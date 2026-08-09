/**
 * T3o board client state.
 *
 * The card reducer is called from the upstream shell reducer's switch, so
 * every surface that keeps a cached shell snapshot (web, mobile, persistence)
 * applies card deltas without further seams (D17: board client state lives in
 * client-runtime). Exported to apps through `state/shell.ts`.
 */
import type {
  BoardCardRemovedShellEvent,
  BoardCardUpsertedShellEvent,
  OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import type * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createBoardCard, type CreateBoardCardInput } from "../operations/boardCommands.ts";
import { createEnvironmentCommand } from "./runtime.ts";

export type { CreateBoardCardInput };

export type BoardShellStreamEvent = BoardCardUpsertedShellEvent | BoardCardRemovedShellEvent;

export function applyBoardShellStreamEvent(
  snapshot: OrchestrationShellSnapshot,
  event: BoardShellStreamEvent,
): OrchestrationShellSnapshot {
  const cards = snapshot.cards ?? [];
  switch (event.kind) {
    case "card-upserted": {
      const nextCards = cards.some((card) => card.id === event.card.id)
        ? Arr.map(cards, (card) => (card.id === event.card.id ? event.card : card))
        : Arr.append(cards, event.card);
      return { ...snapshot, cards: nextCards, snapshotSequence: event.sequence };
    }
    case "card-removed":
      return {
        ...snapshot,
        cards: Arr.filter(cards, (card) => card.id !== event.cardId),
        snapshotSequence: event.sequence,
      };
  }
}

export function createBoardEnvironmentAtoms<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, ER>,
) {
  return {
    createCard: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:create-card",
      execute: (input: CreateBoardCardInput) => createBoardCard(input),
    }),
  };
}
