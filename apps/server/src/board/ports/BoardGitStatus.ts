/**
 * The board's narrow view of upstream's `GitManager` (T3O-45): importing
 * `git/GitManager.ts` loads `ProjectSetupScriptRunner` and through it every
 * provider driver. Only `BoardGitStatus.live.ts` imports upstream.
 */
import type { GitManagerServiceError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { GitBranchPullRequest } from "../../git/GitManager.ts";

export class BoardGitStatus extends Context.Service<
  BoardGitStatus,
  {
    readonly branchPullRequest: (input: {
      readonly cwd: string;
      readonly branch: string;
    }) => Effect.Effect<GitBranchPullRequest | null, GitManagerServiceError>;
    readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
  }
>()("t3/board/ports/BoardGitStatus") {}
