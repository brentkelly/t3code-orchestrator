/**
 * Whether a mobile card's merge is held by a conflict or CI fix (T3O-9 / T3O-12).
 *
 * Same ranking and button copy as web `boardConflictFix`: a CI fix outranks a
 * conflict rewrite, and the pill names the hold even while the fix is queued.
 */
import type { BoardCardShell } from "@t3tools/contracts";

export type BoardMergeHold = {
  readonly label: string;
  readonly mergeDisabledReason: string;
};

export function boardMergeHold(
  card: Partial<Pick<BoardCardShell, "stepConflictFix" | "stepChecksFix">> | null | undefined,
): BoardMergeHold | null {
  if (card?.stepChecksFix === true) {
    return { label: "Fixing CI", mergeDisabledReason: "Fixing CI…" };
  }
  if (card?.stepConflictFix === true) {
    return { label: "Conflicts", mergeDisabledReason: "Resolving conflicts…" };
  }
  return null;
}
