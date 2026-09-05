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
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardCardStepState,
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
  NOW,
  readyWorktree,
  settingsWith,
  stepCompleted,
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

it.effect("does not merge a child a human pulled BACK out of Done", () =>
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
        // A backward drag is an UNDO. Answering it by immediately re-merging on
        // the forge is both surprising and irreversible, so the hook takes
        // forward arrivals only — the same condition the t3o-24 crossing gate
        // applies just above it.
        yield* h.pumpDomain(cardMoved(childAtMerge("card-one"), DONE, MERGE, 1));
        assert.deepStrictEqual(yield* h.mergeAttempts, []);
        assert.strictEqual(cardStage(yield* h.board, BoardCardId.make("card-one")), MERGE);
      }),
  ),
);

it.effect("does not merge a child a human dragged straight from Building, skipping review", () =>
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
        // A forward JUMP is a human overriding the pipeline, not the pipeline
        // delivering the card. Merging here would land a diff no review round
        // has ever seen — irreversibly, off one drag.
        yield* h.pumpDomain(cardMoved(childAtMerge("card-one"), "building", MERGE, 1));
        assert.deepStrictEqual(yield* h.mergeAttempts, []);
        assert.strictEqual(cardStage(yield* h.board, BoardCardId.make("card-one")), MERGE);
      }),
  ),
);

// ── The pipeline end-to-end (the reported failure) ─────────────────────
//
// Every test above pumps ONE event and asserts the immediate handler. That
// proves each handler in isolation but NOT the chain: in production a handler
// DISPATCHES a command, the engine persists the resulting event and REPUBLISHES
// it (OrchestrationEngine `eventPubSub`), and the reactor's own subscription
// routes it back through `handleCardMoved` / `handleStepCompleted`. The test
// engine double does not republish — `applyDecided` updates the model but never
// re-feeds the reactor — so a chain that only works because a dispatched move
// re-enters the reactor is GREEN here and BROKEN in the app.
//
// `drainBus` closes that gap: it re-feeds every newly-decided domain event back
// through the reactor until the bus goes quiet, exactly as the real PubSub does.
// Step completions are excluded — the reactor never dispatches one, and pumping
// it would re-project a completion already folded in.
const REFEED_TYPES = new Set<string>([
  "board.card-moved",
  "board.card-created",
  "board.plans-approved",
  "board.card-archived",
  "board.card-deleted",
]);

const drainBus = (
  h: {
    readonly decided: Effect.Effect<ReadonlyArray<OrchestrationEvent>>;
    readonly pumpDomain: (e: OrchestrationEvent) => Effect.Effect<void>;
  },
  fed: { value: number },
) =>
  Effect.gen(function* () {
    for (let guard = 0; guard < 100; guard += 1) {
      const decided = yield* h.decided;
      const fresh = decided.slice(fed.value);
      fed.value = decided.length;
      const toFeed = fresh.filter((event) => REFEED_TYPES.has(event.type));
      if (toFeed.length === 0) return;
      for (const event of toFeed) yield* h.pumpDomain(event);
    }
    throw new Error("drainBus did not settle in 100 iterations");
  });

it.effect("PIPELINE 4: a MANUALLY merged child cascades its freed siblings into build", () =>
  withGovernor(
    {
      board: {
        cards: [
          parentCard(),
          childAtMerge("card-one"),
          childWaitingOn("card-two", "ready", ["card-one"]),
          childWaitingOn("card-three", "ready", ["card-one"]),
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      pullRequest: openPr,
    },
    (h) =>
      Effect.gen(function* () {
        const fed = { value: (yield* h.decided).length };
        // The human clicks Merge — the RPC path, not an auto-merge on arrival.
        const result = yield* h.reactor.mergePullRequest(BoardCardId.make("card-one"));
        assert.strictEqual(result.outcome, "merged");
        // The real PubSub now re-feeds the child's move-to-Done through the
        // reactor. Model that; without it the chain below never runs.
        yield* drainBus(h, fed);
        const after = yield* h.board;
        assert.strictEqual(cardStage(after, BoardCardId.make("card-one")), DONE);
        // The reported failure: both freed siblings must now be building.
        assert.strictEqual(cardStage(after, BoardCardId.make("card-two")), "building");
        assert.strictEqual(cardStage(after, BoardCardId.make("card-three")), "building");
        // And unattended — the whole point of the sub-board.
        assert.strictEqual(
          boardCardStepState(after, BoardCardId.make("card-two"))?.humanInLoop,
          false,
        );
      }),
  ),
);

// ── The stranded split (the reported production bug) ────────────────────
//
// The dev DB that surfaced this: a parent dragged back to the floor (`ready`)
// while its children were mid-flight. One child then reached Done, but its
// freed siblings never cascaded — the cascade gated on the parent sitting
// EXACTLY at the build stage, and a begun split whose parent a human parked
// below build silently stopped. The split must run to completion regardless of
// where the parent is parked.

/** A parent parked at the floor (`ready`) — below the build stage — while its
    split is already underway. */
const parentParkedAtFloor = (): BoardCard => ({
  ...parentCard(),
  stage: BoardStageId.make("ready"),
});

it.effect("cascades a freed sibling even when the parent was parked below build", () =>
  withGovernor(
    {
      board: {
        cards: [
          parentParkedAtFloor(),
          // A child that already reached Done — proof the split has begun.
          childCard("card-one", DONE),
          // Its freed sibling, unblocked now that card-one is done.
          childWaitingOn("card-two", "ready", ["card-one"]),
          // A still-blocked grandchild dependency stays put.
          childWaitingOn("card-three", "ready", ["card-two"]),
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    (h) =>
      Effect.gen(function* () {
        const fed = { value: (yield* h.decided).length };
        // card-one arriving at Done is the trigger the reactor keys on.
        yield* h.pumpDomain(cardMoved(childCard("card-one", DONE), "merge", DONE, 1));
        // Let the freed sibling's own move-into-build re-enter the reactor, as
        // the real event bus does, so its build step actually starts.
        yield* drainBus(h, fed);
        const after = yield* h.board;
        assert.strictEqual(cardStage(after, BoardCardId.make("card-two")), "building");
        assert.strictEqual(cardStage(after, BoardCardId.make("card-three")), "ready");
        // …and it started unattended — the whole point of the sub-board.
        assert.strictEqual(
          boardCardStepState(after, BoardCardId.make("card-two"))?.humanInLoop,
          false,
        );
      }),
  ),
);

it.effect("still waits for Begin build on a split that has NOT begun", () =>
  withGovernor(
    {
      // Parent parked at the floor, every child still on the floor — nobody has
      // pressed Begin build, so approval alone must start nothing (t3o-28 D1).
      board: {
        cards: [
          parentParkedAtFloor(),
          childCard("card-one", "ready"),
          childCard("card-two", "ready"),
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(cardMoved(parentParkedAtFloor(), "planning", "ready", 1));
        const after = yield* board;
        assert.strictEqual(cardStage(after, BoardCardId.make("card-one")), "ready");
        assert.strictEqual(cardStage(after, BoardCardId.make("card-two")), "ready");
      }),
  ),
);

// ── Point 2: a child's build auto-advances to review, which auto-starts ──
//
// Faithful chain: the child finishes building, the completion re-enters the
// reactor via the bus, the build stage auto-advances the card to review, and
// the review-role stage — which auto-executes — selects the first review step
// with no human. The bare-pump tests elsewhere prove each hop; this proves they
// connect.

/** A running build step for a child, the state right after admission. */
const runningBuildStep = (cardId: BoardCardId): BoardCardStepState => ({
  cardId,
  stepId: String(BOARD_SEED_STAGE_IDS.building),
  stepLabel: "Building",
  stageLabel: "Building",
  attempt: 1,
  stallCount: 0,
  lastNudgeAt: null,
  baseTipAtRoundStart: null,
  lastError: null,
  prompt: "implement the card",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
  mode: "build",
  runtimeMode: "auto",
  humanInLoop: false,
  maxAttempts: 3,
  timeoutMs: 1_000,
  threadId: ThreadId.make("thread-build-one"),
  status: "running",
  slotHeld: true,
  forceStart: false,
  startedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

it.effect("PIPELINE 2: a child's finished build auto-advances to review and it auto-starts", () =>
  withGovernor(
    {
      board: {
        cards: [
          parentCard(),
          { ...childCard("card-one", "building"), worktree: readyWorktree("card-one") },
        ],
        stepStates: [runningBuildStep(BoardCardId.make("card-one"))],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: new Map([["thread-build-one", { id: "thread-build-one" } as never]]),
    },
    (h) =>
      Effect.gen(function* () {
        const fed = { value: (yield* h.decided).length };
        // The build reports success. The completion re-enters the reactor, the
        // build stage auto-advances, and review auto-starts — all off one event.
        yield* h.pumpDomain(stepCompleted(BoardCardId.make("card-one"), "succeeded", 2));
        yield* drainBus(h, fed);
        const after = yield* h.board;
        assert.strictEqual(cardStage(after, BoardCardId.make("card-one")), "review");
        // A review step is live — the loop started with no human in between.
        const step = boardCardStepState(after, BoardCardId.make("card-one"));
        assert.isNotNull(step);
        assert.strictEqual(step!.humanInLoop, false);
      }),
  ),
);

// ── Point 3: a child's converged review auto-merges to Done ─────────────
//
// The capstone chain: a one-round review converges, the loop advances the
// child to the merge stage, and — because it is a sub-board child — it merges
// itself down to Done with no human. Each hop has a bare-pump test; this proves
// the review verdict flows all the way to Done off one completion.

/** A running first-round review step for a child. */
const runningReviewStep = (cardId: BoardCardId): BoardCardStepState => ({
  ...runningBuildStep(cardId),
  stepId: "review@1",
  stepLabel: "Review",
  stageLabel: "Code review",
  threadId: ThreadId.make("thread-review-one"),
});

/** A converged review completion (a round that ran with no blocking finding). */
const convergedReviewCompleted = (cardId: BoardCardId, sequence: number): OrchestrationEvent =>
  ({
    type: "board.card-step-completed",
    sequence,
    payload: {
      cardId,
      completion: {
        cardId,
        stepId: "review@1",
        outcome: "succeeded",
        summary: "review converged",
        payload: JSON.stringify({ reviewedSha: "sha-1", findings: [] }),
        threadId: ThreadId.make("thread-review-one"),
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  }) as unknown as OrchestrationEvent;

it.effect("PIPELINE 3: a child's converged review auto-merges it through to Done", () =>
  withGovernor(
    {
      board: {
        cards: [
          parentCard(),
          {
            ...childCard("card-one", "review"),
            worktree: readyWorktree("card-one"),
            reviewOverrides: { rounds: 1, stopAfterRound: null, roundModels: {} },
          },
        ],
        stepStates: [runningReviewStep(BoardCardId.make("card-one"))],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      pullRequest: openPr,
      initialShells: new Map([["thread-review-one", { id: "thread-review-one" } as never]]),
    },
    (h) =>
      Effect.gen(function* () {
        const fed = { value: (yield* h.decided).length };
        yield* h.pumpDomain(convergedReviewCompleted(BoardCardId.make("card-one"), 2));
        yield* drainBus(h, fed);
        const after = yield* h.board;
        // Converged → advanced to merge → auto-merged → Done, no human.
        assert.deepStrictEqual(yield* h.mergeAttempts, [{ number: 284 }]);
        assert.strictEqual(cardStage(after, BoardCardId.make("card-one")), DONE);
      }),
  ),
);

// ---------------------------------------------------------------------------
// Restarting a child's merge stage by hand.
//
// The merge role's re-entry rule ("not armed means open a clean
// human-in-the-loop conversation") is written for a top-level card, whose merge
// must always be a deliberate click. A sub-board child is the shape that rule
// does not describe: the human initiated it at Begin build on the parent, and
// the arm that marks that is IN-MEMORY and is dropped by `recoverStep` the
// moment a conflict fix escalates. So the one path a human has to rescue a
// failed conflict fix — the card's stage-restart button — used to hand the
// child a blank, human-in-the-loop thread that no auto-advance and no drop
// detection would ever follow up on, and the card stranded at Merge with a
// merged pull request.

/** The on-demand kickoff the stage-restart button dispatches. */
const stageThreadRequested = (card: BoardCard, sequence: number): OrchestrationEvent =>
  ({
    type: "board.card-stage-thread-requested",
    sequence,
    payload: { cardId: card.id, stage: card.stage },
  }) as unknown as OrchestrationEvent;

/** A merge-stage step reporting success — the testkit's own `stepCompleted` is
    scoped to the building step id. */
const mergeStepSucceeded = (
  cardId: BoardCardId,
  threadId: ThreadId,
  sequence: number,
): OrchestrationEvent =>
  ({
    type: "board.card-step-completed",
    sequence,
    payload: {
      cardId,
      completion: {
        cardId,
        stepId: MERGE,
        outcome: "succeeded",
        summary: "resolved the conflicts",
        payload: null,
        threadId,
        completedAt: NOW,
      },
    },
  }) as unknown as OrchestrationEvent;

const selectedSteps = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter((command) => command.type === "board.card.select-step") as ReadonlyArray<{
    readonly prompt: string;
    readonly humanInLoop: boolean;
  }>;

/** A child at the merge stage that has ALREADY been through a conflict fix —
    the completion is what makes the re-entry rule fire, and the tombstoned
    link is the dead fix's thread. */
const childRetryingMerge = () => {
  const card: BoardCard = {
    ...childAtMerge("card-one"),
    threadLinks: [
      {
        threadId: ThreadId.make("thread-dead-fix"),
        role: MERGE,
        linkedAt: NOW,
        tombstonedAt: NOW,
      },
    ],
  };
  return {
    card,
    completion: {
      cardId: card.id,
      stepId: MERGE,
      outcome: "succeeded" as const,
      summary: "resolved the conflicts",
      payload: null,
      threadId: null,
      completedAt: NOW,
    },
  };
};

it.effect("restarting a child's merge stage re-attempts the MERGE, not a conversation", () =>
  Effect.gen(function* () {
    const { card, completion } = childRetryingMerge();
    yield* withGovernor(
      {
        board: {
          cards: [parentCard(), card],
          stepCompletions: [completion],
          nextCardNumberByProject: {},
        },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
        pullRequest: openPr,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(stageThreadRequested(card, 1));
          // The forge decides, so the restart asks it: the conflict that
          // stranded this card has since been fixed, and the card lands.
          assert.deepStrictEqual(yield* h.mergeAttempts, [{ number: 284 }]);
          assert.strictEqual(cardStage(yield* h.board, card.id), DONE);
          // And no agent was spawned to "fix" a branch with nothing wrong.
          assert.deepStrictEqual(selectedSteps(yield* h.commands), []);
        }),
    );
  }),
);

it.effect("a restart that still conflicts runs the conflict prompt UNATTENDED", () =>
  Effect.gen(function* () {
    const { card, completion } = childRetryingMerge();
    yield* withGovernor(
      {
        board: {
          cards: [parentCard(), card],
          stepCompletions: [completion],
          nextCardNumberByProject: {},
        },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
        pullRequest: openPr,
        mergeFailure: "Pull request is not mergeable: merge conflict between base and head",
      },
      (h) =>
        Effect.gen(function* () {
          // The restart's merge attempt re-arms the card, and the conflict step
          // it requests comes back through this same handler — armed this time.
          yield* h.pumpDomain(stageThreadRequested(card, 1));
          yield* h.pumpDomain(stageThreadRequested(card, 2));
          const selected = selectedSteps(yield* h.commands);
          assert.equal(selected.length, 1, "one conflict step should have been selected");
          // The regression: a blank human-in-the-loop thread. A child never
          // gets one — nothing would resume it, and nothing would advance it.
          assert.isFalse(selected[0]!.humanInLoop);
          assert.isAbove(selected[0]!.prompt.trim().length, 0);
        }),
    );
  }),
);

it.effect("a restart the forge refuses on POLICY spawns no agent and says why", () =>
  Effect.gen(function* () {
    const { card, completion } = childRetryingMerge();
    yield* withGovernor(
      {
        board: {
          cards: [parentCard(), card],
          stepCompletions: [completion],
          nextCardNumberByProject: {},
        },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
        pullRequest: openPr,
        mergeFailure: "Required status check 'test' is failing.",
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(stageThreadRequested(card, 1));
          // Asking the forge instead of assuming a conflict is the whole point:
          // this refusal needs a human, and an agent sent to "resolve" it would
          // merge base into a healthy branch for no reason.
          assert.deepStrictEqual(selectedSteps(yield* h.commands), []);
          assert.equal(mergeRefusedNotes(yield* h.commands).length, 1);
          assert.strictEqual(cardStage(yield* h.board, card.id), MERGE);
        }),
    );
  }),
);

it.effect("restarting a TOP-LEVEL card's merge stage still opens a human conversation", () =>
  Effect.gen(function* () {
    const card = soloAtMerge();
    yield* withGovernor(
      {
        board: { cards: [card], nextCardNumberByProject: {} },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
        pullRequest: openPr,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(stageThreadRequested(card, 1));
          // The carve-out is exactly one card shape. A top-level card keeps the
          // merge spec's rule: the restart is a conversation, and the forge is
          // not touched until a human clicks Merge.
          assert.deepStrictEqual(yield* h.mergeAttempts, []);
          const selected = selectedSteps(yield* h.commands);
          assert.equal(selected.length, 1);
          assert.isTrue(selected[0]!.humanInLoop);
        }),
    );
  }),
);

it.effect("a child's conflict fix succeeding merges even when the arm was LOST", () =>
  Effect.gen(function* () {
    // The arm lives in memory, so a fix that spans a server restart completes
    // with nothing armed. The merge stage's `autoAdvance` is off by design, so
    // before the carve-out that child stranded at Merge with its conflicts
    // resolved and nothing left that would ever merge it.
    const card = childAtMerge("card-one");
    const step: BoardCardStepState = {
      cardId: card.id,
      stepId: MERGE,
      stepLabel: null,
      stageLabel: "Ready for merge",
      attempt: 1,
      stallCount: 0,
      lastNudgeAt: null,
      baseTipAtRoundStart: null,
      lastError: null,
      prompt: "resolve the conflicts",
      providerInstanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
      mode: "build",
      runtimeMode: "auto",
      humanInLoop: false,
      maxAttempts: 3,
      timeoutMs: 1_000,
      threadId: ThreadId.make("thread-fix"),
      status: "running",
      slotHeld: true,
      forceStart: false,
      startedAt: NOW,
      updatedAt: NOW,
    };
    yield* withGovernor(
      {
        board: {
          cards: [parentCard(), card],
          stepStates: [step],
          nextCardNumberByProject: {},
        },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
        pullRequest: openPr,
        initialShells: new Map([["thread-fix", { id: "thread-fix" } as never]]),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(mergeStepSucceeded(card.id, ThreadId.make("thread-fix"), 1));
          assert.deepStrictEqual(yield* h.mergeAttempts, [{ number: 284 }]);
          assert.strictEqual(cardStage(yield* h.board, card.id), DONE);
        }),
    );
  }),
);
