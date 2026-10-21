/**
 * T3o (T3O-62): the web's reads and the one client-side action behind the
 * Workers settings.
 */
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { mintEnvironmentPairingToken } from "@t3tools/client-runtime/state/shell";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import type { BoardWorkersState, EnvironmentId } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { useEffect, useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { boardEnvironment, environmentBoard } from "../../state/board";
import { readPreparedConnection } from "../../state/session";

export class WorkerEnvironmentNotConnected extends Data.TaggedError(
  "WorkerEnvironmentNotConnected",
)<{ readonly message: string }> {}

/**
 * Mint a one-time pairing token on a worker environment with THIS client's
 * session there, for the board server to spend (D19). The token is labelled
 * as the board's session, so the worker's Connections list names it.
 */
export const mintWorkerPairingToken = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:board:mint-worker-pairing-token",
  execute: (input: { readonly environmentId: EnvironmentId; readonly sessionLabel: string }) =>
    Effect.gen(function* () {
      const prepared = readPreparedConnection(input.environmentId);
      if (prepared === null) {
        return yield* new WorkerEnvironmentNotConnected({
          message: "This device isn't connected to that environment.",
        });
      }
      return yield* mintEnvironmentPairingToken({ prepared, label: input.sessionLabel });
    }),
});

export interface BoardWorkersView {
  readonly loading: boolean;
  /** The board server didn't answer and nothing is held. */
  readonly failed: boolean;
  readonly retry: () => void;
  readonly state: BoardWorkersState;
}

/** The board's worker summary, with the subscription's loading and failure. */
export function useBoardWorkers(environmentId: EnvironmentId): BoardWorkersView {
  const result = useAtomValue(environmentBoard.stateAtom(environmentId));
  const retry = useAtomRefresh(environmentBoard.stateAtom(environmentId));
  const state = useAtomValue(boardEnvironment.workersAtom(environmentId));
  return {
    loading: result._tag === "Initial",
    failed: result._tag === "Failure",
    retry,
    state,
  };
}

/**
 * The current time, re-read once at `deadline` (and never otherwise), so a
 * transient state like "Set up just now" settles without a ticking clock
 * repainting the page.
 */
export function useNowUntil(deadline: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    const delay = deadline - Date.now();
    if (delay <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), delay + 50);
    return () => clearTimeout(timer);
  }, [deadline]);
  return now;
}
