import { describe, expect, it } from "vite-plus/test";
import * as Result from "effect/Result";

import * as Effect from "effect/Effect";

import { GitHubApiResponseError } from "./GitHubApi.ts";
import { decodePullRequestCoreJson, pullRequestCoreGraphQlQuery } from "./gitHubPullRequestJson.ts";
import {
  coreQueryForFields,
  fillDroppedCoreFields,
  isMissingScopeRefusal,
  readCoreWithScopeFallback,
} from "./t3oGraphQlScopeFallback.ts";

const PULL_REQUEST_CORE_GRAPHQL_QUERY = pullRequestCoreGraphQlQuery("github.com");

const balanced = (query: string) => {
  let depth = 0;
  for (const char of query) {
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
};

const pullRequest = {
  number: 7,
  title: "Conflicted",
  url: "https://github.com/acme/web/pull/7",
  headRefName: "feature",
  baseRefName: "main",
  headRefOid: "abc123",
  state: "OPEN",
  mergeable: "CONFLICTING",
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-02T00:00:00Z",
  viewerCanUpdate: true,
  viewerDidAuthor: false,
  viewerCanUpdateBranch: true,
  baseRef: null,
  labels: { nodes: [] },
};
const response = (fields: Record<string, unknown>) =>
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  JSON.stringify({
    data: {
      repository: {
        mergeCommitAllowed: true,
        squashMergeAllowed: true,
        rebaseMergeAllowed: true,
        viewerPermission: "WRITE",
        pullRequest: { ...pullRequest, ...fields },
      },
    },
  });

describe("coreQueryForFields", () => {
  it("leaves the document whole while every gated field is still asked for", () => {
    expect(
      coreQueryForFields(PULL_REQUEST_CORE_GRAPHQL_QUERY, "reviewRequests,statusCheckRollup"),
    ).toBe(PULL_REQUEST_CORE_GRAPHQL_QUERY);
  });

  it("drops team review requests and keeps everything else", () => {
    const query = coreQueryForFields(PULL_REQUEST_CORE_GRAPHQL_QUERY, "statusCheckRollup");
    expect(query).not.toContain("reviewRequests");
    expect(query).not.toContain("requestedReviewer");
    expect(query).toContain("statusCheckRollup");
    expect(query).toContain("labels(first: 100)");
    expect(query).toContain("mergeable");
    expect(balanced(query)).toBe(true);
  });

  it("drops the check rollup with the commits connection that carries it", () => {
    const query = coreQueryForFields(PULL_REQUEST_CORE_GRAPHQL_QUERY, "");
    expect(query).not.toContain("reviewRequests");
    expect(query).not.toContain("commits(");
    expect(query).not.toContain("statusCheckRollup");
    expect(query).toContain("autoMergeRequest");
    expect(balanced(query)).toBe(true);
  });
  it("keeps the names either side of an inline selection apart", () => {
    expect(coreQueryForFields("{ x { a commits(last: 1) { n } b } }", "")).toBe("{ x { a b } }");
    expect(coreQueryForFields("{ x {\n  a\n  commits(last: 1) { n }\n  b\n} }", "")).toBe(
      "{ x {\n  a\n  b\n} }",
    );
  });
});

describe("fillDroppedCoreFields", () => {
  it("lets the core decoder read an answer without the dropped fields", () => {
    const raw = response({});
    expect(Result.isFailure(decodePullRequestCoreJson(raw))).toBe(true);

    const decoded = decodePullRequestCoreJson(fillDroppedCoreFields(raw, ""));
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.mergeability).toBe("conflicting");
      expect(decoded.success.reviewRequestLogins).toEqual([]);
      expect(decoded.success.checks).toEqual([]);
    }
  });

  it("leaves an answer alone when nothing was dropped", () => {
    const raw = response({ reviewRequests: { nodes: [] }, commits: { nodes: [] } });
    expect(fillDroppedCoreFields(raw, "reviewRequests,statusCheckRollup")).toBe(raw);
  });

  it("leaves an unreadable answer for the decoder to reject", () => {
    expect(fillDroppedCoreFields("not json", "")).toBe("not json");
  });
});

describe("readCoreWithScopeFallback (T3O-8)", () => {
  const refused = new GitHubApiResponseError({
    host: "github.com",
    operation: "getPullRequestDetail",
    status: 200,
    githubErrors: [
      "Your token has not been granted the required scopes to execute this query. The 'requestedReviewer' field requires one of the following scopes: ['read:org'].",
    ],
  });

  it("recognises GitHub refusing the token a field", () => {
    expect(isMissingScopeRefusal(refused)).toBe(true);
    expect(
      isMissingScopeRefusal(
        new GitHubApiResponseError({
          host: "github.com",
          operation: "getPullRequestDetail",
          status: 200,
          githubErrors: ["Resource not accessible by personal access token"],
        }),
      ),
    ).toBe(true);
    expect(
      isMissingScopeRefusal(
        new GitHubApiResponseError({ host: "github.com", operation: "x", status: 502 }),
      ),
    ).toBe(false);
  });

  it("gives up reviewers first, then checks, and marks unread checks", () => {
    const asked: Array<string> = [];
    const read = (fields: string) =>
      Effect.suspend(() => {
        asked.push(fields);
        return fields.includes("reviewRequests") || fields.includes("statusCheckRollup")
          ? Effect.fail(refused)
          : Effect.succeed({ mergeability: "mergeable" });
      });
    const core = Effect.runSync(readCoreWithScopeFallback(read));
    expect(asked).toEqual(["reviewRequests,statusCheckRollup", "statusCheckRollup", ""]);
    expect(core).toEqual({ mergeability: "mergeable", checksUnread: true });
  });

  it("keeps the checks when only reviewers were refused", () => {
    const read = (fields: string) =>
      fields.includes("reviewRequests")
        ? Effect.fail(refused)
        : Effect.succeed({ mergeability: "mergeable" });
    expect(Effect.runSync(readCoreWithScopeFallback(read))).toEqual({ mergeability: "mergeable" });
  });

  it("does not retry any other failure", () => {
    let attempts = 0;
    const read = () =>
      Effect.suspend(() => {
        attempts += 1;
        return Effect.fail(
          new GitHubApiResponseError({ host: "github.com", operation: "x", status: 502 }),
        );
      });
    expect(Effect.runSync(Effect.flip(readCoreWithScopeFallback(read)))._tag).toBe(
      "GitHubApiResponseError",
    );
    expect(attempts).toBe(1);
  });
});
