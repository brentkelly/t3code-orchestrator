/**
 * Turns a refused auto-merge into a classification and the words the card
 * shows. Pure, so the hard-versus-soft judgement is testable without a forge.
 * Invariant: anything unrecognised degrades to SOFT; a wrong hard verdict
 * parks a card until somebody notices.
 */
import {
  BOARD_AUTO_MERGE_MAX_ATTEMPTS,
  boardAutoMergeRetryDelayMs,
  type BoardCardAutoMergeClassification,
} from "@t3tools/contracts";

import type { BoardMergeState } from "./boardMergeState.ts";

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
function describe(state: BoardMergeState): string | null {
  const { total, passed, failing, running } = state.checks;
  if (total === 0) return null;
  const head = `${passed} of ${total} check${total === 1 ? "" : "s"} green`;
  if (failing.length > 0) return `${head} · ${nameList(failing)} failed`;
  if (running.length > 0) return `${head} · ${nameList(running)} still running`;
  return head;
}

/**
 * Order matters: a failed required check is the only verdict that survives a
 * green-looking rollup, pending checks always mean wait, and only a block the
 * detail names stops the ladder. Everything green waits with the forge's words.
 */
export function classifyBoardAutoMergeRefusal(state: BoardMergeState): BoardAutoMergeVerdict {
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
      case null:
        break;
    }
  }
  // The forge says it is mergeable and refused anyway, or blocked without a
  // reason the detail names. We do not understand that, so we wait, which is
  // the safe direction. The card shows the forge's own words meanwhile.
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
 * `previousAttempt` is the attempt count of the card's existing hold, or 0. A
 * new head sha resets it to 0 (new commits mean new CI), once per distinct sha.
 * A non-soft classification stops the ladder at once, whatever rungs remain.
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
