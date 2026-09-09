/**
 * The card's schedule labels, presets and copy (T3O-19).
 *
 * Every case pins its own "now", so nothing here depends on when the suite
 * runs — and the pill's label is asserted to be the kind of string that does
 * NOT go stale, which is the whole reason it is absolute and the tooltip is
 * relative (D11).
 */
import { describe, expect, it } from "vite-plus/test";

import {
  boardScheduleCopy,
  boardScheduleKind,
  boardScheduleSetTip,
  fromLocalInputValue,
  isoToLocalInputValue,
  localInputValueToIso,
  scheduleInputValue,
  schedulePresets,
  toLocalInputValue,
  untilLabel,
  whenLabel,
} from "./boardSchedule";

/** A fixed local wall clock the cases are read against: 4 March 2026, 2:30pm
    in whatever zone the test runs in, which is what a user's browser reports. */
const NOW = new Date(2026, 2, 4, 14, 30, 0, 0);
const NOW_MS = NOW.getTime();
const at = (input: {
  readonly day?: number;
  readonly hour: number;
  readonly minute?: number;
  readonly month?: number;
}) =>
  new Date(
    2026,
    input.month ?? 2,
    input.day ?? 4,
    input.hour,
    input.minute ?? 0,
    0,
    0,
  ).toISOString();

describe("whenLabel", () => {
  it("says the clock alone for today", () => {
    expect(whenLabel(at({ hour: 21 }), NOW_MS)).toBe("9:00 PM");
  });

  it("names tomorrow, then the weekday, then the date", () => {
    expect(whenLabel(at({ day: 5, hour: 8 }), NOW_MS)).toBe("tomorrow 8:00 AM");
    expect(whenLabel(at({ day: 7, hour: 8 }), NOW_MS)).toBe("Sat 8:00 AM");
    expect(whenLabel(at({ day: 14, hour: 8, month: 9 }), NOW_MS)).toBe("14 Oct, 8:00 AM");
  });

  it("reads midnight and noon as 12, not 0", () => {
    expect(whenLabel(at({ day: 5, hour: 0 }), NOW_MS)).toBe("tomorrow 12:00 AM");
    expect(whenLabel(at({ hour: 12 }), NOW_MS)).toBe("12:00 PM");
  });

  it("is empty for a value that is not an instant, never a broken string", () => {
    expect(whenLabel("tomorrow-ish", NOW_MS)).toBe("");
  });

  // The D11 promise itself: the same instant reads the same at 2:30pm and at
  // 5:00pm on the same day, so nothing has to repaint in between.
  it("does not change as the day wears on", () => {
    const iso = at({ hour: 21 });
    const later = new Date(2026, 2, 4, 17, 0, 0, 0).getTime();
    expect(whenLabel(iso, later)).toBe(whenLabel(iso, NOW_MS));
  });
});

describe("untilLabel", () => {
  it("counts minutes, then hours, then days", () => {
    expect(untilLabel(at({ hour: 14, minute: 45 }), NOW_MS)).toBe("in 15m");
    expect(untilLabel(at({ hour: 16, minute: 30 }), NOW_MS)).toBe("in 2h");
    expect(untilLabel(at({ hour: 17, minute: 0 }), NOW_MS)).toBe("in 2h 30m");
    expect(untilLabel(at({ day: 6, hour: 14, minute: 30 }), NOW_MS)).toBe("in 2d");
  });

  it("says a past time is due now rather than counting backwards", () => {
    expect(untilLabel(at({ hour: 9 }), NOW_MS)).toBe("due now");
  });
});

describe("datetime-local round trip", () => {
  it("survives a trip through the input's local wall clock", () => {
    const iso = at({ day: 5, hour: 8, minute: 30 });
    const value = isoToLocalInputValue(iso);
    expect(value).toBe("2026-03-05T08:30");
    // Only the INSTANT crosses the wire (D12), which is what makes a time set
    // on a laptop read correctly on a phone in another zone.
    expect(localInputValueToIso(value)).toBe(iso);
  });

  it("rejects a half-typed value rather than inventing a date", () => {
    expect(fromLocalInputValue("2026-03-")).toBeNull();
    expect(localInputValueToIso("")).toBeNull();
    expect(toLocalInputValue(NOW)).toBe("2026-03-04T14:30");
  });
});

describe("schedulePresets", () => {
  it("offers three picks, rounded so the picker never lands on 9:37", () => {
    const presets = schedulePresets(NOW_MS);
    expect(presets.map((preset) => preset.label)).toEqual([
      "In 1 hour",
      "Tonight 9:00 PM",
      "Tomorrow 8:00 AM",
    ]);
    expect(whenLabel(presets[0]!.iso, NOW_MS)).toBe("3:30 PM");
    expect(whenLabel(presets[1]!.iso, NOW_MS)).toBe("9:00 PM");
    expect(whenLabel(presets[2]!.iso, NOW_MS)).toBe("tomorrow 8:00 AM");
  });

  it("rolls tonight over to tomorrow once the hour has passed", () => {
    const lateNight = new Date(2026, 2, 4, 23, 15, 0, 0).getTime();
    const presets = schedulePresets(lateNight);
    expect(whenLabel(presets[1]!.iso, lateNight)).toBe("tomorrow 9:00 PM");
  });
});

describe("boardScheduleKind", () => {
  it("reads a card before the build stage as scheduling THE BUILD", () => {
    expect(boardScheduleKind({ atOrAfterBuild: false, stepStatus: null })).toBe("before-build");
  });

  it("reads a card at or past the build stage as scheduling its stage", () => {
    expect(boardScheduleKind({ atOrAfterBuild: true, stepStatus: null })).toBe("waiting");
    expect(boardScheduleKind({ atOrAfterBuild: true, stepStatus: "queued" })).toBe("waiting");
  });

  it("reads a working card as a pause and every parked one as a resume", () => {
    expect(boardScheduleKind({ atOrAfterBuild: true, stepStatus: "running" })).toBe("live");
    for (const status of ["paused", "awaiting-input", "stalled"] as const) {
      expect(boardScheduleKind({ atOrAfterBuild: true, stepStatus: status })).toBe("parked");
    }
  });

  // A parked step outranks the stage: what the control offers is decided by
  // what the card's work is actually doing, not by which column it sits in.
  it("lets a parked step outrank a pre-build stage", () => {
    expect(boardScheduleKind({ atOrAfterBuild: false, stepStatus: "paused" })).toBe("parked");
  });
});

describe("boardScheduleCopy", () => {
  it("promises nothing before the build that planning does not still gate", () => {
    const copy = boardScheduleCopy("before-build", "the build");
    expect(copy.title).toBe("Start the build at");
    expect(copy.note).toContain("planning and approval still need you");
  });

  // The one that matters (D13): setting a time on a working card STOPS it, and
  // the control has to say so before the click rather than after.
  it("says out loud that scheduling a working card stops the agent", () => {
    const copy = boardScheduleCopy("live", "Building");
    expect(copy.title).toBe("Pause and resume at");
    expect(copy.note).toBe("Stops the agent now and picks it up again at that time.");
    // And clearing is the full undo, which is what makes a confirm dialog
    // unnecessary.
    expect(copy.clearLabel).toBe("Clear — keep working");
  });

  it("names the stage once the card is past the build gate", () => {
    expect(boardScheduleCopy("waiting", "Code review").title).toBe("Start Code review at");
    expect(boardScheduleCopy("parked", "Code review").title).toBe("Resume Code review at");
    expect(boardScheduleCopy("parked", "Code review").note).toContain("where it stopped");
  });

  it("gives every situation a way out", () => {
    for (const kind of ["before-build", "waiting", "live", "parked"] as const) {
      expect(boardScheduleCopy(kind, "Building").clearLabel).toMatch(/^Clear — /);
    }
  });
});

describe("boardScheduleSetTip", () => {
  it("carries the absolute and the relative reading together", () => {
    expect(
      boardScheduleSetTip({
        kind: "before-build",
        stageLabel: "the build",
        iso: at({ hour: 21 }),
        nowMs: NOW_MS,
      }),
    ).toBe("Starts the build 9:00 PM · in 6h 30m — click to change");
  });

  it("says resume for a parked card, not start", () => {
    expect(
      boardScheduleSetTip({
        kind: "parked",
        stageLabel: "Building",
        iso: at({ hour: 21 }),
        nowMs: NOW_MS,
      }),
    ).toContain("Resumes building");
  });
});

describe("scheduleInputValue", () => {
  it("opens EMPTY on an unscheduled card, so a nudge cannot commit a time nobody chose", () => {
    // The popover has no submit: it writes on every complete value. A
    // pre-filled field would therefore turn the first spinner nudge into a
    // commit — and on a running card that commit stops the agent and releases
    // its slot. Empty means an incomplete value is all a nudge can produce, and
    // an incomplete value is never sent.
    const value = scheduleInputValue({ draft: "", scheduledStartAt: null });
    expect(value).toBe("");
    expect(localInputValueToIso(value)).toBeNull();
  });

  it("shows the stored instant when the card already has one", () => {
    expect(scheduleInputValue({ draft: "", scheduledStartAt: at({ hour: 21 }) })).toBe(
      "2026-03-04T21:00",
    );
  });

  it("lets a half-typed draft stand, so the field does not fight the user", () => {
    expect(scheduleInputValue({ draft: "2026-03-", scheduledStartAt: at({ hour: 21 }) })).toBe(
      "2026-03-",
    );
  });
});
