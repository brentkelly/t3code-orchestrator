/**
 * T3o board schema — the full card domain model (t3o-03) on the generalised
 * seams (t3o-02a).
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
 *
 * Event payload shape: `board.card-created` is flat (its walking-skeleton
 * form is already persisted in real event logs, so new fields carry decoding
 * defaults). Every later event carries the full post-change `card` alongside
 * its semantic fields — the shell delta mapping in ws.ts is a pure function
 * of the event with no projection re-read, so the event must contain
 * everything the shell needs, and the projectors get replay determinism for
 * free by upserting exactly what the decider computed.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const BoardCardId = TrimmedNonEmptyString.pipe(Schema.brand("BoardCardId"));
export type BoardCardId = typeof BoardCardId.Type;

// ── Stages ─────────────────────────────────────────────────────────────

/**
 * The fixed, closed stage set (D12), in board order. The decider derives
 * adjacency from this array and the stage UIs derive column order and
 * labels from it — it is the single source of stage ordering.
 */
export const BOARD_STAGES = [
  "backlog",
  "sprint",
  "planning",
  "ready",
  "building",
  "review",
  "merge",
  "done",
] as const;

export const BoardStage = Schema.Literals(BOARD_STAGES);
export type BoardStage = typeof BoardStage.Type;

export function boardStageIndex(stage: BoardStage): number {
  return BOARD_STAGES.indexOf(stage);
}

export function areBoardStagesAdjacent(a: BoardStage, b: BoardStage): boolean {
  return Math.abs(boardStageIndex(a) - boardStageIndex(b)) === 1;
}

/** Dependency gating starts at Ready (D18): a card may reach Ready with
    unmet dependencies and is blocked from Ready onward, never earlier. */
export function isBoardStageReadyOrBeyond(stage: BoardStage): boolean {
  return boardStageIndex(stage) >= boardStageIndex("ready");
}

/** Sub-board plan cards (D12) use the Ready-onward stage subset; a card with
    a parent can never enter these stages, override or not. */
export function isBoardStageBeforeReady(stage: BoardStage): boolean {
  return boardStageIndex(stage) < boardStageIndex("ready");
}

// ── Card pieces ────────────────────────────────────────────────────────

export const BoardCardType = Schema.Literals(["feature", "bug", "chore"]);
export type BoardCardType = typeof BoardCardType.Type;

/**
 * Thread link (D9). `role` is a free string discriminator (`planning`,
 * `build`, `review:r1:triage`, …) so the review pipeline can extend it
 * without a schema change. A deleted thread's link is never removed, only
 * tombstoned — recorded when the link is next touched: unlinking a deleted
 * thread sets `tombstonedAt` instead of removing the link. (Nothing reacts
 * to `thread.deleted` itself in t3o-03; eager tombstoning needs the Phase-2
 * reactor seam, t3o-10.)
 */
export const BoardCardThreadLink = Schema.Struct({
  threadId: ThreadId,
  role: TrimmedNonEmptyString,
  linkedAt: IsoDateTime,
  tombstonedAt: Schema.NullOr(IsoDateTime),
});
export type BoardCardThreadLink = typeof BoardCardThreadLink.Type;

/**
 * Canonical thread-link order: (linkedAt, threadId), needed because linkedAt
 * is client-supplied, so link order ≠ linkedAt order in general. Compared by
 * code units (not localeCompare, which is locale-sensitive) and applied on
 * BOTH sides of the replay-equals-rehydration invariant: the decider sorts
 * links into event payloads with it, and the board projection re-sorts rows
 * read back from `board_card_thread_links` with it — never trusting SQL
 * collation to agree with JS.
 */
export function sortBoardCardThreadLinks(
  links: ReadonlyArray<BoardCardThreadLink>,
): ReadonlyArray<BoardCardThreadLink> {
  const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  return [...links].sort(
    (left, right) =>
      compare(left.linkedAt, right.linkedAt) || compare(left.threadId, right.threadId),
  );
}

/** External tracker escape hatch (D14): exists from day one so import from,
    and later sync to, GitHub Issues / Linear / Jira is a field, not a
    migration. */
export const BoardCardExternalRef = Schema.Struct({
  system: TrimmedNonEmptyString,
  id: TrimmedNonEmptyString,
  url: Schema.NullOr(TrimmedNonEmptyString),
});
export type BoardCardExternalRef = typeof BoardCardExternalRef.Type;

/**
 * Placeholder for the resolved recipe captured on stage entry (D10). Schema
 * only in t3o-03 — nothing writes it until the settings surface (t3o-07) and
 * step execution (t3o-10) land, at which point this alias tightens to the
 * real recipe shape with no seam change.
 */
export const BoardCardRecipeSnapshot = Schema.Record(Schema.String, Schema.Unknown);
export type BoardCardRecipeSnapshot = typeof BoardCardRecipeSnapshot.Type;

/** The `kind` under which a card's brief body is stored in
    `board_card_bodies`; `BoardCard.briefRef` holds it when a brief exists. */
export const BOARD_CARD_BRIEF_BODY_KIND = "brief";

// ── Card aggregate ─────────────────────────────────────────────────────

export const BoardCard = Schema.Struct({
  id: BoardCardId,
  /** Generated `<prefix>-<cardNumber>`, e.g. "T3-195" (D14). */
  key: TrimmedNonEmptyString,
  /** The per-project counter value `key` was allocated from; kept so the
      counter can be rebuilt exactly on rehydration and replay. */
  cardNumber: NonNegativeInt,
  projectId: ProjectId,
  type: BoardCardType,
  stage: BoardStage,
  /** Fractional ordering key within the stage column, following the
      `pinOrderKey` precedent: the client computes it (threadSort.ts helpers)
      and the server stores it. */
  orderKey: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  /** Body kind in `board_card_bodies` when a brief exists (D8: bodies never
      ride the read model); null when the card has no brief. */
  briefRef: Schema.NullOr(TrimmedNonEmptyString),
  dependsOn: Schema.Array(BoardCardId),
  /** Null for top-level cards; set for sub-board plan cards. Schema only in
      MVP — no t3o-03 command writes it (D12 materialisation is post-MVP). */
  parentCardId: Schema.NullOr(BoardCardId),
  threadLinks: Schema.Array(BoardCardThreadLink),
  externalRef: Schema.NullOr(BoardCardExternalRef),
  recipeSnapshot: Schema.NullOr(BoardCardRecipeSnapshot),
  /** Derived from unmet dependencies at Ready and beyond (D18), recorded by
      the decider at each move / dependency edit / unarchive. */
  blocked: Schema.Boolean,
  archivedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BoardCard = typeof BoardCard.Type;

/**
 * Blocked derivation (D18): unmet dependencies block a card from Ready
 * onward and never earlier. A dependency is met only when its card is in
 * `done`; an unknown id counts as unmet (nothing can prove it finished).
 * Shared by the decider and any client that wants a live view.
 */
export function deriveBoardCardBlocked(input: {
  readonly stage: BoardStage;
  readonly dependsOn: ReadonlyArray<BoardCardId>;
  readonly cards: ReadonlyArray<Pick<BoardCard, "id" | "stage">>;
}): boolean {
  if (!isBoardStageReadyOrBeyond(input.stage)) return false;
  return input.dependsOn.some((dependencyId) => {
    const dependency = input.cards.find((card) => card.id === dependencyId);
    return dependency === undefined || dependency.stage !== "done";
  });
}

/**
 * Board slice of the in-memory orchestration read model (D8: everything a
 * transition branches on lives here). Archived cards STAY in `cards` with
 * `archivedAt` set — they leave the shell snapshot, but dropping them from
 * the read model would make `board.card-unarchived` unprojectable on a
 * from-empty replay (the card's data would be gone) and break the
 * replay-equals-rehydration invariant. Attached to `OrchestrationReadModel`
 * as an optional field so read models built by pre-board code — upstream
 * tests included — decode and compile unchanged.
 */
export const BoardState = Schema.Struct({
  cards: Schema.Array(BoardCard),
  /** Next key number per project (D14). Lives in the read model so
      allocation is exact and race-free under the engine's total command
      ordering; rebuilt from `MAX(card_number)` on rehydration. */
  nextCardNumberByProject: Schema.Record(ProjectId, PositiveInt),
});
export type BoardState = typeof BoardState.Type;

export const EMPTY_BOARD_STATE: BoardState = { cards: [], nextCardNumberByProject: {} };

// ── Key allocation ─────────────────────────────────────────────────────

/**
 * Key prefix used when `board.card.create` carries none. The spec makes the
 * per-project prefix a setting, but the settings surface does not exist
 * until t3o-07 — so the command carries an optional `keyPrefix` and t3o-07
 * wires the real settings source with no schema change here.
 */
export const DEFAULT_BOARD_KEY_PREFIX = "CARD";

/**
 * Values walking-skeleton (t3o-02) `board.card-created` events and
 * `board_cards` rows decode to for fields that did not exist yet. The
 * decoding defaults on `BoardCardCreatedPayload` and the column defaults in
 * migration `903_BoardCardsColumns` MUST both use these, or a from-empty
 * replay of a pre-t3o-03 log would diverge from table rehydration.
 */
export const LEGACY_BOARD_CARD_NUMBER = 0;
export const LEGACY_BOARD_CARD_KEY = `${DEFAULT_BOARD_KEY_PREFIX}-${LEGACY_BOARD_CARD_NUMBER}`;
export const LEGACY_BOARD_CARD_ORDER_KEY = "m";

// ── Commands ───────────────────────────────────────────────────────────
// Card-shape fields on commands/payloads are named `cardType` (not `type`)
// because `type` is the command/event discriminant.

export const BoardCardCreateCommand = Schema.Struct({
  type: Schema.Literal("board.card.create"),
  commandId: CommandId,
  cardId: BoardCardId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  cardType: BoardCardType,
  /** Client-computed fractional position in the Backlog column. */
  orderKey: TrimmedNonEmptyString,
  /** Overrides DEFAULT_BOARD_KEY_PREFIX; the t3o-07 settings surface will
      supply the per-project value. */
  keyPrefix: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type BoardCardCreateCommand = typeof BoardCardCreateCommand.Type;

export const BoardCardMoveCommand = Schema.Struct({
  type: Schema.Literal("board.card.move"),
  commandId: CommandId,
  cardId: BoardCardId,
  toStage: BoardStage,
  /** Fractional position in the target column; absent keeps the current key. */
  orderKey: Schema.optional(TrimmedNonEmptyString),
  /** Permits non-adjacent stage moves. A drag is an override — a rigid
      board still has to let you drag a card backwards. */
  override: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
});
export type BoardCardMoveCommand = typeof BoardCardMoveCommand.Type;

export const BoardCardReorderCommand = Schema.Struct({
  type: Schema.Literal("board.card.reorder"),
  commandId: CommandId,
  cardId: BoardCardId,
  orderKey: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type BoardCardReorderCommand = typeof BoardCardReorderCommand.Type;

/** Partial update: absent fields are unchanged. `brief` and `externalRef`
    accept null to clear. One command with partial semantics rather than five
    near-identical commands. */
export const BoardCardUpdateCommand = Schema.Struct({
  type: Schema.Literal("board.card.update"),
  commandId: CommandId,
  cardId: BoardCardId,
  title: Schema.optional(TrimmedNonEmptyString),
  /** Brief body text, stored in `board_card_bodies` — never in the read
      model (D8). */
  brief: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  cardType: Schema.optional(BoardCardType),
  dependsOn: Schema.optional(Schema.Array(BoardCardId)),
  externalRef: Schema.optional(Schema.NullOr(BoardCardExternalRef)),
  createdAt: IsoDateTime,
});
export type BoardCardUpdateCommand = typeof BoardCardUpdateCommand.Type;

export const BoardCardLinkThreadCommand = Schema.Struct({
  type: Schema.Literal("board.card.link-thread"),
  commandId: CommandId,
  cardId: BoardCardId,
  threadId: ThreadId,
  role: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type BoardCardLinkThreadCommand = typeof BoardCardLinkThreadCommand.Type;

export const BoardCardUnlinkThreadCommand = Schema.Struct({
  type: Schema.Literal("board.card.unlink-thread"),
  commandId: CommandId,
  cardId: BoardCardId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
export type BoardCardUnlinkThreadCommand = typeof BoardCardUnlinkThreadCommand.Type;

export const BoardCardArchiveCommand = Schema.Struct({
  type: Schema.Literal("board.card.archive"),
  commandId: CommandId,
  cardId: BoardCardId,
  createdAt: IsoDateTime,
});
export type BoardCardArchiveCommand = typeof BoardCardArchiveCommand.Type;

export const BoardCardUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("board.card.unarchive"),
  commandId: CommandId,
  cardId: BoardCardId,
  createdAt: IsoDateTime,
});
export type BoardCardUnarchiveCommand = typeof BoardCardUnarchiveCommand.Type;

// ── Event payloads ─────────────────────────────────────────────────────

/**
 * Flat (not `{ card }`-shaped) because walking-skeleton events with the
 * original five fields are persisted in real dev event logs. Fields added
 * by t3o-03 carry decoding defaults mirroring migration 903's column
 * defaults, so legacy events replay to exactly the card their legacy table
 * rows rehydrate to.
 */
export const BoardCardCreatedPayload = Schema.Struct({
  cardId: BoardCardId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  key: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed(LEGACY_BOARD_CARD_KEY)),
  ),
  cardNumber: NonNegativeInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(LEGACY_BOARD_CARD_NUMBER)),
  ),
  cardType: BoardCardType.pipe(Schema.withDecodingDefault(Effect.succeed("feature" as const))),
  stage: BoardStage.pipe(Schema.withDecodingDefault(Effect.succeed("backlog" as const))),
  orderKey: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed(LEGACY_BOARD_CARD_ORDER_KEY)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BoardCardCreatedPayload = typeof BoardCardCreatedPayload.Type;

export const BoardCardMovedPayload = Schema.Struct({
  cardId: BoardCardId,
  fromStage: BoardStage,
  toStage: BoardStage,
  card: BoardCard,
});
export type BoardCardMovedPayload = typeof BoardCardMovedPayload.Type;

export const BoardCardReorderedPayload = Schema.Struct({
  cardId: BoardCardId,
  orderKey: TrimmedNonEmptyString,
  card: BoardCard,
});
export type BoardCardReorderedPayload = typeof BoardCardReorderedPayload.Type;

export const BoardCardUpdatedPayload = Schema.Struct({
  cardId: BoardCardId,
  /** Absent: brief unchanged. Null: brief cleared. String: new body text for
      `board_card_bodies` (the body deliberately never enters the read
      model — D8). */
  brief: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  card: BoardCard,
});
export type BoardCardUpdatedPayload = typeof BoardCardUpdatedPayload.Type;

export const BoardCardThreadLinkedPayload = Schema.Struct({
  cardId: BoardCardId,
  threadId: ThreadId,
  role: TrimmedNonEmptyString,
  card: BoardCard,
});
export type BoardCardThreadLinkedPayload = typeof BoardCardThreadLinkedPayload.Type;

export const BoardCardThreadUnlinkedPayload = Schema.Struct({
  cardId: BoardCardId,
  threadId: ThreadId,
  /** Null: the thread was live and the link was removed. Set: the thread was
      deleted, so the link stays on the card as a tombstone (D9). */
  tombstonedAt: Schema.NullOr(IsoDateTime),
  card: BoardCard,
});
export type BoardCardThreadUnlinkedPayload = typeof BoardCardThreadUnlinkedPayload.Type;

export const BoardCardArchivedPayload = Schema.Struct({
  cardId: BoardCardId,
  archivedAt: IsoDateTime,
  card: BoardCard,
});
export type BoardCardArchivedPayload = typeof BoardCardArchivedPayload.Type;

export const BoardCardUnarchivedPayload = Schema.Struct({
  cardId: BoardCardId,
  card: BoardCard,
});
export type BoardCardUnarchivedPayload = typeof BoardCardUnarchivedPayload.Type;

// ── Shell deltas ───────────────────────────────────────────────────────

/**
 * Card deltas on the shell stream, mirroring `thread-upserted` /
 * `thread-removed`. Archiving emits `card-removed` (the card leaves the
 * live board every client renders); unarchiving emits `card-upserted`.
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
export const BOARD_CLIENT_COMMANDS = [
  BoardCardCreateCommand,
  BoardCardMoveCommand,
  BoardCardReorderCommand,
  BoardCardUpdateCommand,
  BoardCardLinkThreadCommand,
  BoardCardUnlinkThreadCommand,
  BoardCardArchiveCommand,
  BoardCardUnarchiveCommand,
] as const;

export const BOARD_EVENT_TYPES = [
  "board.card-created",
  "board.card-moved",
  "board.card-reordered",
  "board.card-updated",
  "board.card-thread-linked",
  "board.card-thread-unlinked",
  "board.card-archived",
  "board.card-unarchived",
] as const;

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
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-moved"),
      payload: BoardCardMovedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-reordered"),
      payload: BoardCardReorderedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-updated"),
      payload: BoardCardUpdatedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-thread-linked"),
      payload: BoardCardThreadLinkedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-thread-unlinked"),
      payload: BoardCardThreadUnlinkedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-archived"),
      payload: BoardCardArchivedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-unarchived"),
      payload: BoardCardUnarchivedPayload,
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
