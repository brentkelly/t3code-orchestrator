/**
 * Worker summaries for supervisor tests that place cards: online workers with a checkout of
 * the harness project and a provider, and a placement service the test can change.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  ProjectId,
  ProviderInstanceId,
  type BoardWorkerId,
  type BoardWorkersState,
  type BoardWorkerView,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { BoardPlacementShape } from "./BoardPlacement.ts";

/** The harness project's repository, as the workers' checkouts report it. */
const REPOSITORY_KEY = "github.com/acme/repo";

export const workerView = (
  id: EnvironmentId,
  options: {
    readonly label?: string;
    readonly online?: boolean;
    readonly checkout?: boolean;
    readonly providers?: ReadonlyArray<ProviderInstanceId>;
    readonly protocolVersion?: number;
  } = {},
): BoardWorkerView => ({
  id,
  label: options.label ?? String(id).replace(/^env-/, ""),
  url: `http://${id}:3773`,
  addedAt: "2026-01-01T00:00:00.000Z",
  status: {
    state: options.online === false ? "offline" : "online",
    lastSeenAt: null,
    t3oVersion: "0.1.0",
    protocolVersion: options.protocolVersion ?? 1,
  },
  snapshot: {
    providers: (options.providers ?? [ProviderInstanceId.make("codex")]).map((instanceId) => ({
      instanceId,
      driver: "codex",
      displayName: null,
      enabled: true,
      models: [],
    })),
    checkouts:
      options.checkout === false
        ? []
        : [
            {
              projectId: ProjectId.make(`${id}-project`),
              title: "repo",
              workspaceRoot: `/home/${id}/repo`,
              repositoryKey: REPOSITORY_KEY,
            },
          ],
    projectsFolder: null,
    reportedAt: "2026-01-01T00:00:00.000Z",
  },
});

export const workersState = (
  workers: ReadonlyArray<BoardWorkerView>,
  defaultWorkerId: BoardWorkerId = BOARD_LOCAL_WORKER_ID,
): BoardWorkersState => ({ defaultWorkerId, workers, setups: [], joinCodes: [] });

/** A placement whose worker summary the test changes, ticking on each change. */
export const makePlacement = (initial: BoardWorkersState) =>
  Effect.map(SubscriptionRef.make(initial), (ref) => ({
    ref,
    placement: {
      workers: SubscriptionRef.get(ref),
      changes: SubscriptionRef.changes(ref).pipe(Stream.drop(1)),
    } satisfies BoardPlacementShape,
  }));

/** The registry entry for a worker, as the board records it. */
export const registeredWorker = (id: EnvironmentId, label?: string) => ({
  id,
  label: label ?? String(id).replace(/^env-/, ""),
  url: `http://${id}:3773`,
  addedAt: "2026-01-01T00:00:00.000Z",
});

/** A placement that never changes. */
export const staticPlacement = (state: BoardWorkersState): BoardPlacementShape => ({
  workers: Effect.succeed(state),
  changes: Stream.empty,
});
