/**
 * T3o: the board's worker summary for every card surface below the
 * board page — the worker chip, the move notices, the worker field — so a
 * local-only board's cards read one empty summary rather than each
 * subscribing.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_BOARD_WORKERS_STATE,
  type BoardWorkersState,
  type EnvironmentId,
} from "@t3tools/contracts";
import { createContext, useContext, useState } from "react";

import { boardEnvironment } from "../../state/board";

export const BoardWorkersContext = createContext<BoardWorkersState>(EMPTY_BOARD_WORKERS_STATE);

/** The board's worker summary, or the empty one outside a board. */
export function useBoardWorkersState(): BoardWorkersState {
  return useContext(BoardWorkersContext);
}

/**
 * The summary as the cards read it: a clone's progress (`stage`, `percent`)
 * dropped, since no card surface shows it. A clone streams those many times a
 * second, and every new summary would otherwise re-render every card on the
 * board.
 */
function boardWorkersCardView(state: BoardWorkersState): BoardWorkersState {
  return {
    ...state,
    setups: state.setups.map((setup) => ({ ...setup, stage: null, percent: null })),
  };
}

/** `boardWorkersCardView`, kept the same object until what it holds changes. */
export function useBoardWorkersCardView(environmentId: EnvironmentId): BoardWorkersState {
  const state = useAtomValue(boardEnvironment.workersAtom(environmentId));
  const view = boardWorkersCardView(state);
  const key = JSON.stringify(view);
  // Held in state, as `useStableHandoffRuns` does: the compiler caches on `state`, which
  // every clone-progress tick replaces.
  const [stable, setStable] = useState({ key, view });
  if (stable.key === key) return stable.view;
  setStable({ key, view });
  return view;
}
