/**
 * Worker-owned capacity (T3O-86): a project's baseline, a card's size per dimension, the
 * profile the two make, and what the board was granted for a card. Imports only leaf
 * modules, so `board.ts` can import it without a cycle.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const BOARD_RESOURCE_DIMENSIONS = ["cpu", "ram", "disk"] as const;
export const BoardResourceDimension = Schema.Literals(BOARD_RESOURCE_DIMENSIONS);
export type BoardResourceDimension = typeof BoardResourceDimension.Type;

const NonNegativeNumber = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveNumber = Schema.Finite.check(Schema.isGreaterThan(0));

/** An amount of each resource: cores, GiB of RAM, GB of disk. */
export const BoardResourceProfile = Schema.Struct({
  cpuCores: NonNegativeNumber,
  ramGiB: NonNegativeNumber,
  diskGB: NonNegativeNumber,
});
export type BoardResourceProfile = typeof BoardResourceProfile.Type;

export const BOARD_RESOURCE_PROFILE_KEYS = {
  cpu: "cpuCores",
  ram: "ramGiB",
  disk: "diskGB",
} as const satisfies Record<BoardResourceDimension, keyof BoardResourceProfile>;

export const ZERO_BOARD_RESOURCE_PROFILE: BoardResourceProfile = {
  cpuCores: 0,
  ramGiB: 0,
  diskGB: 0,
};

/** What an undeclared project's cards reserve at size M. */
export const DEFAULT_BOARD_PROJECT_BASELINE: BoardResourceProfile = {
  cpuCores: 2,
  ramGiB: 4,
  diskGB: 5,
};

export const BOARD_CARD_SIZE_LETTERS = ["S", "M", "L", "XL"] as const;
export const BoardCardSizeLetter = Schema.Literals(BOARD_CARD_SIZE_LETTERS);
export type BoardCardSizeLetter = typeof BoardCardSizeLetter.Type;

export const BOARD_CARD_SIZE_MULTIPLIERS: Record<BoardCardSizeLetter, number> = {
  S: 0.75,
  M: 1,
  L: 1.25,
  XL: 1.5,
};

/** A size per dimension. */
export const BoardCardSize = Schema.Struct({
  cpu: BoardCardSizeLetter,
  ram: BoardCardSizeLetter,
  disk: BoardCardSizeLetter,
});
export type BoardCardSize = typeof BoardCardSize.Type;

export const DEFAULT_BOARD_CARD_SIZE: BoardCardSize = { cpu: "M", ram: "M", disk: "M" };

/** Who set a card's size: the planner's proposal, or an edit over it. An agent's edit is
    not a human override, so card detail never says "Edited by you" for it. */
export const BoardCardSizeEditor = Schema.Literals(["human", "agent"]);
export type BoardCardSizeEditor = typeof BoardCardSizeEditor.Type;

/** A card's size: the planner's suggestion and any edit, kept apart for Reset to planner. */
export const BoardCardSizing = Schema.Struct({
  planner: Schema.NullOr(
    Schema.Struct({ size: BoardCardSize, reason: Schema.NullOr(TrimmedNonEmptyString) }),
  ),
  edit: Schema.NullOr(Schema.Struct({ size: BoardCardSize, by: BoardCardSizeEditor })),
});
export type BoardCardSizing = typeof BoardCardSizing.Type;

export function boardCardEffectiveSize(sizing: BoardCardSizing | null | undefined): BoardCardSize {
  return sizing?.edit?.size ?? sizing?.planner?.size ?? DEFAULT_BOARD_CARD_SIZE;
}

/** Rounded to hundredths, so 0.75 x 6 reads 4.5, never 4.499999. */
const round2 = (value: number) => Math.round(value * 100) / 100;

/** The baseline scaled by the size, per dimension. */
export function boardResourceProfile(
  baseline: BoardResourceProfile,
  size: BoardCardSize,
): BoardResourceProfile {
  return {
    cpuCores: round2(baseline.cpuCores * BOARD_CARD_SIZE_MULTIPLIERS[size.cpu]),
    ramGiB: round2(baseline.ramGiB * BOARD_CARD_SIZE_MULTIPLIERS[size.ram]),
    diskGB: round2(baseline.diskGB * BOARD_CARD_SIZE_MULTIPLIERS[size.disk]),
  };
}

export function boardResourceProfileValue(
  profile: BoardResourceProfile,
  dimension: BoardResourceDimension,
): number {
  return profile[BOARD_RESOURCE_PROFILE_KEYS[dimension]];
}

/** Whether `inner` fits within `outer` on every dimension. */
export function boardResourceProfileFits(
  inner: BoardResourceProfile,
  outer: BoardResourceProfile,
): boolean {
  return BOARD_RESOURCE_DIMENSIONS.every(
    (dimension) =>
      boardResourceProfileValue(inner, dimension) <= boardResourceProfileValue(outer, dimension),
  );
}

/** The first dimension where `inner` exceeds `outer`, or null when it fits. */
export function boardResourceProfileOverflow(
  inner: BoardResourceProfile,
  outer: BoardResourceProfile,
): BoardResourceDimension | null {
  return (
    BOARD_RESOURCE_DIMENSIONS.find(
      (dimension) =>
        boardResourceProfileValue(inner, dimension) > boardResourceProfileValue(outer, dimension),
    ) ?? null
  );
}

/** The project's declared baseline: one M card's reservation. `setAtUpgrade` marks a
    baseline the one-time upgrade wrote, until a human edits it. */
export const BoardProjectBaseline = Schema.Struct({
  ...BoardResourceProfile.fields,
  setAtUpgrade: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type BoardProjectBaseline = typeof BoardProjectBaseline.Type;

export const DEFAULT_BOARD_SETUP_TIMEOUT_MINUTES = 30;
export const DEFAULT_BOARD_READINESS_SCRIPT_PATH = ".t3/ready.sh";
export const DEFAULT_BOARD_READINESS_TIMEOUT_SECONDS = 120;

/** A project's Resources settings. Every field null follows its default. */
export const BoardProjectResources = Schema.Struct({
  baseline: Schema.NullOr(BoardProjectBaseline).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  setupTimeoutMinutes: Schema.NullOr(PositiveNumber).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  readinessPath: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  readinessTimeoutSeconds: Schema.NullOr(PositiveNumber).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type BoardProjectResources = typeof BoardProjectResources.Type;

export const EMPTY_BOARD_PROJECT_RESOURCES: BoardProjectResources = {
  baseline: null,
  setupTimeoutMinutes: null,
  readinessPath: null,
  readinessTimeoutSeconds: null,
};

export function isEmptyBoardProjectResources(
  resources: BoardProjectResources | null | undefined,
): boolean {
  return (
    resources == null ||
    (resources.baseline === null &&
      resources.setupTimeoutMinutes === null &&
      resources.readinessPath === null &&
      resources.readinessTimeoutSeconds === null)
  );
}

export function resolveBoardProjectBaseline(
  resources: BoardProjectResources | null | undefined,
): BoardResourceProfile {
  const baseline = resources?.baseline;
  return baseline == null
    ? DEFAULT_BOARD_PROJECT_BASELINE
    : { cpuCores: baseline.cpuCores, ramGiB: baseline.ramGiB, diskGB: baseline.diskGB };
}

/**
 * A readiness path is relative and stays inside the repository: no absolute path, no `..`
 * segment, no backslash. Null when it is unusable.
 */
export function normalizeBoardReadinessPath(path: string): string | null {
  const trimmed = path.trim();
  if (trimmed === "" || trimmed.startsWith("/") || trimmed.includes("\\")) return null;
  if (/^[A-Za-z]:/.test(trimmed)) return null;
  const segments = trimmed.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) return null;
  return segments.join("/");
}

export function resolveBoardProjectResourceSettings(
  resources: BoardProjectResources | null | undefined,
) {
  return {
    baseline: resolveBoardProjectBaseline(resources),
    setupTimeoutMinutes: resources?.setupTimeoutMinutes ?? DEFAULT_BOARD_SETUP_TIMEOUT_MINUTES,
    readinessPath: resources?.readinessPath ?? DEFAULT_BOARD_READINESS_SCRIPT_PATH,
    readinessTimeoutSeconds:
      resources?.readinessTimeoutSeconds ?? DEFAULT_BOARD_READINESS_TIMEOUT_SECONDS,
  };
}

/**
 * What the board was granted for a card on its worker. `profile` is the reservation the card
 * runs at; `heavy` is whether its CPU and RAM are held. `claimId` names the placement claim the
 * card's provision consumes, so a restarted board resumes with it.
 */
export const BoardCardGrant = Schema.Struct({
  profile: BoardResourceProfile,
  heavy: Schema.Boolean,
  claimId: Schema.NullOr(TrimmedNonEmptyString),
  grantedAt: IsoDateTime,
  /** The card's first heavy step ended, or two hours passed: its disk is no longer pending. */
  settled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** When the card last stopped being active, for the ten-minute tail; null while active. */
  idleSince: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type BoardCardGrant = typeof BoardCardGrant.Type;

/** The four fixed card setup stages (section 5). */
export const BOARD_CARD_SETUP_STAGES = ["fetch", "checkout", "submodules", "setup-script"] as const;
export const BoardCardSetupStage = Schema.Literals(BOARD_CARD_SETUP_STAGES);
export type BoardCardSetupStage = typeof BoardCardSetupStage.Type;

/** A card's last setup run, as the board persisted it. */
export const BoardCardSetupResult = Schema.Struct({
  status: Schema.Literals(["running", "succeeded", "failed", "cancelled"]),
  /** The last stage reached: the running one, the failed one, or the last on success. */
  stage: BoardCardSetupStage,
  exitCode: Schema.NullOr(Schema.Int),
  startedAt: IsoDateTime,
  durationMs: Schema.NullOr(Schema.Finite),
  workerId: TrimmedNonEmptyString,
  detail: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type BoardCardSetupResult = typeof BoardCardSetupResult.Type;

/** A card's capacity state, in one column: its size, its grant, and its setup. */
export const BoardCardResources = Schema.Struct({
  sizing: Schema.NullOr(BoardCardSizing).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  grant: Schema.NullOr(BoardCardGrant).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  setup: Schema.NullOr(BoardCardSetupResult).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type BoardCardResources = typeof BoardCardResources.Type;

export const EMPTY_BOARD_CARD_RESOURCES: BoardCardResources = {
  sizing: null,
  grant: null,
  setup: null,
};

/** The card's reservation as it would be placed now. */
export function boardCardRequestedProfile(
  resources: BoardCardResources | null | undefined,
  projectResources: BoardProjectResources | null | undefined,
): BoardResourceProfile {
  return boardResourceProfile(
    resolveBoardProjectBaseline(projectResources),
    boardCardEffectiveSize(resources?.sizing),
  );
}

const withSizing = (
  resources: BoardCardResources | null | undefined,
  sizing: BoardCardSizing,
): BoardCardResources | null => {
  const next = { ...(resources ?? EMPTY_BOARD_CARD_RESOURCES), sizing };
  return next.sizing.planner === null &&
    next.sizing.edit === null &&
    next.grant === null &&
    next.setup === null
    ? null
    : next;
};

/** A card's resources with its size edit set, or dropped back to the planner's. */
export function withBoardCardSizeEdit(
  resources: BoardCardResources | null | undefined,
  edit: BoardCardSizing["edit"],
): BoardCardResources | null {
  return withSizing(resources, { planner: resources?.sizing?.planner ?? null, edit });
}

/** A card's resources with the planner's suggestion recorded; any edit stands. */
export function withBoardCardPlannerSize(
  resources: BoardCardResources | null | undefined,
  planner: BoardCardSizing["planner"],
): BoardCardResources | null {
  return withSizing(resources, { planner, edit: resources?.sizing?.edit ?? null });
}
