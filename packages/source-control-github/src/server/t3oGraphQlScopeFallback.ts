/**
 * T3o (T3O-8, T3O-54): the GraphQL half of the pull request reads' missing-scope fallback.
 *
 * Upstream reads a pull request's detail through one GraphQL document that also asks for team
 * review requests (needs `read:org` on a classic token) and the check rollup (needs the Checks
 * and Commit statuses permissions on a fine-grained one). GitHub refuses the whole document
 * over either, which would cost the board the mergeability it routes conflicts on. The fork's
 * fallback reads again without each gated field in turn; these helpers let it do that against
 * the GraphQL document by removing a field's selection and filling the shape the decoder
 * expects back in, empty. The batched summary read uses the same removal on its aliased
 * document, where the check rollup's selection repeats once per pull request.
 */
import * as Effect from "effect/Effect";

/** The GraphQL selection each gated `gh --json` field name stands for in the core query. */
const GATED_SELECTIONS: Readonly<
  Record<string, { readonly selection: string; readonly empty: unknown }>
> = {
  reviewRequests: { selection: "reviewRequests(", empty: { nodes: [] } },
  // The rollup is the only thing the core query reads from `commits`.
  statusCheckRollup: { selection: "commits(", empty: { nodes: [] } },
};

const selectionKey = (selection: string) => selection.slice(0, -1);

/** Removes every occurrence of one field (with its arguments and sub-selection) from a document. */
const withoutSelection = (query: string, selection: string): string => {
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

/** `query` without the selections of every gated field absent from `fields` (comma-separated). */
export const coreQueryForFields = (query: string, fields: string): string => {
  const kept = new Set(fields.split(","));
  return Object.entries(GATED_SELECTIONS).reduce(
    (current, [field, { selection }]) =>
      kept.has(field) ? current : withoutSelection(current, selection),
    query,
  );
};

/**
 * Puts each dropped field back into the response as an empty connection, so the core decoder
 * reads a pull request with no reviewers and no checks rather than failing on the absence.
 */
export const fillDroppedCoreFields = (raw: string, fields: string): string => {
  const kept = new Set(fields.split(","));
  const dropped = Object.entries(GATED_SELECTIONS).filter(([field]) => !kept.has(field));
  if (dropped.length === 0) return raw;
  let parsed: unknown;
  try {
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const pullRequest = (parsed as { data?: { repository?: { pullRequest?: unknown } } })?.data
    ?.repository?.pullRequest;
  if (typeof pullRequest !== "object" || pullRequest === null) return raw;
  for (const [, { selection, empty }] of dropped) {
    (pullRequest as Record<string, unknown>)[selectionKey(selection)] = empty;
  }
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  return JSON.stringify(parsed);
};

/** The gated fields, in the order a refused read gives them up: team review requests first,
    since nothing the board decides needs reviewers, while mergeability outranks checks. */
const GATED_FIELDS = Object.keys(GATED_SELECTIONS);

/**
 * GitHub refusing the token one of the gated fields (T3O-8). A classic token without
 * `read:org` is told it "has not been granted the required scopes"; a fine-grained one
 * without the Checks permission that the resource is "not accessible".
 */
export const isMissingScopeRefusal = (error: { readonly _tag: string }): boolean =>
  error._tag === "GitHubApiResponseError" &&
  ((error as { readonly githubErrors?: ReadonlyArray<string> }).githubErrors ?? []).some(
    (message) =>
      /required scopes|not been granted|not accessible by|INSUFFICIENT_SCOPES/i.test(message),
  );

/**
 * T3O-8, T3O-59: the pull request core read with the missing-scope fallback. `read` is handed
 * the gated fields it may ask for (comma-separated) and must leave the others out of its
 * document (`coreQueryForFields`) and fill them back empty on decode (`fillDroppedCoreFields`).
 * Only a scope refusal is retried, once per gated field. A read that had to drop the check
 * rollup is marked `checksUnread`: its empty checks mean "could not look", not "none".
 */
export const readCoreWithScopeFallback = <A extends object, E extends { readonly _tag: string }, R>(
  read: (fields: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A & { readonly checksUnread?: true }, E, R> => {
  const attempt = (
    fields: ReadonlyArray<string>,
  ): Effect.Effect<A & { readonly checksUnread?: true }, E, R> =>
    read(fields.join(",")).pipe(
      Effect.map((core) => (fields.includes("statusCheckRollup") ? core : { ...core, checksUnread: true as const })),
      Effect.catchIf(
        (error) => fields.length > 0 && isMissingScopeRefusal(error),
        () => attempt(fields.slice(1)),
      ),
    );
  return attempt(GATED_FIELDS);
};
