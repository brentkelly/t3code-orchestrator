/**
 * T3o: what each worker offers this board (T3O-86), from `board.workers.subscribeCapacity`.
 * Opened only by the Workers page, the pin picker, the Resources tab and a queued card's
 * detail, never by every card: capacity changes far more often than the board does.
 */
import {
  BOARD_WORKERS_WS_METHODS,
  type BoardResourceProfile,
  type BoardWorkerCapacitySnapshot,
  type BoardWorkersCapacityActionInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { request, subscribeDynamic } from "../rpc/client.ts";

/** A worker's snapshot, with what this board's own cards hold there when the board knows. */
export type BoardWorkerCapacityView = BoardWorkerCapacitySnapshot & {
  readonly held?: BoardResourceProfile;
};

export type BoardCapacityView = ReadonlyMap<string, BoardWorkerCapacityView>;

const EMPTY_BOARD_CAPACITY_VIEW: BoardCapacityView = new Map();

/** Every worker's latest snapshot, folded from the stream. */
export const boardCapacityViewStream = () =>
  subscribeDynamic(BOARD_WORKERS_WS_METHODS.subscribeCapacity, () => Effect.succeed({})).pipe(
    Stream.scan(
      (): BoardCapacityView => EMPTY_BOARD_CAPACITY_VIEW,
      (view, item): BoardCapacityView =>
        new Map(view).set(
          item.workerId,
          item.held === undefined ? item.snapshot : { ...item.snapshot, held: item.held },
        ),
    ),
  );

/** Re-check readiness, or read a readiness or setup log. */
export const boardCapacityAction = (input: BoardWorkersCapacityActionInput) =>
  request(BOARD_WORKERS_WS_METHODS.capacityAction, input);
