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
        let end = index + 1;
        while (query[end] === " " || query[end] === "\n") end += 1;
        let lineStart = start;
        while (lineStart > 0 && query[lineStart - 1] === " ") lineStart -= 1;
        return withoutSelection(query.slice(0, lineStart) + query.slice(end), selection);
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
