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
  forgetBoard,
  heldByBoard,
  recordIsHeavy,
  type CapacityActivity,
  type CapacityRecord,
  type CapacityState,
  type MachineReading,
  type WorktreePresence,
} from "./capacityModel.ts";
import { BoardMachine, bytesToGB, bytesToGiB, defaultRamGiB } from "./machine.ts";

/** How often the snapshot is recomputed; it is pushed only on a meaningful change. */
export const SNAPSHOT_INTERVAL_MS = 5_000;
/** A headroom change smaller than this share of declared capacity is not pushed. */
const HYSTERESIS = 0.05;
/** An unsettled worktree is measured at most this often. */
const MEASURE_INTERVAL_MS = 5 * 60_000;
/** Usage is refreshed this often while a gating window is at the threshold, and on a
    placement claim when the reading is older. */
const QUOTA_REFRESH_MS = 10 * 60_000;

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
  readonly notReady: (repositoryKey: string | null) => Effect.Effect<string | null>;
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

const isGatingWindow = (window: { readonly kind: string; readonly label: string }) =>
  (window.kind === "session" || window.kind === "weekly") && !window.label.includes("·");

const nowIso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

/** A provider is exhausted when an account-wide session or weekly window is at the
    threshold. Model-scoped and spend windows never gate; a passed reset is available. */
export function providerQuota(
  provider: Pick<ServerProvider, "usageLimits">,
  thresholdPercent: number,
  now: number,
): BoardWorkerProviderCapacity["quota"] {
  const limits = provider.usageLimits;
  if (limits === undefined) {
    return { exhausted: false, checkedAt: null, resetsAt: null, windows: [] };
  }
  const windows = limits.windows.map((window) => {
    const reset = window.resetsAt === undefined ? null : window.resetsAt;
    return {
      label: window.label,
      usedPercent: window.usedPercent,
      resetsAt: reset,
      gating: isGatingWindow(window),
    };
  });
  const exhausting = windows.filter(
    (window) =>
      window.gating &&
      window.usedPercent >= thresholdPercent &&
      (window.resetsAt === null || Date.parse(window.resetsAt) > now),
  );
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

  /** Disk by default: 90% of the free space when first configured, plus what board
      worktrees already use. Computed once and kept. */
  const defaultDiskGB = Effect.gen(function* () {
    const stored = yield* ports.store.setting("capacity.diskGB.default");
    const parsed = stored === null ? Number.NaN : Number(stored);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    const free = yield* machine.freeDiskBytes(ports.worktreeVolume);
    if (free === null) return 50;
    const used = state.records.reduce((sum, record) => sum + (record.measuredDiskGB ?? 0), 0);
    const computed = Math.max(1, Math.floor(bytesToGB(free) * 0.9 + used));
    yield* ports.store.saveSetting("capacity.diskGB.default", String(computed));
    return computed;
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
    yield* ports.refreshProviderUsage(providerInstanceId).pipe(Effect.ignore);
  });

  const decide = Effect.fn("BoardWorkerCapacity.decide")(function* (
    boardId: string,
    input: BoardCapacityClaimInput,
  ) {
    const now = yield* Clock.currentTimeMillis;
    if (input.kind === "placement" && input.force !== true) {
      yield* freshUsage(input.providerInstanceId, now);
    }
    const settings = yield* ports.settings;
    const providers = yield* ports.providers;
    const threads = yield* ports.threads;
    const notReady = yield* ports.notReady(input.repositoryKey);
    return decideClaim(state, input, {
      boardId,
      declared: yield* declared,
      activity: activityOf(threads),
      machine: yield* machineReading,
      now,
      quotaExhausted: quotaFor(providers, settings, now),
      notReady: () => notReady,
    });
  });

  const claim: BoardWorkerCapacityShape["claim"] = (boardId, input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const decision = yield* decide(boardId, input);
        state = decision.state;
        return decision.result;
      }),
    );

  /** A claim of nothing: a group card's worktree, which takes no claim and makes no record. */
  const isEmptyClaim = (provisionClaim: BoardProvisionClaim) =>
    provisionClaim.profile.cpuCores === 0 &&
    provisionClaim.profile.ramGiB === 0 &&
    provisionClaim.profile.diskGB === 0;

  const checkProvision: BoardWorkerCapacityShape["checkProvision"] = (boardId, provisionClaim) =>
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
        // Presence is read before the pure step: it may adopt a legacy marker on disk.
        const known = new Set(
          state.records
            .filter((record) => record.boardId === boardId)
            .map((record) => record.cardId),
        );
        const presence = new Map<string, WorktreePresence>();
        for (const entry of input.cards) {
          if (known.has(entry.cardId)) continue;
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
      const threads = yield* ports.threads;
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
      } satisfies BoardWorkerCapacitySnapshot;
    },
  );

  const subscribe: BoardWorkerCapacityShape["subscribe"] = (boardId) =>
    Stream.unwrap(
      Effect.sync(() => {
        let last: BoardWorkerCapacitySnapshot | null = null;
        const tick = snapshot(boardId).pipe(
          Effect.map((next) => {
            if (last !== null && !snapshotChanged(last, next)) return [] as const;
            last = next;
            return [next] as const;
          }),
        );
        return Stream.fromEffectSchedule(tick, Schedule.spaced(SNAPSHOT_INTERVAL_MS)).pipe(
          Stream.flatMap((items) => Stream.fromIterable(items)),
        );
      }),
    );

  const forget: BoardWorkerCapacityShape["forgetBoard"] = (boardId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        state = forgetBoard(state, boardId);
        yield* ports.store.deleteBoard(boardId);
      }),
    );

  const status: BoardWorkerCapacityShape["status"] = Effect.fn("BoardWorkerCapacity.status")(
    function* (servedBoardIds) {
      const now = yield* Clock.currentTimeMillis;
      const activity = activityOf(yield* ports.threads);
      const headroom = computeHeadroom({
        state,
        declared: yield* declared,
        activity,
        machine: yield* machineReading,
        now,
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
        unowned: yield* ports.unownedWorktrees(servedBoardIds),
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
