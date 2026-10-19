import { describe, expect, it } from "vitest";
import * as Result from "effect/Result";

import {
  buildPullRequestSummariesGraphQlQuery,
  decodePullRequestCoreJson,
  PULL_REQUEST_CORE_GRAPHQL_QUERY,
} from "./gitHubPullRequestJson.ts";
import { coreQueryForFields, fillDroppedCoreFields } from "./t3oGraphQlScopeFallback.ts";

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
  it("drops the check rollup from every pull request in a batched summary read", () => {
    const batch = buildPullRequestSummariesGraphQlQuery(
      [
        { repository: "acme/web", number: 7 },
        { repository: "acme/api", number: 8 },
      ],
      true,
    );
    if (batch === null) throw new Error("expected a batched document");
    const query = coreQueryForFields(batch, "");
    expect(query).not.toContain("commits(");
    expect(query).not.toContain("statusCheckRollup");
    expect(query.match(/latestReviews/g)).toHaveLength(2);
    expect(query.match(/stackEntry/g)).toHaveLength(2);
    expect(balanced(query)).toBe(true);
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
