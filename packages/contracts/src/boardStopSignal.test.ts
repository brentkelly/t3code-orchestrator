import { describe, expect, it } from "@effect/vitest";

import { boardTextEndsWithQuestion } from "./boardStopSignal.ts";

describe("boardTextEndsWithQuestion", () => {
  it("reads a plain trailing question", () => {
    expect(boardTextEndsWithQuestion("I need one decision first. Which auth library?")).toBe(true);
  });

  it("reads a question that introduces paragraph-length options", () => {
    // The shape this module exists for: the question is nowhere near the end,
    // because each option carries a paragraph of consequence.
    const options = ["A", "B", "C"]
      .map(
        (label) =>
          `**Option ${label}.** ${"It changes how the worktree is provisioned and how the branch is named. ".repeat(
            12,
          )}`,
      )
      .join("\n\n");
    expect(boardTextEndsWithQuestion(`Which of these do you want?\n\n${options}`)).toBe(true);
  });

  it("reads an ask-shape with no question mark", () => {
    expect(
      boardTextEndsWithQuestion("I have written the plan. Let me know if you want it split."),
    ).toBe(true);
  });

  it("reads a questions heading", () => {
    expect(boardTextEndsWithQuestion("## Open questions\n\n- rate limiting\n- retries")).toBe(true);
  });

  it("does not read a status report as a question", () => {
    expect(
      boardTextEndsWithQuestion(
        "Wrote the plan to .plans/auth.md. It covers the token exchange, the refresh path and the migration.",
      ),
    ).toBe(false);
  });

  it("ignores a question mark inside a fenced code block", () => {
    expect(
      boardTextEndsWithQuestion(
        "Ran the check.\n\n```sh\ngrep -c 'what?' src/*.ts\n```\n\nAll clean.",
      ),
    ).toBe(false);
  });

  it("ignores a question mark anywhere inside a multi-line fenced block", () => {
    // The whole block has to go, not just its first line: a lazy regex body
    // stops at the first newline and leaks the rest into the question window.
    expect(
      boardTextEndsWithQuestion(
        [
          "Ran the check.",
          "",
          "```sh",
          "set -euo pipefail",
          "",
          "grep -rn 'which one?' src/",
          "echo done",
          "```",
          "",
          "All clean.",
        ].join("\n"),
      ),
    ).toBe(false);
  });

  it("does not let a nested fence of the other character close the block", () => {
    expect(
      boardTextEndsWithQuestion(
        ["~~~md", "```", "Which one?", "```", "~~~", "", "Done."].join("\n"),
      ),
    ).toBe(false);
  });

  it("still sees a question that follows a closed fenced block", () => {
    expect(
      boardTextEndsWithQuestion(
        ["```sh", "pnpm install", "```", "", "Which lockfile should I commit?"].join("\n"),
      ),
    ).toBe(true);
  });

  it("ignores a dangling fence that is never closed", () => {
    expect(boardTextEndsWithQuestion("Here is the diff.\n\n```diff\n- is this right?\n")).toBe(
      false,
    );
  });

  it("ignores a question mark inside an inline code span", () => {
    expect(boardTextEndsWithQuestion("The route is `/users/:id?`. Done.")).toBe(false);
  });

  it("looks through trailing markdown emphasis", () => {
    expect(boardTextEndsWithQuestion("**Should I proceed with the rename?**")).toBe(true);
  });

  it("ignores a question far above the tail window", () => {
    const filler = "Then it writes the file and moves on. ".repeat(300);
    expect(boardTextEndsWithQuestion(`Which way?\n\n${filler}`)).toBe(false);
  });

  it("is false for empty and whitespace-only text", () => {
    expect(boardTextEndsWithQuestion("")).toBe(false);
    expect(boardTextEndsWithQuestion("   \n\n  ")).toBe(false);
  });
});
