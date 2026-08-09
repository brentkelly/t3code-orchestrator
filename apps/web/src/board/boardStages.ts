/**
 * T3o board stage presentation (t3o-05). `BOARD_STAGES` in contracts is the
 * single source of stage order; this maps each stage to its column label.
 */
import type { BoardStage } from "@t3tools/contracts";

export const BOARD_STAGE_LABELS: Record<BoardStage, string> = {
  backlog: "Backlog",
  sprint: "Sprint",
  planning: "Planning",
  ready: "Ready",
  building: "Building",
  review: "Code review",
  merge: "Ready for merge",
  done: "Done",
};
