import { boardStagePrimaryAction } from "@t3tools/client-runtime/board";
import { BOARD_SEED_STAGE_IDS, BOARD_SEED_STAGES } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardMergeHold } from "./boardMergeHold";

describe("boardMergeHold", () => {
  it("names a conflict rewrite Conflicts and disables Merge", () => {
    const hold = boardMergeHold({ stepConflictFix: true });
    expect(hold).toEqual({ label: "Conflicts", mergeDisabledReason: "Resolving conflicts…" });
    expect(
      boardStagePrimaryAction(BOARD_SEED_STAGES, BOARD_SEED_STAGE_IDS.merge, {
        pullRequestState: "open",
        conflictFixLive: hold !== null,
        conflictFixReason: hold?.mergeDisabledReason ?? null,
      }),
    ).toMatchObject({ kind: "merge", disabled: true, disabledReason: "Resolving conflicts…" });
  });

  it("names a CI fix Fixing CI and disables Merge while stepConflictFix is false", () => {
    const hold = boardMergeHold({ stepConflictFix: false, stepChecksFix: true });
    expect(hold).toEqual({ label: "Fixing CI", mergeDisabledReason: "Fixing CI…" });
    expect(
      boardStagePrimaryAction(BOARD_SEED_STAGES, BOARD_SEED_STAGE_IDS.merge, {
        pullRequestState: "open",
        conflictFixLive: hold !== null,
        conflictFixReason: hold?.mergeDisabledReason ?? null,
      }),
    ).toMatchObject({ kind: "merge", disabled: true, disabledReason: "Fixing CI…" });
  });

  it("leaves Merge live when neither hold is set", () => {
    expect(boardMergeHold({ stepConflictFix: false })).toBeNull();
    expect(
      boardStagePrimaryAction(BOARD_SEED_STAGES, BOARD_SEED_STAGE_IDS.merge, {
        pullRequestState: "open",
        conflictFixLive: false,
        conflictFixReason: null,
      }),
    ).toMatchObject({ kind: "merge", disabled: false, disabledReason: null });
  });
});
