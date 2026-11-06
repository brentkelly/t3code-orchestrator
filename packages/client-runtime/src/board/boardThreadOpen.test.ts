import { EnvironmentId, ThreadId, type BoardCardThreadLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardThreadOpen, boardThreadOpenForCard } from "./boardThreadOpen.ts";

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

const threadOnHost = ThreadId.make("thread-host");
const threadOnWorker = ThreadId.make("thread-worker");

function link(
  threadId: ThreadId,
  extra: Partial<Pick<BoardCardThreadLink, "workerId" | "tombstonedAt" | "linkedAt">> = {},
): BoardCardThreadLink {
  return {
    threadId,
    role: "building",
    linkedAt: extra.linkedAt ?? "2026-01-01T00:00:00.000Z",
    tombstonedAt: extra.tombstonedAt ?? null,
    ...(extra.workerId === undefined ? {} : { workerId: extra.workerId }),
  };
}

describe("boardThreadOpenForCard", () => {
  it("opens a worker thread on the link's environment, not the board host", () => {
    expect(
      boardThreadOpenForCard({
        boardHostEnvironmentId: host,
        threadLinks: [link(threadOnWorker, { workerId: worker })],
        connectedEnvironmentIds: [host, worker],
      }),
    ).toEqual({
      threadId: threadOnWorker,
      action: { kind: "open", environmentId: worker },
    });
  });

  it("asks to connect the worker instead of opening the thread on the board host", () => {
    expect(
      boardThreadOpenForCard({
        boardHostEnvironmentId: host,
        threadLinks: [link(threadOnWorker, { workerId: worker })],
        connectedEnvironmentIds: [host],
      }),
    ).toEqual({
      threadId: threadOnWorker,
      action: { kind: "connect", environmentId: worker },
    });
  });

  it("opens on the board host when the live link has no worker", () => {
    expect(
      boardThreadOpenForCard({
        boardHostEnvironmentId: host,
        threadLinks: [link(threadOnHost)],
        connectedEnvironmentIds: [host],
      }),
    ).toEqual({
      threadId: threadOnHost,
      action: { kind: "open", environmentId: host },
    });
  });
});
