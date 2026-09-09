/**
 * The board card's schedule pill (T3O-19, D9/D11) — pure, so its wording is
 * testable without rendering a card.
 *
 * The LABEL is absolute (`9:00 PM`, `tomorrow 8:00 AM`) and only the TOOLTIP is
 * relative. That is what lets thirty of these sit on a board and repaint only
 * when their card does: a relative label would either tick continuously or lie,
 * and this repo refuses both.
 */
import { untilLabel, whenLabel } from "./boardSchedule";

export interface BoardCardScheduleLabel {
  readonly label: string;
  readonly tooltip: string;
}

export function boardCardScheduleLabel(input: {
  readonly scheduledStartAt: string | null;
  /** A done card is asking for nothing and is not going to move on a timer. */
  readonly done: boolean;
  /** Whether the card's step is parked, so the tooltip says RESUME rather than
      start. Read off the shell flags the card face already holds, which is why
      this surface needs no stage name: the verb has to match the popover's
      (`boardScheduleSetTip`), or the same card would claim two different
      things depending on where you hovered it. */
  readonly parked: boolean;
  readonly nowMs: number;
}): BoardCardScheduleLabel | null {
  if (input.scheduledStartAt === null || input.done) return null;
  const label = whenLabel(input.scheduledStartAt, input.nowMs);
  if (label === "") return null;
  const until = untilLabel(input.scheduledStartAt, input.nowMs);
  const verb = input.parked ? "resume" : "start";
  return { label, tooltip: `Scheduled to ${verb} ${label} · ${until}` };
}
