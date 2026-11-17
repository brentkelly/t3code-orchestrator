/**
 * T3o: the automation gate sweep (T3O-115). `fireDueGates` asks `boardGateDue` of every card it
 * is given — the cards an event touched, or every card on the 30s tick and the boot pass — and
 * dispatches each due gate through its action. One board and settings read per pass; each action
 * re-reads what it needs. The reactor supplies the actions; this module owns the pass.
 */
import {
  boardGateDue,
  boardGateIndex,
  boardStageById,
  effectiveBoardStageRole,
  type BoardCard,
  type BoardCardGateBlock,
  type BoardCardId,
  type BoardGate,
  type BoardSettings,
  type BoardState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

/** What a gate action did. `not-due` for a gate the predicate called due is a silent stall. */
export type BoardGateOutcome =
  | { readonly kind: "acted" }
  | {
      readonly kind: "blocked";
      readonly reason: BoardCardGateBlock["reason"];
      readonly detail: string | null;
    }
  | { readonly kind: "not-due" };

export const gateActed: BoardGateOutcome = { kind: "acted" };
export const gateNotDue: BoardGateOutcome = { kind: "not-due" };
export const gateBlocked = (
  reason: BoardCardGateBlock["reason"],
  detail: string | null,
): BoardGateOutcome => ({ kind: "blocked", reason, detail });

/** Exhaustive over `BoardGate`: a new gate is a compile error until it has an action. A failed
    action reads as a `fault` block. */
export type BoardGateActions<E> = {
  readonly [G in BoardGate]: (card: BoardCard) => Effect.Effect<BoardGateOutcome, E>;
};

export interface BoardGateSweepDeps<E> {
  readonly readBoard: Effect.Effect<BoardState>;
  readonly readSettings: Effect.Effect<BoardSettings>;
  readonly workerUnreachable: Effect.Effect<(workerId: string) => boolean>;
  readonly actions: BoardGateActions<E>;
  /** Persist a block, called only when its gate + reason differ from the card's last one. */
  readonly recordBlock: (
    cardId: BoardCardId,
    block: BoardCardGateBlock | null,
  ) => Effect.Effect<void>;
}

/** Whether two block records are the same for writing purposes: gate and reason only. */
function sameGateBlock(
  left: Pick<BoardCardGateBlock, "gate" | "reason"> | null | undefined,
  right: Pick<BoardCardGateBlock, "gate" | "reason"> | null | undefined,
): boolean {
  if (left == null || right == null) return left == right;
  return left.gate === right.gate && left.reason === right.reason;
}

/** The cards a pass never evaluates: archived, groups and Done. Backlog is evaluated; no gate is
    due there. */
function sweepable(board: BoardState, card: BoardCard): boolean {
  if (card.archivedAt !== null || card.group !== null) return false;
  const stage = boardStageById(board, card.stage);
  if (stage === null) return false;
  const role = effectiveBoardStageRole(stage);
  return role !== "done";
}

export function makeBoardGateSweep<E>(deps: BoardGateSweepDeps<E>) {
  const act = Effect.fn("board-supervisor-fireGate")(function* (gate: BoardGate, card: BoardCard) {
    const outcome = yield* deps.actions[gate](card).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("board supervisor: a gate action failed", {
              gate,
              cardId: card.id,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(gateBlocked("fault", null))),
      ),
    );
    if (outcome.kind === "not-due") {
      yield* Effect.logWarning("board supervisor: a due gate's action did not act", {
        gate,
        cardId: card.id,
      });
      return outcome;
    }
    const block: BoardCardGateBlock | null =
      outcome.kind === "blocked" ? { gate, reason: outcome.reason, detail: outcome.detail } : null;
    // A move already cleared the old block; anything else that acted leaves nothing to clear.
    if (block !== null && !sameGateBlock(card.gateBlock, block)) {
      yield* deps.recordBlock(card.id, block);
    } else if (block === null && outcome.kind === "acted" && card.gateBlock !== undefined) {
      const after = (yield* deps.readBoard).cards.find((candidate) => candidate.id === card.id);
      if (after?.gateBlock !== undefined && after.gateBlock.gate === gate) {
        yield* deps.recordBlock(card.id, null);
      }
    }
    return outcome;
  });

  /** Fire every gate due on the given cards, or on every card. Returns what each due gate did. */
  const fireDueGates = Effect.fn("board-supervisor-fireDueGates")(function* (
    cardIds: ReadonlyArray<BoardCardId> | "all",
  ) {
    const board = yield* deps.readBoard;
    const settings = yield* deps.readSettings;
    const workerUnreachable = yield* deps.workerUnreachable;
    const index = boardGateIndex(board);
    const cards =
      cardIds === "all"
        ? board.cards
        : cardIds.flatMap((id) => index.cardsById.get(String(id)) ?? []);
    const fired: Array<
      { readonly cardId: BoardCardId; readonly gate: BoardGate } & {
        readonly outcome: BoardGateOutcome;
      }
    > = [];
    for (const card of cards) {
      if (!sweepable(board, card)) continue;
      const due = boardGateDue({ board, card, settings, workerUnreachable, index });
      // A block belongs to its gate being due: once that gate is not, nothing retries it.
      if (card.gateBlock !== undefined && due?.gate !== card.gateBlock.gate) {
        yield* deps.recordBlock(card.id, null);
      }
      if (due === null) continue;
      const outcome = yield* act(due.gate, card);
      fired.push({ cardId: card.id, gate: due.gate, outcome });
    }
    return fired;
  });

  return { fireDueGates };
}
