/**
 * Plan review through the board tools: `board_propose_plans` hands
 * the planning agent its review instructions, a late turn-on starts the
 * review at once (reopening a finished step), and
 * `board_get_card_context` carries a running review and its rounds.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  resolveBoardStageExecution,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import {
  SupervisorReactor,
  type SupervisorReactorShape,
} from "../../../board/supervisorReactor.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { boardStackEngine, makeBoardStackTestLayer } from "../../../board/boardStack.testkit.ts";
import { boardHandlers } from "./handlers.ts";

const t0 = "2026-01-01T00:00:00.000Z";

const SupervisorStub = Layer.succeed(SupervisorReactor, {} as SupervisorReactorShape);

const layer = makeBoardStackTestLayer("t3o-board-mcp-plan-review-").pipe(
  Layer.provideMerge(SupervisorStub),
);

const scope = (threadId: ThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("env-1"),
  requestNamespace: "sess-1",
  thread: {
    threadId,
    providerSessionId: "sess-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["board"]),
  issuedAt: 0,
});

const as = (threadId: ThreadId) =>
  Effect.provideService(McpInvocationContext.McpInvocationContext, scope(threadId));

const onePlan = [{ key: "main", title: "Main", summary: "s", dependsOn: [], body: "# Plan" }];

/** A card of its own with a live, running Planning step on `thread`. The card
    sits in the first stage unless `inPlanning`, which a finished step's late
    review needs. */
const seedPlanningCard = Effect.fn("seedPlanningCard")(function* (
  suffix: string,
  options: { readonly inPlanning?: true } = {},
) {
  const engine = yield* boardStackEngine;
  const cardId = BoardCardId.make(`card-${suffix}`);
  const threadId = ThreadId.make(`thread-${suffix}`);
  const projectId = ProjectId.make(`project-${suffix}`);
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make(`cmd-project-${suffix}`),
    projectId,
    title: `Project ${suffix}`,
    workspaceRoot: `/tmp/project-${suffix}`,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    createdAt: t0,
  });
  yield* engine.dispatch({
    type: "board.card.create",
    commandId: CommandId.make(`cmd-card-${suffix}`),
    cardId,
    projectId,
    title: `Card ${suffix}`,
    ...(options.inPlanning === true ? { stage: BOARD_SEED_STAGE_IDS.planning } : {}),
    orderKey: "m",
    createdAt: t0,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`cmd-thread-${suffix}`),
    threadId,
    projectId,
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
    cardId,
    threadId,
    role: "planning",
    createdAt: t0,
  });
  yield* engine.dispatch({
    type: "board.card.select-step",
    commandId: CommandId.make(`cmd-select-${suffix}`),
    cardId,
    stepId: BOARD_SEED_STAGE_IDS.planning,
    stepLabel: null,
    stageLabel: "Planning",
    prompt: "",
    providerInstanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5-codex",
    mode: "plan",
    runtimeMode: "approval-required",
    humanInLoop: true,
    maxAttempts: 3,
    timeoutMs: 60_000,
    baseTipAtRoundStart: null,
    createdAt: t0,
  });
  yield* engine.dispatch({
    type: "board.card.admit-step",
    commandId: CommandId.make(`cmd-admit-${suffix}`),
    cardId,
    stepId: BOARD_SEED_STAGE_IDS.planning,
    admitted: true,
    threadId,
    createdAt: t0,
  });
  return { cardId, threadId };
});

const turnOn = (cardId: BoardCardId, threadId: ThreadId, rounds: number) =>
  boardHandlers
    .board_update_card({ cardId, planReview: { enabled: true, rounds } })
    .pipe(as(threadId));

it.layer(layer)("plan review through the board tools", (it) => {
  it.effect("the first proposal returns the instructions, and only the first", () =>
    Effect.gen(function* () {
      const { cardId, threadId } = yield* seedPlanningCard("propose");
      yield* turnOn(cardId, threadId, 3);
      const first = yield* boardHandlers.board_propose_plans({ plans: onePlan }).pipe(as(threadId));
      assert.strictEqual(first.planReview?.rounds, 3);
      assert.include(first.planReview?.instructions ?? "", "up to 3 rounds");
      assert.notInclude(first.planReview?.instructions ?? "", "{rounds}");
      // Human-in-the-loop planning: the review ends in a sign-off.
      assert.include(first.planReview?.instructions ?? "", "sign-off");

      const again = yield* boardHandlers.board_propose_plans({ plans: onePlan }).pipe(as(threadId));
      assert.strictEqual(again.planReview, undefined);

      // While it runs, re-orienting returns the same instructions.
      const context = yield* boardHandlers.board_get_card_context().pipe(as(threadId));
      assert.strictEqual(context.planReview?.rounds, 3);
    }),
  );

  it.effect("a proposal with review off returns no instructions", () =>
    Effect.gen(function* () {
      const { threadId } = yield* seedPlanningCard("off");
      const proposed = yield* boardHandlers
        .board_propose_plans({ plans: onePlan })
        .pipe(as(threadId));
      assert.strictEqual(proposed.planReview, undefined);
      const context = yield* boardHandlers.board_get_card_context().pipe(as(threadId));
      assert.strictEqual(context.planReview, undefined);
    }),
  );

  it.effect("turned on after the plan was posted, the review starts at once", () =>
    Effect.gen(function* () {
      const { cardId, threadId } = yield* seedPlanningCard("late");
      yield* boardHandlers.board_propose_plans({ plans: onePlan }).pipe(as(threadId));
      yield* turnOn(cardId, threadId, 2);
      const between = yield* boardHandlers.board_get_card_context().pipe(as(threadId));
      assert.strictEqual(between.planReview?.rounds, 2);

      const done = yield* boardHandlers
        .board_complete_step({
          outcome: "succeeded",
          summary: "Planned and reviewed.",
          payload: { planReview: { roundsRun: 1, converged: true } },
        })
        .pipe(as(threadId));
      assert.strictEqual(done.completed, undefined);
      assert.strictEqual(done.outcome, "succeeded");
      const after = yield* boardHandlers.board_get_card_context().pipe(as(threadId));
      assert.strictEqual(after.steps.length, 1);
      assert.isTrue(after.activity.some((entry) => entry.kind === "plan-review-started"));
      const finished = after.activity.find((entry) => entry.kind === "plan-review-finished");
      assert.strictEqual(finished?.payload.planReviewRoundsRun, 1);
      assert.strictEqual(finished?.payload.planReviewRounds, 2);
    }),
  );

  it.effect("turned on after planning finished, the reopened step records a new completion", () =>
    Effect.gen(function* () {
      const engine = yield* boardStackEngine;
      const { cardId, threadId } = yield* seedPlanningCard("reopen", { inPlanning: true });
      yield* boardHandlers.board_propose_plans({ plans: onePlan }).pipe(as(threadId));
      yield* boardHandlers
        .board_complete_step({ outcome: "succeeded", summary: "Planned." })
        .pipe(as(threadId));
      yield* engine.dispatch({
        type: "board.card.settle-step",
        commandId: CommandId.make("cmd-settle-reopen"),
        cardId,
        stepId: BOARD_SEED_STAGE_IDS.planning,
        outcome: "succeeded",
        createdAt: "2026-01-01T00:00:01.000Z",
      });

      yield* TestClock.adjust("1 second");
      yield* turnOn(cardId, threadId, 2);
      const reopened = yield* boardHandlers.board_get_card_context().pipe(as(threadId));
      assert.strictEqual(reopened.planReview?.rounds, 2);
      assert.isTrue(reopened.activity.some((entry) => entry.kind === "plan-review-started"));

      const done = yield* boardHandlers
        .board_complete_step({
          outcome: "succeeded",
          summary: "Planned and reviewed.",
          payload: { planReview: { roundsRun: 2, converged: true } },
        })
        .pipe(as(threadId));
      assert.strictEqual(done.alreadyCompleted, false);
      assert.strictEqual(done.outcome, "succeeded");
      const after = yield* boardHandlers.board_get_card_context().pipe(as(threadId));
      assert.strictEqual(after.steps.length, 1);
      assert.strictEqual(after.steps[0]?.summary, "Planned and reviewed.");
      const finished = after.activity.find((entry) => entry.kind === "plan-review-finished");
      assert.strictEqual(finished?.payload.planReviewRoundsRun, 2);
    }),
  );

  it.effect("a rounds change mid-review reaches the context and the activity", () =>
    Effect.gen(function* () {
      const { cardId, threadId } = yield* seedPlanningCard("rounds");
      yield* turnOn(cardId, threadId, 3);
      yield* boardHandlers.board_propose_plans({ plans: onePlan }).pipe(as(threadId));
      yield* turnOn(cardId, threadId, 5);
      const context = yield* boardHandlers.board_get_card_context().pipe(as(threadId));
      assert.strictEqual(context.planReview?.rounds, 5);
      const changed = context.activity.find((entry) => entry.kind === "plan-review-rounds-changed");
      assert.strictEqual(changed?.payload.planReviewRounds, 5);
    }),
  );

  it.effect("turning the review off lifts it from the context", () =>
    Effect.gen(function* () {
      const { cardId, threadId } = yield* seedPlanningCard("stop");
      yield* turnOn(cardId, threadId, 2);
      yield* boardHandlers.board_propose_plans({ plans: onePlan }).pipe(as(threadId));
      yield* boardHandlers
        .board_update_card({ cardId, planReview: { enabled: false, rounds: 2 } })
        .pipe(as(threadId));
      const context = yield* boardHandlers.board_get_card_context().pipe(as(threadId));
      assert.strictEqual(context.planReview, undefined);
      assert.isTrue(context.activity.some((entry) => entry.kind === "plan-review-stopped"));
    }),
  );

  it.effect("turning the review back on after a stop starts a fresh one", () =>
    Effect.gen(function* () {
      const { cardId, threadId } = yield* seedPlanningCard("restart");
      yield* turnOn(cardId, threadId, 2);
      yield* boardHandlers.board_propose_plans({ plans: onePlan }).pipe(as(threadId));
      yield* boardHandlers
        .board_update_card({ cardId, planReview: { enabled: false, rounds: 2 } })
        .pipe(as(threadId));
      const stopped = yield* boardHandlers.board_get_card_context().pipe(as(threadId));
      assert.strictEqual(stopped.planReview, undefined);

      yield* turnOn(cardId, threadId, 4);
      const restarted = yield* boardHandlers.board_get_card_context().pipe(as(threadId));
      assert.strictEqual(restarted.planReview?.rounds, 4);
    }),
  );

  it.effect("an untouched card follows the planning stage's default and prompt", () =>
    Effect.gen(function* () {
      // The stack supplies its own settings service, so the default is set
      // through it rather than through the layer.
      const settings = yield* ServerSettings.ServerSettingsService;
      const current = yield* settings.getSettings;
      const planning = resolveBoardStageExecution(current.board, BOARD_SEED_STAGE_IDS.planning);
      assert.ok(planning.kind === "simple");
      yield* settings.updateSettings({
        board: {
          pipeline: {
            ...current.board.pipeline,
            [BOARD_SEED_STAGE_IDS.planning]: {
              ...planning,
              planReview: { enabledByDefault: true, defaultRounds: 4, prompt: "Review {rounds}x." },
            },
          },
        },
      });
      const { threadId } = yield* seedPlanningCard("default");
      const proposed = yield* boardHandlers
        .board_propose_plans({ plans: onePlan })
        .pipe(as(threadId));
      assert.strictEqual(proposed.planReview?.rounds, 4);
      assert.include(proposed.planReview?.instructions ?? "", "Review 4x.");
    }),
  );
});
