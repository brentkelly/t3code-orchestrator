/**
 * Errors the board engine answers a dispatch with (T3O-56).
 *
 * Board-owned rather than borrowed from `orchestration/Errors.ts`: the board
 * has its own engine now, and upstream's v1 error module does not survive the
 * orchestration-v2 port.
 */
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { OrchestrationProjectorDecodeError } from "../orchestration/Errors.ts";

/** The decider refused a board command — the board's "no". */
export class BoardCommandInvariantError extends Schema.TaggedError<BoardCommandInvariantError>()(
  "BoardCommandInvariantError",
  {
    commandType: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Board command invariant failed (${this.commandType}): ${this.detail}`;
  }
}

/** A command id the board already refused, replayed. */
export class BoardCommandPreviouslyRejectedError extends Schema.TaggedError<BoardCommandPreviouslyRejectedError>()(
  "BoardCommandPreviouslyRejectedError",
  {
    commandId: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Board command previously rejected (${this.commandId}): ${this.detail}`;
  }
}

/** A command id whose receipt belongs to a different aggregate. Replaying the
    receipt would report success for work that never happened. */
export class BoardCommandIdConflictError extends Schema.TaggedError<BoardCommandIdConflictError>()(
  "BoardCommandIdConflictError",
  {
    commandId: Schema.String,
    receiptAggregateKind: Schema.String,
    receiptAggregateId: Schema.String,
    commandAggregateKind: Schema.String,
    commandAggregateId: Schema.String,
  },
) {
  override get message(): string {
    return `Command id '${this.commandId}' already used for ${this.receiptAggregateKind} '${this.receiptAggregateId}'; refusing to replay its receipt for ${this.commandAggregateKind} '${this.commandAggregateId}'.`;
  }
}

export const isBoardCommandInvariantError = Schema.is(BoardCommandInvariantError);

export type BoardDispatchError =
  | BoardCommandInvariantError
  | BoardCommandPreviouslyRejectedError
  | BoardCommandIdConflictError
  | OrchestrationProjectorDecodeError
  | ProjectionRepositoryError;
