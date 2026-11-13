/**
 * T3o: measured resource actuals and learned baselines (T3O-87). A worker samples each heavy
 * step's control group and relays the reading; the board keeps one row per card step and
 * learns a project's baseline from them. "Not measured" is a state of its own, never a 0.
 * Imports only leaf modules, so `boardWorkerGateway.ts` and `board.ts` can import it.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  BOARD_CARD_SIZE_MULTIPLIERS,
  BOARD_LEARNED_MIN_SAMPLES,
  BOARD_LEARNED_WINDOW_DAYS,
  BOARD_RESOURCE_DIMENSIONS,
  BoardResourceProfile,
  boardPlannerUse,
  type BoardCardSize,
  type BoardLearnedDimension,
  type BoardProjectLearned,
  type BoardProjectResources,
  type BoardResourceDimension,
} from "./boardCapacity.ts";

const NonNegativeNumber = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** How often a worker samples a step's control group. */
export const BOARD_ACTUALS_SAMPLE_INTERVAL_MS = 5_000;
/** The window the peak CPU rate averages over. */
export const BOARD_ACTUALS_PEAK_WINDOW_MS = 60_000;

const GiB = 1024 ** 3;
const GB = 1000 ** 3;

/** What a worker measured of one step, so far or in full. */
export const BoardStepReading = Schema.Struct({
  /** False when nothing could be measured; `reason` says why. */
  measured: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
  /** Still sampling: the figures are so far. */
  running: Schema.Boolean,
  /** A restart cut into the step: the figures are a lower bound. */
  partial: Schema.Boolean,
  cpuCoreSeconds: Schema.NullOr(NonNegativeNumber),
  /** The highest 1-minute average rate, in cores; over the whole step when shorter. */
  peakCpuCores: Schema.NullOr(NonNegativeNumber),
  /** The peak of `anon` + `shmem`: page cache excluded. */
  peakRamBytes: Schema.NullOr(NonNegativeNumber),
  ioReadBytes: Schema.NullOr(NonNegativeNumber),
  ioWriteBytes: Schema.NullOr(NonNegativeNumber),
  /** The worktree's footprint at the step's end. */
  diskBytes: Schema.NullOr(NonNegativeNumber),
  samples: NonNegativeInt,
});
export type BoardStepReading = typeof BoardStepReading.Type;

export function boardStepNotMeasured(reason: string): BoardStepReading {
  return {
    measured: false,
    reason,
    running: false,
    partial: false,
    cpuCoreSeconds: null,
    peakCpuCores: null,
    peakRamBytes: null,
    ioReadBytes: null,
    ioWriteBytes: null,
    diskBytes: null,
    samples: 0,
  };
}

/** The board's relay call to a worker. The board is the calling session's. */
export const BoardWorkerActualsInput = Schema.Struct({
  /** `read` returns the figures so far; `end` takes a last sample, measures the worktree and
      forgets the key. */
  op: Schema.Literals(["read", "end"]),
  /** `thread:<id>`, `ci:<runId>` or `setup:<worktree>`. */
  key: TrimmedNonEmptyString,
  /** An agent step's thread, whose scope the worker samples; begun on first read. */
  threadId: Schema.optionalKey(TrimmedNonEmptyString),
  worktreePath: Schema.optionalKey(TrimmedNonEmptyString),
  /** The board stored a reading for this key before: one begun now is partial. */
  seen: Schema.optionalKey(Schema.Boolean),
});
export type BoardWorkerActualsInput = typeof BoardWorkerActualsInput.Type;

const BOARD_ACTUALS_STEP_KINDS = ["agent", "ci", "setup"] as const;
export const BoardActualsStepKind = Schema.Literals(BOARD_ACTUALS_STEP_KINDS);
export type BoardActualsStepKind = typeof BoardActualsStepKind.Type;

/** One measured step of a card, as the board stores it. It keeps the worker it ran on and the
    profile granted then, so a re-placed card never mixes one worker's peak with another's grant. */
export const BoardCardActualsRow = Schema.Struct({
  stepKey: TrimmedNonEmptyString,
  kind: BoardActualsStepKind,
  /** An agent step's thread link role (as Usage rows carry), for the linked hover. */
  stepId: Schema.NullOr(TrimmedNonEmptyString),
  label: TrimmedNonEmptyString,
  workerId: TrimmedNonEmptyString,
  grantedProfile: Schema.NullOr(BoardResourceProfile),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  reading: BoardStepReading,
  updatedAt: IsoDateTime,
});
export type BoardCardActualsRow = typeof BoardCardActualsRow.Type;

export type BoardActualsRowState = "complete" | "partial" | "not-measured" | "so-far";

export function boardActualsRowState(
  row: Pick<BoardCardActualsRow, "reading">,
): BoardActualsRowState {
  if (!row.reading.measured) return "not-measured";
  if (row.reading.running) return "so-far";
  return row.reading.partial ? "partial" : "complete";
}

// ── Why an agent step isn't measured ───────────────────────────────────

const UNSCOPED_PROVIDERS: ReadonlyArray<readonly [string, string]> = [
  ["cursor", "Cursor"],
  ["grok", "Grok"],
  ["opencode", "OpenCode"],
  ["antigravity", "Antigravity"],
  ["kiro", "Kiro"],
];

export const BOARD_ACTUALS_NO_CGROUP_REASON =
  "This machine has no per-agent control groups (macOS, or no systemd user manager).";

/** Why a provider's agent step can't be measured, or null when only the worker can tell
    (Claude runs in its own scope; an unknown instance is asked). */
export function boardAgentActualsSkipReason(providerInstanceId: string): string | null {
  const id = providerInstanceId.toLowerCase();
  if (id.startsWith("codex")) {
    return "Codex runs every agent in one shared scope, so one step can't be told apart.";
  }
  for (const [prefix, name] of UNSCOPED_PROVIDERS) {
    if (id.startsWith(prefix)) return `${name} agents don't run in a scope of their own.`;
  }
  return null;
}

// ── The footer ─────────────────────────────────────────────────────────

export interface BoardActualsPeaks {
  readonly cpuCores: number | null;
  readonly ramGiB: number | null;
  readonly diskGB: number | null;
}

const maxOf = (values: ReadonlyArray<number | null>): number | null => {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.max(...present);
};

function peaksOf(rows: ReadonlyArray<BoardCardActualsRow>): BoardActualsPeaks {
  const measured = rows.filter((row) => row.reading.measured);
  return {
    cpuCores: maxOf(measured.map((row) => row.reading.peakCpuCores)),
    ramGiB: maxOf(
      measured.map((row) =>
        row.reading.peakRamBytes === null ? null : row.reading.peakRamBytes / GiB,
      ),
    ),
    diskGB: maxOf(
      measured.map((row) => (row.reading.diskBytes === null ? null : row.reading.diskBytes / GB)),
    ),
  };
}

/** The Measured footer: the card's reservation on its current worker and its peak as a share of
    it, from that placement's rows only. */
export function boardActualsFooter(input: {
  readonly rows: ReadonlyArray<BoardCardActualsRow>;
  readonly workerId: string;
  readonly reservation: BoardResourceProfile;
}): { readonly peaks: BoardActualsPeaks; readonly share: BoardActualsPeaks } {
  const peaks = peaksOf(input.rows.filter((row) => row.workerId === input.workerId));
  const share = (peak: number | null, held: number) =>
    peak === null || held <= 0 ? null : peak / held;
  return {
    peaks,
    share: {
      cpuCores: share(peaks.cpuCores, input.reservation.cpuCores),
      ramGiB: share(peaks.ramGiB, input.reservation.ramGiB),
      diskGB: share(peaks.diskGB, input.reservation.diskGB),
    },
  };
}

// ── Learning ───────────────────────────────────────────────────────────

/** One card's sample, normalised to an M card. */
export interface BoardActualsCardSample {
  readonly at: string;
  readonly cpu: number | null;
  readonly ram: number | null;
  readonly disk: number | null;
}

/**
 * One sample per card: per dimension the largest value over its measured, finished steps,
 * normalised by its size multiplier. A card with no measured CI pass or setup gives none, so an
 * agent step alone (often idle) never makes a sample. A partial reading is a lower bound and
 * is left out.
 */
export function boardCardActualsSample(
  rows: ReadonlyArray<BoardCardActualsRow>,
  size: BoardCardSize,
): BoardActualsCardSample | null {
  const usable = rows.filter((row) => boardActualsRowState(row) === "complete");
  if (!usable.some((row) => row.kind === "ci" || row.kind === "setup")) return null;
  const peaks = peaksOf(usable);
  const normalised = (value: number | null, dimension: BoardResourceDimension) =>
    value === null ? null : value / BOARD_CARD_SIZE_MULTIPLIERS[size[dimension]];
  const at = usable
    .map((row) => row.endedAt ?? row.updatedAt)
    .reduce((latest, next) => (next > latest ? next : latest));
  return {
    at,
    cpu: normalised(peaks.cpuCores, "cpu"),
    ram: normalised(peaks.ramGiB, "ram"),
    disk: normalised(peaks.diskGB, "disk"),
  };
}

const HISTORY_POINTS = 30;
/** Rounding up absorbs float noise first, so 3.0000000001 stays 3. */
const roundUp = (value: number) => Math.ceil(Math.round(value * 1e6) / 1e6);

/** The 90th percentile (nearest rank) across cards, rounded up, over the last 30 days; null
    under five samples. */
export function boardLearnedDimension(
  samples: ReadonlyArray<BoardActualsCardSample>,
  dimension: BoardResourceDimension,
  nowIso: string,
): BoardLearnedDimension {
  const since = Date.parse(nowIso) - BOARD_LEARNED_WINDOW_DAYS * 24 * 60 * 60_000;
  const inWindow = samples
    .filter((sample) => Date.parse(sample.at) >= since)
    .sort((left, right) => left.at.localeCompare(right.at))
    .map((sample) => sample[dimension])
    .filter((value): value is number => value !== null);
  const history = inWindow.slice(-HISTORY_POINTS);
  if (inWindow.length < BOARD_LEARNED_MIN_SAMPLES) {
    return { value: null, samples: inWindow.length, history };
  }
  const sorted = [...inWindow].sort((left, right) => left - right);
  const p90 = sorted[Math.ceil(0.9 * sorted.length) - 1]!;
  return { value: roundUp(p90), samples: inWindow.length, history };
}

/**
 * A project's learned baseline. An increase that would leave an M card unplaceable on every
 * ready worker is marked, so it shows as a warning and is never applied. With no worker
 * reporting, nothing is marked.
 */
export function boardProjectLearned(input: {
  readonly samples: ReadonlyArray<BoardActualsCardSample>;
  readonly resources: BoardProjectResources | null | undefined;
  readonly readyWorkers: ReadonlyArray<BoardResourceProfile>;
  readonly nowIso: string;
}): BoardProjectLearned {
  const learned = {
    computedAt: input.nowIso,
    cpu: boardLearnedDimension(input.samples, "cpu", input.nowIso),
    ram: boardLearnedDimension(input.samples, "ram", input.nowIso),
    disk: boardLearnedDimension(input.samples, "disk", input.nowIso),
  } satisfies BoardProjectLearned;
  const withLearned = { ...input.resources, learned } as BoardProjectResources;
  const marked = { ...learned };
  for (const dimension of BOARD_RESOURCE_DIMENSIONS) {
    const use = boardPlannerUse(withLearned, dimension);
    const key = ({ cpu: "cpuCores", ram: "ramGiB", disk: "diskGB" } as const)[dimension];
    const unplaceable =
      use.source === "learned" &&
      input.readyWorkers.length > 0 &&
      input.readyWorkers.every((declared) => declared[key] < use.value);
    if (unplaceable) marked[dimension] = { ...learned[dimension], unplaceable: true };
  }
  return marked;
}

/** Whether two learned baselines say the same, ignoring when they were computed. */
export function boardProjectLearnedEqual(
  left: BoardProjectLearned | undefined,
  right: BoardProjectLearned | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  const strip = ({ computedAt: _at, ...rest }: BoardProjectLearned) => JSON.stringify(rest);
  return strip(left) === strip(right);
}

/** What an agent's card read carries of the card's actuals: small on purpose. */
export const BoardCardActualsSummary = Schema.Struct({
  measuredSteps: NonNegativeInt,
  notMeasuredSteps: NonNegativeInt,
  peakCpuCores: Schema.NullOr(NonNegativeNumber),
  peakRamGiB: Schema.NullOr(NonNegativeNumber),
  diskGB: Schema.NullOr(NonNegativeNumber),
});
export type BoardCardActualsSummary = typeof BoardCardActualsSummary.Type;

export function boardCardActualsSummary(
  rows: ReadonlyArray<BoardCardActualsRow>,
): BoardCardActualsSummary | null {
  if (rows.length === 0) return null;
  const peaks = peaksOf(rows);
  const round = (value: number | null) => (value === null ? null : Math.round(value * 100) / 100);
  return {
    measuredSteps: rows.filter((row) => row.reading.measured).length,
    notMeasuredSteps: rows.filter((row) => !row.reading.measured).length,
    peakCpuCores: round(peaks.cpuCores),
    peakRamGiB: round(peaks.ramGiB),
    diskGB: round(peaks.diskGB),
  };
}
