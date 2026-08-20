/**
 * t3o-14 — the card thread `+` menu's restart gate (D1).
 *
 * The load-bearing safety property: the menu must never offer a restart that
 * would put a second thread on a step the supervisor already owns. That reduces
 * to two pure decisions — is a run in flight, and does the current stage even
 * auto-execute — pinned here so the connected component stays a thin adapter.
 */
import type { BoardCardShell, BoardCardThreadState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_STAGE_RESTART_IN_FLIGHT_REASON,
  isBoardCardRunInFlight,
  resolveBoardThreadStageRestart,
} from "./boardCardThreadMenu";

const shell = (
  threadState: BoardCardThreadState,
  queued = false,
): Pick<BoardCardShell, "threadState" | "queued"> => ({ threadState, queued });

describe("isBoardCardRunInFlight", () => {
  it("is true while an active thread runs, awaits the human, or a build is queued", () => {
    expect(isBoardCardRunInFlight(shell("working"))).toBe(true);
    expect(isBoardCardRunInFlight(shell("waiting"))).toBe(true);
    // A queued build holds a step even with no live thread yet.
    expect(isBoardCardRunInFlight(shell("none", true))).toBe(true);
  });

  it("is false for an idle live thread — the explicit restart escape hatch (D2)", () => {
    expect(isBoardCardRunInFlight(shell("stopped"))).toBe(false);
    expect(isBoardCardRunInFlight(shell("none"))).toBe(false);
  });

  it("is false when the card has no shell", () => {
    expect(isBoardCardRunInFlight(undefined)).toBe(false);
  });
});

describe("resolveBoardThreadStageRestart", () => {
  it("returns null when the stage does not auto-execute (item absent, not disabled)", () => {
    expect(
      resolveBoardThreadStageRestart({
        autoExecute: false,
        stageLabel: "Planning",
        runInFlight: false,
      }),
    ).toBeNull();
    // Absent even mid-run: no restart affordance to disable.
    expect(
      resolveBoardThreadStageRestart({
        autoExecute: false,
        stageLabel: "Planning",
        runInFlight: true,
      }),
    ).toBeNull();
  });

  it("offers an enabled restart on an auto-executing stage at rest", () => {
    expect(
      resolveBoardThreadStageRestart({
        autoExecute: true,
        stageLabel: "Planning",
        runInFlight: false,
      }),
    ).toEqual({ label: "Planning", disabledReason: null });
  });

  it("disables the restart, with a reason, while a run is in flight", () => {
    expect(
      resolveBoardThreadStageRestart({
        autoExecute: true,
        stageLabel: "Planning",
        runInFlight: true,
      }),
    ).toEqual({ label: "Planning", disabledReason: BOARD_STAGE_RESTART_IN_FLIGHT_REASON });
  });
});
