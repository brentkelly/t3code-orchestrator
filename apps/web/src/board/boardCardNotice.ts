/**
 * Ranks a card's candidate notices into its one header slot, most specific
 * first: worker trouble (a provider stall included), a question, conflicts,
 * auto-merge hold, no PR at merge, the attention chip, the dependency gate, a
 * kept worktree. Not a tone ranking.
 */
import { BOARD_ATTENTION_SETTLE_MS } from "@t3tools/contracts";
import type {
  BoardCardAttentionReason,
  BoardCardAttentionTone,
  BoardCardStepStalledReason,
} from "@t3tools/contracts";

import type { BoardAutoMergePill } from "./boardAutoMergeHold";
import type { BoardConflictFixInfo } from "./boardConflictFix";
import type { BoardCardMoveNotice, BoardCardWorkerTrouble } from "./workers/cardWorker";

/** Whether the card's step stalled on its provider before it started: not on
    the card's worker (T3O-65), or turned off for its project (T3O-74). */
export function boardCardProviderStalled(card: {
  readonly stalled: boolean;
  readonly stalledReason?: BoardCardStepStalledReason | null | undefined;
}): boolean {
  return (
    card.stalled &&
    (card.stalledReason === "provider-not-on-worker" ||
      card.stalledReason === "provider-disabled-for-project")
  );
}

/** The attention chip as the card renders it — `boardCardAttention`'s answer
    after the card has resolved a parent's inherited child attention into the
    words it shows, which is why this is not `BoardCardAttention` itself. */
export interface BoardCardNoticeAttention {
  readonly reason: BoardCardAttentionReason;
  readonly tone: BoardCardAttentionTone;
  readonly label: string;
  readonly tooltip: string;
}

/** The winner, tagged by where it came from, because each source keeps its own
    glyph and tone in the card. */
export type BoardCardNotice =
  | { readonly kind: "attention"; readonly attention: BoardCardNoticeAttention }
  | { readonly kind: "conflicts"; readonly fix: BoardConflictFixInfo }
  | { readonly kind: "auto-merge"; readonly pill: BoardAutoMergePill }
  /** T3o: parked at the merge role with nothing to merge. */
  | { readonly kind: "no-pull-request" }
  | { readonly kind: "blocked"; readonly dependencyCount: number }
  /** A finished card still holding its worktree, and why. */
  | { readonly kind: "worktree-kept"; readonly reason: string }
  /** The card's project no longer uses the stage it sits in. */
  | { readonly kind: "stage-gone"; readonly note: string }
  /** The card is moving to another worker, or its move failed. */
  | { readonly kind: "worker-move"; readonly move: BoardCardMoveNotice }
  /** The card's worker was removed, or is offline. */
  | { readonly kind: "worker"; readonly trouble: BoardCardWorkerTrouble };

/** The one notice a card header shows, or null when it has nothing to say. */
export function boardCardNotice(input: {
  /** `boardCardAttention`'s chip, already suppressed by the card where the
      summary's round row says the same thing. */
  readonly attention: BoardCardNoticeAttention | null;
  readonly conflictFix: BoardConflictFixInfo | null;
  readonly autoMergeHold: BoardAutoMergePill | null;
  /** The card is at the merge-role stage with no pull request. Merge role only:
      a review card legitimately has none yet. */
  readonly noPullRequestAtMerge: boolean;
  /** `BoardCardShell.blocked`: the dependency gate, which bites from the build
      role onward. */
  readonly blocked: boolean;
  readonly dependencyCount: number;
  /** Why a finished card kept its worktree, or null when it has not
      (`boardCardWorktreeKept`, resolved by the board page). */
  readonly worktreeKeptReason?: string | null | undefined;
  /** Why the card's stage is no longer in its project's pipeline. */
  readonly stageGone?: string | null | undefined;
  /** Moving (blue) or Move failed (amber), or null. */
  readonly workerMove?: BoardCardMoveNotice | null | undefined;
  /** Worker removed or Worker offline (`boardCardWorkerTrouble`). */
  readonly workerTrouble?: BoardCardWorkerTrouble | null | undefined;
  /** The attention chip is a provider stall (`boardCardProviderStalled`),
      which ranks with the worker notices rather than among the generic chips. */
  readonly providerMissing?: boolean | undefined;
}): BoardCardNotice | null {
  const attention = input.attention;
  // The card's worker comes first: removed, then offline — one
  // value, which `boardCardWorkerTrouble` already ranks — then a step whose
  // provider the worker doesn't have.
  if (input.workerTrouble != null) return { kind: "worker", trouble: input.workerTrouble };
  if (input.providerMissing === true && attention !== null) return { kind: "attention", attention };
  // A permission prompt is as answerable as a question, so it takes
  // the same carve-out.
  if (attention !== null && (attention.reason === "input" || attention.reason === "permission")) {
    return { kind: "attention", attention };
  }
  // A card mid-move, or whose move failed, can do nothing else until the move
  // lands or a human retries it: that is the one thing worth saying.
  if (input.workerMove != null) return { kind: "worker-move", move: input.workerMove };
  // A conflict fix RUNS and a hold WAITS; the server never records both, and a
  // running agent is the more specific claim if they somehow collide.
  if (input.conflictFix !== null) return { kind: "conflicts", fix: input.conflictFix };
  if (input.autoMergeHold !== null) return { kind: "auto-merge", pill: input.autoMergeHold };
  // Above the generic attention chip because it NAMES the thing that is wrong;
  // below the two pills above because both of those describe a card that does
  // have a pull request, and so are more specific still.
  if (input.noPullRequestAtMerge) return { kind: "no-pull-request" };
  if (attention !== null) return { kind: "attention", attention };
  if (input.blocked) return { kind: "blocked", dependencyCount: input.dependencyCount };
  if (input.stageGone != null) return { kind: "stage-gone", note: input.stageGone };
  if (input.worktreeKeptReason != null) {
    return { kind: "worktree-kept", reason: input.worktreeKeptReason };
  }
  return null;
}

/**
 * Whether a card is parked at the merge-role stage with no pull request. Uses
 * the attention settle grace, since a card is briefly PR-less while the lookup
 * runs; no idle timestamp fails open. No branch condition: the pane explains.
 */
export function boardCardNoPullRequest(input: {
  /** The card is in the stage carrying the `merge` role. */
  readonly atMergeStage: boolean;
  /** `BoardCardShell.hasPr`: true whatever the pull request's state, so a card
      whose PR is already merged never wears this. */
  readonly hasPr: boolean;
  /** When the card's active thread last finished a turn, joined from the thread
      shells the board already holds (`deriveBoardThreadIdleSince`). */
  readonly threadIdleSince?: string | null | undefined;
  /** Epoch millis to measure the grace against, passed in for the same reason
      `boardCardAttention` takes it: so thirty cards share one clock. */
  readonly now?: number | undefined;
}): boolean {
  // A Done card needs no guard of its own: it is not at the merge stage, which
  // is what `atMergeStage` already says.
  if (!input.atMergeStage || input.hasPr) return false;
  const idleSince = input.threadIdleSince == null ? Number.NaN : Date.parse(input.threadIdleSince);
  const settling =
    input.now !== undefined &&
    Number.isFinite(idleSince) &&
    input.now - idleSince < BOARD_ATTENTION_SETTLE_MS;
  return !settling;
}
