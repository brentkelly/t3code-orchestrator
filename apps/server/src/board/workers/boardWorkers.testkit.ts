/**
 * T3o (T3O-62): a `BoardWorkers` for suites that are not about workers — a
 * local-only board that refuses every worker operation. Its summary never
 * changes, so a board subscription under test sees exactly today's stream.
 */
import {
  BoardWorkerActionError,
  BoardWorkerAddError,
  EMPTY_BOARD_WORKERS_STATE,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { BoardPlacement } from "./BoardPlacement.ts";
import { BoardWorkers } from "./BoardWorkers.ts";
import { WorkerConnections, WorkerUnavailable } from "./WorkerConnections.ts";

const refused = new BoardWorkerAddError({
  code: "unreachable",
  message: "This test board has no workers.",
});
const refusedAction = new BoardWorkerActionError({
  code: "not-found",
  message: "This test board has no workers.",
});

export const BoardWorkersLocalOnlyTest = Layer.succeed(BoardWorkers, {
  add: () => Effect.fail(refused),
  repair: () => Effect.fail(refused),
  remove: () => Effect.fail(refusedAction),
  setDefault: () => Effect.fail(refusedAction),
  setupProject: () => Effect.fail(refusedAction),
  dismissSetup: () => Effect.void,
  state: Effect.succeed(EMPTY_BOARD_WORKERS_STATE),
  states: Stream.make(EMPTY_BOARD_WORKERS_STATE),
});

/** No worker connections at all (T3O-65): every card is placed on this server. */
export const WorkerConnectionsNoneTest = Layer.succeed(WorkerConnections, {
  get: (workerId) =>
    Effect.fail(
      new WorkerUnavailable({
        workerId,
        state: "unknown",
        message: "This test board has no workers.",
      }),
    ),
  current: Effect.succeed(new Map()),
  states: Stream.make(new Map()),
  changes: Stream.empty,
  sync: () => Effect.void,
  restart: () => Effect.void,
  refresh: () => Effect.void,
  record: () => Effect.void,
});

/** A local-only board's placement (T3O-65): no workers, and nothing changes. */
export const BoardPlacementLocalOnlyTest = Layer.succeed(BoardPlacement, {
  workers: Effect.succeed(EMPTY_BOARD_WORKERS_STATE),
  changes: Stream.empty,
});
