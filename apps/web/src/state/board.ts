/**
 * T3o board state atoms for the web app, mirroring `state/threads.ts`. The
 * board rides its own subscription per environment; the thread shells
 * still come from the environment shell.
 */
import {
  createBoardEnvironmentAtoms,
  createEnvironmentBoardStateAtoms,
} from "@t3tools/client-runtime/state/shell";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentShell } from "./shell";
import { environmentThreadShells } from "./threads";

export const environmentBoard = createEnvironmentBoardStateAtoms(connectionAtomRuntime);

export const boardEnvironment = createBoardEnvironmentAtoms(connectionAtomRuntime, {
  shellStateValueAtom: environmentShell.stateValueAtom,
  boardSnapshotValueAtom: environmentBoard.snapshotValueAtom,
  // T3o: a subagent awaiting approval turns its card violet.
  pendingSubagentRequestsAtom: environmentThreadShells.pendingSubagentRequestsAtom,
});
