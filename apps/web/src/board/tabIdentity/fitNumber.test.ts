import { describe, expect, it } from "vite-plus/test";

import { fitStretched } from "./fitNumber";

describe("fitStretched", () => {
  // Widths are each number's advance at the nominal 28.93u, as Barlow Condensed 700 sets them.
  it.each([
    { digits: "7", width: 12.4, size: 28.93, scaleY: 1 },
    { digits: "65", width: 24.8, size: 28.93, scaleY: 1 },
    { digits: "318", width: 33.06, size: 28.0, scaleY: 1.033 },
    { digits: "1204", width: 48.86, size: 18.95, scaleY: 1.527 },
  ])("$digits fits the tile at the design's size and stretch", ({ width, size, scaleY }) => {
    const fit = fitStretched(width);
    expect(fit.size).toBeCloseTo(size, 2);
    expect(fit.scaleY).toBeCloseTo(scaleY, 3);
  });
});
