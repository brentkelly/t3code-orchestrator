/**
 * How a supervised step gets its thread. An engine `thread.turn.start` with
 * `bootstrap.createThread` does NOT create a thread (only ws.ts unpacks it), so the board
 * spawns through the gateway; the fake gateway refuses a turn to a thread never created.
 * Pinned: the spawn creates its own thread, and a failed spawn leaves the card recoverable.
 */
import {
  BoardCardId,
  BOARD_SEED_STAGE_IDS,
  boardCardStepState,
  ProviderInstanceId,
  ThreadId,
  type BoardCardStepState,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ThreadSignal } from "./ThreadGateway.ts";
import { aliveThread } from "./threadGateway.testkit.ts";
import {
  humanTurnStartRequested,
  buildingCard,
  cardMoved,
  type HarnessEvent,
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

        // One spawn creates the thread AND carries the step's prompt as its
        // first turn; a bare `send` to the new thread would be the old bug — a
        // turn against a thread nobody created.
        const dispatched = yield* commands;
        const spawn = dispatched.find(
          (command) => command.type === "thread.spawn" && command.threadId === threadId,
        );
        assert.isDefined(spawn, "the step's thread is created with its first turn");
        assert.isNotEmpty(
          spawn?.type === "thread.spawn" ? spawn.text : "",
          "the step's prompt is sent as the thread's first turn",
        );
        assert.isUndefined(
          dispatched.find(
            (command) => command.type === "thread.send" && command.threadId === threadId,
          ),
          "the first turn is never sent separately from the create",
        );
        // Asserted through the read model, not the dispatch log: a link-thread the decider
        // rejected still appears in `commands` because the dispatch helper swallows rejections.
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

// A provider turned off for the card's project is refused where the
// thread would spawn. The step stalls amber, spends no recovery budget, and a
// model edit restarts the stage on the new model.
it.effect("a spawn on a provider disabled for the project stalls without spending budget", () =>
  withGovernor(
    {
      board: { cards: [buildingCard("card-a", "a")], nextCardNumberByProject: {} },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 1 }),
      providerDisabled: ["codex"],
    },
    ({ slots, pumpDomain, board, decided, reactor }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("card-a");
        yield* pumpDomain(movedToBuilding(buildingCard("card-a", "a"), 1));
        const stalled = boardCardStepState(yield* board, id);
        assert.strictEqual(stalled?.status, "stalled");
        assert.strictEqual(stalled?.stalledReason, "provider-disabled-for-project");
        assert.include(stalled?.lastError ?? "", "codex");
        assert.isNull(stalled?.threadId ?? null);
        assert.strictEqual(stalled?.stageEntryRecoveries, 0, "no recovery budget spent");
        assert.strictEqual(yield* slots.heldTotal, 0, "the acquired slot came back");

        // A human picks a model on a provider the project has on.
        const before = (yield* board).cards.find((candidate) => candidate.id === id)!;
        const edited = {
          ...before,
          modelOverrides: {
            [BOARD_SEED_STAGE_IDS.building]: {
              instanceId: ProviderInstanceId.make("claude"),
              model: "claude-sonnet",
            },
          },
        };
        yield* pumpDomain({
          type: "board.card-updated",
          sequence: 2,
          payload: { cardId: id, card: edited, modelOverridesEdited: true },
        } as unknown as HarnessEvent);
        yield* reactor.drain;
        const requested = (yield* decided).find(
          (event) => event.type === "board.card-stage-thread-requested",
        );
        assert.isDefined(requested, "the model edit restarts the stage");
        yield* pumpDomain(requested!);
        const restarted = boardCardStepState(yield* board, id);
        assert.strictEqual(restarted?.status, "running");
        assert.strictEqual(restarted?.providerInstanceId, ProviderInstanceId.make("claude"));
      }),
  ),
);

// The gh pin used to run only while provisioning a worktree, so a card
// whose worktree was already ready never got it. Every build-mode spawn pins.
it.effect("a build spawn into an already-ready worktree pins gh's default repository", () =>
  withGovernor(
    {
      board: { cards: [buildingCard("card-a", "a")], nextCardNumberByProject: {} },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 1 }),
    },
    ({ pumpDomain, board, gitInvocations }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(buildingCard("card-a", "a"), 1));

        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("card-a")), "running");
        const pinProbe = (yield* gitInvocations).find(
          (args) => args[0] === "rev-parse" && args.includes("--git-common-dir"),
        );
        assert.isDefined(pinProbe, "the spawn checked the worktree for a gh pin");
      }),
  ),
);

// A card holds ONE step-state row, so a stalled or in-flight run in the stage it just
// left must not read as a live step for the new stage and block its kickoff.

/** A leftover step-state row for `card-1`, non-terminal so it blocks kickoff,
    seeded `stalled` so boot reconcile leaves it untouched (resume-watch). */
const leftoverStep = (stepId: string): BoardCardStepState => ({
  cardId,
  stepId,
  stepLabel: null,
  stageLabel: null,
  attempt: 5,
  stallCount: 5,
  stageEntryRecoveries: 0,
  humanTurnAt: null,
  lastNudgeAt: NOW,
  baseTipAtRoundStart: null,
  lastError: null,
  awaitingReason: "question" as const,
  stalledReason: "gave-up" as const,
  retryAt: null,
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
  forceStart: false,
  queuedBy: null,
  queuedDetail: null,
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
              command.type === "thread.interrupt" &&
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

// A completion for a step whose stage the card has since LEFT must not spawn a thread on
// its new stage: `continueStage` refuses a stage that does not auto-execute.
const planningCompletedFor = (threadId: ThreadId, sequence: number): HarnessEvent =>
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
  }) as unknown as HarnessEvent;

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
      initialShells: new Map([["thread-planning-live", aliveThread("thread-planning-live")]]),
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
          (yield* commands).find((command) => command.type === "thread.spawn"),
          "no thread is spawned on the manual Sprint stage",
        );
      }),
  ),
);

/** The signal the gateway raises when a requested turn never starts: the CLI is
    missing, the session will not spawn. It is the ONLY signal the board gets: no
    turn ran, so no turn completes. */
const turnStartFailed = (threadId: ThreadId, detail: string, _sequence?: number): ThreadSignal => ({
  type: "turn-start-failed",
  threadId,
  detail,
});

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
          yield* pumpDomain(humanTurnStartRequested(threadId!, 3));

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
        yield* pumpDomain(humanTurnStartRequested(running!.threadId!, 2));
        yield* pumpDomain(humanTurnStartRequested(ThreadId.make("thread-a-human-opened"), 3));

        const after = boardCardStepState(yield* board, cardId);
        assert.strictEqual(after?.status, "running");
        assert.strictEqual(after?.attempt, running?.attempt);
        assert.isUndefined(
          (yield* commands).find((command) => command.type === "board.card.resume-step"),
        );
      }),
  ),
);
