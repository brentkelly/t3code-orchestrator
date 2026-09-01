/**
 * Sub-board supervisor behaviour (t3o-23, D4): a split parent in the
 * build-role stage spawns nothing while its children are unfinished, and
 * advances to the next stage in order when the last child finishes — by
 * reaching Done, or by being archived (an archived child counts as done, D6).
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  BoardStageId,
  boardCardStepState,
  boardPlanId,
  type BoardCard,
  type BoardSettings,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type VcsStatusChangeRequest,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import * as Effect from "effect/Effect";

import {
  cardArchived,
  cardMoved,
  cardStage,
  codexStep,
  makeBoardCard,
  movedToBuilding,
  readyWorktree,
  settingsWith,
  stepStatus,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

/** A `board.card-created` event carrying the given card as its payload —
    enough for the reactor's `handleCardCreated`, which re-reads the card. */
const cardCreated = (card: BoardCard, sequence: number): OrchestrationEvent =>
  ({
    type: "board.card-created",
    sequence,
    payload: {
      cardId: card.id,
      projectId: card.projectId,
      title: card.title,
      key: card.key,
      cardNumber: card.cardNumber,
      labels: card.labels,
      dependsOn: card.dependsOn,
      ...(card.parentCardId === null ? {} : { parentCardId: card.parentCardId }),
      ...(card.sourcePlanId === null ? {} : { sourcePlanId: card.sourcePlanId }),
      stage: card.stage,
      orderKey: card.orderKey,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
    },
  }) as unknown as OrchestrationEvent;

/** A `board.plans-approved` event carrying the parent — the reactor's
    `handlePlansApproved` reads only `payload.card`. */
const plansApproved = (
  card: BoardCard,
  childCardIds: ReadonlyArray<BoardCardId>,
  sequence: number,
): OrchestrationEvent =>
  ({
    type: "board.plans-approved",
    sequence,
    payload: {
      cardId: card.id,
      card,
      childCardIds,
      approvedAt: card.updatedAt,
    },
  }) as unknown as OrchestrationEvent;

const parentId = BoardCardId.make("card-parent");

const parentCard = (): BoardCard => ({
  ...makeBoardCard({
    id: "card-parent",
    stage: "building",
    orderKey: "a",
    // The split's branch-only integration branch (D5): real branch, no
    // worktree until the parent's own review entry.
    worktree: { ...readyWorktree("card-parent"), path: null, status: "branch-only" },
  }),
});

const childCard = (id: string, stage: string, archivedAt: string | null = null): BoardCard => ({
  ...makeBoardCard({ id, stage, orderKey: "m" }),
  parentCardId: parentId,
  archivedAt,
});

/** A child waiting on a sibling, the shape the plan graph materialises. */
const childWaitingOn = (
  id: string,
  stage: string,
  dependsOn: ReadonlyArray<string>,
): BoardCard => ({
  ...childCard(id, stage),
  dependsOn: dependsOn.map((candidate) => BoardCardId.make(candidate)),
});

it.effect(
  "spawns nothing for a parent whose children are unfinished, even in an auto-executing build stage",
  () =>
    withGovernor(
      {
        board: {
          cards: [parentCard(), childCard("card-child", "ready")],
          nextCardNumberByProject: {},
        },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      },
      ({ pumpDomain, board, slots }) =>
        Effect.gen(function* () {
          yield* pumpDomain(movedToBuilding(parentCard(), 1));
          const after = yield* board;
          // No step selected, no slot held: the parent builds THROUGH its
          // children (D4), so the build stage's auto-execute must not touch it.
          assert.strictEqual(stepStatus(after, parentId), null);
          assert.strictEqual(yield* slots.heldTotal, 0);
          assert.strictEqual(cardStage(after, parentId), "building");
        }),
    ),
);

it.effect("advances the parent to the next stage when the last child reaches Done", () =>
  withGovernor(
    {
      board: {
        cards: [parentCard(), childCard("card-done", "done"), childCard("card-final", "done")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        // The last child's arrival at Done (the fixture already holds the
        // post-move card; the event is what the reactor keys on).
        yield* pumpDomain(cardMoved(childCard("card-final", "done"), "merge", "done", 1));
        assert.strictEqual(cardStage(yield* board, parentId), "review");
      }),
  ),
);

it.effect("does not advance the parent while another child is still unfinished", () =>
  withGovernor(
    {
      board: {
        cards: [parentCard(), childCard("card-done", "done"), childCard("card-open", "building")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(cardMoved(childCard("card-done", "done"), "merge", "done", 1));
        assert.strictEqual(cardStage(yield* board, parentId), "building");
      }),
  ),
);

it.effect(
  "does not auto-start a freshly materialised child, even into an auto-executing stage",
  () =>
    withGovernor(
      {
        // The child is created straight into the auto-executing build stage — the
        // worst case for D18 (approving a split must not fan out into N running
        // agents). handleCardCreated must skip kickoff for a card with a parent.
        board: {
          cards: [parentCard()],
          nextCardNumberByProject: {},
        },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      },
      ({ pumpDomain, board, slots }) =>
        Effect.gen(function* () {
          const child = childCard("card-child", "building");
          yield* pumpDomain(cardCreated(child, 1));
          const after = yield* board;
          assert.strictEqual(stepStatus(after, BoardCardId.make("card-child")), null);
          assert.strictEqual(yield* slots.heldTotal, 0);
        }),
    ),
);

it.effect("provisions and runs a build step from a branch-only slice (parent review entry)", () =>
  withGovernor(
    {
      // A split parent reaches its own review carrying the `branch-only`
      // integration-branch slice from approval (t3o-23, D5). `schedule` must
      // (re)provision it — a worktree that is neither ready nor mid-flight
      // provisioning — rather than skip it and leave the review step wedged
      // pending forever. Modelled at the build stage (auto-executes a single
      // step), which shares the exact `schedule` gate.
      board: {
        cards: [
          {
            ...makeBoardCard({ id: "card-1", stage: "building", orderKey: "m" }),
            worktree: { ...readyWorktree("card-1"), path: null, status: "branch-only" },
          },
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ pumpDomain, board, slots }) =>
      Effect.gen(function* () {
        yield* pumpDomain(
          cardMoved(
            {
              ...makeBoardCard({ id: "card-1", stage: "building", orderKey: "m" }),
              worktree: { ...readyWorktree("card-1"), path: null, status: "branch-only" },
            },
            "ready",
            "building",
            1,
          ),
        );
        const after = yield* board;
        // The slice was re-provisioned to ready and the step spawned — not
        // left pending behind an un-provisioned branch-only worktree.
        assert.strictEqual(
          after.cards.find((card) => card.id === BoardCardId.make("card-1"))?.worktree?.status,
          "ready",
        );
        assert.strictEqual(stepStatus(after, BoardCardId.make("card-1")), "running");
        assert.strictEqual(yield* slots.heldTotal, 1);
      }),
  ),
);

it.effect("counts an archived child as finished and advances the parent (D6)", () =>
  withGovernor(
    {
      board: {
        cards: [
          parentCard(),
          childCard("card-done", "done"),
          childCard("card-stray", "building", "2026-01-01T00:00:00.000Z"),
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(
          cardArchived(childCard("card-stray", "building", "2026-01-01T00:00:00.000Z"), 1),
        );
        assert.strictEqual(cardStage(yield* board, parentId), "review");
      }),
  ),
);
// ── The cascade (t3o-28, D3) ───────────────────────────────────────────

it.effect("starts every unblocked child when the PARENT arrives at the build stage", () =>
  withGovernor(
    {
      // The plan graph the split materialised: #1 free, #2 and #3 waiting on
      // it. The parent's Begin build should start #1 and only #1.
      board: {
        cards: [
          parentCard(),
          childCard("card-one", "ready"),
          childWaitingOn("card-two", "ready", ["card-one"]),
          childWaitingOn("card-three", "ready", ["card-one"]),
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(parentCard(), 1));
        const after = yield* board;
        assert.strictEqual(cardStage(after, BoardCardId.make("card-one")), "building");
        // Blocked siblings stay on the floor: the D11 gate would refuse them
        // anyway, so the cascade never asks.
        assert.strictEqual(cardStage(after, BoardCardId.make("card-two")), "ready");
        assert.strictEqual(cardStage(after, BoardCardId.make("card-three")), "ready");
        // And the parent itself still spawns nothing — its build IS the child.
        assert.strictEqual(stepStatus(after, parentId), null);
      }),
  ),
);

it.effect("starts the siblings a finishing child unblocks, with no human in between", () =>
  withGovernor(
    {
      board: {
        cards: [
          parentCard(),
          childCard("card-one", "done"),
          childWaitingOn("card-two", "ready", ["card-one"]),
          childWaitingOn("card-three", "ready", ["card-one"]),
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(cardMoved(childCard("card-one", "done"), "merge", "done", 1));
        const after = yield* board;
        // Both of #1's dependents go at once — the fan is the plan graph's,
        // not a queue of one.
        assert.strictEqual(cardStage(after, BoardCardId.make("card-two")), "building");
        assert.strictEqual(cardStage(after, BoardCardId.make("card-three")), "building");
        // The parent stays put: children are unfinished again.
        assert.strictEqual(cardStage(after, parentId), "building");
      }),
  ),
);

it.effect("starts nothing while the parent is still short of the build stage", () =>
  withGovernor(
    {
      // The children are materialised and unblocked, but the human has not
      // pressed Begin build. Approval is not a start signal (D1).
      board: {
        cards: [
          { ...parentCard(), stage: BoardStageId.make("planning") },
          childCard("card-one", "ready"),
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(
          cardMoved(
            { ...parentCard(), stage: BoardStageId.make("planning") },
            "sprint",
            "planning",
            1,
          ),
        );
        assert.strictEqual(cardStage(yield* board, BoardCardId.make("card-one")), "ready");
      }),
  ),
);

it.effect("leaves a child a human parked past the floor alone", () =>
  withGovernor(
    {
      // Waiting on the floor is the only state the cascade starts. A child
      // already in review is running its own loop and wants no move.
      board: {
        cards: [parentCard(), childCard("card-one", "review")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(parentCard(), 1));
        assert.strictEqual(cardStage(yield* board, BoardCardId.make("card-one")), "review");
      }),
  ),
);

it.effect("restarts the sub-board when a corrected parent lands back on build (t3o-24)", () =>
  withGovernor(
    {
      // A child dragged out of Done pulled the parent back from review; the
      // regression is a move onto build like any other, so whatever is
      // unblocked starts again.
      board: {
        cards: [parentCard(), childCard("card-one", "ready")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(cardMoved(parentCard(), "review", "building", 1));
        assert.strictEqual(cardStage(yield* board, BoardCardId.make("card-one")), "building");
      }),
  ),
);
it.effect("starts the children when a split is APPROVED on a parent already at build", () =>
  withGovernor(
    {
      // Approving from the build stage is legal (a card built conversationally
      // can be split first) and emits no move, so the entering-build trigger
      // never fires. handlePlansApproved must nudge the cascade itself, or the
      // children strand on the floor with nothing to start them (t3o-28, D3).
      // The parent's branch-only worktree makes ensureIntegrationBranch a
      // no-op, so this exercises the cascade nudge and not the git path.
      board: {
        cards: [
          parentCard(),
          childCard("card-one", "ready"),
          childWaitingOn("card-two", "ready", ["card-one"]),
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(
          plansApproved(
            parentCard(),
            [BoardCardId.make("card-one"), BoardCardId.make("card-two")],
            1,
          ),
        );
        const after = yield* board;
        assert.strictEqual(cardStage(after, BoardCardId.make("card-one")), "building");
        // The blocked sibling still waits — the nudge is the cascade, not a
        // blanket start.
        assert.strictEqual(cardStage(after, BoardCardId.make("card-two")), "ready");
      }),
  ),
);

// ── A child's human-in-the-loop stance ─────────────────────────────────

/** The shipped Build stage defaults: a card WITHOUT a plan pauses for a human,
    one WITH a plan runs unattended (D6). The harness turns both off, so this
    re-arms the one that bit: a materialised child owns no `board_plans` row
    (its plan became its brief), and read as plan-less it would pause. */
const settingsPausingPlanless = (): BoardSettings => {
  const settings = settingsWith({ building: [codexStep], globalMaxConcurrent: 3 });
  const building = settings.pipeline[BOARD_SEED_STAGE_IDS.building]!;
  return {
    ...settings,
    pipeline: {
      ...settings.pipeline,
      [BOARD_SEED_STAGE_IDS.building]: {
        ...building,
        humanInLoopWithPlan: false,
        humanInLoopWithoutPlan: true,
      },
    },
  };
};

/** A child as `board.plans.approve` materialises it: cut from one of the
    parent's plans, no plan rows of its own, no explicit stance. */
const materialisedChild = (id: string, stage: string): BoardCard => ({
  ...childCard(id, stage),
  sourcePlanId: boardPlanId(parentId, id),
  humanInLoop: null,
});

it.effect(
  "runs a cascaded child unattended even though it owns no plan row (its plan is its brief)",
  () =>
    withGovernor(
      {
        board: {
          cards: [parentCard(), materialisedChild("card-one", "ready")],
          nextCardNumberByProject: {},
        },
        settings: settingsPausingPlanless(),
      },
      ({ pumpDomain, board }) =>
        Effect.gen(function* () {
          // Begin build on the parent cascades #1 onto the build stage …
          yield* pumpDomain(movedToBuilding(parentCard(), 1));
          const childId = BoardCardId.make("card-one");
          assert.strictEqual(cardStage(yield* board, childId), "building");
          // … and the child's own arrival there (the reactor's dispatched
          // move, observed as any move is) selects its build step.
          yield* pumpDomain(
            movedToBuilding(
              { ...materialisedChild("card-one", "building"), worktree: readyWorktree("card-one") },
              2,
            ),
          );
          const state = boardCardStepState(yield* board, childId);
          assert.isNotNull(state);
          // The whole point of the sub-board: dependency resolution → build →
          // PR → merge with no human in between (t3o-28, D3). A materialised
          // child is a planned build — the plan-less pause must not apply.
          assert.strictEqual(state!.humanInLoop, false);
        }),
    ),
);

it.effect("still pauses a child a human explicitly put in the loop", () =>
  withGovernor(
    {
      board: {
        cards: [parentCard(), { ...materialisedChild("card-one", "ready"), humanInLoop: true }],
        nextCardNumberByProject: {},
      },
      settings: settingsPausingPlanless(),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(parentCard(), 1));
        yield* pumpDomain(
          movedToBuilding(
            {
              ...materialisedChild("card-one", "building"),
              humanInLoop: true,
              worktree: readyWorktree("card-one"),
            },
            2,
          ),
        );
        const state = boardCardStepState(yield* board, BoardCardId.make("card-one"));
        assert.isNotNull(state);
        assert.strictEqual(state!.humanInLoop, true);
      }),
  ),
);

// ── Merging a child down (t3o-23 D4, t3o-28 D3) ────────────────────────
//
// The sub-board's whole promise is dependency resolution → build → PR → merge
// with NO human in between. The human act was Begin build on the parent; a
// child that sits at the merge stage waiting to be clicked breaks the chain
// and strands every sibling that depends on it.

const openPr: VcsStatusChangeRequest = {
  number: 284,
  title: "Services index page",
  url: "https://github.com/acme/repo/pull/284",
  baseRef: "board/tt-9",
  headRef: "board/card-one",
  state: "open",
};

/** The merge-role and done-role stage ids, as the seed board names them. */
const MERGE = String(BOARD_SEED_STAGE_IDS.merge);
const DONE = String(BOARD_SEED_STAGE_IDS.done);

/** A child sitting at the merge stage with the branch its pull request is
    open on — the state the review stage's auto-advance leaves it in. */
const childAtMerge = (id: string): BoardCard => ({
  ...childCard(id, MERGE),
  worktree: readyWorktree(id),
});

/** A child arriving at the merge stage off its review auto-advance. */
const childReachedMerge = (id: string, sequence: number): OrchestrationEvent =>
  cardMoved(childAtMerge(id), "review", MERGE, sequence);

/** The same card shape with no parent: a top-level card at the merge stage. */
const soloAtMerge = (): BoardCard =>
  makeBoardCard({
    id: "card-solo",
    stage: MERGE,
    orderKey: "m",
    worktree: readyWorktree("card-solo"),
  });

const mergeRefusedNotes = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter(
    (command) => command.type === "board.card.record-note" && command.kind === "card-merge-refused",
  );

it.effect("merges a child that reaches the merge stage and lands it in Done", () =>
  withGovernor(
    {
      board: {
        cards: [parentCard(), childAtMerge("card-one")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      pullRequest: openPr,
    },
    (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(childReachedMerge("card-one", 1));
        // The forge was actually asked — the card did not merely move.
        assert.deepStrictEqual(yield* h.mergeAttempts, [{ number: 284 }]);
        assert.strictEqual(cardStage(yield* h.board, BoardCardId.make("card-one")), DONE);
      }),
  ),
);

it.effect("leaves a TOP-LEVEL card at the merge stage for a human to click Merge", () =>
  withGovernor(
    {
      board: {
        cards: [soloAtMerge()],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      pullRequest: openPr,
    },
    (h) =>
      Effect.gen(function* () {
        // The merge spec's line holds everywhere the sub-board is not: no merge
        // happens that a human did not initiate.
        yield* h.pumpDomain(cardMoved(soloAtMerge(), "review", MERGE, 1));
        assert.deepStrictEqual(yield* h.mergeAttempts, []);
        assert.strictEqual(cardStage(yield* h.board, BoardCardId.make("card-solo")), MERGE);
      }),
  ),
);

it.effect("resolves the dependency tree off the merge: the freed sibling goes to build", () =>
  withGovernor(
    {
      board: {
        cards: [
          parentCard(),
          childAtMerge("card-one"),
          childWaitingOn("card-two", "ready", ["card-one"]),
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      pullRequest: openPr,
    },
    (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(childReachedMerge("card-one", 1));
        const after = yield* h.board;
        // One event, the whole chain: merge → Done → the dependency the merge
        // just satisfied → the sibling into build.
        assert.strictEqual(cardStage(after, BoardCardId.make("card-one")), DONE);
        assert.strictEqual(cardStage(after, BoardCardId.make("card-two")), "building");
        // The parent stays put — it still has an unfinished child.
        assert.strictEqual(cardStage(after, parentId), "building");
      }),
  ),
);

it.effect("advances the parent when the LAST child merges itself down", () =>
  withGovernor(
    {
      board: {
        cards: [parentCard(), childCard("card-done", "done"), childAtMerge("card-one")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      pullRequest: openPr,
    },
    (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(childReachedMerge("card-one", 1));
        const after = yield* h.board;
        assert.strictEqual(cardStage(after, BoardCardId.make("card-one")), DONE);
        assert.strictEqual(cardStage(after, parentId), "review");
      }),
  ),
);

it.effect("stops at a merge the forge REFUSES, and says so on the card", () =>
  withGovernor(
    {
      board: {
        cards: [parentCard(), childAtMerge("card-one")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      pullRequest: openPr,
      mergeFailure: "Required status check 'test' is failing.",
    },
    (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(childReachedMerge("card-one", 1));
        // A policy block needs a human (the merge spec's rule, unchanged): the
        // card holds at merge and the reason is on the activity rail rather
        // than in a server log nobody is reading.
        assert.strictEqual(cardStage(yield* h.board, BoardCardId.make("card-one")), MERGE);
        const notes = mergeRefusedNotes(yield* h.commands);
        assert.strictEqual(notes.length, 1);
        assert.include(String((notes[0] as { readonly detail: string }).detail), "status check");
      }),
  ),
);
