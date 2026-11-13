/**
 * T3O-86 in the decider: a card's size (the planner's, kept apart from an edit), and the
 * project's Resources settings.
 */
import {
  BoardCardId,
  BoardPlanId,
  BoardStageId,
  boardCardEffectiveSize,
  boardProjectStageConfig,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type BoardCard,
  type BoardCardStepState,
  type BoardCardWorktree,
  type BoardState,
  type BoardWorkerId,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";

import { boardDecidedEvents, type BoardCommand } from "./decider.ts";
import {
  decideBoardCommandOnModel,
  type BoardOrchestrationReadModel,
} from "./decisionContext.testkit.ts";
import { projectBoardEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const workerA = EnvironmentId.make("env-worker-a");
const workerB = EnvironmentId.make("env-worker-b");

const readyWorktree: BoardCardWorktree = {
  branch: "board/card-1",
  baseRefName: "main",
  path: "/tmp/worktrees/card-1",
  status: "ready",
  attempts: 1,
  lastError: null,
  reclaimBlockedReason: null,
};

function makeCard(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id: BoardCardId.make("card-1"),
    key: "T3-1",
    cardNumber: 1,
    projectId,
    labels: [],
    stage: BoardStageId.make("building"),
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
    resources: null,
    worktree: null,
    pullRequest: null,
    pullRequestHistory: [],
    pullRequestFloor: null,
    blocked: false,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeStep(status: BoardCardStepState["status"]): BoardCardStepState {
  return {
    cardId: BoardCardId.make("card-1"),
    stepId: "building",
    stepLabel: null,
    stageLabel: "Building",
    attempt: 1,
    stallCount: 0,
    stageEntryRecoveries: 0,
    humanTurnAt: null,
    lastNudgeAt: null,
    baseTipAtRoundStart: null,
    lastError: null,
    awaitingReason: "question",
    stalledReason: "gave-up",
    retryAt: null,
    prompt: "build it",
    providerInstanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5-codex",
    mode: "build",
    runtimeMode: "full-access",
    humanInLoop: false,
    maxAttempts: 3,
    timeoutMs: 60_000,
    threadId: null,
    status,
    slotHeld: false,
    forceStart: false,
    queuedBy: null,
    queuedDetail: null,
    startedAt: null,
    updatedAt: NOW,
  };
}

function makeReadModel(input: {
  readonly cards: ReadonlyArray<BoardCard>;
  readonly stepStates?: ReadonlyArray<BoardCardStepState>;
  readonly defaultWorkerId?: BoardWorkerId;
}): BoardOrchestrationReadModel {
  const board: BoardState = {
    cards: input.cards,
    nextCardNumberByProject: {},
    workers: [
      { id: workerA, label: "worker-a", url: "http://worker-a:3773", addedAt: NOW },
      { id: workerB, label: "worker-b", url: "http://worker-b:3773", addedAt: NOW },
    ],
    ...(input.stepStates === undefined ? {} : { stepStates: input.stepStates }),
    ...(input.defaultWorkerId === undefined ? {} : { defaultWorkerId: input.defaultWorkerId }),
  };
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

const decideEvents = (command: BoardCommand, readModel: BoardOrchestrationReadModel) =>
  decideBoardCommandOnModel({ command, readModel }).pipe(Effect.map(boardDecidedEvents));

const decideFail = (command: BoardCommand, readModel: BoardOrchestrationReadModel) =>
  Effect.flip(decideEvents(command, readModel));

/** The card after a command, folded through the projector as the engine does. */
const cardAfter = (command: BoardCommand, readModel: BoardOrchestrationReadModel) =>
  Effect.gen(function* () {
    let model = readModel;
    for (const event of yield* decideEvents(command, readModel)) {
      model = yield* projectBoardEvent(model, { ...event, sequence: 1 } as never);
    }
    return model.board!.cards.find((card) => card.id === "card-1")!;
  });

const cardId = BoardCardId.make("card-1");

const update = (fields: Partial<Extract<BoardCommand, { type: "board.card.update" }>>) =>
  ({
    type: "board.card.update",
    commandId: CommandId.make("cmd-update"),
    cardId,
    createdAt: NOW,
    ...fields,
  }) as BoardCommand;

const propose = (
  plans: ReadonlyArray<Record<string, unknown>>,
  splitRationale: string | null = null,
): BoardCommand =>
  ({
    type: "board.plans.propose",
    commandId: CommandId.make("cmd-propose"),
    cardId,
    plans: plans.map((plan, index) => ({
      key: `p${index}`,
      title: `Plan ${index}`,
      summary: "summary",
      dependsOn: [],
      body: "body",
      ...plan,
    })),
    splitRationale,
    createdAt: NOW,
  }) as BoardCommand;

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("card sizes", (it) => {
  it.effect("a human's size edit is kept apart from the planner's, and Reset drops it", () =>
    Effect.gen(function* () {
      const planning = makeCard({ stage: BoardStageId.make("planning") });
      const proposed = yield* cardAfter(
        propose([{ size: { cpu: "S", ram: "S", disk: "L" }, sizeReason: "Mostly docs" }]),
        makeReadModel({ cards: [planning] }),
      );
      assert.deepStrictEqual(proposed.resources?.sizing, {
        planner: { size: { cpu: "S", ram: "S", disk: "L" }, reason: "Mostly docs" },
        edit: null,
      });

      const edited = yield* cardAfter(
        update({ size: { cpu: "XL", ram: "M", disk: "M" } }),
        makeReadModel({ cards: [proposed] }),
      );
      assert.deepStrictEqual(edited.resources?.sizing?.edit, {
        size: { cpu: "XL", ram: "M", disk: "M" },
        by: "human",
      });
      assert.deepStrictEqual(edited.resources?.sizing?.planner?.size, {
        cpu: "S",
        ram: "S",
        disk: "L",
      });
      assert.deepStrictEqual(boardCardEffectiveSize(edited.resources?.sizing), {
        cpu: "XL",
        ram: "M",
        disk: "M",
      });

      const reset = yield* cardAfter(update({ size: null }), makeReadModel({ cards: [edited] }));
      assert.isNull(reset.resources?.sizing?.edit ?? null);
      assert.deepStrictEqual(boardCardEffectiveSize(reset.resources?.sizing), {
        cpu: "S",
        ram: "S",
        disk: "L",
      });
    }),
  );

  it.effect("an agent's size edit is recorded as the agent's, not a human override", () =>
    Effect.gen(function* () {
      const edited = yield* cardAfter(
        update({ size: { cpu: "L", ram: "L", disk: "L" }, sizeEditor: "agent" }),
        makeReadModel({ cards: [makeCard()] }),
      );
      assert.strictEqual(edited.resources?.sizing?.edit?.by, "agent");
    }),
  );

  it.effect("a split's sizes reach each child; the parent records none", () =>
    Effect.gen(function* () {
      const planning = makeCard({ stage: BoardStageId.make("planning") });
      let model = makeReadModel({ cards: [planning] });
      const events = yield* decideEvents(
        propose(
          [{ size: { cpu: "XL", ram: "L", disk: "M" }, sizeReason: "Builds the app" }, {}],
          "Two independent halves that can ship and be reviewed separately.",
        ),
        model,
      );
      assert.isFalse(events.some((event) => event.type === "board.card-resources-recorded"));
      for (const event of events) {
        model = yield* projectBoardEvent(model, { ...event, sequence: 1 } as never);
      }
      const plans = model.board!.plans ?? [];
      assert.deepStrictEqual(
        plans.find((plan) => plan.planId === BoardPlanId.make("card-1::p0"))?.size,
        { cpu: "XL", ram: "L", disk: "M" },
      );
    }),
  );

  it.effect("the project's Resources settings are recorded and a bad readiness path refused", () =>
    Effect.gen(function* () {
      const resources = {
        baseline: { cpuCores: 6, ramGiB: 16, diskGB: 45, setAtUpgrade: false },
        setupTimeoutMinutes: 20,
        readinessPath: "./.t3//ready.sh",
        readinessTimeoutSeconds: null,
      };
      const set = (path: string | null): BoardCommand => ({
        type: "board.project.set-resources",
        commandId: CommandId.make("cmd-resources"),
        projectId,
        resources: { ...resources, readinessPath: path },
        createdAt: NOW,
      });
      let model = makeReadModel({ cards: [makeCard()] });
      for (const event of yield* decideEvents(set(resources.readinessPath), model)) {
        model = yield* projectBoardEvent(model, { ...event, sequence: 1 } as never);
      }
      const config = boardProjectStageConfig(model.board!, projectId);
      assert.deepStrictEqual(config?.resources, { ...resources, readinessPath: ".t3/ready.sh" });
      const refused = yield* decideFail(set("../outside.sh"), model);
      assert.include(String(refused), "inside the repository");
    }),
  );
});
