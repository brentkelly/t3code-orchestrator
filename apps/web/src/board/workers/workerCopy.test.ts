import {
  EnvironmentId,
  ProjectId,
  type BoardWorkerSetup,
  type BoardWorkerView,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addWorkerErrorCopy,
  checkoutCell,
  looksLikePairingLink,
  remoteHost,
  SETUP_JUST_NOW_MS,
  workerLastSeen,
  workerLastSeenDeadlines,
  workerStatusPresentation,
} from "./workerCopy";

const NOW = Date.parse("2026-10-21T10:00:00.000Z");

const worker = (state: BoardWorkerView["status"]["state"], lastSeenAt: string | null = null) =>
  ({
    id: EnvironmentId.make("env-linux-box"),
    label: "linux-box",
    url: "https://linux-box:3773",
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
  it("keeps online grey, connecting blue, and every state needing a human amber", () => {
    expect(workerStatusPresentation(worker("online"), "studio").tone).toBe("neutral");
    expect(workerStatusPresentation(worker("connecting"), "studio").tone).toBe("running");
    for (const state of ["offline", "unauthorized", "incompatible"] as const) {
      expect(workerStatusPresentation(worker(state), "studio").tone).toBe("warning");
    }
  });

  it("names the board's session in the revoked tooltip", () => {
    const revoked = workerStatusPresentation(worker("unauthorized"), "studio");
    expect(revoked.label).toBe("Access revoked");
    expect(revoked.tooltip).toContain("“T3o board (studio)”");
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

describe("add worker errors", () => {
  it("tells the human which server a wrong link came from", () => {
    expect(
      addWorkerErrorCopy({
        code: "different-server",
        target: "studio-pc",
        workerLabel: "ci-runner-3",
        message: "",
      }).body,
    ).toBe(
      "You're adding studio-pc, but this link is from ci-runner-3. Paste a link created on studio-pc, or go back and pick ci-runner-3.",
    );
  });

  it("says the board SERVER can't reach the worker", () => {
    expect(
      addWorkerErrorCopy({ code: "unreachable", target: "mbp-brent", message: "" }).title,
    ).toBe("Board server can't reach mbp-brent");
  });

  it("checks a pasted link's shape before sending it", () => {
    expect(looksLikePairingLink("https://ci-runner-3.internal:3773/pair#token=9fXw")).toBe(true);
    expect(looksLikePairingLink("ci-runner-3.internal:3773")).toBe(false);
    expect(looksLikePairingLink("https://ci-runner-3.internal:3773/")).toBe(false);
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

  it("asks for a re-pair or an update rather than guessing", () => {
    expect(checkoutCell({ ...base, worker: worker("unauthorized"), checkout }).kind).toBe(
      "re-pair-to-check",
    );
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
