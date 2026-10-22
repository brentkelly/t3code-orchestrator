/**
 * T3o (T3O-63): where the supervisor spawns a card's threads.
 *
 * Placement is T3O-65's: until a card can be pinned to a worker, every thread
 * runs on this server and nothing provides this service. A test provides it
 * to put a card's threads on a worker, which is how the remote gateway, the
 * signal feed and the MCP relay are driven end to end before placement exists.
 */
import type { BoardCard, BoardWorkerId } from "@t3tools/contracts";
import * as Context from "effect/Context";

export interface BoardPlacementShape {
  /** The worker a card's next thread spawns on. */
  readonly workerFor: (card: BoardCard) => BoardWorkerId;
}

export class BoardPlacement extends Context.Service<BoardPlacement, BoardPlacementShape>()(
  "t3/board/workers/BoardPlacement",
) {}
