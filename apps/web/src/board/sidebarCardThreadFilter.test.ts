import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { OlderSettled } from "@t3tools/client-runtime/state/threads";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  cardThreadMatcher,
  filterSettledCardThreads,
  settledCardThreadCount,
} from "./sidebarCardThreadFilter";

const DAY = 24 * 60 * 60 * 1000;
const environmentId = EnvironmentId.make("env-board");
const worker = EnvironmentId.make("env-worker");
const project = ProjectId.make("project-a");

const thread = (id: string, settledDay: number, environment = environmentId) => {
  const source = {
    id: ThreadId.make(id),
    projectId: project,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    settledOverride: "settled",
    settledAt: DateTime.makeUnsafe(settledDay * DAY),
  };
  return { ...source, environmentId: environment, source } as unknown as EnvironmentThreadShell;
};

const older = (input: {
  readonly cardIds: ReadonlyArray<string>;
  readonly cardCount?: number | null;
}): OlderSettled => ({
  before: DateTime.formatIso(DateTime.makeUnsafe(50 * DAY)),
  beforeMs: 50 * DAY,
  counts: new Map([[project, 4]]),
  boardCardThreadCounts: input.cardCount == null ? null : new Map([[project, input.cardCount]]),
  boardCardThreadIds: new Set(input.cardIds.map((id) => ThreadId.make(id))),
});

// The server names `card-archived` because its card is archived: the board shell would not.
const reads = new Map([
  [environmentId, older({ cardIds: ["card-archived", "card-open", "card-old"], cardCount: 5 })],
  [worker, older({ cardIds: ["relayed"] })],
]);
const olderSettled = (id: EnvironmentId) => reads.get(id) ?? null;
const isCardThread = cardThreadMatcher(olderSettled);

const oneOff = thread("one-off", 60);
const cardArchived = thread("card-archived", 61);
const cardOpen = thread("card-open", 62);
const cardOld = thread("card-old", 10);
const settledThreads = [oneOff, cardArchived, cardOpen];
const visibleThreads = [oneOff, cardArchived, cardOpen, cardOld];

describe("cardThreadMatcher", () => {
  it("matches the ids each environment's server names, on that environment only", () => {
    expect(isCardThread(environmentId, ThreadId.make("card-archived"))).toBe(true);
    expect(isCardThread(worker, ThreadId.make("relayed"))).toBe(true);
    expect(isCardThread(worker, ThreadId.make("card-archived"))).toBe(false);
    expect(isCardThread(environmentId, ThreadId.make("one-off"))).toBe(false);
    expect(isCardThread(EnvironmentId.make("env-old-server"), ThreadId.make("one-off"))).toBe(
      false,
    );
  });
});

describe("filterSettledCardThreads", () => {
  it("hides card threads from Settled, an archived card's included, but keeps the open one", () => {
    const filtered = filterSettledCardThreads({
      hide: true,
      isCardThread,
      settledThreads,
      visibleThreads,
      isRouteThread: (candidate) => candidate === cardOpen,
    });
    expect(filtered.settledThreads).toEqual([oneOff, cardOpen]);
    expect(filtered.localCardCount).toBe(1);
    expect(filtered.held).toEqual([oneOff]);
    expect(filtered.heldCardThreads).toEqual([cardArchived, cardOpen, cardOld]);
  });

  it("keeps every row when showing, and still counts the card threads among them", () => {
    const filtered = filterSettledCardThreads({
      hide: false,
      isCardThread,
      settledThreads,
      visibleThreads,
      isRouteThread: () => false,
    });
    expect(filtered.settledThreads).toBe(settledThreads);
    expect(filtered.held).toBe(visibleThreads);
    expect(filtered.localCardCount).toBe(2);
  });

  it("finds no card threads where Settled has none", () => {
    const filtered = filterSettledCardThreads({
      hide: false,
      isCardThread,
      settledThreads: [oneOff],
      visibleThreads: [oneOff],
      isRouteThread: () => false,
    });
    expect(filtered.localCardCount).toBe(0);
  });
});

describe("settledCardThreadCount", () => {
  const scopes = [{ environmentId, projectIds: null }];

  it("adds the server's older card threads the client does not hold", () => {
    // The server counted 5 older card threads apart; one of them (`card-old`) is held locally.
    expect(
      settledCardThreadCount({
        localCardCount: 2,
        scopes,
        olderSettled,
        heldCardThreads: [cardArchived, cardOld],
      }),
    ).toBe(6);
  });

  it("counts only the local ones when the server reports no card counts", () => {
    expect(
      settledCardThreadCount({
        localCardCount: 2,
        scopes,
        olderSettled: () => older({ cardIds: [], cardCount: null }),
        heldCardThreads: [cardOld],
      }),
    ).toBe(2);
  });
});
