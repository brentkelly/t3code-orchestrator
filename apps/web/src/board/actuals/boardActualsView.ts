/**
 * T3o: the Measured table's lines and footer (T3O-87). "Not measured" is a state with its
 * reason, drawn with dashes and a tag, never as 0. A partial reading is a lower bound (≥).
 */
import {
  BOARD_LOCAL_WORKER_ABBREVIATION,
  BOARD_LOCAL_WORKER_ID,
  boardActualsFooter,
  boardActualsRowState,
  type BoardActualsRowState,
  type BoardCardActualsRow,
  type BoardResourceProfile,
  type BoardWorkersState,
} from "@t3tools/contracts";

import { BOARD_USAGE_UNKNOWN } from "../usage/boardUsageFormat";
import { localWorkerLabel } from "../workers/threadWorker";

const GiB = 1024 ** 3;
const GB = 1000 ** 3;
const MB = 1000 ** 2;

export interface BoardActualsLine {
  readonly key: string;
  /** The Usage row it lines up with (an agent step's role), for the linked hover. */
  readonly stepId: string | null;
  readonly label: string;
  readonly worker: { readonly label: string; readonly abbreviation: string };
  readonly state: BoardActualsRowState;
  readonly reason: string | null;
  readonly coreSeconds: string;
  readonly peakCores: string;
  readonly peakRam: string;
  readonly io: string;
  readonly disk: string;
}

const round = (value: number, digits = 1) => {
  const factor = 10 ** digits;
  return (Math.round(value * factor) / factor).toLocaleString("en-US", {
    maximumFractionDigits: digits,
  });
};

const bytes = (value: number) =>
  value >= GB ? `${round(value / GB)} GB` : `${round(value / MB, 0)} MB`;

export function boardWorkerNames(
  workerId: string,
  workers: BoardWorkersState,
): { readonly label: string; readonly abbreviation: string } {
  if (workerId === BOARD_LOCAL_WORKER_ID) {
    return { label: localWorkerLabel(workers), abbreviation: BOARD_LOCAL_WORKER_ABBREVIATION };
  }
  const worker = workers.workers.find((candidate) => candidate.id === workerId);
  const label = worker?.label ?? workerId;
  return { label, abbreviation: worker?.abbreviation ?? label.slice(0, 3).toUpperCase() };
}

export function boardActualsLines(
  rows: ReadonlyArray<BoardCardActualsRow>,
  workers: BoardWorkersState,
): ReadonlyArray<BoardActualsLine> {
  return rows.map((row) => {
    const state = boardActualsRowState(row);
    const { reading } = row;
    const at = state === "partial" ? "≥" : "";
    const figure = (value: number | null, format: (value: number) => string) =>
      state === "not-measured" || value === null ? BOARD_USAGE_UNKNOWN : `${at}${format(value)}`;
    return {
      key: `${row.stepKey}|${row.startedAt}`,
      stepId: row.stepId,
      label: row.label,
      worker: boardWorkerNames(row.workerId, workers),
      state,
      reason: reading.reason,
      coreSeconds: figure(reading.cpuCoreSeconds, (value) => round(value, 0)),
      peakCores: figure(reading.peakCpuCores, (value) => round(value)),
      peakRam: figure(reading.peakRamBytes, (value) => `${round(value / GiB)} GiB`),
      io:
        state === "not-measured" || reading.ioReadBytes === null || reading.ioWriteBytes === null
          ? BOARD_USAGE_UNKNOWN
          : `${at}${bytes(reading.ioReadBytes)} / ${bytes(reading.ioWriteBytes)}`,
      disk: reading.diskBytes === null ? BOARD_USAGE_UNKNOWN : bytes(reading.diskBytes),
    };
  });
}

/** The footer: the reservation on the card's worker now, and its peak as a share of it,
    from that placement's rows only. */
export function boardActualsFooterText(input: {
  readonly rows: ReadonlyArray<BoardCardActualsRow>;
  readonly workerId: string;
  readonly reservation: BoardResourceProfile;
}): { readonly reservation: string; readonly share: string | null } {
  const { share } = boardActualsFooter(input);
  const percent = (value: number | null, label: string) =>
    value === null ? null : `${label} ${Math.round(value * 100)}%`;
  const parts = [
    percent(share.cpuCores, "CPU"),
    percent(share.ramGiB, "RAM"),
    percent(share.diskGB, "disk"),
  ].filter((part): part is string => part !== null);
  const { cpuCores, ramGiB, diskGB } = input.reservation;
  return {
    reservation: `${round(cpuCores)} cores · ${round(ramGiB)} GiB · ${round(diskGB)} GB`,
    share: parts.length === 0 ? null : parts.join(" · "),
  };
}
