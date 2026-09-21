/**
 * T3o: the machine-readable answer to "why did that merge get refused?",
 * read out of upstream's pull-request detail (T3O-38 D6/D7, rebuilt on
 * `pullRequest/` by T3O-47).
 *
 * The board classifies a refusal into "wait, this clears itself" and "stop, a
 * human is needed". That decision must not be made by matching error prose,
 * which every forge rewrites — so it is made against the structured detail
 * every provider in `apps/server/src/pullRequest/` already reports.
 *
 * Pure and total. Anything it cannot read comes back as `unknown` with zero
 * counts, which the classifier degrades to a soft refusal: a probe we cannot
 * read costs a few extra retries and never a wrong verdict.
 *
 * Not a contract. Nothing here crosses the wire — the gateway hands it to the
 * classifier, and what the card persists is the classifier's verdict.
 */
import type { PullRequestCheckStatus, PullRequestDetail } from "@t3tools/contracts";

/**
 * Whether the forge will take this merge. Tri-state because "we do not know
 * yet" is a real and common answer: a forge still computing mergeability has
 * said nothing, and reading that as "no" would stop a ladder that should keep
 * waiting.
 */
export type BoardMergeability = "mergeable" | "blocked" | "unknown";

/**
 * Why the forge is blocking, when it says so in a way the board can act on.
 *
 * Narrow on purpose: only the reasons that change what the board DOES. A
 * branch that is behind needs a rebase, a draft needs a human to mark it
 * ready, and a conflict has its own resolution path already. Everything else
 * — a missing approval, a protection rule, a required conversation — is
 * `other`, because the board's answer to all of them is the same: stop and
 * hand the card to a person.
 */
export type BoardMergeBlockReason = "behind" | "draft" | "conflict" | "other";

/** The rollup of a pull request's checks at one instant. */
export interface BoardMergeChecks {
  readonly total: number;
  readonly passed: number;
  readonly pending: number;
  readonly failed: number;
  /** The names of the checks counted in `failed`, for the card's detail line.
      Bounded here; never the whole log. */
  readonly failing: ReadonlyArray<string>;
  /** The names of the checks counted in `pending`, same contract. */
  readonly running: ReadonlyArray<string>;
}

export interface BoardMergeState {
  readonly mergeable: BoardMergeability;
  /** Null when the forge is not blocking, or is blocking for a reason this
      host could not name. */
  readonly blockedReason: BoardMergeBlockReason | null;
  readonly checks: BoardMergeChecks;
  /** The head commit the checks above describe. A new sha means new CI, which
      is what resets the board's retry ladder (T3O-38, D9). Null where the host
      reported none. */
  readonly headSha: string | null;
}

/** How many failing/running check names a detail line will ever show. Bounded
    because this text is persisted on the card and rendered in a banner, and a
    repository with 200 checks must not put 200 names there. */
export const BOARD_MERGE_STATE_MAX_NAMED_CHECKS = 4;

/**
 * One check's verdict.
 *
 * `neutral` and `skipped` count as passed because GitHub does not block a
 * merge on either, so they must not block the ladder either. `action-required`
 * and `cancelled` count as failed: both need a new commit or a human, and
 * neither clears on its own.
 */
function verdictOf(status: PullRequestCheckStatus): "passed" | "pending" | "failed" {
  switch (status) {
    case "failure":
    case "action-required":
    case "cancelled":
      return "failed";
    case "pending":
      return "pending";
    case "success":
    case "skipped":
    case "neutral":
      return "passed";
  }
}

function checksOf(detail: PullRequestDetail): BoardMergeChecks {
  let passed = 0;
  let pending = 0;
  let failed = 0;
  const failing: string[] = [];
  const running: string[] = [];
  for (const check of detail.checks) {
    switch (verdictOf(check.status)) {
      case "passed":
        passed += 1;
        break;
      case "pending":
        pending += 1;
        if (running.length < BOARD_MERGE_STATE_MAX_NAMED_CHECKS) running.push(check.name);
        break;
      case "failed":
        failed += 1;
        if (failing.length < BOARD_MERGE_STATE_MAX_NAMED_CHECKS) failing.push(check.name);
        break;
    }
  }
  return { total: passed + pending + failed, passed, pending, failed, failing, running };
}

/**
 * Read a refusal out of the forge's own detail.
 *
 * Asked only AFTER a merge has been refused, which is what makes the last
 * branch honest: a pull request the host reports as mergeable, green, ready
 * and up to date, that the host nonetheless refused to merge, was refused for
 * a reason nothing here can see — a required approval, a protection rule, an
 * unresolved conversation. All of those need a person, so the board stops.
 *
 * The one case that must stay soft is a host that could not compare the branch
 * with its base: `baseComparison` is absent or "unknown" on every host but
 * GitHub, and a branch that is merely behind would otherwise be read as a
 * decision the board cannot take. Unclassifiable stays soft (D7).
 */
export function boardMergeStateOf(detail: PullRequestDetail): BoardMergeState {
  const checks = checksOf(detail);
  const headSha = detail.headSha ?? null;
  const blocked = (blockedReason: BoardMergeBlockReason): BoardMergeState => ({
    mergeable: "blocked",
    blockedReason,
    checks,
    headSha,
  });

  if (detail.mergeability === "conflicting") return blocked("conflict");
  if (detail.isDraft) return blocked("draft");
  if (detail.baseComparison === "behind") return blocked("behind");
  if (detail.mergeability === "unknown") {
    return { mergeable: "unknown", blockedReason: null, checks, headSha };
  }
  if (checks.failed > 0 || checks.pending > 0 || detail.baseComparison !== "up-to-date") {
    return { mergeable: "mergeable", blockedReason: null, checks, headSha };
  }
  return blocked("other");
}

/**
 * The sentence a card shows for a refused merge.
 *
 * This replaces the forge's own prose (T3O-47): upstream's process layer
 * deliberately drops a subprocess's stderr, so `gh pr merge`'s words no longer
 * reach this far. The structured state says more than they did anyway — the
 * board was already forbidden from BRANCHING on that text, and a sentence
 * derived from the same facts it branches on cannot disagree with the verdict
 * shown beside it.
 *
 * `null` is a probe that itself failed, which says only that the merge was
 * refused.
 */
export function boardMergeRefusalReason(state: BoardMergeState | null): string {
  if (state === null) return "The forge refused the merge and did not say why.";
  if (state.checks.failed > 0) return "Its checks are failing.";
  if (state.checks.pending > 0) return "Its checks have not finished.";
  if (state.mergeable === "unknown") {
    return "The forge has not finished working out whether it can merge.";
  }
  switch (state.blockedReason) {
    case "conflict":
      return "Its pull request conflicts with its base branch.";
    case "draft":
      return "Its pull request is still a draft.";
    case "behind":
      return "Its branch is behind its base branch.";
    case "other":
      return "The forge is blocking the merge — it needs a review approval, a protection rule satisfied, or a conversation resolved.";
    case null:
      return "The forge refused the merge and did not say why.";
  }
}
