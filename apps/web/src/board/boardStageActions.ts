/**
 * T3o primary stage action (t3o-06, D18). The detail pane's primary button is
 * the human gate that advances a card one stage — the SAME gate a drag or a
 * thread answer resolves. Pure and total over `BoardStage`.
 *
 * Only the human-gated forward transitions from D18 appear here. Building has
 * NO forward button: Building -> Code review is board-driven (the build step
 * reports success), never a human click — encoding it as a button would be a
 * D18 violation. Done has none either (its only exit is archive, a reverse
 * state handled separately).
 */
import type { BoardStage } from "@t3tools/contracts";

export interface BoardStagePrimaryAction {
  readonly label: string;
  readonly toStage: BoardStage;
}

export function boardStagePrimaryAction(stage: BoardStage): BoardStagePrimaryAction | null {
  switch (stage) {
    case "backlog":
      return { label: "Add to sprint", toStage: "sprint" };
    case "sprint":
      return { label: "Begin planning", toStage: "planning" };
    case "planning":
      return { label: "Approve plan", toStage: "ready" };
    case "ready":
      // "Begin build" commits the card to the build queue (D11); never
      // automatic (D18) — this click is the crossing.
      return { label: "Begin build", toStage: "building" };
    case "building":
      // Board-driven onward (build success) — no human forward gate.
      return null;
    case "review":
      return { label: "Approve review", toStage: "merge" };
    case "merge":
      return { label: "Merge", toStage: "done" };
    case "done":
      return null;
  }
}
