/**
 * T3o per-project stage config (T3O-43) through the real board engine: a
 * project's resolved `t3o.json` lands in the read model, moves walk the
 * card's own project's pipeline, a stage that leaves the file is retired while
 * occupied and dropped once empty, and a from-empty replay still equals the
 * table rehydration.
 */
import {
  BoardCardId,
  BoardStageId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  boardProjectStageId,
  boardProjectStagesInOrder,
  resolveT3oProjectFile,
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
const security = boardProjectStageId(projectA, "security");

let commandSeq = 0;
const nextCommandId = (tag: string) => CommandId.make(`cmd-${tag}-${(commandSeq += 1)}`);

const createProject = (projectId: ProjectId, name: string) =>
  ({
    type: "project.create",
    commandId: CommandId.make(`cmd-project-${name}`),
    projectId,
    title: `Project ${name}`,
    workspaceRoot: `/tmp/${name}`,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    createdAt: t0,
  }) as const;

const setConfig = (board: BoardState, raw: unknown) => {
  const resolved = resolveT3oProjectFile({
    raw,
    board,
    projectId: projectA,
    source: { path: "/tmp/a/t3o.json", commitSha: "abc123" },
    now: t0,
  });
  return {
    type: "board.project.set-stage-config",
    commandId: nextCommandId("config"),
    projectId: projectA,
    config: resolved.config,
    stages: resolved.stages,
    createdAt: t0,
  } as const;
};

const move = (cardId: BoardCardId, toStage: string, override = false) =>
  ({
    type: "board.card.move",
    commandId: nextCommandId("move"),
    cardId,
    toStage: BoardStageId.make(toStage),
    ...(override ? { override: true } : {}),
    createdAt: t0,
  }) as const;

const FILE = {
  stages: {
    remove: ["sprint"],
    add: [{ id: "security", label: "Security review", after: "review", autoExecute: true }],
  },
};

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
        for (const [cardId, projectId] of [
          [cardA, projectA],
          [cardB, projectB],
        ] as const) {
          yield* engine.dispatch({
            type: "board.card.create",
            commandId: nextCommandId("create"),
            cardId,
            projectId,
            title: `Card ${cardId}`,
            createdAt: t0,
          });
        }

        const modelBefore = yield* snapshots.getCommandReadModel();
        yield* engine.dispatch(setConfig(modelBefore.board!, FILE));

        const configured = yield* board();
        assert.deepStrictEqual(
          boardProjectStagesInOrder(configured, projectA).map((stage) => stage.stageId),
          ["backlog", "planning", "ready", "building", "review", security, "merge", "done"],
        );
        // Project B is untouched.
        assert.include(
          boardProjectStagesInOrder(configured, projectB).map((stage) => stage.stageId),
          "sprint",
        );

        // Backlog → Planning is adjacent for A (Sprint is gone), not for B.
        yield* engine.dispatch(move(cardA, "planning"));
        const refusedB = yield* Effect.exit(engine.dispatch(move(cardB, "planning")));
        assert.isTrue(Exit.isFailure(refusedB));

        // A removed stage is refused even with override; another project's
        // stage likewise.
        const intoSprint = yield* Effect.exit(engine.dispatch(move(cardA, "sprint", true)));
        assert.isTrue(Exit.isFailure(intoSprint));
        assert.include(String(intoSprint), "doesn't use the Sprint stage");
        const intoForeign = yield* Effect.exit(engine.dispatch(move(cardB, security, true)));
        assert.isTrue(Exit.isFailure(intoForeign));

        // Into the project's own stage, then drop it from the file while
        // occupied: it stays, retired, and nothing new may enter it.
        yield* engine.dispatch(move(cardA, security, true));
        yield* engine.dispatch(setConfig(yield* board(), { stages: { remove: ["sprint"] } }));
        const retired = yield* board();
        const retiredEntry = boardProjectStagesInOrder(retired, projectA).find(
          (stage) => stage.stageId === security,
        );
        assert.strictEqual(retiredEntry?.retired, true);

        // Leave it; the next reconcile drops the empty row.
        yield* engine.dispatch(move(cardA, "merge", true));
        yield* engine.dispatch(setConfig(yield* board(), { stages: { remove: ["sprint"] } }));
        const pruned = yield* board();
        assert.isUndefined(pruned.stages?.find((stage) => stage.stageId === security));

        const shell = yield* snapshots.getBoardSnapshot();
        assert.deepStrictEqual(shell.projectStageConfigs?.[projectA]?.removedStageIds, ["sprint"]);

        const rehydrated = yield* snapshots.getCommandReadModel();
        const events: BoardEvent[] = Array.from(yield* Stream.runCollect(engine.readBoardEvents()));
        assert.strictEqual(
          events.filter((event) => event.type === "board.project-stage-config-set").length,
          3,
        );
        let replayed = {} as BoardReadModel;
        for (const event of events) replayed = yield* projectBoardEvent(replayed, event);
        assert.deepStrictEqual(replayed.board, rehydrated.board);
      }),
    );
  },
);

it.layer(makeBoardStackTestLayer("t3o-project-stage-set-project-test-"))(
  "per-project stage config: changing a card's project",
  (it) => {
    it.effect(
      "refuses moving a card out of its project while it sits in a project-owned stage",
      () =>
        Effect.gen(function* () {
          const engine = yield* boardStackEngine;
          const snapshots = yield* boardStackSnapshotQuery;
          const intake = boardProjectStageId(projectA, "intake");

          yield* engine.dispatch(createProject(projectA, "a"));
          yield* engine.dispatch(createProject(projectB, "b"));
          yield* engine.dispatch({
            type: "board.card.create",
            commandId: nextCommandId("create"),
            cardId: cardA,
            projectId: projectA,
            title: "Card A",
            createdAt: t0,
          });
          const model = yield* snapshots.getCommandReadModel();
          yield* engine.dispatch(
            setConfig(model.board!, {
              stages: { add: [{ id: "intake", label: "Intake", after: "backlog" }] },
            }),
          );
          yield* engine.dispatch(move(cardA, intake));

          const setProject = () =>
            engine.dispatch({
              type: "board.card.set-project",
              commandId: nextCommandId("set-project"),
              cardId: cardA,
              projectId: projectB,
              createdAt: t0,
            });
          const refused = yield* Effect.exit(setProject());
          assert.isTrue(Exit.isFailure(refused));
          assert.include(String(refused), "a stage only its project's t3o.json defines");

          // Back in a shared stage, the move is allowed.
          yield* engine.dispatch(move(cardA, "backlog"));
          yield* setProject();
        }),
    );
  },
);
