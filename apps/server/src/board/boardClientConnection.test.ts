/**
 * The board's half of a client connection (T3O-56): board commands off
 * `orchestration.dispatchCommand`, and the board's shell deltas.
 *
 * Board deltas no longer ride upstream's event stream. They come from two
 * sources — the board engine's events, and the read-only tail of upstream's log
 * that keeps the todo cache — and these tests pin which deltas each produces.
 */
import {
  BoardCardId,
  CommandId,
  ProjectId,
  ThreadId,
  type BoardCard,
  type BoardCommand,
  type BoardEvent,
  type OrchestrationShellStreamEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { BoardEngine, type BoardEngineShape } from "./BoardEngine.ts";
import { BoardQueries } from "./BoardQueries.ts";
import { BoardThreadTail } from "./boardThreadTail.ts";
import { BoardCommandInvariantError } from "./errors.ts";
import { inertBoardQueries } from "./boardServices.testkit.ts";
import { boardClientConnection } from "./rpc.ts";
import { makeBoardCard, NOW } from "./supervisorHarness.testkit.ts";
import { ThreadGateway } from "./ThreadGateway.ts";
import { inertThreadGateway } from "./threadGateway.testkit.ts";

const cardId = BoardCardId.make("card-1");
const linkedThread = ThreadId.make("thread-linked");
const strayThread = ThreadId.make("thread-stray");
const card: BoardCard = makeBoardCard({ id: "card-1", stage: "building", orderKey: "m" });

const boardEvent = (event: Record<string, unknown>) =>
  ({
    eventId: `evt-${String(event.type)}`,
    aggregateKind: "card",
    aggregateId: cardId,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    ...event,
  }) as unknown as BoardEvent;

/** The connection over doubles: the board engine and the tail publish what a
    test pushes, and the queries know one live link. */
const harness = Effect.gen(function* () {
  const boardEvents = yield* PubSub.unbounded<BoardEvent>();
  const todoChanges = yield* PubSub.unbounded<ThreadId>();
  const dispatched = yield* Ref.make<ReadonlyArray<BoardCommand>>([]);
  const latest = yield* Ref.make(0);
  const refuse = yield* Ref.make(false);

  const engine = {
    dispatch: (command: BoardCommand) =>
      Effect.gen(function* () {
        if (yield* Ref.get(refuse)) {
          return yield* new BoardCommandInvariantError({
            commandType: command.type,
            detail: "No.",
          });
        }
        yield* Ref.update(dispatched, (all) => [...all, command]);
        return { sequence: 1 };
      }),
    getReadModel: Effect.succeed({}),
    latestSequence: Ref.get(latest),
    streamBoardEvents: () => Stream.never,
    liveBoardEvents: Stream.fromPubSub(boardEvents),
    subscribeBoardEvents: PubSub.subscribe(boardEvents).pipe(Effect.map(Stream.fromSubscription)),
  } as unknown as BoardEngineShape;

  const layer = Layer.mergeAll(
    Layer.succeed(BoardEngine, engine),
    Layer.succeed(
      BoardQueries,
      inertBoardQueries({
        boardCardThreads: () => Effect.succeed([{ cardId, threadId: linkedThread }]),
        boardCardIdForThread: (threadId) =>
          Effect.succeed(threadId === linkedThread ? cardId : null),
      }),
    ),
    Layer.succeed(BoardThreadTail, {
      todoChanges: Stream.fromPubSub(todoChanges),
      subscribeTodoChanges: PubSub.subscribe(todoChanges).pipe(Effect.map(Stream.fromSubscription)),
      drain: Effect.void,
    }),
    Layer.succeed(ThreadGateway, inertThreadGateway()),
  );

  const connection = yield* boardClientConnection({
    git: {} as GitVcsDriver["Service"],
    origin: undefined,
  }).pipe(Effect.provide(layer));

  return { connection, boardEvents, todoChanges, dispatched, latest, refuse };
});

/** Attach the deltas, push `publish`, and collect the first `count` deltas. */
const collect = (
  count: number,
  publish: (h: Effect.Success<typeof harness>) => Effect.Effect<unknown>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      const deltas = yield* h.connection.shellDeltas;
      yield* publish(h);
      return Array.from(
        yield* Stream.runCollect(deltas.pipe(Stream.take(count))),
      ) as ReadonlyArray<OrchestrationShellStreamEvent>;
    }),
  ).pipe(Effect.provide(NodeServices.layer));

it.effect("maps a board event to its card delta, stamped with the board's own sequence", () =>
  Effect.gen(function* () {
    const deltas = yield* collect(1, (h) =>
      PubSub.publish(
        h.boardEvents,
        boardEvent({
          type: "board.card-moved",
          sequence: 3,
          payload: { cardId, fromStage: "ready", toStage: "building", card },
        }),
      ),
    );
    assert.deepStrictEqual(
      deltas.map((delta) => [delta.kind, delta.sequence]),
      [["card-upserted", 3]],
    );
  }),
);

it.effect("a link-set change carries the card's thread summaries too", () =>
  Effect.gen(function* () {
    const deltas = yield* collect(2, (h) =>
      PubSub.publish(
        h.boardEvents,
        boardEvent({
          type: "board.card-thread-linked",
          sequence: 4,
          payload: { cardId, threadId: linkedThread, role: "building", card },
        }),
      ),
    );
    assert.deepStrictEqual(
      deltas.map((delta) => delta.kind),
      ["card-upserted", "card-threads"],
    );
  }),
);

it.effect("a todo change on a linked thread refetches its card's threads", () =>
  Effect.gen(function* () {
    const deltas = yield* collect(1, (h) =>
      Ref.set(h.latest, 9).pipe(Effect.andThen(PubSub.publish(h.todoChanges, linkedThread))),
    );
    assert.strictEqual(deltas[0]?.kind, "card-threads");
    // Stamped with the board head: board deltas are applied unguarded.
    assert.strictEqual(deltas[0]?.sequence, 9);
  }),
);

it.effect("a todo change on a thread no card holds emits nothing", () =>
  Effect.gen(function* () {
    // The stray change comes first; the only delta that arrives is the
    // linked one after it.
    const deltas = yield* collect(1, (h) =>
      PubSub.publish(h.todoChanges, strayThread).pipe(
        Effect.andThen(PubSub.publish(h.todoChanges, linkedThread)),
      ),
    );
    assert.deepStrictEqual(
      deltas.map((delta) => delta.kind),
      ["card-threads"],
    );
  }),
);

it.effect("a resuming shell needs a snapshot once the board has any history", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    assert.isFalse(yield* h.connection.shellNeedsSnapshot);
    yield* Ref.set(h.latest, 1);
    assert.isTrue(yield* h.connection.shellNeedsSnapshot);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("dispatches a client board command to the board engine", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const command = {
      type: "board.card.move",
      commandId: CommandId.make("cmd-move"),
      cardId,
      toStage: "building",
      createdAt: NOW,
    } as never;
    const result = yield* h.connection.dispatch(command);
    assert.deepStrictEqual(result, { sequence: 1 });
    assert.deepStrictEqual(
      (yield* Ref.get(h.dispatched)).map((dispatched) => dispatched.commandId),
      [CommandId.make("cmd-move")],
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a board refusal reaches the client in the decider's own words", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.set(h.refuse, true);
    const failure = yield* Effect.flip(
      h.connection.dispatch({
        type: "board.card.create",
        commandId: CommandId.make("cmd-create"),
        cardId,
        projectId: ProjectId.make("project-1"),
        title: "Card",
        createdAt: NOW,
      } as never),
    );
    assert.strictEqual(failure._tag, "OrchestrationDispatchCommandError");
    assert.include(failure.message, "No.");
  }).pipe(Effect.provide(NodeServices.layer)),
);
