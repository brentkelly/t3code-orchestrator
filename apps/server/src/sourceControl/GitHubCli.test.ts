import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcessExitError, VcsProcessSpawnError } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const mockRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();

const layer = GitHubCli.layer.pipe(
  Layer.provide(
    Layer.mock(VcsProcess.VcsProcess)({
      run: mockRun,
    }),
  ),
);

afterEach(() => {
  mockRun.mockReset();
});

describe("GitHubCli.layer", () => {
  it("does not classify a missing cwd as an unavailable gh executable", () => {
    const context = { command: "gh", cwd: "/repo" } as const;
    const missingCwd = new VcsProcessSpawnError({
      operation: "GitHubCli.execute",
      command: "gh",
      cwd: context.cwd,
      cause: PlatformError.systemError({
        _tag: "NotFound",
        module: "FileSystem",
        method: "access",
        pathOrDescriptor: context.cwd,
      }),
    });

    const commandFailure = GitHubCli.fromVcsError(context, missingCwd);

    assert.equal(commandFailure._tag, "GitHubCliCommandError");
    assert.strictEqual(commandFailure.cause, missingCwd);
    assert.notProperty(commandFailure, "operation");
  });

  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              number: 42,
              title: "Add PR thread creation",
              url: "https://github.com/pingdotgg/codething-mvp/pull/42",
              baseRefName: "main",
              headRefName: "feature/pr-threads",
              state: "OPEN",
              mergedAt: null,
              isCrossRepository: true,
              headRepository: {
                nameWithOwner: "octocat/codething-mvp",
              },
              headRepositoryOwner: {
                login: "octocat",
              },
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add PR thread creation",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/codething-mvp",
        headRepositoryOwnerLogin: "octocat",
      });
      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: [
          "pr",
          "view",
          "#42",
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("trims pull request fields decoded from gh json", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              number: 42,
              title: "  Add PR thread creation  \n",
              url: " https://github.com/pingdotgg/codething-mvp/pull/42 ",
              baseRefName: " main ",
              headRefName: "\tfeature/pr-threads\t",
              state: "OPEN",
              mergedAt: null,
              isCrossRepository: true,
              headRepository: {
                nameWithOwner: " octocat/codething-mvp ",
              },
              headRepositoryOwner: {
                login: " octocat ",
              },
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add PR thread creation",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/codething-mvp",
        headRepositoryOwnerLogin: "octocat",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("skips invalid entries when parsing pr lists", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 0,
                title: "invalid",
                url: "https://github.com/pingdotgg/codething-mvp/pull/0",
                baseRefName: "main",
                headRefName: "feature/invalid",
              },
              {
                number: 43,
                title: "  Valid PR  ",
                url: " https://github.com/pingdotgg/codething-mvp/pull/43 ",
                baseRefName: " main ",
                headRefName: " feature/pr-list ",
                headRepository: {
                  nameWithOwner: "   ",
                },
                headRepositoryOwner: {
                  login: "   ",
                },
              },
            ]),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.listOpenPullRequests({
        cwd: "/repo",
        headSelector: "feature/pr-list",
      });

      assert.deepStrictEqual(result, [
        {
          number: 43,
          title: "Valid PR",
          url: "https://github.com/pingdotgg/codething-mvp/pull/43",
          baseRefName: "main",
          headRefName: "feature/pr-list",
          state: "open",
        },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps pull requests from gh versions without headRepository.nameWithOwner", () =>
    // gh < 2.47 (e.g. Ubuntu-packaged 2.46) exports headRepository as
    // {id, name} only. These entries must decode instead of being dropped,
    // with nameWithOwner rebuilt from the owner login.
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 2829,
                title: "Codex turn mapping",
                url: "https://github.com/pingdotgg/codething-mvp/pull/2829",
                baseRefName: "main",
                headRefName: "t3code/codex-turn-mapping",
                state: "OPEN",
                mergedAt: null,
                isCrossRepository: false,
                headRepository: {
                  id: "R_kgDORLtfbQ",
                  name: "codething-mvp",
                },
                headRepositoryOwner: {
                  id: "MDEyOk9yZ2FuaXphdGlvbjg5MTkxNzI3",
                  login: "pingdotgg",
                },
              },
            ]),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.listOpenPullRequests({
        cwd: "/repo",
        headSelector: "t3code/codex-turn-mapping",
      });

      assert.deepStrictEqual(result, [
        {
          number: 2829,
          title: "Codex turn mapping",
          url: "https://github.com/pingdotgg/codething-mvp/pull/2829",
          baseRefName: "main",
          headRefName: "t3code/codex-turn-mapping",
          state: "open",
          isCrossRepository: false,
          headRepositoryNameWithOwner: "pingdotgg/codething-mvp",
          headRepositoryOwnerLogin: "pingdotgg",
        },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              nameWithOwner: "octocat/codething-mvp",
              url: "https://github.com/octocat/codething-mvp",
              sshUrl: "git@github.com:octocat/codething-mvp.git",
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates repositories and parses clone URLs from create output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            "✓ Created repository octocat/codething-mvp on github.com\nhttps://github.com/octocat/codething-mvp\n",
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.createRepository({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
        visibility: "private",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
      expect(mockRun).toHaveBeenCalledTimes(1);
      expect(mockRun).toHaveBeenNthCalledWith(1, {
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["repo", "create", "octocat/codething-mvp", "--private"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("falls back to constructed URLs when create output omits a URL", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.createRepository({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
        visibility: "private",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("surfaces a friendly error when the pull request is not found", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitHubCli.execute",
        command: "gh pr view",
        cwd: "/repo",
        exitCode: 1,
        failureKind: "not-found",
        detail:
          "GraphQL: Could not resolve to a PullRequest with the number of 4888. (repository.pullRequest)",
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .getPullRequest({
          cwd: "/repo",
          reference: "4888",
        })
        .pipe(Effect.flip);

      assert.equal(error.message.includes("Pull request not found"), true);
      assert.strictEqual(error._tag, "GitHubPullRequestNotFoundError");
      assert.strictEqual(error.command, "gh");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message.includes(cause.detail), false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("surfaces an actionable rate-limit error without exposing provider stderr", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitHubCli.execute",
        command: "gh",
        cwd: "/repo",
        exitCode: 1,
        failureKind: "rate-limited",
        detail: "API rate limit exceeded.",
        stderrLength: 82,
        stderrTruncated: false,
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .listOpenPullRequests({
          cwd: "/repo",
          headSelector: "feature/rate-limited",
        })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitHubCliRateLimitError");
      assert.include(error.detail, "GitHub API rate limit exceeded");
      assert.include(error.detail, "gh api rate_limit");
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, "user ID");
    }).pipe(Effect.provide(layer)),
  );
});

describe("GitHubCli.mergePullRequest", () => {
  it.effect("surfaces the forge's own refusal text", () =>
    Effect.gen(function* () {
      // The failure this closes: `VcsProcessExitError` deliberately redacts
      // stderr, so routing the merge through the ordinary error path gave the
      // board a constant string ("GitHub CLI command failed.") instead of
      // GitHub's explanation. That silently disabled conflict detection — the
      // classifier can only ever see this text — and showed the user a message
      // that says nothing. So the merge reads the refusal as OUTPUT.
      mockRun.mockReturnValueOnce(
        Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(1),
          stdout: "",
          stderr: "X Pull request is not mergeable: the merge commit cannot be cleanly created\n",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      );

      const github = yield* GitHubCli.GitHubCli;
      const error = yield* Effect.flip(
        github.mergePullRequest({ cwd: "/repo", reference: "284", strategy: "squash" }),
      );

      assert.equal(error._tag, "GitHubPullRequestMergeRefusedError");
      assert.include(error.detail, "cannot be cleanly created");
      // `--squash` is always passed: `gh pr merge` with no strategy prompts
      // interactively, which would hang the server.
      const call = mockRun.mock.calls[0]?.[0];
      assert.deepStrictEqual(call?.args, ["pr", "merge", "284", "--squash"]);
      // Non-zero has to come back as a RESULT, or the stderr never survives.
      assert.strictEqual(call?.allowNonZeroExit, true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("strips credentials out of the refusal before it reaches a card", () =>
    Effect.gen(function* () {
      // The refusal lands on the card's activity rail and in a durable event
      // log, so it goes through the free-text scrubber rather than being
      // passed along raw. A credential inside a SENTENCE is the case that
      // matters — a URL-parsing sanitizer lets that straight through — so the
      // fixture wraps it in one.
      mockRun.mockReturnValueOnce(
        Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(1),
          stdout: "",
          stderr: "X Pull request is not mergeable: https://user:hunter2@github.com/acme/repo.git",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      );

      const github = yield* GitHubCli.GitHubCli;
      const error = yield* Effect.flip(
        github.mergePullRequest({ cwd: "/repo", reference: "284", strategy: "squash" }),
      );
      assert.notInclude(error.detail, "hunter2");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("succeeds silently on a clean merge", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));
      const github = yield* GitHubCli.GitHubCli;
      yield* github.mergePullRequest({ cwd: "/repo", reference: "284", strategy: "merge" });
      assert.deepStrictEqual(mockRun.mock.calls[0]?.[0]?.args, ["pr", "merge", "284", "--merge"]);
    }).pipe(Effect.provide(layer)),
  );
});

// T3o (T3O-48): `gh` resolves the base repository itself when no repository is
// named, and its rule PREFERS a remote called `upstream` — so in a fork every
// unpinned call asks the wrong repository and truthfully answers "no pull
// request". These pin the flag onto every invocation that takes one.
describe("GitHubCli repository pinning", () => {
  const repository = { host: "github.com", nameWithOwner: "brentkelly/t3code-orchestrator" };
  const args = () => mockRun.mock.calls[0]?.[0]?.args ?? [];

  it.effect("names the repository on a pull request lookup", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("[]")));
      const github = yield* GitHubCli.GitHubCli;
      yield* github.listOpenPullRequests({
        cwd: "/repo",
        repository,
        headSelector: "board/t3o-46",
      });
      assert.deepStrictEqual(args().slice(0, 4), [
        "pr",
        "list",
        "--repo",
        "github.com/brentkelly/t3code-orchestrator",
      ]);
      assert.include(args(), "board/t3o-46");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("names the repository when viewing one pull request", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              number: 110,
              title: "Upgrade",
              url: "https://github.com/brentkelly/t3code-orchestrator/pull/110",
              baseRefName: "t3o",
              headRefName: "board/t3o-46",
              state: "OPEN",
            }),
          ),
        ),
      );
      const github = yield* GitHubCli.GitHubCli;
      yield* github.getPullRequest({ cwd: "/repo", repository, reference: "110" });
      assert.deepStrictEqual(args().slice(0, 5), [
        "pr",
        "view",
        "110",
        "--repo",
        "github.com/brentkelly/t3code-orchestrator",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("names the repository when opening a pull request", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));
      const github = yield* GitHubCli.GitHubCli;
      yield* github.createPullRequest({
        cwd: "/repo",
        repository,
        baseBranch: "t3o",
        headSelector: "board/t3o-46",
        title: "Upgrade",
        bodyFile: "/tmp/body.md",
      });
      assert.deepStrictEqual(args().slice(0, 4), [
        "pr",
        "create",
        "--repo",
        "github.com/brentkelly/t3code-orchestrator",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("names the repository when checking a pull request out", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));
      const github = yield* GitHubCli.GitHubCli;
      yield* github.checkoutPullRequest({
        cwd: "/repo",
        repository,
        reference: "110",
        force: true,
      });
      assert.deepStrictEqual(args(), [
        "pr",
        "checkout",
        "110",
        "--repo",
        "github.com/brentkelly/t3code-orchestrator",
        "--force",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("names the repository on a merge, so a fork never merges upstream's PR", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));
      const github = yield* GitHubCli.GitHubCli;
      yield* github.mergePullRequest({
        cwd: "/repo",
        repository,
        reference: "108",
        strategy: "squash",
      });
      assert.deepStrictEqual(args(), [
        "pr",
        "merge",
        "108",
        "--repo",
        "github.com/brentkelly/t3code-orchestrator",
        "--squash",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("names the repository on the merge-state probe", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));
      const github = yield* GitHubCli.GitHubCli;
      yield* github.pullRequestMergeState({ cwd: "/repo", repository, reference: "110" });
      assert.deepStrictEqual(args().slice(0, 5), [
        "pr",
        "view",
        "110",
        "--repo",
        "github.com/brentkelly/t3code-orchestrator",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("names the repository POSITIONALLY on `repo view`, which has no --repo flag", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("t3o\n")));
      const github = yield* GitHubCli.GitHubCli;
      const branch = yield* github.getDefaultBranch({ cwd: "/repo", repository });
      assert.strictEqual(branch, "t3o");
      assert.deepStrictEqual(args(), [
        "repo",
        "view",
        "github.com/brentkelly/t3code-orchestrator",
        "--json",
        "defaultBranchRef",
        "--jq",
        ".defaultBranchRef.name",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("qualifies an enterprise host rather than colliding with github.com", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("[]")));
      const github = yield* GitHubCli.GitHubCli;
      yield* github.listOpenPullRequests({
        cwd: "/repo",
        repository: { host: "ghe.example.test", nameWithOwner: "octocat/widgets" },
        headSelector: "feature",
      });
      assert.include(args(), "ghe.example.test/octocat/widgets");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("leaves the arg vector untouched when no repository was resolved", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));
      const github = yield* GitHubCli.GitHubCli;
      yield* github.mergePullRequest({ cwd: "/repo", reference: "108", strategy: "squash" });
      assert.deepStrictEqual(args(), ["pr", "merge", "108", "--squash"]);
      assert.notInclude(args(), "--repo");
    }).pipe(Effect.provide(layer)),
  );
});
