/**
 * Branches deleted cards left behind (T3O-123). A card delete queues its branch removal in
 * memory, so a restart before it runs leaves the branch for good; the worktree sweep reads the
 * recent deletes back from the event log and tidies what is left.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

/** How far back the sweep looks for deleted cards. */
export const DELETED_CARD_BRANCH_WINDOW_DAYS = 90;

export interface DeletedCardBranch {
  readonly cardId: string;
  readonly projectId: string;
  /** Where the card was placed; null is this server. */
  readonly workerId: string | null;
  readonly branch: string;
}

// Only what the sweep needs: an older payload's other card fields may not decode today.
const DeletedCardPayload = Schema.fromJsonString(
  Schema.Struct({
    card: Schema.Struct({
      id: Schema.String,
      projectId: Schema.String,
      placedWorkerId: Schema.optionalKey(Schema.NullOr(Schema.String)),
      worktree: Schema.NullOr(Schema.Struct({ branch: Schema.String })),
    }),
  }),
);
const decodePayload = Schema.decodeUnknownOption(DeletedCardPayload);

export const readDeletedCardBranches = Effect.fn("readDeletedCardBranches")(function* (
  sql: SqlClient.SqlClient,
  sinceIso: string,
) {
  const rows = yield* sql<{ readonly payload: string }>`
    SELECT payload_json AS "payload"
    FROM boards.board_events
    WHERE event_type = 'board.card-deleted' AND occurred_at >= ${sinceIso}
    ORDER BY sequence ASC
  `;
  const branches: Array<DeletedCardBranch> = [];
  for (const row of rows) {
    const decoded = decodePayload(row.payload);
    if (decoded._tag === "None") continue;
    const { card } = decoded.value;
    if (card.worktree === null || !card.worktree.branch.startsWith("board/")) continue;
    branches.push({
      cardId: card.id,
      projectId: card.projectId,
      workerId: card.placedWorkerId ?? null,
      branch: card.worktree.branch,
    });
  }
  return branches;
});

/** The deleted cards' branches no live card uses: names are reused, and a live card's is its own. */
export const leftoverDeletedCardBranches = (
  deleted: ReadonlyArray<DeletedCardBranch>,
  liveCards: ReadonlyArray<{ readonly worktree: { readonly branch: string } | null }>,
): ReadonlyArray<DeletedCardBranch> => {
  const live = new Set(
    liveCards.flatMap((card) => (card.worktree === null ? [] : [card.worktree.branch])),
  );
  const seen = new Set<string>();
  return deleted.filter((leftover) => {
    const key = `${leftover.workerId ?? ""}\0${leftover.projectId}\0${leftover.branch}`;
    if (live.has(leftover.branch) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
