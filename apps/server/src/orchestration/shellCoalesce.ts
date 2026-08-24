/**
 * Which shell-stream events may collapse into one another (ws.ts coalescing).
 *
 * The shell stream coalesces a short window of domain events so a burst of
 * streaming deltas cannot serialize behind one DB read per event. That is sound
 * only when a later event SUBSUMES the earlier ones for the same aggregate.
 *
 * - Project and thread deltas are a REFETCH of the aggregate's current shell, so
 *   the last event carries every earlier one: collapse per aggregate.
 * - T3o board deltas are built from the EVENT PAYLOAD (a board event carries its
 *   whole card), and ONE card emits deltas of several different kinds. Collapsed
 *   per aggregate they lose data: a `board.card-moved` (→ `card-upserted`, the
 *   card's new stage) followed inside the window by `board.card-step-selected` /
 *   `board.card-step-admitted` (→ a one-bit `card-stalled` / `card-queued`)
 *   survives only as the badge, and the client's board never learns the card
 *   moved. That is precisely what dropping a card into an auto-executing stage
 *   does — the supervisor selects and admits its step milliseconds after the
 *   move — so the column never updated while the card detail (its own
 *   subscription) did. Board events therefore collapse per EVENT TYPE, so each
 *   kind of delta survives and only genuine repeats of one kind collapse.
 */
import { isBoardEvent, type OrchestrationEvent } from "@t3tools/contracts";

export function shellCoalesceKey(event: OrchestrationEvent): string {
  return isBoardEvent(event)
    ? `${event.aggregateKind}:${event.aggregateId}:${event.type}`
    : `${event.aggregateKind}:${event.aggregateId}`;
}

/**
 * The events of one coalescing window that still need mapping: the last event
 * per key, back in ascending sequence order (the client applies shell items by
 * increasing sequence and drops anything at or below its snapshot).
 */
export function coalesceShellWindow(
  events: ReadonlyArray<OrchestrationEvent>,
): ReadonlyArray<OrchestrationEvent> {
  const latest = new Map<string, OrchestrationEvent>();
  for (const event of events) {
    latest.set(shellCoalesceKey(event), event);
  }
  return Array.from(latest.values()).sort((left, right) => left.sequence - right.sequence);
}
