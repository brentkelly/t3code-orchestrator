import { describe, expect, it } from "vite-plus/test";

import { ansiToSegments } from "./boardCiAnsi";

describe("ansiToSegments (T3O-60)", () => {
  it("maps the basic colours and bold to theme classes", () => {
    const { segments } = ansiToSegments("\u001b[1;31mFAIL\u001b[0m ok \u001b[92mpass\u001b[39m");
    expect(segments).toEqual([
      { text: "FAIL", className: "text-red-600 dark:text-red-400 font-semibold" },
      { text: " ok ", className: null },
      { text: "pass", className: "text-green-600 dark:text-green-300" },
    ]);
  });

  it("strips every other escape: cursor moves, extended colours, backgrounds, OSC", () => {
    const line =
      "\u001b[2K\u001b[1G\u001b[38;5;208morange\u001b[48;2;1;2;3m bg\u001b]0;title\u0007 \u001b]8;;https://x\u001b\\link\u001b]8;;\u001b\\\u0008";
    const { segments } = ansiToSegments(line);
    expect(segments.map((segment) => segment.text).join("")).toBe("orange bg link");
    expect(segments.every((segment) => segment.className === null)).toBe(true);
  });

  it("carries a colour on to the next line", () => {
    const first = ansiToSegments("\u001b[33mwarning: one");
    const second = ansiToSegments("two\u001b[0m three", first.state);
    expect(second.segments).toEqual([
      { text: "two", className: "text-amber-700 dark:text-amber-300" },
      { text: " three", className: null },
    ]);
  });
});
