/**
 * T3O-33 — what the supervisor does when a card changes project.
 *
 * The card's stage does not move, but the repository it works in does, so any
 * live agent is now editing the wrong checkout. The reactor abandons that run,
 * stops its turn, clears the stage's threads off the card, and lets the stage
 * start again on a fresh thread — but only if the stage auto-executes, so a
 * card sitting in Backlog stays put.
 *
 * Two things here are easy to get wrong and are asserted directly: the
 * abandoned thread must be NAMED to the release sweep (unlinking a live thread
 * removes the link outright, so nothing can derive it from a card afterwards),
 * and a thread a human ADOPTED links with role `linked`, never the stage, so it
 * must survive.
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
  otherProjectId,
  projectId,
  settingsWith,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const cardId = BoardCardId.make("card-1");
const planning = String(BOARD_SEED_STAGE_IDS.planning);
const backlog = String(BOARD_SEED_STAGE_IDS.backlog);
const oldThread = ThreadId.make("thread-old-planning");
const adoptedThread = ThreadId.make("thread-adopted");

const link = (threadId: ThreadId, role: string): BoardCardThreadLink =>
  ({ threadId, role, linkedAt: NOW, tombstonedAt: null }) as unknown as BoardCardThreadLink;

/** The card as the board holds it AFTER the move: the projector runs before the
    reactor sees the event, so its `projectId` and `key` are already the new
    ones. The fixture seeds this shape, exactly as production would. */
const movedCardIn = (stage: string, links: ReadonlyArray<BoardCardThreadLink>): BoardCard =>
  ({
    ...makeBoardCard({ id: "card-1", stage, orderKey: "m" }),
    projectId: otherProjectId,
    key: "P2-1",
    threadLinks: [...links],
  }) as BoardCard;

/** The card's live planning run. */
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

/** What the decider emits for `board.card.set-project`: the post-state card,
    plus the project and key it gave up. */
const cardProjectChanged = (card: BoardCard, sequence: number): OrchestrationEvent =>
  ({
    type: "board.card-project-changed",
    sequence,
    payload: {
      cardId: card.id,
      previousProjectId: projectId,
      previousKey: "P1-1",
      previousCardNumber: 1,
      card,
    },
  }) as unknown as OrchestrationEvent;

interface MoveOutcome {
  readonly state: BoardCardStepState | null;
  readonly card: BoardCard;
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly settledThreads: ReadonlySet<string>;
}

const moveOutcome = (input: {
  readonly card: BoardCard;
  readonly stepStates: ReadonlyArray<BoardCardStepState>;
  readonly shells?: ReadonlyMap<string, OrchestrationThreadShell>;
}): Effect.Effect<MoveOutcome> =>
  Effect.gen(function* () {
    let outcome: MoveOutcome | null = null;
    yield* withGovernor(
      {
        board: {
          cards: [input.card],
          stepStates: [...input.stepStates],
          nextCardNumberByProject: {},
        } as never,
        settings: settingsWith({
          building: [codexStep],
          planning: codexStep,
          planningHumanInLoop: true,
          globalMaxConcurrent: 3,
        }),
        initialShells:
          input.shells ?? new Map([[String(oldThread), idleThreadShell(String(oldThread))]]),
      },
      ({ pumpDomain, board, commands, settledThreads }) =>
        Effect.gen(function* () {
          yield* pumpDomain(cardProjectChanged(input.card, 2));

          const after = yield* board;
          const card = after.cards.find((entry) => entry.id === cardId);
          assert.isDefined(card, "the card survives the move");
          outcome = {
            state: boardCardStepState(after, cardId),
            card: card!,
            commands: yield* commands,
            settledThreads: yield* settledThreads,
          };
        }),
    );
    assert.isNotNull(outcome, "the harness ran its body");
    return outcome!;
  });

it.effect("abandons the running planning agent and restarts the stage in the new project", () =>
  Effect.gen(function* () {
    const outcome = yield* moveOutcome({
      card: movedCardIn(planning, [link(oldThread, planning)]),
      stepStates: [planningStep({ status: "running" })],
      // Alive, so boot reconciliation resume-watches the row rather than
      // parking it: this case is about a genuinely running agent.
      shells: new Map([[String(oldThread), aliveThreadShell(String(oldThread))]]),
    });

    // A fresh run, on a thread that is not the abandoned one.
    assert.strictEqual(outcome.state?.stepId, planning);
    assert.strictEqual(outcome.state?.status, "running");
    assert.isNotNull(outcome.state?.threadId ?? null);
    assert.notStrictEqual(outcome.state?.threadId, oldThread);

    // The agent working the OLD repository is stopped, not just unlinked: left
    // alone it keeps burning provider capacity against a checkout the card no
    // longer belongs to.
    assert.isDefined(
      outcome.commands.find(
        (command) => command.type === "thread.turn.interrupt" && command.threadId === oldThread,
      ),
      "the abandoned turn is interrupted",
    );
    assert.isUndefined(
      outcome.card.threadLinks.find(
        (entry) => entry.threadId === oldThread && entry.tombstonedAt === null,
      ),
      "the abandoned planning thread is unlinked",
    );

    // The new thread is spawned against the card's NEW project — the whole
    // point of the restart.
    const created = outcome.commands.find(
      (command) => command.type === "thread.create" && command.threadId === outcome.state?.threadId,
    );
    assert.isDefined(created);
    if (created?.type === "thread.create") {
      assert.strictEqual(created.projectId, otherProjectId);
    }
  }),
);

// Driven from a planning interview PARKED on a question, whose session is
// idle: the settle decider refuses a thread mid-turn (that is what the sweep
// exists to retry), so an alive session would prove nothing here.
it.effect("names the abandoned thread to the release sweep", () =>
  Effect.gen(function* () {
    const outcome = yield* moveOutcome({
      card: movedCardIn(planning, [link(oldThread, planning)]),
      stepStates: [planningStep({ status: "awaiting-input" })],
      shells: new Map([[String(oldThread), idleThreadShell(String(oldThread))]]),
    });

    // Unlinking a LIVE thread removes the link outright, so `threadRelease` can
    // no longer derive it from any card. Unless the move names it, the thread
    // sits unsettled in the inbox forever.
    assert.isTrue(
      outcome.settledThreads.has(String(oldThread)),
      "the abandoned thread is settled rather than stranded in the inbox",
    );
  }),
);

// The thread RECORDS are history (D2): a planning thread's real output is the
// plan, and that lives on the card. Only a running agent is broken by the move.
it.effect("keeps the thread record rather than deleting it", () =>
  Effect.gen(function* () {
    const outcome = yield* moveOutcome({
      card: movedCardIn(planning, [link(oldThread, planning)]),
      stepStates: [planningStep({ status: "running" })],
      shells: new Map([[String(oldThread), aliveThreadShell(String(oldThread))]]),
    });

    assert.isUndefined(
      outcome.commands.find(
        (command) => command.type === "thread.delete" && command.threadId === oldThread,
      ),
      "the abandoned thread is stopped, never deleted",
    );
  }),
);

it.effect("leaves a thread the human adopted alone", () =>
  Effect.gen(function* () {
    const outcome = yield* moveOutcome({
      // Adoption links with role `linked`, never the stage — so the restart
      // never takes a conversation off the card that the board did not put
      // there.
      card: movedCardIn(planning, [link(oldThread, planning), link(adoptedThread, "linked")]),
      stepStates: [planningStep({ status: "running" })],
      shells: new Map([
        [String(oldThread), aliveThreadShell(String(oldThread))],
        [String(adoptedThread), idleThreadShell(String(adoptedThread))],
      ]),
    });

    assert.isDefined(
      outcome.card.threadLinks.find(
        (entry) => entry.threadId === adoptedThread && entry.tombstonedAt === null,
      ),
      "the adopted thread stays linked",
    );
    assert.isUndefined(
      outcome.commands.find(
        (command) => command.type === "thread.turn.interrupt" && command.threadId === adoptedThread,
      ),
      "the adopted thread's turn is not interrupted",
    );
  }),
);

// `onDemand: false`, so the stage's own `autoExecute` decides. Backlog does not
// auto-execute, so moving a card sitting there starts nothing — the move must
// not conjure an agent for a card nobody has begun.
it.effect("starts nothing for a card in a stage that does not auto-execute", () =>
  Effect.gen(function* () {
    const outcome = yield* moveOutcome({
      card: movedCardIn(backlog, []),
      stepStates: [],
      shells: new Map(),
    });

    assert.isNull(outcome.state, "no run row was selected");
    assert.isUndefined(
      outcome.commands.find((command) => command.type === "thread.create"),
      "no thread was spawned",
    );
  }),
);

// A stage the card has run before leaves a link whose role IS the stage id.
// Clearing only the live step's thread would leave that link standing, and the
// live-stage-thread guard would then swallow the restart entirely.
it.effect("clears a link left by an earlier run of the same stage", () =>
  Effect.gen(function* () {
    const stale = ThreadId.make("thread-stale-planning");
    const outcome = yield* moveOutcome({
      card: movedCardIn(planning, [link(stale, planning)]),
      // Terminal: nothing is in flight, but the stale link is still the stage's.
      stepStates: [planningStep({ status: "succeeded", threadId: stale })],
      shells: new Map([[String(stale), idleThreadShell(String(stale))]]),
    });

    assert.isUndefined(
      outcome.card.threadLinks.find(
        (entry) => entry.threadId === stale && entry.tombstonedAt === null,
      ),
      "the stale stage link is cleared",
    );
    assert.strictEqual(outcome.state?.status, "running");
    assert.notStrictEqual(outcome.state?.threadId, stale);
  }),
);
