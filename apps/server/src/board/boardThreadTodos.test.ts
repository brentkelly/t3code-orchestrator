/**
 * T3o thread todo cache + Activity rail (t3o-18).
 *
 * Drives the real engine and projection: a `turn.plan.updated` thread activity
 * lands in `board_thread_todos` when — and only when — the emitting thread has a
 * live card link, the caps hold, elapsed time survives reordering, the sweeps
 * fire, and the Activity rail records the nine curated kinds with the actor the
 * dispatch boundary stamped.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { boardHumanActor, stampBoardActivityActor } from "./activityActors.ts";
import { boardSnapshotQueryMethodsOf } from "./projection.ts";

const makeLayer = (prefix: string) =>
  Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
    ServerSettings.layerTest(),
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

const t0 = "2026-01-01T00:00:00.000Z";
const at = (minute: number) => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z` as const;

const projectId = ProjectId.make("project-a");
const instance = ProviderInstanceId.make("codex");

/** One `it.layer` block shares a database, so every test gets its own card and
    threads — ids derived from the test's tag — and the project create is
    idempotent by its fixed command id (the engine's receipt dedup). */
interface Fixture {
  readonly cardId: BoardCardId;
  readonly linkedThread: ThreadId;
  readonly orphanThread: ThreadId;
}

const fixtureFor = (tag: string): Fixture => ({
  cardId: BoardCardId.make(`card-${tag}`),
  linkedThread: ThreadId.make(`thread-${tag}`),
  orphanThread: ThreadId.make(`orphan-${tag}`),
});

let commandSeq = 0;
const nextCommandId = () => CommandId.make(`cmd-live-${(commandSeq += 1)}`);

const planActivity = (
  id: string,
  plan: ReadonlyArray<{ readonly step: string; readonly status: string }>,
  createdAt: string,
): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  tone: "info",
  kind: "turn.plan.updated",
  summary: "Plan updated",
  payload: { plan },
  turnId: null,
  createdAt,
});

const seed = Effect.fn("seed")(function* (tag: string) {
  const fixture = fixtureFor(tag);
  const engine = yield* OrchestrationEngineService;
  // Fixed command id: the second test's create is an idempotent no-op.
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-project"),
    projectId,
    title: "Project A",
    workspaceRoot: "/tmp/project-a",
    defaultModelSelection: { instanceId: instance, model: "gpt-5-codex" },
    createdAt: t0,
  });
  yield* engine.dispatch({
    type: "board.card.create",
    commandId: CommandId.make(`cmd-card-${tag}`),
    cardId: fixture.cardId,
    projectId,
    title: `Card ${tag}`,
    orderKey: "m",
    createdAt: t0,
  });
  for (const threadId of [fixture.linkedThread, fixture.orphanThread]) {
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-thread-${threadId}`),
      threadId,
      projectId,
      title: `Thread ${threadId}`,
      modelSelection: { instanceId: instance, model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: t0,
    });
  }
  yield* engine.dispatch({
    type: "board.card.link-thread",
    commandId: CommandId.make(`cmd-link-${tag}`),
    cardId: fixture.cardId,
    threadId: fixture.linkedThread,
    role: "planning",
    createdAt: t0,
  });
  return fixture;
});

const appendPlan = (
  threadId: ThreadId,
  id: string,
  plan: ReadonlyArray<{ readonly step: string; readonly status: string }>,
  createdAt: string,
) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: nextCommandId(),
      threadId,
      activity: planActivity(id, plan, createdAt),
      createdAt,
    });
  });

const boardMethods = Effect.gen(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const methods = boardSnapshotQueryMethodsOf(snapshotQuery);
  assert.isNotNull(methods);
  return methods!;
});

const cardThreads = (cardId: BoardCardId) =>
  Effect.gen(function* () {
    const methods = yield* boardMethods;
    return yield* methods.boardCardThreads(cardId);
  });

it.layer(makeLayer("t3o-board-todos-"))("board thread todos (t3o-18)", (it) => {
  it.effect("AC 1: a linked thread's plan is cached; an unlinked thread's is not", () =>
    Effect.gen(function* () {
      const { cardId, linkedThread, orphanThread } = yield* seed("ac1");
      yield* appendPlan(
        linkedThread,
        "ac1-1",
        [
          { step: "Read the brief", status: "completed" },
          { step: "Write the code", status: "inProgress" },
          { step: "Ship it", status: "pending" },
        ],
        at(1),
      );
      // An unlinked thread emitting the same plan writes nothing.
      yield* appendPlan(orphanThread, "ac1-2", [{ step: "Nothing", status: "pending" }], at(1));

      const entries = yield* cardThreads(cardId);
      assert.strictEqual(entries.length, 1);
      const entry = entries[0]!;
      assert.strictEqual(entry.threadId, linkedThread);
      assert.strictEqual(entry.todoStatuses, "dip");
      assert.strictEqual(entry.todoDone, 1);
      assert.strictEqual(entry.todoTotal, 3);
      assert.strictEqual(entry.todoCurrent, "Write the code");

      const methods = yield* boardMethods;
      assert.isNull(yield* methods.boardThreadTodo(orphanThread));
    }),
  );

  it.effect("AC 4/5: 47 items store 30 status chars, still report n/47, in true positions", () =>
    Effect.gen(function* () {
      const { cardId, linkedThread } = yield* seed("ac4");
      // Out-of-order completion: items 0 and 5 done, 2 in progress, rest pending.
      const plan = Array.from({ length: 47 }, (_, index) => ({
        step: `Item ${index}`,
        status: index === 0 || index === 5 ? "completed" : index === 2 ? "inProgress" : "pending",
      }));
      yield* appendPlan(linkedThread, "ac4-1", plan, at(1));

      const entry = (yield* cardThreads(cardId))[0]!;
      assert.strictEqual(entry.todoStatuses?.length, 30);
      // TRUE counts survive the cap, and the pips sit where the items really are.
      assert.strictEqual(entry.todoDone, 2);
      assert.strictEqual(entry.todoTotal, 47);
      assert.strictEqual(entry.todoStatuses?.[0], "d");
      assert.strictEqual(entry.todoStatuses?.[2], "i");
      assert.strictEqual(entry.todoStatuses?.[5], "d");
      assert.strictEqual(entry.todoStatuses?.[1], "p");
    }),
  );

  it.effect("AC 7: reordering keeps the elapsed anchor; rewording the current item resets it", () =>
    Effect.gen(function* () {
      const { cardId, linkedThread } = yield* seed("ac7");
      yield* appendPlan(
        linkedThread,
        "ac7-1",
        [
          { step: "Alpha", status: "inProgress" },
          { step: "Beta", status: "pending" },
        ],
        at(1),
      );
      assert.strictEqual((yield* cardThreads(cardId))[0]!.todoStartedAt, at(1));

      // Reorder + insert around the SAME in-progress text: the anchor holds.
      yield* appendPlan(
        linkedThread,
        "ac7-2",
        [
          { step: "Gamma", status: "pending" },
          { step: "Beta", status: "completed" },
          { step: "Alpha", status: "inProgress" },
        ],
        at(5),
      );
      assert.strictEqual((yield* cardThreads(cardId))[0]!.todoStartedAt, at(1));

      // Rewording the in-progress item is indistinguishable from moving on, so
      // it resets — wrong, harmless, and rare (D6).
      yield* appendPlan(
        linkedThread,
        "ac7-3",
        [
          { step: "Beta", status: "completed" },
          { step: "Alpha, revised", status: "inProgress" },
        ],
        at(9),
      );
      assert.strictEqual((yield* cardThreads(cardId))[0]!.todoStartedAt, at(9));
    }),
  );

  it.effect("D16: the stall-reset signal moves only when the list actually advances", () =>
    Effect.gen(function* () {
      const { linkedThread } = yield* seed("d16");
      const methods = yield* boardMethods;
      yield* appendPlan(
        linkedThread,
        "d16-1",
        [
          { step: "Alpha", status: "inProgress" },
          { step: "Beta", status: "pending" },
        ],
        at(1),
      );
      assert.strictEqual((yield* methods.boardThreadTodo(linkedThread))?.advancedAt, at(1));

      // A revision that neither ticks an item nor changes the current one is not
      // progress — a frozen list reads exactly like no list (D16).
      yield* appendPlan(
        linkedThread,
        "d16-2",
        [
          { step: "Alpha", status: "inProgress" },
          { step: "Beta", status: "pending" },
          { step: "Gamma", status: "pending" },
        ],
        at(5),
      );
      assert.strictEqual((yield* methods.boardThreadTodo(linkedThread))?.advancedAt, at(1));

      // Ticking one does advance it.
      yield* appendPlan(
        linkedThread,
        "d16-3",
        [
          { step: "Alpha", status: "completed" },
          { step: "Beta", status: "inProgress" },
        ],
        at(9),
      );
      const advanced = yield* methods.boardThreadTodo(linkedThread);
      assert.strictEqual(advanced?.advancedAt, at(9));
      assert.strictEqual(advanced?.hasList, true);
    }),
  );

  it.effect("AC 19: unlinking the thread drops its cached list", () =>
    Effect.gen(function* () {
      const { cardId, linkedThread } = yield* seed("ac19a");
      const engine = yield* OrchestrationEngineService;
      const methods = yield* boardMethods;
      yield* appendPlan(linkedThread, "ac19a-1", [{ step: "Alpha", status: "pending" }], at(1));
      assert.isNotNull(yield* methods.boardThreadTodo(linkedThread));

      yield* engine.dispatch({
        type: "board.card.unlink-thread",
        commandId: nextCommandId(),
        cardId,
        threadId: linkedThread,
        createdAt: at(2),
      });
      assert.isNull(yield* methods.boardThreadTodo(linkedThread));
      assert.strictEqual((yield* cardThreads(cardId)).length, 0);
    }),
  );

  it.effect("AC 19: archiving the card drops every cached list on it", () =>
    Effect.gen(function* () {
      const { cardId, linkedThread } = yield* seed("ac19b");
      const engine = yield* OrchestrationEngineService;
      const methods = yield* boardMethods;
      yield* appendPlan(linkedThread, "ac19b-1", [{ step: "Alpha", status: "pending" }], at(1));
      yield* engine.dispatch({
        type: "board.card.archive",
        commandId: nextCommandId(),
        cardId,
        createdAt: at(2),
      });
      assert.isNull(yield* methods.boardThreadTodo(linkedThread));
    }),
  );

  it.effect("AC 20: the boot sweep removes rows whose thread no longer exists", () =>
    Effect.gen(function* () {
      const { linkedThread } = yield* seed("ac20");
      const engine = yield* OrchestrationEngineService;
      const methods = yield* boardMethods;
      yield* appendPlan(linkedThread, "ac20-1", [{ step: "Alpha", status: "pending" }], at(1));

      yield* engine.dispatch({
        type: "thread.delete",
        commandId: nextCommandId(),
        threadId: linkedThread,
      });
      // Whatever the live path did, the sweep is the backstop for the case where
      // the delete landed while the server was down.
      yield* methods.boardSweepThreadTodos();
      assert.isNull(yield* methods.boardThreadTodo(linkedThread));
    }),
  );

  it.effect("AC 15/16: the rail records the curated kinds with the stamped actor", () =>
    Effect.gen(function* () {
      const { cardId } = yield* seed("ac15");
      const engine = yield* OrchestrationEngineService;
      const methods = yield* boardMethods;

      // A human drag: the dispatch boundary stamps the actor first (D11).
      const moveCommandId = nextCommandId();
      stampBoardActivityActor(moveCommandId, boardHumanActor("brent"));
      yield* engine.dispatch({
        type: "board.card.move",
        commandId: moveCommandId,
        cardId,
        toStage: BOARD_SEED_STAGE_IDS.sprint,
        createdAt: at(1),
      });
      // An internally-dispatched command carries no stamp at all.
      yield* engine.dispatch({
        type: "board.card.move",
        commandId: nextCommandId(),
        cardId,
        toStage: BOARD_SEED_STAGE_IDS.planning,
        createdAt: at(2),
      });
      yield* engine.dispatch({
        type: "board.plans.propose",
        commandId: nextCommandId(),
        cardId,
        plans: [{ key: "a", title: "Plan A", summary: "s", dependsOn: [], body: "body" }],
        createdAt: at(3),
      });
      // Excluded from the rail (D12): a reorder is not a milestone.
      yield* engine.dispatch({
        type: "board.card.reorder",
        commandId: nextCommandId(),
        cardId,
        orderKey: "n",
        createdAt: at(4),
      });

      const activity = yield* methods.boardCardActivity(cardId);
      assert.deepStrictEqual(
        activity.map((entry) => entry.kind),
        ["card-created", "card-moved", "card-moved", "plans-proposed"],
      );
      const [, humanMove, systemMove, plans] = activity;
      assert.strictEqual(humanMove?.actor.kind, "human");
      assert.strictEqual(humanMove?.actor.name, "brent");
      assert.strictEqual(humanMove?.payload.toStage, BOARD_SEED_STAGE_IDS.sprint);
      assert.strictEqual(humanMove?.payload.fromStage, BOARD_SEED_STAGE_IDS.backlog);
      // No stamp → the system actor, never an invented human.
      assert.strictEqual(systemMove?.actor.kind, "system");
      assert.strictEqual(systemMove?.actor.name, null);
      assert.strictEqual(plans?.payload.planCount, 1);
    }),
  );
});
