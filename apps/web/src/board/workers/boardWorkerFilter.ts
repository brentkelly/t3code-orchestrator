/**
 * T3o: the board header's worker filter (T3O-87). It matches a card's placement target only (the
 * worker its worktree is on), so a card planned on the board server and built on build-01 shows
 * under build-01. Selections ride the URL by worker id, never by label.
 */
import {
  BOARD_LOCAL_WORKER_ABBREVIATION,
  BOARD_LOCAL_WORKER_ID,
  type BoardCardShell,
  type BoardWorkersState,
} from "@t3tools/contracts";
import type { BoardStageColumns } from "@t3tools/client-runtime/state/shell";

/** The "Not placed yet" choice. */
export const BOARD_UNPLACED_FILTER = "unplaced";

type ShellPlacementFields = Pick<
  BoardCardShell,
  "workerId" | "worktreeReady" | "worktreeProvisioning"
>;

/** Whether the shell's `workerId` is a placement: its worktree is ready or being made there. */
export const boardShellHoldsWorktree = (card: ShellPlacementFields): boolean =>
  card.worktreeReady === true || card.worktreeProvisioning === true;

/** The worker a card's worktree is on, or null before the gate places it. */
export function boardShellPlacementTarget(card: ShellPlacementFields): string | null {
  return boardShellHoldsWorktree(card) ? (card.workerId ?? BOARD_LOCAL_WORKER_ID) : null;
}

/** The selection a URL names, without ids of workers no longer on the board. */
export function parseBoardWorkerFilter(
  param: string | undefined,
  state: Pick<BoardWorkersState, "workers">,
): ReadonlyArray<string> {
  if (param === undefined || param.trim() === "") return [];
  const known = new Set<string>([
    BOARD_LOCAL_WORKER_ID,
    BOARD_UNPLACED_FILTER,
    ...state.workers.map((worker) => worker.id),
  ]);
  return [...new Set(param.split(",").map((part) => part.trim()))].filter((id) => known.has(id));
}

export const serializeBoardWorkerFilter = (selection: ReadonlyArray<string>): string | undefined =>
  selection.length === 0 ? undefined : selection.join(",");

export function boardCardMatchesWorkerFilter(
  card: ShellPlacementFields,
  selection: ReadonlySet<string>,
): boolean {
  if (selection.size === 0) return true;
  return selection.has(boardShellPlacementTarget(card) ?? BOARD_UNPLACED_FILTER);
}

export function filterBoardColumnsByWorker(
  columns: BoardStageColumns,
  selection: ReadonlySet<string>,
): BoardStageColumns {
  if (selection.size === 0) return columns;
  return Object.fromEntries(
    Object.entries(columns).map(([stageId, cards]) => [
      stageId,
      cards.filter((card) => boardCardMatchesWorkerFilter(card, selection)),
    ]),
  ) as BoardStageColumns;
}

/** A selection's short name, by abbreviation: up to two, then a count. */
export function boardWorkerFilterLabel(
  selection: ReadonlyArray<string>,
  state: Pick<BoardWorkersState, "workers">,
): string {
  const short = (id: string) =>
    id === BOARD_UNPLACED_FILTER
      ? "Not placed"
      : id === BOARD_LOCAL_WORKER_ID
        ? BOARD_LOCAL_WORKER_ABBREVIATION
        : (state.workers.find((worker) => worker.id === id)?.abbreviation ??
          state.workers.find((worker) => worker.id === id)?.label ??
          id);
  if (selection.length === 0) return "Worker";
  if (selection.length <= 2) return selection.map(short).join(", ");
  return `${short(selection[0]!)}, ${short(selection[1]!)} +${selection.length - 2}`;
}

/** The filter remembered per board in this browser, for a URL that names none. */
export const boardWorkerFilterStorageKey = (boardKey: string) =>
  `t3o:board-worker-filter:${boardKey}`;
