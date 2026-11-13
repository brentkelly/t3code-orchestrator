/**
 * Worker-owned capacity (T3O-86): this server's card records for every board it serves, the
 * claims it has granted, and what it offers each board. A board sees only its own headroom
 * and asks; the worker alone accounts for every board and decides. `local` (the board server
 * itself) runs the same service in-process under its own environment id.
 */
import {
  BOARD_RESOURCE_DIMENSIONS,
  boardResourceProfileValue,
  type BoardCapacityClaimInput,
  type BoardCapacityClaimResult,
  type BoardProvisionClaim,
  type BoardResourceProfile,
  type BoardSyncCardsInput,
  type BoardSyncCardsResult,
  type BoardWorkerCapacitySnapshot,
  type BoardWorkerProviderCapacity,
  type BoardCardSetupProgress,
  type BoardWorkerCheckReadinessInput,
  type BoardWorkerReadiness,
  type BoardWorkerRunSetupInput,
  type BoardWorkerSetupState,
  type ServerProvider,
  type BoardCapacityHoldInput,
  type BoardCapacityHoldResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { WorkerCapacitySettings, WorkerCapacityStatus } from "../tunnel/workerFile.ts";
import {
  applySyncCards,
  computeHeadroom,
  consumePlacement,
  decideClaim,
  EMPTY_CAPACITY_STATE,
  firstShort,
  forgetBoard,
  heldByBoard,
  recordIsHeavy,
  type CapacityActivity,
  type CapacityRecord,
  type CapacityState,
  type MachineReading,
  type ClaimDecision,
  type WorktreePresence,
} from "./capacityModel.ts";
import {
  EMPTY_HOLD_STATE,
  holdClaimRefusal,
  holdUntil,
  holdView,
  noteConsumed,
  noteEarlyStart,
  releaseBoardHolds,
  releaseHold,
  requestHold,
  tickHolds,
  type HoldSettings,
  type HoldState,
} from "./holdModel.ts";
import { BoardMachine, bytesToGB, bytesToGiB, defaultRamGiB } from "./machine.ts";

/** How often the snapshot is recomputed; it is pushed only on a meaningful change. */
export const SNAPSHOT_INTERVAL_MS = 5_000;
/** A headroom change smaller than this share of declared capacity is not pushed. */
const HYSTERESIS = 0.05;
/** A small change held back by the hysteresis is still pushed once it has stood this long. */
export const SNAPSHOT_SETTLE_MS = 30_000;
const THREADS_SHARED_MS = 2_000;
const UNOWNED_SHARED_MS = 60_000;
/** An unsettled worktree is measured at most this often. */
const MEASURE_INTERVAL_MS = 5 * 60_000;
/** Usage is refreshed this often while a gating window is at the threshold, and on a
    placement claim when the reading is older. */
const QUOTA_REFRESH_MS = 10 * 60_000;
/** A claim waits this long for a stale usage reading, then decides on what it has. */
const CLAIM_QUOTA_REFRESH_TIMEOUT_MS = 2_000;

/** A thread on this worker, as capacity sees it. */
export interface CapacityThread {
  readonly threadId: string;
  /** The board that spawned it, or null for a thread no board started. */
  readonly boardId: string | null;
  readonly worktreePath: string | null;
  /** A turn runs, or background work does; a thread waiting on a human is not running. */
  readonly running: boolean;
  readonly providerInstanceId: string | null;
}

/** Everything the service reads from the server around it, so tests supply each. */
export interface WorkerCapacityPorts {
  readonly settings: Effect.Effect<WorkerCapacitySettings>;
  readonly threads: Effect.Effect<ReadonlyArray<CapacityThread>>;
  readonly providers: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly refreshProviderUsage: (instanceId: string) => Effect.Effect<void>;
  /** Null when the worker is ready for the repository, else why not (section 5). */
  readonly notReady: (
    boardId: string,
    repositoryKey: string | null,
    projectId: string | undefined,
  ) => Effect.Effect<string | null>;
  /** Readiness of the projects this board asked about (section 5). */
  readonly readiness: (boardId: string) => Effect.Effect<ReadonlyArray<BoardWorkerReadiness>>;
  /** Whether a listed worktree is this board's here, adopting a legacy marker. */
  readonly worktreePresence: (
    boardId: string,
    entry: BoardSyncCardsInput["cards"][number],
  ) => Effect.Effect<WorktreePresence>;
  /** The volume card worktrees live on. */
  readonly worktreeVolume: string;
  /** Board worktrees here no served board owns: a legacy marker no board listed, or a
      board this worker no longer serves. */
  readonly unownedWorktrees: (
    servedBoardIds: ReadonlySet<string>,
  ) => Effect.Effect<WorkerCapacityStatus["unowned"]>;
  readonly store: {
    readonly load: Effect.Effect<CapacityState>;
    readonly saveBoard: (
      boardId: string,
      lastSeq: number | null,
      records: ReadonlyArray<CapacityRecord>,
    ) => Effect.Effect<void>;
    readonly deleteBoard: (boardId: string) => Effect.Effect<void>;
    readonly setting: (key: string) => Effect.Effect<string | null>;
    readonly saveSetting: (key: string, value: string) => Effect.Effect<void>;
  };
}

export interface BoardWorkerCapacityShape {
  readonly claim: (
    boardId: string,
    input: BoardCapacityClaimInput,
  ) => Effect.Effect<BoardCapacityClaimResult>;
  readonly syncCards: (
    boardId: string,
    input: BoardSyncCardsInput,
  ) => Effect.Effect<BoardSyncCardsResult>;
  /** Before a provision: the claim it carries is still held, or fits again now. */
  readonly checkProvision: (
    boardId: string,
    claim: BoardProvisionClaim,
  ) => Effect.Effect<BoardCapacityClaimResult>;
  /** After a provision: its claim is consumed into the card's record. */
  readonly recordProvision: (
    boardId: string,
    claim: BoardProvisionClaim,
    worktree: { readonly branch: string; readonly worktreePath: string },
  ) => Effect.Effect<void>;
  /** Why a board may not start another turn here now (`agent-cap`), or null. */
  readonly agentCapRefusal: (providerInstanceId: string | null) => Effect.Effect<string | null>;
  /** T3o: ask for or refresh a hold, or withdraw one (T3O-87). */
  readonly hold: (
    boardId: string,
    input: BoardCapacityHoldInput,
  ) => Effect.Effect<BoardCapacityHoldResult>;
  readonly releaseHold: (boardId: string, cardId: string) => Effect.Effect<void>;
  readonly snapshot: (boardId: string) => Effect.Effect<BoardWorkerCapacitySnapshot>;
  /** The snapshot now, then on every meaningful change, at most every 5 s. */
  readonly subscribe: (boardId: string) => Stream.Stream<BoardWorkerCapacitySnapshot>;
  /** A board left: its records and claims go. */
  readonly forgetBoard: (boardId: string) => Effect.Effect<void>;
  readonly boardIds: Effect.Effect<ReadonlyArray<string>>;
  /** The section `t3o-worker status` prints. */
  readonly status: (servedBoardIds: ReadonlySet<string>) => Effect.Effect<WorkerCapacityStatus>;
  /** Measure unsettled worktrees due a measurement; the service runs it on its own clock. */
  readonly measure: Effect.Effect<void>;
  /** The board on this server names its own threads, so they count as board threads. */
  readonly registerLocalBoardThreads: (
    read: Effect.Effect<ReadonlySet<string>>,
  ) => Effect.Effect<void>;
  // Section 5: a card's setup and a project's readiness on this worker.
  readonly runSetup: (input: BoardWorkerRunSetupInput) => Stream.Stream<BoardCardSetupProgress>;
  readonly setupState: (worktreePath: string) => Effect.Effect<BoardWorkerSetupState>;
  readonly cancelSetup: (worktreePath: string) => Effect.Effect<void>;
  readonly readSetupLog: (worktreePath: string) => Effect.Effect<string>;
  readonly checkReadiness: (
    boardId: string,
    input: BoardWorkerCheckReadinessInput,
  ) => Effect.Effect<BoardWorkerReadiness>;
  readonly readinessOutput: (
    boardId: string,
    repositoryKey: string | null,
    path: string,
  ) => Effect.Effect<string | null>;
  /** Whether a worktree here is one of this board's cards: its setup is that board's. */
  readonly boardHoldsWorktree: (boardId: string, worktreePath: string) => Effect.Effect<boolean>;
}

/** What the live layer adds around the capacity arithmetic. */
type LiveOnly =
  | "registerLocalBoardThreads"
  | "runSetup"
  | "setupState"
  | "cancelSetup"
  | "readSetupLog"
  | "checkReadiness"
  | "readinessOutput";

export class BoardWorkerCapacity extends Context.Service<
  BoardWorkerCapacity,
  BoardWorkerCapacityShape
>()("t3/board/capacity/BoardWorkerCapacity") {}

/** Drivers whose every window is one model family's quota, never the account's. */
const MODEL_SCOPED_DRIVERS: ReadonlySet<string> = new Set(["antigravity"]);

/** Read from window ids, which the usage contract keeps stable, never display labels.
    Claude's per-model weekly windows are `seven_day_<model>` beside the account's `seven_day`. */
const isGatingWindow = (driver: string, window: { readonly kind: string; readonly id: string }) =>
  (window.kind === "session" || window.kind === "weekly") &&
  !MODEL_SCOPED_DRIVERS.has(driver) &&
  !window.id.startsWith("seven_day_");

const nowIso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

/** A provider is exhausted when an account-wide session or weekly window is at the
    threshold. Model-scoped and spend windows never gate; a passed reset is available. */
export function providerQuota(
  provider: Pick<ServerProvider, "usageLimits" | "driver">,
  thresholdPercent: number,
  now: number,
): BoardWorkerProviderCapacity["quota"] {
  const limits = provider.usageLimits;
  if (limits === undefined) {
    return { exhausted: false, checkedAt: null, resetsAt: null, windows: [] };
  }
  const windows = limits.windows.map((window) => {
    const resetsAt = window.resetsAt === undefined ? null : window.resetsAt;
    const gating = isGatingWindow(provider.driver, window);
    return {
      label: window.label,
      usedPercent: window.usedPercent,
      resetsAt,
      gating,
      nearLimit:
        gating &&
        window.usedPercent >= thresholdPercent &&
        (resetsAt === null || Date.parse(resetsAt) > now),
    };
  });
  const exhausting = windows.filter((window) => window.nearLimit);
  const resetsAt =
    exhausting
      .map((window) => window.resetsAt)
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? null;
  return { exhausted: exhausting.length > 0, checkedAt: limits.checkedAt, resetsAt, windows };
}

const accountOf = (provider: ServerProvider): BoardWorkerProviderCapacity["account"] => {
  const status =
    provider.auth.status === "authenticated"
      ? "signed-in"
      : provider.auth.status === "unauthenticated"
        ? "signed-out"
        : "unknown";
  return {
    status,
    ...(provider.auth.email === undefined ? {} : { email: provider.auth.email }),
    ...(provider.auth.label === undefined ? {} : { plan: provider.auth.label }),
  };
};

/** Whether two snapshots differ enough to push the later one. */
function snapshotChanged(
  previous: BoardWorkerCapacitySnapshot,
  next: BoardWorkerCapacitySnapshot,
): boolean {
  for (const dimension of BOARD_RESOURCE_DIMENSIONS) {
    const declared = Math.max(1, boardResourceProfileValue(next.declared, dimension));
    const delta = Math.abs(
      boardResourceProfileValue(next.headroom, dimension) -
        boardResourceProfileValue(previous.headroom, dimension),
    );
    if (delta / declared > HYSTERESIS) return true;
    if (
      boardResourceProfileValue(next.declared, dimension) !==
      boardResourceProfileValue(previous.declared, dimension)
    ) {
      return true;
    }
  }
  const stable = (snapshot: BoardWorkerCapacitySnapshot) =>
    JSON.stringify({
      over: snapshot.over,
      agents: snapshot.agents,
      providers: snapshot.providers.map((provider) => ({
        ...provider,
        quota: {
          ...provider.quota,
          checkedAt: null,
          windows: provider.quota.windows.map((window) => ({
            ...window,
            usedPercent: Math.round(window.usedPercent),
          })),
        },
      })),
      readiness: snapshot.readiness,
      heavyCards: [...snapshot.heavyCards].sort(),
      hold: snapshot.hold ?? null,
    });
  return stable(previous) !== stable(next);
}

export const makeBoardWorkerCapacity = Effect.fn("makeBoardWorkerCapacity")(function* (
  ports: WorkerCapacityPorts,
) {
  const machine = yield* BoardMachine;
  const lock = yield* Semaphore.make(1);
  let state: CapacityState = yield* ports.store.load.pipe(
    Effect.catchCause(() => Effect.succeed(EMPTY_CAPACITY_STATE)),
  );
  let quotaRefreshedAt = new Map<string, number>();

  const persistBoard = (boardId: string) =>
    ports.store.saveBoard(
      boardId,
      state.lastSeq.get(boardId) ?? null,
      state.records.filter((record) => record.boardId === boardId),
    );

  const machineReading = Effect.gen(function* () {
    const available = yield* machine.availableMemoryBytes;
    const free = yield* machine.freeDiskBytes(ports.worktreeVolume);
    return {
      availableRamGiB: available === null ? null : bytesToGiB(available),
      freeDiskGB: free === null ? null : bytesToGB(free),
    } satisfies MachineReading;
  });

  /** Disk by default: 90% of the free space when first configured, kept, plus what the
      worktrees that were already there use. Those are backfilled after the first snapshot and
      measured later, so their part is added as it is measured, never stored. */
  const defaultDiskGB = Effect.gen(function* () {
    const stored = yield* ports.store.setting("capacity.diskGB.default");
    const parsed = stored === null ? Number.NaN : Number(stored);
    let base = parsed;
    if (!(Number.isFinite(parsed) && parsed > 0)) {
      const free = yield* machine.freeDiskBytes(ports.worktreeVolume);
      if (free === null) return 50;
      base = Math.max(1, Math.floor(bytesToGB(free) * 0.9));
      yield* ports.store.saveSetting("capacity.diskGB.default", String(base));
    }
    const existing = state.records.reduce(
      (sum, record) =>
        sum + (record.diskFromMeasurement ? Math.ceil(record.measuredDiskGB ?? 0) : 0),
      0,
    );
    return base + existing;
  });

  const declared = Effect.gen(function* () {
    const settings = yield* ports.settings;
    return {
      cpuCores: settings.cpuCores ?? (yield* machine.cpuCount),
      ramGiB:
        settings.ramGiB ??
        defaultRamGiB(yield* machine.totalMemoryBytes, yield* machine.agentSliceMemoryHighBytes),
      diskGB: settings.diskGB ?? (yield* defaultDiskGB),
    } satisfies BoardResourceProfile;
  });

  const activityOf = (threads: ReadonlyArray<CapacityThread>): CapacityActivity => {
    const recordPaths = new Set(
      state.records.flatMap((record) =>
        record.worktreePath === null ? [] : [record.worktreePath],
      ),
    );
    const runningWorktrees = new Set<string>();
    let planningThreads = 0;
    for (const thread of threads) {
      if (!thread.running) continue;
      if (thread.worktreePath !== null && recordPaths.has(thread.worktreePath)) {
        runningWorktrees.add(thread.worktreePath);
      } else if (thread.boardId !== null) {
        planningThreads += 1;
      }
    }
    return { runningWorktrees, planningThreads };
  };

  const quotaFor = (
    providers: ReadonlyArray<ServerProvider>,
    settings: WorkerCapacitySettings,
    now: number,
  ) => {
    return (providerInstanceId: string | null) => {
      if (providerInstanceId === null) return null;
      const provider = providers.find((candidate) => candidate.instanceId === providerInstanceId);
      if (provider === undefined) return null;
      const quota = providerQuota(provider, settings.quotaThresholdPercent, now);
      return quota.exhausted ? { resetsAt: quota.resetsAt } : null;
    };
  };

  /** A placement claim refreshes a usage reading older than ten minutes first. */
  const freshUsage = Effect.fn("BoardWorkerCapacity.freshUsage")(function* (
    providerInstanceId: string | null,
    now: number,
  ) {
    if (providerInstanceId === null) return;
    const providers = yield* ports.providers;
    const provider = providers.find((candidate) => candidate.instanceId === providerInstanceId);
    const checkedAt =
      provider?.usageLimits === undefined ? null : Date.parse(provider.usageLimits.checkedAt);
    const last = quotaRefreshedAt.get(providerInstanceId);
    if (checkedAt !== null && now - checkedAt < QUOTA_REFRESH_MS) return;
    if (last !== undefined && now - last < QUOTA_REFRESH_MS) return;
    quotaRefreshedAt = new Map(quotaRefreshedAt).set(providerInstanceId, now);
    yield* ports
      .refreshProviderUsage(providerInstanceId)
      .pipe(Effect.timeout(CLAIM_QUOTA_REFRESH_TIMEOUT_MS), Effect.ignore);
  });

  /** Run before taking the lock: a slow provider must not hold every board's claims. */
  const refreshBeforePlacement = Effect.fn("BoardWorkerCapacity.refreshBeforePlacement")(function* (
    input: Pick<BoardCapacityClaimInput, "kind" | "force" | "providerInstanceId">,
  ) {
    if (input.kind !== "placement" || input.force === true) return;
    yield* freshUsage(input.providerInstanceId, yield* Clock.currentTimeMillis);
  });

  // T3o: holds live in worker memory (T3O-87): after a restart they return on the next refresh.
  let holds: HoldState = EMPTY_HOLD_STATE;
  const holdSettingsOf = (settings: WorkerCapacitySettings): HoldSettings => ({
    earlyStartFraction: settings.holdEarlyStartFraction,
    maxMinutes: settings.holdMaxMinutes,
  });
  const withinCapacity = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const headroom = computeHeadroom({
      state,
      declared: yield* declared,
      activity: activityOf(yield* ports.threads),
      machine: yield* machineReading,
      now,
    });
    return !headroom.over.cpuRam;
  });

  const decide = Effect.fn("BoardWorkerCapacity.decide")(function* (
    boardId: string,
    input: BoardCapacityClaimInput,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const settings = yield* ports.settings;
    const providers = yield* ports.providers;
    const threads = yield* ports.threads;
    const notReady = yield* ports.notReady(boardId, input.repositoryKey, input.projectId);
    const holdSettings = holdSettingsOf(settings);
    const within = yield* withinCapacity;
    holds = tickHolds(holds, { now, withinCapacity: within, settings: holdSettings });
    const record = state.records.some(
      (candidate) => candidate.boardId === boardId && candidate.cardId === input.cardId,
    );
    // A resumed provision resends its claim; the card's hold doesn't refuse its own record.
    if (!(input.kind === "placement" && record)) {
      const refused = holdClaimRefusal(holds, {
        boardId,
        cardId: input.cardId,
        kind: input.kind,
        force: input.force === true,
        early: input.hold === true,
        now,
        settings: holdSettings,
        withinCapacity: within,
        replacesCardId: input.replacesCardId,
      });
      holds = refused.state;
      if (refused.refusal !== null) {
        const until = holdUntil(holds, holds.placement?.boardId ?? boardId, holdSettings, now);
        return {
          result: {
            outcome: "denied",
            reason: "reserved",
            ...(until === null ? {} : { resetsAt: nowIso(until) }),
          },
          state,
        } satisfies ClaimDecision;
      }
    }
    const early =
      input.hold === true &&
      (input.kind === "grow"
        ? holds.grows.some((grow) => grow.boardId === boardId && grow.cardId === input.cardId)
        : holds.placement?.boardId === boardId && holds.placement.cardId === input.cardId);
    const decision = decideClaim(state, input, {
      boardId,
      declared: yield* declared,
      activity: activityOf(threads),
      machine: yield* machineReading,
      now,
      quotaExhausted: quotaFor(providers, settings, now),
      notReady: () => notReady,
      ...(early ? { earlyStartFraction: holdSettings.earlyStartFraction } : {}),
    });
    if (decision.result.outcome === "granted") {
      if (early && input.kind === "placement") holds = noteEarlyStart(holds, boardId, now);
      if (
        input.kind === "placement" &&
        holds.placement?.boardId === boardId &&
        holds.placement.cardId === input.replacesCardId
      ) {
        holds = releaseHold(holds, boardId, input.replacesCardId);
      }
      // A granted grow ends the card's grow hold: the sync that lists it heavy consumes it.
      if (input.kind === "grow") holds = releaseHold(holds, boardId, input.cardId);
    }
    return decision;
  });

  const hold: BoardWorkerCapacityShape["hold"] = (boardId, input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const settings = yield* ports.settings;
        const providers = yield* ports.providers;
        const total = yield* declared;
        const activity = activityOf(yield* ports.threads);
        const headroom = computeHeadroom({
          state,
          declared: total,
          activity,
          machine: yield* machineReading,
          now,
        });
        const notReady = yield* ports.notReady(boardId, input.repositoryKey, input.projectId);
        const provider =
          input.providerInstanceId === null
            ? undefined
            : providers.find((candidate) => candidate.instanceId === input.providerInstanceId);
        const signedOut = provider !== undefined && accountOf(provider).status === "signed-out";
        const quota = quotaFor(providers, settings, now)(input.providerInstanceId);
        const holdSettings = holdSettingsOf(settings);
        const asked = requestHold(holds, {
          boardId,
          cardId: input.cardId,
          kind: input.kind,
          profile: input.profile,
          eligibility: {
            eligible: notReady === null && !signedOut && quota === null,
            tooBig: firstShort(input.profile, total) !== null,
            // Over on CPU or RAM offers nothing, but the disk that is free still counts.
            diskFits:
              !headroom.over.disk &&
              input.profile.diskGB <=
                (headroom.over.cpuRam
                  ? headroom.declared.diskGB - headroom.held.diskGB
                  : headroom.offered.diskGB),
            placedHere: state.records.some(
              (record) => record.boardId === boardId && record.cardId === input.cardId,
            ),
          },
          now,
          settings: holdSettings,
          withinCapacity: !headroom.over.cpuRam,
          replacesCardId: input.replacesCardId,
        });
        holds = asked.state;
        const answer = asked.answer;
        if (answer.outcome === "refused") {
          return {
            outcome: "refused",
            reason: answer.reason,
            until: answer.until === null ? null : nowIso(answer.until),
          } satisfies BoardCapacityHoldResult;
        }
        const need =
          input.kind === "grow"
            ? input.profile
            : {
                cpuCores: input.profile.cpuCores * holdSettings.earlyStartFraction,
                ramGiB: input.profile.ramGiB * holdSettings.earlyStartFraction,
                diskGB: input.profile.diskGB,
              };
        return {
          outcome: "held",
          short: {
            cpuCores: Math.max(0, need.cpuCores - headroom.offered.cpuCores),
            ramGiB: Math.max(0, need.ramGiB - headroom.offered.ramGiB),
            diskGB: Math.max(0, need.diskGB - headroom.offered.diskGB),
          },
          until: answer.until === null ? null : nowIso(answer.until),
        } satisfies BoardCapacityHoldResult;
      }),
    );

  const releaseHoldOf: BoardWorkerCapacityShape["releaseHold"] = (boardId, cardId) =>
    lock.withPermits(1)(Effect.sync(() => void (holds = releaseHold(holds, boardId, cardId))));

  const claim: BoardWorkerCapacityShape["claim"] = (boardId, input) =>
    refreshBeforePlacement(input).pipe(
      Effect.andThen(
        lock.withPermits(1)(
          Effect.gen(function* () {
            const decision = yield* decide(boardId, input);
            state = decision.state;
            return decision.result;
          }),
        ),
      ),
    );

  /** A claim of nothing: a group card's worktree, which takes no claim and makes no record. */
  const isEmptyClaim = (provisionClaim: BoardProvisionClaim) =>
    provisionClaim.profile.cpuCores === 0 &&
    provisionClaim.profile.ramGiB === 0 &&
    provisionClaim.profile.diskGB === 0;

  const checkProvision: BoardWorkerCapacityShape["checkProvision"] = (boardId, provisionClaim) =>
    (isEmptyClaim(provisionClaim)
      ? Effect.void
      : refreshBeforePlacement({ ...provisionClaim, kind: "placement" })
    ).pipe(
      Effect.andThen(
        lock.withPermits(1)(
          Effect.gen(function* () {
            if (isEmptyClaim(provisionClaim)) {
              return { outcome: "granted" } satisfies BoardCapacityClaimResult;
            }
            const now = yield* Clock.currentTimeMillis;
            const held =
              state.records.some(
                (record) => record.boardId === boardId && record.cardId === provisionClaim.cardId,
              ) ||
              state.reservations.some(
                (reservation) =>
                  reservation.boardId === boardId &&
                  reservation.claimId === provisionClaim.claimId &&
                  reservation.kind === "placement" &&
                  reservation.expiresAt > now,
              );
            if (held) return { outcome: "granted" } satisfies BoardCapacityClaimResult;
            // Unknown or expired (a slow board, or a worker restart): checked again now.
            const decision = yield* decide(boardId, { ...provisionClaim, kind: "placement" });
            state = decision.state;
            return decision.result;
          }),
        ),
      ),
    );

  const recordProvision: BoardWorkerCapacityShape["recordProvision"] = (
    boardId,
    provisionClaim,
    worktree,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (isEmptyClaim(provisionClaim)) return;
        const now = yield* Clock.currentTimeMillis;
        // T3o: the provision consumes the card's hold, and resets its board's clock (T3O-87).
        holds = noteConsumed(holds, boardId, provisionClaim.cardId);
        const result = consumePlacement(state, {
          boardId,
          cardId: provisionClaim.cardId,
          claimId: provisionClaim.claimId,
          seq: provisionClaim.seq,
          repositoryKey: provisionClaim.repositoryKey,
          branch: worktree.branch,
          worktreePath: worktree.worktreePath,
          profile: provisionClaim.profile,
          now,
        });
        state = result.state;
        yield* persistBoard(boardId);
      }),
    );

  const syncCards: BoardWorkerCapacityShape["syncCards"] = (boardId, input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        // Presence is read before the pure step: it may adopt a legacy marker on disk. A known
        // card is checked only when the board names a new path for it.
        const known = new Map(
          state.records
            .filter((record) => record.boardId === boardId)
            .map((record) => [record.cardId, record.worktreePath] as const),
        );
        const presence = new Map<string, WorktreePresence>();
        for (const entry of input.cards) {
          if (known.has(entry.cardId) && known.get(entry.cardId) === entry.worktreePath) continue;
          if (known.has(entry.cardId) && entry.worktreePath === null) continue;
          presence.set(entry.cardId, yield* ports.worktreePresence(boardId, entry));
        }
        const result = applySyncCards(state, {
          ...input,
          boardId,
          now,
          presence: (entry) => presence.get(entry.cardId) ?? "missing",
        });
        if (result.applied) {
          state = result.state;
          yield* persistBoard(boardId);
        }
        return { lastSeq: result.lastSeq, refused: result.refused } satisfies BoardSyncCardsResult;
      }),
    );

  /**
   * Reading every thread is the costly part of a snapshot: each board's stream and the status
   * file share one reading for a few seconds. Claims and spawns read fresh, so the agent cap
   * counts the turn that just started.
   */
  let sharedThreads: {
    readonly at: number;
    readonly threads: ReadonlyArray<CapacityThread>;
  } | null = null;
  const recentThreads = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (sharedThreads !== null && now - sharedThreads.at < THREADS_SHARED_MS) {
      return sharedThreads.threads;
    }
    const threads = yield* ports.threads;
    sharedThreads = { at: now, threads };
    return threads;
  });
  /** Unowned worktrees cost a git call per project: the status file reads them once a minute. */
  let sharedUnowned: {
    readonly at: number;
    readonly value: WorkerCapacityStatus["unowned"];
  } | null = null;

  const agentCapRefusal: BoardWorkerCapacityShape["agentCapRefusal"] = Effect.fn(
    "BoardWorkerCapacity.agentCapRefusal",
  )(function* (providerInstanceId) {
    const settings = yield* ports.settings;
    const running = (yield* ports.threads).filter(
      (thread) => thread.running && thread.boardId !== null,
    );
    if (settings.maxAgents !== null && running.length >= settings.maxAgents) {
      return `This worker runs at most ${settings.maxAgents} agents at once.`;
    }
    const cap = providerInstanceId === null ? undefined : settings.providerCaps[providerInstanceId];
    if (
      cap !== undefined &&
      running.filter((thread) => thread.providerInstanceId === providerInstanceId).length >= cap
    ) {
      return `This worker runs at most ${cap} ${providerInstanceId} agents at once.`;
    }
    return null;
  });

  const snapshot: BoardWorkerCapacityShape["snapshot"] = Effect.fn("BoardWorkerCapacity.snapshot")(
    function* (boardId) {
      const now = yield* Clock.currentTimeMillis;
      const settings = yield* ports.settings;
      const threads = yield* recentThreads;
      const activity = activityOf(threads);
      const headroom = computeHeadroom({
        state,
        declared: yield* declared,
        activity,
        machine: yield* machineReading,
        now,
      });
      const boardThreads = threads.filter((thread) => thread.running && thread.boardId !== null);
      const providers = (yield* ports.providers).filter((provider) => provider.enabled);
      return {
        at: nowIso(now),
        declared: headroom.declared,
        headroom: headroom.offered,
        over: headroom.over,
        agents: { running: boardThreads.length, max: settings.maxAgents },
        providers: providers.map((provider) => ({
          instanceId: provider.instanceId,
          driver: provider.driver,
          account: accountOf(provider),
          quota: providerQuota(provider, settings.quotaThresholdPercent, now),
          agents: {
            running: boardThreads.filter(
              (thread) => thread.providerInstanceId === provider.instanceId,
            ).length,
            max: settings.providerCaps[provider.instanceId] ?? null,
          },
        })),
        readiness: yield* ports.readiness(boardId),
        heavyCards: state.records
          .filter(
            (record) =>
              record.boardId === boardId &&
              record.phase === "light" &&
              recordIsHeavy(record, activity),
          )
          .map((record) => record.cardId),
        hold: (() => {
          const view = holdView(
            tickHolds(holds, {
              now,
              withinCapacity: !headroom.over.cpuRam,
              settings: holdSettingsOf(settings),
            }),
            boardId,
            holdSettingsOf(settings),
            now,
          );
          return { ...view, until: view.until === null ? null : nowIso(view.until) };
        })(),
      } satisfies BoardWorkerCapacitySnapshot;
    },
  );

  const subscribe: BoardWorkerCapacityShape["subscribe"] = (boardId) =>
    Stream.unwrap(
      Effect.sync(() => {
        let last: BoardWorkerCapacitySnapshot | null = null;
        let lastAt = 0;
        const tick = Effect.gen(function* () {
          const next = yield* snapshot(boardId);
          const now = yield* Clock.currentTimeMillis;
          if (last !== null && !snapshotChanged(last, next)) {
            // Without this a release under 5% would never reach the board, which filters on it.
            const drifted =
              now - lastAt >= SNAPSHOT_SETTLE_MS &&
              BOARD_RESOURCE_DIMENSIONS.some(
                (dimension) =>
                  boardResourceProfileValue(last!.headroom, dimension) !==
                  boardResourceProfileValue(next.headroom, dimension),
              );
            if (!drifted) return [] as const;
          }
          last = next;
          lastAt = now;
          return [next] as const;
        });
        return Stream.fromEffectSchedule(tick, Schedule.spaced(SNAPSHOT_INTERVAL_MS)).pipe(
          Stream.flatMap((items) => Stream.fromIterable(items)),
        );
      }),
    );

  const forget: BoardWorkerCapacityShape["forgetBoard"] = (boardId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        state = forgetBoard(state, boardId);
        holds = releaseBoardHolds(holds, boardId);
        yield* ports.store.deleteBoard(boardId);
      }),
    );

  const status: BoardWorkerCapacityShape["status"] = Effect.fn("BoardWorkerCapacity.status")(
    function* (servedBoardIds) {
      const now = yield* Clock.currentTimeMillis;
      const activity = activityOf(yield* recentThreads);
      const headroom = computeHeadroom({
        state,
        declared: yield* declared,
        activity,
        machine: yield* machineReading,
        now,
      });
      // As a claim would see them now: lapsed holds gone, `until` at this worker's own limit.
      const holdSettings = holdSettingsOf(yield* ports.settings);
      const current = tickHolds(holds, {
        now,
        withinCapacity: !headroom.over.cpuRam,
        settings: holdSettings,
      });
      return {
        updatedAt: nowIso(now),
        declared: headroom.declared,
        held: headroom.held,
        headroom: headroom.offered,
        heldByBoard: [...heldByBoard(state, activity, now)].map(([boardEnvironmentId, held]) => ({
          boardEnvironmentId,
          held,
        })),
        hold: {
          placement:
            current.placement === null
              ? null
              : {
                  boardEnvironmentId: current.placement.boardId,
                  cardId: current.placement.cardId,
                  since: nowIso(current.placement.since),
                  until: (() => {
                    const until = holdUntil(current, current.placement.boardId, holdSettings, now);
                    return until === null ? null : nowIso(until);
                  })(),
                },
          grows: current.grows.map((grow) => ({
            boardEnvironmentId: grow.boardId,
            cardId: grow.cardId,
            since: nowIso(grow.since),
          })),
        },
        unowned: yield* Effect.gen(function* () {
          if (sharedUnowned !== null && now - sharedUnowned.at < UNOWNED_SHARED_MS) {
            return sharedUnowned.value;
          }
          const value = yield* ports.unownedWorktrees(servedBoardIds);
          sharedUnowned = { at: now, value };
          return value;
        }),
      };
    },
  );

  const measure: BoardWorkerCapacityShape["measure"] = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const due = state.records.filter(
      (record) =>
        record.worktreePath !== null &&
        (!record.settled || (record.diskFromMeasurement && record.measuredDiskGB === null)) &&
        (record.measuredAt === null || now - record.measuredAt >= MEASURE_INTERVAL_MS),
    );
    for (const record of due) {
      const bytes = yield* machine.diskUsageBytes(record.worktreePath!);
      if (bytes === null) continue;
      yield* lock.withPermits(1)(
        Effect.sync(() => {
          state = {
            ...state,
            records: state.records.map((candidate) =>
              candidate.boardId === record.boardId && candidate.cardId === record.cardId
                ? { ...candidate, measuredDiskGB: bytesToGB(bytes), measuredAt: now }
                : candidate,
            ),
          };
        }),
      );
      yield* persistBoard(record.boardId);
    }
  }).pipe(Effect.withSpan("BoardWorkerCapacity.measure"));

  /** Usage refreshes every ten minutes while a gating window is at the threshold: upstream
      refreshes only while a UI client is connected, which a headless worker never has. */
  const refreshQuota = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const settings = yield* ports.settings;
    for (const provider of yield* ports.providers) {
      if (!provider.enabled) continue;
      const quota = providerQuota(provider, settings.quotaThresholdPercent, now);
      if (!quota.exhausted) continue;
      const last = quotaRefreshedAt.get(provider.instanceId);
      if (last !== undefined && now - last < QUOTA_REFRESH_MS) continue;
      quotaRefreshedAt = new Map(quotaRefreshedAt).set(provider.instanceId, now);
      yield* ports.refreshProviderUsage(provider.instanceId).pipe(Effect.ignore);
    }
  });

  return {
    service: {
      claim,
      syncCards,
      checkProvision,
      recordProvision,
      agentCapRefusal,
      hold,
      releaseHold: releaseHoldOf,
      snapshot,
      subscribe,
      forgetBoard: forget,
      boardIds: Effect.sync(() => [...new Set(state.records.map((record) => record.boardId))]),
      boardHoldsWorktree: (boardId: string, worktreePath: string) =>
        Effect.sync(() =>
          state.records.some(
            (record) => record.boardId === boardId && record.worktreePath === worktreePath,
          ),
        ),
      status,
      measure,
    } satisfies Omit<BoardWorkerCapacityShape, LiveOnly>,
    /** The background work: measuring worktrees and refreshing exhausted quota. */
    background: Effect.all(
      [
        measure.pipe(Effect.ignore, Effect.repeat(Schedule.spaced(MEASURE_INTERVAL_MS))),
        refreshQuota.pipe(Effect.ignore, Effect.repeat(Schedule.spaced(QUOTA_REFRESH_MS))),
      ],
      { concurrency: "unbounded", discard: true },
    ),
    /** Test access to the model state. */
    state: () => state,
  };
});
