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
  readonly nowMs: number;
}): BoardCardScheduleLabel | null {
  if (input.scheduledStartAt === null || input.done) return null;
  const label = whenLabel(input.scheduledStartAt, input.nowMs);
  if (label === "") return null;
  const until = untilLabel(input.scheduledStartAt, input.nowMs);
  return { label, tooltip: `Scheduled to start ${label} · ${until}` };
}
