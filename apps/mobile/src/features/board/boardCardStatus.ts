/**
 * One status word for a mobile board row (T3O-18), coloured per
 * `docs/t3o/status-colours.md`.
 */
import {
  boardCardAttention,
  effectiveBoardStageRole,
  isBoardCardWorking,
  type BoardCardShell,
  type BoardStageDefinition,
} from "@t3tools/contracts";
import type { StatusTone } from "../../components/StatusPill";

export type BoardCardStatusKind = "success" | "info" | "attention" | "warning" | "neutral";

export const BOARD_CARD_STATUS_TONES: Record<BoardCardStatusKind, Omit<StatusTone, "label">> = {
  success: {
    pillClassName: "bg-adaptive-emerald-500-a12-a16",
    textClassName: "text-adaptive-emerald-700-300",
  },
  info: {
    pillClassName: "bg-update",
    textClassName: "text-update-foreground",
  },
  attention: {
    pillClassName: "bg-adaptive-violet-500-a12-a16",
    textClassName: "text-adaptive-violet-700-300",
  },
  warning: {
    pillClassName: "bg-warning",
    textClassName: "text-warning-foreground",
  },
  neutral: {
    pillClassName: "bg-subtle",
    textClassName: "text-foreground-secondary",
  },
};

export type BoardCardStatusCard = Parameters<typeof boardCardAttention>[0]["card"] &
  Pick<BoardCardShell, "blocked" | "queued">;

export function boardCardStatus(input: {
  readonly card: BoardCardStatusCard;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly now?: number;
}): StatusTone | null {
  const { card, stages } = input;
  if (card.archivedAt !== null) {
    return status("success", "Archived");
  }
  const stage = stages.find((entry) => entry.stageId === card.stage);
  if (stage !== undefined && effectiveBoardStageRole(stage) === "done") {
    return status("success", "Done");
  }
  if (isBoardCardWorking(card)) {
    return status("info", "Running");
  }
  const attention = boardCardAttention({ card, stages, now: input.now });
  // A pending question or permission prompt is answerable in one tap, the same
  // carve-out `boardCardNotice` and `docs/t3o/status-colours.md` give it over
  // the dependency gate. `blocked` and `queued` stay after that so they cannot
  // hide the violet pill.
  if (attention !== null && (attention.reason === "input" || attention.reason === "permission")) {
    return status("attention", attention.label);
  }
  if (card.queued) {
    return status("neutral", "Queued");
  }
  if (card.blocked) {
    return status("warning", "Blocked");
  }
  if (attention === null) return null;
  if (attention.tone === "attention") return status("attention", attention.label);
  if (attention.tone === "warning") return status("warning", attention.label);
  return status("neutral", attention.label);
}

function status(kind: BoardCardStatusKind, label: string): StatusTone {
  return { label, ...BOARD_CARD_STATUS_TONES[kind] };
}
