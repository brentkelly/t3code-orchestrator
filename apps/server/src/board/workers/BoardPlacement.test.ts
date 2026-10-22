import {
  BOARD_LOCAL_WORKER_ID,
  EnvironmentId,
  ProjectId,
  type BoardWorkersState,
  type BoardWorkerSetup,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { boardPlacementChanges } from "./BoardPlacement.ts";

const W1 = EnvironmentId.make("env-w1");

const cloning = (percent: number, phase: BoardWorkerSetup["phase"] = "cloning"): BoardWorkerSetup => ({
  projectId: ProjectId.make("project-1"),
  workerId: W1,
  workerProjectId: null,
  destinationPath: "/home/w1/repo",
  phase,
  stage: "receiving",
  percent,
  failure: null,
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: null,
});

const summary = (
  setup: BoardWorkerSetup,
  options: { readonly online?: boolean; readonly reportedAt?: string } = {},
): BoardWorkersState => ({
  defaultWorkerId: BOARD_LOCAL_WORKER_ID,
  workers: [
    {
      id: W1,
      label: "w1",
      url: "http://env-w1:3773",
      addedAt: "2026-01-01T00:00:00.000Z",
      status: {
        state: options.online === false ? "offline" : "online",
        lastSeenAt: null,
        t3oVersion: "0.1.0",
        protocolVersion: 1,
      },
      snapshot: {
        providers: [],
        checkouts: [],
        projectsFolder: null,
        reportedAt: options.reportedAt ?? "2026-01-01T00:00:00.000Z",
      },
    },
  ],
  setups: [setup],
});

it.effect("clone progress and snapshot timestamps do not tick placement", () =>
  Effect.gen(function* () {
    const ticks = yield* Stream.runCount(
      boardPlacementChanges(
        Stream.fromIterable([
          summary(cloning(1)),
          summary(cloning(40)),
          summary(cloning(80), { reportedAt: "2026-01-01T00:01:00.000Z" }),
          // The clone lands, then the worker drops: two gate-relevant changes.
          summary(cloning(100, "done")),
          summary(cloning(100, "done"), { online: false }),
        ]),
      ),
    );
    assert.strictEqual(ticks, 2);
  }),
);
