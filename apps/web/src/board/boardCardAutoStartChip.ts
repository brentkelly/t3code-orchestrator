/**
 * The board card's auto-start chip (T3O-24, D8) — pure, so its wording and its
 * precedence against the schedule pill are testable without rendering a card.
 *
 * Neutral, never coloured, for the schedule pill's own documented reason: the
 * card is not running, not done, and nothing is waiting on a human. The close
 * call is amber, which `docs/t3o/status-colours.md` gives to "blocked or held",
 * and an armed card IS held — but amber's claim is "this will never move until
 * someone acts", which is precisely false of a card that moves itself.
 *
 * The label is static, so thirty of these repaint only when their card does.
 */
export interface BoardCardAutoStartChip {
  readonly label: string;
  readonly tooltip: string;
}

export function boardCardAutoStartChip(input: {
  readonly autoStart: boolean;
  /** A done card is asking for nothing and is not going to move on its own.
      The server clears the arm as the card leaves the pre-build stage, so this
      only covers the tick before that lands. */
  readonly done: boolean;
  /** Whether the card already wears a schedule pill. ONE slot in the card's
      right-hand cluster, and a schedule names a concrete moment, so it is the
      more specific claim and wins (D8: schedule > auto-start > queue). */
  readonly scheduled: boolean;
}): BoardCardAutoStartChip | null {
  if (!input.autoStart || input.done || input.scheduled) return null;
  // The tooltip does not NAME the blockers. The card shell carries a dependency
  // COUNT, not the edges (D7's byte budget), so a column card cannot resolve a
  // key without new payload on every card — and the general sentence is true of
  // every armed card. Open the card to see who it is waiting for; the blocked
  // callout there names them.
  return { label: "Auto-start", tooltip: "Starts automatically when its dependencies are done" };
}
