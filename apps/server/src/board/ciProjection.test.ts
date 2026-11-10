/**
 * T3O-44/57 — CI records through the real seams: decider, event store, SQL
 * projection, the card detail's pass rows, the activity rail and the
 * rehydrated read model.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  BoardStageId,
  CommandId,
  boardCiStepsFromLegacy,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BoardCardRecordCiCommand,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { BoardQueries } from "./BoardQueries.ts";
import {
  boardStackEngine,
  boardStackSnapshotQuery,
  makeBoardStackTestLayer,
} from "./boardStack.testkit.ts";

const at = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-ci");
const cardId = BoardCardId.make("card-ci-1");
const steps = [
  { name: "Lint", command: "vp lint", timeoutMinutes: 30 },
  { name: "Test", command: "vp test", timeoutMinutes: 10 },
];
const ciSteps = boardCiStepsFromLegacy(steps);
const step = (index: number, status: "running" | "passed", tail = "") => ({
  ...steps[index]!,
  status,
  startedAt: at,
  finishedAt: status === "running" ? null : at,
  exitCode: status === "running" ? null : 0,
  tail,
});

it.layer(makeBoardStackTestLayer("t3o-board-ci-"))("a CI pass", (it) => {
  it.effect("lands in the pass table, the card, the shell and the rail", () =>
    Effect.gen(function* () {
      const engine = yield* boardStackEngine;
      let n = 0;
      const id = () => CommandId.make(`cmd-ci-${n++}`);
      yield* engine.dispatch({
        type: "project.create",
        commandId: id(),
        projectId,
        title: "CI project",
        workspaceRoot: `/tmp/${projectId}`,
        defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
        createdAt: at,
      });
      yield* engine.dispatch({
        type: "board.project.set-ci-steps",
        commandId: id(),
        projectId,
        steps: ciSteps,
        createdAt: at,
      });
      yield* engine.dispatch({
        type: "board.project.set-ci-enabled",
        commandId: id(),
        projectId,
        on: true,
        createdAt: at,
      });
      yield* engine.dispatch({
        type: "board.card.create",
        commandId: id(),
        cardId,
        projectId,
        title: "Goes through CI",
        keyPrefix: "CI",
        stage: BoardStageId.make("review"),
        createdAt: at,
      });
      // A human may not drag it over CI.
      const refused = yield* engine
        .dispatch({
          type: "board.card.move",
          commandId: id(),
          cardId,
          toStage: BOARD_SEED_STAGE_IDS.merge,
          override: true,
          createdAt: at,
        })
        .pipe(Effect.flip);
      assert.include(String(refused.message ?? refused), "has to pass CI");
      yield* engine.dispatch({
        type: "board.card.pipeline-move",
        commandId: id(),
        cardId,
        toStage: BOARD_SEED_STAGE_IDS.ci,
        createdAt: at,
      });
      const record = (action: BoardCardRecordCiCommand["action"]) =>
        engine.dispatch({
          type: "board.card.record-ci",
          commandId: id(),
          cardId,
          action,
          createdAt: at,
        });
      yield* record({
        kind: "start-pass",
        runId: "run-a",
        entry: 1,
        ordinal: 1,
        steps: ciSteps,
        maxFixAttempts: 2,
        logDir: "/wt/.t3/ci/run-a",
        queued: false,
        fixThreadId: null,
      });
      yield* record({ kind: "step", runId: "run-a", index: 0, step: step(0, "running") });
      yield* record({ kind: "step", runId: "run-a", index: 0, step: step(0, "passed", "ok") });
      yield* record({
        kind: "step",
        runId: "run-a",
        index: 1,
        step: step(1, "passed", "all good"),
      });
      yield* record({ kind: "finish-pass", runId: "run-a", result: "passed" });

      const detail = yield* (yield* BoardQueries).boardCardDetail(cardId);
      assert.isNotNull(detail);
      const pass = detail!.ciPasses[0]!;
      assert.strictEqual(pass.outcome, "passed");
      assert.isNotNull(pass.finishedAt);
      assert.deepStrictEqual(
        pass.steps.map((entry) => [entry.status, entry.tail]),
        [
          ["passed", "ok"],
          ["passed", "all good"],
        ],
      );
      assert.strictEqual(detail!.card.ci?.phase, "passed");
      assert.isTrue(
        detail!.activity.some(
          (entry) => entry.kind === "card-ci-pass-finished" && entry.payload.ciOutcome === "passed",
        ),
      );

      const snapshot = yield* (yield* boardStackSnapshotQuery).getBoardSnapshot();
      const shell = snapshot.cards.find((candidate) => candidate.cardId === cardId)!;
      assert.strictEqual(shell.ci?.steps[1]?.status, "passed");
      assert.notProperty(shell.ci?.steps[1] ?? {}, "tail");

      // Rehydrated from the tables, the card's CI state is the same.
      const rehydrated = yield* (yield* boardStackSnapshotQuery).getCommandReadModel();
      assert.deepStrictEqual(
        rehydrated.board?.cards.find((candidate) => candidate.id === cardId)?.ci,
        detail!.card.ci,
      );

      // T3O-57: Stop on failure saves to the project's CI config, and a pass
      // started with it off carries that, its fix's issue count, and a stop
      // with the fix thread on its row.
      yield* engine.dispatch({
        type: "board.project.set-ci-stop-on-failure",
        commandId: id(),
        projectId,
        stopOnFailure: false,
        createdAt: at,
      });
      const configured = yield* (yield* boardStackSnapshotQuery).getCommandReadModel();
      assert.isFalse(configured.board?.projectStageConfigs?.[projectId]?.ci.stopOnFailure);
      assert.lengthOf(configured.board?.projectStageConfigs?.[projectId]?.ci.steps ?? [], 2);
      // Editing the steps keeps the setting; Yes stores nothing.
      yield* engine.dispatch({
        type: "board.project.set-ci-steps",
        commandId: id(),
        projectId,
        steps: ciSteps.slice(0, 1),
        createdAt: at,
      });
      const edited = yield* (yield* boardStackSnapshotQuery).getCommandReadModel();
      assert.isFalse(edited.board?.projectStageConfigs?.[projectId]?.ci.stopOnFailure);
      yield* engine.dispatch({
        type: "board.project.set-ci-stop-on-failure",
        commandId: id(),
        projectId,
        stopOnFailure: true,
        createdAt: at,
      });
      const yes = yield* (yield* boardStackSnapshotQuery).getCommandReadModel();
      assert.notProperty(yes.board?.projectStageConfigs?.[projectId]?.ci ?? {}, "stopOnFailure");
      yield* record({
        kind: "start-pass",
        runId: "run-b",
        entry: 1,
        ordinal: 2,
        steps: ciSteps,
        maxFixAttempts: 2,
        logDir: "/wt/.t3/ci/run-b",
        queued: false,
        fixThreadId: null,
        continueOnFailure: true,
      });
      yield* record({ kind: "finish-pass", runId: "run-b", result: "failed" });
      yield* record({ kind: "begin-fix", runId: "run-b", fixIssues: 2 });
      yield* record({
        kind: "stop",
        runId: "run-b",
        reason: "The fix agent couldn't fix Test: needs a database.",
        finding: "",
        fixThreadId: ThreadId.make("thread-fix-b"),
      });
      const stopped = yield* (yield* BoardQueries).boardCardDetail(cardId);
      assert.deepStrictEqual(
        {
          phase: stopped!.card.ci?.phase,
          continueOnFailure: stopped!.card.ci?.continueOnFailure,
          fixIssues: stopped!.card.ci?.fixIssues,
        },
        { phase: "stopped", continueOnFailure: true, fixIssues: 2 },
      );
      const passB = stopped!.ciPasses.find((entry) => entry.runId === "run-b");
      assert.strictEqual(passB?.outcome, "stopped");
      assert.strictEqual(passB?.fixThreadId, "thread-fix-b");
      const reread = yield* (yield* boardStackSnapshotQuery).getCommandReadModel();
      assert.deepStrictEqual(
        reread.board?.cards.find((candidate) => candidate.id === cardId)?.ci,
        stopped!.card.ci,
      );
    }),
  );
});

it.layer(makeBoardStackTestLayer("t3o-board-ci-leave-"))("a card leaving CI", (it) => {
  it.effect("while its fix agent runs settles the failed pass as cancelled", () =>
    Effect.gen(function* () {
      const engine = yield* boardStackEngine;
      let n = 0;
      const id = () => CommandId.make(`cmd-ci-leave-${n++}`);
      yield* engine.dispatch({
        type: "project.create",
        commandId: id(),
        projectId,
        title: "CI project",
        workspaceRoot: `/tmp/${projectId}`,
        defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
        createdAt: at,
      });
      yield* engine.dispatch({
        type: "board.project.set-ci-steps",
        commandId: id(),
        projectId,
        steps: ciSteps,
        createdAt: at,
      });
      yield* engine.dispatch({
        type: "board.project.set-ci-enabled",
        commandId: id(),
        projectId,
        on: true,
        createdAt: at,
      });
      yield* engine.dispatch({
        type: "board.card.create",
        commandId: id(),
        cardId,
        projectId,
        title: "Dragged out mid-fix",
        keyPrefix: "CI",
        stage: BoardStageId.make("review"),
        createdAt: at,
      });
      yield* engine.dispatch({
        type: "board.card.pipeline-move",
        commandId: id(),
        cardId,
        toStage: BOARD_SEED_STAGE_IDS.ci,
        createdAt: at,
      });
      const record = (action: BoardCardRecordCiCommand["action"]) =>
        engine.dispatch({
          type: "board.card.record-ci",
          commandId: id(),
          cardId,
          action,
          createdAt: at,
        });
      yield* record({
        kind: "start-pass",
        runId: "run-a",
        entry: 1,
        ordinal: 1,
        steps: ciSteps,
        maxFixAttempts: 2,
        logDir: "/wt/.t3/ci/run-a",
        queued: false,
        fixThreadId: null,
      });
      yield* record({ kind: "finish-pass", runId: "run-a", result: "failed" });
      yield* record({ kind: "begin-fix", runId: "run-a" });

      yield* engine.dispatch({
        type: "board.card.move",
        commandId: id(),
        cardId,
        toStage: BoardStageId.make("review"),
        override: true,
        createdAt: at,
      });

      const detail = yield* (yield* BoardQueries).boardCardDetail(cardId);
      assert.strictEqual(detail!.ciPasses[0]!.outcome, "cancelled");
      assert.isNull(detail!.card.ci);

      // T3O-49: a send-back counts a round trip; the board's own move keeps
      // the count, and a human's move starts it again.
      const queries = yield* BoardQueries;
      const roundTrips = () =>
        queries.boardCardDetail(cardId).pipe(Effect.map((found) => found!.card.ciRoundTrips));
      yield* engine.dispatch({
        type: "board.card.pipeline-move",
        commandId: id(),
        cardId,
        toStage: BOARD_SEED_STAGE_IDS.ci,
        createdAt: at,
      });
      yield* record({
        kind: "send-back",
        runId: null,
        stepName: "Test",
        finding: "broken",
        round: 2,
        fixThreadId: null,
      });
      assert.strictEqual(yield* roundTrips(), 1);
      yield* engine.dispatch({
        type: "board.card.pipeline-move",
        commandId: id(),
        cardId,
        toStage: BOARD_SEED_STAGE_IDS.review,
        override: true,
        createdAt: at,
      });
      assert.strictEqual(yield* roundTrips(), 1);
      yield* engine.dispatch({
        type: "board.card.move",
        commandId: id(),
        cardId,
        toStage: BOARD_SEED_STAGE_IDS.building,
        override: true,
        cause: "human",
        createdAt: at,
      });
      assert.strictEqual(yield* roundTrips(), 0);
    }),
  );
});
