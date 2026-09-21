/**
 * T3o: Forgejo's answer to "why was that merge refused?" (T3O-38, D7).
 *
 * Two API reads, because Forgejo splits the answer the way Gitea's API does:
 * the pull request itself carries `mergeable` and its head sha, and the checks
 * are the commit statuses on that sha. Neither is error prose, which is the
 * whole point — see `changeRequestMergeState` on `SourceControlProvider`.
 *
 * Lenient throughout, and deliberately so. The JSON is Gitea's raw struct,
 * which has changed shape across versions; anything this cannot read degrades
 * to `unknown` / zero counts, which the board's classifier reads as a SOFT
 * refusal. An unreadable probe costs a few extra retries and never a wrong
 * verdict.
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
    reason GitHub's `SKIPPED` is: the forge will merge over it, as it will over
    a `warning`. */
const PASSED_STATES = new Set(["success", "succeeded", "skipped", "neutral", "warning"]);

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
 * The head sha, mergeability and behind-ness off `GET pulls/{n}` (Gitea's raw
 * `PullRequest`).
 *
 * `mergeable` absent is `unknown`, not `false`: Gitea omits it while it is
 * still computing, and reading "we have not worked it out" as "no" would stop
 * a ladder that should keep waiting.
 *
 * `behind` is read STRUCTURALLY rather than from a field, because Gitea has no
 * equivalent of GitHub's `BEHIND` status: `merge_base` is the common ancestor
 * and `base.sha` is the base branch's current tip (Gitea resolves it per
 * request), so the two differing is the definition of the head lacking base
 * commits. Either one unreadable leaves it `null` — an unnamed block is then
 * classified by the checks, which is where this started.
 */
export function parseForgejoPullRequestMergeability(raw: string): {
  readonly mergeable: boolean | null;
  readonly headSha: string | null;
  readonly behind: boolean | null;
} {
  const body = asRecord(parseJson(raw));
  if (body === null) return { mergeable: null, headSha: null, behind: null };
  const head = asRecord(body["head"]);
  const sha = text(head?.["sha"]);
  const mergeable = body["mergeable"];
  const mergeBase = text(body["merge_base"]) || text(body["mergeBase"]);
  const baseSha = text(asRecord(body["base"])?.["sha"]);
  return {
    mergeable: typeof mergeable === "boolean" ? mergeable : null,
    headSha: sha.length > 0 ? sha : null,
    behind: mergeBase.length > 0 && baseSha.length > 0 ? mergeBase !== baseSha : null,
  };
}

/** Whether `GET pulls/{n}` says the pull request is merged. Unreadable is "no". */
export function parseForgejoPullRequestMerged(raw: string): boolean {
  return asRecord(parseJson(raw))?.["merged"] === true;
}

/**
 * What a merge refusal means when the forge's own words never reached us.
 *
 * Only Gitea's two merge-refusal statuses are spelled out; every other failure
 * keeps whatever `ForgejoCli.api` said, which for anything but a refused merge
 * is the more informative of the two.
 */
const REFUSAL_WITHOUT_A_MESSAGE: Record<number, string> = {
  405: "Forgejo refused to merge the pull request. It is most likely waiting on a review, a check, or a branch protection rule. Open it on the host to see which.",
  409: "Forgejo could not merge the pull request. It most likely conflicts with its base branch.",
};

/**
 * The forge's own words out of an API failure, when it sent any.
 *
 * On a server whose credentials belong to `fj`, `ForgejoCli.api` reports an
 * HTTP failure as `… (HTTP 405): <body>`, and the body is Gitea's
 * `{"message": "…"}`. For a merge that message IS the product — it is what the
 * card shows, and what tells a conflict apart from a failing check — so it is
 * lifted out of the envelope rather than shown as JSON.
 *
 * Under `tea` there is no body to lift: that branch reports the status alone,
 * and a bare `(HTTP 405).` on a card reads as a malfunction rather than as a
 * refusal. So a refusal status with no message is rendered from the status.
 * Nothing machine-readable is lost either way — the board classifies a refusal
 * from `changeRequestMergeState`'s probe, never from this text.
 */
export function forgejoRefusalDetail(detail: string, httpStatus?: number | undefined): string {
  const start = detail.indexOf("{");
  if (start >= 0) {
    const message = text(asRecord(parseJson(detail.slice(start)))?.["message"]).trim();
    if (message.length > 0) return message;
  }
  return (httpStatus === undefined ? undefined : REFUSAL_WITHOUT_A_MESSAGE[httpStatus]) ?? detail;
}

/**
 * The check rollup for one head sha, off `GET commits/{sha}/status` — Gitea's
 * combined status, which already holds the latest status per context for that
 * commit alone, whoever posted it (Forgejo Actions or an external CI).
 *
 * Null when the body is not a combined status at all, so the caller can tell
 * "no checks" from "could not look" (`checksReadable`).
 */
export function parseForgejoCommitStatuses(raw: string): ChangeRequestChecks | null {
  const body = asRecord(parseJson(raw));
  const statuses = body?.["statuses"];
  // Gitea writes `"statuses": null` for a commit nobody has reported on.
  if (body === null || (statuses !== null && statuses !== undefined && !Array.isArray(statuses))) {
    return null;
  }
  if (!("statuses" in body) && !("state" in body)) return null;

  let passed = 0;
  let pending = 0;
  let failed = 0;
  const failing: string[] = [];
  const running: string[] = [];
  for (const item of Array.isArray(statuses) ? statuses : []) {
    const entry = asRecord(item);
    if (entry === null) continue;
    const name = text(entry["context"]) || text(entry["name"]) || "a check";
    // Gitea's struct names the field `status`; GitHub-compatible readers say `state`.
    const verdict = (text(entry["status"]) || text(entry["state"])).toLowerCase();
    if (FAILED_STATES.has(verdict)) {
      failed += 1;
      if (failing.length < FORGEJO_MERGE_STATE_MAX_NAMED_CHECKS) failing.push(name);
    } else if (PENDING_STATES.has(verdict)) {
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
 * `checksReadable` is what keeps a status read that failed — or a body this
 * build could not parse — from being classified as
 * "every check is green and the forge still says no", which is a HARD stop.
 * With no check evidence the honest answer is `unknown`, which retries.
 */
export function forgejoMergeState(input: {
  readonly mergeable: boolean | null;
  readonly headSha: string | null;
  readonly checks: ChangeRequestChecks;
  readonly checksReadable: boolean;
  /** Whether the head lacks base commits, from `merge_base` versus `base.sha`;
      null when either was unreadable. */
  readonly behind?: boolean | null | undefined;
}): ChangeRequestMergeState {
  const mergeable =
    input.mergeable === true
      ? ("mergeable" as const)
      : input.mergeable === false && input.checksReadable
        ? ("blocked" as const)
        : ("unknown" as const);
  return {
    mergeable,
    // Forgejo does not NAME its block the way GitHub's `mergeStateStatus`
    // does, so only the one reason that can be established from the struct
    // itself is reported — the head missing base commits. Everything else
    // stays null rather than guessed: an unnamed block is classified by the
    // checks, and a wrong name would send the card down the wrong path (and,
    // via the stored classification, the wrong remediation).
    blockedReason: input.behind === true ? ("behind" as const) : null,
    checks: input.checks,
    headSha: input.headSha,
  };
}
