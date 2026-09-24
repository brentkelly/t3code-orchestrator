/**
 * T3o board card notice slot (T3O-45). The column card's header has room for
 * ONE status notice, and this ranks the candidates into it.
 *
 * The card shipped with two independent slots — `boardCardAttention`'s chip on
 * the left, the merge pills and the dependency gate on the right — and nothing
 * stopped both from filling. A card whose merge had given up wore
 * `Needs a human` beside `Merge needs you`: the same claim twice, in the same
 * amber, and ~23px wider than the 268px column, so the second chip hung off the
 * card's right edge.
 *
 * The ranking, most specific first:
 *
 * 1. **A pending question.** `input` is a live thread's real question, one click
 *    from being answered — the same carve-out `boardCardAttention` gives it and
 *    `docs/t3o/status-colours.md` spells out. Burying it behind a merge pill
 *    strands the answer.
 * 2. **Conflicts.** A named cause with an agent already on it.
 * 3. **The auto-merge hold.** A named cause with a retry ladder behind it.
 * 4. **No pull request at the merge stage** (T3O-48). A card parked at Ready
 *    for merge with no pull request goes nowhere on its own, and there is
 *    nothing on the card face that says so — the bug that card was filed about
 *    was a human staring at "Ready for merge" with no PR link, no Merge button
 *    and no explanation. Below 2 and 3, which name a MORE specific cause on a
 *    card that does have a pull request; above 5, which is the generic reading.
 * 5. **The rest of the attention chip** — `Needs a human`, `Stalled`, `Paused`,
 *    `No convergence`, an approval. Every one of them is the generic reading of
 *    what 2 and 3 say precisely, which is why they lose to them rather than
 *    stacking beside them.
 * 6. **The dependency gate.** Last because it is the one notice whose fact
 *    survives elsewhere on the card: the meta row's chain icon carries the count
 *    and names the dependencies in its tooltip at every stage.
 *
 * Pure, and deliberately NOT a tone comparison: amber-vs-violet says how loud a
 * notice is, not which fact the human needs, and `Merge needs you` outranking
 * `Needs a human` is a ranking between two ambers.
 *
 * The neutral informational pills — a queue position, a scheduled start, the
 * auto-start arm, the grey `Auto` glyph — are out of scope and keep their own
 * right-hand slot. They assert that nothing is needed from the human, so they
 * are not competing with any of this for the reader's attention, and they are
 * already mutually exclusive among themselves.
 */
import { BOARD_ATTENTION_SETTLE_MS } from "@t3tools/contracts";
import type { BoardCardAttentionReason, BoardCardAttentionTone } from "@t3tools/contracts";

import type { BoardAutoMergePill } from "./boardAutoMergeHold";
import type { BoardConflictFixInfo } from "./boardConflictFix";

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
  /** T3o (T3O-48): parked at the merge role with nothing to merge. */
  | { readonly kind: "no-pull-request" }
  | { readonly kind: "publish-running" }
  | { readonly kind: "publish-failed" }
  | { readonly kind: "blocked"; readonly dependencyCount: number };

/** The one notice a card header shows, or null when it has nothing to say. */
export function boardCardNotice(input: {
  /** `boardCardAttention`'s chip, already suppressed by the card where the
      summary's round row says the same thing. */
  readonly attention: BoardCardNoticeAttention | null;
  readonly conflictFix: BoardConflictFixInfo | null;
  readonly autoMergeHold: BoardAutoMergePill | null;
  /** T3o (T3O-48): the card is at the merge-role stage and has no pull request.
      Resolved by the card face from what it already holds — the stage, that
      stage's role and the shell's `hasPr` — so this costs no new shell bytes.

      The MERGE role only. A card in Code review with no pull request is also
      wrong, but it has a running step and its own notices, and the window
      before the build opens one is legitimate. */
  readonly noPullRequestAtMerge: boolean;
  /** A publish-on-done attempt is in flight. Key-optional on the shell. */
  readonly publishRunning: boolean;
  /** Last publish-on-done attempt failed. Key-optional on the shell. */
  readonly publishFailed: boolean;
  /** `BoardCardShell.blocked`: the dependency gate, which bites from the build
      role onward. */
  readonly blocked: boolean;
  readonly dependencyCount: number;
}): BoardCardNotice | null {
  const attention = input.attention;
  if (attention !== null && attention.reason === "input") return { kind: "attention", attention };
  // A conflict fix RUNS and a hold WAITS; the server never records both, and a
  // running agent is the more specific claim if they somehow collide.
  if (input.conflictFix !== null) return { kind: "conflicts", fix: input.conflictFix };
  if (input.autoMergeHold !== null) return { kind: "auto-merge", pill: input.autoMergeHold };
  // Above the generic attention chip because it NAMES the thing that is wrong;
  // below the two pills above because both of those describe a card that does
  // have a pull request, and so are more specific still.
  if (input.noPullRequestAtMerge) return { kind: "no-pull-request" };
  if (input.publishRunning) return { kind: "publish-running" };
  if (input.publishFailed) return { kind: "publish-failed" };
  if (attention !== null) return { kind: "attention", attention };
  if (input.blocked) return { kind: "blocked", dependencyCount: input.dependencyCount };
  return null;
}

/**
 * Whether a card is parked at the merge-role stage with no pull request
 * (T3O-48) — the `no-pull-request` notice's one input.
 *
 * Pure, and derived entirely from what the card face already holds, so it costs
 * no new shell bytes: the stage's role comes from the column the card is in and
 * `hasPr` is already on the shell.
 *
 * The settle grace is the same one `boardCardAttention` applies to its two
 * "Needs a human" chips, for the same reason and off the same timestamp: a card
 * arriving at Ready for merge is briefly PR-less while the stage-move lookup is
 * still in flight, and a chip that appears for a second and vanishes is worse
 * than no chip. A card with no idle timestamp fails OPEN — there is no evidence
 * the stop is fresh — exactly as the attention chips do.
 *
 * Deliberately no branch condition. A merge-stage card that never built one is
 * the same dead end one step further along, and the shell carries no worktree
 * to test against anyway (D7 payload discipline). The detail pane's notice
 * covers both shapes — the branch named, or saying there is none — so the chip
 * always opens onto an explanation.
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
