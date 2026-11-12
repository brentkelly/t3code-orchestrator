/**
 * Where Add worker is (prototype 3.5), derived from the code this client
 * created and the board's live join-code list. The plain code is known only
 * to this client; everything after creation is the board's record of it.
 */
import type {
  BoardWorkerJoinCodeView,
  BoardWorkerJoinMilestone,
  BoardWorkersState,
  BoardWorkerView,
} from "@t3tools/contracts";

/** How long after a code is used without the worker connecting before the dialog says so. */
export const JOIN_STALL_MS = 30_000;

type UsedBy = NonNullable<BoardWorkerJoinCodeView["usedBy"]>;

export type JoinDialogPhase =
  | { readonly kind: "waiting" }
  | { readonly kind: "expired" }
  | { readonly kind: "cancelled" }
  /** A worker too old to join tried the code; the code stays valid. */
  | {
      readonly kind: "needs-update";
      readonly release: string | null;
      readonly usedBy: UsedBy | null;
    }
  /** Someone presented this code after it was spent. */
  | { readonly kind: "already-used" }
  | {
      readonly kind: "checking";
      readonly usedBy: UsedBy;
      readonly milestones: ReadonlyArray<BoardWorkerJoinMilestone>;
      /** Code accepted, but no connection within `JOIN_STALL_MS`. */
      readonly stalled: boolean;
    }
  | { readonly kind: "joined"; readonly usedBy: UsedBy; readonly worker: BoardWorkerView | null };

export function joinDialogPhase(input: {
  readonly codeId: string;
  /** When the code this client holds expires, for before the board lists it. */
  readonly expiresAt: string;
  readonly state: BoardWorkersState;
  readonly nowMs: number;
}): JoinDialogPhase {
  const code = input.state.joinCodes.find((candidate) => candidate.codeId === input.codeId);
  if (code === undefined) {
    return input.nowMs >= Date.parse(input.expiresAt) ? { kind: "expired" } : { kind: "waiting" };
  }
  const refusal = code.lastRefusal;
  if (code.usedBy !== null) {
    const usedBy = code.usedBy;
    const worker =
      input.state.workers.find((candidate) => candidate.id === usedBy.workerId) ?? null;
    if (code.milestones.includes("joined")) return { kind: "joined", usedBy, worker };
    if (worker?.status.state === "incompatible") {
      return {
        kind: "needs-update",
        release: worker.status.t3oVersion ?? usedBy.t3oRelease,
        usedBy,
      };
    }
    return {
      kind: "checking",
      usedBy,
      milestones: code.milestones,
      stalled:
        !code.milestones.includes("connected") &&
        input.nowMs - Date.parse(usedBy.usedAt) >= JOIN_STALL_MS,
    };
  }
  if (code.state === "cancelled" || refusal?.reason === "cancelled") return { kind: "cancelled" };
  if (code.state === "expired" || refusal?.reason === "expired") return { kind: "expired" };
  if (code.state === "used" || refusal?.reason === "used") {
    return { kind: "already-used" };
  }
  if (refusal?.reason === "needs-update") {
    return { kind: "needs-update", release: refusal.t3oRelease, usedBy: null };
  }
  return input.nowMs >= Date.parse(code.expiresAt) ? { kind: "expired" } : { kind: "waiting" };
}

/** The moments the phase can change with no new state: expiry and the stall. */
export function joinDialogDeadlines(input: {
  readonly codeId: string;
  readonly expiresAt: string;
  readonly state: BoardWorkersState;
}): ReadonlyArray<number> {
  const code = input.state.joinCodes.find((candidate) => candidate.codeId === input.codeId);
  const deadlines = [Date.parse(code?.expiresAt ?? input.expiresAt)];
  if (code?.usedBy != null) deadlines.push(Date.parse(code.usedBy.usedAt) + JOIN_STALL_MS);
  return deadlines;
}

/** The open codes the Workers header lists ("1 join code open · expires 22:58"). */
export function openJoinCodes(
  state: BoardWorkersState,
  nowMs: number,
): ReadonlyArray<BoardWorkerJoinCodeView> {
  return state.joinCodes.filter(
    (code) => code.state === "open" && code.usedBy === null && Date.parse(code.expiresAt) > nowMs,
  );
}

/** "in 9 min", rounded up so a fresh code reads its full lifetime. */
export function minutesLeft(expiresAt: string, nowMs: number): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - nowMs) / 60_000));
}
