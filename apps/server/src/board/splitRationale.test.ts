/**
 * T3o card 11 — the split justification on the card.
 *
 * A multi-plan proposal splits the card into child cards behind a human
 * approval gate, so the decider makes it carry a reason. That reason has to
 * reach the human at the gate, which means it has to survive both paths into
 * the read model: the SQL projection (migration 035's `split_rationale`) and a
 * from-empty replay of the log. Those two agreeing is the whole property —
 * a card that shows its split reason after an edit but not after a reconnect
 * is the stale label this codebase refuses to ship.
 *
 * Run through the real seams (decider → event store → projection → snapshot
 * query), because that is where the two producers meet.
 */
import {
  BoardCardId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { createEmptyReadModel, projectEvent } from "../orchestration/projector.ts";
import { ServerConfig } from "../config.ts";

const makeTestLayer = (prefix: string) =>
  Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(NodeServices.layer),
  );

const createdAt = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-split");
const cardId = BoardCardId.make("card-split");

const WHY =
  "The migration and the pane land on separate branches and are worth reviewing one at a time.";

const seedCard = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-project"),
    projectId,
    title: "Split Project",
    workspaceRoot: "/tmp/project-split",
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt,
  });
  yield* engine.dispatch({
    type: "board.card.create",
    commandId: CommandId.make("cmd-create"),
    cardId,
    projectId,
    title: "A card that might split",
    orderKey: "m",
    createdAt,
  });
  return engine;
});

const plan = (key: string, dependsOn: ReadonlyArray<string> = []) => ({
  key,
  title: key,
  summary: "s",
  dependsOn,
  body: `# ${key}`,
});

/** The card as the tables hold it. */
const rehydratedCard = Effect.gen(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const model = yield* snapshotQuery.getCommandReadModel();
  return model.board?.cards.find((card) => card.id === cardId);
});

/** The card a from-empty replay of the whole log arrives at. */
const replayedCard = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const events: OrchestrationEvent[] = Array.from(yield* Stream.runCollect(engine.readEvents(0)));
  let replayed = createEmptyReadModel(createdAt);
  for (const event of events) {
    replayed = yield* projectEvent(replayed, event);
  }
  return replayed.board?.cards.find((card) => card.id === cardId);
});

it.layer(makeTestLayer("t3o-split-rationale-1-"))("a split's rationale", (it) => {
  it.effect("reaches the card on both the projection and a from-empty replay", () =>
    Effect.gen(function* () {
      const engine = yield* seedCard;
      assert.strictEqual(
        (yield* rehydratedCard)?.splitRationale,
        null,
        "a card that has never planned has no rationale",
      );

      yield* engine.dispatch({
        type: "board.plans.propose",
        commandId: CommandId.make("cmd-split"),
        cardId,
        plans: [plan("one"), plan("two", ["one"])],
        splitRationale: WHY,
        createdAt,
      });

      assert.strictEqual((yield* rehydratedCard)?.splitRationale, WHY);
      // The two producers agree, which is the property this file exists for.
      assert.deepStrictEqual(yield* replayedCard, yield* rehydratedCard);
    }),
  );
});

it.layer(makeTestLayer("t3o-split-rationale-2-"))("re-planning down to one plan", (it) => {
  it.effect("clears the rationale in the same stroke that clears the split", () =>
    Effect.gen(function* () {
      // A card re-planned down to a single plan is no longer split, so a
      // rationale left behind would argue for a gate that is no longer there.
      const engine = yield* seedCard;
      yield* engine.dispatch({
        type: "board.plans.propose",
        commandId: CommandId.make("cmd-split"),
        cardId,
        plans: [plan("one"), plan("two", ["one"])],
        splitRationale: WHY,
        createdAt,
      });
      assert.strictEqual((yield* rehydratedCard)?.splitRationale, WHY);

      yield* engine.dispatch({
        type: "board.plans.propose",
        commandId: CommandId.make("cmd-resplit"),
        cardId,
        plans: [plan("one")],
        // Passed and ignored: below two plans the decider forces null, so
        // "non-null" keeps meaning "the last proposal split this card".
        splitRationale: WHY,
        createdAt,
      });

      assert.strictEqual((yield* rehydratedCard)?.splitRationale, null);
      assert.deepStrictEqual(yield* replayedCard, yield* rehydratedCard);
    }),
  );
});

it.layer(makeTestLayer("t3o-split-rationale-3-"))("a log written before migration 035", (it) => {
  it.effect("replays a rationale-less plans-proposed payload to null", () =>
    Effect.gen(function* () {
      // The pre-035 shape: a `board.plans-proposed` payload with no
      // `splitRationale` key at all. It must decode to null, or a from-empty
      // replay of an older log would diverge from the rehydrated tables.
      const engine = yield* seedCard;
      yield* engine.dispatch({
        type: "board.plans.propose",
        commandId: CommandId.make("cmd-plan"),
        cardId,
        plans: [plan("one")],
        splitRationale: null,
        createdAt,
      });
      const events: OrchestrationEvent[] = Array.from(
        yield* Stream.runCollect(engine.readEvents(0)),
      );
      const legacy = events.map((event) =>
        event.type === "board.plans-proposed"
          ? {
              ...event,
              payload: (({ splitRationale: _dropped, ...rest }) => rest)(
                event.payload as { readonly splitRationale?: unknown },
              ),
            }
          : event,
      ) as ReadonlyArray<OrchestrationEvent>;
      assert.isTrue(
        legacy.some((event) => event.type === "board.plans-proposed"),
        "the log must actually hold the event this test strips",
      );

      let replayed = createEmptyReadModel(createdAt);
      for (const event of legacy) {
        replayed = yield* projectEvent(replayed, event);
      }
      const card = replayed.board?.cards.find((entry) => entry.id === cardId);
      assert.strictEqual(card?.splitRationale, null);
      assert.deepStrictEqual(card, yield* rehydratedCard);
    }),
  );
});
