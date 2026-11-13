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

const DEFAULT_BOARD_CARD_SIZE: BoardCardSize = { cpu: "M", ram: "M", disk: "M" };

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

const DEFAULT_BOARD_SETUP_TIMEOUT_MINUTES = 30;
export const DEFAULT_BOARD_READINESS_SCRIPT_PATH = ".t3/ready.sh";
const DEFAULT_BOARD_READINESS_TIMEOUT_SECONDS = 120;

// ── Learned baselines (T3O-87) ─────────────────────────────────────────

/** A learned baseline needs this many card samples. */
export const BOARD_LEARNED_MIN_SAMPLES = 5;
/** Card samples older than this are not learned from. */
export const BOARD_LEARNED_WINDOW_DAYS = 30;

/** One dimension of a learned baseline, per M card. */
export const BoardLearnedDimension = Schema.Struct({
  /** The 90th percentile of the card samples, rounded up; null under the minimum. */
  value: Schema.NullOr(NonNegativeNumber),
  samples: Schema.Int,
  /** The card samples, oldest first, for the sparkline. */
  history: Schema.Array(NonNegativeNumber),
  /** An increase that no ready worker could place at size M: shown, never applied. */
  unplaceable: Schema.optionalKey(Schema.Boolean),
});
export type BoardLearnedDimension = typeof BoardLearnedDimension.Type;

/** What the board learned of a project's cards: written by the board, never by a human. */
export const BoardProjectLearned = Schema.Struct({
  computedAt: IsoDateTime,
  cpu: BoardLearnedDimension,
  ram: BoardLearnedDimension,
  disk: BoardLearnedDimension,
});
export type BoardProjectLearned = typeof BoardProjectLearned.Type;

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
  /** T3o (T3O-87): dimensions whose declared value ignores learning. Absent pins none. */
  pinDeclared: Schema.optionalKey(Schema.Array(BoardResourceDimension)),
  /** T3o (T3O-87): the learned baseline, the board's to write. Not in the config's version. */
  learned: Schema.optionalKey(BoardProjectLearned),
});
export type BoardProjectResources = typeof BoardProjectResources.Type;

/** The resources without what the board learned: what a version hashes and a file compares. */
export function boardProjectResourcesWithoutLearned(
  resources: BoardProjectResources,
): BoardProjectResources {
  const { learned: _learned, ...rest } = resources;
  return rest;
}

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
      resources.readinessTimeoutSeconds === null &&
      (resources.pinDeclared ?? []).length === 0 &&
      resources.learned === undefined)
  );
}

/** The declared baseline, ignoring learning. */
export function resolveBoardProjectDeclared(
  resources: BoardProjectResources | null | undefined,
): BoardResourceProfile {
  const baseline = resources?.baseline;
  return baseline == null
    ? DEFAULT_BOARD_PROJECT_BASELINE
    : { cpuCores: baseline.cpuCores, ramGiB: baseline.ramGiB, diskGB: baseline.diskGB };
}

/** Where a declared value came from: a human, the 2/4/5 placeholder, or the upgrade. */
export type BoardDeclaredSource = "declared" | "placeholder" | "upgrade";

function boardDeclaredSource(
  resources: BoardProjectResources | null | undefined,
): BoardDeclaredSource {
  const baseline = resources?.baseline;
  if (baseline == null) return "placeholder";
  return baseline.setAtUpgrade ? "upgrade" : "declared";
}

/** A learned value as it may apply: clamped to 0.5x–2x only against a human's declared value,
    so a placeholder or upgrade value learns past 2x. */
function boardLearnedCandidate(
  declared: number,
  source: BoardDeclaredSource,
  learned: number,
): number {
  if (source !== "declared") return learned;
  return Math.min(Math.max(learned, declared * 0.5), declared * 2);
}

/** The value in force for new placements in one dimension ("Planner uses"), and what learning
    offers beside it. */
export interface BoardPlannerUse {
  readonly value: number;
  readonly source: "learned" | BoardDeclaredSource;
  readonly declared: number;
  readonly declaredSource: BoardDeclaredSource;
  readonly pinned: boolean;
  /** A learned decrease, offered with Use learned; never applied by itself. */
  readonly offeredDecrease: number | null;
  /** A learned increase held back: no ready worker could place an M card with it. */
  readonly heldIncrease: number | null;
}

export function boardPlannerUse(
  resources: BoardProjectResources | null | undefined,
  dimension: BoardResourceDimension,
): BoardPlannerUse {
  const declared = boardResourceProfileValue(resolveBoardProjectDeclared(resources), dimension);
  const declaredSource = boardDeclaredSource(resources);
  const pinned = (resources?.pinDeclared ?? []).includes(dimension);
  const base: BoardPlannerUse = {
    value: declared,
    source: declaredSource,
    declared,
    declaredSource,
    pinned,
    offeredDecrease: null,
    heldIncrease: null,
  };
  const learned = resources?.learned?.[dimension] ?? null;
  if (pinned || learned === null || learned.value === null) return base;
  const candidate = boardLearnedCandidate(declared, declaredSource, learned.value);
  if (candidate < declared) return { ...base, offeredDecrease: candidate };
  if (candidate === declared) return base;
  if (learned.unplaceable === true) return { ...base, heldIncrease: candidate };
  return { ...base, value: candidate, source: "learned" };
}

/** The baseline new placements use: per dimension a learned increase, or the declared value. */
export function resolveBoardProjectBaseline(
  resources: BoardProjectResources | null | undefined,
): BoardResourceProfile {
  return {
    cpuCores: boardPlannerUse(resources, "cpu").value,
    ramGiB: boardPlannerUse(resources, "ram").value,
    diskGB: boardPlannerUse(resources, "disk").value,
  };
}

/** The baseline Use learned writes: `value` in `dimension`, and in the others the value the
    planner already uses there, so they don't move once they count as a human's. */
export function boardBaselineWithLearned(
  resources: BoardProjectResources | null | undefined,
  dimension: BoardResourceDimension,
  value: number,
): BoardProjectBaseline {
  return {
    ...resolveBoardProjectBaseline(resources),
    [BOARD_RESOURCE_PROFILE_KEYS[dimension]]: value,
    setAtUpgrade: false,
  };
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
  /** The setup holds the agent until it exits. */
  blocking: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type BoardCardSetupResult = typeof BoardCardSetupResult.Type;

/** T3o: when and why the placement gate chose the card's worker (T3O-87). */
export const BoardCardPlacementRecord = Schema.Struct({
  workerId: TrimmedNonEmptyString,
  at: IsoDateTime,
  reason: Schema.NullOr(TrimmedNonEmptyString),
});
export type BoardCardPlacementRecord = typeof BoardCardPlacementRecord.Type;

/** A card's capacity state, in one column: its size, its grant, and its setup. */
export const BoardCardResources = Schema.Struct({
  sizing: Schema.NullOr(BoardCardSizing).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  grant: Schema.NullOr(BoardCardGrant).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  setup: Schema.NullOr(BoardCardSetupResult).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** A worktree was cut or moved since the last setup: it runs setup, even on a built card. */
  setupDue: Schema.optional(Schema.Boolean),
  /** T3o: the placement on record (T3O-87); absent until the gate places the card. */
  placement: Schema.optional(Schema.NullOr(BoardCardPlacementRecord)),
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
    next.setup === null &&
    next.setupDue !== true &&
    (next.placement ?? null) === null
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

// ── Worker capacity on the wire (T3O-86) ──────────────────────────────

/** The card phase the board last granted: heavy holds CPU and RAM, light only disk. */
export const BoardCardPhase = Schema.Literals(["heavy", "light"]);
export type BoardCardPhase = typeof BoardCardPhase.Type;

/** Why a placement can't go ahead on a worker. Open to extension: a peer reads an unknown
    reason as a plain denial. */
const BOARD_CLAIM_DENIAL_REASONS = ["capacity", "quota", "not-ready"] as const;
export type BoardClaimDenialReason = (typeof BOARD_CLAIM_DENIAL_REASONS)[number];

export const BoardCapacityClaimInput = Schema.Struct({
  claimId: TrimmedNonEmptyString,
  seq: Schema.Int,
  cardId: TrimmedNonEmptyString,
  repositoryKey: Schema.NullOr(TrimmedNonEmptyString),
  /** The worker's project, for a repository with no remote (its readiness is its own). */
  projectId: Schema.optionalKey(TrimmedNonEmptyString),
  kind: Schema.Literals(["placement", "grow"]),
  profile: BoardResourceProfile,
  providerInstanceId: Schema.NullOr(TrimmedNonEmptyString),
  force: Schema.optionalKey(Schema.Boolean),
  /** T3o: the card holds this worker: start early at its early-start share (T3O-87). */
  hold: Schema.optionalKey(Schema.Boolean),
  /**
   * T3o: a later card of this board holding the worker gives way (T3O-87): its placement hold
   * passes to this card only if this request succeeds, so a refusal leaves it in place.
   */
  replacesCardId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type BoardCapacityClaimInput = typeof BoardCapacityClaimInput.Type;

/** T3o: ask for, or refresh, a hold on a worker for a waiting card (T3O-87). Idempotent. */
export const BoardCapacityHoldInput = Schema.Struct({
  cardId: TrimmedNonEmptyString,
  repositoryKey: Schema.NullOr(TrimmedNonEmptyString),
  projectId: Schema.optionalKey(TrimmedNonEmptyString),
  providerInstanceId: Schema.NullOr(TrimmedNonEmptyString),
  profile: BoardResourceProfile,
  kind: Schema.Literals(["placement", "grow"]),
  /**
   * T3o: a later card of this board holding the worker gives way (T3O-87): its placement hold
   * passes to this card only if this request succeeds, so a refusal leaves it in place.
   */
  replacesCardId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type BoardCapacityHoldInput = typeof BoardCapacityHoldInput.Type;

export const BoardCapacityHoldResult = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("held"),
    /** What the card is still short of in each dimension now. */
    short: BoardResourceProfile,
    /** When the hold ends at the latest: only once someone else is waiting. */
    until: Schema.NullOr(IsoDateTime),
  }),
  Schema.Struct({
    outcome: Schema.Literal("refused"),
    /** held, disk, too-big, not-eligible, cool-off or turn; an unknown one reads as refused. */
    reason: TrimmedNonEmptyString,
    until: Schema.NullOr(IsoDateTime),
  }),
]);
export type BoardCapacityHoldResult = typeof BoardCapacityHoldResult.Type;

/** T3o: what a board sees of the holds on a worker (T3O-87). Never another board's card. */
export const BoardWorkerHoldView = Schema.Struct({
  /** Not taking new placements: held for a card, or a grow hold is waiting. */
  closed: Schema.Boolean,
  /** Until when, once someone is waiting. */
  until: Schema.NullOr(IsoDateTime),
  earlyStartFraction: Schema.Finite,
  /** This board's card the worker is held for, when the hold is this board's. */
  cardId: Schema.NullOr(TrimmedNonEmptyString),
});
export type BoardWorkerHoldView = typeof BoardWorkerHoldView.Type;

export const BoardCapacityClaimResult = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("granted") }),
  Schema.Struct({
    outcome: Schema.Literal("denied"),
    /** `BoardClaimDenialReason`, or one a newer worker added. */
    reason: TrimmedNonEmptyString,
    dimension: Schema.optionalKey(BoardResourceDimension),
    providerInstanceId: Schema.optionalKey(TrimmedNonEmptyString),
    resetsAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
    detail: Schema.optionalKey(Schema.String),
  }),
]);
export type BoardCapacityClaimResult = typeof BoardCapacityClaimResult.Type;

/** The placement a provision consumes, so a worker that lost the claim checks it again. */
export const BoardProvisionClaim = Schema.Struct({
  claimId: TrimmedNonEmptyString,
  seq: Schema.Int,
  cardId: TrimmedNonEmptyString,
  repositoryKey: Schema.NullOr(TrimmedNonEmptyString),
  profile: BoardResourceProfile,
  providerInstanceId: Schema.NullOr(TrimmedNonEmptyString),
  force: Schema.optionalKey(Schema.Boolean),
  /** As on the claim, so a lapsed claim is checked again as it was granted. */
  projectId: Schema.optionalKey(TrimmedNonEmptyString),
  hold: Schema.optionalKey(Schema.Boolean),
});
export type BoardProvisionClaim = typeof BoardProvisionClaim.Type;

/** One card the board holds a worktree for on the worker. */
export const BoardSyncedCard = Schema.Struct({
  cardId: TrimmedNonEmptyString,
  repositoryKey: Schema.NullOr(TrimmedNonEmptyString),
  branch: TrimmedNonEmptyString,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  grantedProfile: BoardResourceProfile,
  phase: BoardCardPhase,
  settled: Schema.Boolean,
  /** The card finished a Building step: its worktree counts as set up. */
  builtOnce: Schema.optionalKey(Schema.Boolean),
});
export type BoardSyncedCard = typeof BoardSyncedCard.Type;

export const BoardSyncCardsInput = Schema.Struct({
  seq: Schema.Int,
  /** The first sync on a new connection: it resets the worker's `lastSeq` for this board. */
  authoritative: Schema.Boolean,
  cards: Schema.Array(BoardSyncedCard),
});
export type BoardSyncCardsInput = typeof BoardSyncCardsInput.Type;

export const BoardSyncCardsResult = Schema.Struct({
  lastSeq: Schema.Int,
  /** Entries the worker could not adopt: no worktree there with this board's marker. */
  refused: Schema.Array(TrimmedNonEmptyString),
});
export type BoardSyncCardsResult = typeof BoardSyncCardsResult.Type;

/** A project's readiness on a worker (section 5), one per repository and script path. */
export const BoardWorkerReadinessState = Schema.Literals([
  "not-set-up",
  "cloning",
  "checking",
  "not-ready",
  "ready",
]);
export type BoardWorkerReadinessState = typeof BoardWorkerReadinessState.Type;

export const BoardWorkerReadiness = Schema.Struct({
  repositoryKey: Schema.NullOr(TrimmedNonEmptyString),
  /** The worker's project, for a repository with no remote: each such project is its own. */
  projectId: Schema.optionalKey(TrimmedNonEmptyString),
  path: TrimmedNonEmptyString,
  state: BoardWorkerReadinessState,
  /** The script's blob id the last result ran, or null with no script or no result. */
  version: Schema.NullOr(TrimmedNonEmptyString),
  /** The script on the default branch now, when newer than `version`. */
  pendingVersion: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  checkedAt: Schema.NullOr(IsoDateTime),
  exitCode: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  lastLine: Schema.optionalKey(Schema.NullOr(Schema.String)),
  durationMs: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  /** The last fetch failed: the result stands, checked with the version named. */
  fetchFailed: Schema.optionalKey(Schema.Boolean),
  /** The repository has no readiness script at the path. */
  noScript: Schema.optionalKey(Schema.Boolean),
  cloneProgress: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
});
export type BoardWorkerReadiness = typeof BoardWorkerReadiness.Type;

/** Whether a readiness entry is this project's. With no remote each project is its own; an
    entry from a worker that names no project still matches. */
export function boardReadinessIsFor(
  entry: { readonly repositoryKey: string | null; readonly projectId?: string },
  repositoryKey: string | null,
  projectId: string,
): boolean {
  if (entry.repositoryKey !== repositoryKey) return false;
  return repositoryKey !== null || entry.projectId === undefined || entry.projectId === projectId;
}

export const BoardWorkerProviderCapacity = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  driver: TrimmedNonEmptyString,
  account: Schema.Struct({
    status: Schema.Literals(["signed-in", "signed-out", "unknown"]),
    email: Schema.optionalKey(TrimmedNonEmptyString),
    plan: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  quota: Schema.Struct({
    exhausted: Schema.Boolean,
    checkedAt: Schema.NullOr(IsoDateTime),
    /** When the gating window that is exhausted resets. */
    resetsAt: Schema.NullOr(IsoDateTime),
    windows: Schema.Array(
      Schema.Struct({
        label: TrimmedNonEmptyString,
        usedPercent: Schema.Finite,
        resetsAt: Schema.NullOr(IsoDateTime),
        gating: Schema.Boolean,
        /** At or above the worker's quota threshold, and so refusing placements. */
        nearLimit: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  }),
  agents: Schema.Struct({ running: Schema.Int, max: Schema.NullOr(Schema.Int) }),
});
export type BoardWorkerProviderCapacity = typeof BoardWorkerProviderCapacity.Type;

/** What a worker offers one board. Nothing in it is about any other board. */
export const BoardWorkerCapacitySnapshot = Schema.Struct({
  at: IsoDateTime,
  declared: BoardResourceProfile,
  headroom: BoardResourceProfile,
  /** Over declared CPU or RAM: nothing is offered. Over disk only: placements are refused. */
  over: Schema.Struct({ cpuRam: Schema.Boolean, disk: Schema.Boolean }),
  agents: Schema.Struct({ running: Schema.Int, max: Schema.NullOr(Schema.Int) }),
  providers: Schema.Array(BoardWorkerProviderCapacity),
  readiness: Schema.Array(BoardWorkerReadiness),
  /** This board's cards the worker counts heavy because a turn is running there. */
  heavyCards: Schema.Array(TrimmedNonEmptyString),
  /** T3o: the worker's holds as this board sees them (T3O-87). Absent from an older worker. */
  hold: Schema.optionalKey(BoardWorkerHoldView),
});
export type BoardWorkerCapacitySnapshot = typeof BoardWorkerCapacitySnapshot.Type;

// ── Card setup and readiness on the wire (T3O-86, section 5) ───────────

/** The last lines of setup output a card's detail shows. */
export const BOARD_CARD_SETUP_TAIL_LINES = 6;
/** The most of a setup or readiness log kept and read back. */
export const BOARD_CAPACITY_LOG_MAX_BYTES = 64 * 1024;

/** A card's setup as it runs: four fixed stages, then a result. */
export const BoardCardSetupProgress = Schema.Struct({
  status: Schema.Literals(["running", "succeeded", "failed", "cancelled"]),
  stage: BoardCardSetupStage,
  stages: Schema.Array(
    Schema.Struct({
      stage: BoardCardSetupStage,
      status: Schema.Literals(["done", "running", "pending", "failed", "skipped"]),
      durationMs: Schema.NullOr(Schema.Finite),
    }),
  ),
  exitCode: Schema.NullOr(Schema.Int),
  startedAt: IsoDateTime,
  durationMs: Schema.NullOr(Schema.Finite),
  tail: Schema.String,
  /** The project's setup script holds the agent until it exits (upstream's `async: false`). */
  blocking: Schema.Boolean,
  detail: Schema.NullOr(Schema.String),
});
export type BoardCardSetupProgress = typeof BoardCardSetupProgress.Type;

export const BoardWorkerRunSetupInput = Schema.Struct({
  cardId: TrimmedNonEmptyString,
  /** The WORKER's project id. */
  projectId: TrimmedNonEmptyString,
  worktreePath: TrimmedNonEmptyString,
  timeoutMinutes: Schema.Finite,
  /** Re-run only the setup script on a worktree that exists. */
  retry: Schema.optionalKey(Schema.Boolean),
  /** Mark it set up without running anything: its card already built (the upgrade). */
  markOnly: Schema.optionalKey(Schema.Boolean),
});
export type BoardWorkerRunSetupInput = typeof BoardWorkerRunSetupInput.Type;

export const BoardWorkerSetupState = Schema.Literals(["running", "done", "failed", "none"]);
export type BoardWorkerSetupState = typeof BoardWorkerSetupState.Type;

export const BoardWorkerCheckReadinessInput = Schema.Struct({
  repositoryKey: Schema.NullOr(TrimmedNonEmptyString),
  /** The WORKER's project, for a repository with no remote (no key to find it by). */
  projectId: Schema.optionalKey(TrimmedNonEmptyString),
  path: TrimmedNonEmptyString,
  timeoutSeconds: Schema.Finite,
  /** A human asked (Re-check): a failure counts at once, and a fresh result is wanted. */
  requested: Schema.optionalKey(Schema.Boolean),
});
export type BoardWorkerCheckReadinessInput = typeof BoardWorkerCheckReadinessInput.Type;

/** What a card's capacity reads as, for an agent's card read (T3O-86). */
export const BoardCardCapacityView = Schema.Struct({
  /** The size the card would be placed at now. */
  size: BoardCardSize,
  planner: Schema.NullOr(
    Schema.Struct({ size: BoardCardSize, reason: Schema.NullOr(TrimmedNonEmptyString) }),
  ),
  /** An edit over the planner's size, and whose. */
  edit: Schema.NullOr(Schema.Struct({ size: BoardCardSize, by: BoardCardSizeEditor })),
  /** What placing it now would reserve: the project's baseline times its size. */
  reservation: BoardResourceProfile,
  /** What its worker granted it, while it holds a worktree; null otherwise. */
  granted: Schema.NullOr(Schema.Struct({ profile: BoardResourceProfile, heavy: Schema.Boolean })),
  /** The worker it runs on, or will. */
  workerId: TrimmedNonEmptyString,
  /** T3o: where the placement gate put it, when and why; absent until its build starts (T3O-87). */
  placement: Schema.optionalKey(BoardCardPlacementRecord),
  /** Why its step waits, when it does. */
  queuedBy: Schema.NullOr(TrimmedNonEmptyString),
  queuedDetail: Schema.NullOr(
    Schema.Struct({
      workerId: Schema.optionalKey(TrimmedNonEmptyString),
      dimension: Schema.optionalKey(BoardResourceDimension),
      behindCardId: Schema.optionalKey(TrimmedNonEmptyString),
      tooBig: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export type BoardCardCapacityView = typeof BoardCardCapacityView.Type;

export function boardCardCapacityView(input: {
  readonly resources: BoardCardResources | null;
  readonly projectResources: BoardProjectResources | null | undefined;
  readonly workerId: string;
  readonly queuedBy: string | null;
  readonly queuedDetail: BoardCardCapacityView["queuedDetail"];
}): BoardCardCapacityView {
  const sizing = input.resources?.sizing ?? null;
  const grant = input.resources?.grant ?? null;
  return {
    size: boardCardEffectiveSize(sizing),
    planner: sizing?.planner ?? null,
    edit: sizing?.edit ?? null,
    reservation: boardCardRequestedProfile(input.resources, input.projectResources),
    granted: grant === null ? null : { profile: grant.profile, heavy: grant.heavy },
    workerId: input.workerId,
    ...(input.resources?.placement == null ? {} : { placement: input.resources.placement }),
    queuedBy: input.queuedBy,
    queuedDetail: input.queuedDetail,
  };
}
