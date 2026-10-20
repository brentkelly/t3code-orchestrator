import { RunId, RuntimeRequestId, deriveBoardCardThreadState } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { boardThreadStateSource, type BoardThreadShellFields } from "./boardThreadState.ts";

const at = DateTime.makeUnsafe("2026-10-20T00:00:00.000Z");
const idle: BoardThreadShellFields = {
  activityRunStatus: null,
  status: "completed",
  latestRunId: RunId.make("run-1"),
  activeProviderThreadId: null,
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
};
const request = (kind: "user_input" | "permission" | "auth_refresh") => ({
  id: RuntimeRequestId.make("request-1"),
  kind,
  createdAt: at,
});
const state = (overrides: Partial<BoardThreadShellFields>) =>
  deriveBoardCardThreadState(boardThreadStateSource({ ...idle, ...overrides }));

describe("boardThreadStateSource (T3O-59)", () => {
  it("reads a live run as a running session, including one held on a request", () => {
    expect(state({ activityRunStatus: "running" }).threadState).toBe("working");
    expect(state({ activityRunStatus: "preparing" }).threadState).toBe("working");
    expect(
      state({ activityRunStatus: "waiting", pendingRuntimeRequest: request("permission") })
        .threadState,
    ).toBe("waiting");
  });

  it("reads a run awaiting only its checkpoint as a turn that has ended", () => {
    expect(state({ activityRunStatus: "waiting" }).threadState).toBe("stopped");
    expect(boardThreadStateSource({ ...idle, activityRunStatus: "waiting" }).session).toEqual({
      status: "ready",
    });
    // Its delegated work still counts as background work.
    expect(
      state({
        activityRunStatus: "waiting",
        pendingBackgroundTasks: [{ taskId: "s", kind: "subagent" as const }],
      }),
    ).toMatchObject({ threadState: "working", waitingOnBackground: true });
  });

  it("separates a question from a permission prompt", () => {
    const asking = state({
      activityRunStatus: "waiting",
      pendingRuntimeRequest: request("user_input"),
    });
    expect(asking).toMatchObject({ threadState: "waiting", awaitingInput: true });
    // An auth refresh is not the human's to answer on the card.
    expect(
      state({ activityRunStatus: "running", pendingRuntimeRequest: request("auth_refresh") })
        .threadState,
    ).toBe("working");
  });

  it("does not hold a card on a permission prompt no live run can take", () => {
    expect(state({ pendingRuntimeRequest: request("permission") }).threadState).toBe("stopped");
  });

  it("reads a failed latest run as failed, and a thread that never ran as no session", () => {
    expect(state({ status: "failed" }).threadState).toBe("failed");
    expect(boardThreadStateSource({ ...idle, latestRunId: null }).session).toBeNull();
  });

  it("waits on background work that wakes the agent, not on a command left running", () => {
    const monitor = { taskId: "m", kind: "monitor" as const };
    const subagent = { taskId: "s", kind: "subagent" as const };
    const command = { taskId: "c", kind: "command" as const };
    expect(boardThreadStateSource({ ...idle, pendingBackgroundTasks: [monitor] })).toMatchObject({
      backgroundLiveness: "monitoring",
    });
    expect(state({ pendingBackgroundTasks: [monitor, subagent] })).toMatchObject({
      threadState: "working",
      waitingOnBackground: true,
    });
    expect(state({ pendingBackgroundTasks: [command] })).toMatchObject({
      threadState: "stopped",
      waitingOnBackground: false,
    });
  });
});
