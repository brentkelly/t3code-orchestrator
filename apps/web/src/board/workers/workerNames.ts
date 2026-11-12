/**
 * A worker's label and abbreviation as Add worker and Rename edit them
 * (prototype 3.5, 3.6): the same rules the board server enforces, checked as
 * the human types so Save never sends a refusal.
 */
import {
  BOARD_LOCAL_WORKER_ABBREVIATION,
  BOARD_LOCAL_WORKER_ID,
  suggestBoardWorkerAbbreviation,
  type BoardWorkerId,
  type BoardWorkerView,
} from "@t3tools/contracts";

const LABEL_MAX_LENGTH = 64;

export interface WorkerNameProblems {
  readonly label: string | null;
  readonly abbreviation: string | null;
}

/** Abbreviation input is forced to uppercase and to letters and digits. */
export function normalizeAbbreviationInput(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 3);
}

export function workerNameProblems(input: {
  readonly workerId: BoardWorkerId;
  readonly label: string;
  readonly abbreviation: string;
  readonly workers: ReadonlyArray<Pick<BoardWorkerView, "id" | "label" | "abbreviation">>;
}): WorkerNameProblems {
  const label = input.label.trim();
  const labelProblem =
    label.length === 0
      ? "Give the worker a label."
      : label.length > LABEL_MAX_LENGTH
        ? `Keep the label to ${LABEL_MAX_LENGTH} characters.`
        : null;
  const abbreviation = input.abbreviation;
  const isLocal = input.workerId === BOARD_LOCAL_WORKER_ID;
  let abbreviationProblem: string | null = null;
  if (!/^[A-Z0-9]{1,3}$/.test(abbreviation)) {
    abbreviationProblem = "Use 1–3 letters or digits.";
  } else if (isLocal && abbreviation !== BOARD_LOCAL_WORKER_ABBREVIATION) {
    abbreviationProblem = `This server keeps ${BOARD_LOCAL_WORKER_ABBREVIATION}.`;
  } else if (!isLocal && abbreviation === BOARD_LOCAL_WORKER_ABBREVIATION) {
    abbreviationProblem = `${BOARD_LOCAL_WORKER_ABBREVIATION} is reserved for this server.`;
  } else {
    const holder = input.workers.find(
      (worker) => worker.id !== input.workerId && worker.abbreviation === abbreviation,
    );
    if (holder !== undefined)
      abbreviationProblem = `${abbreviation} is already used by ${holder.label}.`;
  }
  return { label: labelProblem, abbreviation: abbreviationProblem };
}

/** The abbreviation a worker is edited from: its own, else one suggested from its label. */
export function initialWorkerAbbreviation(
  worker: Pick<BoardWorkerView, "id" | "label" | "abbreviation">,
  workers: ReadonlyArray<Pick<BoardWorkerView, "id" | "abbreviation">>,
): string {
  if (worker.abbreviation !== undefined) return worker.abbreviation;
  const taken = workers.flatMap((other) =>
    other.id !== worker.id && other.abbreviation !== undefined ? [other.abbreviation] : [],
  );
  return suggestBoardWorkerAbbreviation(worker.label, taken) ?? "";
}
