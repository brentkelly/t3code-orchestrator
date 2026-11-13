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
    priority: "normal",
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

      // T3O-87: the board's learned baseline lands without moving the version, and a human's
      // later edit (or Pin declared) never overwrites it.
      const dimension = { value: 9, samples: 6, history: [9] };
      const learned = { computedAt: NOW, cpu: dimension, ram: dimension, disk: dimension };
      const before = boardProjectStageConfig(model.board!, projectId)!.version;
      for (const event of yield* decideEvents(
        {
          type: "board.project.record-learned",
          commandId: CommandId.make("cmd-learned"),
          projectId,
          learned,
          createdAt: NOW,
        },
        model,
      )) {
        model = yield* projectBoardEvent(model, { ...event, sequence: 2 } as never);
      }
      assert.strictEqual(boardProjectStageConfig(model.board!, projectId)?.version, before);
      const pinned: BoardCommand = {
        type: "board.project.set-resources",
        commandId: CommandId.make("cmd-pin"),
        projectId,
        resources: { ...resources, readinessPath: null, pinDeclared: ["cpu"] },
        createdAt: NOW,
      };
      for (const event of yield* decideEvents(pinned, model)) {
        model = yield* projectBoardEvent(model, { ...event, sequence: 3 } as never);
      }
      const after = boardProjectStageConfig(model.board!, projectId)?.resources;
      assert.deepStrictEqual(after?.learned, learned);
      assert.deepStrictEqual(after?.pinDeclared, ["cpu"]);
    }),
  );

  it.effect(
    "the placement records its grant before the worker is called; claim-expired undoes both",
    () =>
      Effect.gen(function* () {
        const branchOnly: BoardCardWorktree = {
          ...readyWorktree,
          path: null,
          status: "branch-only",
        };
        const placeCommand: BoardCommand = {
          type: "board.card.place",
          commandId: CommandId.make("cmd-place"),
          cardId,
          workerId: workerA,
          grantedProfile: { cpuCores: 2, ramGiB: 4, diskGB: 5 },
          heavyGranted: true,
          claimId: "card-1:1:0",
          reason: "offered the most RAM among ready workers",
          createdAt: NOW,
        };
        const provisionCommand: BoardCommand = {
          type: "board.card.provision-worktree",
          commandId: CommandId.make("cmd-provision"),
          cardId,
          branch: "board/card-1",
          baseRefName: "main",
          createdAt: NOW,
        };
        // An unplaced card is never provisioned: the gate places it first.
        const unplaced = makeCard({ worktree: branchOnly });
        const refused = yield* Effect.exit(
          decideEvents(provisionCommand, makeReadModel({ cards: [unplaced] })),
        );
        assert.isTrue(refused._tag === "Failure");
        const provision = (card: BoardCard) => ({
          command: provisionCommand,
          model: (model: BoardOrchestrationReadModel) =>
            cardAfter(placeCommand, model).pipe(
              Effect.map((placed) => ({
                ...model,
                board: {
                  ...model.board!,
                  cards: model.board!.cards.map((candidate) =>
                    candidate.id === card.id ? placed : candidate,
                  ),
                },
              })),
            ),
        });
        const provisionAfter = (card: BoardCard, model: BoardOrchestrationReadModel) =>
          Effect.flatMap(provision(card).model(model), (placed) =>
            cardAfter(provisionCommand, placed),
          );
        const before = makeCard({ worktree: branchOnly });
        const provisioning = yield* provisionAfter(before, makeReadModel({ cards: [before] }));
        assert.strictEqual(provisioning.worktree?.status, "provisioning");
        // The provision keeps the gate's choice, never the pin or the default.
        assert.strictEqual(provisioning.placedWorkerId, workerA);
        assert.deepInclude(provisioning.resources?.grant, { heavy: true, claimId: "card-1:1:0" });
        assert.deepInclude(provisioning.resources?.placement, {
          workerId: workerA,
          reason: "offered the most RAM among ready workers",
        });
        // A new worktree runs setup even when the last one ran it: the old result goes.
        const recut = yield* provisionAfter(
          before,
          makeReadModel({
            cards: [
              {
                ...before,
                resources: {
                  sizing: null,
                  grant: null,
                  setup: {
                    status: "succeeded",
                    stage: "setup-script",
                    exitCode: 0,
                    startedAt: NOW,
                    durationMs: 1,
                    workerId: workerA,
                    detail: null,
                    blocking: false,
                  },
                },
              },
            ],
          }),
        );
        assert.deepInclude(recut.resources, { setup: null, setupDue: true });

        const undo = (restore: BoardCardWorktree | null): BoardCommand => ({
          type: "board.card.undo-provision",
          commandId: CommandId.make("cmd-undo"),
          cardId,
          restore,
          createdAt: NOW,
        });
        // The branch-only record a group child takes its base from comes back, attempts and all.
        const restored = yield* cardAfter(
          undo(branchOnly),
          makeReadModel({ cards: [provisioning] }),
        );
        assert.deepStrictEqual(restored.worktree, branchOnly);
        assert.isNull(restored.resources);
        // The placement goes with the claim: the card is ranked again.
        assert.isNull(restored.placedWorkerId);
        // A reclaimed card keeps the worker its unpushed commits may live on.
        const reclaimed: BoardCardWorktree = { ...branchOnly, status: "reclaimed" };
        const rePlaced = yield* provisionAfter(
          makeCard({ worktree: reclaimed }),
          makeReadModel({ cards: [makeCard({ worktree: reclaimed })] }),
        );
        const home = yield* cardAfter(undo(reclaimed), makeReadModel({ cards: [rePlaced] }));
        assert.strictEqual(home.placedWorkerId, workerA);
        // With nothing before it, the record goes.
        const fresh = yield* provisionAfter(makeCard(), makeReadModel({ cards: [makeCard()] }));
        const nulled = yield* cardAfter(undo(null), makeReadModel({ cards: [fresh] }));
        assert.isNull(nulled.worktree);
        // A provision that already landed is never undone.
        const ready = { ...fresh, worktree: readyWorktree };
        assert.deepStrictEqual(
          yield* decideEvents(undo(null), makeReadModel({ cards: [ready] })),
          [],
        );
      }),
  );

  it.effect("record-grant goes light, settles, and never changes a grant to the same thing", () =>
    Effect.gen(function* () {
      const grant = {
        profile: { cpuCores: 2, ramGiB: 4, diskGB: 5 },
        heavy: true,
        claimId: null,
        grantedAt: NOW,
        settled: false,
      };
      const card = makeCard({ resources: { sizing: null, grant, setup: null } });
      const command = (
        fields: Partial<Extract<BoardCommand, { type: "board.card.record-grant" }>>,
      ) =>
        ({
          type: "board.card.record-grant",
          commandId: CommandId.make("cmd-grant"),
          cardId,
          createdAt: NOW,
          ...fields,
        }) as BoardCommand;
      const light = yield* cardAfter(
        command({ heavy: false, settled: true }),
        makeReadModel({ cards: [card] }),
      );
      assert.deepInclude(light.resources?.grant, { heavy: false, settled: true });
      assert.deepStrictEqual(
        yield* decideEvents(command({ heavy: true }), makeReadModel({ cards: [card] })),
        [],
      );
      const refused = yield* decideFail(
        command({ heavy: true }),
        makeReadModel({ cards: [makeCard()] }),
      );
      assert.include(String(refused), "no grant");
    }),
  );
});
