import {
  EnvironmentId,
  ProjectId,
  type BoardWorkerSetup,
  type BoardWorkerView,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  checkoutCell,
  remoteHost,
  SETUP_JUST_NOW_MS,
  workerLastSeen,
  workerLastSeenDeadlines,
  workersNeedAttention,
  workerStatusPresentation,
} from "./workerCopy";

const NOW = Date.parse("2026-10-21T10:00:00.000Z");

const worker = (state: BoardWorkerView["status"]["state"], lastSeenAt: string | null = null) =>
  ({
    id: EnvironmentId.make("env-linux-box"),
    label: "linux-box",
    addedAt: "2026-10-01T00:00:00.000Z",
    status: { state, lastSeenAt, t3oVersion: "0.0.45", protocolVersion: 1 },
    snapshot: null,
  }) satisfies BoardWorkerView;

const setup = (patch: Partial<BoardWorkerSetup>): BoardWorkerSetup => ({
  projectId: ProjectId.make("project-app"),
  workerId: EnvironmentId.make("env-linux-box"),
  workerProjectId: null,
  destinationPath: "~/projects/app",
  phase: "cloning",
  stage: null,
  percent: null,
  failure: null,
  startedAt: "2026-10-21T09:59:00.000Z",
  endedAt: null,
  ...patch,
});

describe("worker status", () => {
  it("maps each connection state to its label and colour", () => {
    const rows = (["online", "connecting", "unauthorized", "offline", "incompatible"] as const).map(
      (state) => {
        const status = workerStatusPresentation(worker(state), NOW);
        return [state, status.label, status.tone];
      },
    );
    expect(rows).toEqual([
      ["online", "Connected", "neutral"],
      ["connecting", "Reconnecting", "running"],
      ["unauthorized", "Reconnecting", "running"],
      ["offline", "Offline", "warning"],
      ["incompatible", "Needs update", "warning"],
    ]);
    expect(workerStatusPresentation(worker("incompatible")).detail).toBe(
      "Connected · taking no new cards",
    );
  });

  it("says when an offline worker was last seen, and flags only blocked workers", () => {
    const offline = worker("offline", "2026-10-21T09:10:00.000Z");
    expect(workerStatusPresentation(offline, NOW).detail).toMatch(/^Last seen .+ · 50 min ago$/);
    expect(workerStatusPresentation(worker("offline"), NOW).detail).toBe("Never connected");
    expect(workersNeedAttention([worker("online"), worker("unauthorized")])).toBe(false);
    expect(workersNeedAttention([worker("online"), worker("incompatible")])).toBe(true);
  });

  it("says when an offline worker was last seen", () => {
    expect(workerLastSeen(worker("online"), NOW)).toBe("Now");
    expect(workerLastSeen(worker("offline", "2026-10-21T09:58:00.000Z"), NOW)).toBe("2 min ago");
    expect(workerLastSeen(worker("offline"), NOW)).toBe("Never");
  });

  it("lists every moment an offline worker's last-seen label changes", () => {
    expect(workerLastSeenDeadlines(worker("online"))).toEqual([]);
    expect(workerLastSeenDeadlines(worker("offline"))).toEqual([]);
    const seen = worker("offline", "2026-10-21T09:58:00.000Z");
    const deadlines = workerLastSeenDeadlines(seen);
    // Walk a day minute by minute: the label may only differ from the one a
    // minute earlier if a deadline fell in between.
    const start = Date.parse("2026-10-21T09:58:00.000Z");
    let previous = workerLastSeen(seen, start);
    for (let at = start + 1_000; at < start + 26 * 3_600_000; at += 1_000) {
      const label = workerLastSeen(seen, at);
      if (label !== previous) {
        expect(deadlines.some((deadline) => deadline > at - 1_000 && deadline <= at)).toBe(true);
      }
      previous = label;
    }
  });
});

describe("project checkout cells", () => {
  const base = { checkout: null, setup: null, projectHasRemote: true, nowMs: NOW };
  const checkout = {
    projectId: ProjectId.make("worker-app"),
    title: "app",
    workspaceRoot: "~/src/app",
    repositoryKey: "github.com/acme/app",
  };

  it("shows a checkout, and marks it last-known while the worker is offline", () => {
    expect(checkoutCell({ ...base, worker: worker("online"), checkout })).toEqual({
      kind: "checked-out",
      path: "~/src/app",
      lastKnown: false,
    });
    expect(checkoutCell({ ...base, worker: worker("offline"), checkout })).toMatchObject({
      lastKnown: true,
    });
  });

  it("asks for an update rather than guessing", () => {
    expect(checkoutCell({ ...base, worker: worker("incompatible") }).kind).toBe("update-to-check");
  });

  it("offers Set up only online, and never for a project with no remote", () => {
    expect(checkoutCell({ ...base, worker: worker("online") })).toEqual({
      kind: "not-checked-out",
      canSetUp: true,
    });
    expect(checkoutCell({ ...base, worker: worker("online"), projectHasRemote: false })).toEqual({
      kind: "not-checked-out",
      canSetUp: false,
    });
    expect(checkoutCell({ ...base, worker: worker("offline") }).kind).toBe("set-up-when-online");
  });

  it("follows a setup: cloning, failed, then green briefly once done", () => {
    expect(
      checkoutCell({
        ...base,
        worker: worker("online"),
        setup: setup({ stage: "receiving", percent: 48 }),
      }),
    ).toEqual({ kind: "cloning", percent: 48, stage: "receiving" });
    const failed = setup({
      phase: "failed",
      failure: { kind: "no-credentials", message: "x", log: "denied" },
    });
    expect(checkoutCell({ ...base, worker: worker("online"), setup: failed }).kind).toBe("failed");
    const done = setup({ phase: "done", endedAt: "2026-10-21T09:59:55.000Z" });
    expect(checkoutCell({ ...base, worker: worker("online"), setup: done }).kind).toBe(
      "set-up-just-now",
    );
    expect(
      checkoutCell({
        ...base,
        worker: worker("online"),
        setup: done,
        checkout,
        nowMs: NOW + SETUP_JUST_NOW_MS,
      }).kind,
    ).toBe("checked-out");
  });

  it("reads the host off https and scp-style remotes", () => {
    expect(remoteHost("git@github.com:acme/app.git")).toBe("github.com");
    expect(remoteHost("https://gitlab.com/mesh/infra.git")).toBe("gitlab.com");
  });
});
