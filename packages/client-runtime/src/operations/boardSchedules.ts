/**
 * T3o: t3o.json schedules — client operations (T3O-117). Each is one
 * `board.schedules.*` RPC on the board server.
 */
import {
  BOARD_SCHEDULE_WS_METHODS,
  type BoardScheduleListInput,
  type BoardScheduleRef,
  type BoardScheduleRetryInput,
  type BoardScheduleSetMachineInput,
} from "@t3tools/contracts";

import { request } from "../rpc/client.ts";

export const listBoardSchedules = (input: BoardScheduleListInput) =>
  request(BOARD_SCHEDULE_WS_METHODS.list, input);

export const setBoardScheduleMachine = (input: BoardScheduleSetMachineInput) =>
  request(BOARD_SCHEDULE_WS_METHODS.setMachine, input);

export const runBoardScheduleNow = (input: BoardScheduleRef) =>
  request(BOARD_SCHEDULE_WS_METHODS.runNow, input);

export const retryBoardSchedules = (input: BoardScheduleRetryInput) =>
  request(BOARD_SCHEDULE_WS_METHODS.retry, input);

export const boardScheduleManagedTasks = () => request(BOARD_SCHEDULE_WS_METHODS.managedTasks, {});
