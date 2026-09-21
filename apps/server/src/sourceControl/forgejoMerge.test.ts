/**
 * The board's Forgejo merge seams (t3o-16, T3O-38), driven through a recording
 * `ForgejoCli` double: what reaches the REST API, and what the board is told
 * when the forge says no.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ForgejoCli from "./ForgejoCli.ts";
import { forgejoPullRequestNumber, makeForgejoMergeSeams } from "./forgejoMerge.ts";

type ApiInput = ForgejoCli.ForgejoApiInput;
type ApiAnswer = string | ForgejoCli.ForgejoCliError;

const ok = (stdout: string) => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "HTTP/1.1 200\n",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const refused = (httpStatus: number, body: string) =>
  new ForgejoCli.ForgejoCliError({
    command: "fj",
    cwd: "/repo",
    httpStatus,
    detail: `Forgejo API request failed (HTTP ${httpStatus}): ${body}`,
  });

/** Seams over a CLI double that answers each API call from `answer` and
    records what it was asked. */
const harness = (answer: (input: ApiInput) => ApiAnswer) => {
  const calls: Array<{ readonly method: string; readonly path: string; readonly body: unknown }> =
    [];
  const seams = makeForgejoMergeSeams({
    execute: () => Effect.die("the merge seams never shell out to a CLI subcommand"),
    resolveRepository: () =>
      Effect.succeed({
        command: "fj" as const,
        login: "codeberg.org",
        repository: "octo cat/widgets",
        baseUrl: "https://codeberg.org",
      }),
    api: (input) => {
      calls.push({ method: input.method ?? "GET", path: input.path, body: input.body });
      const result = answer(input);
      return typeof result === "string" ? Effect.succeed(ok(result)) : Effect.fail(result);
    },
  });
  return { seams, calls };
};

const PULL = "repos/octo%20cat/widgets/pulls/41";

describe("forgejoPullRequestNumber", () => {
  it("reads a bare number, a #number and the URLs a card can hold", () => {
    assert.strictEqual(forgejoPullRequestNumber("41"), "41");
    assert.strictEqual(forgejoPullRequestNumber(" #41 "), "41");
    assert.strictEqual(
      forgejoPullRequestNumber("https://codeberg.org/octocat/widgets/pulls/41"),
      "41",
    );
    assert.strictEqual(
      forgejoPullRequestNumber("https://codeberg.org/octocat/widgets/pulls/41/files?x=1#diff"),
      "41",
    );
    assert.strictEqual(forgejoPullRequestNumber("board/t3o-1"), null);
  });
});

describe("mergeChangeRequest", () => {
  it.effect("posts the strategy as Gitea's merge style, then confirms the merge landed", () =>
    Effect.gen(function* () {
      const { seams, calls } = harness((input) =>
        input.method === "POST" ? "" : JSON.stringify({ merged: true }),
      );

      yield* seams.mergeChangeRequest({ cwd: "/repo", reference: "41", strategy: "squash" });

      assert.deepStrictEqual(calls, [
        { method: "POST", path: `${PULL}/merge`, body: { Do: "squash" } },
        { method: "GET", path: PULL, body: undefined },
      ]);
    }),
  );

  it.effect("fails with the forge's own words when the forge refuses", () =>
    Effect.gen(function* () {
      const { seams, calls } = harness(() =>
        refused(405, JSON.stringify({ message: "Not all required status checks successful" })),
      );

      const error = yield* Effect.flip(
        seams.mergeChangeRequest({
          cwd: "/repo",
          reference: "https://codeberg.org/octocat/widgets/pulls/41",
          strategy: "merge",
        }),
      );

      assert.strictEqual(error.provider, "forgejo");
      assert.strictEqual(error.operation, "mergeChangeRequest");
      assert.strictEqual(error.detail, "Not all required status checks successful");
      // A refused merge is never re-read: there is nothing to confirm.
      assert.strictEqual(calls.length, 1);
    }),
  );

  it.effect("explains a refusal a tea-authenticated server reported as a bare status", () =>
    Effect.gen(function* () {
      // `ForgejoCli.api`'s tea branch has no response body to report, only the
      // status — the card must still read as a refusal, not as a malfunction.
      const { seams } = harness(
        () =>
          new ForgejoCli.ForgejoCliError({
            command: "tea",
            cwd: "/repo",
            httpStatus: 405,
            detail: "Forgejo API request failed (HTTP 405).",
          }),
      );

      const error = yield* Effect.flip(
        seams.mergeChangeRequest({ cwd: "/repo", reference: "41", strategy: "merge" }),
      );

      assert.include(error.detail, "refused to merge the pull request");
      assert.notInclude(error.detail, "HTTP 405");
    }),
  );

  it.effect("fails when the API accepted the merge but the pull request is still open", () =>
    Effect.gen(function* () {
      const { seams } = harness((input) =>
        input.method === "POST" ? "" : JSON.stringify({ merged: false, state: "open" }),
      );

      const error = yield* Effect.flip(
        seams.mergeChangeRequest({ cwd: "/repo", reference: "41", strategy: "rebase" }),
      );

      assert.include(error.detail, "did not merge pull request 41");
    }),
  );

  it.effect("refuses a reference that names no pull request without asking the forge", () =>
    Effect.gen(function* () {
      const { seams, calls } = harness(() => "");

      const error = yield* Effect.flip(
        seams.mergeChangeRequest({ cwd: "/repo", reference: "board/t3o-1", strategy: "squash" }),
      );

      assert.include(error.detail, "pull request number");
      assert.strictEqual(calls.length, 0);
    }),
  );
});

describe("changeRequestMergeState", () => {
  const pullRequest = JSON.stringify({
    mergeable: false,
    head: { ref: "board/t3o-1", sha: "abc/123" },
  });

  it.effect("reads the pull request, then the statuses of ITS head sha", () =>
    Effect.gen(function* () {
      const { seams, calls } = harness((input) =>
        input.path === PULL
          ? pullRequest
          : JSON.stringify({
              statuses: [
                { context: "build", status: "success" },
                { context: "e2e", status: "pending" },
              ],
            }),
      );

      const state = yield* seams.changeRequestMergeState({ cwd: "/repo", reference: "#41" });

      assert.deepStrictEqual(
        calls.map((call) => call.path),
        [PULL, "repos/octo%20cat/widgets/commits/abc%2F123/status"],
      );
      assert.deepStrictEqual(state, {
        mergeable: "blocked",
        blockedReason: null,
        headSha: "abc/123",
        checks: { total: 2, passed: 1, pending: 1, failed: 0, failing: [], running: ["e2e"] },
      });
    }),
  );

  it.effect("degrades to unknown — a retry — when the statuses cannot be read", () =>
    Effect.gen(function* () {
      const { seams } = harness((input) =>
        input.path === PULL ? pullRequest : refused(500, "upstream timeout"),
      );

      const state = yield* seams.changeRequestMergeState({ cwd: "/repo", reference: "41" });

      // "Not mergeable" with no check evidence is indistinguishable from "CI has
      // not finished", and claiming `blocked` there is a HARD stop.
      assert.strictEqual(state.mergeable, "unknown");
      assert.strictEqual(state.checks.total, 0);
    }),
  );

  it.effect("fails when the pull request itself cannot be read", () =>
    Effect.gen(function* () {
      const { seams } = harness(() => refused(404, ""));

      const error = yield* Effect.flip(
        seams.changeRequestMergeState({ cwd: "/repo", reference: "41" }),
      );

      assert.strictEqual(error.operation, "changeRequestMergeState");
    }),
  );
});
