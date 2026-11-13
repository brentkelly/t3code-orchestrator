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

const harness = (board: BoardState) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeCapacity(roomForCards(4));
    const finished = yield* Deferred.make<void>();
    const runs: Array<BoardWorkerRunSetupInput> = [];
    const recorded: Array<BoardCardSetupResult | null> = [];
    let state: "running" | "done" | "failed" | "none" = "none";
    const client = {
      ...fake.client,
      runSetup: (_workerId: unknown, input: BoardWorkerRunSetupInput) => {
        runs.push(input);
        return Stream.make(progress({ status: "running", exitCode: null }), progress());
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
      onFinished: Deferred.succeed(finished, undefined).pipe(Effect.asVoid),
    });
    return {
      setup,
      runs,
      recorded,
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

it.effect("a card that already built is marked set up, not run again", () =>
  Effect.gen(function* () {
    const card = buildingCard("a", "a");
    const h = yield* harness({
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
    } as unknown as BoardState);
    yield* h.setup.gate(card, BOARD_LOCAL_WORKER_ID);
    yield* h.finished;
    assert.isTrue(h.runs[0]?.markOnly);
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
