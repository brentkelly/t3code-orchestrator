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
  BLANK_THREAD_WARN,
  BOARD_STAGE_RESTART_IN_FLIGHT_REASON,
  isBoardCardRunInFlight,
  resolveBoardThreadStageRestart,
  runBlankThreadCreation,
  type BlankThreadStep,
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

describe("runBlankThreadCreation", () => {
  // A distinct detail payload per step, so tests can assert the failing
  // command's raw result is forwarded to the log — not swallowed by the tag.
  const detailOf = (step: BlankThreadStep) => `detail:${step}`;

  const harness = (steps: {
    create: BlankThreadStep;
    link?: BlankThreadStep;
    rollback?: BlankThreadStep;
  }) => {
    const calls = { create: 0, link: 0, rollback: 0 };
    const warnings: Array<{ message: string; detail: unknown }> = [];
    const dispatch = (step: BlankThreadStep) => ({ step, detail: detailOf(step) });
    const run = () =>
      runBlankThreadCreation({
        createThread: async () => {
          calls.create += 1;
          return dispatch(steps.create);
        },
        linkThread: async () => {
          calls.link += 1;
          return dispatch(steps.link ?? "ok");
        },
        rollbackThread: async () => {
          calls.rollback += 1;
          return dispatch(steps.rollback ?? "ok");
        },
        warn: (message, detail) => warnings.push({ message, detail }),
      });
    return { run, calls, warnings };
  };

  it("returns true and never rolls back when create and link both succeed", async () => {
    const h = harness({ create: "ok", link: "ok" });
    expect(await h.run()).toBe(true);
    expect(h.calls.rollback).toBe(0);
    expect(h.warnings).toEqual([]);
  });

  it("warns (with the error payload) and stops before linking when create fails", async () => {
    const h = harness({ create: "failed" });
    expect(await h.run()).toBe(false);
    expect(h.calls.link).toBe(0);
    expect(h.warnings).toEqual([{ message: BLANK_THREAD_WARN.create, detail: detailOf("failed") }]);
  });

  it("stays silent and does not link when create is interrupted", async () => {
    const h = harness({ create: "interrupted" });
    expect(await h.run()).toBe(false);
    expect(h.calls.link).toBe(0);
    expect(h.warnings).toEqual([]);
  });

  it("rolls back on a DEFINITE link failure, logging the link error", async () => {
    const h = harness({ create: "ok", link: "failed", rollback: "ok" });
    expect(await h.run()).toBe(false);
    expect(h.calls.rollback).toBe(1);
    expect(h.warnings).toEqual([{ message: BLANK_THREAD_WARN.link, detail: detailOf("failed") }]);
  });

  it("warns twice, each with its payload, when the rollback itself fails", async () => {
    const h = harness({ create: "ok", link: "failed", rollback: "failed" });
    expect(await h.run()).toBe(false);
    expect(h.calls.rollback).toBe(1);
    expect(h.warnings).toEqual([
      { message: BLANK_THREAD_WARN.link, detail: detailOf("failed") },
      { message: BLANK_THREAD_WARN.rollback, detail: detailOf("failed") },
    ]);
  });

  it("does NOT roll back an interrupted link — its server outcome is unknown", async () => {
    // The load-bearing decision: deleting a possibly-landed link would destroy
    // the card's thread, strictly worse than a harmless empty orphan.
    const h = harness({ create: "ok", link: "interrupted" });
    expect(await h.run()).toBe(false);
    expect(h.calls.rollback).toBe(0);
    expect(h.warnings).toEqual([]);
  });
});
