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
  | { readonly kind: "idle"; readonly reason: string }
  | { readonly kind: "wait"; readonly reasons: ReadonlyArray<string>; readonly retryAt: string }
  | { readonly kind: "update"; readonly reasons: ReadonlyArray<string> };

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

export function decideAutoUpdate(input: {
  /** The parsed status file, or null when it is missing or unreadable. */
  readonly status: unknown;
  /** Whether the pid that wrote it is alive: a dead one's flags are stale. */
  readonly serverAlive: boolean;
  readonly lastAttemptAt: number | null;
  readonly now: number;
}): AutoUpdateDecision {
  if (input.status === null) {
    return { kind: "idle", reason: "no worker status yet: the server hasn't reported." };
  }
  if (!input.serverAlive) {
    return { kind: "idle", reason: "the T3o server isn't running, so its status is stale." };
  }
  const reasons = updateReasons(input.status);
  if (reasons.length === 0) return { kind: "idle", reason: "no board needs an update." };
  if (input.lastAttemptAt !== null && input.now - input.lastAttemptAt < AUTO_UPDATE_RETRY_MS) {
    const retryAt = new Date(input.lastAttemptAt + AUTO_UPDATE_RETRY_MS).toISOString();
    return { kind: "wait", reasons, retryAt };
  }
  return { kind: "update", reasons };
}
