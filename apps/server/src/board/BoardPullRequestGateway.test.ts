/**
 * T3o (T3O-48): the gateway's `force` contract.
 *
 * "Check again" only answers from the forge because `force` routes through
 * `invalidateStatus`, which bumps the checkout's PR-lookup epoch and so
 * bypasses both the TTL and the failure backoff. Its neighbours are covered —
 * the reactor forwards `force` (cardPullRequest.test.ts) and `invalidateStatus`
 * really does bypass the cache (GitManager.test.ts) — but the wiring between
 * them is three lines that a refactor could drop, silently returning the
 * cached answer this card exists to stop returning.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BoardPullRequestGateway from "./BoardPullRequestGateway.ts";
import * as GitManager from "../git/GitManager.ts";

/** A gateway over a GitManager that records the order of what it was asked. */
function makeGateway() {
  const calls: string[] = [];
  const layer = BoardPullRequestGateway.layer.pipe(
    Layer.provide(
      Layer.mock(GitManager.GitManager)({
        invalidateStatus: (cwd) =>
          Effect.sync(() => {
            calls.push(`invalidateStatus:${cwd}`);
          }),
        findBranchPullRequest: (input) =>
          Effect.sync(() => {
            calls.push(`findBranchPullRequest:${input.cwd}:${input.branch}`);
            return null;
          }),
      }),
    ),
  );
  return { calls, layer };
}

describe("BoardPullRequestGateway", () => {
  it.effect("invalidates the lookup cache before finding, when forced", () => {
    const { calls, layer } = makeGateway();

    return Effect.gen(function* () {
      const gateway = yield* BoardPullRequestGateway.BoardPullRequestGateway;
      const found = yield* gateway.find({ cwd: "/repo", branch: "board/t3o-48", force: true });

      assert.deepStrictEqual(calls, [
        "invalidateStatus:/repo",
        "findBranchPullRequest:/repo:board/t3o-48",
      ]);
      assert.equal(found, null);
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves the cache alone on an unforced lookup", () => {
    const { calls, layer } = makeGateway();

    return Effect.gen(function* () {
      const gateway = yield* BoardPullRequestGateway.BoardPullRequestGateway;
      yield* gateway.find({ cwd: "/repo", branch: "board/t3o-48" });
      yield* gateway.find({ cwd: "/repo", branch: "board/t3o-48", force: false });

      assert.deepStrictEqual(calls, [
        "findBranchPullRequest:/repo:board/t3o-48",
        "findBranchPullRequest:/repo:board/t3o-48",
      ]);
    }).pipe(Effect.provide(layer));
  });
});
