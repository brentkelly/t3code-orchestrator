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
 * It names only what the detail shows. A refusal the detail cannot explain is
 * left unexplained, never guessed at (T3O-67): the forge's own words, which
 * now reach the board, say why.
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
 * Why the forge is blocking, when its detail shows it in a way the board can
 * act on.
 *
 * Narrow on purpose: only the reasons that change what the board DOES. A
 * branch that is behind needs a rebase, a draft needs a human to mark it
 * ready, and a conflict has its own resolution path already. A missing
 * approval, a protection rule or a required conversation is not here: the
 * detail does not carry them, and inferring one by elimination stopped cards
 * whose merge was really refused for something else, such as the wrong
 * credential (T3O-67).
 */
export type BoardMergeBlockReason = "behind" | "draft" | "conflict";

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
  /** True when the token was refused the checks (T3O-8), so the zero counts
      above are "could not look". Nothing may then be concluded from a green
      rollup, least of all a missing approval. */
  readonly checksUnread: boolean;
}

/** How many failing/running check names a detail line will ever show. Bounded
    because this text is persisted on the card and rendered in a banner, and a
    repository with 200 checks must not put 200 names there. */
export const BOARD_MERGE_STATE_MAX_NAMED_CHECKS = 4;

/** How much of the forge's own refusal text a card will show (T3O-67). Bounded
    for the same reason as the check names: it is persisted on the card and
    rendered in a banner, and a forge error can run to paragraphs. */
export const BOARD_MERGE_FORGE_TEXT_MAX_LENGTH = 300;

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
 * Asked only AFTER a merge has been refused. A conflict, a draft and a branch
 * behind its base are structural, and the board routes each of them. A pull
 * request the host reports as mergeable, green, ready and up to date was
 * refused for a reason the detail does not show, so it reads as `mergeable`
 * and the refusal stays soft. The forge's own words go on the card instead
 * (`boardHostMergeRefusalReason`). This used to conclude "needs an approval"
 * by elimination and stop the card. A merge refused for any other reason,
 * such as a token that could read the pull request but not merge it, then sat
 * held behind a reason that was not true (T3O-67). A refusal that really does
 * need an approval now climbs the soft ladder and holds when it runs out,
 * showing GitHub's "approving review is required". Unclassifiable stays soft
 * (D7).
 */
export function boardMergeStateOf(detail: PullRequestDetail): BoardMergeState {
  const checks = checksOf(detail);
  const headSha = detail.headSha ?? null;
  const checksUnread = detail.checksUnread === true;
  const blocked = (blockedReason: BoardMergeBlockReason): BoardMergeState => ({
    mergeable: "blocked",
    blockedReason,
    checks,
    headSha,
    checksUnread,
  });

  if (detail.mergeability === "conflicting") return blocked("conflict");
  if (detail.isDraft) return blocked("draft");
  if (detail.baseComparison === "behind") return blocked("behind");
  if (detail.mergeability === "unknown") {
    return { mergeable: "unknown", blockedReason: null, checks, headSha, checksUnread };
  }
  return { mergeable: "mergeable", blockedReason: null, checks, headSha, checksUnread };
}

/**
 * The state of a pull request the forge could not describe but git proved
 * conflicting (T3O-8) — see `probeLocalMergeConflict`. Nothing was read from
 * the forge, so the checks are unread and there is no head sha.
 */
export const LOCAL_CONFLICT_MERGE_STATE: BoardMergeState = {
  mergeable: "blocked",
  blockedReason: "conflict",
  checks: { total: 0, passed: 0, pending: 0, failed: 0, failing: [], running: [] },
  headSha: null,
  checksUnread: true,
};

/**
 * The sentence a card shows for a refused merge.
 *
 * Derived from the same facts the board branches on, so it cannot disagree
 * with the verdict shown beside it. A host refusal adds the forge's own words
 * through `boardHostMergeRefusalReason` (T3O-67); this sentence alone serves
 * when there are none.
 *
 * `null` is a probe that itself failed. The forge may well have a reason the
 * board could not read, so the card says the READ failed and passes on its
 * words, which usually name the fix (a missing token scope, a rate limit),
 * rather than claiming the forge gave no reason (T3O-8).
 */
export function boardMergeRefusalReason(
  state: BoardMergeState | null,
  probeFailure?: string,
): string {
  if (state === null) {
    return probeFailure === undefined
      ? "The forge refused the merge, and asking it why failed."
      : `The forge refused the merge, and asking it why failed: ${probeFailure}`;
  }
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
    case null:
      return state.checksUnread
        ? "The forge refused the merge, and this token may not read the pull request's checks to see why. Grant it read access to Checks and Commit statuses."
        : "The forge refused the merge and did not say why.";
  }
}

/**
 * The sentence a card shows for a merge the HOST refused (T3O-67): the board's
 * own reading of the detail, together with what the forge said.
 *
 * Since v0.1.0 the merge goes through the forge's API rather than a CLI, so the
 * forge's refusal text reaches the board again ("GitHub returned an error:
 * …"). When the probe names a concrete cause (a conflict, failing checks, a
 * draft), that sentence leads and the forge's text follows. When it names
 * none, the forge's text is the whole explanation. Nothing here branches on
 * that text: it is shown, never parsed.
 */
export function boardHostMergeRefusalReason(
  state: BoardMergeState | null,
  probeFailure: string | undefined,
  forgeText: string | undefined,
): string {
  const derived = boardMergeRefusalReason(state, probeFailure);
  const trimmed = forgeText?.trim() ?? "";
  if (trimmed.length === 0) return derived;
  const said =
    trimmed.length <= BOARD_MERGE_FORGE_TEXT_MAX_LENGTH
      ? trimmed
      : `${trimmed.slice(0, BOARD_MERGE_FORGE_TEXT_MAX_LENGTH - 1).trimEnd()}…`;
  const explained =
    state === null ||
    state.blockedReason !== null ||
    state.mergeable === "unknown" ||
    state.checksUnread ||
    state.checks.failed > 0 ||
    state.checks.pending > 0;
  return explained ? `${derived} The forge said: ${said}` : `The forge refused the merge: ${said}`;
}
