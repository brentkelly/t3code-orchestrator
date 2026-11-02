/**
 * The words for a card's merge strategy override (T3O-80): the kebab row's
 * value, the header pill and its tooltip, and the popover's options. One place,
 * so the row, the pill and the popover cannot disagree about the same card.
 */
import {
  resolveBoardCardMergeStrategy,
  type BoardCard,
  type BoardMergeStrategy,
} from "@t3tools/contracts";

const BOARD_MERGE_STRATEGIES: ReadonlyArray<BoardMergeStrategy> = ["squash", "merge", "rebase"];

const LABELS: Record<BoardMergeStrategy, string> = {
  squash: "Squash",
  merge: "Merge commit",
  rebase: "Rebase",
};

const NOTES: Record<BoardMergeStrategy, string> = {
  squash: "One commit; the branch's history is dropped.",
  merge: "Keeps the branch's ancestry; required for upstream syncs.",
  rebase: "Replays the branch's commits linearly onto the base.",
};

const VERBS: Record<BoardMergeStrategy, string> = {
  squash: "Squashes into one commit",
  merge: "Merges with a merge commit",
  rebase: "Rebases onto the base",
};

export interface BoardCardMergeStrategyOption {
  /** null is the "follow the default" option, which clears the override. */
  readonly value: BoardMergeStrategy | null;
  readonly label: string;
  readonly note: string;
}

export interface BoardCardMergeStrategyView {
  /** What the card's pull request will merge with. */
  readonly effective: BoardMergeStrategy;
  /** The kebab row's value: the strategy, plus where it came from unless it is
      the card's own (`squash · default`, `merge · parent`). */
  readonly menuValue: string;
  /** The header pill, shown only when the card has its OWN value — even one
      equal to the default, because it pins the card if the default moves. */
  readonly pill: { readonly label: string; readonly tooltip: string } | null;
  readonly options: ReadonlyArray<BoardCardMergeStrategyOption>;
}

export function boardCardMergeStrategyView(input: {
  readonly card: Pick<BoardCard, "mergeStrategy">;
  /** The sub-board parent's key and own strategy; null for a top-level card. */
  readonly parent: {
    readonly key: string;
    readonly mergeStrategy: BoardMergeStrategy | null;
  } | null;
  /** The merge-role stage's configured strategy. */
  readonly boardStrategy: BoardMergeStrategy;
}): BoardCardMergeStrategyView {
  const { strategy, source } = resolveBoardCardMergeStrategy({
    card: input.card,
    parent: input.parent,
    stageStrategy: input.boardStrategy,
  });
  const parentStrategy = input.parent?.mergeStrategy ?? null;
  const fallback =
    input.parent !== null && parentStrategy !== null
      ? {
          label: `Use parent (${parentStrategy} · ${input.parent.key})`,
          note: "Follows the parent card's setting.",
          baseline: `the parent's setting (${parentStrategy} · ${input.parent.key})`,
        }
      : {
          label: `Use board default (${input.boardStrategy})`,
          note: "Follows the merge stage's setting.",
          baseline: `the board default (${input.boardStrategy})`,
        };
  const own = input.card.mergeStrategy;
  return {
    effective: strategy,
    menuValue:
      source === "card" ? strategy : `${strategy} · ${source === "parent" ? "parent" : "default"}`,
    pill:
      own === null
        ? null
        : { label: LABELS[own], tooltip: `${VERBS[own]} instead of ${fallback.baseline}` },
    options: [
      { value: null, label: fallback.label, note: fallback.note },
      ...BOARD_MERGE_STRATEGIES.map((value) => ({
        value,
        label: LABELS[value],
        note: NOTES[value],
      })),
    ],
  };
}
