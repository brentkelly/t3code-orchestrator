import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";

import { VcsProcessExitError } from "@t3tools/contracts";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ForgejoCli from "./ForgejoCli.ts";
import type * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  FORGEJO_PR_LIST_JSON,
  FORGEJO_PR_VIEW_JSON,
  FORGEJO_REPO_VIEW_OUTPUT,
} from "./testing/forgejoFixtures.ts";

const mockedRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();
const mockedReadFileString = vi.fn<FileSystem.FileSystem["readFileString"]>();
const mockedListLocalBranchNames =
  vi.fn<GitVcsDriver.GitVcsDriver["Service"]["listLocalBranchNames"]>();
const mockedFetchPullRequestBranch =
  vi.fn<GitVcsDriver.GitVcsDriver["Service"]["fetchPullRequestBranch"]>();
const mockedSwitchRef = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["switchRef"]>();

const layer = it.layer(
  ForgejoCli.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(VcsProcess.VcsProcess)({ run: mockedRun }),
        FileSystem.layerNoop({ readFileString: mockedReadFileString }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          listLocalBranchNames: mockedListLocalBranchNames,
          fetchPullRequestBranch: mockedFetchPullRequestBranch,
          switchRef: mockedSwitchRef,
        }),
      ),
    ),
  ),
);

/** A board card's remote: a self-hosted instance on a hostname that names nothing. */
const context: SourceControlProvider.SourceControlProviderContext = {
  provider: { kind: "forgejo", name: "Forgejo", baseUrl: "https://forgejo.example.test" },
  remoteName: "origin",
  remoteUrl: "https://forgejo.example.test/octocat/widgets.git",
};

/** Both flags on every applicable call — this is the linked-worktree guarantee. */
const TARGET_ARGS = ["-R", "octocat/widgets", "--hostname", "forgejo.example.test"];

function processOutput(
  stdout: string,
  options?: { readonly stdoutTruncated?: boolean },
): VcsProcess.VcsProcessOutput {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: options?.stdoutTruncated ?? false,
    stderrTruncated: false,
  };
}

afterEach(() => {
  mockedRun.mockReset();
  mockedReadFileString.mockReset();
  mockedListLocalBranchNames.mockReset();
  mockedFetchPullRequestBranch.mockReset();
  mockedSwitchRef.mockReset();
});

layer("ForgejoCli.layer", (it) => {
  it.effect("lists open change requests for the head branch with -R and --hostname", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput(FORGEJO_PR_LIST_JSON)));

      const forgejo = yield* ForgejoCli.ForgejoCli;
      const result = yield* forgejo.listPullRequests({
        cwd: "/repo",
        context,
        headSelector: "feat/read-document",
        state: "open",
      });

      assert.deepStrictEqual(
        result.map((entry) => [entry.number, entry.state]),
        [[37, "open"]],
      );
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "fgj",
          cwd: "/repo",
          args: ["pr", "list", "--json", "-s", "open", ...TARGET_ARGS],
        }),
      );
    }),
  );

  it.effect("asks for closed change requests when the caller wants merged ones", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput(FORGEJO_PR_LIST_JSON)));

      const forgejo = yield* ForgejoCli.ForgejoCli;
      const result = yield* forgejo.listPullRequests({
        cwd: "/repo",
        context,
        headSelector: "board/ma-3",
        state: "merged",
      });

      assert.deepStrictEqual(
        result.map((entry) => [entry.number, entry.state]),
        [[41, "merged"]],
      );
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ["pr", "list", "--json", "-s", "closed", ...TARGET_ARGS],
        }),
      );
    }),
  );

  it.effect("does not report a merged change request as closed", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput(FORGEJO_PR_LIST_JSON)));

      const forgejo = yield* ForgejoCli.ForgejoCli;
      const result = yield* forgejo.listPullRequests({
        cwd: "/repo",
        context,
        headSelector: "board/ma-3",
        state: "closed",
      });

      assert.deepStrictEqual(result, []);
    }),
  );

  it.effect("filters by head branch, since fgj cannot", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput(FORGEJO_PR_LIST_JSON)));

      const forgejo = yield* ForgejoCli.ForgejoCli;
      const result = yield* forgejo.listPullRequests({
        cwd: "/repo",
        context,
        headSelector: "octocat:board/ma-3",
        state: "all",
      });

      assert.deepStrictEqual(
        result.map((entry) => entry.number),
        [41],
      );
    }),
  );

  it.effect("sorts newest first and honours the caller's limit", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify(
              [3, 11, 7].map((number) => ({
                number,
                title: `PR ${number}`,
                html_url: `https://forgejo.example.test/octocat/widgets/pulls/${number}`,
                base: { ref: "main" },
                head: { ref: "shared-branch" },
                state: "open",
              })),
            ),
          ),
        ),
      );

      const forgejo = yield* ForgejoCli.ForgejoCli;
      const result = yield* forgejo.listPullRequests({
        cwd: "/repo",
        context,
        headSelector: "shared-branch",
        state: "all",
        limit: 2,
      });

      assert.deepStrictEqual(
        result.map((entry) => entry.number),
        [11, 7],
      );
    }),
  );

  it.effect("refuses a truncated list instead of decoding it as an empty one", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(processOutput('[{"number":1,', { stdoutTruncated: true })),
      );

      const forgejo = yield* ForgejoCli.ForgejoCli;
      const error = yield* forgejo
        .listPullRequests({ cwd: "/repo", context, headSelector: "main", state: "all" })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "ForgejoOutputTruncatedError");
    }),
  );

  it.effect("fails with no remote to address rather than letting fgj guess a host", () =>
    Effect.gen(function* () {
      const forgejo = yield* ForgejoCli.ForgejoCli;
      const error = yield* forgejo
        .listPullRequests({ cwd: "/repo", headSelector: "main", state: "all" })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "ForgejoRemoteContextError");
      expect(mockedRun).not.toHaveBeenCalled();
    }),
  );

  it.effect("reads a single change request by number", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput(FORGEJO_PR_VIEW_JSON)));

      const forgejo = yield* ForgejoCli.ForgejoCli;
      const result = yield* forgejo.getPullRequest({ cwd: "/repo", context, reference: "41" });

      assert.strictEqual(result.number, 41);
      assert.strictEqual(result.state, "merged");
      assert.strictEqual(Option.isSome(result.updatedAt ?? Option.none()), true);
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ["pr", "view", "41", "--json", ...TARGET_ARGS],
        }),
      );
    }),
  );

  it.effect("accepts a change request URL or a #-prefixed number", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValue(Effect.succeed(processOutput(FORGEJO_PR_VIEW_JSON)));

      const forgejo = yield* ForgejoCli.ForgejoCli;
      yield* forgejo.getPullRequest({
        cwd: "/repo",
        context,
        reference: "https://forgejo.example.test/octocat/widgets/pulls/41",
      });
      yield* forgejo.getPullRequest({ cwd: "/repo", context, reference: "#41" });

      for (const call of mockedRun.mock.calls) {
        assert.deepStrictEqual(call[0].args, ["pr", "view", "41", "--json", ...TARGET_ARGS]);
      }
    }),
  );

  it.effect("reports a missing change request as not found", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.fail(
          new VcsProcessExitError({
            operation: "ForgejoCli.execute",
            command: "fgj",
            cwd: "/repo",
            argumentCount: 7,
            exitCode: 1,
            detail: "failed to get pull request: The target couldn't be found.",
            failureKind: "not-found",
          }),
        ),
      );

      const forgejo = yield* ForgejoCli.ForgejoCli;
      const error = yield* forgejo
        .getPullRequest({ cwd: "/repo", context, reference: "999" })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "ForgejoPullRequestNotFoundError");
      assert.strictEqual(error.detail.includes("999"), true);
    }),
  );

  it.effect("reads the body file and passes it inline, since fgj has no --body-file", () =>
    Effect.gen(function* () {
      mockedReadFileString.mockReturnValueOnce(Effect.succeed("A body\nover two lines."));
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const forgejo = yield* ForgejoCli.ForgejoCli;
      yield* forgejo.createPullRequest({
        cwd: "/repo",
        context,
        baseBranch: "main",
        headSelector: "board/t3o-28",
        title: "Forgejo support",
        bodyFile: "/tmp/body.md",
      });

      expect(mockedReadFileString).toHaveBeenCalledWith("/tmp/body.md");
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          args: [
            "pr",
            "create",
            ...TARGET_ARGS,
            "-B",
            "main",
            "-H",
            "board/t3o-28",
            "-t",
            "Forgejo support",
            "-b",
            "A body\nover two lines.",
          ],
        }),
      );
    }),
  );

  // A single argv entry is capped at 128 KiB on Linux; past it the spawn fails with E2BIG, which
  // the error mapping would otherwise report as "`fgj` is not on PATH" and send someone chasing
  // a problem they do not have. `fgj pr create` has no --body-file to fall back to.
  it.effect("says the body is too large rather than reporting fgj as missing", () =>
    Effect.gen(function* () {
      mockedReadFileString.mockReturnValueOnce(Effect.succeed("x".repeat(200_000)));

      const forgejo = yield* ForgejoCli.ForgejoCli;
      const error = yield* forgejo
        .createPullRequest({
          cwd: "/repo",
          context,
          baseBranch: "main",
          headSelector: "board/t3o-28",
          title: "Forgejo support",
          bodyFile: "/tmp/body.md",
        })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "ForgejoPullRequestBodyTooLargeError");
      expect(mockedRun).not.toHaveBeenCalled();
    }),
  );

  it.effect("does not run fgj when the body file cannot be read", () =>
    Effect.gen(function* () {
      mockedReadFileString.mockReturnValueOnce(Effect.fail(new Error("gone") as never));

      const forgejo = yield* ForgejoCli.ForgejoCli;
      const error = yield* forgejo
        .createPullRequest({
          cwd: "/repo",
          context,
          baseBranch: "main",
          headSelector: "board/t3o-28",
          title: "Forgejo support",
          bodyFile: "/tmp/body.md",
        })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "ForgejoPullRequestBodyReadError");
      expect(mockedRun).not.toHaveBeenCalled();
    }),
  );

  it.effect("passes the merge strategy straight through as fgj's merge method", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("")));
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput(FORGEJO_PR_VIEW_JSON)));

      const forgejo = yield* ForgejoCli.ForgejoCli;
      yield* forgejo.mergePullRequest({
        cwd: "/repo",
        context,
        reference: "#41",
        strategy: "squash",
      });

      expect(mockedRun).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          args: ["pr", "merge", "41", "--merge-method", "squash", ...TARGET_ARGS],
        }),
      );
    }),
  );

  // `fgj pr merge` v0.4.0 prints "Pull request #N merged successfully" and exits 0 whatever the
  // host answered — verified live against a closed-unmerged PR and against a PR that does not
  // exist. A card moved to Done on that word would be wrong in the one direction that cannot be
  // undone, so the state is read back.
  it.effect("does not believe fgj's merge report until the host agrees", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(processOutput("Pull request #37 merged successfully")),
      );
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              number: 37,
              title: "Still open",
              html_url: "https://forgejo.example.test/octocat/widgets/pulls/37",
              base: { ref: "main" },
              head: { ref: "feature" },
              state: "open",
              merged: false,
            }),
          ),
        ),
      );

      const forgejo = yield* ForgejoCli.ForgejoCli;
      const error = yield* forgejo
        .mergePullRequest({ cwd: "/repo", context, reference: "37", strategy: "merge" })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "ForgejoMergeNotAppliedError");
      assert.strictEqual(error.detail.includes("37"), true);
      assert.strictEqual(error.detail.includes("open"), true);
    }),
  );

  it.effect("accepts the merge once the host reports the change request merged", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(processOutput("Pull request #41 merged successfully")),
      );
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput(FORGEJO_PR_VIEW_JSON)));

      const forgejo = yield* ForgejoCli.ForgejoCli;
      yield* forgejo.mergePullRequest({
        cwd: "/repo",
        context,
        reference: "41",
        strategy: "squash",
      });

      expect(mockedRun).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          args: ["pr", "view", "41", "--json", ...TARGET_ARGS],
        }),
      );
    }),
  );

  it.effect("reads the default branch off `repo view`, which takes a positional repository", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput(FORGEJO_REPO_VIEW_OUTPUT)));

      const forgejo = yield* ForgejoCli.ForgejoCli;
      const branch = yield* forgejo.getDefaultBranch({ cwd: "/repo", context });

      assert.strictEqual(branch, "main");
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ["repo", "view", "octocat/widgets", "--hostname", "forgejo.example.test"],
        }),
      );
    }),
  );

  it.effect("reports no default branch rather than failing when fgj omits it", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("Repository: octocat/widgets\n")));

      const forgejo = yield* ForgejoCli.ForgejoCli;
      assert.strictEqual(yield* forgejo.getDefaultBranch({ cwd: "/repo", context }), null);
    }),
  );

  it.effect("reads both clone URLs off `repo view`", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput(FORGEJO_REPO_VIEW_OUTPUT)));

      const forgejo = yield* ForgejoCli.ForgejoCli;
      const urls = yield* forgejo.getRepositoryCloneUrls({
        cwd: "/repo",
        context,
        repository: "octocat/widgets",
      });

      assert.deepStrictEqual(urls, {
        nameWithOwner: "octocat/widgets",
        url: "https://forgejo.example.test/octocat/widgets.git",
        sshUrl: "ssh://git@forgejo.example.test/octocat/widgets.git",
      });
    }),
  );

  it.effect("names the clone URL it could not find", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            "Repository: octocat/widgets\nClone URL (HTTPS): https://forgejo.example.test/octocat/widgets.git\n",
          ),
        ),
      );

      const forgejo = yield* ForgejoCli.ForgejoCli;
      const error = yield* forgejo
        .getRepositoryCloneUrls({ cwd: "/repo", context, repository: "octocat/widgets" })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "ForgejoRepositoryDecodeError");
      assert.strictEqual(error.detail.includes("an SSH clone URL"), true);
    }),
  );

  it.effect("checks a change request out through refs/pull/<n>/head", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput(FORGEJO_PR_VIEW_JSON)));
      mockedListLocalBranchNames.mockReturnValueOnce(Effect.succeed([]));
      mockedFetchPullRequestBranch.mockReturnValue(Effect.void);
      mockedSwitchRef.mockReturnValue(Effect.succeed({ refName: "board/ma-3" }) as never);

      const forgejo = yield* ForgejoCli.ForgejoCli;
      yield* forgejo.checkoutPullRequest({ cwd: "/repo", context, reference: "41" });

      expect(mockedFetchPullRequestBranch).toHaveBeenCalledWith({
        cwd: "/repo",
        prNumber: 41,
        branch: "board/ma-3",
      });
      expect(mockedSwitchRef).toHaveBeenCalledWith({ cwd: "/repo", refName: "board/ma-3" });
    }),
  );

  it.effect("leaves an existing local branch alone unless the caller forces it", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput(FORGEJO_PR_VIEW_JSON)));
      mockedListLocalBranchNames.mockReturnValueOnce(Effect.succeed(["board/ma-3"]));
      mockedSwitchRef.mockReturnValue(Effect.succeed({ refName: "board/ma-3" }) as never);

      const forgejo = yield* ForgejoCli.ForgejoCli;
      yield* forgejo.checkoutPullRequest({ cwd: "/repo", context, reference: "41" });

      expect(mockedFetchPullRequestBranch).not.toHaveBeenCalled();
      expect(mockedSwitchRef).toHaveBeenCalledWith({ cwd: "/repo", refName: "board/ma-3" });
    }),
  );

  it.effect("refetches over an existing local branch when forced", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput(FORGEJO_PR_VIEW_JSON)));
      mockedListLocalBranchNames.mockReturnValueOnce(Effect.succeed(["board/ma-3"]));
      mockedFetchPullRequestBranch.mockReturnValue(Effect.void);
      mockedSwitchRef.mockReturnValue(Effect.succeed({ refName: "board/ma-3" }) as never);

      const forgejo = yield* ForgejoCli.ForgejoCli;
      yield* forgejo.checkoutPullRequest({
        cwd: "/repo",
        context,
        reference: "41",
        force: true,
      });

      expect(mockedFetchPullRequestBranch).toHaveBeenCalledOnce();
    }),
  );
});

it("namespaces a fork's branch so two forks cannot collide", () => {
  assert.strictEqual(
    ForgejoCli.forgejoCheckoutBranchName({
      number: 7,
      headRefName: "patch-1",
      isCrossRepository: true,
    }),
    "t3code/pr-7/patch-1",
  );
  assert.strictEqual(
    ForgejoCli.forgejoCheckoutBranchName({
      number: 7,
      headRefName: "patch-1",
      isCrossRepository: false,
    }),
    "patch-1",
  );
});
