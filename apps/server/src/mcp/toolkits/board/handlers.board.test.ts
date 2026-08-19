/**
 * T3o board MCP toolkit — handler integration (t3o-08, D3/D8).
 *
 * Drives the real board tool handlers against the real orchestration engine
 * and projection: a linked thread resolves its own card with no card id in the
 * payload; an unlinked thread is rejected with an actionable message; the
 * completion contract is idempotent (twice → one transition); and the plan
 * tools validate, store and read back. Every write goes MCP handler → command
 * → decider → event → projector → table, so this exercises the whole write
 * path end to end.
 */
import {
  BoardCardId,
  boardPlanId,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { createEmptyReadModel, projectEvent } from "../../../orchestration/projector.ts";
import { ServerConfig } from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import { boardHandlers } from "./handlers.ts";

const makeLayer = (prefix: string) =>
  Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
    // The create tool reads (and may assign) the project's key prefix from
    // board settings (D14) — an in-memory settings runtime is enough.
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
const projectId = ProjectId.make("project-a");
const cardId = BoardCardId.make("card-1");
const linkedThread = ThreadId.make("thread-linked");
const orphanThread = ThreadId.make("thread-orphan");

const scopeFor = (threadId: ThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("env-1"),
  threadId,
  providerSessionId: "sess-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["board"]),
  issuedAt: 0,
});

const withScope = (threadId: ThreadId) =>
  Effect.provideService(McpInvocationContext.McpInvocationContext, scopeFor(threadId));

/** Create a project, a card, a real thread, and link the thread to the card,
    so a handler call from `linkedThread` resolves `card-1`. */
const seed = Effect.fn("seed")(function* () {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-project"),
    projectId,
    title: "Project A",
    workspaceRoot: "/tmp/project-a",
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    createdAt: t0,
  });
  yield* engine.dispatch({
    type: "board.card.create",
    commandId: CommandId.make("cmd-card"),
    cardId,
    projectId,
    title: "First card",
    orderKey: "m",
    createdAt: t0,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("cmd-thread"),
    threadId: linkedThread,
    projectId,
    title: "Planning thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: t0,
  });
  yield* engine.dispatch({
    type: "board.card.link-thread",
    commandId: CommandId.make("cmd-link"),
    cardId,
    threadId: linkedThread,
    role: "planning",
    createdAt: t0,
  });
});

it.layer(makeLayer("t3o-board-mcp-test-"))("board mcp toolkit", (it) => {
  it.effect("resolves the caller's card from its thread with no card id in the payload", () =>
    Effect.gen(function* () {
      yield* seed();
      const context = yield* boardHandlers.board_get_card_context().pipe(withScope(linkedThread));
      assert.strictEqual(context.card.id, cardId);
      assert.strictEqual(context.card.key, "CARD-1");
    }),
  );

  it.effect("rejects a card-scoped tool from an unlinked thread with an actionable message", () =>
    Effect.gen(function* () {
      yield* seed();
      const failure = yield* Effect.flip(
        boardHandlers.board_get_card_context().pipe(withScope(orphanThread)),
      );
      assert.strictEqual(failure.code, "thread-not-linked");
      assert.include(failure.message, "adopt");
    }),
  );

  it.effect("records progress and surfaces it in the card context", () =>
    Effect.gen(function* () {
      yield* seed();
      yield* boardHandlers
        .board_report_progress({ note: "Started planning" })
        .pipe(withScope(linkedThread));
      const context = yield* boardHandlers.board_get_card_context().pipe(withScope(linkedThread));
      assert.strictEqual(context.activity.length, 1);
      assert.strictEqual(context.activity[0]?.kind, "progress");
      assert.strictEqual(context.activity[0]?.body, "Started planning");
    }),
  );

  it.effect("board_complete_step twice produces exactly one completion", () =>
    Effect.gen(function* () {
      yield* seed();
      const first = yield* boardHandlers
        .board_complete_step({ stepId: "build", outcome: "succeeded", summary: "Built" })
        .pipe(withScope(linkedThread));
      assert.strictEqual(first.alreadyCompleted, false);
      const second = yield* boardHandlers
        .board_complete_step({ stepId: "build", outcome: "failed", summary: "Contradiction" })
        .pipe(withScope(linkedThread));
      // The retry is a no-op that returns the first outcome.
      assert.strictEqual(second.alreadyCompleted, true);
      assert.strictEqual(second.outcome, "succeeded");
      const context = yield* boardHandlers.board_get_card_context().pipe(withScope(linkedThread));
      assert.strictEqual(context.steps.length, 1);
      assert.strictEqual(context.steps[0]?.outcome, "succeeded");
    }),
  );

  it.effect("proposes plans, then reads and rewrites a plan body (unlocked)", () =>
    Effect.gen(function* () {
      yield* seed();
      const proposed = yield* boardHandlers
        .board_propose_plans({
          plans: [
            { key: "base", title: "Base", summary: "s", dependsOn: [], body: "base body" },
            { key: "leaf", title: "Leaf", summary: "s", dependsOn: ["base"], body: "leaf body" },
          ],
        })
        .pipe(withScope(linkedThread));
      assert.deepStrictEqual(proposed.planIds, [
        boardPlanId(cardId, "base"),
        boardPlanId(cardId, "leaf"),
      ]);
      const got = yield* boardHandlers
        .board_get_plan({ planId: boardPlanId(cardId, "leaf") })
        .pipe(withScope(linkedThread));
      assert.strictEqual(got.body, "leaf body");
      assert.deepStrictEqual(got.plan.dependsOn, [boardPlanId(cardId, "base")]);
      yield* boardHandlers
        .board_write_plan({ planId: boardPlanId(cardId, "leaf"), body: "rewritten" })
        .pipe(withScope(linkedThread));
      const reread = yield* boardHandlers
        .board_get_plan({ planId: boardPlanId(cardId, "leaf") })
        .pipe(withScope(linkedThread));
      assert.strictEqual(reread.body, "rewritten");
    }),
  );

  it.effect("board_propose_plans rejects a cycle from the handler, naming the edge", () =>
    Effect.gen(function* () {
      yield* seed();
      const failure = yield* Effect.flip(
        boardHandlers
          .board_propose_plans({
            plans: [
              { key: "a", title: "A", summary: "s", dependsOn: ["b"], body: "" },
              { key: "b", title: "B", summary: "s", dependsOn: ["a"], body: "" },
            ],
          })
          .pipe(withScope(linkedThread)),
      );
      assert.strictEqual(failure.code, "rejected");
      assert.include(failure.message, "cycle");
    }),
  );

  it.effect("creates a board-scoped card and lists it; rejects an unknown label name", () =>
    Effect.gen(function* () {
      yield* seed();
      const created = yield* boardHandlers
        .board_create_card({
          projectId,
          title: "Agent-made card",
          brief: "Do the thing",
          stage: "sprint",
          labels: ["feature"],
        })
        .pipe(withScope(orphanThread));
      // The key carries the project's acronym, not the compiled-in default:
      // "Project A" -> PA, the same prefix the client would assign, so agent-
      // and human-created cards share one key namespace (D14).
      assert.strictEqual(created.key, "PA-2");
      const listed = yield* boardHandlers
        .board_list_cards({ stage: "sprint" })
        .pipe(withScope(orphanThread));
      assert.deepStrictEqual(
        listed.cards.map((card) => card.cardId),
        [created.cardId],
      );
      const failure = yield* Effect.flip(
        boardHandlers
          .board_create_card({ projectId, title: "Bad", labels: ["nonexistent-label"] })
          .pipe(withScope(orphanThread)),
      );
      assert.strictEqual(failure.code, "unknown-label");
      assert.include(failure.message, "feature");
    }),
  );

  it.effect("board_create_card rejects an unknown dependency before creating anything", () =>
    Effect.gen(function* () {
      yield* seed();
      const before = yield* boardHandlers.board_list_cards({}).pipe(withScope(orphanThread));
      const failure = yield* Effect.flip(
        boardHandlers
          .board_create_card({
            projectId,
            title: "Depends on a ghost",
            dependsOn: [BoardCardId.make("card-ghost")],
          })
          .pipe(withScope(orphanThread)),
      );
      assert.strictEqual(failure.code, "invalid-input");
      // No half-built card was left behind by the rejected create.
      const after = yield* boardHandlers.board_list_cards({}).pipe(withScope(orphanThread));
      assert.strictEqual(after.cards.length, before.cards.length);
    }),
  );

  it.effect("board_create_card cannot create into Building (D18)", () =>
    Effect.gen(function* () {
      yield* seed();
      const failure = yield* Effect.flip(
        boardHandlers
          .board_create_card({ projectId, title: "Sneaky", stage: "building" })
          .pipe(withScope(orphanThread)),
      );
      assert.strictEqual(failure.code, "rejected");
      assert.include(failure.message, "creation stage");
    }),
  );

  it.effect("board_list_projects returns the seeded project's id, title and workspace root", () =>
    Effect.gen(function* () {
      yield* seed();
      const { projects } = yield* boardHandlers.board_list_projects().pipe(withScope(orphanThread));
      const project = projects.find((candidate) => candidate.projectId === projectId);
      assert.isDefined(project);
      assert.strictEqual(project?.title, "Project A");
      assert.strictEqual(project?.workspaceRoot, "/tmp/project-a");
    }),
  );

  it.effect("board_create_card with no projectId lands in the calling thread's project", () =>
    Effect.gen(function* () {
      yield* seed();
      // linkedThread belongs to project-a; omitting projectId must resolve to
      // it from the thread, not require the agent to know the id.
      const created = yield* boardHandlers
        .board_create_card({ title: "Thread-default card", stage: "sprint" })
        .pipe(withScope(linkedThread));
      const listed = yield* boardHandlers.board_list_cards({}).pipe(withScope(linkedThread));
      const card = listed.cards.find((candidate) => candidate.cardId === created.cardId);
      assert.strictEqual(card?.projectId, projectId);
    }),
  );

  it.effect("board_create_card resolves a project by title and by workspace folder name", () =>
    Effect.gen(function* () {
      yield* seed();
      // A value copied from the app — the title, or a path whose last segment
      // is the workspace folder — resolves to the id (orphanThread has no
      // project of its own, so only the passed value can resolve it).
      const byTitle = yield* boardHandlers
        .board_create_card({ projectId: ProjectId.make("Project A"), title: "By title" })
        .pipe(withScope(orphanThread));
      const byPath = yield* boardHandlers
        .board_create_card({
          projectId: ProjectId.make("/somewhere/else/project-a"),
          title: "By path",
        })
        .pipe(withScope(orphanThread));
      const listed = yield* boardHandlers.board_list_cards({}).pipe(withScope(orphanThread));
      const titleCard = listed.cards.find((candidate) => candidate.cardId === byTitle.cardId);
      const pathCard = listed.cards.find((candidate) => candidate.cardId === byPath.cardId);
      assert.strictEqual(titleCard?.projectId, projectId);
      assert.strictEqual(pathCard?.projectId, projectId);
    }),
  );

  it.effect("board_create_card rejects an unresolvable project with the live project list", () =>
    Effect.gen(function* () {
      yield* seed();
      const failure = yield* Effect.flip(
        boardHandlers
          .board_create_card({ projectId: ProjectId.make("does-not-exist"), title: "Nope" })
          .pipe(withScope(orphanThread)),
      );
      assert.strictEqual(failure.code, "invalid-input");
      // Handed the id AND title so the agent can retry with the real id.
      assert.include(failure.message, projectId);
      assert.include(failure.message, "Project A");
    }),
  );

  it.effect("board_create_card rejects an ambiguous project match by title and by folder", () =>
    Effect.gen(function* () {
      yield* seed();
      const engine = yield* OrchestrationEngineService;
      const dupProject = (id: string, title: string, workspaceRoot: string, commandId: string) =>
        engine.dispatch({
          type: "project.create" as const,
          commandId: CommandId.make(commandId),
          projectId: ProjectId.make(id),
          title,
          workspaceRoot,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          createdAt: t0,
        });
      // A second project with the SAME title as the seed's "Project A", and two
      // more that SHARE a workspace folder name (`shared-ws`) that is not itself
      // any project's id — so only the workspace-folder branch can match them.
      yield* dupProject(
        "project-dup-title",
        "Project A",
        "/var/dup-title",
        "cmd-project-dup-title",
      );
      yield* dupProject("project-ws-1", "Yak", "/a/shared-ws", "cmd-project-ws-1");
      yield* dupProject("project-ws-2", "Zebra", "/b/shared-ws", "cmd-project-ws-2");
      // Two projects titled "Project A" → the title is no longer a unique key.
      const byTitle = yield* Effect.flip(
        boardHandlers
          .board_create_card({ projectId: ProjectId.make("Project A"), title: "Ambiguous" })
          .pipe(withScope(orphanThread)),
      );
      assert.strictEqual(byTitle.code, "invalid-input");
      assert.include(byTitle.message, "more than one project by title");
      // `shared-ws` is no id and no title, but is the folder name of two
      // projects (/a/shared-ws and /b/shared-ws).
      const byPath = yield* Effect.flip(
        boardHandlers
          .board_create_card({ projectId: ProjectId.make("/tmp/shared-ws"), title: "Ambiguous" })
          .pipe(withScope(orphanThread)),
      );
      assert.strictEqual(byPath.code, "invalid-input");
      assert.include(byPath.message, "more than one project by workspace folder");
    }),
  );

  it.effect("board_create_card with no projectId from an unlinked thread lists the projects", () =>
    Effect.gen(function* () {
      yield* seed();
      const failure = yield* Effect.flip(
        boardHandlers.board_create_card({ title: "Homeless" }).pipe(withScope(orphanThread)),
      );
      assert.strictEqual(failure.code, "invalid-input");
      assert.include(failure.message, projectId);
    }),
  );

  it.effect("the agent write path replays identically from an empty read model (D8)", () =>
    Effect.gen(function* () {
      yield* seed();
      yield* boardHandlers.board_report_progress({ note: "note" }).pipe(withScope(linkedThread));
      yield* boardHandlers
        .board_complete_step({ stepId: "build", outcome: "succeeded", summary: "done" })
        .pipe(withScope(linkedThread));
      yield* boardHandlers
        .board_propose_plans({
          plans: [{ key: "a", title: "A", summary: "s", dependsOn: [], body: "body" }],
        })
        .pipe(withScope(linkedThread));
      yield* boardHandlers
        .board_write_plan({ planId: boardPlanId(cardId, "a"), body: "rewritten" })
        .pipe(withScope(linkedThread));

      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const rehydrated = yield* snapshotQuery.getCommandReadModel();
      const events = Array.from(yield* Stream.runCollect(engine.readEvents(0)));
      let replayed = createEmptyReadModel(t0);
      for (const event of events) replayed = yield* projectEvent(replayed, event);
      // Read-model step completions and plan metadata rehydrated from the
      // 908/909 tables must equal a from-empty replay of the event log.
      assert.deepStrictEqual(replayed.board, rehydrated.board);
    }),
  );
});
