/**
 * Per-project stage config through the real board engine: deltas, moves on the
 * card's own pipeline, stale edits refused, deleted stages pruned, replay
 * equals rehydration, and legacy payloads upcast on read.
 */
import {
  BOARD_CONFIG_VERSION_MISMATCH,
  BoardCardId,
  BoardStageId,
  CommandId,
  EMPTY_BOARD_PROJECT_STAGE_CONFIG,
  EventId,
  ProjectId,
  ProviderInstanceId,
  boardNewStageOrderKey,
  boardProjectStagesInOrder,
  type BoardEvent,
  type BoardState,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";

import { projectBoardEvent, type BoardReadModel } from "./projector.ts";
import {
  boardStackEngine,
  boardStackSnapshotQuery,
  makeBoardStackTestLayer,
} from "./boardStack.testkit.ts";

const t0 = "2026-01-01T00:00:00.000Z";
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const cardA = BoardCardId.make("card-a");
const cardB = BoardCardId.make("card-b");
const security = BoardStageId.make("security");

let commandSeq = 0;
const nextCommandId = (tag: string) => CommandId.make(`cmd-${tag}-${(commandSeq += 1)}`);

const createProject = (projectId: ProjectId, name: string) =>
  ({
    type: "project.create",
    commandId: CommandId.make(`cmd-project-${name}-${(commandSeq += 1)}`),
    projectId,
    title: `Project ${name}`,
    workspaceRoot: `/tmp/${name}`,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    createdAt: t0,
  }) as const;

const createCard = (cardId: BoardCardId, projectId: ProjectId, stage?: string) =>
  ({
    type: "board.card.create",
    commandId: nextCommandId("create"),
    cardId,
    projectId,
    title: `Card ${cardId}`,
    ...(stage === undefined ? {} : { stage: BoardStageId.make(stage) }),
    createdAt: t0,
  }) as const;

const move = (cardId: BoardCardId, toStage: string, override = false) =>
  ({
    type: "board.card.move",
    commandId: nextCommandId("move"),
    cardId,
    toStage: BoardStageId.make(toStage),
    ...(override ? { override: true } : {}),
    createdAt: t0,
  }) as const;

const switchStage = (stageId: string, on: boolean | null, projectId = projectA) =>
  ({
    type: "board.project.set-stage-switch",
    commandId: nextCommandId("switch"),
    projectId,
    stageId: BoardStageId.make(stageId),
    on,
    actor: { kind: "human", name: "Ada", providerInstanceId: null, threadId: null },
    createdAt: t0,
  }) as const;

it.layer(makeBoardStackTestLayer("t3o-project-stage-config-test-"))(
  "per-project stage config",
  (it) => {
    it.effect("walks each card's own project pipeline and replays identically", () =>
      Effect.gen(function* () {
        const engine = yield* boardStackEngine;
        const snapshots = yield* boardStackSnapshotQuery;
        const board = () =>
          snapshots
            .getCommandReadModel()
            .pipe(Effect.map((model) => model.board ?? ({} as BoardState)));

        yield* engine.dispatch(createProject(projectA, "a"));
        yield* engine.dispatch(createProject(projectB, "b"));
        yield* engine.dispatch(createCard(cardA, projectA));
        yield* engine.dispatch(createCard(cardB, projectB));

        // A stage made for project A: a global stage, off for B.
        yield* engine.dispatch({
          type: "board.stage.create",
          commandId: nextCommandId("stage"),
          stageId: security,
          label: "Security review",
          orderKey: boardNewStageOrderKey(yield* board())!,
          forProjectId: projectA,
          createdAt: t0,
        });
        yield* engine.dispatch(switchStage("sprint", false));

        const configured = yield* board();
        assert.deepStrictEqual(
          boardProjectStagesInOrder(configured, projectA).map((stage) => String(stage.stageId)),
          ["backlog", "planning", "ready", "building", "review", "security", "merge", "done"],
        );
        assert.notInclude(
          boardProjectStagesInOrder(configured, projectB).map((stage) => String(stage.stageId)),
          "security",
        );
        const configA = configured.projectStageConfigs?.[projectA];
        assert.deepStrictEqual(configA?.stageSwitches, { security: true, sprint: false });
        assert.strictEqual(configA?.lastChangedBy?.actor.name, "Ada");

        // Backlog → Planning is adjacent for A (Sprint is off), not for B.
        yield* engine.dispatch(move(cardA, "planning"));
        const refusedB = yield* Effect.exit(engine.dispatch(move(cardB, "planning")));
        assert.isTrue(Exit.isFailure(refusedB));

        // A switched-off stage is refused even with override; so is a stage
        // made for another project.
        const intoSprint = yield* Effect.exit(engine.dispatch(move(cardA, "sprint", true)));
        assert.include(String(intoSprint), "Sprint is off for");
        const intoForeign = yield* Effect.exit(engine.dispatch(move(cardB, security, true)));
        assert.include(String(intoForeign), "Security review is off for");

        // A role stage can't be switched; a stale version is refused.
        const roleSwitch = yield* Effect.exit(engine.dispatch(switchStage("review", false)));
        assert.include(String(roleSwitch), "can't be switched off");
        const stale = yield* Effect.exit(
          engine.dispatch({
            type: "board.project.set-stage-override",
            commandId: nextCommandId("override"),
            projectId: projectA,
            stageId: BoardStageId.make("building"),
            patch: { prompt: "Build it" },
            expectedConfigVersion: EMPTY_BOARD_PROJECT_STAGE_CONFIG.version,
            createdAt: t0,
          }),
        );
        assert.include(String(stale), BOARD_CONFIG_VERSION_MISMATCH);
        yield* engine.dispatch({
          type: "board.project.set-stage-override",
          commandId: nextCommandId("override"),
          projectId: projectA,
          stageId: BoardStageId.make("building"),
          patch: { prompt: "Build it" },
          expectedConfigVersion: (yield* board()).projectStageConfigs![projectA]!.version,
          createdAt: t0,
        });

        // A made-for-project stage is renamed like any other, and its default
        // can be turned on for every project.
        yield* engine.dispatch({
          type: "board.stage.rename",
          commandId: nextCommandId("rename"),
          stageId: security,
          label: "Security",
          createdAt: t0,
        });
        yield* engine.dispatch({
          type: "board.stage.set-default-for-projects",
          commandId: nextCommandId("default"),
          stageId: security,
          on: true,
          createdAt: t0,
        });
        assert.include(
          boardProjectStagesInOrder(yield* board(), projectB).map((stage) => String(stage.stageId)),
          "security",
        );
        const ciDefault = yield* Effect.exit(
          engine.dispatch({
            type: "board.stage.set-default-for-projects",
            commandId: nextCommandId("default"),
            stageId: BoardStageId.make("ci"),
            on: true,
            createdAt: t0,
          }),
        );
        assert.isTrue(Exit.isFailure(ciDefault));

        // Deleting the empty stage prunes it from A's delta and re-versions it.
        const versionBefore = (yield* board()).projectStageConfigs![projectA]!.version;
        yield* engine.dispatch({
          type: "board.stage.delete",
          commandId: nextCommandId("delete"),
          stageId: security,
          createdAt: t0,
        });
        const pruned = yield* board();
        assert.isUndefined(pruned.stages?.find((stage) => stage.stageId === security));
        assert.deepStrictEqual(pruned.projectStageConfigs?.[projectA]?.stageSwitches, {
          sprint: false,
        });
        assert.notStrictEqual(pruned.projectStageConfigs?.[projectA]?.version, versionBefore);

        // The shell carries the delta less its prompts.
        const shell = yield* snapshots.getBoardSnapshot();
        assert.deepStrictEqual(shell.projectStageConfigs?.[projectA]?.stageSwitches, {
          sprint: false,
        });
        assert.deepStrictEqual(shell.projectStageConfigs?.[projectA]?.overrides, { building: {} });

        const rehydrated = yield* snapshots.getCommandReadModel();
        const events: BoardEvent[] = Array.from(yield* Stream.runCollect(engine.readBoardEvents()));
        let replayed = {} as BoardReadModel;
        for (const event of events) replayed = yield* projectBoardEvent(replayed, event);
        assert.deepStrictEqual(replayed.board, rehydrated.board);
      }),
    );
  },
);

it.layer(makeBoardStackTestLayer("t3o-project-stage-set-project-removed-test-"))(
  "per-project stage config: changing a card's project into one without its stage",
  (it) => {
    it.effect("refuses a project that switched the card's stage off", () =>
      Effect.gen(function* () {
        const engine = yield* boardStackEngine;
        yield* engine.dispatch(createProject(projectA, "a"));
        yield* engine.dispatch(createProject(projectB, "b"));
        yield* engine.dispatch(createCard(cardB, projectB, "sprint"));
        yield* engine.dispatch(switchStage("sprint", false));

        const setProject = () =>
          engine.dispatch({
            type: "board.card.set-project",
            commandId: nextCommandId("set-project"),
            cardId: cardB,
            projectId: projectA,
            createdAt: t0,
          });
        const refused = yield* Effect.exit(setProject());
        assert.isTrue(Exit.isFailure(refused));
        assert.include(String(refused), "doesn't use the Sprint stage");

        yield* engine.dispatch(move(cardB, "backlog"));
        yield* setProject();
      }),
    );
  },
);

it.effect("upcasts a T3O-43 config event on replay", () =>
  Effect.gen(function* () {
    const legacyStage = BoardStageId.make(`${projectA}:qa`);
    const event = {
      sequence: 1,
      eventId: EventId.make("legacy-config"),
      aggregateKind: "project",
      aggregateId: projectA,
      occurredAt: t0,
      commandId: CommandId.make("legacy-config"),
      causationEventId: null,
      correlationId: CommandId.make("legacy-config"),
      metadata: {},
      type: "board.project-stage-config-set",
      payload: {
        projectId: projectA,
        config: {
          removedStageIds: ["sprint"],
          addedStageIds: [legacyStage],
          overrides: { ci: { steps: [], enabled: true, maxFixAttempts: 1 } },
          warnings: [],
          source: { path: "/tmp/a/t3o.json", commitSha: "abc" },
          ci: { steps: [{ name: "Test", command: "vp test", timeoutMinutes: 30 }], active: true },
        },
        upserts: [
          {
            stageId: legacyStage,
            label: "QA",
            role: null,
            orderKey: "k",
            createdAt: t0,
            updatedAt: t0,
            projectId: projectA,
          },
        ],
        deletedStageIds: [],
      },
    } as unknown as BoardEvent;
    const model = yield* projectBoardEvent({} as BoardReadModel, event);
    const config = model.board?.projectStageConfigs?.[projectA];
    assert.deepStrictEqual(config?.stageSwitches, { sprint: false, [legacyStage]: true, ci: true });
    assert.deepStrictEqual(config?.overrides, { ci: { maxFixAttempts: 1 } });
    assert.deepStrictEqual(
      config?.ci.steps.map((step) => [step.kind, step.id]),
      [["script", "legacy-0"]],
    );
    assert.deepStrictEqual(
      boardProjectStagesInOrder(model.board!, projectA).map((stage) => String(stage.stageId)),
      ["backlog", "planning", "ready", "building", legacyStage, "review", "ci", "merge", "done"],
    );
    assert.notInclude(
      boardProjectStagesInOrder(model.board!, projectB).map((stage) => String(stage.stageId)),
      String(legacyStage),
    );
  }),
);
