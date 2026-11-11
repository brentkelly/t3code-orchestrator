/**
 * Plan review in the decider: it starts on the first proposal or succeeded
 * planning completion, the card's toggle stops it or changes its rounds, and
 * turned on late it reopens a finished planning step or resumes a paused one.
 */
import {
  BoardCardId,
  BoardStageId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  boardPlanId,
  type BoardCard,
  type BoardCardPlanReview,
  type BoardCardStepState,
  type BoardPlan,
  type BoardState,
  type BoardStepCompletion,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { boardDecidedEvents, type BoardCommand } from "./decider.ts";
import { decideBoardCommandOnModel } from "./decisionContext.testkit.ts";
import type { BoardOrchestrationReadModel } from "./decisionContext.testkit.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T01:00:00.000Z";
const projectId = ProjectId.make("project-1");
const cardId = BoardCardId.make("card-1");
const threadId = ThreadId.make("thread-planning");
const ON: BoardCardPlanReview = { enabled: true, rounds: 3 };

function makeCard(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id: cardId,
    key: "T3-1",
    cardNumber: 1,
    projectId,
    labels: [],
    stage: BoardStageId.make("planning"),
    orderKey: "m",
    title: "Card",
    briefRef: null,
    dependsOn: [],
    parentCardId: null,
    sourcePlanId: null,
    group: null,
    threadLinks: [],
    attachments: [],
    externalRef: null,
    humanInLoop: null,
    reviewOverrides: null,
    modelOverrides: null,
    splitRationale: null,
    baseBranch: null,
    scheduledStartAt: null,
    autoPlanSetting: null,
    autoBuildSetting: null,
    autoMergeSetting: null,
    autoMergeHold: null,
    mergeStrategy: null,
    pinnedWorkerId: null,
    placedWorkerId: null,
    workerMove: null,
    placementOrphaned: null,
    ci: null,
    ciLastOutcome: null,
    ciRoundTrips: 0,
    worktree: null,
    pullRequest: null,
    pullRequestHistory: [],
    pullRequestFloor: null,
    blocked: false,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const stepState = (overrides: Partial<BoardCardStepState> = {}): BoardCardStepState => ({
  cardId,
  stepId: "planning",
  stepLabel: null,
  stageLabel: "Planning",
  attempt: 1,
  stallCount: 0,
  stageEntryRecoveries: 0,
  humanTurnAt: null,
  awaitingReason: "question",
  stalledReason: "gave-up",
  retryAt: null,
  lastNudgeAt: null,
  prompt: "plan it",
  providerInstanceId: ProviderInstanceId.make("claude"),
  model: "opus",
  mode: "plan",
  runtimeMode: "approval-required",
  humanInLoop: true,
  maxAttempts: 3,
  timeoutMs: 1000,
  baseTipAtRoundStart: null,
  lastError: null,
  threadId,
  status: "running",
  slotHeld: false,
  forceStart: false,
  queuedBy: null,
  startedAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const plan: BoardPlan = {
  planId: boardPlanId(cardId, "main"),
  cardId,
  title: "Main",
  summary: "The plan",
  dependsOn: [],
  ordinal: 0,
  locked: false,
  createdAt: NOW,
  updatedAt: NOW,
};

const started = { planReviewStartedAt: NOW, planReviewRounds: 3 } as const;

function readModel(input: {
  readonly card?: BoardCard;
  readonly state?: BoardCardStepState | null;
  readonly plans?: ReadonlyArray<BoardPlan>;
  readonly completions?: ReadonlyArray<BoardStepCompletion>;
}): BoardOrchestrationReadModel {
  const board: BoardState = {
    cards: [input.card ?? makeCard()],
    plans: input.plans ?? [plan],
    stepStates: input.state === null ? [] : [input.state ?? stepState()],
    stepCompletions: input.completions ?? [],
    nextCardNumberByProject: { [projectId]: 2 },
  };
  return { snapshotSequence: 0, projects: [], threads: [], board, updatedAt: NOW };
}

const decide = (command: BoardCommand, model: BoardOrchestrationReadModel) =>
  decideBoardCommandOnModel({ command, readModel: model }).pipe(
    Effect.map(boardDecidedEvents),
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const decideFail = (command: BoardCommand, model: BoardOrchestrationReadModel) =>
  Effect.flip(decide(command, model));

const propose = (planReview?: BoardCardPlanReview): BoardCommand => ({
  type: "board.plans.propose",
  commandId: CommandId.make("cmd-propose"),
  cardId,
  plans: [{ key: "main", title: "Main", summary: "The plan", dependsOn: [], body: "# Plan" }],
  splitRationale: null,
  ...(planReview === undefined ? {} : { planReview }),
  createdAt: LATER,
});

const complete = (input: {
  readonly outcome?: "succeeded" | "failed" | "blocked";
  readonly planReview?: BoardCardPlanReview;
  readonly payload?: string | null;
}): BoardCommand => ({
  type: "board.card.complete-step",
  commandId: CommandId.make("cmd-complete"),
  cardId,
  stepId: "planning",
  outcome: input.outcome ?? "succeeded",
  summary: "Planned.",
  payload: input.payload ?? null,
  threadId,
  ...(input.planReview === undefined ? {} : { planReview: input.planReview }),
  createdAt: LATER,
});

const update = (planReview: BoardCardPlanReview | null): BoardCommand => ({
  type: "board.card.update",
  commandId: CommandId.make("cmd-update"),
  cardId,
  planReview,
  createdAt: LATER,
});

const types = (events: ReadonlyArray<{ readonly type: string }>) =>
  events.map((event) => event.type);

it.effect("a proposal with review on starts the review on the live planning step", () =>
  Effect.gen(function* () {
    const events = yield* decide(propose(ON), readModel({ plans: [] }));
    assert.deepStrictEqual(types(events), ["board.plans-proposed", "board.plan-review-started"]);
    const startedEvent = events[1]!;
    assert.ok(startedEvent.type === "board.plan-review-started");
    assert.strictEqual(startedEvent.payload.state.planReviewStartedAt, LATER);
    assert.strictEqual(startedEvent.payload.state.planReviewRounds, 3);
    assert.strictEqual(startedEvent.payload.state.status, "running");
  }),
);

it.effect("a proposal does not start a review that is off or already started", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(types(yield* decide(propose(), readModel({}))), [
      "board.plans-proposed",
    ]);
    assert.deepStrictEqual(
      types(yield* decide(propose({ enabled: false, rounds: 2 }), readModel({}))),
      ["board.plans-proposed"],
    );
    // A re-proposal during the review does not start another.
    assert.deepStrictEqual(
      types(yield* decide(propose(ON), readModel({ state: stepState(started) }))),
      ["board.plans-proposed"],
    );
  }),
);

it.effect("a proposal outside the planning stage, or with no live step, starts nothing", () =>
  Effect.gen(function* () {
    const building = readModel({
      card: makeCard({ stage: BoardStageId.make("building") }),
      state: stepState({ stepId: "building", stageLabel: "Building" }),
    });
    assert.deepStrictEqual(types(yield* decide(propose(ON), building)), ["board.plans-proposed"]);
    assert.deepStrictEqual(types(yield* decide(propose(ON), readModel({ state: null }))), [
      "board.plans-proposed",
    ]);
    const settled = readModel({ state: stepState({ status: "succeeded" }) });
    assert.deepStrictEqual(types(yield* decide(propose(ON), settled)), ["board.plans-proposed"]);
  }),
);

it.effect("the first succeeded completion with review on starts the review instead", () =>
  Effect.gen(function* () {
    const events = yield* decide(complete({ planReview: ON }), readModel({}));
    assert.deepStrictEqual(types(events), ["board.plan-review-started"]);
    const event = events[0]!;
    assert.ok(event.type === "board.plan-review-started");
    assert.strictEqual(event.payload.state.planReviewStartedAt, LATER);
    assert.strictEqual(event.payload.state.planReviewRounds, 3);
  }),
);

it.effect("a failed earlier attempt is superseded through the gate too", () =>
  Effect.gen(function* () {
    const failed: BoardStepCompletion = {
      cardId,
      stepId: "planning",
      outcome: "failed",
      summary: "Crashed.",
      payload: null,
      threadId,
      completedAt: NOW,
    };
    const events = yield* decide(
      complete({ planReview: ON }),
      readModel({ completions: [failed] }),
    );
    assert.deepStrictEqual(types(events), ["board.plan-review-started"]);
  }),
);

it.effect("the gate passes blocked and failed outcomes, cards with no plan, and review off", () =>
  Effect.gen(function* () {
    for (const outcome of ["blocked", "failed"] as const) {
      assert.deepStrictEqual(
        types(yield* decide(complete({ outcome, planReview: ON }), readModel({}))),
        ["board.card-step-completed"],
      );
    }
    assert.deepStrictEqual(
      types(yield* decide(complete({ planReview: ON }), readModel({ plans: [] }))),
      ["board.card-step-completed"],
    );
    assert.deepStrictEqual(types(yield* decide(complete({}), readModel({}))), [
      "board.card-step-completed",
    ]);
  }),
);

it.effect("an idempotent re-emit of a recorded success is never gated", () =>
  Effect.gen(function* () {
    const succeeded: BoardStepCompletion = {
      cardId,
      stepId: "planning",
      outcome: "succeeded",
      summary: "Planned.",
      payload: null,
      threadId,
      completedAt: NOW,
    };
    const events = yield* decide(
      complete({ planReview: ON }),
      readModel({ completions: [succeeded] }),
    );
    assert.deepStrictEqual(types(events), ["board.card-step-completed"]);
  }),
);

it.effect("completing after the review records how it finished", () =>
  Effect.gen(function* () {
    const reported = yield* decide(
      complete({
        planReview: ON,
        payload: JSON.stringify({ planReview: { roundsRun: 2, converged: true } }),
      }),
      readModel({ state: stepState(started) }),
    );
    assert.deepStrictEqual(types(reported), ["board.card-step-completed"]);
    const event = reported[0]!;
    assert.ok(event.type === "board.card-step-completed");
    assert.deepStrictEqual(event.payload.planReviewFinished, {
      rounds: 3,
      roundsRun: 2,
      converged: true,
    });

    const silent = (yield* decide(
      complete({ planReview: ON }),
      readModel({ state: stepState(started) }),
    ))[0]!;
    assert.ok(silent.type === "board.card-step-completed");
    assert.deepStrictEqual(silent.payload.planReviewFinished, {
      rounds: 3,
      roundsRun: null,
      converged: null,
    });

    // No review ran, so there is nothing to report.
    const plain = (yield* decide(complete({}), readModel({})))[0]!;
    assert.ok(plain.type === "board.card-step-completed");
    assert.strictEqual(plain.payload.planReviewFinished, undefined);
  }),
);

it.effect("a card update can carry plan review alone, and null resets it", () =>
  Effect.gen(function* () {
    const set = (yield* decide(update({ enabled: true, rounds: 4 }), readModel({})))[0]!;
    assert.ok(set.type === "board.card-updated");
    assert.deepStrictEqual(set.payload.card.planReview, { enabled: true, rounds: 4 });

    const reset = (yield* decide(
      update(null),
      readModel({ card: makeCard({ planReview: { enabled: true, rounds: 4 } }) }),
    ))[0]!;
    assert.ok(reset.type === "board.card-updated");
    assert.strictEqual("planReview" in reset.payload.card, false);
  }),
);

it.effect("a rounds change while a review runs is recorded, and turning it off stops it", () =>
  Effect.gen(function* () {
    const running = readModel({
      card: makeCard({ planReview: { enabled: true, rounds: 3 } }),
      state: stepState(started),
    });
    const changed = yield* decide(update({ enabled: true, rounds: 5 }), running);
    assert.deepStrictEqual(types(changed), [
      "board.card-updated",
      "board.plan-review-rounds-changed",
    ]);
    const change = changed[1]!;
    assert.ok(change.type === "board.plan-review-rounds-changed");
    assert.deepStrictEqual(change.payload, {
      cardId,
      state: stepState({ ...started, planReviewRounds: 5, updatedAt: LATER }),
    });
    const card = changed[0]!;
    assert.ok(card.type === "board.card-updated");
    assert.deepStrictEqual(card.payload.card.planReview, { enabled: true, rounds: 5 });

    // A paused review records the new count too; the reactor does not wake it.
    const paused = yield* decide(
      update({ enabled: true, rounds: 1 }),
      readModel({
        card: makeCard({ planReview: { enabled: true, rounds: 3 } }),
        state: stepState({ ...started, status: "paused" }),
      }),
    );
    const pausedChange = paused[1]!;
    assert.ok(pausedChange.type === "board.plan-review-rounds-changed");
    assert.strictEqual(pausedChange.payload.state.status, "paused");
    assert.strictEqual(pausedChange.payload.state.planReviewRounds, 1);

    // The same rounds are fine.
    assert.deepStrictEqual(types(yield* decide(update({ enabled: true, rounds: 3 }), running)), [
      "board.card-updated",
    ]);

    const stopped = yield* decide(update({ enabled: false, rounds: 3 }), running);
    assert.deepStrictEqual(types(stopped), ["board.card-updated", "board.plan-review-stopped"]);
    const stop = stopped[1]!;
    assert.ok(stop.type === "board.plan-review-stopped");
    assert.deepStrictEqual(stop.payload, {
      cardId,
      stepId: "planning",
      threadId,
      state: stepState({ updatedAt: LATER }),
    });
  }),
);

it.effect("a null reset is refused while a review runs, since it could stop it silently", () =>
  Effect.gen(function* () {
    const running = readModel({
      card: makeCard({ planReview: { enabled: true, rounds: 3 } }),
      state: stepState(started),
    });
    const refusal = yield* decideFail(update(null), running);
    assert.include(String(refusal), "cannot be reset to the default");
  }),
);

it.effect("turning review off with none running, or when already off, stops nothing", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      types(yield* decide(update({ enabled: false, rounds: 2 }), readModel({}))),
      ["board.card-updated"],
    );
    const alreadyOff = readModel({
      card: makeCard({ planReview: { enabled: false, rounds: 3 } }),
      state: stepState(started),
    });
    assert.deepStrictEqual(
      types(yield* decide(update({ enabled: false, rounds: 3 }), alreadyOff)),
      ["board.card-updated"],
    );
    // A review left on a settled step is not running, and is not run twice.
    const settled = readModel({ state: stepState({ ...started, status: "succeeded" }) });
    assert.deepStrictEqual(types(yield* decide(update({ enabled: true, rounds: 9 }), settled)), [
      "board.card-updated",
    ]);
  }),
);

it.effect("a new stage entry starts with no review, so re-entering Planning reviews again", () =>
  Effect.gen(function* () {
    const events = yield* decide(
      {
        type: "board.card.select-step",
        commandId: CommandId.make("cmd-select"),
        cardId,
        stepId: "planning",
        stepLabel: null,
        stageLabel: "Planning",
        prompt: "plan it",
        providerInstanceId: ProviderInstanceId.make("claude"),
        model: "opus",
        mode: "plan",
        runtimeMode: "approval-required",
        humanInLoop: true,
        maxAttempts: 3,
        timeoutMs: 1000,
        baseTipAtRoundStart: null,
        createdAt: LATER,
      },
      readModel({ state: stepState({ ...started, status: "succeeded" }) }),
    );
    const selected = events[0]!;
    assert.ok(selected.type === "board.card-step-selected");
    assert.strictEqual(selected.payload.state.planReviewStartedAt, undefined);
    assert.strictEqual(selected.payload.state.planReviewRounds, undefined);
  }),
);

it.effect("turning review on after the plan was posted starts it on the live step", () =>
  Effect.gen(function* () {
    const events = yield* decide(update({ enabled: true, rounds: 2 }), readModel({}));
    assert.deepStrictEqual(types(events), ["board.card-updated", "board.plan-review-started"]);
    const startedEvent = events[1]!;
    assert.ok(startedEvent.type === "board.plan-review-started");
    assert.strictEqual(startedEvent.payload.turnedOnLate, true);
    assert.strictEqual(startedEvent.payload.state.planReviewStartedAt, LATER);
    assert.strictEqual(startedEvent.payload.state.planReviewRounds, 2);
  }),
);

it.effect("turning review on starts nothing with no plan posted, or on a card already on", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      types(yield* decide(update({ enabled: true, rounds: 2 }), readModel({ plans: [] }))),
      ["board.card-updated"],
    );
    // Only a turn-on starts it: a rounds change on a card already on does not.
    assert.deepStrictEqual(
      types(
        yield* decide(
          update({ enabled: true, rounds: 2 }),
          readModel({ card: makeCard({ planReview: ON }) }),
        ),
      ),
      ["board.card-updated"],
    );
    // No live planning step: nothing to start.
    assert.deepStrictEqual(
      types(yield* decide(update({ enabled: true, rounds: 2 }), readModel({ state: null }))),
      ["board.card-updated"],
    );
  }),
);

const succeededCompletion: BoardStepCompletion = {
  cardId,
  stepId: "planning",
  outcome: "succeeded",
  summary: "Planned.",
  payload: null,
  threadId,
  completedAt: NOW,
};

it.effect("turned on after planning finished, the settled step reopens with the review", () =>
  Effect.gen(function* () {
    const events = yield* decide(
      update({ enabled: true, rounds: 2 }),
      readModel({
        state: stepState({ status: "succeeded", stallCount: 2, lastError: "old" }),
        completions: [succeededCompletion],
      }),
    );
    assert.deepStrictEqual(types(events), ["board.card-updated", "board.plan-review-started"]);
    const startedEvent = events[1]!;
    assert.ok(startedEvent.type === "board.plan-review-started");
    assert.strictEqual(startedEvent.payload.turnedOnLate, true);
    assert.deepStrictEqual(
      startedEvent.payload.state,
      stepState({
        status: "running",
        stallCount: 0,
        lastError: null,
        slotHeld: false,
        lastNudgeAt: LATER,
        planReviewStartedAt: LATER,
        planReviewRounds: 2,
        updatedAt: LATER,
      }),
    );
  }),
);

it.effect("a late turn-on reopens only a succeeded plan step on a card still in Planning", () =>
  Effect.gen(function* () {
    const on = update({ enabled: true, rounds: 2 });
    for (const status of ["failed", "abandoned"] as const) {
      assert.deepStrictEqual(
        types(yield* decide(on, readModel({ state: stepState({ status }) }))),
        ["board.card-updated"],
      );
    }
    assert.deepStrictEqual(
      types(yield* decide(on, readModel({ state: stepState({ status: "succeeded" }), plans: [] }))),
      ["board.card-updated"],
    );
    // The card moved on, leaving its settled planning step behind.
    assert.deepStrictEqual(
      types(
        yield* decide(
          on,
          readModel({
            card: makeCard({ stage: BoardStageId.make("ready") }),
            state: stepState({ status: "succeeded" }),
          }),
        ),
      ),
      ["board.card-updated"],
    );
  }),
);

it.effect("turned on while the planning step is paused, the step resumes with the review", () =>
  Effect.gen(function* () {
    const events = yield* decide(
      update({ enabled: true, rounds: 2 }),
      readModel({ state: stepState({ status: "paused", stallCount: 1, retryAt: LATER }) }),
    );
    assert.deepStrictEqual(types(events), ["board.card-updated", "board.plan-review-started"]);
    const startedEvent = events[1]!;
    assert.ok(startedEvent.type === "board.plan-review-started");
    assert.strictEqual(startedEvent.payload.turnedOnLate, true);
    assert.strictEqual(startedEvent.payload.state.status, "running");
    assert.strictEqual(startedEvent.payload.state.stallCount, 0);
    assert.strictEqual(startedEvent.payload.state.retryAt, null);
    assert.strictEqual(startedEvent.payload.state.lastNudgeAt, LATER);
    assert.strictEqual(startedEvent.payload.state.planReviewRounds, 2);
  }),
);

it.effect("the reopened review's completion replaces the pinned one, then pins again", () =>
  Effect.gen(function* () {
    const reopened = stepState({ planReviewStartedAt: NOW, planReviewRounds: 2 });
    const earlier = { ...succeededCompletion, completedAt: "2025-12-31T00:00:00.000Z" };
    const events = yield* decide(
      complete({
        planReview: ON,
        payload: JSON.stringify({ planReview: { roundsRun: 2, converged: false } }),
      }),
      readModel({ state: reopened, completions: [earlier] }),
    );
    assert.deepStrictEqual(types(events), ["board.card-step-completed"]);
    const event = events[0]!;
    assert.ok(event.type === "board.card-step-completed");
    assert.strictEqual(event.payload.completion.completedAt, LATER);
    assert.deepStrictEqual(event.payload.planReviewFinished, {
      rounds: 2,
      roundsRun: 2,
      converged: false,
    });

    // A completion recorded after the review started is pinned as ever.
    const retry = (yield* decide(
      complete({ planReview: ON }),
      readModel({
        state: reopened,
        completions: [{ ...earlier, summary: "Earlier.", completedAt: LATER }],
      }),
    ))[0]!;
    assert.ok(retry.type === "board.card-step-completed");
    assert.strictEqual(retry.payload.completion.summary, "Earlier.");
    assert.strictEqual(retry.payload.completion.payload, null);

    // A non-success never replaces the pinned success.
    const failed = (yield* decide(
      complete({ outcome: "failed", planReview: ON }),
      readModel({ state: reopened, completions: [earlier] }),
    ))[0]!;
    assert.ok(failed.type === "board.card-step-completed");
    assert.strictEqual(failed.payload.completion.outcome, "succeeded");
    assert.strictEqual(failed.payload.completion.completedAt, earlier.completedAt);
  }),
);

// ── Auto-plan reopening a finished planning step (T3O-80) ─────────────

const markReopen = (): BoardCommand => ({
  type: "board.card.mark-auto-plan",
  commandId: CommandId.make("cmd-mark-reopen"),
  cardId,
  reopenFinished: true,
  createdAt: LATER,
});

it.effect("Auto-plan can be turned on after planning succeeded, while still in Planning", () =>
  Effect.gen(function* () {
    const events = yield* decide(
      {
        type: "board.card.set-automation",
        commandId: CommandId.make("cmd-automation"),
        cardId,
        autoPlan: true,
        createdAt: LATER,
      },
      readModel({
        state: stepState({ status: "succeeded" }),
        completions: [succeededCompletion],
      }),
    );
    const updated = events.find((event) => event.type === "board.card-updated");
    assert.ok(updated?.type === "board.card-updated");
    assert.strictEqual(updated.payload.card.autoPlanSetting, true);
  }),
);

it.effect("reopenFinished marks the run and reopens the succeeded step, stamped", () =>
  Effect.gen(function* () {
    const events = yield* decide(
      markReopen(),
      readModel({
        state: stepState({ status: "succeeded", stallCount: 2, lastError: "old" }),
        completions: [succeededCompletion],
      }),
    );
    assert.deepStrictEqual(types(events), ["board.card-updated", "board.card-step-recovered"]);
    const [marked, reopened] = events;
    assert.ok(marked?.type === "board.card-updated");
    assert.strictEqual(marked.payload.autoPlanMarked, true);
    assert.deepStrictEqual(marked.payload.card.autoPlan, { requestedAt: LATER, endedAt: null });
    assert.ok(reopened?.type === "board.card-step-recovered");
    assert.deepInclude(reopened.payload.state, {
      status: "running",
      stallCount: 0,
      lastError: null,
      slotHeld: false,
      retryAt: null,
      reopenedAt: LATER,
      lastNudgeAt: LATER,
      threadId,
    });
  }),
);

it.effect("reopenFinished refuses a step that is not succeeded, or a card out of Planning", () =>
  Effect.gen(function* () {
    const running = yield* decideFail(markReopen(), readModel({ state: stepState() }));
    assert.include(running.message, "no finished planning step");
    const gone = yield* decideFail(markReopen(), readModel({ state: null }));
    assert.include(gone.message, "no finished planning step");
    const ready = yield* decideFail(
      markReopen(),
      readModel({
        card: makeCard({ stage: BoardStageId.make("ready") }),
        state: stepState({ status: "succeeded" }),
      }),
    );
    assert.include(ready.message, "not in planning");
    const already = yield* decideFail(
      markReopen(),
      readModel({
        card: makeCard({ autoPlan: { requestedAt: NOW, endedAt: null } }),
        state: stepState({ status: "succeeded" }),
      }),
    );
    assert.include(already.message, "already being auto-planned");
    const split = yield* decideFail(
      markReopen(),
      readModel({
        card: makeCard({ splitRationale: "Two parts that review separately." }),
        plans: [plan, { ...plan, planId: boardPlanId(cardId, "second"), ordinal: 1 }],
        state: stepState({ status: "succeeded" }),
      }),
    );
    assert.include(split.message, "proposed split");
  }),
);

it.effect("after an Auto-plan reopen the next completion supersedes; without one it re-emits", () =>
  Effect.gen(function* () {
    const reopened = stepState({ reopenedAt: NOW, lastNudgeAt: NOW });
    const earlier = { ...succeededCompletion, completedAt: "2025-12-31T00:00:00.000Z" };
    const superseding = (yield* decide(
      complete({}),
      readModel({ state: reopened, completions: [earlier] }),
    ))[0]!;
    assert.ok(superseding.type === "board.card-step-completed");
    assert.strictEqual(superseding.payload.completion.completedAt, LATER);

    // A completion newer than the stamp is pinned: the stale stamp no longer counts.
    const pinned = (yield* decide(
      complete({}),
      readModel({ state: reopened, completions: [{ ...earlier, completedAt: LATER }] }),
    ))[0]!;
    assert.ok(pinned.type === "board.card-step-completed");
    assert.strictEqual(pinned.payload.completion.summary, earlier.summary);
    assert.strictEqual(pinned.payload.completion.completedAt, LATER);

    // No reopen: the pinned success re-emits.
    const replay = (yield* decide(
      complete({}),
      readModel({ state: stepState(), completions: [earlier] }),
    ))[0]!;
    assert.ok(replay.type === "board.card-step-completed");
    assert.strictEqual(replay.payload.completion.completedAt, earlier.completedAt);
  }),
);
