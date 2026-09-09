/**
 * The board card's schedule pill (T3O-19, D9/D11).
 */
import { describe, expect, it } from "vite-plus/test";

import { boardCardScheduleLabel } from "./boardCardScheduleLabel";

const NOW_MS = new Date(2026, 2, 4, 14, 30, 0, 0).getTime();
const at = (hour: number, day = 4) => new Date(2026, 2, day, hour, 0, 0, 0).toISOString();

describe("boardCardScheduleLabel", () => {
  it("is absent on an unscheduled card, so it costs the common card nothing", () => {
    expect(
      boardCardScheduleLabel({ scheduledStartAt: null, done: false, parked: false, nowMs: NOW_MS }),
    ).toBeNull();
  });

  it("pairs an absolute label with a relative tooltip", () => {
    const pill = boardCardScheduleLabel({
      scheduledStartAt: at(21),
      done: false,
      parked: false,
      nowMs: NOW_MS,
    });
    // The label never goes stale; only the tooltip counts down, and it is
    // computed once at render rather than on a timer.
    expect(pill?.label).toBe("9:00 PM");
    expect(pill?.tooltip).toBe("Scheduled to start 9:00 PM · in 6h 30m");
  });

  it("says resume for a parked card, matching what the popover says", () => {
    // The same card must not claim two different things depending on which
    // surface you hovered it on.
    expect(
      boardCardScheduleLabel({
        scheduledStartAt: at(21),
        done: false,
        parked: true,
        nowMs: NOW_MS,
      })?.tooltip,
    ).toBe("Scheduled to resume 9:00 PM · in 6h 30m");
  });

  it("says nothing on a done card, which is not going to move on a timer", () => {
    expect(
      boardCardScheduleLabel({
        scheduledStartAt: at(21),
        done: true,
        parked: false,
        nowMs: NOW_MS,
      }),
    ).toBeNull();
  });

  it("drops the pill once the moment has passed, rather than wearing a stale time", () => {
    // `schedule()` admits a due card without clearing the field, so a card can
    // be RUNNING with its time still set until the next 30s firing pass. A pill
    // naming a moment that has gone would be a lying label for that window.
    expect(
      boardCardScheduleLabel({
        scheduledStartAt: at(14),
        done: false,
        parked: false,
        nowMs: NOW_MS,
      }),
    ).toBeNull();
  });

  it("keeps the pill right up to the instant itself", () => {
    expect(
      boardCardScheduleLabel({
        scheduledStartAt: new Date(NOW_MS + 1).toISOString(),
        done: false,
        parked: false,
        nowMs: NOW_MS,
      })?.label,
    ).toBe("2:30 PM");
  });

  it("renders no pill for a value it cannot read, rather than an empty chip", () => {
    expect(
      boardCardScheduleLabel({
        scheduledStartAt: "soon",
        done: false,
        parked: false,
        nowMs: NOW_MS,
      }),
    ).toBeNull();
  });
});
