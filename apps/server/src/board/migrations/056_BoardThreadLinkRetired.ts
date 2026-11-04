// T3o: retired thread links (T3O-41).
//
// `board_card_thread_links.retired_at` — set when the board finishes with a
// thread that is still alive (a finished conflict fix, a superseded restart,
// an abandoned step), so the thread stays on its card as history instead of
// losing its link. Null while the link is live.
//
// Backfills the threads the board unlinked before this existed, straight into
// the table (the board hydrates from its tables, like 012/016):
//
//   (a) the thread's LAST `board.card-thread-unlinked` event was the server's,
//       on a live thread: relink it to that card as retired, with the role,
//       linked_at and worker of its latest `board.card-thread-linked` event.
//   (b) no event says where it belonged, but its title is `<KEY> · <label>`
//       for a card in the thread's project and a board stage or step label.
//
// Only threads with no link row (thread_id is the key), that still exist
// undeleted, and whose card still exists. A human's unlink is left alone.
// Guarded by the column check, so re-running is a no-op.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Step labels the board titles its machinery threads with, as of this migration. */
const STEP_LABEL = /^(?:Conflicts|Fixing CI|(?:Review|Triage|Adjudicate|Sync base) · round \d+)$/;
const TITLE = /^([A-Z][A-Z0-9]*-\d+) · (.+)$/;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_card_thread_links)
  `;
  if (columns.some((column) => column.name === "retired_at")) return;
  yield* sql`ALTER TABLE board_card_thread_links ADD COLUMN retired_at TEXT`;

  // The thread projection is upstream's, in `main`; the board's own test
  // layers may run without it.
  const [threadsTable] = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM main.sqlite_master
    WHERE type = 'table' AND name = 'orchestration_v2_projection_threads'
  `;
  if ((threadsTable?.n ?? 0) === 0) return;

  // (a) From the event log.
  yield* sql`
    WITH unlinks AS (
      SELECT
        json_extract(payload_json, '$.threadId') AS thread_id,
        json_extract(payload_json, '$.cardId') AS card_id,
        json_extract(payload_json, '$.tombstonedAt') AS tombstoned_at,
        actor_kind,
        occurred_at,
        ROW_NUMBER() OVER (
          PARTITION BY json_extract(payload_json, '$.threadId') ORDER BY sequence DESC
        ) AS recency
      FROM board_events
      WHERE event_type = 'board.card-thread-unlinked'
    ),
    links AS (
      SELECT
        json_extract(events.payload_json, '$.threadId') AS thread_id,
        json_extract(events.payload_json, '$.cardId') AS card_id,
        json_extract(events.payload_json, '$.role') AS role,
        events.occurred_at AS linked_at,
        (
          SELECT json_extract(link.value, '$.workerId')
          FROM json_each(events.payload_json, '$.card.threadLinks') AS link
          WHERE json_extract(link.value, '$.threadId') = json_extract(events.payload_json, '$.threadId')
        ) AS worker_id,
        ROW_NUMBER() OVER (
          PARTITION BY json_extract(events.payload_json, '$.threadId') ORDER BY events.sequence DESC
        ) AS recency
      FROM board_events AS events
      WHERE events.event_type = 'board.card-thread-linked'
    )
    INSERT INTO board_card_thread_links
      (thread_id, card_id, role, linked_at, tombstoned_at, worker_id, retired_at)
    SELECT unlinks.thread_id, unlinks.card_id, links.role, links.linked_at, NULL,
      links.worker_id, unlinks.occurred_at
    FROM unlinks
    INNER JOIN links
      ON links.thread_id = unlinks.thread_id AND links.card_id = unlinks.card_id
      AND links.recency = 1
    INNER JOIN board_cards AS cards ON cards.card_id = unlinks.card_id
    INNER JOIN main.orchestration_v2_projection_threads AS threads
      ON threads.thread_id = unlinks.thread_id AND threads.deleted_at IS NULL
    WHERE unlinks.recency = 1
      AND unlinks.actor_kind = 'server'
      AND unlinks.tombstoned_at IS NULL
      AND links.role IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM board_card_thread_links AS existing
        WHERE existing.thread_id = unlinks.thread_id
      )
  `;

  // (b) Card-titled threads no event accounts for.
  const stages = yield* sql<{ readonly stageId: string; readonly label: string }>`
    SELECT stage_id AS "stageId", label FROM board_stages
  `;
  const candidates = yield* sql<{
    readonly threadId: string;
    readonly projectId: string;
    readonly title: string;
    readonly createdAt: string;
    readonly settledAt: string | null;
    readonly updatedAt: string;
  }>`
    SELECT
      threads.thread_id AS "threadId",
      threads.project_id AS "projectId",
      threads.title,
      threads.created_at AS "createdAt",
      json_extract(threads.payload_json, '$.settledAt') AS "settledAt",
      threads.updated_at AS "updatedAt"
    FROM main.orchestration_v2_projection_threads AS threads
    WHERE threads.deleted_at IS NULL
      AND threads.title GLOB '[A-Z]*-[0-9]* · *'
      AND NOT EXISTS (
        SELECT 1 FROM board_card_thread_links AS existing
        WHERE existing.thread_id = threads.thread_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM board_events AS events
        WHERE events.event_type IN ('board.card-thread-linked', 'board.card-thread-unlinked')
          AND json_extract(events.payload_json, '$.threadId') = threads.thread_id
      )
  `;
  for (const thread of candidates) {
    const match = TITLE.exec(thread.title);
    if (match === null) continue;
    const [, key, label] = match;
    const stage = stages.find((candidate) => candidate.label === label);
    if (stage === undefined && !STEP_LABEL.test(label!)) continue;
    const [card] = yield* sql<{ readonly cardId: string }>`
      SELECT card_id AS "cardId" FROM board_cards
      WHERE key = ${key!} AND project_id = ${thread.projectId}
    `;
    if (card === undefined) continue;
    yield* sql`
      INSERT INTO board_card_thread_links
        (thread_id, card_id, role, linked_at, tombstoned_at, worker_id, retired_at)
      VALUES (
        ${thread.threadId}, ${card.cardId}, ${stage?.stageId ?? "linked"}, ${thread.createdAt},
        NULL, NULL, ${thread.settledAt ?? thread.updatedAt}
      )
    `;
  }
});
