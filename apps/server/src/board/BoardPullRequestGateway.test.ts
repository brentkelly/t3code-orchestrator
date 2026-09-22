/**
 * T3o: the three lines between the board and upstream's forge services.
 *
 * Everything either side of this file is covered elsewhere — the reactor
 * forwards `force` (`cardPullRequest.test.ts`), an invalidated checkout really
 * does re-ask the forge (`GitManager.test.ts`), `runAction` really does merge
 * (`PullRequestService.test.ts`) — and the wiring between them is a handful of
 * lines a refactor could drop while every neighbouring test stayed green.
 *
 * Three things have to hold, and none of them are visible from either side:
 *
 *  1. "Check again" reaches the forge rather than the lookup cache — including
 *     a cached lookup FAILURE, whose backoff only the epoch bump clears
 *     (T3O-48).
 *  2. A pull request is addressed by the project's own repository, resolved
 *     from the read model the way `PullRequestService` resolves its own — a
 *     mismatch here is refused by the service as "not this project's".
 *  3. The refusal probe reads the state AFTER the refused merge, not the one
 *     the detail cache was already holding (T3O-47).
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type {
  OrchestrationProjectShell,
  ProjectId,
  PullRequestDetail,
  PullRequestInvalidateInput,
  PullRequestRef,
} from "@t3tools/contracts";
import { PullRequestOperationError, PullRequestUnavailableError } from "@t3tools/contracts";

import * as BoardPullRequestGateway from "./BoardPullRequestGateway.ts";
import * as GitManager from "../git/GitManager.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PullRequestProviderError } from "../pullRequest/PullRequestProvider.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";

/** How upstream reports a host that was asked and said no: the placeholder
    `VcsProcessExitError` leaves behind once the subprocess's stderr is
    dropped, wrapped with the provider error as its cause. */
function hostRefusal(reason: PullRequestProviderError["reason"] = "failed") {
  return new PullRequestOperationError({
    operation: "runAction",
    detail: "Process exited with a non-zero status.",
    cause: new PullRequestProviderError({
      provider: "github",
      operation: "runAction",
      reason,
      detail: "Process exited with a non-zero status.",
    }),
  });
}

const PROJECT = "project-1" as ProjectId;

function project(repository: string | null): OrchestrationProjectShell {
  return {
    id: PROJECT,
    title: "T3o",
    workspaceRoot: "/repo",
    ...(repository === null
      ? {}
      : {
          repositoryIdentity: {
            canonicalKey: `github.com/${repository}`,
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: `https://github.com/${repository}.git`,
            },
            provider: "github",
            displayName: repository,
          },
        }),
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
  };
}

function detail(overrides: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return {
    provider: "github",
    capabilities: {} as PullRequestDetail["capabilities"],
    viewerPermissions: {} as PullRequestDetail["viewerPermissions"],
    projectId: PROJECT,
    projectTitle: "T3o",
    workspaceRoot: "/repo",
    repository: "brentkelly/t3code-orchestrator",
    number: 110,
    title: "A change",
    body: "",
    url: "https://github.com/brentkelly/t3code-orchestrator/pull/110",
    author: null,
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    headBranch: "board/t3o-47",
    baseBranch: "t3o",
    createdAt: "2026-09-21T00:00:00Z",
    updatedAt: "2026-09-21T00:00:00Z",
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    labels: [],
    checks: [],
    mergeCapabilities: { merge: true, squash: true, rebase: true },
    baseComparison: "up-to-date",
    ...overrides,
  };
}

/** A gateway over recording stubs of the two services it delegates to. */
function makeGateway(
  options: {
    readonly repository?: string | null;
    readonly detail?: PullRequestDetail;
    readonly runActionFails?: boolean;
    readonly runActionError?: unknown;
  } = {},
) {
  const calls: string[] = [];
  const layer = BoardPullRequestGateway.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(GitManager.GitManager)({
          branchPullRequest: (input) =>
            Effect.sync(() => {
              calls.push(`branchPullRequest:${input.cwd}:${input.branch}`);
              return null;
            }),
          invalidateStatus: (cwd) =>
            Effect.sync(() => {
              calls.push(`invalidateStatus:${cwd}`);
            }),
        }),
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getProjectShellById: (projectId) =>
            Effect.succeed(
              projectId === PROJECT
                ? Option.some(
                    project(
                      options.repository === undefined
                        ? "brentkelly/t3code-orchestrator"
                        : options.repository,
                    ),
                  )
                : Option.none(),
            ),
        }),
        Layer.mock(PullRequestService.PullRequestService)({
          runAction: (input) =>
            Effect.suspend(() => {
              calls.push(
                `runAction:${input.repository}:${input.number}:${input.action}:${input.mergeMethod}`,
              );
              if (options.runActionError !== undefined) {
                return Effect.fail(options.runActionError as PullRequestOperationError);
              }
              return options.runActionFails === true ? Effect.fail(hostRefusal()) : Effect.void;
            }),
          invalidate: (input: PullRequestInvalidateInput) =>
            Effect.sync(() => {
              calls.push(`invalidate:${input.reference?.repository}:${input.reference?.number}`);
            }),
          detail: (input: PullRequestRef) =>
            Effect.sync(() => {
              calls.push(
                `detail:${input.repository}:${input.number}:allowStale=${input.allowStale}`,
              );
              return options.detail ?? detail();
            }),
        }),
      ),
    ),
  );
  return { calls, layer };
}

describe("BoardPullRequestGateway.find", () => {
  it.effect("invalidates this checkout before a forced lookup", () => {
    const { calls, layer } = makeGateway();
    return Effect.gen(function* () {
      const gateway = yield* BoardPullRequestGateway.BoardPullRequestGateway;
      const found = yield* gateway.find({ cwd: "/repo", branch: "board/t3o-47", force: true });

      // The epoch bump has to come FIRST, and it has to be the bump rather
      // than `{ refresh: true }`: refresh clears a cached ANSWER, while the
      // case "Check again" exists for is a cached FAILURE, which upstream
      // deliberately holds for its backoff
      // (`GitManager.test.ts`, "branch PR lookup propagates provider
      // failures"). Only the epoch, which is part of the cache key, gets past
      // both.
      assert.deepStrictEqual(calls, [
        "invalidateStatus:/repo",
        "branchPullRequest:/repo:board/t3o-47",
      ]);
      assert.equal(found, null);
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves the cache alone on an unforced lookup", () => {
    const { calls, layer } = makeGateway();
    return Effect.gen(function* () {
      const gateway = yield* BoardPullRequestGateway.BoardPullRequestGateway;
      yield* gateway.find({ cwd: "/repo", branch: "board/t3o-47" });
      yield* gateway.find({ cwd: "/repo", branch: "board/t3o-47", force: false });

      assert.deepStrictEqual(calls, [
        "branchPullRequest:/repo:board/t3o-47",
        "branchPullRequest:/repo:board/t3o-47",
      ]);
    }).pipe(Effect.provide(layer));
  });
});

describe("BoardPullRequestGateway.merge", () => {
  it.effect("addresses the project's own repository and asks for the chosen method", () => {
    const { calls, layer } = makeGateway();
    return Effect.gen(function* () {
      const gateway = yield* BoardPullRequestGateway.BoardPullRequestGateway;
      yield* gateway.merge({ projectId: PROJECT, number: 110, method: "squash" });

      assert.deepStrictEqual(calls, ["runAction:brentkelly/t3code-orchestrator:110:merge:squash"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("carries the host's own refusal out, marked as the host's", () => {
    const { layer } = makeGateway({ runActionFails: true });
    return Effect.gen(function* () {
      const gateway = yield* BoardPullRequestGateway.BoardPullRequestGateway;
      const error = yield* Effect.flip(
        gateway.merge({ projectId: PROJECT, number: 110, method: "squash" }),
      );

      assert.strictEqual(error.operation, "merge");
      assert.strictEqual(error.detail, "Process exited with a non-zero status.");
      // The one refusal a merge-state probe can explain, and the only one
      // whose `detail` is worth nothing on its own.
      assert.strictEqual(error.refusal, "host");
    }).pipe(Effect.provide(layer));
  });

  // The whole point of `refusal`: upstream refuses several things itself,
  // BEFORE the host is asked, and each carries a sentence naming the fix. A
  // caller that cannot tell those from the host's own "no" throws those
  // sentences away and asks the pull request why it was refused — and the pull
  // request, never having been the problem, answers that it is perfectly
  // mergeable.
  it.effect("marks a refusal upstream made itself as blocked, not the host's", () => {
    const { layer } = makeGateway({
      // What `runAction` fails with when the configured strategy is not in
      // `mergeCapabilities.mergeMethods` — a squash-disabled repository, say.
      runActionError: new PullRequestOperationError({
        operation: "runAction",
        detail: "This host cannot merge with the squash strategy.",
      }),
    });
    return Effect.gen(function* () {
      const gateway = yield* BoardPullRequestGateway.BoardPullRequestGateway;
      const error = yield* Effect.flip(
        gateway.merge({ projectId: PROJECT, number: 110, method: "squash" }),
      );

      assert.strictEqual(error.refusal, "blocked");
      assert.strictEqual(error.detail, "This host cannot merge with the squash strategy.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("marks a rate-limited attempt as unavailable, not as the host's answer", () => {
    const { layer } = makeGateway({ runActionError: hostRefusal("rate-limited") });
    return Effect.gen(function* () {
      const gateway = yield* BoardPullRequestGateway.BoardPullRequestGateway;
      const error = yield* Effect.flip(
        gateway.merge({ projectId: PROJECT, number: 110, method: "squash" }),
      );

      // The backoff stopped the request; the host never weighed the merge.
      assert.strictEqual(error.refusal, "unavailable");
    }).pipe(Effect.provide(layer));
  });

  it.effect("marks a host that cannot be reached at all as unavailable", () => {
    const { layer } = makeGateway({
      runActionError: new PullRequestUnavailableError({
        reason: "cli-unauthenticated",
        provider: "github",
      }),
    });
    return Effect.gen(function* () {
      const gateway = yield* BoardPullRequestGateway.BoardPullRequestGateway;
      const error = yield* Effect.flip(
        gateway.merge({ projectId: PROJECT, number: 110, method: "squash" }),
      );

      assert.strictEqual(error.refusal, "unavailable");
      assert.match(error.detail, /not authenticated/iu);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a project with no recognised remote rather than guessing one", () => {
    const { calls, layer } = makeGateway({ repository: null });
    return Effect.gen(function* () {
      const gateway = yield* BoardPullRequestGateway.BoardPullRequestGateway;
      const error = yield* Effect.flip(
        gateway.merge({ projectId: PROJECT, number: 110, method: "squash" }),
      );

      assert.strictEqual(error.operation, "merge");
      assert.match(error.detail, /source-control remote/u);
      // A project with no remote is not something a retry fixes.
      assert.strictEqual(error.refusal, "blocked");
      // Nothing was sent: an unaddressable pull request must not reach a host.
      assert.deepStrictEqual(calls, []);
    }).pipe(Effect.provide(layer));
  });
});

describe("BoardPullRequestGateway.mergeState", () => {
  it.effect("reads the state after the refusal, not the one already cached", () => {
    const { calls, layer } = makeGateway();
    return Effect.gen(function* () {
      const gateway = yield* BoardPullRequestGateway.BoardPullRequestGateway;
      yield* gateway.mergeState({ projectId: PROJECT, number: 110 });

      // The invalidation has to come FIRST, and the read has to refuse a held
      // answer: either one alone can still serve the state from before the
      // merge was attempted.
      assert.deepStrictEqual(calls, [
        "invalidate:brentkelly/t3code-orchestrator:110",
        "detail:brentkelly/t3code-orchestrator:110:allowStale=false",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps the host's detail into the board's merge state", () => {
    const { layer } = makeGateway({
      detail: detail({
        mergeability: "conflicting",
        headSha: "abc123",
        checks: [
          { name: "ci/build", status: "failure", description: null, url: null },
          { name: "ci/lint", status: "success", description: null, url: null },
        ],
      }),
    });
    return Effect.gen(function* () {
      const gateway = yield* BoardPullRequestGateway.BoardPullRequestGateway;
      const state = yield* gateway.mergeState({ projectId: PROJECT, number: 110 });

      assert.strictEqual(state.mergeable, "blocked");
      assert.strictEqual(state.blockedReason, "conflict");
      assert.strictEqual(state.headSha, "abc123");
      assert.deepStrictEqual(state.checks.failing, ["ci/build"]);
    }).pipe(Effect.provide(layer));
  });
});
