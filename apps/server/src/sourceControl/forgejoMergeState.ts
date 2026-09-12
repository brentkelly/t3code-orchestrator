/**
 * T3o: Forgejo's answer to "why was that merge refused?" (T3O-38, D7).
 *
 * Two `fgj` calls, because Forgejo splits the answer the way Gitea's API does:
 * the pull request itself carries `mergeable` and its head sha, and the
 * checks live with Forgejo Actions. Neither is error prose, which is the whole
 * point — see `changeRequestMergeState` on `SourceControlProvider`.
 *
 * Lenient throughout, and deliberately so. `fgj` is a thinner wrapper than
 * `gh` and its JSON is Gitea's raw struct, which has changed shape across
 * versions; anything this cannot read degrades to `unknown` / zero counts,
 * which the board's classifier reads as a SOFT refusal. An unreadable probe
 * costs a few extra retries and never a wrong verdict.
 */
import type { ChangeRequestChecks, ChangeRequestMergeState } from "@t3tools/contracts";

/** How many check names a detail line will ever show — bounded because the
    text is persisted on the card and rendered in a banner. */
export const FORGEJO_MERGE_STATE_MAX_NAMED_CHECKS = 4;

/** Gitea run states that mean "finished badly". */
const FAILED_STATES = new Set(["failure", "failed", "error", "cancelled", "canceled"]);
/** …and the ones that mean "not finished". */
const PENDING_STATES = new Set(["waiting", "running", "queued", "pending", "blocked"]);
/** …and the ones that do not block a merge. `skipped` is a pass for the same
    reason GitHub's `SKIPPED` is: the forge will merge over it. */
const PASSED_STATES = new Set(["success", "succeeded", "skipped", "neutral"]);

const text = (value: unknown): string => (typeof value === "string" ? value : "");

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * The head sha and mergeability off `fgj pr view --json` (Gitea's raw
 * `PullRequest`).
 *
 * `mergeable` absent is `unknown`, not `false`: Gitea omits it while it is
 * still computing, and reading "we have not worked it out" as "no" would stop
 * a ladder that should keep waiting.
 */
export function parseForgejoPullRequestMergeability(raw: string): {
  readonly mergeable: boolean | null;
  readonly headSha: string | null;
} {
  const body = asRecord(parseJson(raw));
  if (body === null) return { mergeable: null, headSha: null };
  const head = asRecord(body["head"]);
  const sha = text(head?.["sha"]);
  const mergeable = body["mergeable"];
  return {
    mergeable: typeof mergeable === "boolean" ? mergeable : null,
    headSha: sha.length > 0 ? sha : null,
  };
}

/**
 * The check rollup for one head sha, off `fgj actions run list --json`.
 *
 * Filtered by sha rather than taken whole: the listing is "recent runs for the
 * repository", so without the filter a card would be classified against
 * somebody else's branch. A run whose sha cannot be read is skipped for the
 * same reason — counting it would be inventing evidence.
 */
export function parseForgejoChecks(raw: string, headSha: string | null): ChangeRequestChecks {
  const empty: ChangeRequestChecks = {
    total: 0,
    passed: 0,
    pending: 0,
    failed: 0,
    failing: [],
    running: [],
  };
  if (headSha === null) return empty;
  const parsed = parseJson(raw);
  const body = asRecord(parsed);
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(body?.["workflow_runs"])
      ? (body["workflow_runs"] as ReadonlyArray<unknown>)
      : Array.isArray(body?.["runs"])
        ? (body["runs"] as ReadonlyArray<unknown>)
        : [];

  let passed = 0;
  let pending = 0;
  let failed = 0;
  const failing: string[] = [];
  const running: string[] = [];
  for (const item of entries) {
    const entry = asRecord(item);
    if (entry === null) continue;
    const sha =
      text(entry["head_sha"]) || text(entry["headSha"]) || text(asRecord(entry["head"])?.["sha"]);
    if (sha !== headSha) continue;
    const name =
      text(entry["name"]) || text(entry["display_title"]) || text(entry["title"]) || "a check";
    // `conclusion` wins where a version reports both: it is the settled
    // answer, and `status` on a finished run is just "completed".
    const conclusion = text(entry["conclusion"]).toLowerCase();
    const status = text(entry["status"]).toLowerCase();
    const verdict = conclusion.length > 0 ? conclusion : status;
    if (FAILED_STATES.has(verdict)) {
      failed += 1;
      if (failing.length < FORGEJO_MERGE_STATE_MAX_NAMED_CHECKS) failing.push(name);
    } else if (PENDING_STATES.has(verdict) || (status === "completed" && conclusion.length === 0)) {
      pending += 1;
      if (running.length < FORGEJO_MERGE_STATE_MAX_NAMED_CHECKS) running.push(name);
    } else if (PASSED_STATES.has(verdict)) {
      passed += 1;
    }
  }
  return { total: passed + pending + failed, passed, pending, failed, failing, running };
}

/**
 * Assemble the provider-neutral state.
 *
 * `checksReadable` is what keeps an instance without Actions — or an `fgj`
 * whose run listing we could not read — from being classified as
 * "every check is green and the forge still says no", which is a HARD stop.
 * With no check evidence the honest answer is `unknown`, which retries.
 */
export function forgejoMergeState(input: {
  readonly mergeable: boolean | null;
  readonly headSha: string | null;
  readonly checks: ChangeRequestChecks;
  readonly checksReadable: boolean;
}): ChangeRequestMergeState {
  const mergeable =
    input.mergeable === true
      ? ("mergeable" as const)
      : input.mergeable === false && input.checksReadable
        ? ("blocked" as const)
        : ("unknown" as const);
  return {
    mergeable,
    // Forgejo does not name its block the way GitHub's `mergeStateStatus`
    // does. Left null rather than guessed: an unnamed block is classified by
    // the checks, and a wrong name would send the card down the wrong path.
    blockedReason: null,
    checks: input.checks,
    headSha: input.headSha,
  };
}
