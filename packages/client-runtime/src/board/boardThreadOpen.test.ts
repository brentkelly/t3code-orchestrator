import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardThreadOpen } from "./boardThreadOpen.ts";

const host = EnvironmentId.make("environment-host");
const worker = EnvironmentId.make("environment-worker");

describe("boardThreadOpen", () => {
  it("opens on the board host when the thread has no environment of its own", () => {
    expect(
      boardThreadOpen({
        boardHostEnvironmentId: host,
        connectedEnvironmentIds: [host],
      }),
    ).toEqual({ kind: "open", environmentId: host });
  });

  it("opens on the thread environment when that environment is connected", () => {
    expect(
      boardThreadOpen({
        boardHostEnvironmentId: host,
        threadEnvironmentId: worker,
        connectedEnvironmentIds: new Set([host, worker]),
      }),
    ).toEqual({ kind: "open", environmentId: worker });
  });

  it("asks to connect the thread environment instead of opening on the board host", () => {
    expect(
      boardThreadOpen({
        boardHostEnvironmentId: host,
        threadEnvironmentId: worker,
        connectedEnvironmentIds: [host],
      }),
    ).toEqual({ kind: "connect", environmentId: worker });
  });

  it("asks to connect the board host when nothing is connected", () => {
    expect(
      boardThreadOpen({
        boardHostEnvironmentId: host,
        connectedEnvironmentIds: [],
      }),
    ).toEqual({ kind: "connect", environmentId: host });
  });
});
