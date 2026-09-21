/**
 * T3o: the three lines between the board and upstream's forge services.
 *
 * Everything either side of this file is covered elsewhere — the reactor
 * forwards `force` (`cardPullRequest.test.ts`), `branchPullRequest` really does
 * refresh (`GitManager.test.ts`), `runAction` really does merge
 * (`PullRequestService.test.ts`) — and the wiring between them is a handful of
 * lines a refactor could drop while every neighbouring test stayed green.
 *
 * Three things have to hold, and none of them are visible from either side:
 *
 *  1. "Check again" reaches the forge rather than the lookup cache (T3O-48).
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
import { PullRequestOperationError } from "@t3tools/contracts";

import * as BoardPullRequestGateway from "./BoardPullRequestGateway.ts";
import * as GitManager from "../git/GitManager.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";

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
  } = {},
) {
  const calls: string[] = [];
  const layer = BoardPullRequestGateway.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(GitManager.GitManager)({
          branchPullRequest: (input, opts) =>
            Effect.sync(() => {
              calls.push(
                `branchPullRequest:${input.cwd}:${input.branch}:refresh=${opts?.refresh === true}`,
              );
              return null;
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
              return options.runActionFails === true
                ? Effect.fail(
                    new PullRequestOperationError({
                      operation: "runAction",
                      detail: "GitHub would not merge it.",
                    }),
                  )
                : Effect.void;
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
  it.effect("asks the forge again when forced", () => {
    const { calls, layer } = makeGateway();
    return Effect.gen(function* () {
      const gateway = yield* BoardPullRequestGateway.BoardPullRequestGateway;
      const found = yield* gateway.find({ cwd: "/repo", branch: "board/t3o-47", force: true });

      assert.deepStrictEqual(calls, ["branchPullRequest:/repo:board/t3o-47:refresh=true"]);
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
        "branchPullRequest:/repo:board/t3o-47:refresh=false",
        "branchPullRequest:/repo:board/t3o-47:refresh=false",
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

  it.effect("carries the host's own refusal out", () => {
    const { layer } = makeGateway({ runActionFails: true });
    return Effect.gen(function* () {
      const gateway = yield* BoardPullRequestGateway.BoardPullRequestGateway;
      const error = yield* Effect.flip(
        gateway.merge({ projectId: PROJECT, number: 110, method: "squash" }),
      );

      assert.strictEqual(error.operation, "merge");
      assert.strictEqual(error.detail, "GitHub would not merge it.");
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
