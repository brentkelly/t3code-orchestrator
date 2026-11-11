/**
 * The port adapters against stubbed upstream services: each port
 * forwards to the upstream service it narrows. Testkits stub the ports
 * directly, so without this a broken adapter would only surface in prod.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { GitManager } from "../../git/GitManager.ts";
import { ProjectSetupScriptRunner } from "../../project/ProjectSetupScriptRunner.ts";
import { TerminalManager } from "../../terminal/Manager.ts";
import type { BoardServerLive } from "../serverLayer.ts";
import { BoardGitStatus } from "./BoardGitStatus.ts";
import { BoardGitStatusLive } from "./BoardGitStatus.live.ts";
import { BoardSetupScriptRunner } from "./BoardSetupScriptRunner.ts";
import { BoardSetupScriptRunnerLive } from "./BoardSetupScriptRunner.live.ts";
import { BoardTerminals } from "./BoardTerminals.ts";
import { BoardTerminalsLive } from "./BoardTerminals.live.ts";

// `serverLayer.ts` provides every port itself: none may leak into what
// `server.ts` has to provide. Checked by the typecheck, not at runtime.
type BoardServerRequirements = Layer.Services<typeof BoardServerLive>;
const portsAreProvided: [
  Extract<BoardServerRequirements, BoardSetupScriptRunner | BoardTerminals | BoardGitStatus>,
] extends [never]
  ? true
  : false = true;

describe("board port adapters", () => {
  it.effect("forward each call to the upstream service", () => {
    const calls: Array<string> = [];
    const upstream = Layer.mergeAll(
      Layer.mock(ProjectSetupScriptRunner)({
        runForThread: (input) =>
          Effect.sync(() => {
            calls.push(`setup:${input.threadId}:${input.worktreePath}`);
            return { status: "no-script" as const };
          }),
      }),
      Layer.mock(TerminalManager)({
        close: (input) => Effect.sync(() => void calls.push(`close:${input.threadId}`)),
      }),
      Layer.mock(GitManager)({
        branchPullRequest: (input) =>
          Effect.sync(() => {
            calls.push(`branchPullRequest:${input.cwd}:${input.branch}`);
            return null;
          }),
        invalidateStatus: (cwd) => Effect.sync(() => void calls.push(`invalidate:${cwd}`)),
      }),
    );
    return Effect.gen(function* () {
      const setup = yield* BoardSetupScriptRunner;
      const terminals = yield* BoardTerminals;
      const git = yield* BoardGitStatus;

      const result = yield* setup.runForThread({ threadId: "thread-1", worktreePath: "/wt" });
      yield* terminals.close({ threadId: "thread-1", deleteHistory: false });
      yield* git.invalidateStatus("/repo");
      const pullRequest = yield* git.branchPullRequest({ cwd: "/repo", branch: "board/t-1" });

      assert.isTrue(portsAreProvided);
      assert.deepStrictEqual(result, { status: "no-script" });
      assert.isNull(pullRequest);
      assert.deepStrictEqual(calls, [
        "setup:thread-1:/wt",
        "close:thread-1",
        "invalidate:/repo",
        "branchPullRequest:/repo:board/t-1",
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(BoardSetupScriptRunnerLive, BoardTerminalsLive, BoardGitStatusLive).pipe(
          Layer.provide(upstream),
        ),
      ),
    );
  });
});
