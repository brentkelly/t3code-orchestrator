/**
 * T3o board state atoms for the web app, mirroring `state/threads.ts`. The
 * board rides its own subscription per environment (T3O-57); the thread shells
 * still come from the environment shell.
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
