/**
 * T3o: a v2 thread shell, read as the board's thread-state source (T3O-59).
 *
 * The board's card state (`deriveBoardCardThreadState` in contracts) predates
 * orchestration-v2 and reads a small structural shape. This is the one place
 * that shape is filled from a v2 shell, shared by the server's thread gateway
 * and the client's live re-derivation so the two cannot disagree.
 */
import type { BoardThreadStateSource, OrchestrationV2ThreadShell } from "@t3tools/contracts";

import { backgroundWorkHoldsCompletion } from "./orchestrationV2PendingBackgroundWork.ts";

export type BoardThreadShellFields = Pick<
  OrchestrationV2ThreadShell,
  | "activityRunStatus"
  | "status"
  | "latestRunId"
  | "activeProviderThreadId"
  | "pendingRuntimeRequest"
  | "pendingBackgroundTasks"
>;

type BoardSessionStatus = "starting" | "running" | "ready" | "error";

/**
 * The session status the board reads. v2 has no per-thread session status;
 * the live run's activity stands in for it. `waiting` is a run held on a
 * runtime request, which is still mid-turn for the board.
 */
export function boardThreadSessionStatus(thread: BoardThreadShellFields): BoardSessionStatus | null {
  switch (thread.activityRunStatus) {
    case "preparing":
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    default:
      break;
  }
  if (thread.latestRunId === null && thread.activeProviderThreadId === null) return null;
  return thread.status === "failed" ? "error" : "ready";
}

/**
 * Background work left running after the turn ended (T3O-20). Only work that
 * wakes the agent counts — a command left running (a dev server) does not
 * (upstream #14872). Monitors alone read as `monitoring`.
 */
export function boardThreadBackgroundLiveness(
  thread: BoardThreadShellFields,
): "working" | "monitoring" | null {
  if (thread.activityRunStatus != null) return null;
  const holding = (thread.pendingBackgroundTasks ?? []).filter((task) =>
    backgroundWorkHoldsCompletion([task]),
  );
  if (holding.length === 0) return null;
  return holding.every((task) => task.kind === "monitor") ? "monitoring" : "working";
}

export function boardThreadStateSource(thread: BoardThreadShellFields): BoardThreadStateSource {
  const request = thread.pendingRuntimeRequest;
  const status = boardThreadSessionStatus(thread);
  return {
    hasPendingUserInput: request?.kind === "user_input",
    hasPendingApprovals:
      request !== null && request.kind !== "user_input" && request.kind !== "auth_refresh",
    session: status === null ? null : { status },
    backgroundLiveness: boardThreadBackgroundLiveness(thread),
  };
}
