/**
 * T3o: a worker's side of a board's t3o.json schedule runs (T3O-118). `WorkerGatewayHost`
 * guards the call and prunes; this launches the run exactly as a local scheduled run, and
 * removes a pruned run's worktree. The host sits below the workspace and retirement layers,
 * so it reaches this through a slot the board layer fills for its lifetime.
 */
import type { CommandId, ModelSelection, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import { BoardScheduleLauncherLive } from "../ThreadGatewayV2.ts";
import { BoardWorkspaces } from "../workspace/BoardWorkspace.ts";
import { BoardScheduleLauncher } from "./BoardScheduleLauncher.ts";
import { makeRemoveRunWorktree, type RunWorktreeInput } from "./runWorktree.ts";

export interface WorkerScheduleLaunchInput {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  /** This worker's own project. */
  readonly projectId: ProjectId;
  readonly title: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly branch: string;
}

export interface WorkerScheduleRunsShape {
  /** Returns once the thread exists and its first message is sent. */
  readonly launch: (
    input: WorkerScheduleLaunchInput,
  ) => Effect.Effect<void, { readonly message: string }>;
  readonly removeRunWorktree: (input: RunWorktreeInput) => Effect.Effect<boolean>;
}

export class WorkerScheduleRunsSlot extends Context.Service<
  WorkerScheduleRunsSlot,
  {
    readonly current: () => WorkerScheduleRunsShape | null;
    readonly register: (runs: WorkerScheduleRunsShape) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/board/schedules/WorkerScheduleRuns/WorkerScheduleRunsSlot") {}

export const makeWorkerScheduleRunsSlot = () => {
  let current: WorkerScheduleRunsShape | null = null;
  return WorkerScheduleRunsSlot.of({
    current: () => current,
    register: Effect.fn("WorkerScheduleRunsSlot.register")((runs: WorkerScheduleRunsShape) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          current = runs;
        }),
        () =>
          Effect.sync(() => {
            if (current === runs) current = null;
          }),
      ),
    ),
  });
};

export const WorkerScheduleRunsSlotLive = Layer.sync(
  WorkerScheduleRunsSlot,
  makeWorkerScheduleRunsSlot,
);

const make = Effect.gen(function* () {
  const launcher = yield* BoardScheduleLauncher;
  const workspaces = yield* BoardWorkspaces;
  const removeRunWorktree = yield* makeRemoveRunWorktree;
  return {
    launch: Effect.fn("WorkerScheduleRuns.launch")(function* (input) {
      // The default branch of this worker's own checkout, as a local run resolves it.
      const resolved = yield* workspaces.localProject(input.projectId).pipe(
        Effect.flatMap((workspace) => workspace.resolveDefaultBranch({})),
        Effect.orElseSucceed(() => null),
      );
      if (resolved === null || resolved.defaultBranch.length === 0) {
        return yield* Effect.fail({
          message: "Couldn't resolve the project's default branch on the worker.",
        });
      }
      yield* launcher.launch({
        commandId: input.commandId,
        threadId: input.threadId,
        projectId: input.projectId,
        title: input.title,
        prompt: input.prompt,
        modelSelection: input.modelSelection,
        baseRef: resolved.defaultBranch,
        branch: input.branch,
      });
    }),
    removeRunWorktree,
  } satisfies WorkerScheduleRunsShape;
});

/** Fills the worker's slot for the board layer's lifetime. */
export const WorkerScheduleRunsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const slot = yield* WorkerScheduleRunsSlot;
    yield* slot.register(yield* make);
  }),
).pipe(Layer.provide(BoardScheduleLauncherLive));
