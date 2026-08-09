/**
 * T3o board state atoms for the web app, mirroring `state/threads.ts`.
 */
import { createBoardEnvironmentAtoms } from "@t3tools/client-runtime/state/shell";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentShell } from "./shell";

export const boardEnvironment = createBoardEnvironmentAtoms(connectionAtomRuntime, {
  shellStateValueAtom: environmentShell.stateValueAtom,
});
