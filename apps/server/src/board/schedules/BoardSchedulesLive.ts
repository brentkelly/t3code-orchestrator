/**
 * T3o: `BoardSchedules` on this server's real services (T3O-117), and the runner it
 * registers with upstream's scheduled tasks for the board's lifetime.
 */
import { BoardScheduleError, CommandId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ThreadLaunchService } from "../../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ScheduledTaskService } from "../../scheduledTasks/ScheduledTaskService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { boardFallbackModelSelection } from "../boardFallbackModel.ts";
import { ThreadGateway, UNKNOWN_THREAD_STATE } from "../ThreadGateway.ts";
import { BoardWorkspaces } from "../workspace/BoardWorkspace.ts";
import { WorktreeRetirer } from "../worktreeRetire.ts";
import { BoardSchedules, makeBoardSchedules } from "./BoardSchedules.ts";
import { BoardScheduleStore, BoardScheduleStoreLive } from "./BoardScheduleStore.ts";
import { registerBoardScheduleRunner } from "./scheduleRuns.ts";

const make = Effect.gen(function* () {
  const store = yield* BoardScheduleStore;
  const scheduledTasks = yield* ScheduledTaskService;
  const threads = yield* ThreadGateway;
  const threadManagement = yield* ThreadManagementService;
  const launcher = yield* ThreadLaunchService;
  const workspaces = yield* BoardWorkspaces;
  const retirer = yield* WorktreeRetirer;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const serverSettings = yield* ServerSettingsService;
  const crypto = yield* SecureRandom.SecureRandom;
  const serverEnvironmentId = yield* Effect.flatMap(
    ServerEnvironment,
    (env) => env.getEnvironmentId,
  );
  const uuid = crypto.uuidV4().pipe(Effect.orDie);

  return makeBoardSchedules({
    store,
    tasks: {
      list: () => scheduledTasks.list().pipe(Effect.map((result) => result.tasks)),
      upsert: (input) => scheduledTasks.upsert(input),
      delete: (id) => scheduledTasks.delete({ id }).pipe(Effect.asVoid),
      runNow: (id) => scheduledTasks.runNow({ id }),
    },
    serverEnvironmentId,
    projects: () =>
      threads
        .projects()
        .pipe(
          Effect.mapError(
            (cause) => new BoardScheduleError({ message: "Couldn't read the projects.", cause }),
          ),
        ),
    threadState: (threadId) =>
      threads.threadState(threadId).pipe(Effect.orElseSucceed(() => UNKNOWN_THREAD_STATE)),
    deleteThread: (threadId) =>
      Effect.flatMap(uuid, (id) =>
        threads.delete({
          commandId: CommandId.make(`server:board-schedule-prune:${id}`),
          threadId,
        }),
      ).pipe(
        Effect.mapError(
          (cause) => new BoardScheduleError({ message: "Couldn't delete the run thread.", cause }),
        ),
      ),
    threadWorkspace: (threadId) =>
      threadManagement.getThreadShell(threadId).pipe(
        Effect.map((shell) => ({
          worktreePath: shell?.worktreePath ?? null,
          branch: shell?.branch ?? null,
        })),
        Effect.orElseSucceed(() => ({ worktreePath: null, branch: null })),
      ),
    // Deleting a thread leaves its worktree, and every run makes a new branch.
    removeRunWorktree: Effect.fn("BoardSchedules.removeRunWorktree")(
      function* ({ project, worktreePath, branch }) {
        if (worktreePath !== null && worktreePath !== project.workspaceRoot) {
          const retired = yield* retirer.retire({
            projectCwd: project.workspaceRoot,
            projectId: project.id,
            worktreePath,
            kind: "forced",
            verifiedClean: false,
            skipIfBusy: true,
          });
          if (retired === null || retired.outcome !== "removed") return false;
        }
        if (branch !== null) {
          yield* git.execute({
            operation: "board.schedule.pruneRunBranch",
            cwd: project.workspaceRoot,
            args: ["branch", "-D", branch],
            allowNonZeroExit: true,
          });
        }
        return true;
      },
      Effect.orElseSucceed(() => false),
    ),
    defaultBranch: (projectId) =>
      workspaces.localProject(projectId).pipe(
        Effect.flatMap((workspace) => workspace.resolveDefaultBranch({})),
        Effect.map((resolved) =>
          resolved.defaultBranch.length > 0 ? resolved.defaultBranch : null,
        ),
        Effect.orElseSucceed(() => null),
      ),
    modelFor: (projectId) =>
      boardFallbackModelSelection(serverSettings, projectId).pipe(
        Effect.map((selection) => {
          const options = "options" in selection ? selection.options : undefined;
          return {
            instanceId: selection.instanceId,
            model: selection.model,
            ...(options === undefined ? {} : { options }),
          };
        }),
      ),
    launch: (input) =>
      launcher
        .launch({
          commandId: input.commandId,
          threadId: input.threadId,
          projectId: input.projectId,
          title: input.title,
          modelSelection: input.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "worktree", baseRef: input.baseRef, startFromOrigin: true },
          initialMessage: { scheduledTaskId: input.taskId, text: input.prompt, attachments: [] },
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(Effect.map((launched) => launched.threadId)),
    uuid,
    utcOffsetMinutes: DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone).pipe(
      Effect.map((now) => Math.round(DateTime.zonedOffset(now) / 60_000)),
    ),
    retainInBackground: true,
  });
});

/** One long-lived instance for the server, with its runner registered for its lifetime. */
export const BoardSchedulesLive = Layer.effect(
  BoardSchedules,
  Effect.tap(make, (schedules) => registerBoardScheduleRunner({ run: schedules.run })),
).pipe(Layer.provideMerge(BoardScheduleStoreLive));
