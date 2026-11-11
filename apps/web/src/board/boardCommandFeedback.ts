/**
 * T3o board command feedback. One place that turns a rejected board
 * command into a human sentence — the decider's invariant rejections carry a
 * `detail` string (the unmet dependency, the cycle-closing edge, the label
 * cap), and that is what the user needs to see, not a generic failure.
 */
import type {
  BoardCheckCardWorktreeResult,
  BoardMergeCardPullRequestResult,
  BoardRefreshCardPullRequestResult,
  BoardRemoveCardWorktreeResult,
  BoardRequestReviewRoundResult,
  BoardSkipCiResult,
  BoardSubmitCardForMergeResult,
} from "@t3tools/contracts";
import { boardCardWorktreeKeptReason } from "@t3tools/contracts";
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
 * The sentence a Merge click leaves on the card. Forge refusals are quoted
 * verbatim. `merged` returns null: the card visibly moves to Done.
 */
export function describeBoardMergeOutcome(result: BoardMergeCardPullRequestResult): string | null {
  switch (result.outcome) {
    case "merged":
      return null;
    case "conflict":
      return "The branch conflicts with its base. Resolving the conflicts, then merging.";
    case "checks-fix":
      return "The pull request's checks failed. Fixing them, then merging once CI passes.";
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
    case "stale-base":
      return "The base branch moved since this card's last review round. The card went back to review to rebase and re-review before merging.";
    case "unknown-card":
      return "This card no longer exists.";
  }
}

/**
 * The sentence "Check again" leaves on the card. Every arm answers because a
 * successful re-check may change nothing visible; only `linked` is silent, as
 * the Merge button appears.
 */
export function describeBoardRefreshOutcome(
  result: BoardRefreshCardPullRequestResult,
  branch: string | null,
): string | null {
  const on = branch === null ? "" : ` for ${branch}`;
  switch (result.outcome) {
    case "linked":
      return null;
    case "none":
      return `Still no pull request${on}.`;
    // The forge's own words — a rate limit, a signed-out CLI, a network
    // failure. This is the case the old fire-and-forget refresh could not
    // express at all, and the one where retrying is worth anything.
    case "lookup-failed":
      return result.detail.length > 0
        ? `Could not reach the forge: ${result.detail}`
        : "Could not reach the forge.";
    case "no-branch":
      return "This card has no branch to look a pull request up for.";
    case "unknown-card":
      return "This card no longer exists.";
  }
}

/**
 * The sentence "Submit for merge (no review)" leaves on the card. `started`
 * returns null: the card visibly picks up the step.
 */
export function describeBoardSubmitOutcome(result: BoardSubmitCardForMergeResult): string | null {
  switch (result.outcome) {
    case "started":
      return null;
    case "wrong-stage":
      return "This card is no longer in the build stage.";
    case "step-running":
      return "Something is already running on this card. Wait for it to finish, then try again.";
    case "no-branch":
      return "This card has no branch to push.";
    case "no-merge-stage":
      return "This board has no merge stage to send the card to.";
    case "blocked":
      return "This card is blocked by unmet dependencies.";
    // The gate wrote the sentence — it names the plan cards still running, or
    // the split still waiting on approval, and there is nothing to add.
    case "refused":
      return result.detail;
    case "unknown-card":
      return "This card no longer exists.";
    case "failed":
      return "The submission could not be started. See the server log for details.";
  }
}

/**
 * The sentence "Another review round" / "Request review" leaves on the card.
 * `started` answers too: a converged loop may not visibly move.
 */
export function describeBoardReviewRoundOutcome(
  result: BoardRequestReviewRoundResult,
): string | null {
  switch (result.outcome) {
    case "started":
      return result.round === 1
        ? "Review round 1 is starting on this branch."
        : `Review round ${result.round} is starting on this branch.`;
    case "no-review-stage":
      return "This board has no review stage to run a round in.";
    case "wrong-stage":
      return "Another review round can only be asked for from the review or merge stage.";
    case "step-running":
      return "Something is already running on this card. Wait for it to finish, then try again.";
    case "no-branch":
      return "This card has no branch to review.";
    case "unknown-card":
      return "This card no longer exists.";
    case "stuck":
      return "The review is stuck. Rule on the stuck findings in Code review (Fix it or Reviewer is wrong), or advance the card. If the card has left Code review, move it back there first.";
    case "not-stuck":
      return "The review is no longer stuck, so there is nothing to rule on.";
    case "failed":
      return "The review round could not be started. See the server log for details.";
  }
}

/**
 * The sentence "Remove worktree" leaves on the card, or null when it
 * did what was asked — the banner disappearing is the acknowledgement.
 */
export function describeBoardRemoveWorktreeOutcome(
  result: BoardRemoveCardWorktreeResult,
): string | null {
  switch (result.outcome) {
    case "removed":
    case "no-worktree":
      return null;
    case "not-finished":
      return "Only a card in Done or the archive can have its worktree removed.";
    case "unknown-card":
      return "This card no longer exists.";
    case "failed":
      return "The worktree could not be removed. See the server log for details.";
  }
}

/**
 * The sentence "Check again" on a kept worktree leaves on the card,
 * or null when the worktree went — the banner disappearing says that. A
 * repeat refusal writes nothing to the card, so without this the banner would
 * look exactly as it did before the click.
 */
export function describeBoardCheckWorktreeOutcome(
  result: BoardCheckCardWorktreeResult,
): string | null {
  switch (result.outcome) {
    case "removed":
    case "no-worktree":
      return null;
    case "kept":
      return `Still kept: ${boardCardWorktreeKeptReason(result.reason)}.`;
    case "busy":
      return "A cleanup of this worktree is already running. Check again in a moment.";
    case "not-finished":
      return "This card's worktree isn't cleaned up automatically: it is not archived, and either not in Done or Done cleanup is off.";
    case "unknown-card":
      return "This card no longer exists.";
    case "failed":
      return "The worktree could not be checked. See the server log for details.";
  }
}

/** The toast "Skip CI" leaves. `stageLabel` names where it went. */
export function describeBoardSkipCiOutcome(
  result: BoardSkipCiResult,
  cardKey: string,
  stageLabel: (stageId: string) => string,
): { readonly title: string; readonly description?: string; readonly tone: "info" | "error" } {
  switch (result.outcome) {
    case "skipped":
      return {
        title: `CI skipped for ${cardKey}`,
        description:
          result.toStage === null
            ? "The skip is recorded on the card under your name."
            : `Moved to ${stageLabel(result.toStage)}. The skip is recorded on the card under your name.`,
        tone: "info",
      };
    case "not-in-ci":
      return { title: `${cardKey} is no longer in CI`, tone: "info" };
    case "unknown-card":
      return { title: "This card no longer exists.", tone: "error" };
    case "failed":
      return {
        title: "CI could not be skipped",
        description: "See the server log for details.",
        tone: "error",
      };
  }
}
