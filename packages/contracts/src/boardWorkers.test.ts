import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_LOCAL_WORKER_ID,
  boardRepositoryGroupingKey,
  boardWorkerIds,
  EMPTY_BOARD_WORKERS_STATE,
  isLocalOnlyBoardWorkers,
  resolveBoardWorkerCheckout,
  type BoardWorkerCheckout,
  type BoardWorkersState,
} from "./boardWorkers.ts";
import { EnvironmentId, ProjectId } from "./baseSchemas.ts";
import type { RepositoryIdentity } from "./environment.ts";

const identity = (canonicalKey: string, origin?: string): RepositoryIdentity => ({
  canonicalKey,
  locator: {
    source: "git-remote",
    remoteName: "upstream",
    remoteUrl: `https://${canonicalKey}.git`,
  },
  ...(origin === undefined ? {} : { origin: { canonicalKey: origin } }),
});

const checkout = (projectId: string, repositoryKey: string | null): BoardWorkerCheckout => ({
  projectId: ProjectId.make(projectId),
  title: projectId,
  workspaceRoot: `/src/${projectId}`,
  repositoryKey,
});

describe("board workers", () => {
  it("lists the built-in local worker first, always", () => {
    expect(boardWorkerIds(undefined)).toEqual([BOARD_LOCAL_WORKER_ID]);
    const state: BoardWorkersState = {
      ...EMPTY_BOARD_WORKERS_STATE,
      workers: [
        {
          id: EnvironmentId.make("env-a"),
          label: "linux-box",
          url: "http://linux-box:3773",
          addedAt: "2026-10-21T00:00:00.000Z",
          status: { state: "online", lastSeenAt: null, t3oVersion: null, protocolVersion: null },
          snapshot: null,
        },
      ],
    };
    expect(boardWorkerIds(state)).toEqual([BOARD_LOCAL_WORKER_ID, "env-a"]);
    expect(isLocalOnlyBoardWorkers(state)).toBe(false);
  });

  it("treats no workers and the local default as exactly today's board", () => {
    expect(isLocalOnlyBoardWorkers(undefined)).toBe(true);
    expect(isLocalOnlyBoardWorkers(EMPTY_BOARD_WORKERS_STATE)).toBe(true);
    expect(
      isLocalOnlyBoardWorkers({
        ...EMPTY_BOARD_WORKERS_STATE,
        defaultWorkerId: EnvironmentId.make("env-a"),
      }),
    ).toBe(false);
  });

  describe("project ↔ worker mapping", () => {
    it("maps a project to the worker checkout with the same repository", () => {
      const key = boardRepositoryGroupingKey(identity("github.com/acme/app"));
      const match = resolveBoardWorkerCheckout(key, [
        checkout("other", "github.com/acme/other"),
        checkout("app-on-worker", "github.com/acme/app"),
      ]);
      expect(match?.projectId).toBe("app-on-worker");
    });

    it("matches a fork by its own origin, not the repository it forked", () => {
      // The board server's checkout of the fork: upstream is canonical, origin
      // is the fork. The worker's checkout has only the fork as a remote.
      const fork = boardRepositoryGroupingKey(
        identity("github.com/pingdotgg/t3code", "github.com/brentkelly/t3code"),
      );
      expect(fork).toBe("github.com/brentkelly/t3code");
      const workerCheckouts = [
        checkout(
          "upstream-clone",
          boardRepositoryGroupingKey(identity("github.com/pingdotgg/t3code")),
        ),
        checkout(
          "fork-clone",
          boardRepositoryGroupingKey(identity("github.com/brentkelly/t3code")),
        ),
      ];
      expect(resolveBoardWorkerCheckout(fork, workerCheckouts)?.projectId).toBe("fork-clone");
    });

    it("ignores host and owner casing", () => {
      expect(boardRepositoryGroupingKey(identity("GitHub.com/Acme/App"))).toBe(
        "github.com/acme/app",
      );
    });

    it("maps nothing for a project with no remote, or a worker with no checkout", () => {
      expect(resolveBoardWorkerCheckout(null, [checkout("x", null)])).toBeNull();
      expect(resolveBoardWorkerCheckout("github.com/acme/app", [])).toBeNull();
      expect(boardRepositoryGroupingKey(null)).toBeNull();
    });
  });
});
