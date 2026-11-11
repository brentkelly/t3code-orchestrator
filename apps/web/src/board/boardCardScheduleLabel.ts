/**
 * The card's schedule pill. The label is absolute and only the tooltip relative,
 * so the pill repaints only when its card does.
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
  /** Whether the step is parked, so the tooltip says resume, matching the
      popover's verb (`boardScheduleSetTip`). */
  readonly parked: boolean;
  readonly nowMs: number;
}): BoardCardScheduleLabel | null {
  const at = input.scheduledStartAt;
  if (at === null || input.done) return null;
  // No pill once the moment has passed: a due card keeps its time until the next
  // firing pass. `isBoardCardScheduleDue` is shared with the supervisor and the
  // queue, so they cannot disagree.
  if (isBoardCardScheduleDue(at, input.nowMs)) return null;
  const label = whenLabel(at, input.nowMs);
  const until = untilLabel(at, input.nowMs);
  const verb = input.parked ? "resume" : "start";
  return { label, tooltip: `Scheduled to ${verb} ${label} · ${until}` };
}
