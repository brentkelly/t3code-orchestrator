/**
 * T3O-52 (D5): which cards wear the amber "Worktree kept" flag. A pure
 * derivation over the shell's worktree pair, the stage role and the setting.
 */
import { describe, expect, it } from "vite-plus/test";

import { boardCardWorktreeKept, boardCardWorktreeKeptReason } from "./board.ts";

const kept = (input: Partial<Parameters<typeof boardCardWorktreeKept>[0]>) =>
  boardCardWorktreeKept({
    worktreeReady: true,
    archived: false,
    inDoneStage: true,
    reclaimWorktreeOnDone: true,
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

  it("does not flag a Done card when reclaim-on-Done is off — keeping it is intended", () => {
    expect(kept({ reclaimWorktreeOnDone: false })).toBe(false);
  });

  it("flags an archived card whatever the setting and stage", () => {
    expect(kept({ archived: true, inDoneStage: false, reclaimWorktreeOnDone: false })).toBe(true);
  });

  it("does not flag a card still being worked", () => {
    expect(kept({ inDoneStage: false })).toBe(false);
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
