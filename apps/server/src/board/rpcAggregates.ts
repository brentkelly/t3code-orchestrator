/**
 * The `rpc.aggregate` label of every board RPC (T3O-59), spread into upstream's
 * `RPC_AGGREGATES` (observability/RpcInstrumentation.ts), whose type makes a
 * method without a label a compile error.
 */
import {
  BOARD_WORKER_GATEWAY_WS_METHODS,
  BOARD_WORKER_WS_METHODS,
  BOARD_WORKERS_WS_METHODS,
  BOARD_WS_METHODS,
} from "@t3tools/contracts";

// T3O-62: worker management and the worker-side handshake are board RPCs too.
// T3O-63: so are the worker's thread gateway, the MCP relay and staging.
const BOARD_METHOD_MAPS = [
  BOARD_WS_METHODS,
  BOARD_WORKERS_WS_METHODS,
  BOARD_WORKER_WS_METHODS,
  BOARD_WORKER_GATEWAY_WS_METHODS,
];

type BoardWsMethod =
  | (typeof BOARD_WS_METHODS)[keyof typeof BOARD_WS_METHODS]
  | (typeof BOARD_WORKERS_WS_METHODS)[keyof typeof BOARD_WORKERS_WS_METHODS]
  | (typeof BOARD_WORKER_WS_METHODS)[keyof typeof BOARD_WORKER_WS_METHODS]
  | (typeof BOARD_WORKER_GATEWAY_WS_METHODS)[keyof typeof BOARD_WORKER_GATEWAY_WS_METHODS];

export const BOARD_RPC_AGGREGATES = Object.fromEntries(
  BOARD_METHOD_MAPS.flatMap((methods) => Object.values(methods)).map((method) => [method, "board"]),
) as Readonly<Record<BoardWsMethod, "board">>;
