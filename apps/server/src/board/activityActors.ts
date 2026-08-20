/**
 * T3o activity actors (t3o-18, D11) — who caused a board event.
 *
 * `board.ts` contains no `actor`, `userId` or `author`: board commands carry no
 * provenance at all, and a stage move may originate from a human drag, an
 * agent's MCP tool call, or the supervisor reactor. So the actor is stamped at
 * the DISPATCH BOUNDARY, because the transport already knows who called:
 *
 * | Origin                                | Actor                                       |
 * | ------------------------------------- | ------------------------------------------- |
 * | Board RPC from the web client         | `{ kind: "human", name }`                   |
 * | MCP board toolkit                     | `{ kind: "agent", providerInstanceId, threadId }` |
 * | Supervisor reactor / internal command | `{ kind: "system" }`                        |
 *
 * No command schema changes, and no caller can misreport itself —
 * `BOARD_CLIENT_COMMANDS` vs `BOARD_INTERNAL_COMMANDS` already draws half this
 * line.
 *
 * **How the stamp reaches the projector.** The activity rail is a projection of
 * the board's own event log (D10), so the actor has to be readable where the row
 * is written: inside the projection pipeline's transaction, one hop after the
 * dispatcher. That is a different fiber from the caller's, so a `FiberRef` will
 * not carry it and the event envelope is upstream-owned. This module is
 * therefore an explicit in-process side channel keyed by `commandId` — the one
 * identifier the dispatcher chooses and the event carries.
 *
 * It is deliberately best-effort, like the reactor's own in-memory watermarks:
 *
 * - Bounded (`MAX_STAMPS`, FIFO), so a rejected command's stamp cannot leak.
 * - Read without eviction, so a command that lands several events attributes all
 *   of them.
 * - Unknown / unstamped / restarted-process ⇒ `BOARD_SYSTEM_ACTOR`. A rebuilt
 *   projection therefore attributes historic rows to the system rather than
 *   inventing a human — wrong-but-honest beats confidently wrong.
 */
import {
  BOARD_SYSTEM_ACTOR,
  type BoardActivityActor,
  type CommandId,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";

/** Enough for any realistic in-flight burst; the map is a hand-off, not a
    store. Oldest entries are evicted first. */
const MAX_STAMPS = 512;

const stamps = new Map<string, BoardActivityActor>();

/** Record who is dispatching `commandId`. Called by a dispatch boundary
    immediately before `engine.dispatch`, so the stamp is present by the time the
    projector runs. */
export function stampBoardActivityActor(commandId: CommandId, actor: BoardActivityActor): void {
  const key = String(commandId);
  // Re-stamping moves the entry to the back of the FIFO, so a retried command
  // is not evicted while its first attempt's neighbours age out.
  stamps.delete(key);
  stamps.set(key, actor);
  while (stamps.size > MAX_STAMPS) {
    const oldest = stamps.keys().next();
    if (oldest.done === true) break;
    stamps.delete(oldest.value);
  }
}

/** The actor for an event's `commandId`, or the system actor. Never evicts: one
    command may land several events, and all of them share its actor. */
export function boardActivityActorFor(
  commandId: CommandId | string | null | undefined,
): BoardActivityActor {
  if (commandId === null || commandId === undefined) return BOARD_SYSTEM_ACTOR;
  return stamps.get(String(commandId)) ?? BOARD_SYSTEM_ACTOR;
}

/** The agent actor for an MCP tool call (D11). The display name and accent are
    resolved client-side from the provider instance, so a renamed instance
    relabels its own history rather than freezing a stale label on the row. */
export function boardAgentActor(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
}): BoardActivityActor {
  return {
    kind: "agent",
    name: null,
    providerInstanceId: input.providerInstanceId,
    threadId: input.threadId,
  };
}

/** The human actor (D11). `name` is frozen on the row at write time, so it stays
    correct after the project's git config changes. */
export function boardHumanActor(name: string): BoardActivityActor {
  return {
    kind: "human",
    name: name.trim().length > 0 ? name.trim() : BOARD_HUMAN_ACTOR_FALLBACK_NAME,
    providerInstanceId: null,
    threadId: null,
  };
}

/**
 * What a human is called when git has no identity. There is no user identity
 * anywhere in t3code — it is a single-user local server — so this is the whole
 * fallback ladder: the card's project git `user.name`, then this.
 */
export const BOARD_HUMAN_ACTOR_FALLBACK_NAME = "You";

/** Test hook: forget every stamp. Production never calls it. */
export function resetBoardActivityActors(): void {
  stamps.clear();
}
