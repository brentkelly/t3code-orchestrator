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

type BoardEvent = Extract<OrchestrationEvent, { type: `board.${string}` }>;
type StockEvent = Exclude<OrchestrationEvent, BoardEvent>;

/**
 * What the shell stream holds of one domain event while it waits in the
 * coalescing window.
 *
 * Upstream keeps only the routing fields, because project and thread deltas are
 * a refetch and a window full of streamed message bodies is memory held for
 * nothing. The board cannot follow it all the way: a board delta is built from
 * the event payload (see above), so a board event stays whole — it carries one
 * card, not a transcript. A stock event is slimmed like upstream's, plus the one
 * bit of its payload the board reads: whether it rewrote a linked thread's todo
 * list (`boardCardThreadsShellEvents`).
 */
export type ShellWindowEvent =
  | BoardEvent
  | {
      readonly type: StockEvent["type"];
      readonly aggregateKind: StockEvent["aggregateKind"];
      readonly aggregateId: StockEvent["aggregateId"];
      readonly sequence: number;
      readonly todosChanged: boolean;
    };

export function toShellWindowEvent(event: OrchestrationEvent): ShellWindowEvent {
  if (isBoardEvent(event)) return event;
  const { type, aggregateKind, aggregateId, sequence } = event;
  return {
    type,
    aggregateKind,
    aggregateId,
    sequence,
    // The projector WRITES `board_thread_todos` on exactly this event.
    todosChanged:
      event.type === "thread.activity-appended" &&
      event.payload.activity.kind === "turn.plan.updated",
  };
}

export function shellCoalesceKey(event: ShellWindowEvent): string {
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
  events: ReadonlyArray<ShellWindowEvent>,
): ReadonlyArray<ShellWindowEvent> {
  const latest = new Map<string, ShellWindowEvent>();
  for (const event of events) {
    latest.set(shellCoalesceKey(event), event);
  }
  return Array.from(latest.values()).sort((left, right) => left.sequence - right.sequence);
}
