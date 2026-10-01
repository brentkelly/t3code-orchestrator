import { describe, expect, it } from "vite-plus/test";

import { boardBriefDisplayText } from "./boardBriefDisplay";

describe("boardBriefDisplayText", () => {
  it("hides section end markers and keeps everything else", () => {
    const brief = [
      "Intro",
      "## Notes from Z5-34",
      "Body",
      "<!-- end ## Notes from Z5-34 -->",
      "Appended after",
    ].join("\n");
    expect(boardBriefDisplayText(brief)).toBe(
      ["Intro", "## Notes from Z5-34", "Body", "Appended after"].join("\n"),
    );
  });

  it("keeps other HTML comments", () => {
    const brief = "<!-- a note -->\n<!-- end of list -->";
    expect(boardBriefDisplayText(brief)).toBe(brief);
  });
});
