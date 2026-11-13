/** T3o: the web's reads behind the Workers settings. */
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { BoardWorkersState, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { boardEnvironment, environmentBoard } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { boardWorkersLoad } from "./threadWorker";
import { pruneWorkerThreadEnvironments } from "./workerThreadEnvironments";

export interface BoardWorkersView {
  readonly loading: boolean;
  /** The board server didn't answer and nothing is held. */
  readonly failed: boolean;
  /** A snapshot has arrived, so `state` is the board's real worker list. */
  readonly loaded: boolean;
  readonly retry: () => void;
  readonly state: BoardWorkersState;
}

/** The board's worker summary, with the subscription's loading and failure. */
export function useBoardWorkers(environmentId: EnvironmentId): BoardWorkersView {
  const result = useAtomValue(environmentBoard.stateAtom(environmentId));
  const retry = useAtomRefresh(environmentBoard.stateAtom(environmentId));
  const hasSnapshot = useAtomValue(environmentBoard.snapshotValueAtom(environmentId)) !== null;
  const state = useAtomValue(boardEnvironment.workersAtom(environmentId));
  return { ...boardWorkersLoad({ resultTag: result._tag, hasSnapshot }), retry, state };
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one timer that re-reads the clock when the next deadline passes.
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

/**
 * Removes the environments this client registered for the board's workers
 * once the board has loaded without them (a removed worker), so a worker's
 * proxied environment never outlives its place on the board.
 */
export function usePruneWorkerThreadEnvironments(environmentId: EnvironmentId): void {
  const workers = useBoardWorkers(environmentId);
  const prune = useAtomCommand(pruneWorkerThreadEnvironments, { reportFailure: false });
  const loaded = workers.loaded;
  const workerIds = workers.state.workers.map((worker) => worker.id).join(",");
  // `prune` is a fresh closure every render; the board and its worker list are what matter.
  const pruneFor = useEffectEvent((boardEnvironmentId: EnvironmentId, ids: string) => {
    void prune({ boardEnvironmentId, workerIds: ids.split(",").filter(Boolean) });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- removes stale environments from the client's connection registry when the board's worker list changes.
  useEffect(() => {
    if (loaded) pruneFor(environmentId, workerIds);
  }, [environmentId, workerIds, loaded]);
}
