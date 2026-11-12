import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_LOCAL_WORKER_ID,
  boardRepositoryGroupingKey,
  boardWorkerIds,
  EMPTY_BOARD_WORKERS_STATE,
  formatBoardWorkerJoinCode,
  hasOnlyLocalBoardWorker,
  isLocalOnlyBoardWorkers,
  normalizeBoardWorkerJoinCode,
  suggestBoardWorkerAbbreviation,
  resolveBoardWorkerCheckout,
  type BoardWorkerCheckout,
  type BoardWorkersState,
} from "./boardWorkers.ts";
import { EnvironmentId, ProjectId } from "./baseSchemas.ts";
import { BoardWorkerJoinRequest, WorkerTunnelHello } from "./boardWorkerTunnel.ts";
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
    // A listed join code carries worker state, but the board still has only itself as a worker.
    const withCode: BoardWorkersState = {
      ...EMPTY_BOARD_WORKERS_STATE,
      joinCodes: [
        {
          codeId: "code-1",
          createdAt: "2026-11-12T09:59:00.000Z",
          expiresAt: "2026-11-12T10:10:00.000Z",
          state: "open",
          usedBy: null,
          milestones: [],
          lastRefusal: null,
        },
      ],
    };
    expect(isLocalOnlyBoardWorkers(withCode)).toBe(false);
    expect(hasOnlyLocalBoardWorker(withCode)).toBe(true);
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

describe("join codes (T3O-84)", () => {
  it("formats 40 bits as XXXX-XXXX and reads them back however they were typed", () => {
    const code = formatBoardWorkerJoinCode(new Uint8Array([0xff, 0x00, 0xa5, 0x5a, 0x01]));
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(normalizeBoardWorkerJoinCode(code)).toBe(code.replace("-", ""));
    expect(normalizeBoardWorkerJoinCode(` ${code.toLowerCase()} `)).toBe(code.replace("-", ""));
    expect(normalizeBoardWorkerJoinCode("ABCD-EFGO")).toBe("ABCDEFG0");
    expect(normalizeBoardWorkerJoinCode("ABCD-EFGU")).toBeNull();
    expect(normalizeBoardWorkerJoinCode("ABC")).toBeNull();
  });

  it("accepts only a plain environment id from a joining worker, since it names secret files", () => {
    const join = Schema.decodeUnknownOption(BoardWorkerJoinRequest);
    const hello = Schema.decodeUnknownOption(WorkerTunnelHello);
    const request = (environmentId: string) => ({
      code: "ABCD-EFGH",
      environmentId,
      label: "build-03",
      t3oRelease: "0.1.8",
      tunnelProtocol: 1,
    });
    expect(Option.isSome(join(request("6f1c2b0e-3a8d-4c7e-9f21-0d5b8a7c4e19")))).toBe(true);
    for (const id of ["x/../server-signing-key", "..", ".hidden", "a\\b", "a b"]) {
      expect(Option.isNone(join(request(id)))).toBe(true);
      expect(
        Option.isNone(
          hello({
            type: "hello",
            tunnelProtocol: 1,
            environmentId: id,
            label: "build-03",
            t3oRelease: "0.1.8",
            gatewayProtocol: 1,
          }),
        ),
      ).toBe(true);
    }
  });
});

describe("worker abbreviations (T3O-84)", () => {
  it.each([
    ["build-03", [], "B03"],
    ["mac-mini", [], "MAC"],
    ["mac-mini", ["MAC"], "MM"],
    ["Linux box", [], "LIN"],
    ["srv-room", [], "SR"],
    ["x", ["X"], "X1"],
    ["mac-mini", ["MAC", "MM", "MA1", "MA2", "MA3", "MA4", "MA5", "MA6", "MA7", "MA8", "MA9"], "M10"],
    ["42", [], "42"],
  ] as const)("%s, with %j taken, suggests %s", (label, taken, expected) => {
    expect(suggestBoardWorkerAbbreviation(label, taken)).toBe(expected);
  });
});
