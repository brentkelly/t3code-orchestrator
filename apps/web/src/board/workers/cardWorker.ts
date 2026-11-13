/**
 * The copy for a card's worker field, chip, picker, queue reasons and move
 * notices. None show on a single-worker board. The chip never takes a status
 * colour; worker trouble goes in the card's notice slot.
 */
import {
  boardReadinessIsFor,
  BOARD_LOCAL_WORKER_ID,
  BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION,
  resolveBoardWorkerCheckout,
  type BoardCard,
  type BoardCardShell,
  type BoardStepQueuedBy,
  type BoardWorkerCapacitySnapshot,
  type BoardWorkerId,
  type BoardWorkersState,
  type BoardWorkerSetup,
  type BoardWorkerView,
  type ProjectId,
  type ServerProvider,
} from "@t3tools/contracts";

import { localWorkerLabel } from "./threadWorker";
import { clockTime } from "./workerCopy";

/** Whether the board has workers to choose between. */
export function boardShowsWorkers(state: BoardWorkersState): boolean {
  return state.workers.length > 0;
}

/** A worker's name: "This server", or its label. */
export function boardWorkerLabel(workerId: BoardWorkerId, state: BoardWorkersState): string {
  if (workerId === BOARD_LOCAL_WORKER_ID) return localWorkerLabel(state);
  return state.workers.find((worker) => worker.id === workerId)?.label ?? workerId;
}

/** Where a card runs, as its shell says: its bound worker (a pin, or where it holds a
    worktree), else the board server. T3o: there is no default worker (T3O-87). */
function boardCardWorker(
  card: Pick<BoardCardShell, "workerId">,
  _state: BoardWorkersState,
): { readonly workerId: BoardWorkerId; readonly bound: boolean } {
  return card.workerId === undefined
    ? { workerId: BOARD_LOCAL_WORKER_ID, bound: false }
    : { workerId: card.workerId, bound: true };
}

export interface BoardCardWorkerChip {
  readonly label: string;
  /** T3o: a server icon once placed, a pin icon while only pinned (T3O-87). */
  readonly kind: "placed" | "pinned";
  readonly tooltip: string;
}

/** The meta row's worker chip, or null on a one-worker board or before the card is placed
    or pinned. */
export function boardCardWorkerChip(
  card: Pick<BoardCardShell, "workerId" | "worktreeReady">,
  state: BoardWorkersState,
): BoardCardWorkerChip | null {
  if (!boardShowsWorkers(state) || card.workerId === undefined) return null;
  const name = boardWorkerLabel(card.workerId, state);
  const placed = card.worktreeReady === true;
  return {
    label: card.workerId === BOARD_LOCAL_WORKER_ID ? "local" : name,
    kind: placed ? "placed" : "pinned",
    tooltip: placed ? `Placed on ${name}` : `Pinned to ${name}: its builds run there`,
  };
}

const round = (value: number) => Math.round(value * 10) / 10;

/** A worker's load as its latest capacity snapshot says: "2 agents · 6 cores, 24 GiB free". */
export function boardWorkerLoadLabel(snapshot: BoardWorkerCapacitySnapshot | undefined): string {
  if (snapshot === undefined) return "No capacity report yet";
  if (snapshot.over.cpuRam) return "Full · will queue";
  const { running } = snapshot.agents;
  const cpu = round(Math.max(0, snapshot.headroom.cpuCores));
  const ram = round(Math.max(0, snapshot.headroom.ramGiB));
  return `${running} ${running === 1 ? "agent" : "agents"} · ${cpu} cores, ${ram} GiB free`;
}

export interface BoardWorkerChoice {
  readonly workerId: BoardWorkerId;
  readonly label: string;
  readonly selectable: boolean;
  /** The row's right-hand text: load, or why it can't be picked. */
  readonly detail: string;
  /** Why the row is disabled, for its tooltip. */
  readonly tooltip: string | null;
  /** The worker has no checkout of the project and can be given one. */
  readonly canSetUp: boolean;
  /** A clone of the project is running there. */
  readonly cloning: boolean;
}

/** The checkout setup on a worker for a central project, if any. */
function setupOf(
  state: BoardWorkersState,
  workerId: BoardWorkerId,
  projectId: ProjectId,
): BoardWorkerSetup | null {
  return (
    state.setups.find((setup) => setup.workerId === workerId && setup.projectId === projectId) ??
    null
  );
}

/** Whether a worker has a checkout of a project (this server always does). */
function boardWorkerHasCheckout(
  worker: BoardWorkerView,
  projectRepositoryKey: string | null,
): boolean {
  return (
    resolveBoardWorkerCheckout(projectRepositoryKey, worker.snapshot?.checkouts ?? []) !== null
  );
}

/**
 * The Pin to rows (prototype 4.2): every worker, `local` first, each with its
 * load or the reason it can't be picked. A worker cloning the project can be
 * picked — the card waits, "Queued · setting up" — and one without a checkout
 * offers Set up on worker.
 */
export function boardWorkerChoices(input: {
  readonly state: BoardWorkersState;
  readonly projectId: ProjectId;
  readonly projectRepositoryKey: string | null;
  /** The project's short name, as the rows say it ("advisor"). */
  readonly projectName: string;
  /** Each worker's latest capacity snapshot, from the capacity stream. */
  readonly capacity: ReadonlyMap<string, BoardWorkerCapacitySnapshot>;
}): ReadonlyArray<BoardWorkerChoice> {
  const load = (workerId: BoardWorkerId) => boardWorkerLoadLabel(input.capacity.get(workerId));
  const local: BoardWorkerChoice = {
    workerId: BOARD_LOCAL_WORKER_ID,
    label: `${localWorkerLabel(input.state)} (local)`,
    selectable: true,
    detail: load(BOARD_LOCAL_WORKER_ID),
    tooltip: null,
    canSetUp: false,
    cloning: false,
  };
  const rows = input.state.workers.map((worker): BoardWorkerChoice => {
    const base = { workerId: worker.id, label: worker.label, canSetUp: false, cloning: false };
    switch (worker.status.state) {
      case "incompatible":
        return {
          ...base,
          selectable: false,
          detail: `Needs T3o ${BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION}+`,
          tooltip: `${worker.label} runs T3o ${worker.status.t3oVersion ?? "an older version"}; this board needs ${BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION} or newer.`,
        };
      case "offline":
        return {
          ...base,
          selectable: false,
          detail: "Offline",
          tooltip: `${worker.label} is offline. Pin it once it reconnects.`,
        };
      case "connecting":
      case "unauthorized":
        return {
          ...base,
          selectable: false,
          detail: "Reconnecting",
          tooltip: `${worker.label} is reconnecting. Pin it once it's connected.`,
        };
      case "online":
        break;
    }
    const setup = setupOf(input.state, worker.id, input.projectId);
    if (boardWorkerHasCheckout(worker, input.projectRepositoryKey)) {
      const readiness = input.capacity
        .get(worker.id)
        ?.readiness.find((entry) =>
          boardReadinessIsFor(entry, input.projectRepositoryKey, input.projectId),
        );
      // A worker can't be a project's pin until it is ready for it; the server refuses it too.
      return readiness === undefined || readiness.state === "ready"
        ? { ...base, selectable: true, detail: load(worker.id), tooltip: null }
        : {
            ...base,
            selectable: false,
            detail:
              readiness.state === "checking"
                ? `Checking ${input.projectName}`
                : `Not ready for ${input.projectName}`,
            tooltip:
              readiness.state === "checking"
                ? `${worker.label} is checking it's ready for ${input.projectName}. Pin it once the check passes.`
                : `${worker.label}'s readiness check for ${input.projectName} fails. Re-check it on the Workers page, then pin it.`,
          };
    }
    if (setup?.phase === "cloning") {
      return {
        ...base,
        selectable: true,
        cloning: true,
        detail: `Cloning ${input.projectName}${setup.percent === null ? "" : ` · ${setup.percent}%`}`,
        tooltip: `The card waits until ${input.projectName} finishes cloning on ${worker.label}.`,
      };
    }
    return {
      ...base,
      selectable: false,
      canSetUp: input.projectRepositoryKey !== null,
      detail: `No checkout of ${input.projectName}`,
      tooltip: `${worker.label} has no checkout of ${input.projectName}.`,
    };
  });
  return [local, ...rows];
}

/** T3o: the unpinned choice: the placement gate picks at build start (T3O-87). */
export const BOARD_ANY_READY_WORKER_LABEL = "Any ready worker";

/** The closed Worker field: "Any ready worker", or the pin. */
export function boardWorkerFieldLabel(
  pinnedWorkerId: BoardWorkerId | null,
  state: BoardWorkersState,
): { readonly label: string; readonly pinned: boolean } {
  return pinnedWorkerId === null
    ? { label: BOARD_ANY_READY_WORKER_LABEL, pinned: false }
    : { label: boardWorkerLabel(pinnedWorkerId, state), pinned: true };
}

/**
 * T3o: the card's placement line (T3O-87): where and when the gate placed it and why, or that
 * it is chosen when the build starts.
 */
export function boardCardPlacementLine(
  placement: {
    readonly workerId: string;
    readonly at: string;
    readonly reason: string | null;
  } | null,
  holdsWorktree: boolean,
  state: BoardWorkersState,
): string {
  if (placement === null || !holdsWorktree) return "Not placed yet: chosen when the build starts";
  const worker = boardWorkerLabel(placement.workerId as BoardWorkerId, state);
  return `${worker} · placed at ${clockTime(placement.at)}${
    placement.reason === null ? "" : ` · ${placement.reason}`
  }`;
}

/**
 * The create dialog's amber line when the card's worker — its pin, or the
 * default when it follows one — has no checkout of the chosen project
 * (prototype 4.1), or null.
 */
export function boardWorkerCheckoutWarning(input: {
  readonly state: BoardWorkersState;
  /** The card's pin; null follows the default. */
  readonly pinnedWorkerId?: BoardWorkerId | null;
  readonly projectRepositoryKey: string | null;
  readonly projectName: string;
}): string | null {
  const { state } = input;
  const workerId = input.pinnedWorkerId ?? state.defaultWorkerId;
  if (workerId === BOARD_LOCAL_WORKER_ID) return null;
  const worker = state.workers.find((candidate) => candidate.id === workerId);
  if (worker === undefined || boardWorkerHasCheckout(worker, input.projectRepositoryKey)) {
    return null;
  }
  return (input.pinnedWorkerId ?? null) === null
    ? `${worker.label} has no checkout of ${input.projectName}. Set up on worker or pin another.`
    : `${worker.label} has no checkout of ${input.projectName}. The card waits until it is set up there. Set up on worker or pick another.`;
}

// ── Queue reasons (prototype notice copy) ─────────────────────────

/** What a queued card is waiting on, ready for `boardQueueInfo` (T3O-86). */
export type BoardQueueReason =
  | {
      readonly kind: "capacity";
      readonly worker: string;
      readonly dimension: "cpu" | "ram" | "disk" | null;
      /** The card ahead in this board's queue on that worker, by key. */
      readonly behind: string | null;
      /** Bigger than the worker declares: no room will ever free there. */
      readonly tooBig: boolean;
      /** T3o: an unpinned card too big for every ready worker names none (T3O-87). */
      readonly anyWorker: boolean;
    }
  | { readonly kind: "no-ready-worker"; readonly project: string }
  | {
      readonly kind: "server-checkout";
      readonly project: string;
      readonly missing: boolean;
    }
  | { readonly kind: "server-sign-in"; readonly provider: string }
  /** T3o: the card holds `worker` and starts there when room frees (T3O-87). */
  | { readonly kind: "holding"; readonly worker: string }
  /** T3o: `worker` isn't taking new cards: held for this board's `behind`, or not said why. */
  | { readonly kind: "reserved"; readonly worker: string; readonly behind: string | null }
  | { readonly kind: "quota"; readonly worker: string }
  | { readonly kind: "agent-cap"; readonly worker: string }
  | { readonly kind: "needs-update"; readonly worker: string }
  | {
      readonly kind: "setup";
      readonly worker: string;
      readonly project: string;
      /** No percent: queue copy reads the card view, which drops clone
          progress so its ticks don't re-render the board. */
      readonly cloning: boolean;
      readonly failed: boolean;
      /** Why, when it isn't a checkout on its way: see `BoardStepQueuedDetail.setupCause`. */
      readonly cause: "not-ready" | "not-set-up" | "card-setup" | null;
    };

/**
 * The copy inputs for what holds a queued card, or null for plain "Queued #n". Shown on a
 * board with no remote workers too: there the worker is this server. Legacy reasons from the
 * board's old concurrency limits read as plain "Queued".
 */
export function boardQueueReason(input: {
  readonly card: Pick<BoardCardShell, "workerId" | "queuedBy" | "queuedDetail" | "projectId">;
  readonly state: BoardWorkersState;
  /** Card keys by id, for "Waiting behind T3O-90". */
  readonly cardKeys: ReadonlyMap<string, string>;
  readonly projectName: string;
}): BoardQueueReason | null {
  const queuedBy: BoardStepQueuedBy | undefined = input.card.queuedBy;
  if (queuedBy === undefined) return null;
  const detail = input.card.queuedDetail;
  const workerId = detail?.workerId ?? boardCardWorker(input.card, input.state).workerId;
  const worker = boardWorkerLabel(workerId, input.state);
  switch (queuedBy) {
    case "board":
    case "worker":
    case "provider":
    case "worker-offline":
      // Legacy limits read as plain Queued; Worker offline has its own notice.
      return null;
    case "capacity":
      return {
        kind: "capacity",
        worker,
        dimension: detail?.dimension ?? null,
        behind:
          detail?.behindCardId === undefined
            ? null
            : (input.cardKeys.get(detail.behindCardId) ?? null),
        tooBig: detail?.tooBig === true,
        anyWorker: detail?.tooBig === true && detail.workerId === undefined,
      };
    case "no-ready-worker":
      return { kind: "no-ready-worker", project: input.projectName };
    case "server-checkout":
      return {
        kind: "server-checkout",
        project: input.projectName,
        missing: detail?.serverCheckout === "missing",
      };
    case "server-sign-in":
      return { kind: "server-sign-in", provider: detail?.providerInstanceId ?? "the provider" };
    case "holding":
      return { kind: "holding", worker };
    case "reserved":
      return {
        kind: "reserved",
        worker,
        behind:
          detail?.behindCardId === undefined
            ? null
            : (input.cardKeys.get(detail.behindCardId) ?? null),
      };
    case "quota":
      return { kind: "quota", worker };
    case "agent-cap":
      return { kind: "agent-cap", worker };
    case "needs-update":
      return { kind: "needs-update", worker };
    case "setup": {
      const setup = setupOf(input.state, workerId, input.card.projectId);
      return {
        kind: "setup",
        worker,
        project: input.projectName,
        cloning: setup?.phase === "cloning",
        failed: setup?.phase === "failed",
        cause: detail?.setupCause ?? null,
      };
    }
  }
}

// ── Worker trouble (prototype 6) ──────────────────────────

/** Whether the board can't run anything on a worker now. Reconnecting
    (`connecting`, `unauthorized`) is over in seconds and is not trouble. */
function boardWorkerOutOfReach(worker: BoardWorkerView): boolean {
  const state = worker.status.state;
  return state === "offline" || state === "incompatible";
}

/** The card's Worker removed or Worker offline notice, and its panel. */
export interface BoardCardWorkerTrouble {
  readonly kind: "removed" | "offline";
  /** The worker the card is stuck on. */
  readonly workerId: BoardWorkerId | null;
  readonly workerLabel: string;
  readonly label: string;
  readonly tooltip: string;
  readonly panelTitle: string;
  readonly panelBody: string;
}

/**
 * Worker removed (the card holds until it is moved) or Worker offline (its
 * work is paused until the worker is back), or null. Both amber. Offline is
 * said only of a card with work there — a step running, parked, or waiting to
 * start — not of every card that happens to be pinned to the worker.
 */
export function boardCardWorkerTrouble(
  card: Pick<BoardCardShell, "workerId" | "placementOrphaned" | "stepRunning" | "queued"> &
    Partial<Pick<BoardCardShell, "stepAwaiting">>,
  state: BoardWorkersState,
): BoardCardWorkerTrouble | null {
  if (card.placementOrphaned !== undefined) {
    const worker = card.placementOrphaned.workerLabel;
    return {
      kind: "removed",
      workerId: null,
      workerLabel: worker,
      label: "Move this card",
      tooltip: `${worker} was removed from the board. Move this card to keep going.`,
      panelTitle: "Worker removed: move this card",
      panelBody: `${worker} was removed from the board while this card had work there. Pick a new worker and the card continues from its pushed branch.`,
    };
  }
  if (!card.stepRunning && !card.queued && card.stepAwaiting == null) return null;
  const { workerId } = boardCardWorker(card, state);
  if (workerId === BOARD_LOCAL_WORKER_ID) return null;
  const worker = state.workers.find((candidate) => candidate.id === workerId);
  if (worker === undefined || !boardWorkerOutOfReach(worker)) return null;
  const name = worker.label;
  const lastSeenAt = worker.status.lastSeenAt;
  const why =
    worker.status.state === "incompatible"
      ? `${name} needs a newer T3o.`
      : lastSeenAt === null
        ? `${name} is offline.`
        : `${name} went offline at ${clockTime(lastSeenAt)}.`;
  const panelTitle =
    worker.status.state === "incompatible" ? `${name} needs a newer T3o` : `${name} is offline`;
  return {
    kind: "offline",
    workerId,
    workerLabel: name,
    label: "Worker offline",
    tooltip: `${why} Work is paused; nothing has been restarted.`,
    panelTitle,
    panelBody: `Work on this card is paused. Nothing was restarted or moved. It carries on from where it stopped ${boardWorkerResumesWhen(worker, name)}.${
      lastSeenAt === null ? "" : ` Last heard from ${clockTime(lastSeenAt)}.`
    }`,
  };
}

/** When paused work on an out-of-reach worker carries on: an incompatible
    one needs an upgrade; an offline one comes back by itself. */
function boardWorkerResumesWhen(worker: BoardWorkerView, subject: string): string {
  return worker.status.state === "incompatible"
    ? `once ${subject} is upgraded`
    : `when ${subject} reconnects`;
}

/** One worker in the board header's indicator popover (prototype 6.3). */
export interface BoardWorkerAttentionRow {
  readonly workerId: BoardWorkerId;
  readonly label: string;
  /** "Offline since 09:12", "Needs T3o 0.14.0 or newer". */
  readonly status: string;
  /** "when it reconnects", "once it is upgraded". */
  readonly resumesWhen: string;
  readonly pausedCards: ReadonlyArray<Pick<BoardCardShell, "cardId" | "key" | "title">>;
}

/**
 * The board header's worker indicator: "1 worker offline", or "N workers need
 * attention" once any is incompatible — and each of them with the
 * cards it has paused. Null when every worker is fine, and on a local-only
 * board.
 */
export function boardWorkersAttention(
  cards: ReadonlyArray<
    Pick<
      BoardCardShell,
      | "cardId"
      | "key"
      | "title"
      | "workerId"
      | "placementOrphaned"
      | "stepRunning"
      | "queued"
      | "stepAwaiting"
    >
  >,
  state: BoardWorkersState,
): { readonly label: string; readonly rows: ReadonlyArray<BoardWorkerAttentionRow> } | null {
  const troubled = state.workers.filter(boardWorkerOutOfReach);
  if (troubled.length === 0) return null;
  const rows = troubled.map((worker): BoardWorkerAttentionRow => ({
    workerId: worker.id,
    label: worker.label,
    status:
      worker.status.state === "incompatible"
        ? `Needs T3o ${BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION} or newer`
        : worker.status.lastSeenAt === null
          ? "Offline"
          : `Offline since ${clockTime(worker.status.lastSeenAt)}`,
    resumesWhen: boardWorkerResumesWhen(worker, "it"),
    pausedCards: cards.filter(
      (card) => boardCardWorkerTrouble(card, state)?.workerId === worker.id,
    ),
  }));
  const allOffline = troubled.every((worker) => worker.status.state === "offline");
  const count = troubled.length;
  return {
    label: allOffline
      ? `${count} ${count === 1 ? "worker" : "workers"} offline`
      : `${count} ${count === 1 ? "worker needs" : "workers need"} attention`,
    rows,
  };
}

// ── Move notices (prototype 6) ─────────────────────────────────────────

export interface BoardCardMoveNotice {
  /** `moving` is blue; the two failures are amber. */
  readonly status: "moving" | "failed" | "clone-failed";
  readonly label: string;
  readonly tooltip: string;
}

/**
 * The card's worker notice: Moving (blue), Move failed (amber), or — for a card
 * held waiting on its worker's checkout whose clone failed — Clone failed
 * (amber). Null otherwise.
 */
export function boardCardMoveNotice(
  card: Pick<BoardCardShell, "workerMove"> &
    Partial<Pick<BoardCardShell, "workerId" | "queued" | "queuedBy" | "projectId">>,
  state: BoardWorkersState,
): BoardCardMoveNotice | null {
  const move = card.workerMove;
  if (move === undefined) {
    if (card.queued !== true || card.queuedBy !== "setup" || card.projectId === undefined) {
      return null;
    }
    const { workerId } = boardCardWorker(card, state);
    const setup = setupOf(state, workerId, card.projectId);
    if (setup?.phase !== "failed") return null;
    const worker = boardWorkerLabel(workerId, state);
    return {
      status: "clone-failed",
      label: "Clone failed",
      tooltip: `Cloning this card's project on ${worker} failed. Retry it in Settings → Board → Project checkouts, or pick another worker.`,
    };
  }
  const worker = boardWorkerLabel(move.toWorkerId, state);
  return move.status === "moving"
    ? {
        status: "moving",
        label: `Moving to ${worker}`,
        tooltip: `Creating a worktree on ${worker} from the pushed branch.`,
      }
    : {
        status: "failed",
        label: "Move failed",
        tooltip: `Couldn't create a worktree on ${worker}.`,
      };
}

/**
 * Where a Move-dialog move has got to. A move counts as this one only once its
 * `startedAt` differs from the one seen when Move was pressed, and done only once
 * the card is placed on the target.
 */
export type BoardMoveDialogStatus = "pending" | "moving" | "retired" | "done" | "failed";

export function boardMoveDialogStatus(
  card: Pick<BoardCard, "workerMove" | "worktree" | "placedWorkerId">,
  input: { readonly toWorkerId: BoardWorkerId; readonly priorStartedAt: string | null },
): BoardMoveDialogStatus {
  const move = card.workerMove;
  if (move === null) {
    return card.placedWorkerId === input.toWorkerId && card.worktree?.status === "ready"
      ? "done"
      : "pending";
  }
  if (move.startedAt === input.priorStartedAt || move.toWorkerId !== input.toWorkerId) {
    return "pending";
  }
  if (move.status === "failed") return "failed";
  return card.worktree?.status === "reclaimed" ? "retired" : "moving";
}

// ── The thread list's move dividers (prototype 7.1) ────────────────────

/** "today 10:04", or "12 Mar 10:04" on another day. */
function movedAtLabel(iso: string, nowMs: number): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return new Date(nowMs).toDateString() === at.toDateString()
    ? `today ${time}`
    : `${at.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

/**
 * "Moved from {worker} · {time}" above the first thread linked after each move
 * — the moves read off the card's `card-worker-moved` done rows. A thread list
 * on a card that never moved gets none.
 */
export function boardThreadMoveDividers(input: {
  readonly links: ReadonlyArray<{ readonly threadId: string; readonly linkedAt: string }>;
  readonly moves: ReadonlyArray<{
    readonly at: string;
    readonly fromWorkerId: BoardWorkerId | null;
  }>;
  readonly state: BoardWorkersState;
  readonly nowMs: number;
}): ReadonlyMap<string, string> {
  const dividers = new Map<string, string>();
  const ordered = [...input.links].sort((left, right) =>
    left.linkedAt.localeCompare(right.linkedAt),
  );
  for (const move of input.moves) {
    const first = ordered.find((link) => link.linkedAt >= move.at && !dividers.has(link.threadId));
    if (first === undefined) continue;
    const from =
      move.fromWorkerId === null
        ? "its old worker"
        : boardWorkerLabel(move.fromWorkerId, input.state);
    dividers.set(first.threadId, `Moved from ${from} · ${movedAtLabel(move.at, input.nowMs)}`);
  }
  return dividers;
}

// ── Model pickers ────────────────────────────────────────────────

/**
 * Provider instances only workers have, shaped like this server's own for the
 * model pickers; an id resolves on whichever worker runs the card. This server's
 * list comes first and its ids are never repeated.
 */
export function boardWorkerOnlyProviders(
  state: BoardWorkersState,
  serverProviders: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  const known = new Set<string>(serverProviders.map((provider) => provider.instanceId));
  const added: Array<ServerProvider> = [];
  for (const worker of state.workers) {
    const snapshot = worker.snapshot;
    if (snapshot === null) continue;
    for (const provider of snapshot.providers) {
      if (known.has(provider.instanceId)) continue;
      known.add(provider.instanceId);
      added.push({
        instanceId: provider.instanceId,
        driver: provider.driver as ServerProvider["driver"],
        ...(provider.displayName === null ? {} : { displayName: provider.displayName }),
        badgeLabel: worker.label,
        enabled: provider.enabled,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "unknown" },
        checkedAt: snapshot.reportedAt,
        models: provider.models.map((model) => ({
          slug: model.slug,
          name: model.name,
          isCustom: false,
          capabilities: null,
        })),
        slashCommands: [],
        skills: [],
      });
    }
  }
  return added;
}
