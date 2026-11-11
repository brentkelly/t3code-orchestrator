/**
 * T3o: the card threads whose routine upstream alerts ("Thread completed", a
 * usage limit) the board mutes, set by the board card notifier. Matched by
 * thread id alone, so a card thread hosted on a connected worker is muted too.
 */
const NONE: ReadonlySet<string> = new Set();
let mutedThreadIds = NONE;

export function setBoardMutedRoutineThreads(threadIds: ReadonlySet<string> | null): void {
  mutedThreadIds = threadIds ?? NONE;
}

/** Input, approval and failure alerts are never muted. */
export function isBoardRoutineThreadAlertMuted(
  threadId: string,
  kind: "input" | "completion",
  status: string,
): boolean {
  return (kind === "completion" || status === "limited") && mutedThreadIds.has(threadId);
}
