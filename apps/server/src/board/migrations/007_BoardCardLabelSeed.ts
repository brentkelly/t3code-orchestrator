// T3o: seed the label catalogue and convert each existing card's type to a
// one-element label set (t3o-06a). The migration in disguise — the closed
// `feature | bug | chore` type becomes exactly one seed label per card, so no
// card loses information.
//
// The seed values (ids, colours, staggered genesis timestamps) are FROZEN and
// MUST match `BOARD_SEED_LABELS` in packages/contracts/src/board.ts — they are
// compiled into `EMPTY_BOARD_STATE`, so a from-empty event replay and this
// table rehydration must start from an identical catalogue (a migration writes
// tables but emits no event). They are hardcoded here, not imported, because a
// migration is a frozen historical artifact: an already-applied migration must
// never change behaviour. `label-<type>` is exactly the id the projector's
// `legacyBoardCardTypeLabelId` maps a legacy `cardType` to on replay.
//
// Never edited after it has been applied — additive only, guarded and
// idempotent (INSERT OR IGNORE).
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const seeds = [
    { id: "label-feature", name: "feature", colour: "#3b82f6", at: "1970-01-01T00:00:00.000Z" },
    { id: "label-bug", name: "bug", colour: "#ef4444", at: "1970-01-01T00:00:00.001Z" },
    { id: "label-chore", name: "chore", colour: "#f59e0b", at: "1970-01-01T00:00:00.002Z" },
  ] as const;

  for (const seed of seeds) {
    yield* sql`
      INSERT OR IGNORE INTO board_labels (label_id, name, colour, deleted_at, created_at, updated_at)
      VALUES (${seed.id}, ${seed.name}, ${seed.colour}, ${null}, ${seed.at}, ${seed.at})
    `;
  }

  // One join row per existing card, mapping its `card_type` to the matching
  // seed label at ordinal 0. Only the three known types map; any other value
  // is left unlabelled rather than pointed at a non-existent label.
  yield* sql`
    INSERT OR IGNORE INTO board_card_labels (card_id, label_id, ordinal)
    SELECT card_id, 'label-' || card_type, 0
    FROM board_cards
    WHERE card_type IN ('feature', 'bug', 'chore')
  `;
});
