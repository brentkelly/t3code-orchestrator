/**
 * "Submit for merge — no review" at the assembled reactor (t3o-07).
 *
 * The pure routing decision lives in `stageExecutor.test.ts`; what is proved
 * here is the thing a user actually presses: a held build card selects one
 * unattended submit step, the card does NOT move until that step succeeds, and
 * when it does the card lands in the merge-role stage — over the top of the
 * review-role stage, and whatever the Build stage's `autoAdvance` says.
 *
 * Driven through the shared `withGovernor` harness, so every assertion is over
 * the board state the real decider + projector produce from the reactor's own
 * dispatches. The refusals are asserted the same way, because each of them is a
 * sentence the card shows — a button that silently does nothing is the failure
 * mode this whole feature replaces.
 */
import {
  BOARD_SUBMIT_STEP_ID,
  BoardCardId,
  BoardStageId,
  EMPTY_BOARD_STATE,
  ProviderInstanceId,
  ThreadId,
  boardCardStepState,
  type BoardCard,
  type BoardCardStepState,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  NOW,
  cardStage,
  codexStep,
  makeBoardCard,
  readyWorktree,
  settingsWith,
  stepCompleted,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const cardId = BoardCardId.make("card-1");

/** A card that has BUILT and is standing there — its build step settled
    `succeeded` and nothing is running. This is the `held` state the caret
    appears on, and the only state the submit action accepts. */
const heldBuildCard = (patch: Partial<BoardCard> = {}): BoardCard => ({
  ...makeBoardCard({
    id: "card-1",
    stage: "building",
    orderKey: "m",
    worktree: readyWorktree("card-1"),
  }),
  ...patch,
});

const settledBuildStep: BoardCardStepState = {
  cardId,
  stepId: String(BoardStageId.make("building")),
  stepLabel: null,
  stageLabel: "Building",
  attempt: 1,
  stallCount: 0,
  lastNudgeAt: null,
  baseTipAtRoundStart: null,
  lastError: null,
  prompt: "build it",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
  mode: "build",
  runtimeMode: "auto",
  humanInLoop: false,
  maxAttempts: 3,
  timeoutMs: 600_000,
  threadId: ThreadId.make("thread-build"),
  status: "succeeded",
  slotHeld: false,
  startedAt: NOW,
  updatedAt: NOW,
};

const buildCompletion = {
  cardId,
  stepId: String(BoardStageId.make("building")),
  outcome: "succeeded" as const,
  summary: "built it",
  payload: null,
  threadId: ThreadId.make("thread-build"),
  completedAt: NOW,
};

/** The shell of the build step's thread, so a seeded `running` step is not
    reconciled as dead the moment the reactor boots. */
const liveBuildThread = new Map([
  [
    "thread-build",
    {
      id: ThreadId.make("thread-build"),
      session: { activeTurnId: "turn-1" },
      hasPendingUserInput: false,
    } as never,
  ],
]);

/** The board a held build card sits on: its build step recorded and settled, so
    boot reconcile starts nothing and the card is genuinely resting. */
const heldBoard = (card: BoardCard = heldBuildCard()) => ({
  cards: [card],
  stepStates: [settledBuildStep],
  stepCompletions: [buildCompletion],
  nextCardNumberByProject: {},
});

// ── D1: the click selects a step; it does not move the card ─────────────────

it.effect("D1: submitting a held build card selects one unattended submit step", () =>
  withGovernor(
    {
      board: heldBoard(),
      settings: settingsWith({
        building: [codexStep],
        globalMaxConcurrent: 3,
        submit: {
          prompt: "Push and open the PR.",
          model: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
          maxAttempts: 2,
          timeoutMs: 60_000,
        },
      }),
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        const result = yield* reactor.submitForMerge(cardId);
        yield* reactor.drain;
        assert.deepStrictEqual(result, { outcome: "started" });

        const state = boardCardStepState(yield* board, cardId);
        assert.strictEqual(state?.stepId, BOARD_SUBMIT_STEP_ID);
        assert.strictEqual(state?.stepLabel, "Submit for merge");
        assert.strictEqual(state?.prompt, "Push and open the PR.");
        // The submit step's OWN model and limits, not the build's (D1/D3).
        assert.strictEqual(state?.providerInstanceId, "claude");
        assert.strictEqual(state?.model, "opus");
        assert.strictEqual(state?.maxAttempts, 2);
        assert.strictEqual(state?.timeoutMs, 60_000);
        // Unattended machinery (D10): there is no conversation to have about
        // pushing a branch.
        assert.strictEqual(state?.humanInLoop, false);
        // It needs the worktree it is pushing from.
        assert.strictEqual(state?.mode, "build");

        // And the card has NOT moved: the step opens the pull request, and only
        // its success routes the card. A card moved here would arrive at the
        // merge stage with no pull request and a Merge button that never
        // renders.
        assert.strictEqual(cardStage(yield* board, cardId), "building");
      }),
  ),
);

it.effect("the submit step falls back to the Build stage's model when it names none", () =>
  withGovernor(
    {
      board: heldBoard(),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        yield* reactor.submitForMerge(cardId);
        yield* reactor.drain;

        const state = boardCardStepState(yield* board, cardId);
        assert.strictEqual(state?.stepId, BOARD_SUBMIT_STEP_ID);
        assert.strictEqual(state?.providerInstanceId, String(codexStep.providerInstanceId));
        // The compiled-in prompt, which is what a board nobody configured runs.
        assert.include(state?.prompt ?? "", "without a review");
        assert.include(state?.prompt ?? "", "Do not review the code");
      }),
  ),
);

// ── D5/D6: the settle routes the card past Code review ──────────────────────

it.effect("D5: the submit step succeeding moves the card to the merge stage, over review", () =>
  withGovernor(
    {
      board: heldBoard(),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ reactor, board, pumpDomain }) =>
      Effect.gen(function* () {
        yield* reactor.submitForMerge(cardId);
        yield* reactor.drain;
        yield* pumpDomain(stepCompleted(cardId, "succeeded", 10, BOARD_SUBMIT_STEP_ID));

        // Not "review", which is the next stage in order and what the simple
        // executor would have advanced to.
        assert.strictEqual(cardStage(yield* board, cardId), "merge");
      }),
  ),
);

it.effect("D6: the directed advance ignores the Build stage's autoAdvance switch", () =>
  withGovernor(
    {
      board: heldBoard(),
      settings: settingsWith({
        building: [codexStep],
        globalMaxConcurrent: 3,
        // Auto-advance governs the AUTOMATIC crossing after an unattended run.
        // A human who clicked "Submit for merge" asked for this move by name,
        // and it must not silently do nothing because the switch is off.
        buildAutoAdvance: false,
      }),
    },
    ({ reactor, board, pumpDomain }) =>
      Effect.gen(function* () {
        yield* reactor.submitForMerge(cardId);
        yield* reactor.drain;
        yield* pumpDomain(stepCompleted(cardId, "succeeded", 10, BOARD_SUBMIT_STEP_ID));

        assert.strictEqual(cardStage(yield* board, cardId), "merge");
      }),
  ),
);

it.effect("a REBUILD after a submit still advances one stage, to Code review", () =>
  withGovernor(
    {
      board: {
        cards: [heldBuildCard()],
        stepStates: [{ ...settledBuildStep, status: "running" }],
        // The card was submitted once, dragged back to Building, and is being
        // built again — so it carries a `submit` completion that will never be
        // cleared. Routing on that COMPLETION rather than on the settle would
        // send this rebuild straight to the merge stage the moment it finished,
        // skipping review on a card nobody asked to skip review for (D5).
        stepCompletions: [
          { ...buildCompletion, stepId: BOARD_SUBMIT_STEP_ID, summary: "opened PR" },
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: liveBuildThread,
    },
    ({ board, pumpDomain }) =>
      Effect.gen(function* () {
        // The build executor delegates to the simple one for every settle that
        // is not the submit step, so registering it must not change how an
        // ordinary build ends.
        yield* pumpDomain(stepCompleted(cardId, "succeeded", 10));
        assert.strictEqual(cardStage(yield* board, cardId), "review");
      }),
  ),
);

// ── D9: on failure the card stays put ───────────────────────────────────────

it.effect("D9: a submit step that fails leaves the card in Building", () =>
  withGovernor(
    {
      board: heldBoard(),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ reactor, board, pumpDomain }) =>
      Effect.gen(function* () {
        yield* reactor.submitForMerge(cardId);
        yield* reactor.drain;
        // No remote, an unauthenticated forge, a rejected push: the prompt tells
        // the agent to complete `failed` rather than guess.
        yield* pumpDomain(stepCompleted(cardId, "failed", 10, BOARD_SUBMIT_STEP_ID));

        assert.strictEqual(cardStage(yield* board, cardId), "building");
      }),
  ),
);

// ── A restart mid-step is re-driven, not lost ───────────────────────────────

it.effect("D5: a submit step that completed while the server was down still routes the card", () =>
  withGovernor(
    {
      // The state a crash mid-submit leaves behind: the agent reported
      // `succeeded`, the settle never landed, and the step row is still
      // `running`. Boot reconciliation settles it and asks the executor what
      // happens next — which is the routing this feature is made of. Nothing
      // durable had to be added to the card to survive this: the step row and
      // its completion already were.
      board: {
        cards: [heldBuildCard()],
        stepStates: [
          {
            ...settledBuildStep,
            stepId: BOARD_SUBMIT_STEP_ID,
            stepLabel: "Submit for merge",
            status: "running",
            threadId: ThreadId.make("thread-submit"),
          },
        ],
        stepCompletions: [
          buildCompletion,
          { ...buildCompletion, stepId: BOARD_SUBMIT_STEP_ID, summary: "opened PR" },
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ board, reactor }) =>
      Effect.gen(function* () {
        yield* reactor.drain;
        assert.strictEqual(cardStage(yield* board, cardId), "merge");
      }),
  ),
);

// ── Every refusal names its cause ───────────────────────────────────────────

it.effect("refuses a card that is not at the build stage", () =>
  withGovernor(
    {
      board: {
        cards: [makeBoardCard({ id: "card-1", stage: "planning", orderKey: "m" })],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        const result = yield* reactor.submitForMerge(cardId);
        assert.deepStrictEqual(result, { outcome: "wrong-stage" });
        assert.strictEqual(boardCardStepState(yield* board, cardId)?.stepId, undefined);
      }),
  ),
);

it.effect("refuses a card with no worktree — there is nothing to push", () =>
  withGovernor(
    {
      board: {
        cards: [heldBuildCard({ worktree: null })],
        stepStates: [settledBuildStep],
        stepCompletions: [buildCompletion],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ reactor }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* reactor.submitForMerge(cardId), { outcome: "no-branch" });
      }),
  ),
);

it.effect("refuses a blocked card — the dependency gate is not overridable", () =>
  withGovernor(
    {
      board: heldBoard(heldBuildCard({ blocked: true })),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ reactor }) =>
      Effect.gen(function* () {
        // Refused here rather than after an agent has already pushed: the
        // directed move would be refused by the decider anyway.
        assert.deepStrictEqual(yield* reactor.submitForMerge(cardId), { outcome: "blocked" });
      }),
  ),
);

it.effect("refuses while a step is still live on the card", () =>
  withGovernor(
    {
      board: {
        cards: [heldBuildCard()],
        stepStates: [{ ...settledBuildStep, status: "running" }],
        stepCompletions: [],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: liveBuildThread,
    },
    ({ reactor }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* reactor.submitForMerge(cardId), { outcome: "step-running" });
      }),
  ),
);

it.effect("refuses a card that does not exist", () =>
  withGovernor(
    {
      board: heldBoard(),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ reactor }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* reactor.submitForMerge(BoardCardId.make("nope")), {
          outcome: "unknown-card",
        });
      }),
  ),
);

// ── The gates that only bite at the directed advance ────────────────────────
//
// Two of the decider's forward gates past the build role — an unfinished
// sub-board child and an unapproved split — refuse the DIRECTED MOVE, which
// happens after the submit step has already pushed the branch and opened the
// pull request. Left to bite there, the refusal is swallowed by the reactor's
// dispatch and the card sits in Building with a fresh pull request and no
// account of why. So they are pre-checked before the step runs, and the race
// that pre-check cannot close is reported on the card.

/** A live plan card of `card-1`'s: materialised, sitting on the floor, not
    done — the state that holds its parent at the build ceiling. */
const workingChild: BoardCard = {
  ...makeBoardCard({ id: "card-2", stage: "ready", orderKey: "n" }),
  parentCardId: cardId,
};

it.effect("refuses a split parent whose plan cards are still working, before it costs a run", () =>
  withGovernor(
    {
      board: {
        cards: [heldBuildCard(), workingChild],
        stepStates: [settledBuildStep],
        stepCompletions: [buildCompletion],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        const result = yield* reactor.submitForMerge(cardId);
        // The gate would refuse the move ANYWAY — but only after an agent had
        // pushed the branch and opened a pull request for a card that cannot
        // go anywhere. Named up front instead, in the gate's own terms.
        assert.strictEqual(result.outcome, "refused");
        assert.include(result.outcome === "refused" ? result.detail : "", "CARD-2");

        yield* reactor.drain;
        // Nothing was selected: no step, no thread, no run.
        assert.notStrictEqual(
          boardCardStepState(yield* board, cardId)?.stepId,
          BOARD_SUBMIT_STEP_ID,
        );
        assert.strictEqual(cardStage(yield* board, cardId), "building");
      }),
  ),
);

it.effect("says why the card stayed when a gate closes while the submit step is running", () =>
  withGovernor(
    {
      board: heldBoard(),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ reactor, board, model, decided, pumpDomain }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* reactor.submitForMerge(cardId), { outcome: "started" });
        yield* reactor.drain;

        // The race the pre-check cannot close: the split is approved while the
        // step is pushing, so the card acquires a plan card between the click
        // and the advance.
        yield* Ref.update(model, (current) => {
          const existing = current.board ?? EMPTY_BOARD_STATE;
          return { ...current, board: { ...existing, cards: [...existing.cards, workingChild] } };
        });
        yield* pumpDomain(stepCompleted(cardId, "succeeded", 10, BOARD_SUBMIT_STEP_ID));

        // The move is refused, so the card stays put — and it SAYS so, with the
        // decider's own sentence, rather than leaving a fresh pull request and
        // a card that quietly did not move (D6).
        assert.strictEqual(cardStage(yield* board, cardId), "building");
        const notes = (yield* decided).filter((event) => event.type === "board.card-note-recorded");
        assert.strictEqual(notes.length, 1);
        const payload = notes[0]?.payload as
          | { readonly kind?: unknown; readonly detail?: unknown }
          | undefined;
        assert.strictEqual(payload?.kind, "card-merge-refused");
        assert.match(String(payload?.detail), /Held the move to Ready for merge\./);
        assert.include(String(payload?.detail), "CARD-2");
      }),
  ),
);
