/**
 * T3o (T3O-65): the board's worker summary for every card surface below the
 * board page — the worker chip, the move notices, the worker field — so a
 * local-only board's cards read one empty summary rather than each
 * subscribing.
 */
import { EMPTY_BOARD_WORKERS_STATE, type BoardWorkersState } from "@t3tools/contracts";
import { createContext, useContext, useMemo } from "react";

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
export function boardWorkersCardView(state: BoardWorkersState): BoardWorkersState {
  return {
    ...state,
    setups: state.setups.map((setup) => ({ ...setup, stage: null, percent: null })),
  };
}

/** `boardWorkersCardView`, kept the same object until what it holds changes. */
export function useBoardWorkersCardView(state: BoardWorkersState): BoardWorkersState {
  const key = JSON.stringify(boardWorkersCardView(state));
  return useMemo(() => JSON.parse(key) as BoardWorkersState, [key]);
}
