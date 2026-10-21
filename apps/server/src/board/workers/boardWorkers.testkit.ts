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

import { BoardWorkers } from "./BoardWorkers.ts";

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
  changes: Stream.never,
});
