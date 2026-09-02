/**
 * Pulling a merged card's base branch forward in the project-root checkout.
 *
 * The logic worth pinning is which git command runs, and that every failure is
 * a reported skip rather than a raised error: the card is already merged, so a
 * base we could not fast-forward must never surface as a failure. The git
 * driver is faked down to the two methods this module calls.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { GitCommandError } from "@t3tools/contracts";

import type { ExecuteGitInput, ExecuteGitResult, GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { pullMergedBaseBranch } from "./baseBranchSync.ts";

/** The slice of a git result a fake needs to control; the rest is filled in. */
interface FakeReply {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

interface FakeGitOptions {
  readonly remoteName?: string | null;
  /** Reply keyed by the `execute` operation suffix (e.g. "currentBranch"). */
  readonly reply: (operation: string) => FakeReply;
}

function fakeGit(options: FakeGitOptions): {
  readonly service: GitVcsDriver["Service"];
  readonly calls: ReadonlyArray<ExecuteGitInput>;
} {
  const calls: Array<ExecuteGitInput> = [];
  const service = {
    resolvePrimaryRemoteName: (cwd: string) =>
      options.remoteName === undefined || options.remoteName === null
        ? Effect.fail(
            new GitCommandError({
              operation: "git.resolvePrimaryRemoteName",
              command: "git remote",
              cwd,
              detail: "no remote",
            }),
          )
        : Effect.succeed(options.remoteName),
    execute: (input: ExecuteGitInput) => {
      calls.push(input);
      const suffix = input.operation.slice(input.operation.lastIndexOf(".") + 1);
      const reply = options.reply(suffix);
      return Effect.succeed({
        exitCode: (reply.exitCode ?? 0) as ExecuteGitResult["exitCode"],
        stdout: reply.stdout ?? "",
        stderr: reply.stderr ?? "",
        stdoutTruncated: false,
        stderrTruncated: false,
      } satisfies ExecuteGitResult);
    },
  } as unknown as GitVcsDriver["Service"];
  return { service, calls };
}

describe("pullMergedBaseBranch", () => {
  it.effect("fast-forwards the checked-out base branch with a --ff-only pull", () =>
    Effect.gen(function* () {
      const git = fakeGit({
        remoteName: "origin",
        reply: (op) => (op === "currentBranch" ? { stdout: "main\n" } : {}),
      });
      const result = yield* pullMergedBaseBranch({
        git: git.service,
        cwd: "/repo",
        baseBranch: "main",
      });
      assert.deepStrictEqual(result, { updated: true, skippedReason: null });
      const pull = git.calls.find((call) => call.operation.endsWith(".pull"));
      assert.deepStrictEqual(pull?.args, ["pull", "--ff-only", "origin", "main"]);
      assert.isUndefined(git.calls.find((call) => call.operation.endsWith(".fetch")));
    }),
  );

  it.effect("moves the base ref with a fast-forward fetch when it is not checked out", () =>
    Effect.gen(function* () {
      const git = fakeGit({
        remoteName: "origin",
        // Root checkout sits on some other branch — base is not out here.
        reply: (op) => (op === "currentBranch" ? { stdout: "board/card-1\n" } : {}),
      });
      const result = yield* pullMergedBaseBranch({
        git: git.service,
        cwd: "/repo",
        baseBranch: "main",
      });
      assert.deepStrictEqual(result, { updated: true, skippedReason: null });
      const fetch = git.calls.find((call) => call.operation.endsWith(".fetch"));
      assert.deepStrictEqual(fetch?.args, ["fetch", "origin", "main:main"]);
      assert.isUndefined(git.calls.find((call) => call.operation.endsWith(".pull")));
    }),
  );

  it.effect("skips, without erroring, when there is no remote", () =>
    Effect.gen(function* () {
      const git = fakeGit({ remoteName: null, reply: () => ({}) });
      const result = yield* pullMergedBaseBranch({
        git: git.service,
        cwd: "/repo",
        baseBranch: "main",
      });
      assert.deepStrictEqual(result, {
        updated: false,
        skippedReason: "no remote to pull from",
      });
      assert.lengthOf(git.calls, 0);
    }),
  );

  it.effect("reports a base it could not fast-forward instead of failing", () =>
    Effect.gen(function* () {
      const git = fakeGit({
        remoteName: "origin",
        reply: (op) =>
          op === "currentBranch"
            ? { stdout: "board/card-1\n" }
            : { exitCode: 1, stderr: "! [rejected] main -> main (non-fast-forward)" },
      });
      const result = yield* pullMergedBaseBranch({
        git: git.service,
        cwd: "/repo",
        baseBranch: "main",
      });
      assert.isFalse(result.updated);
      assert.include(result.skippedReason ?? "", "local main not fast-forwarded");
    }),
  );
});
