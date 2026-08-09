/**
 * T3o board state atoms for the web app, mirroring `state/threads.ts`.
 */
import { createBoardEnvironmentAtoms } from "@t3tools/client-runtime/state/shell";

import { connectionAtomRuntime } from "../connection/runtime";

export const boardEnvironment = createBoardEnvironmentAtoms(connectionAtomRuntime);
