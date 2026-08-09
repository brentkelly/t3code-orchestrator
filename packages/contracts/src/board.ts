/**
 * T3o board schema — the walking-skeleton slice (t3o-02).
 *
 * Everything board-shaped lives here, in a T3o-owned file, so upstream merges
 * never touch it. This file deliberately imports only from `baseSchemas.ts`:
 * `orchestration.ts` imports this module to append board members to its
 * unions, so an import in the other direction would be a module cycle.
 *
 * The skeleton carries exactly one command (`board.card.create`), one event
 * (`board.card-created`), and one card field (`title`). Stages, ordering,
 * links, and everything else arrive with `t3o-03` onward.
 */
import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const BoardCardId = TrimmedNonEmptyString.pipe(Schema.brand("BoardCardId"));
export type BoardCardId = typeof BoardCardId.Type;

/**
 * The full card and its shell summary are the same struct while the card has
 * a single field; they split (per D7) as soon as cards grow heavy detail.
 */
export const BoardCard = Schema.Struct({
  id: BoardCardId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BoardCard = typeof BoardCard.Type;

/**
 * Board slice of the in-memory orchestration read model (D8: the decider
 * branches on card existence, so cards live here). Attached to
 * `OrchestrationReadModel` as an optional field so read models built by
 * pre-board code — upstream tests included — decode and compile unchanged.
 */
export const BoardState = Schema.Struct({
  cards: Schema.Array(BoardCard),
});
export type BoardState = typeof BoardState.Type;

export const EMPTY_BOARD_STATE: BoardState = { cards: [] };

export const BoardCardCreateCommand = Schema.Struct({
  type: Schema.Literal("board.card.create"),
  commandId: CommandId,
  cardId: BoardCardId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type BoardCardCreateCommand = typeof BoardCardCreateCommand.Type;

export const BoardCardCreatedPayload = Schema.Struct({
  cardId: BoardCardId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BoardCardCreatedPayload = typeof BoardCardCreatedPayload.Type;

/**
 * Card deltas on the shell stream, mirroring `thread-upserted` /
 * `thread-removed`. `card-removed` has no producer in the skeleton; it exists
 * so the client reducer's remove path is exercised before deletion lands.
 */
export const BoardCardUpsertedShellEvent = Schema.Struct({
  kind: Schema.Literal("card-upserted"),
  sequence: NonNegativeInt,
  card: BoardCard,
});
export type BoardCardUpsertedShellEvent = typeof BoardCardUpsertedShellEvent.Type;

export const BoardCardRemovedShellEvent = Schema.Struct({
  kind: Schema.Literal("card-removed"),
  sequence: NonNegativeInt,
  cardId: BoardCardId,
});
export type BoardCardRemovedShellEvent = typeof BoardCardRemovedShellEvent.Type;
