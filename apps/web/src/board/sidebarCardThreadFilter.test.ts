import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { boardCardThreadMatcher } from "@t3tools/client-runtime/state/shell";
import type { OlderSettledShelfEnvironment } from "@t3tools/client-runtime/state/threads";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { filterSettledCardThreads, hiddenCardThreadCount } from "./sidebarCardThreadFilter";

const DAY = 24 * 60 * 60 * 1000;
const environmentId = EnvironmentId.make("env-board");
const project = ProjectId.make("project-a");

const thread = (id: string, settledDay: number) => {
  const source = {
    id: ThreadId.make(id),
    projectId: project,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    settledOverride: "settled",
    settledAt: DateTime.makeUnsafe(settledDay * DAY),
  };
  return { ...source, environmentId, source } as unknown as EnvironmentThreadShell;
};

const isCardThread = boardCardThreadMatcher(environmentId, [
  { threadId: ThreadId.make("card-recent") },
  { threadId: ThreadId.make("card-open") },
  { threadId: ThreadId.make("card-old") },
]);
const oneOff = thread("one-off", 60);
const cardRecent = thread("card-recent", 61);
const cardOpen = thread("card-open", 62);
const cardOld = thread("card-old", 10);
const settledThreads = [oneOff, cardRecent, cardOpen];
const visibleThreads = [oneOff, cardRecent, cardOpen, cardOld];

describe("filterSettledCardThreads", () => {
  it("hides card threads from Settled but keeps the open one", () => {
    const filtered = filterSettledCardThreads({
      hide: true,
      isCardThread,
      settledThreads,
      visibleThreads,
      isRouteThread: (candidate) => candidate === cardOpen,
    });
    expect(filtered.settledThreads).toEqual([oneOff, cardOpen]);
    expect(filtered.hiddenCount).toBe(1);
    expect(filtered.held).toEqual([oneOff]);
    expect(filtered.heldCardThreads).toEqual([cardRecent, cardOpen, cardOld]);
  });

  it("changes nothing when showing", () => {
    const filtered = filterSettledCardThreads({
      hide: false,
      isCardThread,
      settledThreads,
      visibleThreads,
      isRouteThread: () => false,
    });
    expect(filtered.settledThreads).toBe(settledThreads);
    expect(filtered.held).toBe(visibleThreads);
    expect(filtered.hiddenCount).toBe(0);
  });
});

describe("hiddenCardThreadCount", () => {
  const environments = (
    boardCardThreadCounts: ReadonlyMap<ProjectId, number> | null,
  ): ReadonlyMap<EnvironmentId, OlderSettledShelfEnvironment> =>
    new Map([
      [
        environmentId,
        {
          older: {
            before: DateTime.formatIso(DateTime.makeUnsafe(50 * DAY)),
            beforeMs: 50 * DAY,
            counts: new Map([[project, 4]]),
            boardCardThreadCounts,
          },
          pages: { reads: [], frontier: null, status: "ready" },
        },
      ],
    ]);
  const scopes = [{ environmentId, projectIds: null, excludeBoardCardThreads: true }];

  it("adds the server's older card threads the client does not hold", () => {
    // The server left out 5 older card threads; one of them (`card-old`) is held locally.
    expect(
      hiddenCardThreadCount({
        hiddenLocally: 2,
        scopes,
        environments: environments(new Map([[project, 5]])),
        heldCardThreads: [cardRecent, cardOld],
      }),
    ).toBe(6);
  });

  it("counts only the local ones when the server reports no card counts", () => {
    expect(
      hiddenCardThreadCount({
        hiddenLocally: 2,
        scopes,
        environments: environments(null),
        heldCardThreads: [cardOld],
      }),
    ).toBe(2);
  });
});
