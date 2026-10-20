/**
 * The `rpc.aggregate` label of every board RPC (T3O-59), spread into upstream's
 * `RPC_AGGREGATES` (observability/RpcInstrumentation.ts), whose type makes a
 * method without a label a compile error.
 */
import { BOARD_WS_METHODS } from "@t3tools/contracts";

type BoardWsMethod = (typeof BOARD_WS_METHODS)[keyof typeof BOARD_WS_METHODS];

export const BOARD_RPC_AGGREGATES = Object.fromEntries(
  Object.values(BOARD_WS_METHODS).map((method) => [method, "board"]),
) as Readonly<Record<BoardWsMethod, "board">>;
