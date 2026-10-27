/**
 * T3o (T3O-62): every word and colour the Workers and Project checkouts
 * settings show, as pure functions of the board's worker summary. The copy is
 * the prototype's (`.plans/prototype/Distributed Board.dc.html`, screens 1–2);
 * the colours follow `docs/t3o/status-colours.md`: online is the steady state
 * and stays grey, connecting and cloning are blue, anything that needs a human
 * to act on the worker is amber, and only a finished setup is green.
 */
import {
  BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION,
  type BoardWorkerAddErrorCode,
  type BoardWorkerCheckout,
  type BoardWorkerSetup,
  type BoardWorkerSetupFailureKind,
  type BoardWorkerView,
} from "@t3tools/contracts";

export type WorkerTone = "neutral" | "running" | "warning" | "done";

export interface WorkerStatusPresentation {
  readonly label: string;
  /** A second line under the label, when there is more to say. */
  readonly detail: string | null;
  readonly tone: WorkerTone;
  readonly tooltip: string | null;
}

/** "09:12", in the reader's own clock. */
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function workerStatusPresentation(
  worker: BoardWorkerView,
  boardLabel: string,
): WorkerStatusPresentation {
  switch (worker.status.state) {
    case "online":
      return { label: "Online", detail: null, tone: "neutral", tooltip: null };
    case "connecting":
      return { label: "Connecting…", detail: null, tone: "running", tooltip: null };
    case "offline":
      return {
        label: "Offline",
        detail: null,
        tone: "warning",
        tooltip:
          worker.status.lastSeenAt === null
            ? `The board server can't reach ${worker.label}. Cards on ${worker.label} are paused until it reconnects.`
            : `Last heard from at ${clockTime(worker.status.lastSeenAt)}. Cards on ${worker.label} are paused until it reconnects.`,
      };
    case "unauthorized":
      return {
        label: "Access revoked",
        detail: `Revoked in ${worker.label}'s Connections`,
        tone: "warning",
        tooltip: `${worker.label}'s owner removed “T3o board (${boardLabel})” from Settings → Sharing & access → Authorized clients on that machine, or it no longer recognises this board. Its cards are held until it's re-paired.`,
      };
    case "incompatible":
      return {
        label: "Incompatible version",
        detail: `Needs T3o ${BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION} or newer`,
        tone: "warning",
        tooltip: null,
      };
  }
}

/** "Now" while online, otherwise how long ago it was last heard from. */
export function workerLastSeen(worker: BoardWorkerView, nowMs: number): string {
  if (worker.status.state === "online") return "Now";
  if (worker.status.lastSeenAt === null) return "Never";
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(worker.status.lastSeenAt)) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${clockTime(worker.status.lastSeenAt)} · ${hours} h ago`;
  return new Date(worker.status.lastSeenAt).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const HALF_MINUTE_MS = 30_000;
const HALF_HOUR_MS = 30 * 60_000;

/**
 * Every moment `workerLastSeen`'s label can change, until it settles on an
 * absolute time. Its rounding flips minutes on half-minute ages (to 59.5 min)
 * and hours half a minute before each odd half-hour (to 23.5 h).
 */
export function workerLastSeenDeadlines(worker: BoardWorkerView): ReadonlyArray<number> {
  if (worker.status.state === "online" || worker.status.lastSeenAt === null) return [];
  const seenMs = Date.parse(worker.status.lastSeenAt);
  const deadlines: Array<number> = [];
  for (let age = HALF_MINUTE_MS * 2; age <= 119 * HALF_MINUTE_MS; age += HALF_MINUTE_MS) {
    deadlines.push(seenMs + age);
  }
  for (let age = HALF_HOUR_MS * 3; age <= 47 * HALF_HOUR_MS; age += HALF_HOUR_MS * 2) {
    deadlines.push(seenMs + age - HALF_MINUTE_MS);
  }
  return deadlines;
}

export interface AddWorkerErrorCopy {
  readonly title: string;
  readonly body: string;
}

/** The add / re-pair error states (prototype 1.9). `target` is the worker the
    human meant, by the name they know it under. */
export function addWorkerErrorCopy(input: {
  readonly code: BoardWorkerAddErrorCode;
  readonly target: string;
  readonly workerLabel?: string | undefined;
  readonly workerVersion?: string | undefined;
  readonly message: string;
}): AddWorkerErrorCopy {
  switch (input.code) {
    case "unreachable":
      return {
        title: `Board server can't reach ${input.target}`,
        body: "Workers must be reachable from the board server, for example over the same network or VPN.",
      };
    case "invalid-credential":
      return {
        title: "This link has expired or isn't valid",
        body: "Pairing links work once and expire after 5 minutes. Run t3 pair on the worker again and paste the new link. It starts with https:// and contains /pair#.",
      };
    case "incompatible":
      return {
        title:
          input.workerVersion === undefined
            ? `${input.target} isn't a compatible T3o server`
            : `${input.target} runs T3o ${input.workerVersion}`,
        body: `This board needs ${BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION} or newer on every worker. Update T3o on ${input.target}, then try again.`,
      };
    case "different-server":
      return {
        title: "That link is for a different server",
        body:
          input.workerLabel === undefined
            ? `Paste a link created on ${input.target}.`
            : `You're adding ${input.target}, but this link is from ${input.workerLabel}. Paste a link created on ${input.target}, or go back and pick ${input.workerLabel}.`,
      };
    case "board-server":
      return {
        title: "That's the board server",
        body: "This link is from the board server itself, which is already a worker as “This server (local)”. Use a link from another machine.",
      };
    case "already-worker":
      return { title: `${input.workerLabel ?? input.target} is already a worker.`, body: "" };
    case "not-found":
      return { title: "That worker isn't on this board any more.", body: input.message };
  }
}

/** Whether a pasted link looks like a pairing link at all — checked on paste,
    before anything is sent (prototype 1.9: "Bad format is checked on paste"). */
export function looksLikePairingLink(text: string): boolean {
  try {
    const url = new URL(text.trim());
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      (url.hash.includes("token=") || url.searchParams.has("token"))
    );
  } catch {
    return false;
  }
}

// ── Project checkouts ──────────────────────────────────────────────────

/** How long "Set up just now" stays green before settling to "Checked out". */
export const SETUP_JUST_NOW_MS = 10_000;

export type CheckoutCell =
  | { readonly kind: "checked-out"; readonly path: string; readonly lastKnown: boolean }
  | { readonly kind: "set-up-just-now"; readonly path: string }
  | { readonly kind: "cloning"; readonly percent: number | null; readonly stage: string | null }
  | {
      readonly kind: "failed";
      readonly failureKind: BoardWorkerSetupFailureKind;
      readonly setup: BoardWorkerSetup;
    }
  | { readonly kind: "not-checked-out"; readonly canSetUp: boolean }
  | { readonly kind: "set-up-when-online" }
  | { readonly kind: "re-pair-to-check" }
  | { readonly kind: "update-to-check" };

/**
 * One cell of the coverage matrix: a board project on a worker. A setup in
 * flight or just failed outranks the checkout list, which only learns of a
 * clone once the worker reports it.
 */
export function checkoutCell(input: {
  readonly worker: BoardWorkerView;
  readonly checkout: BoardWorkerCheckout | null;
  readonly setup: BoardWorkerSetup | null;
  readonly projectHasRemote: boolean;
  readonly nowMs: number;
}): CheckoutCell {
  const { worker, checkout, setup } = input;
  if (worker.status.state === "unauthorized") return { kind: "re-pair-to-check" };
  if (worker.status.state === "incompatible") return { kind: "update-to-check" };
  if (setup?.phase === "cloning") {
    return { kind: "cloning", percent: setup.percent, stage: setup.stage };
  }
  if (setup?.phase === "failed" && setup.failure !== null) {
    return { kind: "failed", failureKind: setup.failure.kind, setup };
  }
  if (
    setup?.phase === "done" &&
    setup.endedAt !== null &&
    input.nowMs - Date.parse(setup.endedAt) < SETUP_JUST_NOW_MS
  ) {
    return { kind: "set-up-just-now", path: setup.destinationPath };
  }
  const online = worker.status.state === "online";
  if (checkout !== null) {
    return { kind: "checked-out", path: checkout.workspaceRoot, lastKnown: !online };
  }
  if (!online) return { kind: "set-up-when-online" };
  return { kind: "not-checked-out", canSetUp: input.projectHasRemote };
}

/** Git's own phase, as the cell reads it ("Receiving objects"). */
export function cloneStageLabel(stage: string | null): string {
  switch (stage) {
    case "connecting":
      return "Connecting";
    case "counting":
      return "Counting objects";
    case "receiving":
      return "Receiving objects";
    case "resolving":
      return "Resolving deltas";
    case "checkout":
      return "Checking out files";
    default:
      return "Starting";
  }
}

/** The failed cell's short line, and the Details dialog's explanation
    (prototype 2.3). */
export function setupFailureCopy(input: {
  readonly kind: BoardWorkerSetupFailureKind;
  readonly worker: string;
  readonly host: string;
  readonly path: string;
}): { readonly cell: string; readonly detail: string } {
  switch (input.kind) {
    case "no-credentials":
      return {
        cell: `No git credentials for ${input.host}`,
        detail: `${input.host} refused ${input.worker}: it has no credentials for this remote. Add an SSH key or a git credential helper on ${input.worker}, then retry.`,
      };
    case "remote-unreachable":
      return {
        cell: `Can't reach ${input.host}`,
        detail: `${input.worker} couldn't connect to ${input.host}. Check its network or proxy, then retry.`,
      };
    case "folder-exists":
      return {
        cell: "Folder already exists",
        detail: `${input.path} exists on ${input.worker} and isn't a checkout of this repo. Move it aside or pick another folder.`,
      };
    case "no-remote":
      return {
        cell: "No git remote",
        detail: "This project has no git remote, so workers can't clone it. Add a remote and push.",
      };
    case "disk-full":
      return {
        cell: "Out of disk space",
        detail: `${input.worker} ran out of space. Free some space, then retry.`,
      };
    case "worker-offline":
      return {
        cell: "Interrupted — worker offline",
        detail: `${input.worker} went offline during the clone. Retry once it's back.`,
      };
    case "unknown":
      return { cell: "Clone failed", detail: `The clone on ${input.worker} failed. See the log.` };
  }
}

/** The host a remote URL names, for "No git credentials for github.com". */
export function remoteHost(remote: string): string {
  const scp = /^[^@/]+@([^:/]+):/.exec(remote);
  if (scp?.[1] !== undefined) return scp[1];
  try {
    return new URL(remote).host;
  } catch {
    return remote.split("/")[0] ?? remote;
  }
}
