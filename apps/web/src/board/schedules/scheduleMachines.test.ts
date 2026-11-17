import {
  EnvironmentId,
  ProjectId,
  type BoardWorkerCapacitySnapshot,
  type BoardWorkerView,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardScheduleMachineChoices, boardScheduleWorkerStatus } from "./scheduleMachines";

const KEY = "github.com/acme/walls";
const project = { projectId: "project-walls", projectRepositoryKey: KEY, projectName: "walls" };

const worker = (over: {
  readonly state?: BoardWorkerView["status"]["state"];
  readonly protocolVersion?: number;
  readonly checkout?: boolean;
}): BoardWorkerView => ({
  id: EnvironmentId.make("env-build-01"),
  label: "build-01",
  addedAt: "2026-11-01T00:00:00.000Z",
  status: {
    state: over.state ?? "online",
    lastSeenAt: "2026-11-17T02:00:00.000Z",
    t3oVersion: "0.1.9",
    protocolVersion: over.protocolVersion ?? 6,
  },
  snapshot: {
    providers: [],
    checkouts:
      over.checkout === false
        ? []
        : [
            {
              projectId: ProjectId.make("walls-on-build-01"),
              title: "walls",
              workspaceRoot: "/srv/walls",
              repositoryKey: KEY,
            },
          ],
    projectsFolder: null,
    reportedAt: "2026-11-17T02:00:00.000Z",
  },
});

const readiness = (state: "ready" | "not-ready") =>
  ({
    readiness: [{ repositoryKey: KEY, path: "ready.sh", state, version: null, checkedAt: null }],
  }) as unknown as BoardWorkerCapacitySnapshot;

describe("a schedule's Run on rows (T3O-118)", () => {
  it.each([
    [{}, undefined, "Connected · ready for walls", false],
    [{ state: "offline" as const }, undefined, "Offline · last seen", true],
    [{ protocolVersion: 5 }, undefined, "Not ready for walls · needs a T3o update", true],
    [
      { state: "incompatible" as const },
      undefined,
      "Not ready for walls · needs a T3o update",
      true,
    ],
    [{ checkout: false }, undefined, "Not ready for walls · no checkout", true],
    [{}, readiness("not-ready"), "Not ready for walls · readiness check fails", true],
  ])("%o reads as %s", (over, snapshot, text, warning) => {
    const status = boardScheduleWorkerStatus(worker(over), project, snapshot);
    expect(status.text.startsWith(text as string)).toBe(true);
    expect(status.warning).toBe(warning);
  });

  it("lists the board server first, and a worker that can't run now as disabled", () => {
    const choices = boardScheduleMachineChoices({
      state: {
        defaultWorkerId: "local",
        workers: [worker({ state: "offline" })],
        setups: [],
        joinCodes: [],
      },
      serverEnvironmentId: EnvironmentId.make("env-board"),
      project,
      capacity: new Map(),
    });
    expect(choices.map((choice) => [choice.label, choice.selectable])).toEqual([
      ["This server", true],
      ["build-01", false],
    ]);
  });
});
