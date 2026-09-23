import { describe, expect, it } from "vite-plus/test";

import { boardCardParkedChip } from "./boardCardParkedChip";

describe("boardCardParkedChip", () => {
  it("names a parked card", () => {
    expect(boardCardParkedChip({ backlogParked: true })).toEqual({
      label: "Parked",
      tooltip: "Stays in Backlog until you unpark it",
    });
  });

  it("is silent when the card is not parked", () => {
    expect(boardCardParkedChip({ backlogParked: false })).toBe(null);
  });
});
