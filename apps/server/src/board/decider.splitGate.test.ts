/**
 * The split gate (T3O-31): Planned vs Needs-planning children, the agent's
 * recommended group settings and their fallback rules, and approval applying
 * the human's final settings without starting anything.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  BoardStageId,
  boardPlanId,
  CommandId,
  ProjectId,
  type BoardCard,
  type BoardCardGroupTarget,
  type BoardPlan,
  type BoardProposedPlanInput,
  type BoardState,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { boardDecidedEvents, type BoardCommand, type PlannedBoardEvent } from "./decider.ts";
import { decideBoardCommandOnModel } from "./decisionContext.testkit.ts";
import type { BoardOrchestrationReadModel } from "./decisionContext.testkit.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const parentId = BoardCardId.make("card-parent");
const WHY = "The schema and the pane ship on separate branches and review separately.";

function makeCard(
  overrides: Omit<Partial<BoardCard>, "id" | "stage"> & {
    readonly id: string;
    readonly stage?: string;
  },
): BoardCard {
  const { id, stage, ...rest } = overrides;
  return {
    key: `T3-${id.replace(/\D/g, "") || "1"}`,
    cardNumber: 1,
    projectId,
    labels: [],
    orderKey: "m",
    title: "Card",
    briefRef: null,
    dependsOn: [],
    parentCardId: null,
    sourcePlanId: null,
    group: null,
    threadLinks: [],
    attachments: [],
    externalRef: null,
    humanInLoop: null,
    reviewOverrides: null,
    modelOverrides: null,
    splitRationale: null,
    baseBranch: null,
    scheduledStartAt: null,
    autoPlanSetting: null,
    autoBuildSetting: null,
    autoMergeSetting: null,
    autoMergeHold: null,
    mergeStrategy: null,
    pinnedWorkerId: null,
    placedWorkerId: null,
    workerMove: null,
    placementOrphaned: null,
    ci: null,
    ciLastOutcome: null,
    ciRoundTrips: 0,
    worktree: null,
    pullRequest: null,
    pullRequestHistory: [],
    pullRequestFloor: null,
    blocked: false,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...rest,
    stage: BoardStageId.make(stage ?? "planning"),
    id: BoardCardId.make(id),
  };
}

function makePlan(input: {
  readonly cardId?: BoardCardId;
  readonly key: string;
  readonly ordinal: number;
  readonly planned?: boolean;
  readonly dependsOnKeys?: ReadonlyArray<string>;
}): BoardPlan {
  const cardId = input.cardId ?? parentId;
  return {
    planId: boardPlanId(cardId, input.key),
    cardId,
    title: `Plan ${input.key}`,
    summary: `Part ${input.key}`,
    dependsOn: (input.dependsOnKeys ?? []).map((key) => boardPlanId(cardId, key)),
    ordinal: input.ordinal,
    locked: false,
    ...(input.planned === undefined ? {} : { planned: input.planned }),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeBoard(input: {
  readonly parent?: Partial<Parameters<typeof makeCard>[0]>;
  readonly extraCards?: ReadonlyArray<BoardCard>;
  readonly plans?: ReadonlyArray<BoardPlan>;
}): BoardState {
  const parent = makeCard({ id: "card-parent", key: "T3-190", cardNumber: 190, ...input.parent });
  return {
    cards: [parent, ...(input.extraCards ?? [])],
    plans: input.plans ?? [],
    nextCardNumberByProject: { [projectId]: 191 },
  };
}

function makeReadModel(board: BoardState): BoardOrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: projectId,
        title: "Project 1",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads: [],
    board,
    updatedAt: NOW,
  };
}

const decideEvents = (command: BoardCommand, board: BoardState) =>
  decideBoardCommandOnModel({ command, readModel: makeReadModel(board) }).pipe(
    Effect.map(boardDecidedEvents),
  );

const proposedPlan = (
  key: string,
  overrides?: Partial<BoardProposedPlanInput>,
): BoardProposedPlanInput => ({
  key,
  title: key,
  summary: `About ${key}`,
  dependsOn: [],
  body: `# ${key}`,
  ...overrides,
});

const propose = (input: {
  readonly cardId?: string;
  readonly plans: ReadonlyArray<BoardProposedPlanInput>;
  readonly recommendedAutoBuild?: boolean;
  readonly recommendedMergeTarget?: BoardCardGroupTarget;
}): BoardCommand => ({
  type: "board.plans.propose",
  commandId: CommandId.make("cmd-propose"),
  cardId: BoardCardId.make(input.cardId ?? "card-parent"),
  plans: input.plans,
  splitRationale: input.plans.length >= 2 ? WHY : null,
  ...(input.recommendedAutoBuild === undefined
    ? {}
    : { recommendedAutoBuild: input.recommendedAutoBuild }),
  ...(input.recommendedMergeTarget === undefined
    ? {}
    : { recommendedMergeTarget: input.recommendedMergeTarget }),
  createdAt: NOW,
});

const approve = (input?: {
  readonly cardId?: string;
  readonly autoBuild?: boolean;
  readonly mergeTarget?: BoardCardGroupTarget;
}): BoardCommand => ({
  type: "board.plans.approve",
  commandId: CommandId.make("cmd-approve"),
  cardId: BoardCardId.make(input?.cardId ?? "card-parent"),
  ...(input?.autoBuild === undefined ? {} : { autoBuild: input.autoBuild }),
  ...(input?.mergeTarget === undefined ? {} : { mergeTarget: input.mergeTarget }),
  createdAt: NOW,
});

const proposedEvent = (events: ReadonlyArray<PlannedBoardEvent>) => {
  const event = events.find((candidate) => candidate.type === "board.plans-proposed");
  assert.ok(event?.type === "board.plans-proposed");
  return event;
};

const approvedEvent = (events: ReadonlyArray<PlannedBoardEvent>) => {
  const event = events.find((candidate) => candidate.type === "board.plans-approved");
  assert.ok(event?.type === "board.plans-approved");
  return event;
};

const createdEvents = (events: ReadonlyArray<PlannedBoardEvent>) =>
  events.flatMap((event) => (event.type === "board.card-created" ? [event] : []));

/** An own-branch group holding the card that is being split. */
const ownGroup = makeCard({
  id: "card-outer",
  key: "T3-100",
  cardNumber: 100,
  stage: "building",
  group: {
    target: "own",
    autoBuild: true,
    autoMerge: false,
    autoPlan: false,
    started: true,
    placed: BOARD_SEED_STAGE_IDS.ready,
    prevStage: BOARD_SEED_STAGE_IDS.planning,
    heading: false,
    integrated: false,
  },
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("split gate (T3O-31)", (it) => {
  // ── Propose: the Planned flag and the recommendation ────────────────

  it.effect("records Needs planning on a split plan and leaves Planned absent", () =>
    Effect.gen(function* () {
      const event = proposedEvent(
        yield* decideEvents(
          propose({ plans: [proposedPlan("a"), proposedPlan("b", { planned: false })] }),
          makeBoard({}),
        ),
      );
      expect(event.payload.plans.map((plan) => plan.planned)).toEqual([undefined, false]);
    }),
  );

  it.effect("ignores the Planned flag on a single plan, which is the card's own", () =>
    Effect.gen(function* () {
      const event = proposedEvent(
        yield* decideEvents(
          propose({ plans: [proposedPlan("a", { planned: false })] }),
          makeBoard({}),
        ),
      );
      expect(event.payload.plans[0]?.planned).toBeUndefined();
      expect(event.payload.splitRecommendation).toBeUndefined();
    }),
  );

  it.effect("falls back to auto-build on and its own branch when every child is planned", () =>
    Effect.gen(function* () {
      const event = proposedEvent(
        yield* decideEvents(
          propose({ plans: [proposedPlan("a"), proposedPlan("b", { planned: true })] }),
          makeBoard({}),
        ),
      );
      expect(event.payload.splitRecommendation).toEqual({ autoBuild: true, mergeTarget: "own" });
    }),
  );

  it.effect("falls back to auto-build off and inherit when any child needs planning", () =>
    Effect.gen(function* () {
      const event = proposedEvent(
        yield* decideEvents(
          propose({ plans: [proposedPlan("a"), proposedPlan("b", { planned: false })] }),
          makeBoard({}),
        ),
      );
      expect(event.payload.splitRecommendation).toEqual({
        autoBuild: false,
        mergeTarget: "inherit",
      });
    }),
  );

  it.effect("falls back to inherit under an ancestor with its own branch", () =>
    Effect.gen(function* () {
      const event = proposedEvent(
        yield* decideEvents(
          propose({ plans: [proposedPlan("a"), proposedPlan("b")] }),
          makeBoard({ parent: { parentCardId: ownGroup.id }, extraCards: [ownGroup] }),
        ),
      );
      expect(event.payload.splitRecommendation).toEqual({
        autoBuild: true,
        mergeTarget: "inherit",
      });
    }),
  );

  it.effect("keeps the agent's explicit recommendation, filling only an omitted field", () =>
    Effect.gen(function* () {
      const both = proposedEvent(
        yield* decideEvents(
          propose({
            plans: [proposedPlan("a"), proposedPlan("b")],
            recommendedAutoBuild: false,
            recommendedMergeTarget: "inherit",
          }),
          makeBoard({}),
        ),
      );
      expect(both.payload.splitRecommendation).toEqual({
        autoBuild: false,
        mergeTarget: "inherit",
      });
      const one = proposedEvent(
        yield* decideEvents(
          propose({
            plans: [proposedPlan("a"), proposedPlan("b", { planned: false })],
            recommendedMergeTarget: "own",
          }),
          makeBoard({}),
        ),
      );
      expect(one.payload.splitRecommendation).toEqual({ autoBuild: false, mergeTarget: "own" });
    }),
  );

  // ── Approve: landing stages and settings ────────────────────────────

  it.effect("lands Planned children in Ready and Needs-planning children in Backlog", () =>
    Effect.gen(function* () {
      const events = yield* decideEvents(
        approve(),
        makeBoard({
          parent: { splitRationale: WHY },
          plans: [
            makePlan({ key: "p1", ordinal: 0 }),
            makePlan({ key: "p2", ordinal: 1, planned: false, dependsOnKeys: ["p1"] }),
            makePlan({ key: "p3", ordinal: 2, planned: false }),
          ],
        }),
      );
      const [first, second, third] = createdEvents(events);
      assert.ok(first !== undefined && second !== undefined && third !== undefined);
      expect(first.payload.stage).toBe(BOARD_SEED_STAGE_IDS.ready);
      expect(first.payload.briefOnly).toBeUndefined();
      expect(second.payload.stage).toBe(BOARD_SEED_STAGE_IDS.backlog);
      expect(second.payload.briefOnly).toBe(true);
      expect(third.payload.stage).toBe(BOARD_SEED_STAGE_IDS.backlog);
      // Both carry the body as their brief; the dependency graph still maps.
      expect(second.payload.briefFromPlanId).toBe(boardPlanId(parentId, "p2"));
      expect(second.payload.dependsOn).toEqual([first.payload.cardId]);
      // Siblings sharing a column sort in plan order.
      assert.ok(String(second.payload.orderKey) < String(third.payload.orderKey));
    }),
  );

  it.effect("applies the stored recommendation and starts nothing", () =>
    Effect.gen(function* () {
      const events = yield* decideEvents(
        approve(),
        makeBoard({
          parent: {
            splitRationale: WHY,
            splitRecommendation: { autoBuild: false, mergeTarget: "inherit" },
          },
          plans: [makePlan({ key: "p1", ordinal: 0 }), makePlan({ key: "p2", ordinal: 1 })],
        }),
      );
      // Children and the approval record only: no move, no step.
      expect(events.map((event) => event.type)).toEqual([
        "board.card-created",
        "board.card-created",
        "board.plans-approved",
      ]);
      const approved = approvedEvent(events);
      expect(approved.payload.card.stage).toBe(BOARD_SEED_STAGE_IDS.planning);
      expect(approved.payload.card.group).toMatchObject({
        target: "inherit",
        autoBuild: false,
        started: false,
        placed: BOARD_SEED_STAGE_IDS.planning,
      });
    }),
  );

  it.effect("gives an own branch to a split with Needs-planning children (T3O-53)", () =>
    Effect.gen(function* () {
      const plans = [
        makePlan({ key: "p1", ordinal: 0 }),
        makePlan({ key: "p2", ordinal: 1, planned: false }),
      ];
      const createdStages = (events: ReadonlyArray<PlannedBoardEvent>) =>
        events.flatMap((event) =>
          event.type === "board.card-created" ? [String(event.payload.stage)] : [],
        );
      // A human who chose own gets it; the unplanned child lands in Backlog to be planned.
      const chosen = yield* decideEvents(approve({ mergeTarget: "own" }), makeBoard({ plans }));
      expect(approvedEvent(chosen).payload.card.group?.target).toBe("own");
      expect(createdStages(chosen)).toEqual(["ready", "backlog"]);
      // A recommendation of own is honoured as is.
      const approved = approvedEvent(
        yield* decideEvents(
          approve(),
          makeBoard({
            parent: {
              splitRationale: WHY,
              splitRecommendation: { autoBuild: true, mergeTarget: "own" },
            },
            plans,
          }),
        ),
      );
      expect(approved.payload.card.group).toMatchObject({ target: "own", autoBuild: true });
    }),
  );

  it.effect("refuses splitting a card with a live build worktree", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(
        decideEvents(
          approve(),
          makeBoard({
            parent: {
              stage: "building",
              worktree: {
                branch: "board/t3-190",
                baseRefName: "main",
                path: "/tmp/wt",
                status: "ready",
                attempts: 1,
                lastError: null,
                reclaimBlockedReason: null,
              },
            },
            plans: [makePlan({ key: "p1", ordinal: 0 }), makePlan({ key: "p2", ordinal: 1 })],
          }),
        ),
      );
      assert.include(String(refused), "cannot become a group");
    }),
  );

  it.effect("applies the human's edited settings over the recommendation", () =>
    Effect.gen(function* () {
      const approved = approvedEvent(
        yield* decideEvents(
          approve({ autoBuild: true, mergeTarget: "own" }),
          makeBoard({
            parent: {
              splitRationale: WHY,
              splitRecommendation: { autoBuild: false, mergeTarget: "inherit" },
            },
            plans: [makePlan({ key: "p1", ordinal: 0 }), makePlan({ key: "p2", ordinal: 1 })],
          }),
        ),
      );
      expect(approved.payload.card.group).toMatchObject({
        target: "own",
        autoBuild: true,
        started: false,
      });
    }),
  );

  it.effect("falls back for a proposal stored before the recommendation existed", () =>
    Effect.gen(function* () {
      // Fully planned, top level: today's sub-board exactly.
      const planned = approvedEvent(
        yield* decideEvents(
          approve(),
          makeBoard({
            plans: [makePlan({ key: "p1", ordinal: 0 }), makePlan({ key: "p2", ordinal: 1 })],
          }),
        ),
      );
      expect(planned.payload.card.group).toMatchObject({ target: "own", autoBuild: true });
      // An epic breakdown: inherit, auto-build off.
      const epic = approvedEvent(
        yield* decideEvents(
          approve(),
          makeBoard({
            plans: [
              makePlan({ key: "p1", ordinal: 0, planned: false }),
              makePlan({ key: "p2", ordinal: 1, planned: false }),
            ],
          }),
        ),
      );
      expect(epic.payload.card.group).toMatchObject({ target: "inherit", autoBuild: false });
    }),
  );

  it.effect("defaults a nested split under an own-branch group to inherit", () =>
    Effect.gen(function* () {
      const child = makeCard({
        id: "card-inner",
        key: "T3-101",
        cardNumber: 101,
        stage: "planning",
        parentCardId: ownGroup.id,
      });
      const board: BoardState = {
        cards: [ownGroup, child],
        plans: [
          makePlan({ cardId: child.id, key: "q1", ordinal: 0 }),
          makePlan({ cardId: child.id, key: "q2", ordinal: 1 }),
        ],
        nextCardNumberByProject: { [projectId]: 102 },
      };
      const events = yield* decideEvents(approve({ cardId: "card-inner" }), board);
      const approved = approvedEvent(events);
      expect(approved.payload.card.group).toMatchObject({
        target: "inherit",
        autoBuild: true,
        started: false,
      });
      for (const created of createdEvents(events)) {
        expect(created.payload.parentCardId).toBe(child.id);
        expect(created.payload.stage).toBe(BOARD_SEED_STAGE_IDS.ready);
      }
    }),
  );
});
