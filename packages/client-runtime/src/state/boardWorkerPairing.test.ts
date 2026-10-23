import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { boardWorkerCandidate, boardWorkerCandidateIds } from "./boardWorkerPairing.ts";

const env = (id: string) => EnvironmentId.make(id);

describe("Add worker candidates", () => {
  it("lists every known environment except the board server and existing workers", () => {
    expect(
      boardWorkerCandidateIds({
        environmentIds: [env("board"), env("linux-box"), env("gpu-rig"), env("studio-pc")],
        boardEnvironmentId: env("board"),
        workerIds: ["gpu-rig"],
      }),
    ).toEqual(["linux-box", "studio-pc"]);
  });

  it("picks in one click with access:write, and needs a pairing link without it", () => {
    const base = { environmentId: env("x"), connected: true, relayManaged: false };
    expect(boardWorkerCandidate({ ...base, canMintPairingToken: true })).toEqual({ kind: "pick" });
    expect(boardWorkerCandidate({ ...base, canMintPairingToken: false })).toEqual({
      kind: "needs-link",
    });
  });

  it("disables an environment this client isn't connected to, or reaches only by relay", () => {
    const base = { environmentId: env("x"), canMintPairingToken: true };
    expect(boardWorkerCandidate({ ...base, connected: false, relayManaged: false })).toEqual({
      kind: "disabled",
      reason: "offline",
    });
    expect(boardWorkerCandidate({ ...base, connected: true, relayManaged: true })).toEqual({
      kind: "disabled",
      reason: "relay",
    });
  });
});
