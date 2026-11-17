/**
 * The split gate: Planned vs Needs-planning children, the agent's
 * recommended group settings and their fallback rules, and approval applying
 * the human's final settings without starting anything.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  BoardStageId,
  boardPlanId,
  boardSplitFingerprint,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardCardStepState,
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
    autoSignOffSetting: null,
    autoBuildSetting: null,
    autoMergeSetting: null,
    autoMergeHold: null,
    mergeStrategy: null,
    priority: "normal",
    pinnedWorkerId: null,
    placedWorkerId: null,
    workerMove: null,
    placementOrphaned: null,
    ci: null,
    ciLastOutcome: null,
    ciRoundTrips: 0,
    resources: null,
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
  readonly stepStates?: ReadonlyArray<BoardCardStepState>;
}): BoardState {
  const parent = makeCard({ id: "card-parent", key: "T3-190", cardNumber: 190, ...input.parent });
  return {
    cards: [parent, ...(input.extraCards ?? [])],
    plans: input.plans ?? [],
    ...(input.stepStates === undefined ? {} : { stepStates: input.stepStates }),
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
  readonly autoPlan?: boolean;
  readonly autoSignOff?: boolean;
}): BoardCommand => ({
  type: "board.plans.approve",
  commandId: CommandId.make("cmd-approve"),
  cardId: BoardCardId.make(input?.cardId ?? "card-parent"),
  ...(input?.autoBuild === undefined ? {} : { autoBuild: input.autoBuild }),
  ...(input?.mergeTarget === undefined ? {} : { mergeTarget: input.mergeTarget }),
  ...(input?.autoPlan === undefined ? {} : { autoPlan: input.autoPlan }),
  ...(input?.autoSignOff === undefined ? {} : { autoSignOff: input.autoSignOff }),
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
    autoSignOff: false,
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
            priority: "urgent",
          },
          plans: [makePlan({ key: "p1", ordinal: 0 }), makePlan({ key: "p2", ordinal: 1 })],
        }),
      );
      // Children copy the parent's priority; the parent, now a group, has none (T3O-95).
      expect(createdEvents(events).map((event) => event.payload.priority)).toEqual([
        "urgent",
        "urgent",
      ]);
      expect(approvedEvent(events).payload.card.priority).toBe("normal");
      // Children, the approval record and the parent placed in Ready (T3O-115); no step.
      expect(events.map((event) => event.type)).toEqual([
        "board.card-created",
        "board.card-created",
        "board.plans-approved",
        "board.card-moved",
      ]);
      const approved = approvedEvent(events);
      expect(approved.payload.card.stage).toBe(BOARD_SEED_STAGE_IDS.planning);
      expect(approved.payload.card.group).toMatchObject({
        target: "inherit",
        autoBuild: false,
        started: false,
        placed: BOARD_SEED_STAGE_IDS.ready,
      });
    }),
  );

  it.effect("starts the group when Auto sign-off and Auto-build are both on", () =>
    Effect.gen(function* () {
      const board = makeBoard({
        parent: { splitRationale: WHY },
        plans: [makePlan({ key: "p1", ordinal: 0 }), makePlan({ key: "p2", ordinal: 1 })],
      });
      const startedWith = (autoSignOff: boolean, autoBuild: boolean) =>
        decideEvents(approve({ autoSignOff, autoBuild }), board).pipe(
          Effect.map((events) => approvedEvent(events).payload.card.group?.started),
        );
      expect(yield* startedWith(true, true)).toBe(true);
      expect(yield* startedWith(false, true)).toBe(false);
      expect(yield* startedWith(true, false)).toBe(false);
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
          approve({ autoBuild: true, mergeTarget: "own", autoPlan: true, autoSignOff: true }),
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
        autoPlan: true,
        autoSignOff: true,
        started: true,
      });
    }),
  );

  it.effect("carries the card's own Auto-plan and Auto sign-off to the group by default", () =>
    Effect.gen(function* () {
      const plans = [makePlan({ key: "p1", ordinal: 0 }), makePlan({ key: "p2", ordinal: 1 })];
      const handsOff = approvedEvent(
        yield* decideEvents(
          approve(),
          makeBoard({ parent: { autoPlanSetting: true, autoSignOffSetting: true }, plans }),
        ),
      );
      expect(handsOff.payload.card.group).toMatchObject({ autoPlan: true, autoSignOff: true });
      const manual = approvedEvent(yield* decideEvents(approve(), makeBoard({ plans })));
      expect(manual.payload.card.group).toMatchObject({ autoPlan: false, autoSignOff: false });
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

  // ── T3O-105: approve after review ─────────────────────────────────

  const planStep = (overrides: Partial<BoardCardStepState> = {}): BoardCardStepState => ({
    cardId: parentId,
    stepId: "planning",
    stepLabel: null,
    stageLabel: "Planning",
    attempt: 1,
    stallCount: 0,
    stageEntryRecoveries: 0,
    humanTurnAt: null,
    awaitingReason: "question",
    stalledReason: "gave-up",
    retryAt: null,
    lastNudgeAt: null,
    prompt: "plan it",
    providerInstanceId: ProviderInstanceId.make("claude"),
    model: "opus",
    mode: "plan",
    runtimeMode: "approval-required",
    humanInLoop: true,
    maxAttempts: 3,
    timeoutMs: 1000,
    baseTipAtRoundStart: null,
    lastError: null,
    threadId: ThreadId.make("thread-plan"),
    status: "running",
    slotHeld: false,
    forceStart: false,
    queuedBy: null,
    queuedDetail: null,
    startedAt: NOW,
    updatedAt: NOW,
    planReviewStartedAt: NOW,
    planReviewRounds: 3,
    planReviewRound: 2,
    ...overrides,
  });
  const splitPlans = [makePlan({ key: "a", ordinal: 0 }), makePlan({ key: "b", ordinal: 1 })];
  const reviewing = (overrides?: {
    readonly step?: Partial<BoardCardStepState>;
    readonly parent?: Partial<Parameters<typeof makeCard>[0]>;
  }) =>
    makeBoard({
      plans: splitPlans,
      stepStates: [planStep(overrides?.step)],
      ...(overrides?.parent === undefined ? {} : { parent: overrides.parent }),
    });
  const pending = {
    autoBuild: false,
    mergeTarget: "inherit" as const,
    autoPlan: true,
    fingerprint: boardSplitFingerprint(splitPlans),
    approvedAt: NOW,
  };
  const approveAfterReview = (overrides?: {
    readonly autoBuild?: boolean;
    readonly mergeTarget?: BoardCardGroupTarget;
    readonly autoPlan?: boolean;
  }): BoardCommand => ({
    type: "board.split.approve-after-review",
    commandId: CommandId.make("cmd-approve-after-review"),
    cardId: parentId,
    ...overrides,
    createdAt: NOW,
  });
  const undo: BoardCommand = {
    type: "board.split.cancel-approval",
    commandId: CommandId.make("cmd-undo"),
    cardId: parentId,
    createdAt: NOW,
  };
  const approvalChanged = (events: ReadonlyArray<PlannedBoardEvent>) =>
    events.flatMap((event) => (event.type === "board.split-approval-changed" ? [event] : []));

  it.effect("refuses a direct approve while a plan review is running", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decideEvents(approve(), reviewing()));
      expect(error.message).toContain("board.split.approve-after-review");
    }),
  );

  it.effect("allows a direct approve once the review is done, or while the step is parked", () =>
    Effect.gen(function* () {
      approvedEvent(yield* decideEvents(approve(), reviewing({ step: { planReviewDoneAt: NOW } })));
      approvedEvent(yield* decideEvents(approve(), reviewing({ step: { status: "paused" } })));
    }),
  );

  it.effect("stores an approval after review with the gate's settings and the split", () =>
    Effect.gen(function* () {
      const [event, ...rest] = approvalChanged(
        yield* decideEvents(
          approveAfterReview({ autoBuild: false, mergeTarget: "inherit", autoPlan: true }),
          reviewing(),
        ),
      );
      expect(rest).toEqual([]);
      expect(event?.payload).toMatchObject({ change: "approved", round: 2 });
      expect(event?.payload.card.pendingSplitApproval).toEqual(pending);
    }),
  );

  it.effect("refuses approve after review with no review running, or on a single plan", () =>
    Effect.gen(function* () {
      yield* Effect.flip(
        decideEvents(approveAfterReview(), reviewing({ step: { planReviewDoneAt: NOW } })),
      );
      yield* Effect.flip(
        decideEvents(
          approveAfterReview(),
          makeBoard({ plans: [splitPlans[0]!], stepStates: [planStep()] }),
        ),
      );
    }),
  );

  it.effect("Undo clears the approval, and refuses when nothing is pending", () =>
    Effect.gen(function* () {
      const [event] = approvalChanged(
        yield* decideEvents(undo, reviewing({ parent: { pendingSplitApproval: pending } })),
      );
      expect(event?.payload.change).toBe("undone");
      expect(event?.payload.card.pendingSplitApproval).toBeUndefined();
      yield* Effect.flip(decideEvents(undo, reviewing()));
    }),
  );

  it.effect("drops the approval when a re-proposal changes the split, with the round", () =>
    Effect.gen(function* () {
      const events = yield* decideEvents(
        propose({ plans: [proposedPlan("a"), proposedPlan("b"), proposedPlan("c")] }),
        reviewing({ parent: { pendingSplitApproval: pending } }),
      );
      const [dropped] = approvalChanged(events);
      expect(dropped?.payload).toMatchObject({ change: "dropped", round: 2 });
      expect(dropped?.payload.card.pendingSplitApproval).toBeUndefined();
      // Before the proposal, so the proposal's rationale lands on the card last.
      expect(events.indexOf(dropped!)).toBeLessThan(events.indexOf(proposedEvent(events)));
      // Folded into one sized plan: the size event must not carry the approval back.
      const folded = yield* decideEvents(
        propose({
          plans: [
            proposedPlan("a", { size: { cpu: "L", ram: "M", disk: "S" }, sizeReason: "big" }),
          ],
        }),
        reviewing({ parent: { pendingSplitApproval: pending } }),
      );
      expect(approvalChanged(folded)).toHaveLength(1);
      const sized = folded.find((event) => event.type === "board.card-resources-recorded");
      expect(sized).toBeDefined();
      expect(
        (sized!.payload as { card: { pendingSplitApproval?: unknown } }).card.pendingSplitApproval,
      ).toBeUndefined();
    }),
  );

  it.effect("keeps the approval on a body edit or a re-proposal of the same split", () =>
    Effect.gen(function* () {
      const board = reviewing({ parent: { pendingSplitApproval: pending } });
      const write = yield* decideEvents(
        {
          type: "board.plan.write",
          commandId: CommandId.make("cmd-write"),
          cardId: parentId,
          planId: splitPlans[0]!.planId,
          body: "# revised",
          createdAt: NOW,
        },
        board,
      );
      expect(approvalChanged(write)).toEqual([]);
      const same = yield* decideEvents(
        propose({
          plans: ["a", "b"].map((key) =>
            proposedPlan(key, { title: `Plan ${key}`, body: "# revised body" }),
          ),
        }),
        board,
      );
      expect(approvalChanged(same)).toEqual([]);
    }),
  );

  it.effect("clears the approval when the split is approved or the card leaves Planning", () =>
    Effect.gen(function* () {
      const settled = reviewing({
        parent: { pendingSplitApproval: pending },
        step: { status: "succeeded" },
      });
      const approved = approvedEvent(yield* decideEvents(approve(), settled));
      expect(approved.payload.card.pendingSplitApproval).toBeUndefined();
      const moved = (yield* decideEvents(
        {
          type: "board.card.move",
          commandId: CommandId.make("cmd-move"),
          cardId: parentId,
          toStage: BOARD_SEED_STAGE_IDS.sprint,
          createdAt: NOW,
        },
        settled,
      )).find((event) => event.type === "board.card-moved");
      assert.ok(moved?.type === "board.card-moved");
      expect(moved.payload.card.pendingSplitApproval).toBeUndefined();
    }),
  );
});
