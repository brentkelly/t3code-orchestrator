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
 * 4. **The rest of the attention chip** — `Needs a human`, `Stalled`, `Paused`,
 *    `No convergence`, an approval. Every one of them is the generic reading of
 *    what 2 and 3 say precisely, which is why they lose to them rather than
 *    stacking beside them.
 * 5. **The dependency gate.** Last because it is the one notice whose fact
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
  | { readonly kind: "blocked"; readonly dependencyCount: number };

/** The one notice a card header shows, or null when it has nothing to say. */
export function boardCardNotice(input: {
  /** `boardCardAttention`'s chip, already suppressed by the card where the
      summary's round row says the same thing. */
  readonly attention: BoardCardNoticeAttention | null;
  readonly conflictFix: BoardConflictFixInfo | null;
  readonly autoMergeHold: BoardAutoMergePill | null;
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
  if (attention !== null) return { kind: "attention", attention };
  if (input.blocked) return { kind: "blocked", dependencyCount: input.dependencyCount };
  return null;
}
