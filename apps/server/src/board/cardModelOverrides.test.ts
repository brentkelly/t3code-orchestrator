/**
 * Per-card model overrides at the REACTOR level (t3o-29, AC1/AC4).
 *
 * The contracts resolver and the popover's row derivation are unit-tested where
 * they live, but neither proves the thing that actually matters: that the
 * override reaches a real spawn. Between them sits the wiring this file covers
 * — the reactor resolving the card (and, for a sub-board child, its parent) out
 * of the board aggregate, handing it to the executor on the config, and the
 * executor's plan landing on the `board.card.select-step` the thread is
 * created from.
 *
 * D4's parent inheritance is the reason this cannot be left to the pure layer.
 * "A child runs its parent's model" is a claim about a lookup performed against
 * live board state at plan time, and a resolver that is correct in isolation
 * still proves nothing about whether the reactor ever asked it the right
 * question.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  ProviderInstanceId,
  type BoardCard,
  type BoardCardStageModelOverride,
  type OrchestrationEvent,
} from "@t3tools/contracts";

import {
  NOW,
  codexStep,
  makeBoardCard,
  readyWorktree,
  settingsWith,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const building = String(BOARD_SEED_STAGE_IDS.building);
const reviewStage = String(BOARD_SEED_STAGE_IDS.review);

/** The on-demand kickoff signal, the cheapest way to drive one real spawn
    through `beginStageRun` without standing up a whole stage transition. */
const stageThreadRequested = (card: BoardCard): OrchestrationEvent =>
  ({
    type: "board.card-stage-thread-requested",
    sequence: 1,
    payload: { cardId: card.id, stage: card.stage },
  }) as unknown as OrchestrationEvent;

const opus: BoardCardStageModelOverride = {
  instanceId: ProviderInstanceId.make("anthropic"),
  model: "claude-opus-5",
};
const haiku: BoardCardStageModelOverride = {
  instanceId: ProviderInstanceId.make("anthropic"),
  model: "claude-haiku-4-5",
};

const buildCard = (input: {
  readonly id: string;
  readonly modelOverrides?: BoardCard["modelOverrides"];
  readonly parentCardId?: string;
}): BoardCard => ({
  ...makeBoardCard({ id: input.id, stage: building, orderKey: "m" }),
  worktree: readyWorktree(input.id),
  modelOverrides: input.modelOverrides ?? null,
  ...(input.parentCardId === undefined
    ? {}
    : { parentCardId: BoardCardId.make(input.parentCardId) }),
});

interface SelectedStep {
  readonly providerInstanceId: string;
  readonly model: string;
  readonly runtimeMode: string;
}

/** Drive one spawn and hand back the step the reactor selected. `withGovernor`
    discards its body's value, so the step rides out on a closure. */
const spawnedStep = (
  cards: ReadonlyArray<BoardCard>,
  subject: BoardCard,
): Effect.Effect<SelectedStep> =>
  Effect.gen(function* () {
    let step: SelectedStep | null = null;
    yield* withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [...cards] },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 4 }),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(stageThreadRequested(subject));
          const selected = (yield* h.commands).filter(
            (command) => command.type === "board.card.select-step",
          );
          assert.equal(selected.length, 1, "exactly one step should have been selected");
          step = selected[0] as unknown as SelectedStep;
        }),
    );
    assert.isNotNull(step, "the reactor should have selected a step");
    return step as unknown as SelectedStep;
  });

describe("per-card model overrides reach the spawn (t3o-29)", () => {
  it.effect("AC1: a card's own Build override is what the step runs on", () =>
    Effect.gen(function* () {
      const card = buildCard({ id: "card-1", modelOverrides: { [building]: opus } });
      const step = yield* spawnedStep([card], card);
      assert.strictEqual(step.model, opus.model);
      assert.strictEqual(step.providerInstanceId, String(opus.instanceId));
    }),
  );

  it.effect("a card with no override runs the workspace model", () =>
    Effect.gen(function* () {
      const card = buildCard({ id: "card-1" });
      const step = yield* spawnedStep([card], card);
      assert.strictEqual(step.providerInstanceId, String(codexStep.providerInstanceId));
      assert.notStrictEqual(step.model, opus.model);
    }),
  );

  it.effect("an override naming no access level leaves the stage's posture alone", () =>
    Effect.gen(function* () {
      // An override says only what it changes. The build stage resolves to
      // `auto` (t3o-21, D2), and naming a model must not quietly move it.
      const card = buildCard({ id: "card-1", modelOverrides: { [building]: opus } });
      const step = yield* spawnedStep([card], card);
      assert.strictEqual(step.runtimeMode, "auto");
    }),
  );

  it.effect("an override naming an access level is honoured verbatim", () =>
    Effect.gen(function* () {
      const card = buildCard({
        id: "card-1",
        modelOverrides: {
          [building]: { ...opus, runtimeMode: "approval-required" as const },
        },
      });
      const step = yield* spawnedStep([card], card);
      assert.strictEqual(step.runtimeMode, "approval-required");
      assert.notStrictEqual(step.runtimeMode, "full-access");
    }),
  );

  it.effect("AC4: a sub-board child with no override of its own runs its PARENT's", () =>
    Effect.gen(function* () {
      // The live lookup, not a copy taken at split time: the child was created
      // with nothing, and still runs the parent's model because the reactor
      // resolves through it on every plan.
      const parent = buildCard({ id: "parent-1", modelOverrides: { [building]: opus } });
      const child = buildCard({ id: "child-1", parentCardId: "parent-1" });
      const step = yield* spawnedStep([parent, child], child);
      assert.strictEqual(step.model, opus.model);
    }),
  );

  it.effect("AC4: a child's OWN override beats the parent's", () =>
    Effect.gen(function* () {
      const parent = buildCard({ id: "parent-1", modelOverrides: { [building]: opus } });
      const child = buildCard({
        id: "child-1",
        parentCardId: "parent-1",
        modelOverrides: { [building]: haiku },
      });
      const step = yield* spawnedStep([parent, child], child);
      assert.strictEqual(step.model, haiku.model);
    }),
  );

  it.effect("a parent's override for ANOTHER stage never leaks into this one", () =>
    Effect.gen(function* () {
      const parent = buildCard({
        id: "parent-1",
        modelOverrides: { [String(BOARD_SEED_STAGE_IDS.review)]: opus },
      });
      const child = buildCard({ id: "child-1", parentCardId: "parent-1" });
      const step = yield* spawnedStep([parent, child], child);
      assert.strictEqual(step.providerInstanceId, String(codexStep.providerInstanceId));
    }),
  );

  it.effect("a TOP-LEVEL card never inherits from an unrelated card's overrides", () =>
    Effect.gen(function* () {
      // Inheritance is a parent edge, not "some other card on the board".
      const other = buildCard({ id: "other-1", modelOverrides: { [building]: opus } });
      const card = buildCard({ id: "card-1" });
      const step = yield* spawnedStep([other, card], card);
      assert.strictEqual(step.providerInstanceId, String(codexStep.providerInstanceId));
    }),
  );

  it.effect("AC1: a re-entry into a spent review loop still runs on the card's override", () =>
    Effect.gen(function* () {
      // The SECOND application point (t3o-29, D7): a review loop that exhausted
      // its rounds reports `complete` forever, so dragging the card back opens a
      // clean human-in-the-loop conversation the reactor — not an executor —
      // owns. That conversation is still this card's run of this stage, so a
      // pinned model must survive the re-entry rather than snap back to the
      // workspace default. Exercised through a real spawn because no executor
      // plans a re-entry: only the reactor's `complete` arm does.
      const cardId = BoardCardId.make("card-1");
      const reviewOverride: BoardCardStageModelOverride = {
        ...opus,
        runtimeMode: "approval-required" as const,
      };
      const card: BoardCard = {
        ...makeBoardCard({ id: "card-1", stage: reviewStage, orderKey: "m" }),
        worktree: readyWorktree("card-1"),
        reviewOverrides: { rounds: 1, stopAfterRound: null, roundModels: {} },
        modelOverrides: { [reviewStage]: reviewOverride },
      };
      // One round, run in full, still carrying an unresolved critical: the
      // budget is spent and the loop can never converge — `planNext` returns
      // `complete` (blocked), which is exactly the re-entry precondition.
      const reviewCompletion = (stepId: string, payload: unknown) => ({
        cardId,
        stepId,
        outcome: "succeeded" as const,
        summary: `did ${stepId}`,
        payload: JSON.stringify(payload),
        threadId: null,
        completedAt: NOW,
      });
      const spentRound = [
        reviewCompletion("review@1", {
          reviewedSha: "sha-1",
          findings: [
            {
              id: "f1",
              severity: "critical",
              file: "src/x.ts",
              line: 1,
              title: "broke",
              detail: "",
            },
          ],
        }),
        reviewCompletion("triage@1", { fixedSha: "fix-1", dispositions: [] }),
        reviewCompletion("adjudicate@1", { verdicts: [] }),
      ];

      let selected:
        | (SelectedStep & { readonly humanInLoop: boolean; readonly prompt: string })
        | null = null;
      yield* withGovernor(
        {
          board: { nextCardNumberByProject: {}, cards: [card], stepCompletions: spentRound },
          settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 4 }),
        },
        (h) =>
          Effect.gen(function* () {
            yield* h.pumpDomain({
              type: "board.card-stage-thread-requested",
              sequence: 1,
              payload: { cardId: card.id, stage: card.stage },
            } as unknown as OrchestrationEvent);
            const steps = (yield* h.commands).filter(
              (command) => command.type === "board.card.select-step",
            );
            assert.equal(steps.length, 1, "exactly one re-entry step should have been selected");
            selected = steps[0] as unknown as typeof selected;
          }),
      );

      assert.isNotNull(selected, "the reactor should have selected a re-entry step");
      const step = selected as NonNullable<typeof selected>;
      // The override rides the re-entry verbatim: model, provider AND access.
      assert.strictEqual(step.model, reviewOverride.model);
      assert.strictEqual(step.providerInstanceId, String(reviewOverride.instanceId));
      assert.strictEqual(step.runtimeMode, "approval-required");
      // ...and it is unmistakably the re-entry conversation, not a fresh run:
      // no prompt injected, human-in-the-loop forced (D7).
      assert.strictEqual(step.humanInLoop, true);
      assert.strictEqual(step.prompt, "");
    }),
  );
});
