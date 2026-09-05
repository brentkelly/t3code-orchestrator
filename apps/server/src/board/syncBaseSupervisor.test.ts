/**
 * The sync-base gate and the parent mirror check (t3o-24), against the LIVE
 * reactor.
 *
 * D2: a sub-board child whose base moved since its last review round started is
 * intercepted at the review→merge crossing (and again on the Merge click) — the
 * card stays in review and the sync-base step is what runs next. D4: a child
 * dragged back out of Done regresses a parent that had advanced past the
 * build-role stage, abandoning its in-flight step through the existing abandon
 * path.
 *
 * Staleness is driven through the harness's movable rev-parse fixture: the
 * seeded run row records `baseTipAtRoundStart`, and the stub answers "main"
 * for every unset ref, so a row recorded at "main" is fresh and a row recorded
 * elsewhere (or a tip moved with `setBaseTip`) is stale.
 */
import {
  BoardCardId,
  BOARD_SEED_STAGE_IDS,
  ProviderInstanceId,
  type BoardCard,
  type BoardCardStepState,
  type OrchestrationEvent,
  type VcsStatusChangeRequest,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  cardMoved,
  cardStage,
  codexStep,
  makeBoardCard,
  NOW,
  readyWorktree,
  settingsWith,
  stepStatus,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const parentId = BoardCardId.make("card-parent");
const childId = BoardCardId.make("card-child");

const childCard = (stage: string): BoardCard => ({
  ...makeBoardCard({
    id: "card-child",
    stage,
    orderKey: "m",
    worktree: readyWorktree("card-child"),
  }),
  parentCardId: parentId,
});

/** The settled last step of a converged review loop, carrying the tip its
    round started from (t3o-24, D1). Recorded at "main" it is FRESH (the stub's
    rev-parse answers "main"); recorded anywhere else it is STALE. */
const settledReviewStep = (tip: string): BoardCardStepState => ({
  cardId: childId,
  stepId: "review@1",
  stepLabel: "Review · round 1",
  stageLabel: "Code review",
  attempt: 1,
  stallCount: 0,
  lastNudgeAt: null,
  baseTipAtRoundStart: tip,
  lastError: null,
  awaitingReason: "question" as const,
  prompt: "review it",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
  mode: "build",
  runtimeMode: "auto",
  humanInLoop: false,
  maxAttempts: 3,
  timeoutMs: 600_000,
  threadId: null,
  status: "succeeded",
  slotHeld: false,
  forceStart: false,
  startedAt: null,
  updatedAt: NOW,
});

/** The converged round's recorded completion, so a re-entry into the review
    stage plans the sync step (stale) or reports complete (fresh) rather than
    re-running round 1. */
const convergedRound = {
  cardId: childId,
  stepId: "review@1",
  outcome: "succeeded",
  summary: "clean",
  payload: JSON.stringify({ reviewedSha: "sha-reviewed", findings: [] }),
  threadId: null,
  completedAt: NOW,
} as const;

const settings = () => settingsWith({ building: [codexStep], globalMaxConcurrent: 3 });

const staleBaseNotes = (events: ReadonlyArray<OrchestrationEvent>) =>
  events.filter(
    (event) =>
      event.type === "board.card-note-recorded" &&
      JSON.stringify(event).includes("card-base-stale"),
  );

it.effect("D2: a stale child arriving at merge bounces back to review and runs sync-base", () =>
  withGovernor(
    {
      board: {
        cards: [
          makeBoardCard({ id: "card-parent", stage: "building", orderKey: "a" }),
          childCard(String(BOARD_SEED_STAGE_IDS.merge)),
        ],
        stepStates: [settledReviewStep("sha-before-sibling-merged")],
        stepCompletions: [convergedRound],
        nextCardNumberByProject: {},
      },
      settings: settings(),
    },
    ({ pumpDomain, board, decided }) =>
      Effect.gen(function* () {
        // The crossing: auto-advance or drag, review → merge.
        yield* pumpDomain(
          cardMoved(childCard(String(BOARD_SEED_STAGE_IDS.merge)), "review", "merge", 1),
        );
        // Intercepted: the card is back in review, and the interception is on
        // the activity rail rather than a silent snap-back.
        assert.strictEqual(cardStage(yield* board, childId), String(BOARD_SEED_STAGE_IDS.review));
        assert.strictEqual(staleBaseNotes(yield* decided).length, 1);

        // The bounce move's own arrival (in production it streams back through
        // the engine) re-enters the review stage, where the executor plans the
        // sync step — not another review round, and not `complete`.
        yield* pumpDomain(
          cardMoved(childCard(String(BOARD_SEED_STAGE_IDS.review)), "merge", "review", 2),
        );
        const after = yield* board;
        const step = (after.stepStates ?? []).find((state) => state.cardId === childId);
        assert.strictEqual(step?.stepId, "sync@1");
        // The sync step carries the round's recorded tip forward, so the gate
        // that intercepted stays answerable while it runs.
        assert.strictEqual(step?.baseTipAtRoundStart, "sha-before-sibling-merged");
      }),
  ),
);

it.effect("AC1: a child whose base did not move crosses into merge untouched", () =>
  withGovernor(
    {
      board: {
        cards: [
          makeBoardCard({ id: "card-parent", stage: "building", orderKey: "a" }),
          childCard(String(BOARD_SEED_STAGE_IDS.merge)),
        ],
        // Recorded at "main" — exactly what the stub's rev-parse answers.
        stepStates: [settledReviewStep("main")],
        stepCompletions: [convergedRound],
        nextCardNumberByProject: {},
      },
      settings: settings(),
    },
    ({ pumpDomain, board, decided }) =>
      Effect.gen(function* () {
        yield* pumpDomain(
          cardMoved(childCard(String(BOARD_SEED_STAGE_IDS.merge)), "review", "merge", 1),
        );
        assert.strictEqual(cardStage(yield* board, childId), String(BOARD_SEED_STAGE_IDS.merge));
        assert.strictEqual(staleBaseNotes(yield* decided).length, 0);
      }),
  ),
);

it.effect("D2: a top-level card is never intercepted — its base moving is trunk development", () =>
  withGovernor(
    {
      board: {
        cards: [
          {
            ...makeBoardCard({
              id: "card-child",
              stage: String(BOARD_SEED_STAGE_IDS.merge),
              orderKey: "m",
              worktree: readyWorktree("card-child"),
            }),
          },
        ],
        stepStates: [settledReviewStep("sha-before-sibling-merged")],
        stepCompletions: [convergedRound],
        nextCardNumberByProject: {},
      },
      settings: settings(),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(
          cardMoved(
            makeBoardCard({
              id: "card-child",
              stage: String(BOARD_SEED_STAGE_IDS.merge),
              orderKey: "m",
              worktree: readyWorktree("card-child"),
            }),
            "review",
            "merge",
            1,
          ),
        );
        assert.strictEqual(cardStage(yield* board, childId), String(BOARD_SEED_STAGE_IDS.merge));
      }),
  ),
);

const openPr: VcsStatusChangeRequest = {
  number: 7,
  title: "Child slice",
  url: "https://github.com/acme/repo/pull/7",
  baseRef: "main",
  headRef: "board/card-child",
  state: "open",
};

/** The card-side cache of the same pull request (`BoardCardPullRequest`). */
const cardPr = {
  number: 7,
  url: "https://github.com/acme/repo/pull/7",
  state: "open",
  headBranch: "board/card-child",
  baseRef: "main",
  checkedAt: NOW,
} as const;

it.effect("AC3: the Merge click on a parked stale child intercepts instead of merging", () =>
  withGovernor(
    {
      board: {
        cards: [
          makeBoardCard({ id: "card-parent", stage: "building", orderKey: "a" }),
          { ...childCard(String(BOARD_SEED_STAGE_IDS.merge)), pullRequest: cardPr },
        ],
        stepStates: [settledReviewStep("sha-before-sibling-merged")],
        stepCompletions: [convergedRound],
        nextCardNumberByProject: {},
      },
      settings: settings(),
      pullRequest: openPr,
    },
    ({ reactor, board, mergeAttempts, decided }) =>
      Effect.gen(function* () {
        const result = yield* reactor.mergePullRequest(childId);
        assert.strictEqual(result.outcome, "stale-base");
        // The card went back to review, nothing reached the forge, and the
        // interception is on the rail.
        assert.strictEqual(cardStage(yield* board, childId), String(BOARD_SEED_STAGE_IDS.review));
        assert.strictEqual((yield* mergeAttempts).length, 0);
        assert.strictEqual(staleBaseNotes(yield* decided).length, 1);
      }),
  ),
);

it.effect("the Merge click on a fresh child merges as before", () =>
  withGovernor(
    {
      board: {
        cards: [
          makeBoardCard({ id: "card-parent", stage: "building", orderKey: "a" }),
          { ...childCard(String(BOARD_SEED_STAGE_IDS.merge)), pullRequest: cardPr },
        ],
        stepStates: [settledReviewStep("main")],
        stepCompletions: [convergedRound],
        nextCardNumberByProject: {},
      },
      settings: settings(),
      pullRequest: openPr,
    },
    ({ reactor, mergeAttempts }) =>
      Effect.gen(function* () {
        const result = yield* reactor.mergePullRequest(childId);
        assert.strictEqual(result.outcome, "merged");
        assert.strictEqual((yield* mergeAttempts).length, 1);
      }),
  ),
);

// ── D4: the parent mirror check ────────────────────────────────────────────

/** The parent, advanced past build (its children had all finished) with a
    review-loop step left stalled — the in-flight work the regression must
    abandon through the existing abandon path. */
const parentInReview = (): BoardCard =>
  makeBoardCard({
    id: "card-parent",
    stage: String(BOARD_SEED_STAGE_IDS.review),
    orderKey: "a",
    worktree: { ...readyWorktree("card-parent"), path: null, status: "branch-only" },
  });

const parentReviewStep = (): BoardCardStepState => ({
  ...settledReviewStep("main"),
  cardId: parentId,
  status: "stalled",
});

it.effect(
  "D4/AC6: a child leaving Done regresses the parent to build and abandons its step; finishing again re-advances it",
  () =>
    withGovernor(
      {
        board: {
          cards: [parentInReview(), childCard("building")],
          stepStates: [parentReviewStep()],
          nextCardNumberByProject: {},
        },
        settings: settings(),
      },
      ({ pumpDomain, board, model }) =>
        Effect.gen(function* () {
          // The child was dragged back out of Done (the fixture holds the
          // post-move card; the event is what the reactor keys on).
          yield* pumpDomain(cardMoved(childCard("building"), "done", "building", 1));
          // The parent is back where the approval parked it — the decider's
          // freeze admits exactly this regression, override or not.
          assert.strictEqual(cardStage(yield* board, parentId), "building");

          // The parent's own move event (streamed back in production) walks
          // the existing abandon path over its in-flight step.
          yield* pumpDomain(
            cardMoved(
              { ...parentInReview(), stage: "building" } as BoardCard,
              "review",
              "building",
              2,
            ),
          );
          assert.strictEqual(stepStatus(yield* board, parentId), "abandoned");

          // The child finishing again re-advances the parent (t3o-23 D4). An
          // externally-pumped move is not folded into the harness model, so
          // reflect the child's new stage there first, as the projection
          // pipeline would have before the reactor observed the event.
          yield* Ref.update(model, (current) => ({
            ...current,
            board: {
              ...current.board!,
              cards: current.board!.cards.map((card) =>
                card.id === childId ? { ...card, stage: BOARD_SEED_STAGE_IDS.done } : card,
              ),
            },
          }));
          yield* pumpDomain(cardMoved(childCard("done"), "building", "done", 3));
          assert.strictEqual(
            cardStage(yield* board, parentId),
            String(BOARD_SEED_STAGE_IDS.review),
          );
        }),
    ),
);

it.effect("D4: a child leaving Done while the parent still sits in build regresses nothing", () =>
  withGovernor(
    {
      board: {
        cards: [
          makeBoardCard({ id: "card-parent", stage: "building", orderKey: "a" }),
          childCard("building"),
          { ...childCard("done"), id: BoardCardId.make("card-sibling") },
        ],
        nextCardNumberByProject: {},
      },
      settings: settings(),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(cardMoved(childCard("building"), "done", "building", 1));
        assert.strictEqual(cardStage(yield* board, parentId), "building");
      }),
  ),
);
