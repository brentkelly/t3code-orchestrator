/**
 * T3o board schema — the walking-skeleton slice (t3o-02), generalised (t3o-02a).
 *
 * Everything board-shaped lives here, in a T3o-owned file, so upstream merges
 * never touch it. This file deliberately imports only from `baseSchemas.ts`:
 * `orchestration.ts` imports this module to append board members to its
 * unions, so an import in the other direction would be a module cycle.
 *
 * The upstream seams in `orchestration.ts` are spreads of the registries at
 * the bottom of this file (`BOARD_CLIENT_COMMANDS`, `BOARD_EVENT_TYPES`,
 * `BOARD_SHELL_STREAM_EVENTS`) plus one injected-factory call
 * (`makeBoardOrchestrationEvents`). Adding a board command or event grows
 * those registries here and touches no upstream-owned file.
 *
 * The `board.` prefix rule is load-bearing: every board command and event
 * `type` starts with `board.`, and every board shell delta `kind` starts with
 * `card-`. The type guards below key on those prefixes, and a board command
 * named without the prefix falls outside `Extract<..., { type:
 * \`board.${string}\` }>`, reaches upstream's `satisfies never`, and fails
 * the build.
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

/**
 * Type guards for the `board.` / `card-` prefix rule. Generic over the input
 * union (rather than typed against `OrchestrationCommand` etc.) because this
 * file cannot import `orchestration.ts` — narrowing still resolves to the
 * board members of whatever union the caller holds, and the else-branch
 * excludes them, which is what keeps upstream's `satisfies never`
 * exhaustiveness checks intact after a board branch returns.
 */
export function isBoardCommand<Command extends { readonly type: string }>(
  command: Command,
): command is Extract<Command, { type: `board.${string}` }> {
  return command.type.startsWith("board.");
}

export function isBoardEvent<Event extends { readonly type: string }>(
  event: Event,
): event is Extract<Event, { type: `board.${string}` }> {
  return event.type.startsWith("board.");
}

export function isBoardShellStreamEvent<Event extends { readonly kind: string }>(
  event: Event,
): event is Extract<Event, { kind: `card-${string}` }> {
  return event.kind.startsWith("card-");
}

/**
 * Registries spread into upstream unions by `orchestration.ts`. These are the
 * only places a new board command/event/delta needs registering on the
 * contracts side.
 */
export const BOARD_CLIENT_COMMANDS = [BoardCardCreateCommand] as const;

export const BOARD_EVENT_TYPES = ["board.card-created"] as const;

export const BOARD_SHELL_STREAM_EVENTS = [
  BoardCardUpsertedShellEvent,
  BoardCardRemovedShellEvent,
] as const;

/**
 * Board members of the `OrchestrationEvent` union. The event base fields are
 * *injected* by `orchestration.ts` rather than imported here (the import
 * would be a module cycle — orchestration.ts imports this file — with a TDZ
 * failure at load), so upstream base-field changes flow into board events
 * automatically.
 */
export function makeBoardOrchestrationEvents<const Base extends Schema.Struct.Fields>(base: Base) {
  return [
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-created"),
      payload: BoardCardCreatedPayload,
    }),
  ] as const;
}

/**
 * Compile-time drift guard: the `type` literals produced by
 * `makeBoardOrchestrationEvents` and the `BOARD_EVENT_TYPES` registry must
 * stay in lockstep — a member added to one but not the other would otherwise
 * surface only as a runtime decode failure. Both directions are asserted; if
 * either alias errors, a registry and the factory have drifted.
 */
type BoardEventTypeFromRegistry = (typeof BOARD_EVENT_TYPES)[number];
type BoardEventTypeFromFactory = ReturnType<
  typeof makeBoardOrchestrationEvents<Record<never, never>>
>[number]["Type"]["type"];
type _AssertExtends<A extends B, B> = A;
type _RegistryCoversFactory = _AssertExtends<BoardEventTypeFromFactory, BoardEventTypeFromRegistry>;
type _FactoryCoversRegistry = _AssertExtends<BoardEventTypeFromRegistry, BoardEventTypeFromFactory>;
