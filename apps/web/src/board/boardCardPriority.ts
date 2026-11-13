/**
 * Card priority copy and the side panel's rules, shared by the new card dialog, the card
 * panel, the header chip, the board tile and the list view. Pure.
 */
import {
  boardCardPriorityRank,
  effectiveBoardStageRole,
  type BoardCardPriority,
  type BoardStageDefinition,
} from "@t3tools/contracts";

/** Low to Urgent, the segmented control's left-to-right order. */
export const BOARD_CARD_PRIORITIES: ReadonlyArray<BoardCardPriority> = [
  "low",
  "normal",
  "high",
  "urgent",
];

export const BOARD_CARD_PRIORITY_NAME: Record<BoardCardPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

/** What the scheduler does with each level, under its name in the option list. */
export const BOARD_CARD_PRIORITY_RULE: Record<BoardCardPriority, string> = {
  low: "Runs when a slot is free and no higher-priority card is waiting.",
  normal: "First come, first served.",
  high: "Goes ahead of Normal and Low cards.",
  urgent: "Enters Building ahead of every waiting card.",
};

/** The new card dialog's line under the control; only Normal reads differently there. */
export function boardCardPriorityDialogRule(priority: BoardCardPriority): string {
  return priority === "normal"
    ? "Waits its turn behind High and Urgent cards."
    : BOARD_CARD_PRIORITY_RULE[priority];
}

/** Alt+1–4 in the new card dialog, matched on `event.code`: on macOS Alt+digit types a
    character, so `event.key` is not the digit. In a text field that character is real
    typing (Option+2 is `@` on Nordic layouts), so there only an Alt that yields the digit counts. */
export function boardCardPriorityFromShortcut(event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly code: string;
  readonly key: string;
  readonly editable: boolean;
}): BoardCardPriority | null {
  if (!event.altKey || event.ctrlKey || event.metaKey) return null;
  const match = /^Digit([1-4])$/.exec(event.code);
  if (match === null) return null;
  if (event.editable && event.key !== match[1]) return null;
  return BOARD_CARD_PRIORITIES[Number(match[1]) - 1]!;
}

/**
 * The side panel's note on a card the scheduler already ranks ahead of waiting work: one
 * whose step is running, or that is past the first stage that takes a slot (the build role).
 * Never on a queued card that has not started, where priority matters most.
 */
export function boardCardPriorityStartedNote(input: {
  readonly stageId: string;
  readonly running: boolean;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
}): string | null {
  const index = input.stages.findIndex((stage) => stage.stageId === input.stageId);
  const stage = input.stages[index];
  if (stage === undefined || effectiveBoardStageRole(stage) === "done") return null;
  const buildIndex = input.stages.findIndex(
    (candidate) => effectiveBoardStageRole(candidate) === "build",
  );
  const past = buildIndex !== -1 && index > buildIndex;
  if (!past && !input.running) return null;
  return `This card is already in ${stage.label}, so it stays ahead of cards that haven't started. Priority only decides between cards waiting at the same stage.`;
}

/** "Blocks an Urgent card", when a card waiting on this one outranks it. */
export function boardCardBlocksHint(
  own: BoardCardPriority,
  blocked: BoardCardPriority | null,
): string | null {
  if (blocked === null || boardCardPriorityRank(blocked) <= boardCardPriorityRank(own)) {
    return null;
  }
  return blocked === "urgent"
    ? "Blocks an Urgent card"
    : `Blocks a ${BOARD_CARD_PRIORITY_NAME[blocked]} card`;
}
