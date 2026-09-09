/**
 * "New thread — restart <stage>" — the `+` menu's on-demand kickoff (T3O-21).
 *
 * The reported bug: the menu row is enabled (the card's thread is idle, so the
 * client's in-flight gate lets the click through) and clicking it does nothing
 * at all. `board.card.start-stage-thread` is decided, the event lands, and the
 * reactor drops it on the floor — because `beginStageRun` only ever superseded
 * a `stalled` step. Every other resting state was blocked by one of two guards
 * written for the AUTOMATIC kickoff:
 *
 *  - a live thread link whose role is the stage (which is what a step thread's
 *    link IS — a human's adopted thread links as `linked`, never as the stage),
 *    so a stage that has ever run could never be restarted; and
 *  - a non-terminal step, which is what a planning interview parked on a
 *    question (`awaiting-input`) rests in — the exact state of the card in the
 *    bug report.
 *
 * An on-demand request is a human's explicit restart, so it supersedes the
 * card's current run whatever state it rests in, exactly as the stalled path
 * always did: settle the old step abandoned, interrupt and unlink its thread,
 * then spawn a fresh one.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  ProviderInstanceId,
  ThreadId,
  boardCardStepState,
  type BoardCard,
  type BoardCardStepState,
  type BoardCardThreadLink,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  NOW,
  aliveThreadShell,
  codexStep,
  idleThreadShell,
  makeBoardCard,
  settingsWith,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const cardId = BoardCardId.make("card-1");
const planning = String(BOARD_SEED_STAGE_IDS.planning);
const oldThread = ThreadId.make("thread-old-planning");

const link = (threadId: ThreadId, role: string): BoardCardThreadLink =>
  ({ threadId, role, linkedAt: NOW, tombstonedAt: null }) as unknown as BoardCardThreadLink;

/** The card in the report: parked in Planning with the planning run's own
    thread still linked to it. */
const planningCard = (links: ReadonlyArray<BoardCardThreadLink> = [link(oldThread, planning)]) =>
  ({
    ...makeBoardCard({ id: "card-1", stage: planning, orderKey: "m" }),
    threadLinks: [...links],
  }) as BoardCard;

/** The card's live run row, in whatever state the test is restarting from. */
const planningStep = (input: {
  readonly status: BoardCardStepState["status"];
  readonly threadId?: ThreadId | null;
}): BoardCardStepState => ({
  cardId,
  stepId: planning,
  stepLabel: null,
  stageLabel: "Planning",
  attempt: 1,
  stallCount: 0,
  stageEntryRecoveries: 0,
  humanTurnAt: null,
  lastNudgeAt: NOW,
  baseTipAtRoundStart: null,
  lastError: null,
  awaitingReason: "question" as const,
  prompt: "old planning run",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5",
  mode: "plan",
  runtimeMode: "auto",
  humanInLoop: true,
  maxAttempts: 5,
  timeoutMs: 1_800_000,
  threadId: input.threadId === undefined ? oldThread : input.threadId,
  status: input.status,
  slotHeld: false,
  forceStart: false,
  startedAt: NOW,
  updatedAt: NOW,
});

/** What the `+` menu's restart row dispatches, once the decider has accepted
    it: the card and the stage it is standing in. */
const stageThreadRequested = (sequence: number): OrchestrationEvent =>
  ({
    type: "board.card-stage-thread-requested",
    sequence,
    payload: { cardId, stageId: planning },
  }) as unknown as OrchestrationEvent;

const settings = () =>
  settingsWith({
    building: [codexStep],
    planning: codexStep,
    planningHumanInLoop: true,
    globalMaxConcurrent: 3,
  });

/** The step the restart left live, the card it left behind, and every command
    the reactor dispatched — the facts each case here asserts on. `withGovernor`
    discards its body's value, so the outcome rides out on a closure. */
interface RestartOutcome {
  readonly state: BoardCardStepState | null;
  readonly card: BoardCard;
  readonly commands: ReadonlyArray<OrchestrationCommand>;
}

const restartOutcome = (input: {
  readonly card: BoardCard;
  readonly stepStates: ReadonlyArray<BoardCardStepState>;
  readonly stepCompletions?: ReadonlyArray<unknown>;
  /** The superseded thread's shell. Idle by default — a parked interview's
      thread between turns — because boot reconciliation reads it and would
      otherwise park or recover the seeded row before the restart under test
      arrives. Pass an alive one to keep a `running` step running. */
  readonly shell?: OrchestrationThreadShell;
}): Effect.Effect<RestartOutcome> =>
  Effect.gen(function* () {
    let outcome: RestartOutcome | null = null;
    yield* withGovernor(
      {
        board: {
          cards: [input.card],
          stepStates: [...input.stepStates],
          ...(input.stepCompletions === undefined
            ? {}
            : { stepCompletions: [...input.stepCompletions] }),
          nextCardNumberByProject: {},
        } as never,
        settings: settings(),
        initialShells: new Map([
          [String(oldThread), input.shell ?? idleThreadShell(String(oldThread))],
        ]),
      },
      ({ pumpDomain, board, commands }) =>
        Effect.gen(function* () {
          yield* pumpDomain(stageThreadRequested(2));

          const after = yield* board;
          const card = after.cards.find((entry) => entry.id === cardId);
          assert.isDefined(card, "the card survives the restart");
          outcome = {
            state: boardCardStepState(after, cardId),
            card: card!,
            commands: yield* commands,
          };
        }),
    );
    assert.isNotNull(outcome, "the harness ran its body");
    return outcome!;
  });

it.effect("restarts a planning step parked on a question — the reported no-op", () =>
  Effect.gen(function* () {
    const outcome = yield* restartOutcome({
      card: planningCard(),
      stepStates: [planningStep({ status: "awaiting-input" })],
    });

    // A fresh run on the stage's step, on a thread that is not the parked one.
    assert.strictEqual(outcome.state?.stepId, planning);
    assert.strictEqual(outcome.state?.status, "running");
    assert.isNotNull(outcome.state?.threadId ?? null);
    assert.notStrictEqual(outcome.state?.threadId, oldThread);

    // …and it is linked, so the card shows the thread the human just asked for.
    assert.isDefined(
      outcome.card.threadLinks.find(
        (entry) => entry.threadId === outcome.state?.threadId && entry.tombstonedAt === null,
      ),
      "the restarted thread is linked to the card",
    );
    // The superseded run is gone from the card: unlinking a live thread removes
    // the link outright, so the strip stops offering a conversation the board is
    // no longer supervising.
    assert.isUndefined(
      outcome.card.threadLinks.find(
        (entry) => entry.threadId === oldThread && entry.tombstonedAt === null,
      ),
      "the superseded planning thread is unlinked",
    );
  }),
);

it.effect("restarts a stage whose previous run finished and left its thread linked", () =>
  Effect.gen(function* () {
    const outcome = yield* restartOutcome({
      card: planningCard(),
      // Terminal, so nothing is in flight — but its thread link is still the
      // stage's, which is what used to make the restart a permanent no-op.
      stepStates: [planningStep({ status: "succeeded" })],
      stepCompletions: [
        {
          cardId,
          stepId: planning,
          outcome: "succeeded",
          summary: "plan done",
          payload: null,
          threadId: oldThread,
          completedAt: NOW,
        },
      ],
    });

    assert.strictEqual(outcome.state?.stepId, planning);
    assert.strictEqual(outcome.state?.status, "running");
    assert.notStrictEqual(outcome.state?.threadId, oldThread);
    assert.isDefined(
      outcome.card.threadLinks.find(
        (entry) => entry.threadId === outcome.state?.threadId && entry.tombstonedAt === null,
      ),
      "the restarted thread is linked to the card",
    );
  }),
);

it.effect("restarts a step the supervisor still believes is running, and stops the old turn", () =>
  Effect.gen(function* () {
    const outcome = yield* restartOutcome({
      card: planningCard(),
      stepStates: [planningStep({ status: "running" })],
      // Alive, so boot reconciliation resume-watches the row instead of parking
      // it: this case is about a restart landing on a genuinely running step.
      shell: aliveThreadShell(String(oldThread)),
    });

    assert.strictEqual(outcome.state?.status, "running");
    assert.notStrictEqual(outcome.state?.threadId, oldThread);
    // The row really was `running` when the restart arrived: boot
    // reconciliation parks a step it reads as waiting on a human, and a parked
    // row would make this case a duplicate of the first one.
    assert.isUndefined(
      outcome.commands.find((command) => command.type === "board.card.await-step-input"),
      "the superseded step was running, not parked",
    );
    // One writer at a time: the superseded thread's turn is interrupted rather
    // than left running against a card that has moved on, exactly as a stage
    // move's abandonment does.
    assert.isDefined(
      outcome.commands.find(
        (command) => command.type === "thread.turn.interrupt" && command.threadId === oldThread,
      ),
      "the superseded turn is interrupted",
    );
    // The old row settles rather than lingering non-terminal: a second live
    // step for one card is the state D4 exists to forbid.
    assert.isDefined(
      outcome.commands.find(
        (command) => command.type === "board.card.settle-step" && command.outcome === "abandoned",
      ),
      "the superseded step is settled abandoned",
    );
  }),
);

it.effect("restarts a stalled step, as it always did", () =>
  Effect.gen(function* () {
    const outcome = yield* restartOutcome({
      card: planningCard(),
      stepStates: [planningStep({ status: "stalled" })],
    });

    assert.strictEqual(outcome.state?.status, "running");
    assert.notStrictEqual(outcome.state?.threadId, oldThread);
  }),
);

it.effect("restarts a stalled step whose thread never existed", () =>
  Effect.gen(function* () {
    const outcome = yield* restartOutcome({
      // The spawn-failure stall (t3o-30): the provider could not start, so the
      // row names no thread — while the stage's earlier thread is still linked.
      // The old supersede read that lingering link as a conversation a human had
      // adopted and bailed, so the one state most in need of a restart was the
      // one that ignored the click.
      card: planningCard(),
      stepStates: [planningStep({ status: "stalled", threadId: null })],
    });

    assert.strictEqual(outcome.state?.stepId, planning);
    assert.strictEqual(outcome.state?.status, "running");
    assert.isNotNull(outcome.state?.threadId ?? null);
    assert.notStrictEqual(outcome.state?.threadId, oldThread);
  }),
);

it.effect("restarts a card whose stage has no run row at all", () =>
  Effect.gen(function* () {
    const outcome = yield* restartOutcome({
      card: planningCard([]),
      stepStates: [],
    });

    assert.strictEqual(outcome.state?.stepId, planning);
    assert.strictEqual(outcome.state?.status, "running");
  }),
);
