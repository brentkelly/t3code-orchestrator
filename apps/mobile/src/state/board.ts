/**
 * T3o board state atoms for the mobile app, mirroring `apps/web/src/state/board.ts`.
 */
import {
  createBoardEnvironmentAtoms,
  createEnvironmentBoardStateAtoms,
} from "@t3tools/client-runtime/state/shell";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentShell } from "./shell";

export const environmentBoard = createEnvironmentBoardStateAtoms(connectionAtomRuntime);

export const boardEnvironment = createBoardEnvironmentAtoms(connectionAtomRuntime, {
  shellStateValueAtom: environmentShell.stateValueAtom,
  boardSnapshotValueAtom: environmentBoard.snapshotValueAtom,
});
