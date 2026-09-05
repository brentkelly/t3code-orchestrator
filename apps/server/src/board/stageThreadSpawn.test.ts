/**
 * How a supervised step gets its thread — the seam between the board and the
 * thread aggregate.
 *
 * The board dispatches straight into the orchestration engine. A
 * `thread.turn.start` carrying `bootstrap.createThread` does NOT create a
 * thread there: that block is unpacked by the WebSocket dispatch path
 * (`dispatchBootstrapTurnStart` in ws.ts), so an engine dispatch is decided as
 * an ordinary turn start and rejected — "thread does not exist". The board
 * shipped exactly that, and every auto-executing stage silently admitted a step
 * as `running` against a thread that was never created: no thread appeared on
 * the card, and the phantom live step then made the "+ → restart" menu a no-op
 * (one step at a time). These tests pin both halves — the spawn creates its own
 * thread, and a spawn that fails leaves the card recoverable.
 */
import {
  BoardCardId,
  BOARD_SEED_STAGE_IDS,
  boardCardStepState,
  ProviderInstanceId,
  ThreadId,
  type BoardCardStepState,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildingCard,
  cardMoved,
  codexStep,
  makeBoardCard,
  movedToBuilding,
  NOW,
  settingsWith,
  stepStatus,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const sprintCard = () => makeBoardCard({ id: "card-1", stage: "sprint", orderKey: "m" });
const cardId = BoardCardId.make("card-1");

/** Sprint → Planning, the human gate the detail modal's "Move to Planning" and a
    drag both settle as. */
const movedToPlanning = (sequence: number) =>
  cardMoved(
    makeBoardCard({ id: "card-1", stage: "planning", orderKey: "m" }),
    "sprint",
    "planning",
    sequence,
  );

it.effect("a card dropped into an auto-executing stage gets a thread of its own", () =>
  withGovernor(
    {
      board: { cards: [sprintCard()], nextCardNumberByProject: {} },
      settings: settingsWith({
        building: [codexStep],
        planning: codexStep,
        globalMaxConcurrent: 3,
      }),
    },
    ({ pumpDomain, board, commands }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToPlanning(1));

        const state = boardCardStepState(yield* board, cardId);
        assert.strictEqual(state?.status, "running");
        assert.strictEqual(state?.stepId, String(BOARD_SEED_STAGE_IDS.planning));
        const threadId = state?.threadId ?? null;
        assert.isNotNull(threadId, "the admitted step names the thread it runs on");

        const dispatched = yield* commands;
        const create = dispatched.find(
          (command) => command.type === "thread.create" && command.threadId === threadId,
        );
        const turn = dispatched.find(
          (command) => command.type === "thread.turn.start" && command.threadId === threadId,
        );
        assert.isDefined(create, "the step's thread is created before its first turn");
        assert.isDefined(turn, "the step's prompt is sent as the thread's first turn");
        assert.isBelow(
          dispatched.indexOf(create!),
          dispatched.indexOf(turn!),
          "create precedes the turn",
        );
        // The link is what puts the thread on the card in the UI, and it is
        // asserted through the read model rather than the dispatch log: a
        // link-thread the decider REJECTED still appears in `commands` (the
        // reactor's dispatch helper swallows the rejection), which is the exact
        // failure this file exists to catch.
        const linked = (yield* board).cards.find((entry) => entry.id === cardId);
        assert.isDefined(
          linked?.threadLinks.find(
            (link) => link.threadId === threadId && link.tombstonedAt === null,
          ),
          "the spawned thread is linked to the card",
        );
      }),
  ),
);

it.effect(
  "a spawn that cannot create its thread leaves the card stalled, not phantom-running",
  () =>
    withGovernor(
      {
        board: { cards: [sprintCard()], nextCardNumberByProject: {} },
        settings: settingsWith({
          building: [codexStep],
          planning: codexStep,
          globalMaxConcurrent: 3,
        }),
        rejectThreadCreate: true,
      },
      ({ pumpDomain, board, commands }) =>
        Effect.gen(function* () {
          yield* pumpDomain(movedToPlanning(1));

          // `stalled` is the loud, human-visible status an on-demand restart
          // supersedes — never `running` against a thread that does not exist,
          // which would read as a live run and wedge every later kickoff.
          assert.strictEqual(stepStatus(yield* board, cardId), "stalled");
          assert.isNull(boardCardStepState(yield* board, cardId)?.threadId ?? null);
          assert.isUndefined(
            (yield* commands).find(
              (command) => command.type === "board.card.admit-step" && command.admitted,
            ),
            "a step with no thread is never admitted",
          );
        }),
    ),
);

it.effect("a build-mode spawn failure gives the slot back, so the next card still runs", () =>
  withGovernor(
    {
      board: {
        cards: [buildingCard("card-a", "a"), buildingCard("card-b", "b")],
        nextCardNumberByProject: {},
      },
      // One slot for both cards: if the refused spawn kept it, card-b could
      // never start — a permanent under-capacity leak that no assertion
      // elsewhere would catch.
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 1 }),
      rejectThreadCreate: true,
    },
    ({ slots, pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(buildingCard("card-a", "a"), 1));

        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("card-a")), "stalled");
        assert.strictEqual(yield* slots.heldTotal, 0, "the acquired slot came back");

        // The ceiling is free again, so the second card is offered the slot and
        // fails the same way — it is never held behind a phantom run.
        yield* pumpDomain(movedToBuilding(buildingCard("card-b", "b"), 2));
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("card-b")), "stalled");
        assert.strictEqual(yield* slots.heldTotal, 0);
      }),
  ),
);

// ── Moving a card that still carries a leftover step ────────────────────────
// The reported regression: a card is moved into Planning and lands with NO
// thread. A card holds ONE step-state row, so a run that stalled (or was still
// in flight) in the stage the card just left is read by the auto-kickoff guard
// as "a live step for the current stage" and blocks the destination's run. The
// card sits threadless and nothing appears in the thread view. Both cards the
// user hit were in this state — a stalled planning step, and a stuck-running
// sprint step whose provider had failed to spawn.

/** A leftover step-state row for `card-1`, non-terminal so it blocks kickoff,
    seeded `stalled` so boot reconcile leaves it untouched (resume-watch). */
const leftoverStep = (stepId: string): BoardCardStepState => ({
  cardId,
  stepId,
  stepLabel: null,
  stageLabel: null,
  attempt: 5,
  stallCount: 5,
  lastNudgeAt: NOW,
  baseTipAtRoundStart: null,
  lastError: null,
  awaitingReason: "question" as const,
  prompt: "old run",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5",
  mode: "plan",
  runtimeMode: "approval-required",
  humanInLoop: true,
  maxAttempts: 5,
  timeoutMs: 600_000,
  threadId: ThreadId.make("thread-dead-old"),
  status: "stalled",
  slotHeld: false,
  startedAt: NOW,
  updatedAt: NOW,
});

it.effect("a card moved into Planning while a leftover step lingers still gets a thread", () =>
  withGovernor(
    {
      board: {
        // The card has already landed in Planning (the move); its step-state
        // row is a leftover `sprint` run that never settled — exactly TT-2,
        // whose codex sprint thread failed to spawn and stayed running.
        cards: [makeBoardCard({ id: "card-1", stage: "planning", orderKey: "m" })],
        stepStates: [leftoverStep(String(BOARD_SEED_STAGE_IDS.sprint))],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({
        building: [codexStep],
        planning: codexStep,
        globalMaxConcurrent: 3,
      }),
    },
    ({ pumpDomain, board, commands }) =>
      Effect.gen(function* () {
        yield* pumpDomain(
          cardMoved(
            makeBoardCard({ id: "card-1", stage: "planning", orderKey: "m" }),
            "sprint",
            "planning",
            1,
          ),
        );

        // The destination stage's step is now the live one — the leftover was
        // abandoned, not left to block the kickoff.
        const state = boardCardStepState(yield* board, cardId);
        assert.strictEqual(state?.stepId, String(BOARD_SEED_STAGE_IDS.planning));
        assert.strictEqual(state?.status, "running");
        assert.isNotNull(state?.threadId ?? null);

        // …and the fresh thread is linked to the card (visible on the card and
        // in the thread view), which is what the user found missing.
        const linked = (yield* board).cards.find((entry) => entry.id === cardId);
        assert.isDefined(
          linked?.threadLinks.find(
            (link) => link.threadId === state?.threadId && link.tombstonedAt === null,
          ),
          "the spawned thread is linked to the card",
        );
        // The abandoned leftover thread's turn is interrupted, not left running
        // on against a step the card has moved past (wasted capacity, and for a
        // build-mode leftover a second writer on the worktree).
        assert.isDefined(
          (yield* commands).find(
            (command) =>
              command.type === "thread.turn.interrupt" &&
              command.threadId === ThreadId.make("thread-dead-old"),
          ),
          "the abandoned leftover turn is interrupted",
        );
      }),
  ),
);

it.effect("re-entering a stage with a stalled step of its own still restarts it", () =>
  withGovernor(
    {
      board: {
        // TT-8: the card had stalled IN Planning, was dragged out and back. Its
        // leftover step is for the destination stage itself — a drag is the
        // human's restart gesture, so it must supersede rather than block.
        cards: [makeBoardCard({ id: "card-1", stage: "planning", orderKey: "m" })],
        stepStates: [leftoverStep(String(BOARD_SEED_STAGE_IDS.planning))],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({
        building: [codexStep],
        planning: codexStep,
        globalMaxConcurrent: 3,
      }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(
          cardMoved(
            makeBoardCard({ id: "card-1", stage: "planning", orderKey: "m" }),
            "sprint",
            "planning",
            1,
          ),
        );

        const state = boardCardStepState(yield* board, cardId);
        assert.strictEqual(state?.status, "running");
        assert.strictEqual(state?.stepId, String(BOARD_SEED_STAGE_IDS.planning));
        assert.isNotNull(state?.threadId ?? null);
        // A fresh run, not the stalled leftover: the dead thread was replaced.
        assert.notStrictEqual(state?.threadId, ThreadId.make("thread-dead-old"));
      }),
  ),
);

// A completion for a step whose stage the card has since LEFT must not spawn a
// thread on the card's new (manual) stage. This is the second defect behind the
// "codex thread on Sprint" report: the card was dragged Planning→Sprint while a
// planning run was still live (the leftover-step bug above); when that run
// finally finished, `continueStage` keyed off the card's CURRENT stage (Sprint,
// which does not auto-execute) and spawned a fresh step there on the app's
// fallback provider. `continueStage` now refuses a stage that does not
// auto-execute.
const aliveShell = (): OrchestrationThreadShell =>
  ({
    hasPendingUserInput: false,
    session: { activeTurnId: "turn-live" },
  }) as unknown as OrchestrationThreadShell;

const planningCompletedFor = (threadId: ThreadId, sequence: number): OrchestrationEvent =>
  ({
    type: "board.card-step-completed",
    sequence,
    payload: {
      cardId,
      completion: {
        cardId,
        stepId: String(BOARD_SEED_STAGE_IDS.planning),
        outcome: "succeeded",
        summary: "plan done",
        payload: null,
        threadId,
        completedAt: NOW,
      },
    },
  }) as unknown as OrchestrationEvent;

it.effect("a step completing after the card left its stage does not spawn on the new stage", () =>
  withGovernor(
    {
      board: {
        // The card sits in Sprint (a manual stage: absent from the pipeline, so
        // autoExecute is off) but still carries a live PLANNING step — the state
        // a Planning→Sprint drag left behind before the move handler was fixed.
        cards: [makeBoardCard({ id: "card-1", stage: "sprint", orderKey: "m" })],
        stepStates: [
          {
            ...leftoverStep(String(BOARD_SEED_STAGE_IDS.planning)),
            status: "running",
            threadId: ThreadId.make("thread-planning-live"),
          },
        ],
        nextCardNumberByProject: {},
      },
      // A live shell so boot reconcile resume-watches the running step rather
      // than recovering it before the completion under test arrives.
      initialShells: new Map([["thread-planning-live", aliveShell()]]),
      settings: settingsWith({
        building: [codexStep],
        planning: codexStep,
        globalMaxConcurrent: 3,
      }),
    },
    ({ pumpDomain, board, commands }) =>
      Effect.gen(function* () {
        yield* pumpDomain(planningCompletedFor(ThreadId.make("thread-planning-live"), 2));

        // The planning step settles; nothing new is selected. Sprint does NOT
        // get a step, and no thread is spawned on it.
        const state = boardCardStepState(yield* board, cardId);
        assert.strictEqual(state?.stepId, String(BOARD_SEED_STAGE_IDS.planning));
        assert.strictEqual(state?.status, "succeeded");
        assert.isUndefined(
          (yield* commands).find((command) => command.type === "thread.create"),
          "no thread is spawned on the manual Sprint stage",
        );
      }),
  ),
);

/** The thread activity the provider reactor appends when a requested turn never
    starts (t3o-30, D2) — the CLI is missing, the session will not spawn. It is
    the ONLY signal the board gets: no turn ran, so no turn completes. */
const turnStartFailed = (threadId: ThreadId, detail: string, sequence: number) =>
  ({
    type: "thread.activity-appended",
    sequence,
    payload: {
      threadId,
      activity: {
        id: `activity-${sequence}`,
        tone: "error",
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        payload: { detail },
        turnId: null,
        createdAt: NOW,
      },
    },
  }) as unknown as OrchestrationEvent;

/** The shape a real spawn failure arrives in: the outer adapter error, a JS
    stack, then the root cause that actually names what to fix. */
const SPAWN_FAILURE_DETAIL = [
  "ProviderAdapterProcessError: Provider adapter process error (codex): Failed to spawn Codex App Server process",
  "    at file:///app/src/provider/Layers/CodexAdapter.ts:1709:15",
  "    at startSession (file:///app/src/orchestration/Layers/ProviderCommandReactor.ts:624:23)",
  "  [cause]: Error: spawn codex ENOENT",
].join("\n");

it.effect("a step whose provider never starts lands stalled, with the reason on the card", () =>
  withGovernor(
    {
      board: { cards: [sprintCard()], nextCardNumberByProject: {} },
      settings: settingsWith({
        building: [codexStep],
        planning: codexStep,
        globalMaxConcurrent: 3,
      }),
    },
    ({ pumpDomain, board, slots }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToPlanning(1));
        const running = boardCardStepState(yield* board, cardId);
        assert.strictEqual(running?.status, "running");
        const threadId = running?.threadId;
        assert.isDefined(threadId);

        yield* pumpDomain(turnStartFailed(threadId!, SPAWN_FAILURE_DETAIL, 2));

        // Stalled IMMEDIATELY, not `timeoutMs` later via the sweep: there is no
        // agent to nudge, so waiting only holds the card's spinner up for half
        // an hour against a thread that is already dead.
        const state = boardCardStepState(yield* board, cardId);
        assert.strictEqual(state?.status, "stalled");
        // Both halves of the error survive: the layer that noticed and the root
        // cause that says what to fix. The stack frames between them do not.
        assert.include(state?.lastError ?? "", "Failed to spawn Codex App Server process");
        assert.include(state?.lastError ?? "", "spawn codex ENOENT");
        assert.notInclude(state?.lastError ?? "", "CodexAdapter.ts");
        // The slot goes back, or a provider that cannot start anything silently
        // eats the board's capacity one card at a time.
        assert.strictEqual(state?.slotHeld, false);
        assert.strictEqual(yield* slots.heldFor(codexStep.providerInstanceId), 0);
      }),
  ),
);

it.effect("a turn-start failure on a thread the board does not own changes nothing", () =>
  withGovernor(
    {
      board: { cards: [sprintCard()], nextCardNumberByProject: {} },
      settings: settingsWith({
        building: [codexStep],
        planning: codexStep,
        globalMaxConcurrent: 3,
      }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToPlanning(1));

        yield* pumpDomain(
          turnStartFailed(ThreadId.make("thread-a-human-opened"), SPAWN_FAILURE_DETAIL, 2),
        );

        // A human's own thread failing to start is theirs to see in the thread.
        const state = boardCardStepState(yield* board, cardId);
        assert.strictEqual(state?.status, "running");
        assert.isNull(state?.lastError ?? null);
      }),
  ),
);

/** The domain event a turn request raises — the composer's Send, the thread's
    Continue, or the board's own nudge. The reactor reads only the thread. */
const turnStartRequested = (threadId: ThreadId, sequence: number) =>
  ({
    type: "thread.turn-start-requested",
    sequence,
    payload: {
      threadId,
      messageId: `message-${sequence}`,
      runtimeMode: "auto",
      interactionMode: "default",
      createdAt: NOW,
    },
  }) as unknown as OrchestrationEvent;

it.effect(
  "a human's turn on a stalled step's thread resumes it and clears the reason (t3o-17, D3)",
  () =>
    withGovernor(
      {
        board: { cards: [sprintCard()], nextCardNumberByProject: {} },
        settings: settingsWith({
          building: [codexStep],
          planning: codexStep,
          globalMaxConcurrent: 3,
        }),
      },
      ({ pumpDomain, board }) =>
        Effect.gen(function* () {
          yield* pumpDomain(movedToPlanning(1));
          const threadId = boardCardStepState(yield* board, cardId)?.threadId;
          assert.isDefined(threadId);
          yield* pumpDomain(turnStartFailed(threadId!, SPAWN_FAILURE_DETAIL, 2));
          const stalled = boardCardStepState(yield* board, cardId);
          assert.strictEqual(stalled?.status, "stalled");

          // The human opens the step's thread and sends a turn — the one act
          // `stalled` is waiting for.
          yield* pumpDomain(turnStartRequested(threadId!, 3));

          const resumed = boardCardStepState(yield* board, cardId);
          assert.strictEqual(resumed?.status, "running");
          // The card stops rendering a stop that no longer applies.
          assert.isNull(resumed?.lastError ?? null);
          // The human's own turn is not charged to the board's budget.
          assert.strictEqual(resumed?.attempt, stalled?.attempt);
          assert.strictEqual(resumed?.stallCount, 0);
        }),
    ),
);

it.effect("a turn on a thread whose step is not stalled leaves the step alone (t3o-17, D3)", () =>
  withGovernor(
    {
      board: { cards: [sprintCard()], nextCardNumberByProject: {} },
      settings: settingsWith({
        building: [codexStep],
        planning: codexStep,
        globalMaxConcurrent: 3,
      }),
    },
    ({ pumpDomain, board, commands }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToPlanning(1));
        const running = boardCardStepState(yield* board, cardId);
        assert.strictEqual(running?.status, "running");

        // The board's own kickoff and nudge turns arrive on this event too, as
        // does any turn on a thread the board does not own.
        yield* pumpDomain(turnStartRequested(running!.threadId!, 2));
        yield* pumpDomain(turnStartRequested(ThreadId.make("thread-a-human-opened"), 3));

        const after = boardCardStepState(yield* board, cardId);
        assert.strictEqual(after?.status, "running");
        assert.strictEqual(after?.attempt, running?.attempt);
        assert.isUndefined(
          (yield* commands).find((command) => command.type === "board.card.resume-step"),
        );
      }),
  ),
);
