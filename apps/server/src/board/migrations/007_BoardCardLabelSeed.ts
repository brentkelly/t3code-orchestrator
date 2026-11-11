// Converts each card's legacy type to one seed label. The seed values are FROZEN
// and MUST match `BOARD_SEED_LABELS` in contracts board.ts (a from-empty replay
// starts from that catalogue); hardcoded, not imported, so this never changes.
// `label-<type>` is the id `legacyBoardCardTypeLabelId` maps a legacy type to.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

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
