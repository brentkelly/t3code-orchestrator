/**
 * T3o (T3O-65, D20; prototype screens 3–6): every word the card's worker field,
 * its chip, the worker picker, the queue reasons and the move notices show, as
 * pure functions of the board's worker summary.
 *
 * Neither the field nor the chip exists on a board with one worker: a
 * local-only board renders exactly as it always has. The chip never takes a
 * status colour (`docs/t3o/status-colours.md`) — worker trouble goes in the
 * card's notice slot.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION,
  resolveBoardWorkerConcurrency,
  resolveBoardWorkerCheckout,
  type BoardCard,
  type BoardCardShell,
  type BoardConcurrencySettings,
  type BoardStepQueuedBy,
  type BoardWorkerId,
  type BoardWorkersState,
  type BoardWorkerSetup,
  type BoardWorkerView,
  type ProjectId,
  type ServerProvider,
} from "@t3tools/contracts";

import { LOCAL_WORKER_LABEL } from "./threadWorker";
import { clockTime } from "./workerCopy";

/** Whether the board has workers to choose between. */
export function boardShowsWorkers(state: BoardWorkersState): boolean {
  return state.workers.length > 0;
}

/** A worker's name: "This server", or its label. */
export function boardWorkerLabel(workerId: BoardWorkerId, state: BoardWorkersState): string {
  if (workerId === BOARD_LOCAL_WORKER_ID) return LOCAL_WORKER_LABEL;
  return state.workers.find((worker) => worker.id === workerId)?.label ?? workerId;
}

/** Where a card runs, as its shell and the board's default say: its bound
    worker (a pin, or where it holds a worktree), else the default. */
export function boardCardWorker(
  card: Pick<BoardCardShell, "workerId">,
  state: BoardWorkersState,
): { readonly workerId: BoardWorkerId; readonly bound: boolean } {
  return card.workerId === undefined
    ? { workerId: state.defaultWorkerId, bound: false }
    : { workerId: card.workerId, bound: true };
}

export interface BoardCardWorkerChip {
  readonly label: string;
  /** Solid when the card is pinned or holds a worktree; dashed when it
      follows the default and hasn't started. */
  readonly bound: boolean;
  readonly tooltip: string;
}

/** The meta row's worker chip (prototype 4.4), or null on a one-worker board. */
export function boardCardWorkerChip(
  card: Pick<BoardCardShell, "workerId">,
  state: BoardWorkersState,
): BoardCardWorkerChip | null {
  if (!boardShowsWorkers(state)) return null;
  const { workerId, bound } = boardCardWorker(card, state);
  const name = boardWorkerLabel(workerId, state);
  return {
    label: workerId === BOARD_LOCAL_WORKER_ID ? "local" : name,
    bound,
    tooltip: bound ? `Runs on ${name}` : `Follows the default worker — ${name}`,
  };
}

/** Agents running on each worker, from the shells: the "1 of 4 busy" count. */
export function boardWorkerRunningCounts(
  cards: ReadonlyArray<Pick<BoardCardShell, "workerId" | "stepRunning">>,
  state: BoardWorkersState,
): ReadonlyMap<BoardWorkerId, number> {
  const counts = new Map<BoardWorkerId, number>();
  for (const card of cards) {
    if (!card.stepRunning) continue;
    const { workerId } = boardCardWorker(card, state);
    counts.set(workerId, (counts.get(workerId) ?? 0) + 1);
  }
  return counts;
}

/** "1 of 4 busy", "4 of 4 busy · will queue", or "2 busy" with no limit. */
export function boardWorkerLoadLabel(running: number, limit: number | null): string {
  if (limit === null) return `${running} busy`;
  return running >= limit
    ? `${running} of ${limit} busy · will queue`
    : `${running} of ${limit} busy`;
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
export function boardWorkerHasCheckout(
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
  readonly running: ReadonlyMap<BoardWorkerId, number>;
  readonly concurrency: BoardConcurrencySettings;
}): ReadonlyArray<BoardWorkerChoice> {
  const load = (workerId: BoardWorkerId) =>
    boardWorkerLoadLabel(
      input.running.get(workerId) ?? 0,
      resolveBoardWorkerConcurrency(input.concurrency, workerId).maxConcurrent,
    );
  const local: BoardWorkerChoice = {
    workerId: BOARD_LOCAL_WORKER_ID,
    label: `${LOCAL_WORKER_LABEL} (local)`,
    selectable: true,
    detail: load(BOARD_LOCAL_WORKER_ID),
    tooltip: null,
    canSetUp: false,
    cloning: false,
  };
  const rows = input.state.workers.map((worker): BoardWorkerChoice => {
    const base = { workerId: worker.id, label: worker.label, canSetUp: false, cloning: false };
    switch (worker.status.state) {
      case "unauthorized":
        return {
          ...base,
          selectable: false,
          detail: "Access revoked",
          tooltip: `${worker.label}'s access was revoked. Re-pair it in Settings → Workers.`,
        };
      case "incompatible":
        return {
          ...base,
          selectable: false,
          detail: `Needs T3o ${BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION}+`,
          tooltip: `${worker.label} runs T3o ${worker.status.t3oVersion ?? "an older version"}; this board needs ${BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION} or newer.`,
        };
      case "offline":
      case "connecting":
        return {
          ...base,
          selectable: false,
          detail: "Offline",
          tooltip: `${worker.label} is offline. Pin it once it reconnects.`,
        };
      case "online":
        break;
    }
    const setup = setupOf(input.state, worker.id, input.projectId);
    if (boardWorkerHasCheckout(worker, input.projectRepositoryKey)) {
      return { ...base, selectable: true, detail: load(worker.id), tooltip: null };
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

/** The closed Worker field: "Follow default — This server", or the pin. */
export function boardWorkerFieldLabel(
  pinnedWorkerId: BoardWorkerId | null,
  state: BoardWorkersState,
): { readonly label: string; readonly pinned: boolean } {
  return pinnedWorkerId === null
    ? {
        label: `Follow default — ${boardWorkerLabel(state.defaultWorkerId, state)}`,
        pinned: false,
      }
    : { label: boardWorkerLabel(pinnedWorkerId, state), pinned: true };
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

// ── Queue reasons (D11, prototype notice copy) ─────────────────────────

/** What a queued card is waiting on, ready for `boardQueueInfo`. */
export type BoardQueueReason =
  | {
      readonly kind: "worker";
      readonly worker: string;
      readonly running: number;
      readonly limit: number;
    }
  | { readonly kind: "provider"; readonly worker: string }
  | { readonly kind: "board"; readonly running: number; readonly limit: number }
  | {
      readonly kind: "setup";
      readonly worker: string;
      readonly project: string;
      /** No percent: queue copy reads the card view, which drops clone
          progress so its ticks don't re-render the board. */
      readonly cloning: boolean;
      readonly failed: boolean;
    };

/**
 * The binding limit's copy inputs for a queued card, or null with one worker —
 * a local-only board keeps plain "Queued #n".
 */
export function boardQueueReason(input: {
  readonly card: Pick<BoardCardShell, "workerId" | "queuedBy" | "projectId">;
  readonly state: BoardWorkersState;
  readonly cards: ReadonlyArray<Pick<BoardCardShell, "workerId" | "stepRunning">>;
  readonly concurrency: BoardConcurrencySettings;
  readonly projectName: string;
}): BoardQueueReason | null {
  const queuedBy: BoardStepQueuedBy | undefined = input.card.queuedBy;
  if (!boardShowsWorkers(input.state) || queuedBy === undefined) return null;
  const { workerId } = boardCardWorker(input.card, input.state);
  const worker = boardWorkerLabel(workerId, input.state);
  switch (queuedBy) {
    case "worker": {
      const limit = resolveBoardWorkerConcurrency(input.concurrency, workerId).maxConcurrent;
      const running = boardWorkerRunningCounts(input.cards, input.state).get(workerId) ?? 0;
      return { kind: "worker", worker, running, limit: limit ?? running };
    }
    case "provider":
      return { kind: "provider", worker };
    case "board": {
      let running = 0;
      for (const card of input.cards) if (card.stepRunning) running += 1;
      return { kind: "board", running, limit: input.concurrency.globalMaxConcurrent };
    }
    case "worker-offline":
      // The card's Worker offline notice says it (T3O-66).
      return null;
    case "setup": {
      const setup = setupOf(input.state, workerId, input.card.projectId);
      return {
        kind: "setup",
        worker,
        project: input.projectName,
        cloning: setup?.phase === "cloning",
        failed: setup?.phase === "failed",
      };
    }
  }
}

// ── Worker trouble (T3O-66, D22; prototype 6) ──────────────────────────

/** Whether the board can't run anything on a worker now. `connecting` is a
    first dial, over in seconds, and is not trouble; a redial of a worker
    already offline stays `offline`. */
export function boardWorkerOutOfReach(worker: BoardWorkerView): boolean {
  const state = worker.status.state;
  return state === "offline" || state === "unauthorized" || state === "incompatible";
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
      panelTitle: "Worker removed — move this card",
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
    worker.status.state === "unauthorized"
      ? `${name}'s access was revoked.`
      : worker.status.state === "incompatible"
        ? `${name} needs a newer T3o.`
        : lastSeenAt === null
          ? `${name} is offline.`
          : `${name} went offline at ${clockTime(lastSeenAt)}.`;
  const panelTitle =
    worker.status.state === "unauthorized"
      ? `${name}'s access was revoked`
      : worker.status.state === "incompatible"
        ? `${name} needs a newer T3o`
        : `${name} is offline`;
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

/**
 * When paused work on an out-of-reach worker carries on: a revoked worker
 * needs pairing again and an incompatible one an upgrade; only an offline
 * one comes back by itself.
 */
function boardWorkerResumesWhen(worker: BoardWorkerView, subject: string): string {
  return worker.status.state === "unauthorized"
    ? `once ${subject} is paired again`
    : worker.status.state === "incompatible"
      ? `once ${subject} is upgraded`
      : `when ${subject} reconnects`;
}

/** One worker in the board header's indicator popover (prototype 6.3). */
export interface BoardWorkerAttentionRow {
  readonly workerId: BoardWorkerId;
  readonly label: string;
  /** "Offline since 09:12", "Access revoked", "Needs T3o 0.14.0 or newer". */
  readonly status: string;
  /** "when it reconnects", "once it is paired again", "once it is upgraded". */
  readonly resumesWhen: string;
  readonly pausedCards: ReadonlyArray<Pick<BoardCardShell, "cardId" | "key" | "title">>;
}

/**
 * The board header's worker indicator: "1 worker offline", or "N workers need
 * attention" once any is revoked or incompatible — and each of them with the
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
      worker.status.state === "unauthorized"
        ? "Access revoked"
        : worker.status.state === "incompatible"
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
 * Where a move the Move dialog started has got to, read off the card. Until the
 * server records this move's start the card still shows whatever was there
 * before — no move on a first move, the last failure on a Retry — so a move
 * counts as this one only once its `startedAt` differs from the one seen when
 * the human pressed Move, and done only once the card is placed on the target.
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

// ── Model pickers (D10) ────────────────────────────────────────────────

/**
 * Provider instances only workers have, shaped like this server's own so the
 * stage and card model pickers can offer them (T3O-65): a recipe names an
 * instance id, and the id resolves on whichever worker the card is placed on.
 * The central server's own list is unchanged and comes first; an id it already
 * has is never repeated.
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
