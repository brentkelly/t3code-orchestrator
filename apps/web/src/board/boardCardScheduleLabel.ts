/**
 * The board card's schedule pill (T3O-19, D9/D11) — pure, so its wording is
 * testable without rendering a card.
 *
 * The LABEL is absolute (`9:00 PM`, `tomorrow 8:00 AM`) and only the TOOLTIP is
 * relative. That is what lets thirty of these sit on a board and repaint only
 * when their card does: a relative label would either tick continuously or lie,
 * and this repo refuses both.
 */
import { isBoardCardScheduleDue } from "@t3tools/contracts";

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
  const at = input.scheduledStartAt;
  if (at === null || input.done) return null;
  // No pill once the moment has passed. `schedule()` admits a due card WITHOUT
  // clearing the field — only the 30s firing pass clears it — so a card can be
  // running for up to a tick with its time still set, and a pill naming a
  // moment that has gone is a stale label. Sharing `isBoardCardScheduleDue`
  // with the supervisor's gate and the queue derivation is what keeps the pill
  // and the thing it describes from disagreeing; it also covers an instant
  // this client cannot read, which is due by the same rule.
  if (isBoardCardScheduleDue(at, input.nowMs)) return null;
  const label = whenLabel(at, input.nowMs);
  const until = untilLabel(at, input.nowMs);
  const verb = input.parked ? "resume" : "start";
  return { label, tooltip: `Scheduled to ${verb} ${label} · ${until}` };
}
