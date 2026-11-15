// @effect-diagnostics globalDate:off - fixed timestamps for the plain-Node decision.
import { describe, expect, it } from "vite-plus/test";

import { AUTO_UPDATE_RETRY_MS, decideAutoUpdate } from "./t3o-auto-update.ts";

describe("auto-update decision", () => {
  const flagged = {
    pid: 1,
    boards: [
      { boardLabel: "mesh-dev", state: "connected", updateRequired: "needs protocol 6" },
      { boardLabel: "other", state: "connected", updateRequired: null },
      { boardLabel: "older", state: "connected" },
    ],
  };
  const now = 10 * AUTO_UPDATE_RETRY_MS;
  const decide = (input: Partial<Parameters<typeof decideAutoUpdate>[0]>) =>
    decideAutoUpdate({
      status: flagged,
      serverAlive: true,
      lastAttemptAt: null,
      lastOutcome: null,
      now,
      ...input,
    });

  it("updates only for a live server's flagged boards", () => {
    expect(decide({})).toEqual({ kind: "update", reasons: ["mesh-dev: needs protocol 6"] });
    expect(decide({ serverAlive: false }).kind).toBe("idle");
    expect(decide({ status: null }).kind).toBe("idle");
    expect(decide({ status: { pid: 1, boards: [flagged.boards[1]] } }).kind).toBe("idle");
    expect(decide({ status: { pid: 1 } }).kind).toBe("idle");
  });

  it("forgets the last attempt only once a live server flags nothing", () => {
    const lastAttemptAt = now - 1;
    const clear = { pid: 1, boards: [flagged.boards[1]] };
    expect(decide({ status: clear, lastAttemptAt })).toMatchObject({ forgetAttempt: true });
    expect(decide({ status: clear, serverAlive: false, lastAttemptAt })).toMatchObject({
      forgetAttempt: false,
    });
    expect(decide({ status: null, lastAttemptAt })).toMatchObject({ forgetAttempt: false });
    // A board still connecting after a restart hasn't answered, so it clears nothing.
    const connecting = { pid: 1, boards: [{ boardLabel: "mesh-dev", state: "connecting" }] };
    expect(decide({ status: connecting, lastAttemptAt })).toMatchObject({ forgetAttempt: false });
  });

  it("fails visibly when the last update failed and left the server down", () => {
    const lastAttemptAt = now - 1;
    for (const lastOutcome of ["exited 1", "no-sudo"]) {
      expect(decide({ serverAlive: false, lastAttemptAt, lastOutcome })).toMatchObject({
        kind: "failed",
        reason: expect.stringContaining(lastOutcome),
      });
      expect(decide({ status: null, lastAttemptAt, lastOutcome }).kind).toBe("failed");
    }
    // A clean run, or a live server, is not a failure to report.
    expect(decide({ serverAlive: false, lastAttemptAt, lastOutcome: "ran" }).kind).toBe("idle");
    expect(decide({ lastAttemptAt, lastOutcome: "exited 1" }).kind).toBe("wait");
  });

  it("waits out the retry window after an attempt that left the flag set", () => {
    expect(decide({ lastAttemptAt: now - AUTO_UPDATE_RETRY_MS + 1 })).toMatchObject({
      kind: "wait",
      retryAt: new Date(now + 1).toISOString(),
    });
    expect(decide({ lastAttemptAt: now - AUTO_UPDATE_RETRY_MS }).kind).toBe("update");
  });
});
