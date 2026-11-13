/**
 * T3o: what a project's Resources tab says about each worker (T3O-86): the project's
 * readiness there, and whether the project's cards fit the workers ready for it.
 */
import {
  BOARD_CARD_SIZE_LETTERS,
  BOARD_CARD_SIZE_MULTIPLIERS,
  BOARD_RESOURCE_DIMENSIONS,
  BOARD_RESOURCE_PROFILE_KEYS,
  boardResourceProfileValue,
  normalizeBoardReadinessPath,
  type BoardProjectResources,
  type BoardResourceProfile,
  type BoardWorkerCapacitySnapshot,
  type BoardWorkerId,
  type BoardWorkerReadinessState,
} from "@t3tools/contracts";

const UNITS = { cpu: "cores", ram: "GiB", disk: "GB" } as const;
const NAMES = { cpu: "CPU", ram: "RAM", disk: "Disk" } as const;

export interface BoardProjectWorkerRow {
  readonly workerId: BoardWorkerId;
  readonly label: string;
  /** Null when the worker hasn't reported this project yet. */
  readonly state: BoardWorkerReadinessState | null;
  /** "Exit 1 · missing docker", "No readiness script: a checkout counts as ready". */
  readonly detail: string | null;
  readonly declared: BoardResourceProfile;
}

/** One row per worker that has reported capacity, in the order given. */
export function boardProjectWorkerRows(input: {
  readonly workers: ReadonlyArray<{ readonly workerId: BoardWorkerId; readonly label: string }>;
  readonly snapshots: ReadonlyMap<string, BoardWorkerCapacitySnapshot>;
  readonly repositoryKey: string | null;
  readonly readinessPath: string;
}): ReadonlyArray<BoardProjectWorkerRow> {
  return input.workers.flatMap(({ workerId, label }) => {
    const snapshot = input.snapshots.get(workerId);
    if (snapshot === undefined) return [];
    const readiness =
      snapshot.readiness.find(
        (entry) =>
          entry.repositoryKey === input.repositoryKey && entry.path === input.readinessPath,
      ) ?? null;
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
        declared: snapshot.declared,
      },
    ];
  });
}

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * The Resources tab's "hard to place" warnings, per dimension, against the workers ready for
 * the project: no card fits, some sizes don't fit, or only one worker fits an M card. A board
 * with one ready worker always has "only one", so that warning needs another worker to compare.
 */
export function boardProjectHardToPlace(
  baseline: BoardResourceProfile,
  rows: ReadonlyArray<Pick<BoardProjectWorkerRow, "label" | "state" | "declared">>,
): ReadonlyArray<string> {
  const ready = rows.filter((row) => row.state === "ready");
  if (ready.length === 0) return [];
  return BOARD_RESOURCE_DIMENSIONS.flatMap((dimension) => {
    const name = NAMES[dimension];
    const unit = UNITS[dimension];
    const need = boardResourceProfileValue(baseline, dimension);
    const largest = Math.max(
      ...ready.map((row) => boardResourceProfileValue(row.declared, dimension)),
    );
    if (need > largest) {
      return [
        `${name}: an M card needs ${round(need)} ${unit}; the largest ready worker declares ${round(largest)}. No card can be placed.`,
      ];
    }
    const tooBig = BOARD_CARD_SIZE_LETTERS.filter(
      (letter) => need * BOARD_CARD_SIZE_MULTIPLIERS[letter] > largest,
    );
    if (tooBig.length > 0) {
      return [
        `${name}: ${tooBig.join(" and ")} cards can't be placed; the largest ready worker declares ${round(largest)} ${unit}.`,
      ];
    }
    const fitting = ready.filter(
      (row) => boardResourceProfileValue(row.declared, dimension) >= need,
    );
    if (ready.length > 1 && fitting.length === 1) {
      return [
        `${name}: only ${fitting[0]!.label} fits an M card, so cards will queue behind each other.`,
      ];
    }
    return [];
  });
}

/** A project's cards that hold a worktree keep the reservation they were granted. */
export function boardBaselineSaveNotice(
  placedCards: number,
  previous: BoardResourceProfile,
  next: BoardResourceProfile,
): string | null {
  if (placedCards === 0) return null;
  const changed = BOARD_RESOURCE_DIMENSIONS.some(
    (dimension) =>
      boardResourceProfileValue(previous, dimension) !== boardResourceProfileValue(next, dimension),
  );
  if (!changed) return null;
  return `${placedCards} placed ${placedCards === 1 ? "card keeps its" : "cards keep their"} current reservation.`;
}

/** Copied from the Resources tab when the project has no readiness script yet. */
export const BOARD_READINESS_STARTER_SCRIPT = `#!/usr/bin/env sh
# Readiness check: exits 0 when this machine can run this project's cards.
# Check the machine (tools, services, credentials), not files in the repository:
# the checkout may be at an older commit than this script.
# The checkout's path is in T3O_READY_CHECKOUT.
set -eu

command -v git >/dev/null || { echo "git is not installed"; exit 1; }
command -v node >/dev/null || { echo "node is not installed"; exit 1; }
# command -v docker >/dev/null || { echo "docker is not installed"; exit 1; }

echo "ready"
`;

/** A baseline field's input parsed: a positive number, or null when it isn't one. */
export function parseBoardBaselineField(raw: string): number | null {
  const value = Number(raw.trim());
  return raw.trim() !== "" && Number.isFinite(value) && value > 0 ? value : null;
}

export const BOARD_BASELINE_FIELDS = BOARD_RESOURCE_DIMENSIONS.map((dimension) => ({
  dimension,
  key: BOARD_RESOURCE_PROFILE_KEYS[dimension],
  label: NAMES[dimension],
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
