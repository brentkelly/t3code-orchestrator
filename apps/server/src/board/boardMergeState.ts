/**
 * Why a merge was refused, read from upstream's structured pull-request detail
 * rather than forge prose. Pure and total: anything unreadable is `unknown`
 * (a soft refusal), and a refusal the detail cannot explain is never guessed.
 */
import {
  boardCheckNameMatches,
  type PullRequestCheckStatus,
  type PullRequestDetail,
} from "@t3tools/contracts";

/**
 * Whether the forge will take this merge. Tri-state because "we do not know
 * yet" is a real and common answer: a forge still computing mergeability has
 * said nothing, and reading that as "no" would stop a ladder that should keep
 * waiting.
 */
export type BoardMergeability = "mergeable" | "blocked" | "unknown";

/**
 * Only the blocking reasons that change what the board does. Missing approvals
 * and protection rules are absent from the detail, and inferring one by
 * elimination stops cards refused for something else (a wrong credential).
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
  /** Every check's verdict, up to `BOARD_MERGE_STATE_MAX_LISTED_CHECKS`, so a
      CI forge step can filter by name (T3O-49). Absent from older workers. */
  readonly verdicts?: ReadonlyArray<BoardCheckVerdict>;
}

export interface BoardCheckVerdict {
  readonly name: string;
  readonly verdict: "passed" | "pending" | "failed";
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

/** How many checks `verdicts` lists: enough for any real repository, bounded
    because it crosses the worker wire on every forge poll. */
const BOARD_MERGE_STATE_MAX_LISTED_CHECKS = 500;

/** How much of the forge's own refusal text a card will show (T3O-67). Bounded
    for the same reason as the check names: it is persisted on the card and
    rendered in a banner, and a forge error can run to paragraphs. */
export const BOARD_MERGE_FORGE_TEXT_MAX_LENGTH = 300;

/**
 * `neutral` and `skipped` pass because GitHub does not block on them;
 * `action-required` and `cancelled` fail because neither clears on its own.
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
  const verdicts: BoardCheckVerdict[] = [];
  for (const check of detail.checks) {
    const verdict = verdictOf(check.status);
    if (verdicts.length < BOARD_MERGE_STATE_MAX_LISTED_CHECKS) {
      verdicts.push({ name: check.name, verdict });
    }
    switch (verdict) {
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
  return {
    total: passed + pending + failed,
    passed,
    pending,
    failed,
    failing,
    running,
    verdicts,
  };
}

/**
 * The checks a CI forge step's `only` patterns select (T3O-49), counted and
 * named from the full verdict list. A worker that sends no list leaves only
 * the bounded name lists to filter, so its counts are a best effort.
 */
export function boardFilteredMergeChecks(
  checks: BoardMergeChecks,
  only: ReadonlyArray<string>,
): BoardMergeChecks {
  if (only.length === 0) return checks;
  const matches = (name: string) => only.some((pattern) => boardCheckNameMatches(pattern, name));
  if (checks.verdicts === undefined) {
    const failing = checks.failing.filter(matches);
    const running = checks.running.filter(matches);
    return { ...checks, failing, running, failed: failing.length, pending: running.length };
  }
  const selected = checks.verdicts.filter((check) => matches(check.name));
  const named = (verdict: BoardCheckVerdict["verdict"]) =>
    selected
      .filter((check) => check.verdict === verdict)
      .map((check) => check.name)
      .slice(0, BOARD_MERGE_STATE_MAX_NAMED_CHECKS);
  const count = (verdict: BoardCheckVerdict["verdict"]) =>
    selected.filter((check) => check.verdict === verdict).length;
  return {
    total: selected.length,
    passed: count("passed"),
    pending: count("pending"),
    failed: count("failed"),
    failing: named("failed"),
    running: named("pending"),
    verdicts: selected,
  };
}

/**
 * Asked only after a merge was refused. A mergeable, green, ready, up-to-date
 * PR was refused for a reason the detail does not show: it reads `mergeable`,
 * the refusal stays soft, and the forge's own words go on the card.
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
 * Derived from the facts the board branches on, so it cannot disagree with the
 * verdict. `null` is a failed probe: say the read failed and pass on its words
 * (usually the fix), never that the forge gave no reason.
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
 * A host-refused merge: the probe's concrete cause leads, the forge's text
 * follows (or stands alone). The forge's text is shown, never parsed.
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
