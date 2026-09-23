/**
 * The board card's Parked chip (t3o-35, K3) — pure, so its wording is
 * testable without rendering a card.
 *
 * Amber: a parked card will never auto-move until someone acts, which is
 * exactly `docs/t3o/status-colours.md`'s job for amber. The chip is
 * display-only; Unpark lives in the card detail.
 */
export interface BoardCardParkedChip {
  readonly label: string;
  readonly tooltip: string;
}

export function boardCardParkedChip(input: {
  readonly backlogParked: boolean;
}): BoardCardParkedChip | null {
  if (!input.backlogParked) return null;
  return {
    label: "Parked",
    tooltip: "Stays in Backlog until you unpark it",
  };
}
