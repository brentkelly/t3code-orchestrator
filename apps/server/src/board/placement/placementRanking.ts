/**
 * Which worker a card is placed on at build start (T3O-87): eligibility and ranking as pure
 * functions of what the board knows about each worker, so the rules are tested as a table.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  boardReadinessIsFor,
  type BoardCard,
  type BoardState,
  boardResourceProfileOverflow,
  type BoardWorkerCapacitySnapshot,
  type BoardResourceDimension,
  type BoardResourceProfile,
  type BoardWorkerId,
} from "@t3tools/contracts";

/** A Building step finished on a worker this recently counts it warm. */
export const PLACEMENT_WARM_WINDOW_MS = 24 * 60 * 60_000;

/** What the board knows about one worker when it places a card. */
export interface PlacementWorkerFacts {
  readonly workerId: BoardWorkerId;
  readonly label: string;
  /** The tunnel is up (always true for the board server). */
  readonly online: boolean;
  /** At or above the gateway's protocol floor. */
  readonly atFloor: boolean;
  /** Has a checkout of the project's repository. */
  readonly hasCheckout: boolean;
  /** The project's readiness there: ready, still on its way, or failed and needing a human. */
  readonly readiness: "ready" | "pending" | "failed";
  readonly providerSignedIn: boolean;
  readonly quotaRoom: boolean;
  /** Held for another card, or being removed. */
  readonly closed: boolean;
  /** Null when the board has no capacity report from it: nothing is filtered on capacity. */
  readonly declared: BoardResourceProfile | null;
  /** What it offers now, less this pass's grants. */
  readonly headroom: BoardResourceProfile | null;
  readonly over: { readonly cpuRam: boolean; readonly disk: boolean } | null;
}

export type PlacementIneligibility =
  | "offline"
  | "needs-update"
  | "no-checkout"
  | "not-ready"
  | "setting-up"
  | "provider"
  | "quota"
  | "closed"
  | "too-big"
  | "capacity";

export interface PlacementVerdict {
  readonly workerId: BoardWorkerId;
  readonly ineligible: PlacementIneligibility | null;
  /** The dimension that doesn't fit, for `too-big` and `capacity`. */
  readonly dimension?: BoardResourceDimension;
}

/**
 * Whether a worker can take the card now. `force` (Start anyway) keeps only online, ready for
 * the project and the provider signed in: capacity, quota and holds are the worker's to judge.
 */
function placementVerdict(
  facts: PlacementWorkerFacts,
  profile: BoardResourceProfile,
  options: { readonly force?: boolean; readonly skipFit?: boolean } = {},
): PlacementVerdict {
  const no = (ineligible: PlacementIneligibility, dimension?: BoardResourceDimension) => ({
    workerId: facts.workerId,
    ineligible,
    ...(dimension === undefined ? {} : { dimension }),
  });
  if (!facts.online) return no("offline");
  if (!facts.atFloor) return no("needs-update");
  if (!facts.hasCheckout) return no("no-checkout");
  if (facts.readiness === "failed") return no("not-ready");
  if (facts.readiness === "pending") return no("setting-up");
  if (!facts.providerSignedIn) return no("provider");
  if (options.force === true) return { workerId: facts.workerId, ineligible: null };
  if (!facts.quotaRoom) return no("quota");
  if (facts.declared !== null) {
    const tooBig = boardResourceProfileOverflow(profile, facts.declared);
    if (tooBig !== null) return no("too-big", tooBig);
  }
  if (facts.closed) return no("closed");
  if (options.skipFit !== true && facts.headroom !== null) {
    if (facts.over?.cpuRam === true) return no("capacity", "cpu");
    if (facts.over?.disk === true) return no("capacity", "disk");
    const short = boardResourceProfileOverflow(profile, facts.headroom);
    if (short !== null) return no("capacity", short);
  }
  return { workerId: facts.workerId, ineligible: null };
}

/**
 * The room a worker keeps after the card, as a share of what it declares: the smaller of CPU
 * and RAM, with the dimension that sets it. Unknown capacity ranks below any known room.
 */
function placementRoomLeft(
  facts: PlacementWorkerFacts,
  profile: BoardResourceProfile,
): { readonly share: number; readonly dimension: "cpu" | "ram" } {
  if (facts.declared === null || facts.headroom === null) {
    return { share: Number.NEGATIVE_INFINITY, dimension: "ram" };
  }
  const share = (headroom: number, need: number, declared: number) =>
    declared <= 0 ? Number.NEGATIVE_INFINITY : (headroom - need) / declared;
  const cpu = share(facts.headroom.cpuCores, profile.cpuCores, facts.declared.cpuCores);
  const ram = share(facts.headroom.ramGiB, profile.ramGiB, facts.declared.ramGiB);
  return cpu < ram ? { share: cpu, dimension: "cpu" } : { share: ram, dimension: "ram" };
}

/** The last time one of this board's cards finished a successful Building step on each worker,
    for the same repository, within the warm window. */
export function warmWorkers(input: {
  readonly builds: ReadonlyArray<{ readonly workerId: BoardWorkerId; readonly at: number }>;
  readonly now: number;
}): ReadonlyMap<BoardWorkerId, number> {
  const warm = new Map<BoardWorkerId, number>();
  for (const build of input.builds) {
    if (input.now - build.at > PLACEMENT_WARM_WINDOW_MS || build.at > input.now) continue;
    if ((warm.get(build.workerId) ?? Number.NEGATIVE_INFINITY) < build.at) {
      warm.set(build.workerId, build.at);
    }
  }
  return warm;
}

export interface RankedPlacement {
  readonly workerId: BoardWorkerId;
  /** Why it was chosen, for the card's Worker row, should it be the one placed. */
  readonly reason: string;
}

const DIMENSION_NAMES = { cpu: "CPU", ram: "RAM" } as const;

/**
 * The eligible workers in placement order: warm first (most recent first), then the most room
 * left after the card, then worker id. A pin restricts the candidates to the pinned worker.
 */
export function rankPlacement(input: {
  readonly workers: ReadonlyArray<PlacementWorkerFacts>;
  readonly profile: BoardResourceProfile;
  readonly warm: ReadonlyMap<BoardWorkerId, number>;
  readonly pinnedWorkerId: BoardWorkerId | null;
  readonly repositoryLabel: string;
  readonly force?: boolean;
  /** Workers this pass may not place on (held for an earlier card, or denied this pass). */
  readonly excluded?: ReadonlySet<BoardWorkerId>;
}): {
  readonly ranked: ReadonlyArray<RankedPlacement>;
  readonly verdicts: ReadonlyArray<PlacementVerdict>;
} {
  const pool =
    input.pinnedWorkerId === null
      ? input.workers
      : input.workers.filter((worker) => worker.workerId === input.pinnedWorkerId);
  const verdicts = pool.map((worker) =>
    input.excluded?.has(worker.workerId) === true
      ? { workerId: worker.workerId, ineligible: "closed" as const }
      : placementVerdict(worker, input.profile, { force: input.force === true }),
  );
  const eligible = pool.filter((_, index) => verdicts[index]!.ineligible === null);
  const rooms = new Map(
    eligible.map((worker) => [worker.workerId, placementRoomLeft(worker, input.profile)]),
  );
  const ordered = [...eligible].sort((left, right) => {
    const leftWarm = input.warm.get(left.workerId);
    const rightWarm = input.warm.get(right.workerId);
    if (leftWarm !== undefined || rightWarm !== undefined) {
      if (leftWarm === undefined) return 1;
      if (rightWarm === undefined) return -1;
      if (leftWarm !== rightWarm) return rightWarm - leftWarm;
    }
    const roomDelta = rooms.get(right.workerId)!.share - rooms.get(left.workerId)!.share;
    if (roomDelta !== 0 && !Number.isNaN(roomDelta)) return roomDelta;
    return left.workerId < right.workerId ? -1 : left.workerId > right.workerId ? 1 : 0;
  });
  const ranked = ordered.map((worker): RankedPlacement => {
    const reason =
      input.force === true
        ? "started anyway"
        : input.pinnedWorkerId !== null
          ? "pinned"
          : input.warm.has(worker.workerId)
            ? `built ${input.repositoryLabel} most recently`
            : ordered.length === 1
              ? "the only ready worker"
              : rooms.get(worker.workerId)!.share === Number.NEGATIVE_INFINITY
                ? "first ready worker"
                : `offered the most ${DIMENSION_NAMES[rooms.get(worker.workerId)!.dimension]} among ready workers`;
    return { workerId: worker.workerId, reason };
  });
  return { ranked, verdicts };
}

/** Why a card waits when no worker can take it now. */
export type PlacementWait =
  /** Amber: no worker is online and ready for the project with the provider signed in. */
  | { readonly kind: "no-ready-worker" }
  /** Amber: larger than any ready worker declares (or the pin, when pinned). */
  | {
      readonly kind: "too-big";
      readonly dimension: BoardResourceDimension;
      readonly workerId: BoardWorkerId | null;
    }
  /** Blue: a wait that clears by itself, the one that rules out the most workers. */
  | {
      readonly kind: "queued";
      readonly reason: Exclude<PlacementIneligibility, "too-big">;
      readonly workerId: BoardWorkerId | null;
      readonly dimension?: BoardResourceDimension;
    };

const QUEUED_ORDER: ReadonlyArray<Exclude<PlacementIneligibility, "too-big">> = [
  "capacity",
  "closed",
  "quota",
  "setting-up",
  "not-ready",
  "no-checkout",
  "provider",
  "needs-update",
  "offline",
];

/**
 * The one reason a waiting card shows. Blocked beats queued: no worker ready for the project,
 * then too big for every ready worker. Among queued reasons, the one ruling out the most
 * workers, ties broken toward the one that clears soonest.
 */
export function placementWait(input: {
  readonly verdicts: ReadonlyArray<PlacementVerdict>;
  readonly pinned: boolean;
}): PlacementWait {
  const readyFor = input.verdicts.filter(
    (verdict) =>
      verdict.ineligible !== "offline" &&
      verdict.ineligible !== "needs-update" &&
      verdict.ineligible !== "no-checkout" &&
      verdict.ineligible !== "not-ready" &&
      verdict.ineligible !== "setting-up" &&
      verdict.ineligible !== "provider",
  );
  const onTheirWay = input.verdicts.some(
    (verdict) => verdict.ineligible === "setting-up" || verdict.ineligible === "offline",
  );
  if (readyFor.length === 0 && !onTheirWay && !input.pinned) return { kind: "no-ready-worker" };
  if (readyFor.length > 0 && readyFor.every((verdict) => verdict.ineligible === "too-big")) {
    const first = readyFor[0]!;
    return {
      kind: "too-big",
      dimension: first.dimension ?? "cpu",
      workerId: input.pinned ? first.workerId : null,
    };
  }
  const counts = new Map<Exclude<PlacementIneligibility, "too-big">, number>();
  for (const verdict of input.verdicts) {
    if (verdict.ineligible === null || verdict.ineligible === "too-big") continue;
    counts.set(verdict.ineligible, (counts.get(verdict.ineligible) ?? 0) + 1);
  }
  let best: Exclude<PlacementIneligibility, "too-big"> | null = null;
  for (const reason of QUEUED_ORDER) {
    const count = counts.get(reason) ?? 0;
    if (count > 0 && (best === null || count > counts.get(best)!)) best = reason;
  }
  if (best === null) return { kind: "no-ready-worker" };
  const subject = input.verdicts.find((verdict) => verdict.ineligible === best);
  return {
    kind: "queued",
    reason: best,
    workerId: subject?.workerId ?? null,
    ...(subject?.dimension === undefined ? {} : { dimension: subject.dimension }),
  };
}

/** The board server is a candidate only with build capacity declared. */
export const localIsBuildCandidate = (declared: BoardResourceProfile | null): boolean =>
  declared === null || declared.cpuCores > 0 || declared.ramGiB > 0;

/**
 * The facts for one worker, from the board's worker summary (status and checkouts, through
 * `boardPlacementGate`'s answer) and its last capacity snapshot, less this pass's grants. A
 * readiness or provider the snapshot doesn't name is left to the worker's own claim to refuse.
 */
export function placementFacts(input: {
  readonly workerId: BoardWorkerId;
  readonly label: string;
  readonly gate: "ready" | "offline" | "needs-update" | "no-checkout" | "provider-missing";
  readonly snapshot: BoardWorkerCapacitySnapshot | null;
  readonly repositoryKey: string | null;
  readonly projectId: string;
  readonly providerInstanceId: string | null;
  readonly granted: BoardResourceProfile | null;
  readonly closed: boolean;
}): PlacementWorkerFacts {
  const snapshot = input.snapshot;
  const readinessEntry =
    snapshot?.readiness.find((entry) =>
      boardReadinessIsFor(entry, input.repositoryKey, input.projectId),
    ) ?? null;
  const readiness: PlacementWorkerFacts["readiness"] =
    readinessEntry === null || readinessEntry.state === "ready"
      ? "ready"
      : readinessEntry.state === "cloning" || readinessEntry.state === "checking"
        ? "pending"
        : "failed";
  const provider =
    input.providerInstanceId === null
      ? undefined
      : snapshot?.providers.find((candidate) => candidate.instanceId === input.providerInstanceId);
  const headroom =
    snapshot === null
      ? null
      : input.granted === null
        ? snapshot.headroom
        : {
            cpuCores: snapshot.headroom.cpuCores - input.granted.cpuCores,
            ramGiB: snapshot.headroom.ramGiB - input.granted.ramGiB,
            diskGB: snapshot.headroom.diskGB - input.granted.diskGB,
          };
  return {
    workerId: input.workerId,
    label: input.label,
    online: input.gate !== "offline",
    atFloor: input.gate !== "needs-update",
    hasCheckout: input.gate !== "no-checkout",
    readiness,
    providerSignedIn:
      input.gate !== "provider-missing" && provider?.account.status !== "signed-out",
    quotaRoom:
      provider === undefined ||
      (!provider.quota.exhausted &&
        !provider.quota.windows.some((window) => window.gating && window.nearLimit === true)),
    closed: input.closed,
    declared: snapshot?.declared ?? null,
    headroom,
    over: snapshot?.over ?? null,
  };
}

/**
 * Successful Building steps of this board's cards on the same repository, with the worker each
 * ran on (its thread link's worker). Reviews and CI never count: only the build stage's step.
 */
export function boardBuildHistory(input: {
  readonly board: Pick<BoardState, "cards" | "stepCompletions">;
  readonly buildStageId: string | null;
  readonly sameRepository: (projectId: BoardCard["projectId"]) => boolean;
}): ReadonlyArray<{ readonly workerId: BoardWorkerId; readonly at: number }> {
  if (input.buildStageId === null) return [];
  const builds: Array<{ readonly workerId: BoardWorkerId; readonly at: number }> = [];
  for (const completion of input.board.stepCompletions ?? []) {
    if (completion.stepId !== input.buildStageId || completion.outcome !== "succeeded") continue;
    const card = input.board.cards.find((candidate) => candidate.id === completion.cardId);
    if (card === undefined || !input.sameRepository(card.projectId)) continue;
    const link =
      completion.threadId === null
        ? undefined
        : card.threadLinks.find((candidate) => candidate.threadId === completion.threadId);
    const at = Date.parse(completion.completedAt);
    if (Number.isNaN(at)) continue;
    builds.push({ workerId: link?.workerId ?? BOARD_LOCAL_WORKER_ID, at });
  }
  return builds;
}
