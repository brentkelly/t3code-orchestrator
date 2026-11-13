/**
 * T3o: what a project's Resources tab says about each worker (T3O-86): the project's
 * readiness there, and whether one M card of the project fits it at all.
 */
import {
  BOARD_RESOURCE_DIMENSIONS,
  BOARD_RESOURCE_PROFILE_KEYS,
  boardResourceProfileOverflow,
  boardResourceProfileValue,
  normalizeBoardReadinessPath,
  type BoardProjectResources,
  type BoardResourceProfile,
  type BoardWorkerCapacitySnapshot,
  type BoardWorkerId,
  type BoardWorkerReadinessState,
} from "@t3tools/contracts";

const UNITS = { cpu: "cores", ram: "GiB", disk: "GB" } as const;
const NAMES = { cpu: "CPU", ram: "RAM", disk: "disk" } as const;

export interface BoardProjectWorkerRow {
  readonly workerId: BoardWorkerId;
  readonly label: string;
  /** Null when the worker hasn't reported this project yet. */
  readonly state: BoardWorkerReadinessState | null;
  /** "Exit 1 · missing docker", "No readiness script: a checkout counts as ready". */
  readonly detail: string | null;
  /** Amber: an M card of this project is bigger than the worker. */
  readonly hardToPlace: string | null;
}

/** One row per worker that has reported capacity, in the order given. */
export function boardProjectWorkerRows(input: {
  readonly workers: ReadonlyArray<{ readonly workerId: BoardWorkerId; readonly label: string }>;
  readonly snapshots: ReadonlyMap<string, BoardWorkerCapacitySnapshot>;
  readonly repositoryKey: string | null;
  readonly readinessPath: string;
  readonly baseline: BoardResourceProfile;
}): ReadonlyArray<BoardProjectWorkerRow> {
  return input.workers.flatMap(({ workerId, label }) => {
    const snapshot = input.snapshots.get(workerId);
    if (snapshot === undefined) return [];
    const readiness =
      snapshot.readiness.find(
        (entry) =>
          entry.repositoryKey === input.repositoryKey && entry.path === input.readinessPath,
      ) ?? null;
    const overflow = boardResourceProfileOverflow(input.baseline, snapshot.declared);
    return [
      {
        workerId,
        label,
        state: readiness?.state ?? null,
        detail:
          readiness === null
            ? null
            : readiness.noScript === true
              ? "No readiness script: a checkout counts as ready"
              : readiness.state === "not-ready"
                ? [
                    readiness.exitCode == null ? null : `Exit ${readiness.exitCode}`,
                    readiness.lastLine || null,
                  ]
                    .filter((part) => part !== null)
                    .join(" · ") || null
                : null,
        hardToPlace:
          overflow === null
            ? null
            : `An M card needs ${round(boardResourceProfileValue(input.baseline, overflow))} ${
                UNITS[overflow]
              } of ${NAMES[overflow]}; ${label} declares ${round(
                boardResourceProfileValue(snapshot.declared, overflow),
              )}.`,
      },
    ];
  });
}

const round = (value: number) => Math.round(value * 10) / 10;

/** A baseline field's input parsed: a positive number, or null when it isn't one. */
export function parseBoardBaselineField(raw: string): number | null {
  const value = Number(raw.trim());
  return raw.trim() !== "" && Number.isFinite(value) && value > 0 ? value : null;
}

export const BOARD_BASELINE_FIELDS = BOARD_RESOURCE_DIMENSIONS.map((dimension) => ({
  dimension,
  key: BOARD_RESOURCE_PROFILE_KEYS[dimension],
  label: ({ cpu: "CPU", ram: "RAM", disk: "Disk" } as const)[dimension],
  unit: UNITS[dimension],
}));

/** The form's text, one string per field; blank leaves the setting undeclared. */
export type BoardResourcesDraft = Readonly<Record<string, string>>;

const declared = (value: number | null | undefined) => (value == null ? "" : String(value));

/** The form as the settings declare it: an undeclared setting is blank, its default a placeholder. */
export function boardResourcesDraftOf(
  resources: BoardProjectResources | null,
): BoardResourcesDraft {
  return {
    cpuCores: declared(resources?.baseline?.cpuCores),
    ramGiB: declared(resources?.baseline?.ramGiB),
    diskGB: declared(resources?.baseline?.diskGB),
    setupTimeoutMinutes: declared(resources?.setupTimeoutMinutes),
    readinessPath: resources?.readinessPath ?? "",
    readinessTimeoutSeconds: declared(resources?.readinessTimeoutSeconds),
  };
}

/**
 * The draft as settings, or the first field that doesn't parse. Blank stays undeclared, so
 * saving one field declares nothing else; an unchanged baseline keeps its set-at-upgrade mark.
 */
export function boardResourcesOf(
  draft: BoardResourcesDraft,
  previous: BoardProjectResources | null,
): { readonly ok: BoardProjectResources } | { readonly error: string } {
  const raw = BOARD_BASELINE_FIELDS.map((field) => (draft[field.key] ?? "").trim());
  let baseline: BoardProjectResources["baseline"] = null;
  if (raw.some((value) => value !== "")) {
    const values: Record<string, number> = {};
    for (const field of BOARD_BASELINE_FIELDS) {
      const value = parseBoardBaselineField(draft[field.key] ?? "");
      if (value === null) {
        return {
          error: `${field.label} must be a positive number, or clear all three for the default.`,
        };
      }
      values[field.key] = value;
    }
    const before = previous?.baseline ?? null;
    baseline = {
      cpuCores: values.cpuCores!,
      ramGiB: values.ramGiB!,
      diskGB: values.diskGB!,
      setAtUpgrade:
        before !== null &&
        before.setAtUpgrade &&
        before.cpuCores === values.cpuCores &&
        before.ramGiB === values.ramGiB &&
        before.diskGB === values.diskGB,
    };
  }
  const optional = (key: string) => {
    const text = (draft[key] ?? "").trim();
    return text === "" ? { value: null } : { value: parseBoardBaselineField(text) };
  };
  const setupTimeout = optional("setupTimeoutMinutes");
  if (setupTimeout.value === null && (draft.setupTimeoutMinutes ?? "").trim() !== "") {
    return { error: "The setup timeout must be positive." };
  }
  const readinessTimeout = optional("readinessTimeoutSeconds");
  if (readinessTimeout.value === null && (draft.readinessTimeoutSeconds ?? "").trim() !== "") {
    return { error: "The readiness timeout must be positive." };
  }
  const rawPath = (draft.readinessPath ?? "").trim();
  const readinessPath = rawPath === "" ? null : normalizeBoardReadinessPath(rawPath);
  if (rawPath !== "" && readinessPath === null) {
    return { error: "The readiness script must be a path inside the repository." };
  }
  return {
    ok: {
      baseline,
      setupTimeoutMinutes: setupTimeout.value,
      readinessPath,
      readinessTimeoutSeconds: readinessTimeout.value,
    },
  };
}
