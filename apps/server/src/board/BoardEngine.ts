/**
 * The board's own command engine (T3O-56).
 *
 * Board commands used to ride upstream's orchestration engine. Upstream's
 * orchestration-v2 has no extension point, so the board decides, persists and
 * publishes its own commands here, against its own log in `boards.sqlite`.
 *
 * One command at a time, through a queue:
 *
 * 1. a receipt for the command id short-circuits a replay;
 * 2. the state the decider needs beyond the board — the brief, the project and
 *    thread lookups — is loaded (`loadDecisionContext`);
 * 3. `decideBoardCommand` turns the command into events;
 * 4. ONE transaction appends them to `boards.board_events`, folds them into the
 *    `board_*` tables, writes the receipt and the projector watermark — every
 *    table in one database file, so the commit is atomic;
 * 5. the in-memory read model moves, and only then are the events published.
 *
 * Publishing happens on the single worker fiber after commit, which is the
 * serialised publish lane: a subscriber sees sequences in order, never an event
 * whose transaction has not committed. `streamBoardEvents` relies on that to
 * hand over from the durable log to the live tail without a gap or a duplicate.
 */
import { type CommandId, type OrchestrationClientOrigin } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../persistence/Errors.ts";
import { BoardQueries } from "./BoardQueries.ts";
import { makeBoardEventStore } from "./boardEventStore.ts";
import {
  boardCommandAggregateRef,
  boardCommandNeedsBrief,
  boardCommandNeedsProjects,
  boardCommandNeedsThread,
  boardDecidedEvents,
  decideBoardCommand,
  type BoardCommand,
  type BoardDecisionContext,
  type PlannedBoardEvent,
} from "./decider.ts";
import {
  BoardCommandIdConflictError,
  BoardCommandInvariantError,
  BoardCommandPreviouslyRejectedError,
  isBoardCommandInvariantError,
  type BoardDispatchError,
} from "./errors.ts";
import { makeBoardSqlProjector } from "./projection.ts";
import { projectBoardEvent, type BoardEvent, type BoardReadModel } from "./projector.ts";
import type { BoardQueriesShape } from "./projection.ts";

/** The board log projector's watermark row in `boards.projection_state`. */
export const BOARD_EVENTS_PROJECTOR = "projection.board-events";

export interface BoardEngineShape {
  /**
   * Decide, persist and publish one board command. Serialised through the
   * engine's queue; a repeated command id answers from its receipt.
   */
  readonly dispatch: (
    command: BoardCommand,
    options?: { readonly origin?: OrchestrationClientOrigin },
  ) => Effect.Effect<{ readonly sequence: number }, BoardDispatchError>;
  /** The in-memory board read model, as of the last committed command. */
  readonly getReadModel: Effect.Effect<BoardReadModel>;
  /** The sequence of the last committed board event (0 for an empty log). */
  readonly latestSequence: Effect.Effect<number>;
  /**
   * Every board event after `afterSequence` from the durable log, then the
   * live tail — in order, with no gap and no duplicate at the hand-over.
   */
  readonly streamBoardEvents: (input: {
    readonly afterSequence: number;
  }) => Stream.Stream<BoardEvent, ProjectionRepositoryError>;
  /** Live board events only. Each access is its own subscription. */
  readonly liveBoardEvents: Stream.Stream<BoardEvent>;
  /** A live subscription that is attached when this effect returns. */
  readonly subscribeBoardEvents: Effect.Effect<Stream.Stream<BoardEvent>, never, Scope.Scope>;
}

export class BoardEngine extends Context.Service<BoardEngine, BoardEngineShape>()(
  "t3/board/BoardEngine",
) {}

interface CommandEnvelope {
  readonly command: BoardCommand;
  readonly origin: OrchestrationClientOrigin | undefined;
  readonly result: Deferred.Deferred<{ readonly sequence: number }, BoardDispatchError>;
}

/** The state a board command is decided against beyond the board itself. */
export const loadDecisionContext = (command: BoardCommand, queries: BoardQueriesShape) =>
  Effect.gen(function* () {
    const brief = boardCommandNeedsBrief(command)
      ? { brief: yield* queries.boardCardBrief(command.cardId) }
      : {};
    const projects = boardCommandNeedsProjects(command)
      ? { projects: yield* queries.boardProjects() }
      : {};
    const thread = boardCommandNeedsThread(command)
      ? { thread: yield* queries.boardThread(command.threadId) }
      : {};
    return { ...brief, ...projects, ...thread } satisfies BoardDecisionContext;
  });

export const makeBoardEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const queries = yield* BoardQueries;
  const crypto = yield* Crypto.Crypto;
  const store = makeBoardEventStore(sql);
  const projector = makeBoardSqlProjector(sql);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  // Catch the tables up with any logged event they have not folded in. The
  // engine itself never leaves one behind — append and projection share a
  // transaction — but a database migrated from the v1 log can arrive here with
  // a projector watermark behind the log head.
  const head = yield* store.latestSequence;
  const watermark = (yield* store.getWatermark(BOARD_EVENTS_PROJECTOR)) ?? head;
  if (watermark < head) {
    yield* Stream.runForEach(store.readFrom(watermark), (event) =>
      sql
        .withTransaction(
          projector
            .applyBoardEvent(event)
            .pipe(
              Effect.andThen(
                nowIso.pipe(
                  Effect.flatMap((at) =>
                    store.setWatermark(BOARD_EVENTS_PROJECTOR, event.sequence, at),
                  ),
                ),
              ),
            ),
        )
        .pipe(Effect.mapError(toBoardPersistenceError("BoardEngine.catchUp:transaction"))),
    );
    yield* Effect.logInfo("Board projection caught up with the board log").pipe(
      Effect.annotateLogs({ from: watermark, to: head }),
    );
  }

  // Hydrated from the board tables, not by replay: the tables ARE the
  // projection, and a replay of every board event ever is boot time for nothing.
  const hydrated = yield* queries.loadBoardState();
  let readModel: BoardReadModel = hydrated === null ? {} : { board: hydrated };
  let latest = head;

  const queue = yield* Queue.unbounded<CommandEnvelope>();
  const pubsub = yield* PubSub.unbounded<BoardEvent>();

  const process = (envelope: CommandEnvelope) =>
    Effect.gen(function* () {
      const { command } = envelope;
      const aggregate = boardCommandAggregateRef(command);

      const receipt = yield* store.getReceipt(command.commandId);
      if (receipt !== null) {
        // A receipt proves only that THIS command was handled. Replaying it for a
        // command aimed elsewhere would report success for work never done. A
        // legacy accepted receipt names the command's last event, which may be a
        // dependent card, so it matches when the command's own aggregate was hit.
        const sameAggregate =
          (receipt.aggregateKind === aggregate.aggregateKind &&
            receipt.aggregateId === aggregate.aggregateId) ||
          (receipt.status === "accepted" &&
            (yield* store.commandTouchedAggregate(
              command.commandId,
              aggregate.aggregateKind,
              aggregate.aggregateId,
            )));
        if (!sameAggregate) {
          return yield* new BoardCommandIdConflictError({
            commandId: command.commandId,
            receiptAggregateKind: receipt.aggregateKind,
            receiptAggregateId: receipt.aggregateId,
            commandAggregateKind: aggregate.aggregateKind,
            commandAggregateId: aggregate.aggregateId,
          });
        }
        if (receipt.status === "accepted") return { sequence: receipt.resultSequence };
        return yield* new BoardCommandPreviouslyRejectedError({
          commandId: command.commandId,
          detail: receipt.error ?? "Previously rejected.",
        });
      }

      const context = yield* loadDecisionContext(command, queries);
      const decided = yield* decideBoardCommand({ command, readModel, context }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.mapError((cause) =>
          isBoardCommandInvariantError(cause)
            ? cause
            : new BoardCommandInvariantError({
                commandType: command.type,
                detail: "Failed to generate an event identifier.",
                cause,
              }),
        ),
      );
      // The dispatching client's origin rides every event the command made; the
      // decider stays pure and attribution stays an engine concern.
      const planned = boardDecidedEvents(decided).map((event) =>
        envelope.origin === undefined
          ? event
          : { ...event, metadata: { ...event.metadata, origin: envelope.origin } },
      ) as ReadonlyArray<PlannedBoardEvent>;
      if (planned.length === 0) {
        return yield* new BoardCommandInvariantError({
          commandType: command.type,
          detail: "Command produced no events.",
        });
      }

      const committed = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const events: BoardEvent[] = [];
            let next = readModel;
            for (const plannedEvent of planned) {
              const saved = yield* store.append(plannedEvent);
              next = yield* projectBoardEvent(next, saved);
              yield* projector.applyBoardEvent(saved);
              events.push(saved);
            }
            const last = events.at(-1)!;
            // The receipt names the COMMAND's aggregate, not the last event's: a
            // multi-card command (archive re-flagging a dependent) ends elsewhere.
            yield* store.upsertReceipt({
              commandId: command.commandId,
              aggregateKind: aggregate.aggregateKind,
              aggregateId: aggregate.aggregateId,
              acceptedAt: last.occurredAt,
              resultSequence: last.sequence,
              status: "accepted",
              error: null,
            });
            yield* store.setWatermark(BOARD_EVENTS_PROJECTOR, last.sequence, last.occurredAt);
            return { events, next } as const;
          }),
        )
        .pipe(Effect.mapError(toBoardPersistenceError("BoardEngine.dispatch:transaction")));

      readModel = committed.next;
      latest = committed.events.at(-1)!.sequence;
      for (const event of committed.events) {
        yield* PubSub.publish(pubsub, event);
      }
      return { sequence: latest };
    }).pipe(
      Effect.withSpan(`board.command.${envelope.command.type}`),
      Effect.exit,
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }
          const error = Cause.squash(exit.cause) as BoardDispatchError;
          // A refusal is recorded, so a retry of the same command id answers the
          // same "no" rather than being re-decided against a board that moved.
          if (isBoardCommandInvariantError(error)) {
            const aggregate = boardCommandAggregateRef(envelope.command);
            yield* store
              .upsertReceipt({
                commandId: envelope.command.commandId as CommandId,
                aggregateKind: aggregate.aggregateKind,
                aggregateId: aggregate.aggregateId,
                acceptedAt: yield* nowIso,
                resultSequence: latest,
                status: "rejected",
                error: error.message,
              })
              .pipe(Effect.ignore);
          }
          yield* Deferred.failCause(envelope.result, exit.cause);
        }),
      ),
    );

  yield* Effect.forkScoped(Effect.forever(Queue.take(queue).pipe(Effect.flatMap(process))));
  yield* Effect.logDebug("board engine started").pipe(Effect.annotateLogs({ sequence: latest }));

  const dispatch: BoardEngineShape["dispatch"] = (command, options) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ readonly sequence: number }, BoardDispatchError>();
      yield* Queue.offer(queue, { command, origin: options?.origin, result });
      return yield* Deferred.await(result);
    });

  const streamBoardEvents: BoardEngineShape["streamBoardEvents"] = ({ afterSequence }) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe BEFORE reading the head. Every event at or below the head
        // has committed, so the log serves it; every event above it is
        // published after this subscription exists, so the live tail serves it.
        const subscription = yield* PubSub.subscribe(pubsub);
        const head = latest;
        const catchUp = store
          .readFrom(afterSequence)
          .pipe(Stream.filter((event) => event.sequence <= head));
        const live = Stream.fromSubscription(subscription).pipe(
          Stream.filter((event) => event.sequence > Math.max(head, afterSequence)),
        );
        return Stream.concat(catchUp, live);
      }),
    );

  return {
    dispatch,
    getReadModel: Effect.sync(() => readModel),
    latestSequence: Effect.sync(() => latest),
    streamBoardEvents,
    get liveBoardEvents() {
      return Stream.fromPubSub(pubsub);
    },
    subscribeBoardEvents: PubSub.subscribe(pubsub).pipe(Effect.map(Stream.fromSubscription)),
  } satisfies BoardEngineShape;
});

const toBoardPersistenceError =
  (operation: string) =>
  (cause: unknown): BoardDispatchError =>
    typeof cause === "object" && cause !== null && "_tag" in cause && cause._tag !== "SqlError"
      ? (cause as BoardDispatchError)
      : toPersistenceSqlError(operation)(cause);

export const BoardEngineLive = Layer.effect(BoardEngine, makeBoardEngine);
