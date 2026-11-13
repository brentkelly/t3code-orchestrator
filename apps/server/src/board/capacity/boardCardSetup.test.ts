/**
 * A card's setup from the board (T3O-86): started once, marked only for a card that already
 * built, holding a step only when it holds the agent, and recorded as interrupted when the
 * worker restarted mid-setup.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  BoardCardId,
  type BoardCard,
  type BoardCardSetupProgress,
  type BoardCardSetupResult,
  type BoardCommand,
  type BoardState,
  type BoardWorkerRunSetupInput,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { buildingCard } from "../supervisorHarness.testkit.ts";
import { makeBoardCardSetup, setupHold } from "./boardCardSetup.ts";
import { makeFakeCapacity, roomForCards } from "./capacityClient.testkit.ts";

const NOW = "2026-11-13T00:00:00.000Z";

const progress = (overrides: Partial<BoardCardSetupProgress> = {}): BoardCardSetupProgress => ({
  status: "succeeded",
  stage: "setup-script",
  stages: [],
  exitCode: 0,
  startedAt: NOW,
  durationMs: 1000,
  tail: "",
  blocking: false,
  detail: null,
  ...overrides,
});

const harness = (
  board: BoardState,
  stream: Stream.Stream<BoardCardSetupProgress> = Stream.make(
    progress({ status: "running", exitCode: null }),
    progress(),
  ),
) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeCapacity(roomForCards(4));
    const finished = yield* Deferred.make<void>();
    const runs: Array<BoardWorkerRunSetupInput> = [];
    const recorded: Array<BoardCardSetupResult | null> = [];
    let state: "running" | "done" | "failed" | "none" = "none";
    const cancels: Array<string> = [];
    let looks = 0;
    const client = {
      ...fake.client,
      cancelSetup: (_workerId: unknown, worktreePath: string) =>
        Effect.sync(() => void cancels.push(worktreePath)),
      runSetup: (_workerId: unknown, input: BoardWorkerRunSetupInput) => {
        runs.push(input);
        return stream;
      },
      setupState: () => Effect.sync(() => state),
    };
    const setup = makeBoardCardSetup({
      client,
      readBoard: Effect.succeed(board),
      dispatch: (command: BoardCommand) =>
        Effect.sync(() => {
          if (command.type === "board.card.record-setup") recorded.push(command.setup);
          return true;
        }),
      commandId: (tag) => Effect.succeed(`cmd-${tag}` as BoardCommand["commandId"]),
      nowIso: Effect.succeed(NOW),
      placement: () => Effect.succeed({ workerId: BOARD_LOCAL_WORKER_ID, projectId: "p" }),
      // Called on the first progress and again when the run ends: `finished` is the end.
      onFinished: Effect.suspend(() =>
        ++looks < 2 ? Effect.void : Deferred.succeed(finished, undefined).pipe(Effect.asVoid),
      ),
    });
    return {
      setup,
      runs,
      recorded,
      cancels,
      finished: Deferred.await(finished),
      setState: (next: typeof state) => (state = next),
    };
  });

const withSetup = (card: BoardCard, setup: Partial<BoardCardSetupResult> | null): BoardCard => ({
  ...card,
  resources:
    setup === null
      ? null
      : {
          sizing: null,
          grant: null,
          setup: {
            status: "running",
            stage: "setup-script",
            exitCode: null,
            startedAt: NOW,
            durationMs: null,
            workerId: BOARD_LOCAL_WORKER_ID,
            detail: null,
            blocking: false,
            ...setup,
          },
        },
});

it.effect("a worktree with no setup on record starts one, and records each stage", () =>
  Effect.gen(function* () {
    const card = buildingCard("a", "a");
    const h = yield* harness({ cards: [card], nextCardNumberByProject: {} });
    // The first progress says the script doesn't hold the agent: the step goes ahead.
    assert.isNull(yield* h.setup.gate(card, BOARD_LOCAL_WORKER_ID));
    yield* h.finished;
    assert.deepStrictEqual(
      h.runs.map((run) => [run.cardId, run.markOnly ?? false]),
      [["a", false]],
    );
    assert.deepStrictEqual(
      h.recorded.map((setup) => setup?.status),
      ["running", "succeeded"],
    );
  }),
);

const builtOnce = (card: BoardCard) =>
  ({
    cards: [card],
    nextCardNumberByProject: {},
    stepCompletions: [
      {
        cardId: BoardCardId.make("a"),
        stepId: "building",
        outcome: "succeeded",
        summary: null,
        payload: null,
        threadId: null,
        completedAt: NOW,
      },
    ],
  }) as unknown as BoardState;

it.effect("a card that already built is marked set up, not run again", () =>
  Effect.gen(function* () {
    const card = buildingCard("a", "a");
    const h = yield* harness(builtOnce(card));
    yield* h.setup.gate(card, BOARD_LOCAL_WORKER_ID);
    yield* h.finished;
    assert.isTrue(h.runs[0]?.markOnly);
  }),
);

it.effect("a built card's re-cut or moved worktree runs setup", () =>
  Effect.gen(function* () {
    const card: BoardCard = {
      ...buildingCard("a", "a"),
      resources: { sizing: null, grant: null, setup: null, setupDue: true },
    };
    const h = yield* harness(builtOnce(card));
    yield* h.setup.gate(card, BOARD_LOCAL_WORKER_ID);
    yield* h.finished;
    assert.deepStrictEqual(
      h.runs.map((run) => run.markOnly ?? false),
      [false],
    );
  }),
);

it("only a setup that holds the agent holds the step", () => {
  const card = buildingCard("a", "a");
  assert.isNull(setupHold(withSetup(card, { blocking: false }), BOARD_LOCAL_WORKER_ID));
  assert.strictEqual(
    setupHold(withSetup(card, { blocking: true }), BOARD_LOCAL_WORKER_ID)?.queuedBy,
    "setup",
  );
  assert.isNotNull(setupHold(withSetup(card, { blocking: true, status: "failed" }), "local"));
  assert.isNull(setupHold(withSetup(card, { blocking: true, status: "succeeded" }), "local"));
});

it.effect("a worker that restarted mid-setup records it failed: interrupted", () =>
  Effect.gen(function* () {
    const card = withSetup(buildingCard("a", "a"), {});
    const h = yield* harness({ cards: [card], nextCardNumberByProject: {} });
    h.setState("running");
    yield* h.setup.reconcile();
    assert.lengthOf(h.recorded, 0);
    h.setState("none");
    yield* h.setup.reconcile();
    assert.deepInclude(h.recorded[0], {
      status: "failed",
      detail: "Interrupted: the worker restarted.",
    });
  }),
);

it.effect("only a human's Retry starts a run, and Cancel reaches the worker with no run here", () =>
  Effect.gen(function* () {
    const card = withSetup(buildingCard("a", "a"), { status: "cancelled" });
    const h = yield* harness({ cards: [card], nextCardNumberByProject: {} });
    yield* h.setup.onRequested(card, "cancel");
    assert.deepStrictEqual(h.cancels, [card.worktree!.path]);
    assert.lengthOf(h.runs, 0);
    yield* h.setup.onRequested(withSetup(card, { status: "running" }), "retry");
    yield* h.finished;
    assert.deepStrictEqual(
      h.runs.map((run) => run.retry),
      [true],
    );
  }),
);

it.effect("a new setup that blocks holds its step from the first pass; a silent one doesn't", () =>
  Effect.gen(function* () {
    const card = buildingCard("a", "a");
    const blocking = yield* harness(
      { cards: [card], nextCardNumberByProject: {} },
      Stream.make(progress({ status: "running", exitCode: null, blocking: true })),
    );
    assert.strictEqual(
      (yield* blocking.setup.gate(card, BOARD_LOCAL_WORKER_ID))?.queuedBy,
      "setup",
    );
    const silent = yield* harness({ cards: [card], nextCardNumberByProject: {} }, Stream.empty);
    assert.isNull(yield* silent.setup.gate(card, BOARD_LOCAL_WORKER_ID));
  }),
);
