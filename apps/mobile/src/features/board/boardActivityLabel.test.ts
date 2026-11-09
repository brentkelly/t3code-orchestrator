import { describe, expect, it } from "vite-plus/test";

import { boardActivityLabel } from "./boardActivityLabel";

describe("boardActivityLabel", () => {
  it("names known activity kinds", () => {
    expect(boardActivityLabel("plans-approved")).toBe("Plans approved");
    expect(boardActivityLabel("card-moved")).toBe("Moved");
  });

  it("falls back to a readable kind string", () => {
    expect(boardActivityLabel("card-edited" as "card-created")).toBe("edited");
  });
});
