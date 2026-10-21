/**
 * `board.subscribeBoard` (T3O-57): the board's own subscription, off the
 * orchestration shell.
 *
 * The window coalescer is exercised over doubles; the snapshot, live hand-over
 * and resume rules against the real board engine and tables.
 */
import {
  BoardCardId,
  CommandId,
  EMPTY_BOARD_WORKERS_STATE,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardEvent,
  type BoardShellStreamItem,
  type BoardWorkersState,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { inertBoardQueries } from "./boardServices.testkit.ts";
import {
  boardStackEngine,
  drainBoardThreadTail,
  makeBoardStackTestLayer,
  writeStackPlan,
} from "./boardStack.testkit.ts";
import { boardStreamWindowDeltas, subscribeBoard } from "./boardSubscription.ts";
import { makeBoardCard, NOW } from "./supervisorHarness.testkit.ts";
import { BoardWorkers } from "./workers/BoardWorkers.ts";

const cardId = BoardCardId.make("card-1");
const linkedThread = ThreadId.make("thread-linked");
const strayThread = ThreadId.make("thread-stray");
const card: BoardCard = makeBoardCard({ id: "card-1", stage: "building", orderKey: "m" });

const boardEvent = (event: Record<string, unknown>) =>
  ({
    eventId: `evt-${String(event.type)}-${String(event.sequence)}`,
    aggregateKind: "card",
    aggregateId: cardId,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    ...event,
  }) as unknown as BoardEvent;

const moved = (sequence: number) =>
  boardEvent({
    type: "board.card-moved",
    sequence,
    payload: { cardId, fromStage: "ready", toStage: "building", card },
  });

const linked = (sequence: number) =>
  boardEvent({
    type: "board.card-thread-linked",
    sequence,
    payload: { cardId, threadId: linkedThread, role: "building", card },
  });

/** The coalescer over queries that know one live link, counting its reads. */
const windowDeltas = (inputs: Parameters<typeof boardStreamWindowDeltas>[0]) => {
  const reads = { cardThreads: 0 };
  const queries = inertBoardQueries({
    boardCardThreads: () =>
      Effect.sync(() => {
        reads.cardThreads += 1;
        return [{ cardId, threadId: linkedThread }];
      }),
    boardCardIdForThread: (threadId) => Effect.succeed(threadId === linkedThread ? cardId : null),
    boardThreadWorker: () => Effect.succeed(null),
  });
  return boardStreamWindowDeltas(inputs, { queries, latestSequence: Effect.succeed(9) }).pipe(
    Effect.map((deltas) => ({ deltas, reads })),
  );
};

describe("boardStreamWindowDeltas", () => {
  it.effect("maps a board event to its delta, stamped with the board's own sequence", () =>
    Effect.gen(function* () {
      const { deltas } = yield* windowDeltas([{ kind: "board", event: moved(3) }]);
      assert.deepStrictEqual(
        deltas.map((delta) => [delta.kind, delta.sequence]),
        [["card-upserted", 3]],
      );
    }),
  );

  it.effect("passes every board delta through in order, uncollapsed", () =>
    Effect.gen(function* () {
      // A card-carrying delta omits what it cannot see, so an earlier one for
      // the same card is not subsumed by a later one.
      const { deltas } = yield* windowDeltas([
        { kind: "board", event: moved(3) },
        { kind: "board", event: moved(4) },
      ]);
      assert.deepStrictEqual(
        deltas.map((delta) => delta.sequence),
        [3, 4],
      );
    }),
  );

  it.effect("follows a link-set change with the card's thread summaries", () =>
    Effect.gen(function* () {
      const { deltas } = yield* windowDeltas([{ kind: "board", event: linked(4) }]);
      assert.deepStrictEqual(
        deltas.map((delta) => delta.kind),
        ["card-upserted", "card-threads"],
      );
    }),
  );

  it.effect("gives an unarchived card back its thread summaries", () =>
    Effect.gen(function* () {
      const { deltas } = yield* windowDeltas([
        {
          kind: "board",
          event: boardEvent({
            type: "board.card-unarchived",
            sequence: 5,
            payload: { cardId, card },
          }),
        },
      ]);
      assert.deepStrictEqual(
        deltas.map((delta) => delta.kind),
        ["card-upserted", "card-threads"],
      );
    }),
  );

  it.effect("refetches a card's threads once per window, however many changes hit it", () =>
    Effect.gen(function* () {
      const { deltas, reads } = yield* windowDeltas([
        { kind: "todo", threadId: linkedThread },
        { kind: "board", event: linked(4) },
        { kind: "todo", threadId: linkedThread },
        { kind: "todo", threadId: linkedThread },
      ]);
      assert.deepStrictEqual(
        deltas.map((delta) => delta.kind),
        ["card-upserted", "card-threads"],
      );
      assert.strictEqual(reads.cardThreads, 1);
      // Stamped with the board head: the client applies `card-threads` unguarded.
      assert.strictEqual(deltas.at(-1)?.sequence, 9);
    }),
  );

  it.effect("emits nothing for a todo change on a thread no card holds", () =>
    Effect.gen(function* () {
      const { deltas, reads } = yield* windowDeltas([{ kind: "todo", threadId: strayThread }]);
      assert.deepStrictEqual(deltas, []);
      assert.strictEqual(reads.cardThreads, 0);
    }),
  );
});

const projectId = ProjectId.make("project-subscribe");

const createProject = {
  type: "project.create",
  commandId: CommandId.make("cmd-subscribe-project"),
  projectId,
  title: "Subscribe Project",
  workspaceRoot: "/tmp/project-subscribe",
  defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
  createdAt: NOW,
} as const;

const createCard = (id: string) =>
  ({
    type: "board.card.create",
    commandId: CommandId.make(`cmd-create-${id}`),
    cardId: BoardCardId.make(id),
    projectId,
    title: `Card ${id}`,
    orderKey: "m",
    createdAt: NOW,
  }) as const;

const retitle = (id: string, title: string) =>
  ({
    type: "board.card.update",
    commandId: CommandId.make(`cmd-retitle-${id}-${title}`),
    cardId: BoardCardId.make(id),
    title,
    createdAt: NOW,
  }) as const;

/** Subscribe, run `act` while the stream is attached, and take `count` items. */
const collect = <E = never>(
  input: Parameters<typeof subscribeBoard>[0],
  count: number,
  act: Effect.Effect<unknown, E> = Effect.void,
  options?: Parameters<typeof subscribeBoard>[1],
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const stream = yield* subscribeBoard(input, options);
      const fiber = yield* Stream.runCollect(stream.pipe(Stream.take(count))).pipe(
        Effect.forkScoped,
      );
      yield* act;
      return Array.from(yield* Fiber.join(fiber)) as ReadonlyArray<BoardShellStreamItem>;
    }),
  );

const kinds = (items: ReadonlyArray<BoardShellStreamItem>) => items.map((item) => item.kind);

// Live clock: deltas pass through the 50ms coalescing window.
it.layer(makeBoardStackTestLayer("t3o-board-subscribe-test-"), { excludeTestServices: true })(
  "subscribeBoard",
  (it) => {
    it.effect("opens with a snapshot, then goes live with no gap", () =>
      Effect.gen(function* () {
        const engine = yield* boardStackEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createCard("card-a"));
        const head = yield* engine.boardEngine.latestSequence;

        const items = yield* collect(
          {},
          2,
          engine.dispatch(retitle("card-a", "Renamed")).pipe(Effect.orDie),
        );
        assert.deepStrictEqual(kinds(items), ["snapshot", "card-upserted"]);
        const [opening, live] = items;
        assert.strictEqual(opening?.kind === "snapshot" && opening.snapshot.snapshotSequence, head);
        assert.deepStrictEqual(
          opening?.kind === "snapshot" ? opening.snapshot.cards.map((shell) => shell.cardId) : [],
          [BoardCardId.make("card-a")],
        );
        // The stages are seeded, so even a fresh board names its columns.
        assert.isTrue(opening?.kind === "snapshot" && opening.snapshot.stages.length > 0);
        assert.strictEqual(live?.kind === "card-upserted" && live.sequence, head + 1);
        assert.strictEqual(live?.kind === "card-upserted" && live.card.title, "Renamed");
      }),
    );

    it.effect("resumes from a cursor by replaying exactly the events it missed", () =>
      Effect.gen(function* () {
        const engine = yield* boardStackEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createCard("card-b"));
        const cursor = yield* engine.boardEngine.latestSequence;
        yield* engine.dispatch(retitle("card-b", "One"));
        yield* engine.dispatch(retitle("card-b", "Two"));

        const items = yield* collect({ afterSequence: cursor }, 2);
        assert.deepStrictEqual(kinds(items), ["card-upserted", "card-upserted"]);
        assert.deepStrictEqual(
          items.map((item) => (item.kind === "snapshot" ? -1 : item.sequence)),
          [cursor + 1, cursor + 2],
        );
      }),
    );

    it.effect("falls back to a snapshot when the gap is too large", () =>
      Effect.gen(function* () {
        const engine = yield* boardStackEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createCard("card-c"));
        const cursor = yield* engine.boardEngine.latestSequence;
        yield* engine.dispatch(retitle("card-c", "One"));
        yield* engine.dispatch(retitle("card-c", "Two"));
        const head = yield* engine.boardEngine.latestSequence;

        const items = yield* collect({ afterSequence: cursor }, 1, Effect.void, { maxGap: 1 });
        assert.deepStrictEqual(kinds(items), ["snapshot"]);
        assert.strictEqual(
          items[0]?.kind === "snapshot" && items[0].snapshot.snapshotSequence,
          head,
        );
      }),
    );

    it.effect("falls back to a snapshot for a cursor ahead of the board's log", () =>
      Effect.gen(function* () {
        const engine = yield* boardStackEngine;
        const head = yield* engine.boardEngine.latestSequence;
        const items = yield* collect({ afterSequence: head + 50 }, 1);
        assert.deepStrictEqual(kinds(items), ["snapshot"]);
      }),
    );

    it.effect("sends a worker change that lands between the opening read and going live", () =>
      Effect.gen(function* () {
        const engine = yield* boardStackEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createCard("card-w"));
        const online: BoardWorkersState = {
          ...EMPTY_BOARD_WORKERS_STATE,
          workers: [
            {
              id: EnvironmentId.make("env-linux-box"),
              label: "linux-box",
              url: "http://linux-box:3773",
              addedAt: NOW,
              status: {
                state: "online",
                lastSeenAt: NOW,
                t3oVersion: "0.0.45",
                protocolVersion: 1,
              },
              snapshot: null,
            },
          ],
        };
        // The opening snapshot reads a local-only board; by the time the
        // stream subscribes, a worker is online.
        const items = yield* collect(
          {},
          2,
          engine.dispatch(retitle("card-w", "Renamed")).pipe(Effect.orDie),
        ).pipe(
          Effect.provideService(BoardWorkers, {
            ...(yield* BoardWorkers),
            state: Effect.succeed(EMPTY_BOARD_WORKERS_STATE),
            states: Stream.make(online, online),
          }),
        );
        assert.deepStrictEqual(kinds(items), ["snapshot", "workers"]);
        const [, workers] = items;
        assert.deepStrictEqual(workers?.kind === "workers" ? workers.state : null, online);
      }),
    );

    // Runs last: the shared database keeps this card's live link, which every
    // later resume would re-send.
    it.effect("resume re-sends card threads whose todos changed while disconnected", () =>
      Effect.gen(function* () {
        const engine = yield* boardStackEngine;
        const resumedCard = BoardCardId.make("card-d");
        const thread = ThreadId.make("thread-d");
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createCard("card-d"));
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-d"),
          threadId: thread,
          projectId,
          title: "Thread d",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
        });
        yield* engine.dispatch({
          type: "board.card.link-thread",
          commandId: CommandId.make("cmd-link-d"),
          cardId: resumedCard,
          threadId: thread,
          role: "building",
          createdAt: NOW,
        });
        const cursor = yield* engine.boardEngine.latestSequence;

        // The plan lands with no subscriber attached, and writes no board event.
        yield* writeStackPlan(
          thread,
          "plan-d",
          [
            { step: "One", status: "completed" },
            { step: "Two", status: "pending" },
          ],
          NOW,
        );
        yield* drainBoardThreadTail;
        assert.strictEqual(yield* engine.boardEngine.latestSequence, cursor);

        const items = yield* collect({ afterSequence: cursor }, 1);
        const [resent] = items;
        assert.strictEqual(resent?.kind, "card-threads");
        assert.deepStrictEqual(
          resent?.kind === "card-threads"
            ? resent.threads.map((entry) => [entry.cardId, entry.todoDone, entry.todoTotal])
            : [],
          [[resumedCard, 1, 2]],
        );
      }),
    );
  },
);
