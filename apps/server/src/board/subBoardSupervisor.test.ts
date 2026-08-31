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
  type OrchestrationEvent,
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
