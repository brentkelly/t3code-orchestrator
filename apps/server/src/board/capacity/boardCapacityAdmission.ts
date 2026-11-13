/**
 * How the supervisor uses worker-owned capacity (T3O-86): placement and grow claims, the
 * phase rule that releases a card's CPU and RAM, settling, and `syncCards`.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  BOARD_RESOURCE_DIMENSIONS,
  boardResourceProfileValue,
  boardStepWaitsForRoom,
  boardCardEffectiveWorkerId,
  boardCardRequestedProfile,
  boardProjectStageConfig,
  boardResourceProfileOverflow,
  boardStageWithRole,
  type BoardCard,
  type BoardCardId,
  type BoardCardStepState,
  type BoardCommand,
  type BoardResourceDimension,
  type BoardResourceProfile,
  type BoardState,
  type BoardStepQueuedBy,
  type BoardStepQueuedDetail,
  type BoardSyncedCard,
  type BoardWorkerCapacitySnapshot,
  type BoardWorkerId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { BoardCapacityClientShape, BoardClaimAnswer } from "./BoardCapacityClient.ts";

/** After a claim goes unanswered, the worker's other claims skip it this long. */
export const UNREACHABLE_BACKOFF_MS = 30_000;
const UNSTARTED_TURN_LAPSE_MS = 6 * 60 * 60_000;

/** A card stays heavy this long after its last activity ended. */
export const HEAVY_TAIL_MS = 10 * 60_000;
/** A grant settles this long after placement even if no heavy step has ended. */
export const SETTLE_AFTER_MS = 2 * 60 * 60_000;

/** Why a step waits, in the step's own terms. */
export interface CapacityHold {
  readonly queuedBy: BoardStepQueuedBy;
  readonly detail: BoardStepQueuedDetail | null;
  /** A capacity denial on this worker ends this board's placements there for the pass. */
  readonly blocksWorker: boolean;
}

export type PlacementDecision =
  | { readonly kind: "none" }
  | {
      readonly kind: "granted";
      readonly claimId: string;
      readonly profile: BoardResourceProfile;
    }
  | { readonly kind: "held"; readonly hold: CapacityHold }
  | { readonly kind: "unavailable" };

const DEFAULT_TIMESTAMP = 0;

/** A step running or finishing in its worktree. Waiting on a human, paused or stalled is not;
    a step waiting on its own background work stays `running`, so it counts. */
export const stepActiveInWorktree = (state: BoardCardStepState | null) =>
  state !== null &&
  state.mode === "build" &&
  (state.status === "running" || state.status === "completing");

/** A build-mode step queued for its worktree: it keeps a granted heavy phase. */
export const stepQueuedInWorktree = (state: BoardCardStepState | null) =>
  state !== null &&
  state.mode === "build" &&
  (state.status === "queued" || state.status === "pending");

const ciActive = (card: BoardCard) =>
  card.ci !== null && (card.ci.phase === "queued" || card.ci.phase === "running");

/**
 * Whether a card should hold its CPU and RAM: active (a step running in its worktree, a CI
 * pass, a setup run), within ten minutes of the last activity, or queued while already heavy.
 * A queued step never makes a light card heavy; only a grow does.
 */
export function desiredHeavy(input: {
  readonly card: BoardCard;
  readonly state: BoardCardStepState | null;
  readonly active: boolean;
  readonly lastActiveAt: number | null;
  readonly now: number;
}): boolean {
  if (input.active) return true;
  const heavy = input.card.resources?.grant?.heavy === true;
  if (heavy && stepQueuedInWorktree(input.state)) return true;
  return input.lastActiveAt !== null && input.now - input.lastActiveAt < HEAVY_TAIL_MS;
}

/** The worker a card's worktree is on, or would be cut on. */
const cardWorkerOf = (board: BoardState, card: BoardCard): BoardWorkerId =>
  boardCardEffectiveWorkerId(card, board.defaultWorkerId);

/** The card's reservation if it were placed now. */
export const requestedProfileOf = (board: BoardState, card: BoardCard) =>
  boardCardRequestedProfile(
    card.resources,
    boardProjectStageConfig(board, card.projectId)?.resources ?? null,
  );

/** Too big: a card with no worktree whose profile exceeds its worker's declared capacity. */
export function tooBigDimension(
  profile: BoardResourceProfile,
  snapshot: BoardWorkerCapacitySnapshot | null,
): BoardResourceDimension | null {
  if (snapshot === null) return null;
  return boardResourceProfileOverflow(profile, snapshot.declared);
}

/** What the local filter says before any claim: fits, or the dimension that doesn't. */
export function headroomShortfall(
  profile: BoardResourceProfile,
  snapshot: BoardWorkerCapacitySnapshot | null,
): BoardResourceDimension | null {
  if (snapshot === null) return null;
  if (snapshot.over.cpuRam) return "cpu";
  if (snapshot.over.disk) return "disk";
  return boardResourceProfileOverflow(profile, snapshot.headroom);
}

const isGroup = (card: BoardCard) => card.group !== null;

/** The board's granted state for one worker: every card with a worktree there that is
    provisioning or ready and holds a grant. Group cards take no claim and send nothing. */
export function syncEntriesFor(input: {
  readonly board: BoardState;
  readonly workerId: BoardWorkerId;
  readonly repositoryKey: (projectId: ProjectId) => string | null;
}): ReadonlyArray<BoardSyncedCard> {
  const buildStage = boardStageWithRole(input.board, "build");
  const entries: BoardSyncedCard[] = [];
  for (const card of input.board.cards) {
    if (isGroup(card) || card.worktree === null) continue;
    if (card.worktree.status !== "provisioning" && card.worktree.status !== "ready") continue;
    const grant = card.resources?.grant ?? null;
    if (grant === null) continue;
    const at = card.placedWorkerId ?? cardWorkerOf(input.board, card);
    if (at !== input.workerId) continue;
    const builtOnce =
      buildStage !== null &&
      (input.board.stepCompletions ?? []).some(
        (completion) =>
          completion.cardId === card.id &&
          completion.stepId === buildStage.stageId &&
          completion.outcome === "succeeded",
      );
    entries.push({
      cardId: card.id,
      repositoryKey: input.repositoryKey(card.projectId),
      branch: card.worktree.branch,
      worktreePath: card.worktree.path,
      grantedProfile: grant.profile,
      phase: grant.heavy ? "heavy" : "light",
      settled: grant.settled,
      ...(builtOnce ? { builtOnce: true } : {}),
    });
  }
  return entries;
}

/** The hold a claim denial puts on a step. */
export function holdForDenial(
  answer: {
    readonly reason: string;
    readonly dimension?: BoardResourceDimension;
  },
  workerId: BoardWorkerId,
  kind: "placement" | "grow",
): CapacityHold {
  switch (answer.reason) {
    case "quota":
      return { queuedBy: "quota", detail: { workerId }, blocksWorker: false };
    case "not-ready":
      return { queuedBy: "setup", detail: { workerId }, blocksWorker: false };
    default:
      return {
        queuedBy: "capacity",
        detail: {
          workerId,
          ...(answer.dimension === undefined ? {} : { dimension: answer.dimension }),
        },
        blocksWorker: kind === "placement" && answer.reason === "capacity",
      };
  }
}

export interface BoardCapacityAdmissionDeps {
  readonly client: BoardCapacityClientShape;
  readonly readBoard: Effect.Effect<BoardState>;
  readonly dispatch: (command: BoardCommand) => Effect.Effect<boolean>;
  readonly commandId: (tag: string) => Effect.Effect<BoardCommand["commandId"]>;
  readonly nowIso: Effect.Effect<string>;
  readonly repositoryKey: (projectId: ProjectId) => Effect.Effect<string | null>;
  /** Whether a running step's thread is held on a permission prompt (thread shell). */
  readonly awaitingPermission: (state: BoardCardStepState) => Effect.Effect<boolean>;
}

export const makeBoardCapacityAdmission = (deps: BoardCapacityAdmissionDeps) => {
  /** When each card was last active; a card first seen idle starts its tail now. */
  const lastActive = new Map<string, number>();
  /** A fresh claim id per card after a definite denial; the same id on a retry. */
  const claimNonce = new Map<string, number>();
  /** Turns the board didn't start, by thread, until they end. */
  const unstartedTurns = new Map<
    string,
    { readonly cardId: BoardCardId; readonly since: number }
  >();
  /** A turn or a setup running in the card's worktree outside its step keeps it active. */
  const busyOutsideStep = (card: BoardCard, now: number) => {
    if (card.resources?.setup?.status === "running") return true;
    for (const [threadId, turn] of unstartedTurns) {
      // A turn whose end never reached the board (a deleted thread) lapses.
      if (now - turn.since >= UNSTARTED_TURN_LAPSE_MS) unstartedTurns.delete(threadId);
      else if (turn.cardId === card.id) return true;
    }
    return false;
  };

  const nowMs = Effect.map(deps.nowIso, (iso) => Date.parse(iso));
  // A worker that just left a claim unanswered costs the serial pass one timeout, not one
  // per candidate: until the backoff passes, its claims answer unavailable at once.
  const unreachableUntil = new Map<BoardWorkerId, number>();
  const backingOff = (workerId: BoardWorkerId) =>
    Effect.map(nowMs, (now) => (unreachableUntil.get(workerId) ?? 0) > now);
  const noteReach = (workerId: BoardWorkerId, reached: boolean) =>
    Effect.map(nowMs, (now) => {
      if (reached) unreachableUntil.delete(workerId);
      else unreachableUntil.set(workerId, now + UNREACHABLE_BACKOFF_MS);
    });
  const claimOn = Effect.fn("BoardCapacityAdmission.claimOn")(function* (
    workerId: BoardWorkerId,
    input: Parameters<BoardCapacityClientShape["claim"]>[1],
  ) {
    if (yield* backingOff(workerId)) return { outcome: "unavailable" } as BoardClaimAnswer;
    const answer = yield* deps.client.claim(workerId, input);
    yield* noteReach(workerId, answer.outcome !== "unavailable");
    return answer;
  });

  const claimIdFor = (card: BoardCard) => {
    const attempt = (card.worktree?.attempts ?? 0) + 1;
    return `${card.id}:${attempt}:${claimNonce.get(card.id) ?? 0}`;
  };
  const freshClaimId = (cardId: BoardCardId) =>
    claimNonce.set(cardId, (claimNonce.get(cardId) ?? 0) + 1);

  const repositoryKeys = Effect.fn("BoardCapacityAdmission.repositoryKeys")(function* (
    board: BoardState,
  ) {
    const keys = new Map<string, string | null>();
    for (const card of board.cards) {
      if (!keys.has(card.projectId))
        keys.set(card.projectId, yield* deps.repositoryKey(card.projectId));
    }
    return (projectId: ProjectId) => keys.get(projectId) ?? null;
  });

  /** Send each worker the board's granted state for it, when it changed. */
  const syncWorker = Effect.fn("BoardCapacityAdmission.syncWorker")(function* (
    workerId: BoardWorkerId,
  ) {
    // A worker that just left a call unanswered isn't asked again until the backoff passes.
    if (yield* backingOff(workerId)) return yield* deps.client.synced(workerId);
    const board = yield* deps.readBoard;
    const keys = yield* repositoryKeys(board);
    const synced = yield* deps.client.syncCards(
      workerId,
      syncEntriesFor({ board, workerId, repositoryKey: keys }),
    );
    if (!synced) yield* noteReach(workerId, false);
    return synced;
  });

  const workersOf = (board: BoardState): ReadonlyArray<BoardWorkerId> => [
    BOARD_LOCAL_WORKER_ID,
    ...(board.workers ?? []).map((worker) => worker.id),
  ];

  const syncAll = Effect.fn("BoardCapacityAdmission.syncAll")(function* () {
    const board = yield* deps.readBoard;
    for (const workerId of workersOf(board)) yield* syncWorker(workerId);
  });

  /** A placement claim, immediately before the card's provision is dispatched. */
  const placementClaim = Effect.fn("BoardCapacityAdmission.placementClaim")(function* (
    card: BoardCard,
    workerId: BoardWorkerId,
    providerInstanceId: string | null,
    force: boolean,
  ) {
    if (isGroup(card)) return { kind: "none" } as PlacementDecision;
    if (!(yield* deps.client.synced(workerId)) && !(yield* syncWorker(workerId))) {
      return { kind: "unavailable" } as PlacementDecision;
    }
    const board = yield* deps.readBoard;
    const profile = requestedProfileOf(board, card);
    const claimId = claimIdFor(card);
    const answer = yield* claimOn(workerId, {
      claimId,
      cardId: card.id,
      repositoryKey: yield* deps.repositoryKey(card.projectId),
      kind: "placement",
      profile,
      providerInstanceId,
      ...(force ? { force: true } : {}),
    });
    if (answer.outcome === "unavailable") return { kind: "unavailable" } as PlacementDecision;
    if (answer.outcome === "denied") {
      freshClaimId(card.id);
      return {
        kind: "held",
        hold: holdForDenial(answer, workerId, "placement"),
      } as PlacementDecision;
    }
    return { kind: "granted", claimId, profile } as PlacementDecision;
  });

  /**
   * Before a step on a placed card: a heavy grant needs nothing; a light one takes a grow
   * claim at the profile it was granted. Null when the step may go ahead, else its hold.
   */
  const ensureHeavy = Effect.fn("BoardCapacityAdmission.ensureHeavy")(function* (
    card: BoardCard,
    providerInstanceId: string | null,
    force: boolean,
  ) {
    if (isGroup(card)) return null;
    const grant = card.resources?.grant ?? null;
    lastActive.set(card.id, yield* nowMs);
    if (grant?.heavy === true) return null;
    const board = yield* deps.readBoard;
    const workerId = card.placedWorkerId ?? cardWorkerOf(board, card);
    if (!(yield* deps.client.synced(workerId)) && !(yield* syncWorker(workerId))) {
      return {
        queuedBy: "worker-offline",
        detail: { workerId },
        blocksWorker: false,
      } as CapacityHold;
    }
    const profile = grant?.profile ?? requestedProfileOf(board, card);
    const answer = yield* claimOn(workerId, {
      claimId: `${card.id}:grow:${yield* nowMs}`,
      cardId: card.id,
      repositoryKey: yield* deps.repositoryKey(card.projectId),
      kind: "grow",
      profile,
      providerInstanceId,
      ...(force ? { force: true } : {}),
    });
    if (answer.outcome === "unavailable") {
      return {
        queuedBy: "worker-offline",
        detail: { workerId },
        blocksWorker: false,
      } as CapacityHold;
    }
    if (answer.outcome === "denied") return holdForDenial(answer, workerId, "grow");
    yield* deps.dispatch({
      type: "board.card.record-grant",
      commandId: yield* deps.commandId("grow"),
      cardId: card.id,
      profile,
      heavy: true,
      createdAt: yield* deps.nowIso,
    });
    // The sync that lists the card heavy consumes the grow.
    yield* syncWorker(workerId);
    return null;
  });

  /** A turn the board didn't start (a human's message, an answer, an approval, the engine's
      own limit resume): the card is heavy with no claim, and may run over, visibly. */
  const recordUnstartedTurn = Effect.fn("BoardCapacityAdmission.recordUnstartedTurn")(function* (
    cardId: BoardCardId,
    threadId: string,
  ) {
    const board = yield* deps.readBoard;
    const card = board.cards.find((candidate) => candidate.id === cardId);
    if (card === undefined || isGroup(card)) return;
    const now = yield* nowMs;
    lastActive.set(card.id, now);
    unstartedTurns.set(threadId, { cardId: card.id, since: now });
    const grant = card.resources?.grant ?? null;
    if (grant === null || grant.heavy) return;
    yield* deps.dispatch({
      type: "board.card.record-grant",
      commandId: yield* deps.commandId("unstarted-turn"),
      cardId: card.id,
      heavy: true,
      createdAt: yield* deps.nowIso,
    });
    yield* syncWorker(card.placedWorkerId ?? cardWorkerOf(board, card));
  });

  /**
   * A size or baseline change reaches a placed card's grant: a shrink applies at once, an
   * increase on a heavy card is a background grow, retried each pass until granted, and never
   * queues a step. A light card's CPU and RAM are claimed when it next goes heavy. A settled
   * record's disk is never regrown, and no grow is asked above the worker's declared capacity.
   */
  const resizeGrants = Effect.fn("BoardCapacityAdmission.resizeGrants")(function* () {
    const board = yield* deps.readBoard;
    for (const card of board.cards) {
      const grant = card.resources?.grant ?? null;
      if (grant === null || card.archivedAt !== null || isGroup(card)) continue;
      const requested = requestedProfileOf(board, card);
      const want: BoardResourceProfile = {
        ...requested,
        diskGB: grant.settled ? Math.min(requested.diskGB, grant.profile.diskGB) : requested.diskGB,
      };
      const shrunk: BoardResourceProfile = {
        cpuCores: Math.min(want.cpuCores, grant.profile.cpuCores),
        ramGiB: Math.min(want.ramGiB, grant.profile.ramGiB),
        diskGB: Math.min(want.diskGB, grant.profile.diskGB),
      };
      const grows = BOARD_RESOURCE_DIMENSIONS.some(
        (dimension) =>
          boardResourceProfileValue(want, dimension) >
          boardResourceProfileValue(grant.profile, dimension),
      );
      const workerId = card.placedWorkerId ?? cardWorkerOf(board, card);
      if (grows && grant.heavy) {
        const declared = (yield* deps.client.latest(workerId))?.declared ?? null;
        const fits =
          declared !== null &&
          BOARD_RESOURCE_DIMENSIONS.every(
            (dimension) =>
              boardResourceProfileValue(want, dimension) <=
              boardResourceProfileValue(declared, dimension),
          );
        if (fits) {
          const answer = yield* claimOn(workerId, {
            claimId: `${card.id}:grow:${yield* nowMs}`,
            cardId: card.id,
            repositoryKey: yield* deps.repositoryKey(card.projectId),
            kind: "grow",
            profile: want,
            providerInstanceId: null,
          });
          if (answer.outcome === "granted") {
            yield* deps.dispatch({
              type: "board.card.record-grant",
              commandId: yield* deps.commandId("resize"),
              cardId: card.id,
              profile: want,
              createdAt: yield* deps.nowIso,
            });
            yield* syncWorker(workerId);
            continue;
          }
        }
      }
      // A light card holds no CPU or RAM: its larger profile is what its next grow claims.
      const next = grows && !grant.heavy ? want : shrunk;
      if (
        BOARD_RESOURCE_DIMENSIONS.every(
          (dimension) =>
            boardResourceProfileValue(next, dimension) ===
            boardResourceProfileValue(grant.profile, dimension),
        )
      ) {
        continue;
      }
      yield* deps.dispatch({
        type: "board.card.record-grant",
        commandId: yield* deps.commandId("resize"),
        cardId: card.id,
        profile: next,
        createdAt: yield* deps.nowIso,
      });
      yield* syncWorker(workerId);
    }
  });

  /** A turn the board didn't start ended: the card's ten-minute tail starts now. */
  const noteTurnEnded = Effect.fn("BoardCapacityAdmission.noteTurnEnded")(function* (
    threadId: string,
  ) {
    const turn = unstartedTurns.get(threadId);
    if (turn === undefined) return;
    unstartedTurns.delete(threadId);
    lastActive.set(turn.cardId, yield* nowMs);
  });

  /** A step ended: the ten-minute tail starts, and a card's first heavy step settles it. */
  const noteStepEnded = Effect.fn("BoardCapacityAdmission.noteStepEnded")(function* (
    state: BoardCardStepState,
  ) {
    if (state.mode !== "build") return;
    lastActive.set(state.cardId, yield* nowMs);
    const board = yield* deps.readBoard;
    const card = board.cards.find((candidate) => candidate.id === state.cardId);
    const grant = card?.resources?.grant ?? null;
    if (card === undefined || grant === null || grant.settled) return;
    yield* deps.dispatch({
      type: "board.card.record-grant",
      commandId: yield* deps.commandId("settle"),
      cardId: card.id,
      settled: true,
      createdAt: yield* deps.nowIso,
    });
  });

  /**
   * The periodic pass: settle grants two hours old, release the CPU and RAM of cards idle
   * past their ten-minute tail, cut the tail short for idle cards on a worker one of this
   * board's steps waits on for capacity, and keep every worker's records in step.
   */
  const sweep = Effect.fn("BoardCapacityAdmission.sweep")(function* () {
    const board = yield* deps.readBoard;
    const now = yield* nowMs;
    const stateOf = (cardId: BoardCardId) =>
      (board.stepStates ?? []).find((state) => state.cardId === cardId) ?? null;
    const waitingWorkers = new Set(
      (board.stepStates ?? [])
        .filter(boardStepWaitsForRoom)
        .map((state) => state.queuedDetail!.workerId!),
    );
    const idle: Array<{ readonly card: BoardCard; readonly since: number }> = [];
    for (const card of board.cards) {
      const grant = card.resources?.grant ?? null;
      if (grant === null || card.archivedAt !== null) continue;
      const state = stateOf(card.id);
      let active = stepActiveInWorktree(state) || ciActive(card) || busyOutsideStep(card, now);
      if (active && state !== null && state.status === "running") {
        // Held on a permission prompt: the engine keeps the turn open, but nothing runs.
        if (yield* deps.awaitingPermission(state)) active = false;
      }
      if (active) lastActive.set(card.id, now);
      if (!lastActive.has(card.id)) lastActive.set(card.id, now);
      if (!grant.settled && now - Date.parse(grant.grantedAt) >= SETTLE_AFTER_MS) {
        yield* deps.dispatch({
          type: "board.card.record-grant",
          commandId: yield* deps.commandId("settle"),
          cardId: card.id,
          settled: true,
          createdAt: yield* deps.nowIso,
        });
      }
      if (!grant.heavy) continue;
      const heavy = desiredHeavy({
        card,
        state,
        active,
        lastActiveAt: lastActive.get(card.id) ?? null,
        now,
      });
      const nothingPending = !active && !stepQueuedInWorktree(state);
      const workerId = card.placedWorkerId ?? cardWorkerOf(board, card);
      if (!heavy) {
        yield* release(card);
      } else if (nothingPending && waitingWorkers.has(workerId)) {
        idle.push({ card, since: lastActive.get(card.id) ?? now });
      }
    }
    // Longest idle first; only idle cards, so two waiting cards never evict each other.
    // One release per pass per worker: the snapshot that follows says whether it was enough.
    const released = new Set<BoardWorkerId>();
    for (const { card } of idle.sort((left, right) => left.since - right.since)) {
      const workerId = card.placedWorkerId ?? cardWorkerOf(board, card);
      if (released.has(workerId)) continue;
      released.add(workerId);
      yield* release(card);
    }
    yield* syncAll();
  });

  /**
   * The cut-short, read off the board alone, at the start of every scheduling pass: when one
   * of this board's steps waits on capacity on a worker, its idle heavy cards there (nothing
   * active or queued) go light, longest idle first, so a parked or finished card's room
   * reaches the queue within a beat rather than ten minutes later.
   */
  const releaseForWaiting = Effect.fn("BoardCapacityAdmission.releaseForWaiting")(function* () {
    const board = yield* deps.readBoard;
    const states = board.stepStates ?? [];
    // Every pass first tells each worker what the board holds there: a card deleted or
    // reclaimed since gives its room back at once. Unchanged state sends nothing.
    yield* syncAll();
    // Only a wait room could end: a Too-big card never fits, and one queued behind another
    // waits on that card, so neither may evict an idle card's tail.
    const waitingSteps = states.filter(boardStepWaitsForRoom);
    const waiting = new Set<BoardWorkerId>(
      waitingSteps.map((state) => state.queuedDetail!.workerId!),
    );
    // A CI pass waiting for its card to grow counts too.
    const waitingCi = board.cards.filter(
      (card) => card.archivedAt === null && card.ci?.phase === "queued",
    );
    for (const card of waitingCi) waiting.add(card.placedWorkerId ?? cardWorkerOf(board, card));
    if (waiting.size === 0) return false;
    const now = yield* nowMs;
    const idle: Array<{ readonly card: BoardCard; readonly since: number }> = [];
    for (const card of board.cards) {
      const grant = card.resources?.grant ?? null;
      if (grant === null || !grant.heavy || card.archivedAt !== null) continue;
      const workerId = card.placedWorkerId ?? cardWorkerOf(board, card);
      if (!waiting.has(workerId)) continue;
      const state = states.find((candidate) => candidate.cardId === card.id) ?? null;
      if (
        stepActiveInWorktree(state) ||
        stepQueuedInWorktree(state) ||
        ciActive(card) ||
        busyOutsideStep(card, now)
      ) {
        continue;
      }
      idle.push({ card, since: lastActive.get(card.id) ?? now });
    }
    // Per worker, release until the first waiting step's profile fits what is offered.
    let released = 0;
    for (const workerId of waiting) {
      const first = waitingSteps.find((state) => state.queuedDetail?.workerId === workerId);
      const firstCard =
        board.cards.find((card) => card.id === first?.cardId) ??
        waitingCi.find((card) => (card.placedWorkerId ?? cardWorkerOf(board, card)) === workerId);
      if (firstCard === undefined) continue;
      const need = firstCard.resources?.grant?.profile ?? requestedProfileOf(board, firstCard);
      const snapshot = yield* deps.client.latest(workerId);
      let freeCpu = snapshot?.headroom.cpuCores ?? 0;
      let freeRam = snapshot?.headroom.ramGiB ?? 0;
      const onWorker = idle
        .filter(({ card }) => (card.placedWorkerId ?? cardWorkerOf(board, card)) === workerId)
        .sort((left, right) => left.since - right.since);
      for (const { card } of onWorker) {
        if (freeCpu >= need.cpuCores && freeRam >= need.ramGiB) break;
        const profile = card.resources!.grant!.profile;
        yield* release(card);
        released += 1;
        freeCpu += profile.cpuCores;
        freeRam += profile.ramGiB;
      }
    }
    if (released === 0) return false;
    yield* syncAll();
    return true;
  });

  const release = Effect.fn("BoardCapacityAdmission.release")(function* (card: BoardCard) {
    yield* deps.dispatch({
      type: "board.card.record-grant",
      commandId: yield* deps.commandId("release-heavy"),
      cardId: card.id,
      heavy: false,
      createdAt: yield* deps.nowIso,
    });
  });

  return {
    placementClaim,
    ensureHeavy,
    recordUnstartedTurn,
    noteTurnEnded,
    resizeGrants,
    noteStepEnded,
    sweep,
    releaseForWaiting,
    syncWorker,
    syncAll,
    /** Test access: the tail's clock per card. */
    lastActive: (cardId: BoardCardId) => lastActive.get(cardId) ?? DEFAULT_TIMESTAMP,
  };
};

export type BoardCapacityAdmission = ReturnType<typeof makeBoardCapacityAdmission>;
