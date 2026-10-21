/**
 * T3o board workers — client operations (T3O-62, D19).
 *
 * Each is one `board.workers.*` RPC on the BOARD server. Minting the one-time
 * pairing token on the worker itself is a different call, on a different
 * environment: see `mintEnvironmentPairingToken`.
 */
import {
  BOARD_WORKERS_WS_METHODS,
  type BoardWorkerIdInput,
  type BoardWorkersAddInput,
  type BoardWorkersDismissSetupInput,
  type BoardWorkersRepairInput,
  type BoardWorkersSetDefaultInput,
  type BoardWorkersSetupProjectInput,
} from "@t3tools/contracts";

import { request } from "../rpc/client.ts";

export const addBoardWorker = (input: BoardWorkersAddInput) =>
  request(BOARD_WORKERS_WS_METHODS.add, input);

export const repairBoardWorker = (input: BoardWorkersRepairInput) =>
  request(BOARD_WORKERS_WS_METHODS.repair, input);

export const removeBoardWorker = (input: BoardWorkerIdInput) =>
  request(BOARD_WORKERS_WS_METHODS.remove, input);

export const setDefaultBoardWorker = (input: BoardWorkersSetDefaultInput) =>
  request(BOARD_WORKERS_WS_METHODS.setDefault, input);

export const setupBoardWorkerProject = (input: BoardWorkersSetupProjectInput) =>
  request(BOARD_WORKERS_WS_METHODS.setupProject, input);

export const dismissBoardWorkerSetup = (input: BoardWorkersDismissSetupInput) =>
  request(BOARD_WORKERS_WS_METHODS.dismissSetup, input);
