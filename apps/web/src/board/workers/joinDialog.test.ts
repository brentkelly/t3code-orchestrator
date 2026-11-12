import {
  EMPTY_BOARD_WORKERS_STATE,
  EnvironmentId,
  type BoardWorkerJoinCodeView,
  type BoardWorkersState,
  type BoardWorkerView,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  JOIN_STALL_MS,
  joinCodeInPlay,
  joinDialogPhase,
  latchJoinDialogPhase,
  minutesLeft,
  openJoinCodes,
} from "./joinDialog";

const NOW = Date.parse("2026-11-12T10:00:00.000Z");
const EXPIRES = "2026-11-12T10:10:00.000Z";
const BUILD = EnvironmentId.make("env-build-03");
const USED_AT = "2026-11-12T10:00:00.000Z";

const usedBy = {
  workerId: BUILD,
  label: "build-03",
  address: "203.0.113.4",
  t3oRelease: "0.0.50",
  usedAt: USED_AT,
  rejoin: false,
};

const code = (patch: Partial<BoardWorkerJoinCodeView> = {}): BoardWorkerJoinCodeView => ({
  codeId: "code-1",
  createdAt: "2026-11-12T09:59:00.000Z",
  expiresAt: EXPIRES,
  state: "open",
  usedBy: null,
  milestones: [],
  lastRefusal: null,
  ...patch,
});

const worker = (state: BoardWorkerView["status"]["state"]): BoardWorkerView => ({
  id: BUILD,
  label: "build-03",
  addedAt: USED_AT,
  status: { state, lastSeenAt: null, t3oVersion: "0.0.40", protocolVersion: 0 },
  snapshot: null,
});

const board = (
  joinCodes: ReadonlyArray<BoardWorkerJoinCodeView>,
  workers: ReadonlyArray<BoardWorkerView> = [],
): BoardWorkersState => ({ ...EMPTY_BOARD_WORKERS_STATE, joinCodes, workers });

const phase = (state: BoardWorkersState, nowMs = NOW) =>
  joinDialogPhase({ codeId: "code-1", expiresAt: EXPIRES, state, nowMs });

describe("Add worker phases", () => {
  it.each([
    ["waits before the board lists the code", board([]), NOW, "waiting"],
    ["expires a code the board never listed", board([]), Date.parse(EXPIRES), "expired"],
    ["waits on an open code", board([code()]), NOW, "waiting"],
    ["says a cancelled code is cancelled", board([code({ state: "cancelled" })]), NOW, "cancelled"],
    ["says an expired code is expired", board([code({ state: "expired" })]), NOW, "expired"],
    [
      "says a refused second use is already used",
      board([code({ lastRefusal: { reason: "used", at: USED_AT, t3oRelease: null } })]),
      NOW,
      "already-used",
    ],
    [
      "keeps the code valid when the worker needs an update",
      board([code({ lastRefusal: { reason: "needs-update", at: USED_AT, t3oRelease: "0.0.40" } })]),
      NOW,
      "needs-update",
    ],
    [
      "checks in once a worker used the code",
      board([code({ state: "used", usedBy, milestones: ["code-accepted", "connected"] })]),
      NOW,
      "checking",
    ],
    [
      "joins on the joined milestone",
      board([code({ state: "used", usedBy, milestones: ["code-accepted", "joined"] })]),
      NOW,
      "joined",
    ],
    [
      "says a joined but incompatible worker needs an update",
      board(
        [code({ state: "used", usedBy, milestones: ["code-accepted"] })],
        [worker("incompatible")],
      ),
      NOW,
      "needs-update",
    ],
  ] as const)("%s", (_name, state, nowMs, kind) => {
    expect(phase(state, nowMs).kind).toBe(kind);
  });

  it("stalls only when the worker has not connected 30 s after using the code", () => {
    const accepted = board([code({ state: "used", usedBy, milestones: ["code-accepted"] })]);
    expect(phase(accepted, NOW + JOIN_STALL_MS - 1)).toMatchObject({ stalled: false });
    expect(phase(accepted, NOW + JOIN_STALL_MS)).toMatchObject({ stalled: true });
    const connected = board([
      code({ state: "used", usedBy, milestones: ["code-accepted", "connected"] }),
    ]);
    expect(phase(connected, NOW + JOIN_STALL_MS)).toMatchObject({ stalled: false });
  });

  it("lets Add worker mint a new code once a spent one stalled or its worker needs an update", () => {
    const accepted = board([code({ state: "used", usedBy, milestones: ["code-accepted"] })]);
    expect(joinCodeInPlay(phase(board([code()])))).toBe(true);
    expect(joinCodeInPlay(phase(accepted))).toBe(true);
    expect(joinCodeInPlay(phase(accepted, NOW + JOIN_STALL_MS))).toBe(false);
    const refusedOld = board([
      code({ lastRefusal: { reason: "needs-update", at: USED_AT, t3oRelease: "0.0.40" } }),
    ]);
    expect(joinCodeInPlay(phase(refusedOld))).toBe(true);
    const joinedOld = board(
      [code({ state: "used", usedBy, milestones: ["code-accepted"] })],
      [worker("incompatible")],
    );
    expect(joinCodeInPlay(phase(joinedOld))).toBe(false);
  });

  it("keeps where a code got to once the board stops listing it", () => {
    const later = Date.parse(EXPIRES) + 1;
    const gone = board([]);
    const joined = phase(
      board([code({ state: "used", usedBy, milestones: ["code-accepted", "joined"] })]),
    );
    expect(latchJoinDialogPhase(joined, phase(gone, later), gone).kind).toBe("joined");
    const checking = phase(board([code({ state: "used", usedBy, milestones: ["code-accepted"] })]));
    expect(latchJoinDialogPhase(checking, phase(gone, later), gone).kind).toBe("checking");
    // A code that never got used still expires.
    expect(latchJoinDialogPhase(phase(board([code()])), phase(gone, later), gone).kind).toBe(
      "expired",
    );
  });

  it("lists only open, unused, unexpired codes and counts minutes up", () => {
    const state = board([
      code(),
      code({ codeId: "used", usedBy }),
      code({ codeId: "late", expiresAt: "2026-11-12T09:59:00.000Z" }),
    ]);
    expect(openJoinCodes(state, NOW).map((open) => open.codeId)).toEqual(["code-1"]);
    expect(minutesLeft(EXPIRES, NOW)).toBe(10);
    expect(minutesLeft(EXPIRES, NOW + 30_000)).toBe(10);
    expect(minutesLeft(EXPIRES, Date.parse(EXPIRES) + 1)).toBe(0);
  });
});
