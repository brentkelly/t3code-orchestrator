import {
  BOARD_LOCAL_WORKER_ID,
  EnvironmentId,
  PositiveInt,
  ProjectId,
  type BoardConcurrencySettings,
  type BoardWorkersState,
  type BoardWorkerView,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardCardMoveNotice,
  boardCardWorkerChip,
  boardDefaultWorkerCheckoutWarning,
  boardQueueReason,
  boardWorkerChoices,
  boardWorkerFieldLabel,
  boardWorkerLoadLabel,
  boardWorkerRunningCounts,
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
  ...extra,
});

const concurrency: BoardConcurrencySettings = {
  perInstance: {},
  globalMaxConcurrent: PositiveInt.make(8),
  workers: {
    local: { maxConcurrent: PositiveInt.make(4), perInstance: {} },
    [LINUX]: { maxConcurrent: PositiveInt.make(4), perInstance: {} },
  },
};

describe("the worker chip (prototype 4.4)", () => {
  it("is absent on a board with one worker", () => {
    expect(boardCardWorkerChip({}, state([]))).toBeNull();
  });

  it("is dashed while following the default, solid once bound, and says local for this server", () => {
    const board = state([worker(LINUX, "linux-box")]);
    expect(boardCardWorkerChip({}, board)).toEqual({
      label: "local",
      bound: false,
      tooltip: "Follows the default worker — This server",
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
    const running = boardWorkerRunningCounts(
      [
        { stepRunning: true },
        ...Array.from({ length: 4 }, () => ({ workerId: LINUX, stepRunning: true })),
      ],
      board,
    );
    const rows = boardWorkerChoices({
      state: board,
      projectId,
      projectRepositoryKey: KEY,
      projectName: "advisor",
      running,
      concurrency,
    });
    expect(rows.map((row) => [row.label, row.selectable, row.detail])).toEqual([
      ["This server (local)", true, "1 of 4 busy"],
      ["linux-box", true, "4 of 4 busy · will queue"],
      ["mbp-brent", false, "No checkout of advisor"],
      ["gpu-rig", false, "Offline"],
      ["ci-runner-2", false, "Access revoked"],
      ["old-mini", false, "Needs T3o 0.0.45+"],
    ]);
    expect(rows[2]?.canSetUp).toBe(true);
    expect(rows[3]?.tooltip).toBe("gpu-rig is offline. Pin it once it reconnects.");
    expect(rows[4]?.tooltip).toBe(
      "ci-runner-2's access was revoked. Re-pair it in Settings → Workers.",
    );
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
      running: new Map(),
      concurrency,
    })[1]!;
    expect(row).toMatchObject({ selectable: true, cloning: true, detail: "Cloning advisor · 32%" });
  });

  it("says the load with no limit plainly", () => {
    expect(boardWorkerLoadLabel(2, null)).toBe("2 busy");
  });
});

describe("the worker field", () => {
  it("reads Follow default — {worker}, or the pin", () => {
    const board = state([worker(LINUX, "linux-box")], { defaultWorkerId: LINUX });
    expect(boardWorkerFieldLabel(null, board)).toEqual({
      label: "Follow default — linux-box",
      pinned: false,
    });
    expect(boardWorkerFieldLabel(BOARD_LOCAL_WORKER_ID, board)).toEqual({
      label: "This server",
      pinned: true,
    });
  });

  it("warns in the create dialog when the default worker has no checkout", () => {
    const board = state([worker(LINUX, "linux-box", { checkout: false })], {
      defaultWorkerId: LINUX,
    });
    expect(
      boardDefaultWorkerCheckoutWarning({
        state: board,
        projectRepositoryKey: KEY,
        projectName: "advisor",
      }),
    ).toBe("linux-box has no checkout of advisor. Set up on worker or pin another.");
    expect(
      boardDefaultWorkerCheckoutWarning({
        state: state([worker(LINUX, "linux-box")], { defaultWorkerId: LINUX }),
        projectRepositoryKey: KEY,
        projectName: "advisor",
      }),
    ).toBeNull();
  });
});

describe("queue reasons and move notices", () => {
  it("names the binding limit only once there is more than one worker", () => {
    const card = { workerId: LINUX, queuedBy: "worker" as const, projectId };
    const cards = [
      { workerId: LINUX, stepRunning: true },
      { workerId: LINUX, stepRunning: true },
      { workerId: LINUX, stepRunning: true },
      { workerId: LINUX, stepRunning: true },
    ];
    expect(
      boardQueueReason({
        card,
        state: state([worker(LINUX, "linux-box")]),
        cards,
        concurrency,
        projectName: "advisor",
      }),
    ).toEqual({ kind: "worker", worker: "linux-box", running: 4, limit: 4 });
    expect(
      boardQueueReason({ card, state: state([]), cards, concurrency, projectName: "advisor" }),
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
