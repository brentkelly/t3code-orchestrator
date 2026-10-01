import { describe, expect, it } from "@effect/vitest";

import {
  appendToBrief,
  boardBriefVersion,
  briefHeadingLevel,
  briefSectionBodyBreak,
  replaceBriefSection,
} from "./briefEdits.ts";

describe("boardBriefVersion", () => {
  it("is stable for the same text and differs when the text changes", () => {
    expect(boardBriefVersion("Brief")).toBe(boardBriefVersion("Brief"));
    expect(boardBriefVersion("Brief")).not.toBe(boardBriefVersion("Brief."));
    expect(boardBriefVersion("Brief")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("gives a card with no brief a version too, so an empty brief can be guarded", () => {
    expect(boardBriefVersion(null)).toBe(boardBriefVersion(""));
  });
});

describe("appendToBrief", () => {
  it("separates the new text from the brief with one blank line", () => {
    expect(appendToBrief("Brief\n\n", "  Note ")).toBe("Brief\n\nNote");
    expect(appendToBrief(null, "Note")).toBe("Note");
  });
});

describe("briefHeadingLevel", () => {
  it("reads ATX headings and nothing else", () => {
    expect(briefHeadingLevel("## Notes")).toBe(2);
    expect(briefHeadingLevel("###### Deep")).toBe(6);
    expect(briefHeadingLevel("Notes")).toBeNull();
    expect(briefHeadingLevel("##Notes")).toBeNull();
    expect(briefHeadingLevel("####### Too deep")).toBeNull();
  });
});

describe("replaceBriefSection", () => {
  const heading = "## Notes from Z5-34";

  it("appends the section when the heading is absent, and replaces it after", () => {
    const once = replaceBriefSection("Brief", heading, "One");
    expect(once).toBe("Brief\n\n## Notes from Z5-34\n\nOne");
    expect(replaceBriefSection(once, heading, "Two")).toBe("Brief\n\n## Notes from Z5-34\n\nTwo");
  });

  it("ends the section at the next heading of the same or a higher level only", () => {
    const brief = [
      "# Title",
      "",
      "## Notes from Z5-34",
      "",
      "Old notes",
      "",
      "### Sub-point",
      "",
      "Old sub-point",
      "",
      "## Next",
      "",
      "Untouched",
    ].join("\n");
    expect(replaceBriefSection(brief, heading, "New notes")).toBe(
      "# Title\n\n## Notes from Z5-34\n\nNew notes\n\n## Next\n\nUntouched",
    );
  });

  it("ignores a matching line inside a fenced code block", () => {
    const brief = "Intro\n\n```md\n## Notes from Z5-34\n```\n\nOutro";
    expect(replaceBriefSection(brief, heading, "Real")).toBe(
      `${brief}\n\n## Notes from Z5-34\n\nReal`,
    );
  });

  it("does not end the section on a heading inside a fence within it", () => {
    const brief = "## Notes from Z5-34\n\n```\n# not a heading\n```\n\n# Next";
    expect(replaceBriefSection(brief, heading, "Fresh")).toBe(
      "## Notes from Z5-34\n\nFresh\n\n# Next",
    );
  });

  it("leaves a bare heading when the body is empty", () => {
    expect(replaceBriefSection(null, heading, "  ")).toBe(heading);
  });
});

describe("briefSectionBodyBreak", () => {
  const heading = "## Notes from Z5-34";

  it("finds a heading in the body that would end the section", () => {
    expect(briefSectionBodyBreak(heading, "Intro\n\n## Changes\n\nMore")).toBe("## Changes");
    expect(briefSectionBodyBreak(heading, "# Top")).toBe("# Top");
  });

  it("allows deeper headings and headings inside fences", () => {
    expect(briefSectionBodyBreak(heading, "### Changes\n\n```\n## not one\n```")).toBeNull();
  });
});
