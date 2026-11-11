import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { GitManager } from "../../git/GitManager.ts";
import { BoardGitStatus } from "./BoardGitStatus.ts";

export const BoardGitStatusLive = Layer.effect(
  BoardGitStatus,
  Effect.gen(function* () {
    const git = yield* GitManager;
    return BoardGitStatus.of({
      branchPullRequest: git.branchPullRequest,
      invalidateStatus: git.invalidateStatus,
    });
  }),
);
