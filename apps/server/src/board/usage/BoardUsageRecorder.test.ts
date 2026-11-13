/**
 * A finished turn's usage, from the thread log to the card (T3O-77): through the real
 * thread tail and the real v2 projection, priced with a fixed rate table.
 */
import {
  BoardCardId,
  CommandId,
  EventId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import { createOverrideRateTable, parseRateTable } from "../../usage/usagePricing.ts";
import { BoardQueries } from "../BoardQueries.ts";
import { boardStackEngine, makeBoardStackTestLayerWithoutTail } from "../boardStack.testkit.ts";
import { BoardThreadTail, BoardThreadTailLive } from "../boardThreadTail.ts";
import { BOARD_MIGRATIONS } from "../migrations/index.ts";
import { BoardUsagePricing } from "../ports/BoardUsagePricing.ts";
import type { UsageSignal } from "../ThreadGateway.ts";
import {
  BOARD_USAGE_BACKFILL_MARKER,
  BoardUsageRecorder,
  BoardUsageRecorderLive,
} from "./BoardUsageRecorder.ts";

const t0 = "2026-01-01T00:00:00.000Z";
const instance = ProviderInstanceId.make("codex");

const pricingTest = Layer.succeed(
  BoardUsagePricing,
  BoardUsagePricing.of({
    currentRates: Effect.succeed({
      table: parseRateTable({
        "gpt-5-codex": { input_cost_per_token: 1e-6, output_cost_per_token: 10e-6 },
      }),
      overrides: createOverrideRateTable({
        "custom-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 20 },
      }),
    }),
  }),
);

/** A recorder and a tail of their own, started now — as a server boot would start them. */
const withRecorder = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  body.pipe(
    Effect.provide(
      BoardThreadTailLive.pipe(
        Layer.provideMerge(BoardUsageRecorderLive.pipe(Layer.provide(pricingTest))),
        Layer.fresh,
      ),
    ),
  );

/** A project, a card, and a thread linked to it as `role` — named by `tag`. */
const seedLinkedThread = (tag: string, role = "building") =>
  Effect.gen(function* () {
    const engine = yield* boardStackEngine;
    const projectId = ProjectId.make(`project-${tag}`);
    const cardId = BoardCardId.make(`card-${tag}`);
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`cmd-project-${tag}`),
      projectId,
      title: `Project ${tag}`,
      workspaceRoot: `/tmp/${tag}`,
      defaultModelSelection: { instanceId: instance, model: "gpt-5-codex" },
      createdAt: t0,
    });
    yield* engine.dispatch({
      type: "board.card.create",
      commandId: CommandId.make(`cmd-card-${tag}`),
      cardId,
      projectId,
      title: `Card ${tag}`,
      createdAt: t0,
    });
    const threadId = yield* createThread(projectId, `thread-${tag}`);
    yield* engine.dispatch({
      type: "board.card.link-thread",
      commandId: CommandId.make(`cmd-link-${tag}`),
      cardId,
      threadId,
      role,
      createdAt: t0,
    });
    return { cardId, threadId, projectId };
  });

const createThread = (projectId: ProjectId, id: string) =>
  Effect.gen(function* () {
    const engine = yield* boardStackEngine;
    const threadId = ThreadId.make(id);
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-${id}`),
      threadId,
      projectId,
      title: id,
      modelSelection: { instanceId: instance, model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: t0,
    });
    return threadId;
  });

let eventCount = 0;
/** One provider turn as the adapter reports it, written to the engine's log. Its ordinal
    is the number at the end of its id. */
const writeTurn = (
  threadId: ThreadId,
  turnId: string,
  status: "running" | "completed",
  usage: {
    readonly input: number;
    readonly output: number;
    readonly usageStatus?: "complete" | "partial";
    readonly hasSubagents?: boolean;
    readonly otherUsage?: { readonly inputTokens: number; readonly outputTokens: number };
  } | null,
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    yield* sink
      .write({
        events: [
          {
            type: "provider-turn.updated",
            id: EventId.make(`evt-${turnId}-${String((eventCount += 1))}`),
            threadId,
            occurredAt: DateTime.makeUnsafe(t0),
            payload: {
              id: ProviderTurnId.make(turnId),
              providerThreadId: ProviderThreadId.make(`provider-${threadId}`),
              nodeId: NodeId.make(`node-${turnId}`),
              runAttemptId: RunAttemptId.make(`attempt-${turnId}`),
              nativeTurnRef: null,
              ordinal: Number(/\d+$/.exec(turnId)?.[0] ?? "1"),
              status,
              startedAt: DateTime.makeUnsafe(t0),
              completedAt: status === "running" ? null : DateTime.makeUnsafe(t0),
              ...(usage === null
                ? {}
                : {
                    turnTokenUsage: {
                      usageScope: "main_agent",
                      usageStatus: usage.usageStatus ?? "complete",
                      inputTokens: usage.input,
                      outputTokens: usage.output,
                      hasSubagents: usage.hasSubagents ?? false,
                      ...(usage.otherUsage === undefined ? {} : { otherUsage: usage.otherUsage }),
                    },
                  }),
            },
          } as unknown as OrchestrationV2DomainEvent,
        ],
      })
      .pipe(Effect.orDie);
  });

const usageRows = (cardId: BoardCardId) =>
  Effect.flatMap(BoardQueries, (queries) => queries.boardCardDetail(cardId)).pipe(
    Effect.map((detail) => detail?.usage ?? []),
  );

it.layer(makeBoardStackTestLayerWithoutTail("t3o-board-usage-"))("board usage recorder", (it) => {
  it.effect("marks a card partial when a priced turn reported only part of its usage", () =>
    Effect.gen(function* () {
      const { cardId, threadId } = yield* seedLinkedThread("partial");
      yield* withRecorder(
        Effect.gen(function* () {
          yield* writeTurn(threadId, "turn-partial", "completed", {
            input: 1_000_000,
            output: 0,
            usageStatus: "partial",
          });
          yield* (yield* BoardThreadTail).drain;
        }),
      );
      const rows = yield* usageRows(cardId);
      assert.deepStrictEqual(
        rows.map((row) => [row.costUsd, row.turnsListPriced, row.turnsPartial]),
        [[1, 1, 1]],
      );
      const summary = yield* (yield* BoardQueries).boardCardUsageSummary(cardId);
      assert.deepInclude(summary, { costKnown: true, estimated: true, partial: true });
    }),
  );

  it.effect("records a finished turn once, against its thread's card and step", () =>
    Effect.gen(function* () {
      const { cardId, threadId } = yield* seedLinkedThread("once");
      yield* withRecorder(
        Effect.gen(function* () {
          const tail = yield* BoardThreadTail;
          yield* writeTurn(threadId, "turn-once", "running", null);
          yield* writeTurn(threadId, "turn-once", "completed", {
            input: 1_000_000,
            output: 100_000,
          });
          // The engine rewrites a finished turn in place; it must not count twice.
          yield* writeTurn(threadId, "turn-once", "completed", {
            input: 1_000_000,
            output: 100_000,
          });
          yield* tail.drain;
        }),
      );
      const rows = yield* usageRows(cardId);
      assert.strictEqual(rows.length, 1);
      assert.deepInclude(rows[0], {
        stepId: "building",
        threadId,
        model: "gpt-5-codex",
        uncachedInputTokens: 1_000_000,
        outputTokens: 100_000,
        costUsd: 2,
        turnsListPriced: 1,
        turnsNoUsage: 0,
        turnsPartial: 0,
      });
      const summary = yield* (yield* BoardQueries).boardCardUsageSummary(cardId);
      assert.deepStrictEqual(summary, {
        tokens: 1_100_000,
        costUsd: 2,
        costKnown: true,
        estimated: true,
        providers: [{ provider: "codex", tokens: 1_100_000, costUsd: 2, estimated: true }],
      });
    }),
  );

  it.effect("counts a turn that reported nothing as no usage, so the figure is partial", () =>
    Effect.gen(function* () {
      const { cardId, threadId } = yield* seedLinkedThread("empty");
      yield* withRecorder(
        Effect.gen(function* () {
          yield* writeTurn(threadId, "turn-empty", "completed", null);
          yield* (yield* BoardThreadTail).drain;
        }),
      );
      const summary = yield* (yield* BoardQueries).boardCardUsageSummary(cardId);
      assert.deepInclude(summary, { tokens: 0, costUsd: 0, partial: true });
      assert.isUndefined(summary?.costKnown);
    }),
  );

  it.effect("replaces a turn's no-usage count when a later finished event carries usage", () =>
    Effect.gen(function* () {
      const { cardId, threadId } = yield* seedLinkedThread("stopped");
      yield* withRecorder(
        Effect.gen(function* () {
          // A stop settles the turn from the projection first, with no usage.
          yield* writeTurn(threadId, "turn-stopped", "completed", null);
          yield* writeTurn(threadId, "turn-stopped", "completed", { input: 1_000_000, output: 0 });
          // A replay of either event changes nothing.
          yield* writeTurn(threadId, "turn-stopped", "completed", null);
          yield* writeTurn(threadId, "turn-stopped", "completed", { input: 1_000_000, output: 0 });
          yield* (yield* BoardThreadTail).drain;
        }),
      );
      const rows = yield* usageRows(cardId);
      assert.deepStrictEqual(
        rows.map((row) => [row.uncachedInputTokens, row.turnsListPriced, row.turnsNoUsage]),
        [[1_000_000, 1, 0]],
      );
      const summary = yield* (yield* BoardQueries).boardCardUsageSummary(cardId);
      assert.deepInclude(summary, { tokens: 1_000_000, costUsd: 1 });
      assert.isUndefined(summary?.partial);
    }),
  );

  it.effect("credits a delegated child's turn to the card and step it was delegated from", () =>
    Effect.gen(function* () {
      const { cardId, threadId, projectId } = yield* seedLinkedThread("delegate", "review@2");
      const child = yield* createThread(projectId, "thread-delegate-child");
      const signal: UsageSignal = {
        type: "usage-recorded",
        threadId: child,
        providerTurnId: "turn-child",
        driver: "claudeAgent",
        model: "custom-model",
        delegationChain: [threadId],
        usage: { usageStatus: "complete", inputTokens: 1_000_000, outputTokens: 0 },
      };
      // A delegate's delegate: its nearest parent is the unlinked child.
      const grandchild: UsageSignal = {
        ...signal,
        threadId: ThreadId.make("thread-delegate-grandchild"),
        providerTurnId: "turn-grandchild",
        delegationChain: [child, threadId],
      };
      const stray: UsageSignal = {
        ...signal,
        threadId: ThreadId.make("thread-nobody"),
        delegationChain: [],
      };
      yield* withRecorder(
        Effect.gen(function* () {
          const recorder = yield* BoardUsageRecorder;
          const sql = yield* SqlClient.SqlClient;
          const landed = yield* sql.withTransaction(recorder.store(yield* recorder.price(signal)));
          assert.strictEqual(landed, cardId);
          // Stored once: a replay of the same turn lands nowhere.
          assert.isNull(yield* sql.withTransaction(recorder.store(yield* recorder.price(signal))));
          assert.strictEqual(
            yield* sql.withTransaction(recorder.store(yield* recorder.price(grandchild))),
            cardId,
          );
          // A thread no card owns is not the board's to count, nor to price.
          assert.isNull(yield* recorder.price(stray));
        }),
      );
      const rows = yield* usageRows(cardId);
      assert.deepStrictEqual(
        rows.map((row) => [row.stepId, row.threadId, row.provider, row.costUsd, row.turnsOverride]),
        [
          ["review@2", child, "claudeAgent", 2, 1],
          ["review@2", ThreadId.make("thread-delegate-grandchild"), "claudeAgent", 2, 1],
        ],
      );
      assert.isUndefined((yield* (yield* BoardQueries).boardCardUsageSummary(cardId))?.estimated);
    }),
  );

  it.effect("backfills this server's existing turns once, and a second run adds nothing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { cardId, threadId } = yield* seedLinkedThread("backfill");
      // Turns that finished before the board recorded usage: no tail is running.
      yield* writeTurn(threadId, "turn-old-1", "completed", { input: 500_000, output: 0 });
      yield* writeTurn(threadId, "turn-old-2", "completed", { input: 500_000, output: 0 });
      yield* writeTurn(threadId, "turn-old-3", "running", null);
      yield* withRecorder(Effect.flatMap(BoardUsageRecorder, (recorder) => recorder.backfill));
      const once = yield* usageRows(cardId);
      assert.deepStrictEqual(
        once.map((row) => [row.uncachedInputTokens, row.turnsListPriced]),
        [[1_000_000, 2]],
      );
      const [marker] = yield* sql<{ readonly n: number }>`
        SELECT last_applied_sequence AS n FROM boards.projection_state
        WHERE projector = ${BOARD_USAGE_BACKFILL_MARKER}`;
      assert.strictEqual(marker?.n, 1);

      // A re-run behind a cleared marker still counts nothing twice.
      yield* sql`DELETE FROM boards.projection_state WHERE projector = ${BOARD_USAGE_BACKFILL_MARKER}`;
      yield* withRecorder(Effect.flatMap(BoardUsageRecorder, (recorder) => recorder.backfill));
      assert.deepStrictEqual(yield* usageRows(cardId), once);

      // A deleted card takes its usage with it.
      yield* (yield* boardStackEngine).dispatch({
        type: "board.card.delete",
        commandId: CommandId.make("cmd-delete-backfill"),
        cardId,
        createdAt: t0,
      });
      const [left] = yield* sql<{ readonly rows: number; readonly keys: number }>`
        SELECT
          (SELECT COUNT(*) FROM boards.board_card_usage WHERE card_id = ${cardId}) AS rows,
          (SELECT COUNT(*) FROM boards.board_usage_ingested WHERE thread_id = ${threadId}) AS keys`;
      assert.deepStrictEqual(left, { rows: 0, keys: 0 });
    }),
  );
  it.effect("migration 069 re-prices the usage the backfill can rebuild, and drops the rest", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { cardId, threadId, projectId } = yield* seedLinkedThread("reprice");
      const child = yield* createThread(projectId, "thread-reprice-child");
      yield* sql`
        INSERT INTO orchestration_v2_projection_subagents (
          subagent_id, thread_id, parent_node_id, provider, child_thread_id, origin, status,
          updated_at, payload_json
        ) VALUES (
          'subagent-reprice', ${threadId}, 'node-reprice', 'codex', ${child}, 'app_owned',
          'completed', ${t0}, '{}'
        )
      `;
      // A resumed process booked its restored session totals as this turn's otherUsage.
      yield* writeTurn(threadId, "turn-reprice-1", "completed", {
        input: 1_000_000,
        output: 0,
        otherUsage: { inputTokens: 82_000_000, outputTokens: 0 },
      });
      yield* writeTurn(child, "turn-reprice-child-1", "completed", { input: 500_000, output: 0 });
      const worker = ThreadId.make("thread-reprice-worker");
      const tombstoned = ThreadId.make("thread-reprice-tombstoned");
      // Unlinked from the card after it booked usage: the backfill cannot credit it again.
      const unlinked = yield* createThread(projectId, "thread-reprice-unlinked");
      yield* sql`
        INSERT INTO boards.board_card_thread_links
          (thread_id, card_id, role, linked_at, tombstoned_at, worker_id)
        VALUES
          (${worker}, ${cardId}, 'review@1', ${t0}, NULL, 'worker-1'),
          (${tombstoned}, ${cardId}, 'planning', ${t0}, ${t0}, NULL)
      `;
      // What the old pricing stored for each thread, with every turn already ingested.
      for (const [thread, step] of [
        [threadId, "building"],
        [child, "building"],
        [worker, "review@1"],
        [tombstoned, "planning"],
        [unlinked, "building"],
      ] as const) {
        yield* sql`
          INSERT INTO boards.board_card_usage (
            card_id, step_id, thread_id, provider, model, uncached_input, cost_micro_usd,
            turns_list_priced, updated_at
          ) VALUES (${cardId}, ${step}, ${thread}, 'codex', 'gpt-5-codex', 83000000, 83000000, 1, ${t0})
        `;
        yield* sql`
          INSERT INTO boards.board_usage_ingested (thread_id, provider_turn_id)
          VALUES (${thread}, ${`turn-${thread}`})
        `;
      }
      yield* sql`
        INSERT OR REPLACE INTO boards.projection_state (projector, last_applied_sequence, updated_at)
        VALUES (${BOARD_USAGE_BACKFILL_MARKER}, 1, ${t0})
      `;

      const migration = BOARD_MIGRATIONS.find(([id]) => id === 69);
      assert.ok(migration, "migration 069 is registered in the lineage");
      yield* migration[2];
      yield* withRecorder(Effect.flatMap(BoardUsageRecorder, (recorder) => recorder.backfill));

      const rows = yield* sql<{
        readonly threadId: string;
        readonly uncached: number;
        readonly cost: number;
        readonly partial: number;
      }>`
        SELECT thread_id AS "threadId", uncached_input AS uncached, cost_micro_usd AS cost,
          turns_partial AS partial
        FROM boards.board_card_usage WHERE card_id = ${cardId} ORDER BY thread_id
      `;
      assert.deepStrictEqual(rows, [
        { threadId: "thread-reprice", uncached: 1_000_000, cost: 1_000_000, partial: 1 },
        { threadId: "thread-reprice-child", uncached: 500_000, cost: 500_000, partial: 0 },
        { threadId: worker, uncached: 83_000_000, cost: 83_000_000, partial: 0 },
      ]);
      const [card] = yield* sql<{ readonly partial: number }>`
        SELECT usage_history_partial AS partial FROM boards.board_cards WHERE card_id = ${cardId}
      `;
      assert.strictEqual(card?.partial, 1, "dropped rows leave the card a labelled lower bound");
      const ingested = yield* sql<{ readonly threadId: string; readonly turnId: string }>`
        SELECT thread_id AS "threadId", provider_turn_id AS "turnId"
        FROM boards.board_usage_ingested
        WHERE thread_id IN (${threadId}, ${child}, ${worker}, ${tombstoned}, ${unlinked})
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(ingested, [
        { threadId: "thread-reprice", turnId: "turn-reprice-1" },
        { threadId: "thread-reprice-child", turnId: "turn-reprice-child-1" },
        { threadId: worker, turnId: `turn-${worker}` },
      ]);
    }),
  );
});
