/**
 * T3o board workers — client operations. Each is one `board.workers.*` RPC on
 * the BOARD server.
 */
import {
  BOARD_WORKERS_WS_METHODS,
  type BoardWorkerIdInput,
  type BoardWorkersCancelJoinCodeInput,
  type BoardWorkersDismissSetupInput,
  type BoardWorkersRenameInput,
  type BoardWorkersSetDefaultInput,
  type BoardWorkersSetupProjectInput,
} from "@t3tools/contracts";

import { request } from "../rpc/client.ts";

/** A one-time join code; the plain code comes back only in this answer. */
export const createBoardWorkerJoinCode = () => request(BOARD_WORKERS_WS_METHODS.createJoinCode, {});

export const cancelBoardWorkerJoinCode = (input: BoardWorkersCancelJoinCodeInput) =>
  request(BOARD_WORKERS_WS_METHODS.cancelJoinCode, input);

export const renameBoardWorker = (input: BoardWorkersRenameInput) =>
  request(BOARD_WORKERS_WS_METHODS.rename, input);

/** A session on a worker for this client, through the board's proxy. */
export const boardWorkerThreadAccess = (input: BoardWorkerIdInput) =>
  request(BOARD_WORKERS_WS_METHODS.threadAccess, input);

export const removeBoardWorker = (input: BoardWorkerIdInput) =>
  request(BOARD_WORKERS_WS_METHODS.remove, input);

/** What removing a worker would do to its cards, for the confirm. */
export const previewBoardWorkerRemoval = (input: BoardWorkerIdInput) =>
  request(BOARD_WORKERS_WS_METHODS.removePreview, input);

export const setDefaultBoardWorker = (input: BoardWorkersSetDefaultInput) =>
  request(BOARD_WORKERS_WS_METHODS.setDefault, input);

export const setupBoardWorkerProject = (input: BoardWorkersSetupProjectInput) =>
  request(BOARD_WORKERS_WS_METHODS.setupProject, input);

export const dismissBoardWorkerSetup = (input: BoardWorkersDismissSetupInput) =>
  request(BOARD_WORKERS_WS_METHODS.dismissSetup, input);
