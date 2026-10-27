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
import { useEffect, useRef, useState } from "react";

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
  execute: Effect.fn("execute")(function* (input: {
    readonly environmentId: EnvironmentId;
    readonly sessionLabel: string;
  }) {
    const prepared = readPreparedConnection(input.environmentId);
    if (prepared === null) {
      return yield* new WorkerEnvironmentNotConnected({
        message: "This device isn't connected to that environment.",
      });
    }
    const minted = yield* mintEnvironmentPairingToken({ prepared, label: input.sessionLabel });
    // Where THIS device reaches the worker, which is where the board server
    // is asked to dial it.
    return { token: minted.credential, httpBaseUrl: prepared.httpBaseUrl };
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
 * The current time, re-read only when one of `deadlines` passes or the set of
 * deadlines changes (and never otherwise), so a transient state like "Set up
 * just now" settles without a ticking clock repainting the page.
 */
export function useNowAtDeadlines(deadlines: ReadonlyArray<number>): number {
  const [now, setNow] = useState(() => Date.now());
  const key = deadlines.join(",");
  // The deadlines `now` was last read for; new ones may belong to state that
  // arrived after that read, so the clock is re-read once for them.
  const readFor = useRef(key);
  useEffect(() => {
    const deadlinesNow = key
      .split(",")
      .filter((part) => part.length > 0)
      .map(Number);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      const current = Date.now();
      const next = deadlinesNow
        .filter((deadline) => deadline > current)
        .toSorted((left, right) => left - right)[0];
      if (next === undefined) return;
      timer = setTimeout(
        () => {
          setNow(Date.now());
          arm();
        },
        next - current + 50,
      );
    };
    if (readFor.current === key) {
      arm();
    } else {
      readFor.current = key;
      timer = setTimeout(() => {
        setNow(Date.now());
        arm();
      }, 0);
    }
    return () => clearTimeout(timer);
  }, [key]);
  return now;
}
