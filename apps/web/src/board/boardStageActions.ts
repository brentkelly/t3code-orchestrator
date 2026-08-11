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
  /**
   * Whether the button is the filled, accented one. The prototype fills the
   * gates that *commit* work — sprint intake, planning kickoff, the build
   * crossing and the merge — and leaves the approvals (a plan, a review) as
   * quiet outline buttons, so the loud button is never the one you click
   * without reading.
   */
  readonly emphasised: boolean;
}

export function boardStagePrimaryAction(stage: BoardStage): BoardStagePrimaryAction | null {
  switch (stage) {
    case "backlog":
      return { label: "Add to sprint", toStage: "sprint", emphasised: true };
    case "sprint":
      return { label: "Begin planning", toStage: "planning", emphasised: true };
    case "planning":
      return { label: "Approve plan", toStage: "ready", emphasised: false };
    case "ready":
      // "Begin build" commits the card to the build queue (D11); never
      // automatic (D18) — this click is the crossing.
      return { label: "Begin build", toStage: "building", emphasised: true };
    case "building":
      // Board-driven onward (build success) — no human forward gate.
      return null;
    case "review":
      return { label: "Approve review", toStage: "merge", emphasised: false };
    case "merge":
      return { label: "Merge", toStage: "done", emphasised: true };
    case "done":
      return null;
  }
}
