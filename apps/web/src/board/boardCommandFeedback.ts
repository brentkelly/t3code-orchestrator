/**
 * T3o board command feedback (t3o-06). One place that turns a rejected board
 * command into a human sentence — the decider's invariant rejections carry a
 * `detail` string (the unmet dependency, the cycle-closing edge, the label
 * cap), and that is what the user needs to see, not a generic failure.
 */
import type { BoardMergeCardPullRequestResult } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

/** The invariant `detail` when the failure carries one, else the error
    message, else a generic fallback. */
export function describeBoardCommandFailure(result: unknown): string {
  const error: unknown = squashAtomCommandFailure(
    result as Parameters<typeof squashAtomCommandFailure>[0],
  );
  if (
    typeof error === "object" &&
    error !== null &&
    "detail" in error &&
    typeof error.detail === "string"
  ) {
    return error.detail;
  }
  return error instanceof Error ? error.message : "The server rejected the command.";
}

/**
 * The sentence a Merge click leaves on the card.
 *
 * Every outcome is a normal answer rather than an error, so each gets a
 * message written for someone who just pressed the button and wants to know
 * what to do next. A forge refusal is quoted verbatim: GitHub already explains
 * why it will not merge — which check failed, which approval is missing — and
 * paraphrasing that would only lose detail.
 *
 * `merged` returns null: the card visibly moves to Done, which says it better
 * than a sentence would.
 */
export function describeBoardMergeOutcome(result: BoardMergeCardPullRequestResult): string | null {
  switch (result.outcome) {
    case "merged":
      return null;
    case "conflict":
      return "The branch conflicts with its base. Resolving the conflicts, then merging.";
    case "refused":
      return result.detail && result.detail.length > 0
        ? result.detail
        : "The forge refused the merge.";
    case "not-open":
      return result.state === "merged"
        ? "This pull request has already been merged."
        : "This pull request is closed.";
    case "no-pull-request":
      return "This card has no pull request to merge.";
    case "no-workspace":
      return "This card has no workspace to merge from.";
    case "wrong-stage":
      return "Move the card to the merge stage before merging.";
    case "unknown-card":
      return "This card no longer exists.";
  }
}
