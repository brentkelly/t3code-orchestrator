/**
 * T3o (T3O-65): the board's worker summary for every card surface below the
 * board page — the worker chip, the move notices, the worker field — so a
 * local-only board's cards read one empty summary rather than each
 * subscribing.
 */
import { EMPTY_BOARD_WORKERS_STATE, type BoardWorkersState } from "@t3tools/contracts";
import { createContext, useContext } from "react";

export const BoardWorkersContext = createContext<BoardWorkersState>(EMPTY_BOARD_WORKERS_STATE);

/** The board's worker summary, or the empty one outside a board. */
export function useBoardWorkersState(): BoardWorkersState {
  return useContext(BoardWorkersContext);
}
