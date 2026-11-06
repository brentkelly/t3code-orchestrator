/**
 * T3o (T3O-8, T3O-54): the pull request reads' missing-scope fallback. Upstream retries only a
 * reviewer node refusal; a classic token's `INSUFFICIENT_SCOPES` and any check rollup refusal
 * fail the document, so these are upstream's operations with the gated selections cut out.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { GraphQL, GraphQLClientError, GraphQLGroup } from "effect/graphql";

import { PullRequestSummary } from "./pullRequestBatches.graphql.ts";
import { PullRequestCore } from "./pullRequestReads.graphql.ts";

/** A field selection to cut, by the text that opens it, and the empty answer it leaves. */
interface GatedSelection {
  readonly opens: string;
  readonly field: string;
  readonly empty: unknown;
}

const REVIEW_REQUESTS: GatedSelection = {
  opens: "reviewRequests(",
  field: "reviewRequests",
  empty: { nodes: [] },
};
// The rollup is the only thing the core and summary documents read from `commits`.
const CHECK_ROLLUP: GatedSelection = { opens: "commits(", field: "commits", empty: { nodes: [] } };

/** Removes every occurrence of one field (with its arguments and sub-selection) from a document. */
export const withoutSelection = (query: string, selection: string): string => {
  const start = query.indexOf(selection);
  if (start === -1) return query;
  const open = query.indexOf("{", start);
  if (open === -1) return query;
  let depth = 0;
  for (let index = open; index < query.length; index += 1) {
    const char = query[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        // Only the whitespace after the field goes, so whatever preceded it still separates
        // its neighbours, inline or line by line.
        let end = index + 1;
        while (query[end] === " " || query[end] === "\n") end += 1;
        return withoutSelection(query.slice(0, start) + query.slice(end), selection);
      }
    }
  }
  return query;
};

// Template parts alternate literal text and names; joined on a character no document holds,
// a cut that removes whole names keeps that alternation when split again.
const SEPARATOR = "\u0000";

const cutParts = (
  parts: GraphQL.DocumentTemplate.Parts,
  gated: ReadonlyArray<GatedSelection>,
): GraphQL.DocumentTemplate.Parts =>
  gated
    .reduce((text, { opens }) => withoutSelection(text, opens), parts.join(SEPARATOR))
    .split(SEPARATOR);

const namesIn = (parts: GraphQL.DocumentTemplate.Parts | undefined) =>
  (parts ?? []).filter((_, index) => index % 2 === 1);

/**
 * `template` without the gated selections, and without the variables and fragments only they
 * used: GitHub rejects a document that declares a variable or fragment it never uses.
 */
export const templateWithout = (
  template: GraphQL.DocumentTemplate,
  gated: ReadonlyArray<GatedSelection>,
): GraphQL.DocumentTemplate => {
  const selections = template.selections.map((selection) => ({
    ...selection,
    body: cutParts(selection.body, gated),
  }));
  const fragments = template.fragments.map((fragment) => ({
    ...fragment,
    body: cutParts(fragment.body, gated),
  }));
  const used = new Set([
    ...namesIn(template.directives),
    ...selections.flatMap((selection) => namesIn(selection.body)),
  ]);
  for (let grew = true; grew;) {
    grew = false;
    for (const fragment of fragments) {
      if (!used.has(fragment.name)) continue;
      for (const name of namesIn(fragment.body)) {
        if (used.has(name)) continue;
        used.add(name);
        grew = true;
      }
    }
  }
  return {
    ...template,
    variables: template.variables.filter((variable) => used.has(variable.name)),
    selections,
    fragments: fragments.filter((fragment) => used.has(fragment.name)),
  };
};

/** Puts each cut field back into every `pullRequest` of an answer, empty. */
const fillPullRequests = (data: unknown, gated: ReadonlyArray<GatedSelection>): unknown => {
  if (typeof data !== "object" || data === null) return data;
  const empty = Object.fromEntries(gated.map(({ field, empty }) => [field, empty]));
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => {
      const pullRequest: unknown =
        typeof value === "object" && value !== null && "pullRequest" in value
          ? value.pullRequest
          : null;
      return [
        key,
        typeof pullRequest === "object" && pullRequest !== null
          ? { ...value, pullRequest: { ...empty, ...pullRequest } }
          : value,
      ];
    }),
  );
};

/**
 * `operation` under another name, without the gated selections. It takes and answers exactly
 * what `operation` does: variables the cut left unused are dropped on encode, and the answer
 * is decoded by `operation`'s own result schema once the cut fields are filled back in.
 */
const withoutGated = <
  const Name extends string,
  Variables extends Schema.Struct<Schema.Struct.Fields>,
  Result extends Schema.Top,
>(
  name: Name,
  operation: {
    readonly template: GraphQL.DocumentTemplate | undefined;
    readonly variables: Variables;
    readonly result: Result;
  },
  gated: ReadonlyArray<GatedSelection>,
) => {
  const template = templateWithout(operation.template!, gated);
  const kept = new Set(template.variables.map((variable) => variable.name));
  // The struct keeps the declared variables only; extra keys are dropped when it encodes.
  const variables = Schema.Struct(
    Object.fromEntries(
      Object.entries(operation.variables.fields).filter(([variable]) => kept.has(variable)),
    ),
  ) as unknown as Variables;
  return GraphQL.query(name, {
    document: template,
    variables,
    result: Schema.Unknown.pipe(
      Schema.decodeTo(
        operation.result,
        SchemaTransformation.transform<Result["Encoded"], unknown>({
          decode: (data) => fillPullRequests(data, gated) as Result["Encoded"],
          encode: (value) => value,
        }),
      ),
    ),
  });
};

export const T3oPullRequestCoreWithoutReviewers = withoutGated(
  "T3oPullRequestCoreWithoutReviewers",
  PullRequestCore,
  [REVIEW_REQUESTS],
);
export const T3oPullRequestCoreWithoutReviewersOrChecks = withoutGated(
  "T3oPullRequestCoreWithoutReviewersOrChecks",
  PullRequestCore,
  [REVIEW_REQUESTS, CHECK_ROLLUP],
);
export const T3oPullRequestSummaryWithoutChecks = withoutGated(
  "T3oPullRequestSummaryWithoutChecks",
  PullRequestSummary,
  [CHECK_ROLLUP],
);

/** The fallback operations, merged into the pull request client's group. */
export const T3oScopeFallbackGraphQLGroup = GraphQLGroup.make(
  T3oPullRequestCoreWithoutReviewers,
  T3oPullRequestCoreWithoutReviewersOrChecks,
  T3oPullRequestSummaryWithoutChecks,
);

const REFUSAL = /required scopes|not been granted|not accessible by|INSUFFICIENT_SCOPES/i;

/**
 * GitHub refusing the token a gated field (T3O-8), on a 200: as the client's raw
 * `ResponseError`, or as the `GitHubApiResponseError` `GitHubGraphQlClient.call` maps it to.
 */
export const isMissingScopeRefusal = (error: unknown): boolean => {
  if (GraphQLClientError.isGraphQLClientError(error)) {
    const reason = error.reason;
    return (
      reason._tag === "ResponseError" &&
      (reason.status ?? 200) === 200 &&
      reason.errors.some(
        (graphQlError) =>
          REFUSAL.test(graphQlError.message) ||
          (typeof graphQlError["type"] === "string" && REFUSAL.test(graphQlError["type"])),
      )
    );
  }
  if (typeof error !== "object" || error === null || !("_tag" in error)) return false;
  if (error._tag !== "GitHubApiResponseError") return false;
  const { status, githubErrors } = error as {
    readonly status?: number;
    readonly githubErrors?: ReadonlyArray<string>;
  };
  return status === 200 && (githubErrors ?? []).some((message) => REFUSAL.test(message));
};

/** The core reads in the order a refused read gives fields up: team review requests first,
    since nothing the board decides needs reviewers, while mergeability outranks checks. */
export interface T3oCoreReads<A> {
  readonly full: () => A;
  readonly withoutReviewers: () => A;
  readonly withoutReviewersOrChecks: () => A;
}

/**
 * T3O-8, T3O-59: the pull request core read with the missing-scope fallback. `finish` turns
 * each raw read into the core (the same pipeline upstream runs on its own read). Only a scope
 * refusal is retried, once per gated field. A read that had to drop the check rollup is marked
 * `checksUnread`: its empty checks mean "could not look", not "none".
 */
export const readCoreWithScopeFallback = <Raw, A extends object, E, R>(
  reads: T3oCoreReads<Raw>,
  finish: (read: Raw) => Effect.Effect<A, E, R>,
): Effect.Effect<A & { readonly checksUnread?: true }, E, R> => {
  const retry = (
    read: Effect.Effect<A & { readonly checksUnread?: true }, E, R>,
    next: () => Effect.Effect<A & { readonly checksUnread?: true }, E, R>,
  ) => read.pipe(Effect.catchIf(isMissingScopeRefusal, next));
  return retry(finish(reads.full()), () =>
    retry(finish(reads.withoutReviewers()), () =>
      finish(reads.withoutReviewersOrChecks()).pipe(
        Effect.map((core) => ({ ...core, checksUnread: true as const })),
      ),
    ),
  );
};

/**
 * T3O-54: the summary read, again through `read(false)` (the batch without the check rollup)
 * on a scope refusal. The decoder reads the rollup's absence as checks unknown.
 */
export const readSummariesWithScopeFallback = <A, E, R>(
  read: (withChecks: boolean) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  read(true).pipe(Effect.catchIf(isMissingScopeRefusal, () => read(false)));
