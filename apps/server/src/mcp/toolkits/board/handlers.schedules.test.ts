/**
 * A schedule run's board tools (T3O-117): the real handlers and engine, with the caller
 * found among schedule runs. It may file a card in its project, arm it with Auto-merge
 * off and move it up to Planning, and later runs may change the cards earlier ones made.
 */
import {
  BoardCardId,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { BoardEngine } from "../../../board/BoardEngine.ts";
import { boardStackEngine, makeBoardStackTestLayer } from "../../../board/boardStack.testkit.ts";
import {
  BoardScheduleStore,
  BoardScheduleStoreLive,
} from "../../../board/schedules/BoardScheduleStore.ts";
import {
  SupervisorReactor,
  type SupervisorReactorShape,
} from "../../../board/supervisorReactor.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { boardHandlers } from "./handlers.ts";

const t0 = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-nightly");
const otherProject = ProjectId.make("project-other");
const humanCard = BoardCardId.make("card-human");
const firstRun = ThreadId.make("thread-schedule-1");
const laterRun = ThreadId.make("thread-schedule-2");

const layer = BoardScheduleStoreLive.pipe(
  Layer.provideMerge(makeBoardStackTestLayer("t3o-board-mcp-schedules-")),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(Layer.succeed(SupervisorReactor, {} as SupervisorReactorShape)),
);

const as = (threadId: ThreadId) =>
  Effect.provideService(McpInvocationContext.McpInvocationContext, {
    environmentId: EnvironmentId.make("env-1"),
    requestNamespace: "sess-1",
    thread: {
      threadId,
      providerSessionId: "sess-1",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["board"] as const),
    issuedAt: 0,
  });

const seed = Effect.gen(function* () {
  const engine = yield* boardStackEngine;
  for (const [id, title] of [
    [projectId, "Nightly"],
    [otherProject, "Other"],
  ] as const) {
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`cmd-project-${id}`),
      projectId: id,
      title,
      workspaceRoot: `/tmp/${id}`,
      createdAt: t0,
    });
  }
  yield* engine.dispatch({
    type: "board.card.create",
    commandId: CommandId.make("cmd-human-card"),
    cardId: humanCard,
    projectId,
    title: "A human's card",
    orderKey: "m",
    createdAt: t0,
  });
  const store = yield* BoardScheduleStore;
  for (const threadId of [firstRun, laterRun]) {
    yield* store.recordRun({
      threadId,
      projectId,
      fileId: "nightly",
      environmentId: EnvironmentId.make("env-board"),
      startedAt: t0,
      launchError: null,
      branch: null,
    });
  }
});

const cardById = (cardId: string) =>
  Effect.gen(function* () {
    const model = yield* Effect.flatMap(BoardEngine, (engine) => engine.getReadModel);
    return model.board?.cards.find((card) => card.id === cardId);
  });

/** Each test on its own board. */
const test = <A, E>(name: string, body: () => Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
  it.effect(name, () => body().pipe(Effect.provide(layer)));

describe("a schedule run's board tools", () => {
  test("files a card in its project, and later runs arm and move only that card", () =>
    Effect.gen(function* () {
      yield* seed;
      const created = yield* boardHandlers
        .board_create_card({ title: "Nightly: 3 flaky tests" })
        .pipe(as(firstRun));
      assert.strictEqual((yield* cardById(created.cardId))?.stage, "backlog");

      // The next night's run, after the first thread is gone.
      yield* boardHandlers
        .board_set_automation({
          cardId: created.key,
          autoPlan: true,
          autoSignOff: true,
          autoBuild: true,
          autoMerge: false,
          approved: true,
        })
        .pipe(as(laterRun));
      yield* boardHandlers
        .board_move_card({ cardId: created.cardId, toStage: "planning" as never, override: true })
        .pipe(as(laterRun));
      const armed = yield* cardById(created.cardId);
      assert.strictEqual(armed?.stage, "planning");
      assert.strictEqual(armed?.autoMergeSetting, false);
      const store = yield* BoardScheduleStore;
      assert.isTrue(yield* store.threadTouchedCard(laterRun));

      const autoMerge = yield* Effect.flip(
        boardHandlers
          .board_set_automation({ cardId: created.key, autoMerge: true, approved: true })
          .pipe(as(laterRun)),
      );
      assert.include(autoMerge.message, "Auto-merge");
      const pastPlanning = yield* Effect.flip(
        boardHandlers
          .board_move_card({ cardId: created.cardId, toStage: "building" as never, override: true })
          .pipe(as(laterRun)),
      );
      assert.include(pastPlanning.message, "Backlog, Sprint or Planning");
      const humans = yield* Effect.flip(
        boardHandlers
          .board_update_card({ cardId: humanCard, title: "Mine now" })
          .pipe(as(laterRun)),
      );
      assert.include(humans.message, "wasn't created by this schedule");
      const foreignDependency = yield* Effect.flip(
        boardHandlers
          .board_update_card({ cardId: created.cardId, dependsOn: [humanCard] } as never)
          .pipe(as(laterRun)),
      );
      assert.include(foreignDependency.message, "wasn't created by this schedule");
    }));

  test("refuses another project, a stage, a foreign parent, and card-scoped tools", () =>
    Effect.gen(function* () {
      yield* seed;
      for (const input of [
        { title: "Elsewhere", projectId: otherProject },
        { title: "Straight to build", stage: "building" as never },
        { title: "Under a human", parentCardId: humanCard, approved: true },
      ]) {
        const refused = yield* Effect.flip(
          boardHandlers.board_create_card(input).pipe(as(firstRun)),
        );
        assert.strictEqual(refused.code, "rejected");
      }
      const context = yield* Effect.flip(boardHandlers.board_get_card_context().pipe(as(firstRun)));
      assert.strictEqual(context.code, "thread-not-linked");
      const plan = yield* Effect.flip(
        boardHandlers.board_get_plan({ planId: "plan-x" } as never).pipe(as(firstRun)),
      );
      assert.strictEqual(plan.code, "thread-not-linked");
      assert.include(plan.message, "scheduled run");
      const labels = yield* Effect.flip(
        boardHandlers.board_manage_labels({ create: [{ name: "x" }] } as never).pipe(as(firstRun)),
      );
      assert.strictEqual(labels.code, "rejected");
      const projects = yield* boardHandlers.board_list_projects().pipe(as(firstRun));
      assert.deepStrictEqual(
        projects.projects.map((project) => project.projectId),
        [projectId],
      );
    }));

  test("removes a card that would inherit Auto-merge on", () =>
    Effect.gen(function* () {
      yield* seed;
      const group = yield* boardHandlers
        .board_create_card({ title: "Nightly failures" })
        .pipe(as(firstRun));
      // Filing under its own card makes it a group, which a run may do.
      yield* boardHandlers
        .board_create_card({ title: "First child", parentCardId: group.key, approved: true })
        .pipe(as(firstRun));
      // A human arms the group; a child filed under it now would inherit that.
      const engine = yield* boardStackEngine;
      yield* engine.dispatch({
        type: "board.card.set-group-settings",
        commandId: CommandId.make("cmd-human-arms"),
        cardId: group.cardId,
        autoMerge: true,
        createdAt: t0,
      });
      const refused = yield* Effect.flip(
        boardHandlers
          .board_create_card({ title: "Child", parentCardId: group.key, approved: true })
          .pipe(as(laterRun)),
      );
      assert.include(refused.message, "was removed");
      const model = yield* Effect.flatMap(BoardEngine, (board) => board.getReadModel);
      assert.isUndefined(
        model.board?.cards.find((card) => card.title === "Child" && card.archivedAt === null),
      );
    }));
});
