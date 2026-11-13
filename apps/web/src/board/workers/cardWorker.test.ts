import {
  BoardCardId,
  BOARD_LOCAL_WORKER_ID,
  BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION,
  EnvironmentId,
  ProjectId,
  type BoardWorkerCapacitySnapshot,
  type BoardWorkersState,
  type BoardWorkerView,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardCardWorkerTrouble,
  boardWorkersAttention,
  boardCardMoveNotice,
  boardMoveDialogStatus,
  boardThreadMoveDividers,
  boardWorkerOnlyProviders,
  boardCardWorkerChip,
  boardWorkerCheckoutWarning,
  boardQueueReason,
  boardWorkerChoices,
  boardWorkerFieldLabel,
  boardWorkerLoadLabel,
} from "./cardWorker";

const LINUX = EnvironmentId.make("env-linux-box");
const MBP = EnvironmentId.make("env-mbp");
const GPU = EnvironmentId.make("env-gpu");
const projectId = ProjectId.make("project-advisor");
const KEY = "github.com/acme/advisor";
const NOW = "2026-01-01T00:00:00.000Z";

const worker = (
  id: EnvironmentId,
  label: string,
  options: {
    readonly state?: BoardWorkerView["status"]["state"];
    readonly checkout?: boolean;
  } = {},
): BoardWorkerView => ({
  id,
  label,
  url: `http://${label}:3773`,
  addedAt: NOW,
  status: {
    state: options.state ?? "online",
    lastSeenAt: null,
    t3oVersion: "0.11.0",
    protocolVersion: 1,
  },
  snapshot: {
    providers: [],
    checkouts:
      options.checkout === false
        ? []
        : [
            {
              projectId: ProjectId.make(`${label}-advisor`),
              title: "advisor",
              workspaceRoot: `/home/${label}/advisor`,
              repositoryKey: KEY,
            },
          ],
    projectsFolder: null,
    reportedAt: NOW,
  },
});

const state = (
  workers: ReadonlyArray<BoardWorkerView>,
  extra: Partial<BoardWorkersState> = {},
): BoardWorkersState => ({
  defaultWorkerId: BOARD_LOCAL_WORKER_ID,
  workers,
  setups: [],
  joinCodes: [],
  ...extra,
});

const snapshot = (
  running: number,
  extra: Partial<BoardWorkerCapacitySnapshot> = {},
): BoardWorkerCapacitySnapshot => ({
  at: NOW,
  declared: { cpuCores: 16, ramGiB: 64, diskGB: 200 },
  headroom: { cpuCores: 6, ramGiB: 24, diskGB: 120 },
  over: { cpuRam: false, disk: false },
  agents: { running, max: null },
  providers: [],
  readiness: [],
  heavyCards: [],
  ...extra,
});

describe("the worker chip (prototype 4.4)", () => {
  it("is absent on a board with one worker", () => {
    expect(boardCardWorkerChip({}, state([]))).toBeNull();
  });

  it("is dashed while following the default, solid once bound, and says local for this server", () => {
    const board = state([worker(LINUX, "linux-box")]);
    expect(boardCardWorkerChip({}, board)).toEqual({
      label: "local",
      bound: false,
      tooltip: "Follows the default worker (This server)",
    });
    expect(boardCardWorkerChip({ workerId: LINUX }, board)).toEqual({
      label: "linux-box",
      bound: true,
      tooltip: "Runs on linux-box",
    });
  });
});

describe("the worker picker (prototype 4.2)", () => {
  it("lists this server first, then each worker with its load or why it can't be picked", () => {
    const board = state([
      worker(LINUX, "linux-box"),
      worker(MBP, "mbp-brent", { checkout: false }),
      worker(GPU, "gpu-rig", { state: "offline" }),
      worker(EnvironmentId.make("env-ci"), "ci-runner-2", { state: "unauthorized" }),
      worker(EnvironmentId.make("env-old"), "old-mini", { state: "incompatible" }),
    ]);
    const capacity = new Map<string, BoardWorkerCapacitySnapshot>([
      [BOARD_LOCAL_WORKER_ID, snapshot(1)],
      [LINUX, snapshot(4, { over: { cpuRam: true, disk: false } })],
    ]);
    const rows = boardWorkerChoices({
      state: board,
      projectId,
      projectRepositoryKey: KEY,
      projectName: "advisor",
      capacity,
    });
    expect(rows.map((row) => [row.label, row.selectable, row.detail])).toEqual([
      ["This server (local)", true, "1 agent · 6 cores, 24 GiB free"],
      ["linux-box", true, "Full · will queue"],
      ["mbp-brent", false, "No checkout of advisor"],
      ["gpu-rig", false, "Offline"],
      ["ci-runner-2", false, "Reconnecting"],
      ["old-mini", false, `Needs T3o ${BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION}+`],
    ]);
    expect(rows[2]?.canSetUp).toBe(true);
    expect(rows[3]?.tooltip).toBe("gpu-rig is offline. Pin it once it reconnects.");
    expect(rows[4]?.tooltip).toBe("ci-runner-2 is reconnecting. Pin it once it's connected.");
  });

  it("lets a worker still cloning the project be picked, and says how far it is", () => {
    const board = state([worker(MBP, "mbp-brent", { checkout: false })], {
      setups: [
        {
          projectId,
          workerId: MBP,
          workerProjectId: null,
          destinationPath: "/home/mbp/advisor",
          phase: "cloning",
          stage: "receiving",
          percent: 32,
          failure: null,
          startedAt: NOW,
          endedAt: null,
        },
      ],
    });
    const row = boardWorkerChoices({
      state: board,
      projectId,
      projectRepositoryKey: KEY,
      projectName: "advisor",
      capacity: new Map(),
    })[1]!;
    expect(row).toMatchObject({ selectable: true, cloning: true, detail: "Cloning advisor · 32%" });
  });

  it("says a worker whose readiness check fails for the project will queue the card", () => {
    const board = state([worker(LINUX, "linux-box")]);
    const readiness = [
      {
        repositoryKey: KEY,
        path: "t3o/ready.sh",
        state: "not-ready" as const,
        version: null,
        checkedAt: NOW,
      },
    ];
    const row = boardWorkerChoices({
      state: board,
      projectId,
      projectRepositoryKey: KEY,
      projectName: "advisor",
      capacity: new Map([[LINUX, snapshot(0, { readiness })]]),
    })[1]!;
    expect(row).toMatchObject({ selectable: true, detail: "Not ready for advisor · will queue" });
    expect(boardWorkerLoadLabel(undefined)).toBe("No capacity report yet");
  });
});

describe("the worker field", () => {
  it("reads Follow default ({worker}), or the pin", () => {
    const board = state([worker(LINUX, "linux-box")], { defaultWorkerId: LINUX });
    expect(boardWorkerFieldLabel(null, board)).toEqual({
      label: "Follow default (linux-box)",
      pinned: false,
    });
    expect(boardWorkerFieldLabel(BOARD_LOCAL_WORKER_ID, board)).toEqual({
      label: "This server",
      pinned: true,
    });
    // Renamed on the Workers page, the board server reads its new name everywhere.
    const renamed = { ...board, localLabel: "desk-01" };
    expect(boardWorkerFieldLabel(BOARD_LOCAL_WORKER_ID, renamed).label).toBe("desk-01");
    expect(
      boardWorkerFieldLabel(null, { ...renamed, defaultWorkerId: BOARD_LOCAL_WORKER_ID }).label,
    ).toBe("Follow default (desk-01)");
  });

  it("warns in the create dialog when the default worker has no checkout", () => {
    const board = state([worker(LINUX, "linux-box", { checkout: false })], {
      defaultWorkerId: LINUX,
    });
    expect(
      boardWorkerCheckoutWarning({
        state: board,
        projectRepositoryKey: KEY,
        projectName: "advisor",
      }),
    ).toBe("linux-box has no checkout of advisor. Set up on worker or pin another.");
    expect(
      boardWorkerCheckoutWarning({
        state: state([worker(LINUX, "linux-box")], { defaultWorkerId: LINUX }),
        projectRepositoryKey: KEY,
        projectName: "advisor",
      }),
    ).toBeNull();
  });

  it("warns for a pinned worker with no checkout, even when the default has one", () => {
    const board = state([worker(LINUX, "linux-box"), worker(MBP, "mbp", { checkout: false })], {
      defaultWorkerId: LINUX,
    });
    expect(
      boardWorkerCheckoutWarning({
        state: board,
        pinnedWorkerId: MBP,
        projectRepositoryKey: KEY,
        projectName: "advisor",
      }),
    ).toContain("mbp has no checkout of advisor. The card waits");
    expect(
      boardWorkerCheckoutWarning({
        state: board,
        pinnedWorkerId: null,
        projectRepositoryKey: KEY,
        projectName: "advisor",
      }),
    ).toBeNull();
  });
});

describe("queue reasons and move notices", () => {
  it("names a capacity wait on any board, and reads legacy limits as plain Queued (T3O-86)", () => {
    const card = {
      workerId: LINUX,
      queuedBy: "capacity" as const,
      queuedDetail: { workerId: LINUX, behindCardId: BoardCardId.make("card-90") },
      projectId,
    };
    const cardKeys = new Map([["card-90", "T3O-90"]]);
    expect(
      boardQueueReason({
        card,
        state: state([worker(LINUX, "linux-box")]),
        cardKeys,
        projectName: "advisor",
      }),
    ).toEqual({
      kind: "capacity",
      worker: "linux-box",
      dimension: null,
      behind: "T3O-90",
      tooBig: false,
    });
    // A board with no remote workers says it too: the worker is this server.
    expect(
      boardQueueReason({
        card: {
          queuedBy: "capacity",
          queuedDetail: { workerId: BOARD_LOCAL_WORKER_ID },
          projectId,
        },
        state: state([]),
        cardKeys,
        projectName: "advisor",
      })?.kind,
    ).toBe("capacity");
    expect(
      boardQueueReason({
        card: { ...card, queuedBy: "board" as const },
        state: state([]),
        cardKeys,
        projectName: "advisor",
      }),
    ).toBeNull();
  });

  it("says Moving in blue terms and Move failed in amber ones", () => {
    const board = state([worker(LINUX, "linux-box")]);
    expect(
      boardCardMoveNotice({ workerMove: { status: "moving", toWorkerId: LINUX } }, board),
    ).toEqual({
      status: "moving",
      label: "Moving to linux-box",
      tooltip: "Creating a worktree on linux-box from the pushed branch.",
    });
    expect(
      boardCardMoveNotice({ workerMove: { status: "failed", toWorkerId: LINUX } }, board)?.label,
    ).toBe("Move failed");
    expect(boardCardMoveNotice({}, board)).toBeNull();
  });
});

describe("the thread list's move dividers", () => {
  it("marks the first thread linked after each move with where the card came from", () => {
    // Local times, so "today" holds whatever zone the suite runs in.
    const local = (hour: number, minute = 0) => new Date(2026, 2, 12, hour, minute).toISOString();
    const nowMs = Date.parse(local(12));
    const dividers = boardThreadMoveDividers({
      links: [
        { threadId: "plan", linkedAt: local(8) },
        { threadId: "build-2", linkedAt: local(10, 30) },
        { threadId: "build-1", linkedAt: local(9) },
      ],
      moves: [{ at: local(10, 4), fromWorkerId: BOARD_LOCAL_WORKER_ID }],
      state: state([worker(LINUX, "linux-box")]),
      nowMs,
    });
    expect([...dividers.keys()]).toEqual(["build-2"]);
    expect(dividers.get("build-2")).toMatch(/^Moved from This server · today /);
  });
});

describe("worker-only provider instances in the model pickers", () => {
  it("adds instance ids only workers have, once, after this server's own", () => {
    const withProviders = (id: EnvironmentId, label: string, ids: ReadonlyArray<string>) => {
      const base = worker(id, label);
      return {
        ...base,
        snapshot: {
          ...base.snapshot!,
          providers: ids.map((instanceId) => ({
            instanceId: instanceId as never,
            driver: "claudeAgent",
            displayName: null,
            enabled: true,
            models: [{ slug: "opus", name: "Opus" }],
          })),
        },
      };
    };
    const board = state([
      withProviders(LINUX, "linux-box", ["claude-max", "claude-api"]),
      withProviders(MBP, "mbp-brent", ["claude-api"]),
    ]);
    const own = [{ instanceId: "claude-max" }] as never;
    const added = boardWorkerOnlyProviders(board, own);
    expect(added.map((provider) => [provider.instanceId, provider.badgeLabel])).toEqual([
      ["claude-api", "linux-box"],
    ]);
    expect(added[0]?.models).toEqual([
      { slug: "opus", name: "Opus", isCustom: false, capabilities: null },
    ]);
  });
});

describe("the clone-failed notice", () => {
  it("shows on a card held for a checkout whose clone failed", () => {
    const board = state([worker(MBP, "mbp-brent", { checkout: false })], {
      setups: [
        {
          projectId,
          workerId: MBP,
          workerProjectId: null,
          destinationPath: "/home/mbp/advisor",
          phase: "failed",
          stage: null,
          percent: null,
          failure: { kind: "no-credentials", message: "denied", log: "" },
          startedAt: NOW,
          endedAt: NOW,
        },
      ],
    });
    expect(
      boardCardMoveNotice({ workerId: MBP, queued: true, queuedBy: "setup", projectId }, board)
        ?.label,
    ).toBe("Clone failed");
    expect(boardCardMoveNotice({ workerId: MBP, queued: false, projectId }, board)).toBeNull();
  });
});

describe("boardMoveDialogStatus", () => {
  const worktree = {
    branch: "board/t3-1",
    baseRefName: "main",
    path: "/wt",
    status: "ready" as const,
    attempts: 1,
    lastError: null,
    reclaimBlockedReason: null,
  };
  const moving = (status: "moving" | "failed", startedAt: string) => ({
    fromWorkerId: BOARD_LOCAL_WORKER_ID,
    toWorkerId: LINUX,
    status,
    sha: null,
    error: status === "failed" ? "disk full" : null,
    startedAt,
  });
  const LATER = "2026-01-01T00:05:00.000Z";

  it("is pending, not done, before the server records a first move's start", () => {
    expect(
      boardMoveDialogStatus(
        { workerMove: null, worktree, placedWorkerId: BOARD_LOCAL_WORKER_ID },
        { toWorkerId: LINUX, priorStartedAt: null },
      ),
    ).toBe("pending");
  });

  it("is pending, not failed, before a Retry's start replaces the last failure", () => {
    expect(
      boardMoveDialogStatus(
        {
          workerMove: moving("failed", NOW),
          worktree: { ...worktree, path: null, status: "reclaimed" },
          placedWorkerId: null,
        },
        { toWorkerId: LINUX, priorStartedAt: NOW },
      ),
    ).toBe("pending");
  });

  it("follows this move through retired, failed and done", () => {
    const reclaimed = { ...worktree, path: null, status: "reclaimed" as const };
    const input = { toWorkerId: LINUX, priorStartedAt: NOW };
    expect(
      boardMoveDialogStatus(
        { workerMove: moving("moving", LATER), worktree, placedWorkerId: BOARD_LOCAL_WORKER_ID },
        input,
      ),
    ).toBe("moving");
    expect(
      boardMoveDialogStatus(
        { workerMove: moving("moving", LATER), worktree: reclaimed, placedWorkerId: null },
        input,
      ),
    ).toBe("retired");
    expect(
      boardMoveDialogStatus(
        { workerMove: moving("failed", LATER), worktree: reclaimed, placedWorkerId: null },
        input,
      ),
    ).toBe("failed");
    expect(
      boardMoveDialogStatus({ workerMove: null, worktree, placedWorkerId: LINUX }, input),
    ).toBe("done");
  });
});

describe("worker trouble (T3O-66)", () => {
  type AttentionCard = Parameters<typeof boardWorkersAttention>[0][number];
  const card = (overrides: Partial<AttentionCard> = {}): AttentionCard => ({
    cardId: "card-1" as never,
    key: "T3-191",
    title: "GPU-backed embeddings",
    workerId: GPU,
    stepRunning: true,
    queued: false,
    stepAwaiting: null,
    ...overrides,
  });
  const gpuOffline = state([
    {
      ...worker(GPU, "gpu-rig", { state: "offline" }),
      status: {
        ...worker(GPU, "gpu-rig").status,
        state: "offline",
        lastSeenAt: "2026-01-01T09:12:00.000Z",
      },
    },
    worker(LINUX, "linux-box"),
  ]);

  it("says Worker removed on a held card, whatever its worker's state", () => {
    const trouble = boardCardWorkerTrouble(
      card({ placementOrphaned: { workerLabel: "gpu-rig" }, stepRunning: false }),
      state([]),
    );
    expect(trouble?.kind).toBe("removed");
    expect(trouble?.label).toBe("Move this card");
    expect(trouble?.tooltip).toBe(
      "gpu-rig was removed from the board. Move this card to keep going.",
    );
  });

  it("says Worker offline on a card with work on an offline worker", () => {
    const trouble = boardCardWorkerTrouble(card(), gpuOffline);
    expect(trouble?.kind).toBe("offline");
    expect(trouble?.label).toBe("Worker offline");
    expect(trouble?.tooltip).toMatch(
      /^gpu-rig went offline at .+\. Work is paused; nothing has been restarted\.$/,
    );
    // A card waiting to start there, or parked there, too.
    expect(
      boardCardWorkerTrouble(card({ stepRunning: false, queued: true }), gpuOffline)?.kind,
    ).toBe("offline");
    expect(
      boardCardWorkerTrouble(card({ stepRunning: false, stepAwaiting: "question" }), gpuOffline)
        ?.kind,
    ).toBe("offline");
  });

  it("tells an incompatible worker apart from one that will reconnect", () => {
    const old = boardCardWorkerTrouble(
      card(),
      state([worker(GPU, "gpu-rig", { state: "incompatible" })]),
    );
    expect(old?.panelTitle).toBe("gpu-rig needs a newer T3o");
    expect(old?.panelBody).toContain("once gpu-rig is upgraded");
    expect(old?.panelBody).not.toContain("reconnects");
    expect(boardCardWorkerTrouble(card(), gpuOffline)?.panelTitle).toBe("gpu-rig is offline");
  });

  it("says nothing of an idle card pinned there, a reachable worker, or a reconnect", () => {
    expect(boardCardWorkerTrouble(card({ stepRunning: false }), gpuOffline)).toBeNull();
    expect(boardCardWorkerTrouble(card({ workerId: LINUX }), gpuOffline)).toBeNull();
    for (const reconnecting of ["connecting", "unauthorized"] as const) {
      expect(
        boardCardWorkerTrouble(card(), state([worker(GPU, "gpu-rig", { state: reconnecting })])),
      ).toBeNull();
    }
    // A card following the default reads the default's state.
    expect(
      boardCardWorkerTrouble(
        (({ workerId: _bound, ...following }) => following)(card()),
        state([worker(GPU, "gpu-rig", { state: "offline" })], { defaultWorkerId: GPU }),
      )?.kind,
    ).toBe("offline");
  });

  it("the header indicator counts workers and lists the cards each has paused", () => {
    expect(boardWorkersAttention([card()], state([worker(GPU, "gpu-rig")]))).toBeNull();
    expect(boardWorkersAttention([], state([]))).toBeNull();
    const one = boardWorkersAttention(
      [card(), card({ cardId: "card-2" as never, workerId: LINUX })],
      gpuOffline,
    );
    expect(one?.label).toBe("1 worker offline");
    expect(one?.rows.map((row) => row.label)).toEqual(["gpu-rig"]);
    expect(one?.rows[0]?.status).toMatch(/^Offline since /);
    expect(one?.rows[0]?.pausedCards.map((paused) => paused.cardId)).toEqual(["card-1"]);
    const mixed = boardWorkersAttention(
      [],
      state([
        worker(GPU, "gpu-rig", { state: "offline" }),
        worker(MBP, "old-mini", { state: "incompatible" }),
        worker(LINUX, "linux-box", { state: "unauthorized" }),
      ]),
    );
    expect(mixed?.label).toBe("2 workers need attention");
    expect(mixed?.rows.map((row) => row.status)).toEqual([
      "Offline",
      `Needs T3o ${BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION} or newer`,
    ]);
  });
});
