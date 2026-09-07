/**
 * Getting a card OUT of a review round that recorded an unreadable payload
 * (T3O-14), against the LIVE reactor.
 *
 * The deadlock this closes: a `review@N` step completed `succeeded` with a
 * payload nothing could decode. The executor is right to refuse to converge on
 * it — an unreadable payload must never be read as "no findings" — so the loop
 * terminates and the card parks. But the completion was pinned by the
 * idempotency rule, so the round could be neither re-run nor rewritten, and
 * `handleStepCompleted` ignores any completion whose step has already settled.
 * Nothing in the board would ever ask again.
 *
 * Both ways out land here as a `repaired` completion — the agent re-recording a
 * valid payload, or the pane's Reopen sending the round back as `failed` — and
 * what these pin is that the reactor acts on it: the executor is asked again,
 * and the step it plans is the one the ledger now implies.
 */
import {
  BoardCardId,
  BOARD_SEED_STAGE_IDS,
  ProviderInstanceId,
  type BoardCardStepState,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  codexStep,
  makeBoardCard,
  NOW,
  readyWorktree,
  settingsWith,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const cardId = BoardCardId.make("card-1");

const reviewCard = () =>
  makeBoardCard({
    id: "card-1",
    stage: String(BOARD_SEED_STAGE_IDS.review),
    orderKey: "m",
    worktree: readyWorktree("card-1"),
  });

/** The run row the loop leaves behind: round 1's review, settled `succeeded`,
    with nothing live after it because the executor terminated the stage. */
const settledReviewStep: BoardCardStepState = {
  cardId,
  stepId: "review@1",
  stepLabel: "Review · round 1",
  stageLabel: "Code review",
  attempt: 1,
  stallCount: 0,
  lastNudgeAt: null,
  baseTipAtRoundStart: "main",
  lastError: null,
  awaitingReason: "question",
  prompt: "review it",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
  mode: "build",
  runtimeMode: "auto",
  humanInLoop: false,
  maxAttempts: 3,
  timeoutMs: 600_000,
  threadId: null,
  status: "succeeded",
  slotHeld: false,
  forceStart: false,
  startedAt: null,
  updatedAt: NOW,
};

/** The record CAA-5 was left holding: a success with no payload at all. */
const brokenRound = {
  cardId,
  stepId: "review@1",
  outcome: "succeeded",
  summary: "Completed the round-1 PR review.",
  payload: null,
  threadId: null,
  completedAt: NOW,
} as const;

const completionEvent = (input: {
  readonly outcome: "succeeded" | "failed";
  readonly summary: string;
  readonly payload: string | null;
  readonly repaired?: boolean;
  readonly sequence: number;
}): OrchestrationEvent =>
  ({
    type: "board.card-step-completed",
    sequence: input.sequence,
    payload: {
      cardId,
      completion: {
        cardId,
        stepId: "review@1",
        outcome: input.outcome,
        summary: input.summary,
        payload: input.payload,
        threadId: null,
        completedAt: NOW,
      },
      ...(input.repaired === undefined ? {} : { repaired: input.repaired }),
    },
  }) as unknown as OrchestrationEvent;

const deadlocked = {
  board: {
    cards: [reviewCard()],
    stepStates: [settledReviewStep],
    stepCompletions: [brokenRound],
    nextCardNumberByProject: {},
  },
  settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
};

const selectedStepIds = (events: ReadonlyArray<OrchestrationEvent>): ReadonlyArray<string> =>
  events.flatMap((event) =>
    event.type === "board.card-step-selected" ? [event.payload.state.stepId] : [],
  );

it.effect("a repaired review payload restarts the loop at the step it was blocking", () =>
  withGovernor(deadlocked, ({ pumpDomain, decided }) =>
    Effect.gen(function* () {
      // The agent re-calls board_complete_step with the payload that never
      // arrived. The step is long settled, so the ordinary completion path
      // ignores it — `repaired` is what tells the reactor otherwise.
      yield* pumpDomain(
        completionEvent({
          outcome: "succeeded",
          summary: "Re-recording round 1",
          // @effect-diagnostics-next-line preferSchemaOverJson:off - the stored payload is an opaque JSON string.
          payload: JSON.stringify({
            reviewedSha: "abc123",
            findings: [
              {
                id: "f1",
                severity: "improvement",
                file: "src/x.ts",
                line: 1,
                title: "Thing",
                detail: "",
              },
            ],
          }),
          repaired: true,
          sequence: 2,
        }),
      );
      // Round 1's findings are readable now, so triage is what the loop owes —
      // exactly the step that could never start while the record was pinned.
      assert.deepStrictEqual(selectedStepIds(yield* decided), ["triage@1"]);
    }),
  ),
);

it.effect("reopening a broken round runs its review again", () =>
  withGovernor(deadlocked, ({ pumpDomain, decided }) =>
    Effect.gen(function* () {
      // What the pane's Reopen dispatches: the broken record superseded by the
      // `failed` one the ledger should have held. The walk counts only
      // succeeded completions, so round 1's review is due again.
      yield* pumpDomain(
        completionEvent({
          outcome: "failed",
          summary: "Reopened: the recorded payload could not be read, so this step runs again.",
          payload: null,
          repaired: true,
          sequence: 2,
        }),
      );
      assert.deepStrictEqual(selectedStepIds(yield* decided), ["review@1"]);
    }),
  ),
);

it.effect("an ordinary retry of a settled step still starts nothing", () =>
  withGovernor(deadlocked, ({ pumpDomain, decided, slots }) =>
    Effect.gen(function* () {
      // The regression the recovery must not cost. An idempotent retry re-emits
      // the pinned completion unchanged and carries no `repaired` flag, so the
      // settled-step guard holds and no second run is spawned.
      yield* pumpDomain(
        completionEvent({
          outcome: "succeeded",
          summary: "Completed the round-1 PR review.",
          payload: null,
          sequence: 2,
        }),
      );
      assert.deepStrictEqual(selectedStepIds(yield* decided), []);
      assert.strictEqual(yield* slots.heldTotal, 0);
    }),
  ),
);
