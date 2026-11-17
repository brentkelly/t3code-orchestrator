/**
 * T3o: how a t3o.json schedule's run starts (T3O-117): exactly as upstream launches a worktree
 * run, setup script included. A port, implemented beside the thread gateway, the board's one
 * seam onto threads.
 */
import type {
  CommandId,
  ModelSelection,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface BoardScheduleLaunchInput {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly prompt: string;
  readonly taskId: ScheduledTaskId;
  readonly modelSelection: ModelSelection;
  readonly baseRef: string;
  /** Created off the base for this run alone. */
  readonly branch: string;
}

export class BoardScheduleLauncher extends Context.Service<
  BoardScheduleLauncher,
  {
    /** Returns once the thread exists and its first message is sent; preparation forks inside. */
    readonly launch: (
      input: BoardScheduleLaunchInput,
    ) => Effect.Effect<ThreadId, { readonly message: string }>;
  }
>()("t3/board/schedules/BoardScheduleLauncher") {}
