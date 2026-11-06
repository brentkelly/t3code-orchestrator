import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { GraphQLClientError } from "effect/graphql";

import { GitHubApiResponseError } from "./GitHubRequestPolicy.ts";
import { PullRequestSummary } from "./pullRequestBatches.graphql.ts";
import { PullRequestCore } from "./pullRequestReads.graphql.ts";
import {
  isMissingScopeRefusal,
  readCoreWithScopeFallback,
  T3oPullRequestCoreWithoutReviewers,
  T3oPullRequestCoreWithoutReviewersOrChecks,
  T3oPullRequestSummaryWithoutChecks,
  withoutSelection,
} from "./t3oGraphQlScopeFallback.ts";

const balanced = (query: string) => {
  let depth = 0;
  for (const char of query) {
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
};

describe("withoutSelection", () => {
  it("keeps the names either side of an inline selection apart", () => {
    expect(withoutSelection("{ x { a commits(last: 1) { n } b } }", "commits(")).toBe(
      "{ x { a b } }",
    );
    expect(withoutSelection("{ x {\n  a\n  commits(last: 1) { n }\n  b\n} }", "commits(")).toBe(
      "{ x {\n  a\n  b\n} }",
    );
  });
});

describe("the fallback operations", () => {
  it("drop team review requests and their variable, and keep everything else", () => {
    const query = T3oPullRequestCoreWithoutReviewers.document;
    expect(PullRequestCore.document).toContain("reviewRequests(");
    expect(query).not.toContain("reviewRequests");
    expect(query).not.toContain("$requestedReviewers");
    expect(query).toContain("statusCheckRollup");
    expect(query).toContain("fragment CheckContext");
    expect(query).toContain("$required:");
    expect(query).toContain("labels(first:100)");
    expect(balanced(query)).toBe(true);
  });

  it("drop the check rollup with the fragment and variable only it used", () => {
    const query = T3oPullRequestCoreWithoutReviewersOrChecks.document;
    expect(query).not.toContain("reviewRequests");
    expect(query).not.toContain("commits(");
    expect(query).not.toContain("CheckContext");
    expect(query).not.toContain("$required");
    expect(query).toContain("autoMergeRequest");
    expect(query).toContain("$headRef:");
    expect(balanced(query)).toBe(true);
  });

  it("drop the summary's rollup and keep its template batchable", () => {
    expect(PullRequestSummary.document).toContain("statusCheckRollup");
    expect(T3oPullRequestSummaryWithoutChecks.document).not.toContain("commits(");
    expect(T3oPullRequestSummaryWithoutChecks.document).toContain("$stacks:");
    expect(T3oPullRequestSummaryWithoutChecks.template?.selections[0]?.name).toBe("repository");
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

  it("recognises GitHub refusing the token a field, raw or mapped", () => {
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
        new GraphQLClientError.GraphQLClientError({
          operation: "PullRequestSummary",
          reason: new GraphQLClientError.ResponseError({
            errors: [{ message: "x", type: "INSUFFICIENT_SCOPES" }],
            status: 200,
          }),
        }),
      ),
    ).toBe(true);
    expect(
      isMissingScopeRefusal(
        new GitHubApiResponseError({ host: "github.com", operation: "x", status: 502 }),
      ),
    ).toBe(false);
    // An HTTP 403 is not GraphQL refusing one field.
    expect(
      isMissingScopeRefusal(
        new GitHubApiResponseError({
          host: "github.com",
          operation: "x",
          status: 403,
          githubErrors: ["Resource not accessible by integration"],
        }),
      ),
    ).toBe(false);
  });

  const reads = (outcome: (attempt: string) => Effect.Effect<string, GitHubApiResponseError>) => ({
    full: () => outcome("full"),
    withoutReviewers: () => outcome("withoutReviewers"),
    withoutReviewersOrChecks: () => outcome("withoutReviewersOrChecks"),
  });
  const finish = (read: Effect.Effect<string, GitHubApiResponseError>) =>
    read.pipe(Effect.map((attempt) => ({ attempt })));

  effectIt.effect("gives up reviewers first, then checks, and marks unread checks", () => {
    const asked: Array<string> = [];
    const outcome = (attempt: string) =>
      Effect.suspend(() => {
        asked.push(attempt);
        return attempt === "withoutReviewersOrChecks"
          ? Effect.succeed(attempt)
          : Effect.fail(refused);
      });
    return readCoreWithScopeFallback(reads(outcome), finish).pipe(
      Effect.map((core) => {
        expect(asked).toEqual(["full", "withoutReviewers", "withoutReviewersOrChecks"]);
        expect(core).toEqual({ attempt: "withoutReviewersOrChecks", checksUnread: true });
      }),
    );
  });

  effectIt.effect("keeps the checks when only reviewers were refused", () =>
    readCoreWithScopeFallback(
      reads((attempt) => (attempt === "full" ? Effect.fail(refused) : Effect.succeed(attempt))),
      finish,
    ).pipe(Effect.map((core) => expect(core).toEqual({ attempt: "withoutReviewers" }))),
  );

  effectIt.effect("does not retry any other failure", () => {
    let attempts = 0;
    const outcome = () =>
      Effect.suspend(() => {
        attempts += 1;
        return Effect.fail(
          new GitHubApiResponseError({ host: "github.com", operation: "x", status: 502 }),
        );
      });
    return Effect.flip(readCoreWithScopeFallback(reads(outcome), finish)).pipe(
      Effect.map((error) => {
        expect(error._tag).toBe("GitHubApiResponseError");
        expect(attempts).toBe(1);
      }),
    );
  });
});
