// @effect-diagnostics globalDate:off - run by the plain-Node auto-update script.
/**
 * T3o: when `t3o-worker auto-update` should run `t3o-update`. The worker's own server writes
 * `updateRequired` into `worker-status.json` from each board's answer, so deciding is a local
 * file read; GitHub is only asked once an update is due. Erasable TypeScript, plain Node.
 */

export const AUTO_UPDATE_STATE_FILE = "t3o-auto-update.json";

/** A flag that an update didn't clear (no newer release yet) is retried this often, not every tick. */
export const AUTO_UPDATE_RETRY_MS = 30 * 60_000;

export type AutoUpdateDecision =
  | {
      readonly kind: "idle";
      readonly reason: string;
      /** A live server flags nothing: an earlier attempt worked, so its retry window no longer applies. */
      readonly forgetAttempt: boolean;
    }
  | { readonly kind: "wait"; readonly reasons: ReadonlyArray<string>; readonly retryAt: string }
  | { readonly kind: "update"; readonly reasons: ReadonlyArray<string> }
  /** The last unattended update failed and the server is down: retrying can't fix it, so say so. */
  | { readonly kind: "failed"; readonly reason: string };

/** Whether a recorded attempt ended in anything but a clean `t3o-update` run. */
const attemptFailed = (outcome: string | null) => outcome !== null && outcome !== "ran";

/** Each board's reason from a `worker-status.json` body, tolerating any shape. */
function updateReasons(status: unknown): Array<string> {
  const boards = (status as { boards?: unknown } | null)?.boards;
  if (!Array.isArray(boards)) return [];
  return boards.flatMap((board: { boardLabel?: unknown; updateRequired?: unknown } | null) =>
    typeof board?.updateRequired === "string" && board.updateRequired !== ""
      ? [
          `${typeof board.boardLabel === "string" ? board.boardLabel : "a board"}: ${board.updateRequired}`,
        ]
      : [],
  );
}

function anyBoardConnected(status: unknown): boolean {
  const boards = (status as { boards?: unknown } | null)?.boards;
  return (
    Array.isArray(boards) &&
    boards.some((board: { state?: unknown } | null) => board?.state === "connected")
  );
}

export function decideAutoUpdate(input: {
  /** The parsed status file, or null when it is missing or unreadable. */
  readonly status: unknown;
  /** Whether the pid that wrote it is alive: a dead one's flags are stale. */
  readonly serverAlive: boolean;
  readonly lastAttemptAt: number | null;
  /** The recorded outcome of that attempt: "ran", "no-sudo" or "exited <code>". */
  readonly lastOutcome: string | null;
  readonly now: number;
}): AutoUpdateDecision {
  if ((input.status === null || !input.serverAlive) && attemptFailed(input.lastOutcome)) {
    // `t3o-update` stops the service before reinstalling it, so a failure can leave it down, and
    // the checkout may already be at the target, so running it again would do nothing.
    const at =
      input.lastAttemptAt === null ? "" : ` at ${new Date(input.lastAttemptAt).toISOString()}`;
    return {
      kind: "failed",
      reason: `the last update${at} failed (${input.lastOutcome}) and the T3o server isn't running. Run \`pnpm t3o-update\` by hand to see why.`,
    };
  }
  if (input.status === null) {
    return {
      kind: "idle",
      reason: "no worker status yet: the server hasn't reported.",
      forgetAttempt: false,
    };
  }
  if (!input.serverAlive) {
    return {
      kind: "idle",
      reason: "the T3o server isn't running, so its status is stale.",
      forgetAttempt: false,
    };
  }
  const reasons = updateReasons(input.status);
  if (reasons.length === 0) {
    // A board still connecting hasn't answered yet, so its silence doesn't clear the flag.
    return {
      kind: "idle",
      reason: "no board needs an update.",
      forgetAttempt: anyBoardConnected(input.status),
    };
  }
  if (input.lastAttemptAt !== null && input.now - input.lastAttemptAt < AUTO_UPDATE_RETRY_MS) {
    const retryAt = new Date(input.lastAttemptAt + AUTO_UPDATE_RETRY_MS).toISOString();
    return { kind: "wait", reasons, retryAt };
  }
  return { kind: "update", reasons };
}
