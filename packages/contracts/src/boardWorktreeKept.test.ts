/**
 * Which cards wear the amber "Worktree kept" flag. A pure
 * derivation over the shell's worktree pair, the stage role and the setting.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  boardCardFinishedWithWorktree,
  boardCardWorktreeKept,
  boardCardWorktreeKeptReason,
} from "./board.ts";

const kept = (input: Partial<Parameters<typeof boardCardWorktreeKept>[0]>) =>
  boardCardWorktreeKept({
    worktreeReady: true,
    archived: false,
    inDoneStage: true,
    worktreeAtDone: "remove",
    cancelledWork: false,
    ...input,
  });

describe("boardCardWorktreeKept", () => {
  it("flags a Done card still holding a worktree", () => {
    expect(kept({})).toBe(true);
  });

  it("never flags a card with nothing on disk", () => {
    expect(kept({ worktreeReady: false })).toBe(false);
    expect(kept({ worktreeReady: false, archived: true })).toBe(false);
  });

  it("does not flag a finished card under keep — keeping it is intended", () => {
    expect(kept({ worktreeAtDone: "keep" })).toBe(false);
    expect(kept({ worktreeAtDone: "keep", archived: true, inDoneStage: false })).toBe(false);
    expect(kept({ worktreeAtDone: "keep", cancelledWork: true, inDoneStage: false })).toBe(false);
  });

  it("flags a finished card under remove-if-clean, the refusal case", () => {
    expect(kept({ worktreeAtDone: "remove-if-clean" })).toBe(true);
  });

  it("flags an archived card outside Done under either removing mode", () => {
    expect(kept({ archived: true, inDoneStage: false })).toBe(true);
    expect(kept({ archived: true, inDoneStage: false, worktreeAtDone: "remove-if-clean" })).toBe(
      true,
    );
  });

  it("does not flag a card still being worked", () => {
    expect(kept({ inDoneStage: false })).toBe(false);
  });

  it("flags a group still holding the worktree of its cancelled work", () => {
    expect(kept({ inDoneStage: false, cancelledWork: true })).toBe(true);
  });
});

describe("boardCardWorktreeKeptReason", () => {
  it("is the recorded refusal, or says cleanup has not run yet", () => {
    expect(boardCardWorktreeKeptReason("1 uncommitted change (a)")).toBe(
      "1 uncommitted change (a)",
    );
    expect(boardCardWorktreeKeptReason(null)).toBe("Cleanup hasn't run yet");
  });
});

describe("boardCardFinishedWithWorktree", () => {
  it("is Done, archived or cancelled work, whatever the setting", () => {
    const finished = (input: Partial<Parameters<typeof boardCardFinishedWithWorktree>[0]>) =>
      boardCardFinishedWithWorktree({
        archived: false,
        inDoneStage: false,
        cancelledWork: false,
        ...input,
      });
    expect(finished({})).toBe(false);
    expect(finished({ inDoneStage: true })).toBe(true);
    expect(finished({ archived: true })).toBe(true);
    expect(finished({ cancelledWork: true })).toBe(true);
  });
});
