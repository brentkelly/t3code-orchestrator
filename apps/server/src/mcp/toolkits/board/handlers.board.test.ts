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
  BoardStageId,
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
import { BoardToolkit } from "./tools.ts";

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

  it.effect("board_report_progress and board_request_input no longer exist (t3o-18, D13)", () =>
    Effect.gen(function* () {
      yield* seed();
      const names = Object.values(BoardToolkit.tools).map((tool) => tool.name);
      assert.notInclude(names, "board_report_progress");
      assert.notInclude(names, "board_request_input");
      assert.include(names, "board_get_card_context");
      assert.include(names, "board_complete_step");
    }),
  );

  it.effect("the card context carries every live thread's todo list (t3o-18, D13)", () =>
    Effect.gen(function* () {
      yield* seed();
      const context = yield* boardHandlers.board_get_card_context().pipe(withScope(linkedThread));
      // The link exists, so the thread rides — with no todo fields until it
      // emits its first `turn.plan.updated` (D14: the cache fills forward).
      assert.deepStrictEqual(
        context.threads.map((entry) => entry.threadId),
        [linkedThread],
      );
      assert.strictEqual(context.threads[0]?.todoStatuses, undefined);
    }),
  );

  it.effect("board_complete_step twice produces exactly one completion", () =>
    Effect.gen(function* () {
      yield* seed();
      // Completions are validated against the card's LIVE step — select one,
      // as the reactor would, before the agent reports against it.
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "board.card.select-step",
        commandId: CommandId.make("cmd-select-step"),
        cardId,
        stepId: "build",
        stepLabel: "Build",
        stageLabel: "Building",
        prompt: "",
        providerInstanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
        mode: "plan",
        humanInLoop: false,
        maxAttempts: 3,
        timeoutMs: 60_000,
        createdAt: t0,
      });
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

  // ── t3o-19: the completion contract without a step id ──────────────
  //
  // Before this, the agent was never told its stepId — the preamble carried
  // the step LABEL and `board_get_card_context.steps` was history — yet the
  // decider rejected any stepId that was not the live step. Non-review stages
  // only worked because the stage line happened to print a string equal to
  // their step id, which broke outright for a custom stage (a UUID).

  /** A card of its own, plus a thread linked to it — the toolkit's tests share
      one layer (and so one database), so a step-lifecycle test that reused
      `card-1` would collide with whatever step an earlier test left live. */
  const seedOwnCard = Effect.fn("seedOwnCard")(function* (suffix: string) {
    const engine = yield* OrchestrationEngineService;
    const ownCard = BoardCardId.make(`card-${suffix}`);
    const ownThread = ThreadId.make(`thread-${suffix}`);
    // A project of its own too: card keys are allocated per project from a
    // running counter, so creating cards in `project-a` would renumber the
    // keys an earlier test asserts on.
    const ownProject = ProjectId.make(`project-${suffix}`);
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`cmd-project-${suffix}`),
      projectId: ownProject,
      title: `Project ${suffix}`,
      workspaceRoot: `/tmp/project-${suffix}`,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      createdAt: t0,
    });
    yield* engine.dispatch({
      type: "board.card.create",
      commandId: CommandId.make(`cmd-card-${suffix}`),
      cardId: ownCard,
      projectId: ownProject,
      title: `Card ${suffix}`,
      orderKey: "m",
      createdAt: t0,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-thread-${suffix}`),
      threadId: ownThread,
      projectId: ownProject,
      title: `Thread ${suffix}`,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: t0,
    });
    yield* engine.dispatch({
      type: "board.card.link-thread",
      commandId: CommandId.make(`cmd-link-${suffix}`),
      cardId: ownCard,
      threadId: ownThread,
      role: "building",
      createdAt: t0,
    });
    return { ownCard, ownThread };
  });

  /** Put a live, admitted step on `ownCard`, owned by `ownThread`. */
  const startStep = Effect.fn("startStep")(function* (input: {
    readonly ownCard: BoardCardId;
    readonly ownThread: ThreadId;
    readonly suffix: string;
  }) {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "board.card.select-step",
      commandId: CommandId.make(`cmd-select-${input.suffix}`),
      cardId: input.ownCard,
      stepId: "building",
      stepLabel: null,
      stageLabel: "Building",
      prompt: "",
      providerInstanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
      mode: "plan",
      humanInLoop: false,
      maxAttempts: 3,
      timeoutMs: 60_000,
      createdAt: t0,
    });
    yield* engine.dispatch({
      type: "board.card.admit-step",
      commandId: CommandId.make(`cmd-admit-${input.suffix}`),
      cardId: input.ownCard,
      stepId: "building",
      admitted: true,
      threadId: input.ownThread,
      createdAt: t0,
    });
  });

  /** What the reactor does once it observes a completion: settle the run row.
      The completion event itself only writes the ledger, so a step stays live
      — and retry-safe — until the supervisor acts on it. */
  const settleStep = Effect.fn("settleStep")(function* (input: {
    readonly ownCard: BoardCardId;
    readonly suffix: string;
  }) {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "board.card.settle-step",
      commandId: CommandId.make(`cmd-settle-${input.suffix}`),
      cardId: input.ownCard,
      stepId: "building",
      outcome: "succeeded",
      createdAt: t0,
    });
  });

  it.effect("completes the caller's live step when no stepId is passed", () =>
    Effect.gen(function* () {
      yield* seed();
      const own = yield* seedOwnCard("omit");
      yield* startStep({ ...own, suffix: "omit" });
      const result = yield* boardHandlers
        .board_complete_step({ outcome: "succeeded", summary: "Built it" })
        .pipe(withScope(own.ownThread));
      // The board resolved the id the agent was never told.
      assert.strictEqual(result.stepId, "building");
      assert.strictEqual(result.outcome, "succeeded");
      const context = yield* boardHandlers.board_get_card_context().pipe(withScope(own.ownThread));
      assert.strictEqual(context.steps.length, 1);
      assert.strictEqual(context.steps[0]?.stepId, "building");
    }),
  );

  it.effect("rejects an omitted stepId from a thread with no work in progress", () =>
    Effect.gen(function* () {
      yield* seed();
      const own = yield* seedOwnCard("idle");
      const failure = yield* Effect.flip(
        boardHandlers
          .board_complete_step({ outcome: "succeeded", summary: "Nothing to report" })
          .pipe(withScope(own.ownThread)),
      );
      assert.strictEqual(failure.code, "invalid-input");
      assert.include(failure.message, "no work in progress");
    }),
  );

  it.effect("an omitted stepId is retry-safe while the step is still live", () =>
    Effect.gen(function* () {
      yield* seed();
      const own = yield* seedOwnCard("retry");
      yield* startStep({ ...own, suffix: "retry" });
      yield* boardHandlers
        .board_complete_step({ outcome: "succeeded", summary: "Built it" })
        .pipe(withScope(own.ownThread));
      // The completion event writes the ledger; the run row stays live until
      // the reactor settles it. So a repeat call resolves the SAME step and
      // hits the idempotent path, exactly as an explicit stepId does.
      const retry = yield* boardHandlers
        .board_complete_step({ outcome: "failed", summary: "Contradiction" })
        .pipe(withScope(own.ownThread));
      assert.strictEqual(retry.alreadyCompleted, true);
      assert.strictEqual(retry.outcome, "succeeded");
      const context = yield* boardHandlers.board_get_card_context().pipe(withScope(own.ownThread));
      assert.strictEqual(context.steps.length, 1);
    }),
  );

  it.effect("an omitted stepId stays retry-safe after the supervisor settles the step", () =>
    Effect.gen(function* () {
      yield* seed();
      const own = yield* seedOwnCard("settled");
      yield* startStep({ ...own, suffix: "settled" });
      yield* boardHandlers
        .board_complete_step({ outcome: "succeeded", summary: "Built it" })
        .pipe(withScope(own.ownThread));
      // What the reactor does the moment it sees the completion — so in
      // production a retry almost always arrives against a TERMINAL run row.
      // The omitted-stepId shape the tool recommends must not be less
      // retry-safe than passing the id explicitly.
      yield* settleStep({ ownCard: own.ownCard, suffix: "settled" });

      const retry = yield* boardHandlers
        .board_complete_step({ outcome: "failed", summary: "Contradiction" })
        .pipe(withScope(own.ownThread));
      assert.strictEqual(retry.stepId, "building");
      assert.strictEqual(retry.alreadyCompleted, true);
      assert.strictEqual(retry.outcome, "succeeded");
      const context = yield* boardHandlers.board_get_card_context().pipe(withScope(own.ownThread));
      assert.strictEqual(context.steps.length, 1);
    }),
  );

  it.effect("rejects an omitted stepId from a thread that has never worked the card", () =>
    Effect.gen(function* () {
      yield* seed();
      const own = yield* seedOwnCard("sibling-idle");
      yield* startStep({ ...own, suffix: "sibling-idle" });
      // A second thread linked to the same card — an adopted conversation, say.
      // It owns no run, so it has nothing to complete.
      const engine = yield* OrchestrationEngineService;
      const sibling = ThreadId.make("thread-other-idle");
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-other-idle"),
        threadId: sibling,
        projectId: ProjectId.make("project-sibling-idle"),
        title: "Sibling",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: t0,
      });
      yield* engine.dispatch({
        type: "board.card.link-thread",
        commandId: CommandId.make("cmd-link-other-idle"),
        cardId: own.ownCard,
        threadId: sibling,
        role: "planning",
        createdAt: t0,
      });

      const failure = yield* Effect.flip(
        boardHandlers
          .board_complete_step({ outcome: "succeeded", summary: "Not mine" })
          .pipe(withScope(sibling)),
      );
      assert.strictEqual(failure.code, "invalid-input");
      assert.include(failure.message, "no work in progress");
      // And the real owner's run is untouched.
      const context = yield* boardHandlers.board_get_card_context().pipe(withScope(own.ownThread));
      assert.strictEqual(context.currentStep?.stepId, "building");
      assert.strictEqual(context.steps.length, 0);
    }),
  );

  it.effect("refuses an explicit stepId naming another thread's live step", () =>
    Effect.gen(function* () {
      yield* seed();
      const own = yield* seedOwnCard("sibling-explicit");
      yield* startStep({ ...own, suffix: "sibling-explicit" });
      const engine = yield* OrchestrationEngineService;
      const sibling = ThreadId.make("thread-other-explicit");
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-other-explicit"),
        threadId: sibling,
        projectId: ProjectId.make("project-sibling-explicit"),
        title: "Sibling",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: t0,
      });
      yield* engine.dispatch({
        type: "board.card.link-thread",
        commandId: CommandId.make("cmd-link-other-explicit"),
        cardId: own.ownCard,
        threadId: sibling,
        role: "planning",
        createdAt: t0,
      });

      // `currentStep` hands every linked thread the live step id, and step ids
      // are predictable anyway — so knowing the id must not be enough to settle
      // a run you did not perform.
      const failure = yield* Effect.flip(
        boardHandlers
          .board_complete_step({ stepId: "building", outcome: "succeeded", summary: "Not mine" })
          .pipe(withScope(sibling)),
      );
      assert.strictEqual(failure.code, "invalid-input");
      assert.include(failure.message, "another thread");
      const context = yield* boardHandlers.board_get_card_context().pipe(withScope(own.ownThread));
      assert.strictEqual(context.steps.length, 0);
    }),
  );

  it.effect("still rejects an explicit stepId that is not the caller's live step", () =>
    Effect.gen(function* () {
      yield* seed();
      const own = yield* seedOwnCard("explicit");
      yield* startStep({ ...own, suffix: "explicit" });
      const failure = yield* Effect.flip(
        boardHandlers
          .board_complete_step({ stepId: "review@1", outcome: "succeeded", summary: "Nope" })
          .pipe(withScope(own.ownThread)),
      );
      assert.strictEqual(failure.code, "rejected");
    }),
  );

  it.effect("a stale thread cannot supersede a re-entered stage's new run", () =>
    Effect.gen(function* () {
      yield* seed();
      const own = yield* seedOwnCard("reentry");
      yield* startStep({ ...own, suffix: "reentry" });
      // The first attempt fails, and the supervisor settles the run row.
      yield* boardHandlers
        .board_complete_step({ outcome: "failed", summary: "Could not finish" })
        .pipe(withScope(own.ownThread));
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "board.card.settle-step",
        commandId: CommandId.make("cmd-settle-reentry"),
        cardId: own.ownCard,
        stepId: "building",
        outcome: "failed",
        createdAt: t0,
      });

      // The card re-enters the stage under a NEW thread. Step ids repeat across
      // stage entries, so the stale thread's own recorded completion carries the
      // very id that is live again.
      const retryThread = ThreadId.make("thread-reentry-2");
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-reentry-2"),
        threadId: retryThread,
        projectId: ProjectId.make("project-reentry"),
        title: "Retry thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: t0,
      });
      yield* engine.dispatch({
        type: "board.card.link-thread",
        commandId: CommandId.make("cmd-link-reentry-2"),
        cardId: own.ownCard,
        threadId: retryThread,
        role: "building",
        createdAt: t0,
      });
      yield* engine.dispatch({
        type: "board.card.select-step",
        commandId: CommandId.make("cmd-select-reentry-2"),
        cardId: own.ownCard,
        stepId: "building",
        stepLabel: null,
        stageLabel: "Building",
        prompt: "",
        providerInstanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
        mode: "plan",
        humanInLoop: false,
        maxAttempts: 3,
        timeoutMs: 60_000,
        createdAt: t0,
      });
      yield* engine.dispatch({
        type: "board.card.admit-step",
        commandId: CommandId.make("cmd-admit-reentry-2"),
        cardId: own.ownCard,
        stepId: "building",
        admitted: true,
        threadId: retryThread,
        createdAt: t0,
      });

      // The stale thread retries with NO stepId. Resolving to its own last
      // completion would hand it `building` — which the decider's supersede
      // rule would then write over the new thread's live run.
      const failure = yield* Effect.flip(
        boardHandlers
          .board_complete_step({ outcome: "succeeded", summary: "Actually I finished" })
          .pipe(withScope(own.ownThread)),
      );
      assert.strictEqual(failure.code, "invalid-input");
      assert.include(failure.message, "another thread");
      // The ledger still records the original failure, unsuperseded.
      const context = yield* boardHandlers.board_get_card_context().pipe(withScope(retryThread));
      assert.strictEqual(context.steps.length, 1);
      assert.strictEqual(context.steps[0]?.outcome, "failed");
    }),
  );

  it.effect("a recovery retry reports its NEW outcome, not the superseded one", () =>
    Effect.gen(function* () {
      yield* seed();
      const own = yield* seedOwnCard("supersede");
      yield* startStep({ ...own, suffix: "supersede" });
      yield* boardHandlers
        .board_complete_step({ outcome: "failed", summary: "First attempt failed" })
        .pipe(withScope(own.ownThread));

      // The recovery ladder nudges the SAME thread on the SAME live step; the
      // decider supersedes a non-succeeded completion here, so the reply must
      // not tell the agent its success was a no-op that stayed `failed`.
      const retry = yield* boardHandlers
        .board_complete_step({ outcome: "succeeded", summary: "Finished after the nudge" })
        .pipe(withScope(own.ownThread));
      assert.strictEqual(retry.outcome, "succeeded");
      assert.strictEqual(retry.alreadyCompleted, false);
      const context = yield* boardHandlers.board_get_card_context().pipe(withScope(own.ownThread));
      assert.strictEqual(context.steps.length, 1);
      assert.strictEqual(context.steps[0]?.outcome, "succeeded");
    }),
  );

  it.effect("board_get_card_context reports the live step, and null once it settles", () =>
    Effect.gen(function* () {
      yield* seed();
      const own = yield* seedOwnCard("context");
      const idle = yield* boardHandlers.board_get_card_context().pipe(withScope(own.ownThread));
      assert.strictEqual(idle.currentStep, null);

      yield* startStep({ ...own, suffix: "context" });
      const running = yield* boardHandlers.board_get_card_context().pipe(withScope(own.ownThread));
      assert.strictEqual(running.currentStep?.stepId, "building");
      // Null label: Building has no steps, so there is no step to name.
      assert.strictEqual(running.currentStep?.stepLabel, null);
      assert.strictEqual(running.currentStep?.stageLabel, "Building");
      // `steps` stays history — the live step is NOT folded into it.
      assert.strictEqual(running.steps.length, 0);

      yield* boardHandlers
        .board_complete_step({ outcome: "succeeded", summary: "Built it" })
        .pipe(withScope(own.ownThread));
      yield* settleStep({ ownCard: own.ownCard, suffix: "context" });
      const settled = yield* boardHandlers.board_get_card_context().pipe(withScope(own.ownThread));
      assert.strictEqual(settled.currentStep, null);
      assert.strictEqual(settled.steps.length, 1);
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
          stage: BoardStageId.make("sprint"),
          labels: ["feature"],
        })
        .pipe(withScope(orphanThread));
      // The key carries the project's acronym, not the compiled-in default:
      // "Project A" -> PA, the same prefix the client would assign, so agent-
      // and human-created cards share one key namespace (D14).
      assert.strictEqual(created.key, "PA-2");
      const listed = yield* boardHandlers
        .board_list_cards({ stage: BoardStageId.make("sprint") })
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

  it.effect("board_create_card can create directly into any stage, Building included (D10)", () =>
    Effect.gen(function* () {
      yield* seed();
      // BOARD_CREATABLE_STAGES is deleted (D10): a card may be created into any
      // stage, so a create straight into Building succeeds. The auto-execute
      // warning is a create-dialog concern (AC16), not a handler-level refusal.
      const created = yield* boardHandlers
        .board_create_card({
          projectId,
          title: "Straight to build",
          stage: BoardStageId.make("building"),
        })
        .pipe(withScope(orphanThread));
      assert.isDefined(created.cardId);
      const listed = yield* boardHandlers.board_list_cards({}).pipe(withScope(orphanThread));
      const card = listed.cards.find((candidate) => candidate.cardId === created.cardId);
      assert.strictEqual(card?.stage, "building");
    }),
  );

  it.effect("board_move_card lands the moved card at the bottom of the target column", () =>
    Effect.gen(function* () {
      yield* seed();
      // A resident card in the target column, so "bottom" is observable.
      const resident = yield* boardHandlers
        .board_create_card({ projectId, title: "Resident", stage: BoardStageId.make("sprint") })
        .pipe(withScope(orphanThread));
      const moved = yield* boardHandlers
        .board_move_card({ cardId, toStage: BoardStageId.make("sprint") })
        .pipe(withScope(orphanThread));
      assert.strictEqual(moved.stage, "sprint");
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const model = yield* snapshotQuery.getCommandReadModel();
      const cards = model.board?.cards ?? [];
      const movedCard = cards.find((candidate) => candidate.id === cardId);
      const residentCard = cards.find((candidate) => candidate.id === resident.cardId);
      assert.strictEqual(movedCard?.stage, "sprint");
      // Bottom of the target column: the computed key sorts after the resident's.
      assert.isDefined(movedCard);
      assert.isDefined(residentCard);
      assert.isTrue(movedCard!.orderKey > residentCard!.orderKey);
    }),
  );

  it.effect("board_move_card on a missing card is rejected actionably, not given a key", () =>
    Effect.gen(function* () {
      yield* seed();
      const failure = yield* Effect.flip(
        boardHandlers
          .board_move_card({
            cardId: BoardCardId.make("card-ghost"),
            toStage: BoardStageId.make("sprint"),
          })
          .pipe(withScope(orphanThread)),
      );
      assert.strictEqual(failure.code, "rejected");
      assert.include(failure.message, "card-ghost");
    }),
  );

  it.effect("board_update_card resolves label names on update and rejects unknown ones", () =>
    Effect.gen(function* () {
      yield* seed();
      yield* boardHandlers
        .board_update_card({ cardId, title: "Renamed", brief: "New brief", labels: ["feature"] })
        .pipe(withScope(orphanThread));
      const context = yield* boardHandlers.board_get_card_context().pipe(withScope(linkedThread));
      assert.strictEqual(context.card.title, "Renamed");
      assert.strictEqual(context.brief, "New brief");
      assert.strictEqual(context.card.labels.length, 1);
      const failure = yield* Effect.flip(
        boardHandlers
          .board_update_card({ cardId, labels: ["nonexistent-label"] })
          .pipe(withScope(orphanThread)),
      );
      assert.strictEqual(failure.code, "unknown-label");
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
        .board_create_card({ title: "Thread-default card", stage: BoardStageId.make("sprint") })
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
      // Mixed case on the folder segment still resolves (case-insensitive, like
      // the title match, and correct on case-insensitive filesystems).
      const byPath = yield* boardHandlers
        .board_create_card({
          projectId: ProjectId.make("/somewhere/else/Project-A"),
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
