import { describe, expect, it } from "vite-plus/test";

import {
  boardAutoMergeBanner,
  boardAutoMergeCountdown,
  boardAutoMergeElapsedLabel,
  boardAutoMergeHeaderChip,
  boardAutoMergePill,
  boardAutoMergeToggleCopy,
} from "./boardAutoMergeHold";

const HELD = "2026-03-04T09:00:00.000Z";
const NOW = Date.parse("2026-03-04T09:12:00.000Z");

describe("boardAutoMergeElapsedLabel", () => {
  it("reads minutes, then hours, then days — never seconds", () => {
    // A ticking seconds figure on thirty board cards is a continuously
    // repainting animation, which is the one thing this board refuses.
    const at = (iso: string) => boardAutoMergeElapsedLabel(HELD, Date.parse(iso));
    expect(at("2026-03-04T09:00:20.000Z")).toBe("just now");
    expect(at("2026-03-04T09:12:00.000Z")).toBe("12m");
    expect(at("2026-03-04T10:00:00.000Z")).toBe("1h");
    expect(at("2026-03-04T10:05:00.000Z")).toBe("1h 5m");
    expect(at("2026-03-06T12:00:00.000Z")).toBe("2d 3h");
    expect(at("2026-03-06T09:00:00.000Z")).toBe("2d");
  });

  it("never reads negative, and says nothing on an unparseable instant", () => {
    expect(boardAutoMergeElapsedLabel(HELD, Date.parse("2026-03-04T08:00:00.000Z"))).toBe(
      "just now",
    );
    expect(boardAutoMergeElapsedLabel("not a date", NOW)).toBe("");
  });
});

describe("boardAutoMergePill (T3O-38, D12/D13)", () => {
  it("reads `Merge held · 12m` with a clock while rungs remain", () => {
    expect(boardAutoMergePill({ heldSince: HELD, gaveUp: false, done: false, nowMs: NOW })).toEqual(
      {
        label: "Merge held · 12m",
        tooltip: "The forge refused the merge. The board is retrying — nothing is needed from you.",
        icon: "clock",
      },
    );
  });

  it("reads `Merge needs you` with an alert once the ladder stopped", () => {
    // The two states are told apart by their LABEL and ICON, never by colour:
    // both are amber, because the board card has never carried red.
    const pill = boardAutoMergePill({ heldSince: HELD, gaveUp: true, done: false, nowMs: NOW });
    expect(pill?.label).toBe("Merge needs you");
    expect(pill?.icon).toBe("alert");
  });

  it("says nothing on an unheld card or a done one", () => {
    expect(
      boardAutoMergePill({ heldSince: null, gaveUp: false, done: false, nowMs: NOW }),
    ).toBeNull();
    expect(
      boardAutoMergePill({ heldSince: undefined, gaveUp: undefined, done: false, nowMs: NOW }),
    ).toBeNull();
    expect(
      boardAutoMergePill({ heldSince: HELD, gaveUp: false, done: true, nowMs: NOW }),
    ).toBeNull();
  });
});

describe("boardAutoMergeBanner (T3O-38, D12)", () => {
  const base = {
    reason: "Required status check 'test' has not passed.",
    detail: "3 of 5 checks green · ci/build still running",
    attempt: 5,
    maxAttempts: 8,
    heldSince: HELD,
    nowMs: NOW,
  } as const;

  it("is AMBER while the board will end the wait itself", () => {
    const banner = boardAutoMergeBanner({ ...base, retryAt: "2026-03-04T09:15:00.000Z" });
    expect(banner.tone).toBe("warning");
    expect(banner.headline).toBe("Auto-merge is retrying");
    // The forge's own words, verbatim — the user reads the forge's reason
    // rather than a paraphrase of it.
    expect(banner.reason).toBe(base.reason);
    expect(banner.meta).toBe(
      "Held 12m · attempt 5 of 8 · 3 of 5 checks green · ci/build still running",
    );
  });

  it("goes RED once it stays put until a human acts", () => {
    // The same split the stalled banner has had since t3o-30: red on a card
    // counting down to its own retry would be the loudest thing on screen
    // saying the opposite of the card's own pill.
    const banner = boardAutoMergeBanner({ ...base, retryAt: null });
    expect(banner.tone).toBe("destructive");
    expect(banner.headline).toBe("Auto-merge stopped");
  });

  it("drops the detail clause when the probe said nothing to summarise", () => {
    const banner = boardAutoMergeBanner({ ...base, detail: null, retryAt: null });
    expect(banner.meta).toBe("Held 12m · attempt 5 of 8");
  });
});

describe("boardAutoMergeCountdown", () => {
  it("counts down in m:ss and floors at zero", () => {
    const at = (iso: string) =>
      boardAutoMergeCountdown("2026-03-04T09:15:00.000Z", Date.parse(iso));
    expect(at("2026-03-04T09:12:00.000Z")).toBe("3:00");
    expect(at("2026-03-04T09:14:53.000Z")).toBe("0:07");
    expect(at("2026-03-04T09:20:00.000Z")).toBe("0:00");
  });

  it("says nothing once the ladder has stopped", () => {
    // An exhausted hold has nothing to count down to, and the button goes
    // back to plain Merge.
    expect(boardAutoMergeCountdown(null, NOW)).toBeNull();
    expect(boardAutoMergeCountdown("not a date", NOW)).toBeNull();
  });
});

describe("boardAutoMergeHeaderChip", () => {
  it("names the SOURCE when the arm comes from the board-wide setting", () => {
    // With the setting on the per-card switch is hidden, so a user who goes
    // looking for it has to be told where the decision actually lives.
    const chip = boardAutoMergeHeaderChip({ armed: true, fromBoardSetting: true });
    expect(chip?.label).toBe("Auto-merge · board");
    expect(chip?.tooltip).toContain("Settings");
  });

  it("reads plainly for a card armed on its own", () => {
    expect(boardAutoMergeHeaderChip({ armed: true, fromBoardSetting: false })?.label).toBe(
      "Auto-merge",
    );
  });

  it("says nothing on an unarmed card", () => {
    expect(boardAutoMergeHeaderChip({ armed: false, fromBoardSetting: false })).toBeNull();
  });
});

describe("boardAutoMergeToggleCopy", () => {
  it("states the consequence of leaving it OFF, which is the whole point", () => {
    expect(boardAutoMergeToggleCopy(false).hint).toContain("until you come back");
    expect(boardAutoMergeToggleCopy(true).hint).toContain("as soon as the forge accepts");
  });
});
