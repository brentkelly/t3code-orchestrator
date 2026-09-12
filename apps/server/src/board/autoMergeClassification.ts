/**
 * T3o: turning a refused auto-merge into a decision (T3O-38, D6/D8).
 *
 * Pure and total — a probe in, a classification and the words the card will
 * show out — so the whole of the hard-versus-soft judgement is testable
 * without a forge, a reactor or a clock. The reactor resolves the world; this
 * decides what it means, the same split `recoveryDecision` established.
 *
 * The ONE rule that must never be broken: anything unrecognised degrades to
 * SOFT. A probe we cannot read costs a few extra retries; a wrong hard verdict
 * parks a card until somebody notices, which is the state this whole feature
 * exists to remove.
 */
import {
  BOARD_AUTO_MERGE_MAX_ATTEMPTS,
  boardAutoMergeRetryDelayMs,
  type BoardCardAutoMergeClassification,
  type ChangeRequestMergeState,
} from "@t3tools/contracts";

export interface BoardAutoMergeVerdict {
  readonly classification: BoardCardAutoMergeClassification;
  /** One line of structured colour for the card, or null when the probe said
      nothing worth summarising. Never the forge's prose — that is the
      refusal's own `reason`, recorded beside this. */
  readonly detail: string | null;
  readonly headSha: string | null;
}

/** Join a bounded list of check names the way a sentence would. */
function nameList(names: ReadonlyArray<string>): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] as string}`;
}

/** "3 of 5 checks green · ci/build and ci/e2e still running", or null. */
function describe(state: ChangeRequestMergeState): string | null {
  const { total, passed, failing, running } = state.checks;
  if (total === 0) return null;
  const head = `${passed} of ${total} check${total === 1 ? "" : "s"} green`;
  if (failing.length > 0) return `${head} · ${nameList(failing)} failed`;
  if (running.length > 0) return `${head} · ${nameList(running)} still running`;
  return head;
}

/**
 * Classify a refusal against the forge's structured merge state (D6).
 *
 * Order matters and is the table in the spec: a failed required check is the
 * only verdict that survives a green-looking rollup, pending checks always
 * mean wait, and a block with everything green is the one case where "the
 * forge still says no" can only be a decision the board does not have.
 */
export function classifyBoardAutoMergeRefusal(
  state: ChangeRequestMergeState,
): BoardAutoMergeVerdict {
  const detail = describe(state);
  const headSha = state.headSha;
  const { pending, failed } = state.checks;

  // A required check reported failure. More CI will not happen without a new
  // commit, so every remaining rung would be spent waiting for nothing.
  if (failed > 0) return { classification: "checks-failed", detail, headSha };
  // Still running, or the forge has not finished working out whether it can
  // merge. Both are "ask again shortly".
  if (pending > 0 || state.mergeable === "unknown") {
    return { classification: "soft", detail, headSha };
  }
  if (state.mergeable === "blocked") {
    switch (state.blockedReason) {
      case "behind":
        return { classification: "behind", detail, headSha };
      // A conflict never reaches here in practice — `mergeCardPullRequest`
      // routes it to the conflict-fix step before any probe runs (D8) — but a
      // forge that reports one anyway is structural, not transient.
      case "conflict":
      case "draft":
        return { classification: "other", detail, headSha };
      default:
        // Blocked with every check green: a missing approval, a protection
        // rule, an unresolved conversation. A decision, not a wait.
        return { classification: "approval-required", detail, headSha };
    }
  }
  // The forge says it is mergeable and refused anyway. We do not understand
  // that, so we wait — the safe direction.
  return { classification: "soft", detail, headSha };
}

/** The verdict for a refusal the probe could not classify at all — an
    unsupported provider, or a probe that itself failed. Always soft (D7). */
export const UNCLASSIFIED_AUTO_MERGE_VERDICT: BoardAutoMergeVerdict = {
  classification: "soft",
  detail: null,
  headSha: null,
};

export interface BoardAutoMergeLadderStep {
  /** Which attempt this refusal was, 1-based. */
  readonly attempt: number;
  /** When to try again, or null once the ladder has stopped. */
  readonly retryDelayMs: number | null;
}

/**
 * Where a refusal leaves the ladder (D5/D9).
 *
 * `previousAttempt` is the attempt count the card's existing hold recorded, or
 * 0 when this is the first refusal. A new head sha resets to 0 — new commits
 * mean new CI, so the old ladder's evidence is stale — and because the reset
 * keys on the SHA rather than on a counter, it fires once per distinct sha
 * however many rungs have already passed.
 *
 * A non-soft classification stops the ladder on the spot, whatever rungs
 * remain: that is the entire value of classifying at all. A hard block becomes
 * visible within a few minutes of the first refusal instead of after an hour
 * and a half of a pill that claimed to be waiting.
 */
export function boardAutoMergeLadderStep(input: {
  readonly classification: BoardCardAutoMergeClassification;
  readonly previousAttempt: number;
  readonly previousHeadSha: string | null;
  readonly headSha: string | null;
}): BoardAutoMergeLadderStep {
  const shaChanged =
    input.headSha !== null &&
    input.previousHeadSha !== null &&
    input.headSha !== input.previousHeadSha;
  const base = shaChanged ? 0 : Math.max(0, input.previousAttempt);
  const attempt = Math.min(base + 1, BOARD_AUTO_MERGE_MAX_ATTEMPTS);
  if (input.classification !== "soft") return { attempt, retryDelayMs: null };
  return { attempt, retryDelayMs: boardAutoMergeRetryDelayMs(attempt) };
}
