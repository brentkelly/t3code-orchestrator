/**
 * Blocked-agent detection (t3o-34): a human-in-the-loop step that ends a turn
 * without completing stops pretending to work.
 *
 * The defect this covers: `handleTurnCompleted`'s human-in-the-loop arm used to
 * return without doing anything, leaving the step `running` — so the shell's
 * `stepRunning` stayed true and the card pulsed its blue "being worked" dot
 * while the agent sat there waiting. Planning is where it bit hardest, because
 * a question with a paragraph of consequence per option is a poor fit for the
 * structured picker and agents write it in prose instead.
 *
 * Driven through the live reactor against the stateful engine double
 * (`withGovernor`), because the behaviour spans the turn-end handler, the
 * decider and the read model.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
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
  cardMoved,
  codexStep,
  makeBoardCard,
  settingsWith,
  stepCompleted,
  turnCompleted,
  turnStarted,
  userInputCancelled,
  userInputRequested,
  userInputResolved,
  withGovernor,
  type Harness,
} from "./supervisorHarness.testkit.ts";

const planningCard = (id: string) => makeBoardCard({ id, stage: "planning", orderKey: "m" });

const movedToPlanning = (id: string, sequence: number): OrchestrationEvent =>
  cardMoved(planningCard(id), "sprint", "planning", sequence);

/** A human turn arriving on a thread — the event `handleTurnStartRequested`
    watches, and the signal that a parked step is being worked again. */
const turnStartRequested = (threadId: string, sequence: number): OrchestrationEvent =>
  ({
    type: "thread.turn-start-requested",
    sequence,
    payload: { threadId },
  }) as unknown as OrchestrationEvent;

/** The planning stage as it really runs: auto-executing and human-in-the-loop,
    because asking IS the job there. `messages` is handed to the harness by
    reference so a test can write the agent's final message once the harness has
    spawned the thread and told it the id. */
const planningBoard = (id: string, messages: Map<string, string>, stale?: ReadonlySet<string>) => ({
  board: { cards: [planningCard(id)], nextCardNumberByProject: {} },
  settings: settingsWith({
    building: [codexStep],
    planning: codexStep,
    planningHumanInLoop: true,
    globalMaxConcurrent: 3,
  }),
  threadMessages: messages,
  ...(stale === undefined ? {} : { staleThreadMessages: stale }),
});

/** Drive the card into a running, human-in-the-loop planning step and hand back
    its thread id. Every test here starts from exactly this state. */
const startPlanning = (h: Pick<Harness, "pumpDomain" | "board">, id: string) =>
  Effect.gen(function* () {
    yield* h.pumpDomain(movedToPlanning(id, 1));
    const state = boardCardStepState(yield* h.board, BoardCardId.make(id));
    assert.strictEqual(state?.status, "running");
    assert.strictEqual(state?.humanInLoop, true);
    assert.isNotNull(state?.threadId);
    return state!.threadId!;
  });

it.effect("a turn that ends with a prose question parks the step as awaiting input", () => {
  const messages = new Map<string, string>();
  return withGovernor(planningBoard("ask", messages), ({ pumpDomain, pumpRuntime, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startPlanning({ pumpDomain, board }, "ask");
      // The shape that defeats the structured picker: one question, then a
      // paragraph of consequence per option.
      messages.set(
        String(threadId),
        [
          "Before I write the plan I need one decision from you. Which way should the worktree be provisioned?",
          "",
          "**A. Per card.** Every card gets its own checkout, which isolates builds completely but costs a full install each time.",
          "",
          "**B. Shared.** One checkout per project, which is far cheaper but serialises anything that touches the lockfile.",
        ].join("\n"),
      );

      yield* pumpRuntime(turnCompleted(threadId));

      const parked = boardCardStepState(yield* board, BoardCardId.make("ask"));
      assert.strictEqual(parked?.status, "awaiting-input");
      assert.strictEqual(parked?.awaitingReason, "question");
      // No recovery ran: this is a healthy pause, not a stall.
      assert.strictEqual(parked?.attempt, 1);
      assert.strictEqual(parked?.stallCount, 0);
    }),
  );
});

it.effect("a turn that ends with no question parks the step as stopped", () => {
  const messages = new Map<string, string>();
  return withGovernor(planningBoard("quiet", messages), ({ pumpDomain, pumpRuntime, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startPlanning({ pumpDomain, board }, "quiet");
      messages.set(
        String(threadId),
        "Wrote the plan to .plans/auth.md. It covers the token exchange, the refresh path and the migration.",
      );

      yield* pumpRuntime(turnCompleted(threadId));

      const parked = boardCardStepState(yield* board, BoardCardId.make("quiet"));
      assert.strictEqual(parked?.status, "awaiting-input");
      assert.strictEqual(parked?.awaitingReason, "stopped");
      assert.strictEqual(parked?.attempt, 1);
      assert.strictEqual(parked?.stallCount, 0);
    }),
  );
});

// A turn can end having said nothing — interrupted, errored, tool-only — and
// then the newest assistant message belongs to an EARLIER turn. Reading it back
// would re-park the card on a question the human has already answered, which is
// the same "card asks for something it already has" defect in miniature.
it.effect("ignores an assistant message written before the work resumed", () => {
  const messages = new Map<string, string>();
  const stale = new Set<string>();
  return withGovernor(
    planningBoard("stale", messages, stale),
    ({ pumpDomain, pumpRuntime, board }) =>
      Effect.gen(function* () {
        const threadId = yield* startPlanning({ pumpDomain, board }, "stale");
        // Unmistakably a question — and unmistakably old.
        messages.set(String(threadId), "Which auth library do you want?");
        stale.add(String(threadId));

        yield* pumpRuntime(turnCompleted(threadId));

        const parked = boardCardStepState(yield* board, BoardCardId.make("stale"));
        assert.strictEqual(parked?.status, "awaiting-input");
        assert.strictEqual(parked?.awaitingReason, "stopped");
      }),
  );
});

it.effect("a thread with no assistant message at all parks as stopped, never crashes", () => {
  const messages = new Map<string, string>();
  return withGovernor(planningBoard("silent", messages), ({ pumpDomain, pumpRuntime, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startPlanning({ pumpDomain, board }, "silent");
      yield* pumpRuntime(turnCompleted(threadId));

      const parked = boardCardStepState(yield* board, BoardCardId.make("silent"));
      assert.strictEqual(parked?.status, "awaiting-input");
      assert.strictEqual(parked?.awaitingReason, "stopped");
    }),
  );
});

it.effect("a human turn on the parked thread puts the step back to running", () => {
  const messages = new Map<string, string>();
  return withGovernor(planningBoard("resume", messages), ({ pumpDomain, pumpRuntime, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startPlanning({ pumpDomain, board }, "resume");
      messages.set(String(threadId), "Which auth library do you want?");
      yield* pumpRuntime(turnCompleted(threadId));
      assert.strictEqual(
        boardCardStepState(yield* board, BoardCardId.make("resume"))?.status,
        "awaiting-input",
      );

      // The human answers. Without this the card would keep asking for an
      // answer it already has.
      yield* pumpDomain(turnStartRequested(String(threadId), 2));

      const resumed = boardCardStepState(yield* board, BoardCardId.make("resume"));
      assert.strictEqual(resumed?.status, "running");
      // A human's own turn is not a board invocation, so it charges nothing.
      assert.strictEqual(resumed?.attempt, 1);
    }),
  );
});

it.effect("answering a STRUCTURED question resumes the step — no turn ever starts", () => {
  const messages = new Map<string, string>();
  return withGovernor(planningBoard("picker", messages), ({ pumpDomain, pumpRuntime, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startPlanning({ pumpDomain, board }, "picker");
      yield* pumpRuntime(userInputRequested(threadId));
      assert.strictEqual(
        boardCardStepState(yield* board, BoardCardId.make("picker"))?.status,
        "awaiting-input",
      );

      // The subtle case. A structured question is raised from INSIDE a running
      // turn, and answering it only resolves the deferred that turn is blocked
      // on — the same turn carries on. So no turn starts, neither turn-start
      // signal fires, and `user-input.resolved` is the only thing the board
      // sees. Without it the card keeps a violet "Input needed" chip while the
      // agent visibly works.
      yield* pumpRuntime(userInputResolved(threadId));

      const resumed = boardCardStepState(yield* board, BoardCardId.make("picker"));
      assert.strictEqual(resumed?.status, "running");
      assert.strictEqual(resumed?.attempt, 1);
    }),
  );
});

it.effect("a second resume signal on an already-running step is a no-op", () => {
  const messages = new Map<string, string>();
  return withGovernor(planningBoard("both", messages), ({ pumpDomain, pumpRuntime, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startPlanning({ pumpDomain, board }, "both");
      messages.set(String(threadId), "Which one?");
      yield* pumpRuntime(turnCompleted(threadId));

      yield* pumpDomain(turnStartRequested(String(threadId), 2));
      const once = boardCardStepState(yield* board, BoardCardId.make("both"));
      // Both signals can land for one resumption. The second finds the step
      // already running and does nothing — no second resume, no rejected
      // dispatch, no counters touched.
      yield* pumpRuntime(userInputResolved(threadId));
      const twice = boardCardStepState(yield* board, BoardCardId.make("both"));

      assert.strictEqual(twice?.status, "running");
      assert.strictEqual(twice?.updatedAt, once?.updatedAt);
    }),
  );
});

// The signal the resume deliberately does NOT take (t3o-34, D5). Adapters
// synthesise `turn.started` for assistant activity arriving with no active turn,
// so acting on it would clear a card's badge with nobody having acted — and on a
// stalled step it would zero `stallCount` and re-arm the sweep, quietly undoing
// a t3o-17 escalation that is meant to stop until a human appears.
it.effect("a synthetic turn.started does NOT un-park a step", () => {
  const messages = new Map<string, string>();
  return withGovernor(planningBoard("synthetic", messages), ({ pumpDomain, pumpRuntime, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startPlanning({ pumpDomain, board }, "synthetic");
      yield* pumpRuntime(turnCompleted(threadId));
      assert.strictEqual(
        boardCardStepState(yield* board, BoardCardId.make("synthetic"))?.status,
        "awaiting-input",
      );

      yield* pumpRuntime(turnStarted(threadId));

      const still = boardCardStepState(yield* board, BoardCardId.make("synthetic"));
      assert.strictEqual(still?.status, "awaiting-input");
      assert.strictEqual(still?.awaitingReason, "stopped");
    }),
  );
});

// The mirror of the `turn.started` exclusion, and the reason the resume reads
// the payload rather than trusting the event type. Every adapter resolves its
// pending-input deferred on teardown and emits `user-input.resolved` with an
// empty answer set, so "resolved" alone is satisfied by stopping a thread. A
// cancelled question is still unanswered, so the card must keep saying so.
it.effect("a CANCELLED structured question does not un-park the step", () => {
  const messages = new Map<string, string>();
  return withGovernor(planningBoard("cancelled", messages), ({ pumpDomain, pumpRuntime, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startPlanning({ pumpDomain, board }, "cancelled");
      yield* pumpRuntime(userInputRequested(threadId));
      assert.strictEqual(
        boardCardStepState(yield* board, BoardCardId.make("cancelled"))?.status,
        "awaiting-input",
      );

      yield* pumpRuntime(userInputCancelled(threadId));

      const still = boardCardStepState(yield* board, BoardCardId.make("cancelled"));
      assert.strictEqual(still?.status, "awaiting-input");
      assert.strictEqual(still?.awaitingReason, "question");
    }),
  );
});

it.effect("a structured question still parks with reason question", () => {
  const messages = new Map<string, string>();
  return withGovernor(planningBoard("structured", messages), ({ pumpDomain, pumpRuntime, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startPlanning({ pumpDomain, board }, "structured");
      // The runtime's own input request, with nothing in the transcript that
      // reads as a question — the reason must come from the request, not the
      // text.
      messages.set(String(threadId), "Here is where things stand so far.");

      yield* pumpRuntime(userInputRequested(threadId));

      const parked = boardCardStepState(yield* board, BoardCardId.make("structured"));
      assert.strictEqual(parked?.status, "awaiting-input");
      assert.strictEqual(parked?.awaitingReason, "question");
    }),
  );
});

it.effect("an agent that reports blocked parks with reason question", () => {
  const messages = new Map<string, string>();
  return withGovernor(planningBoard("blocked", messages), ({ pumpDomain, board }) =>
    Effect.gen(function* () {
      yield* startPlanning({ pumpDomain, board }, "blocked");
      yield* pumpDomain(
        stepCompleted(
          BoardCardId.make("blocked"),
          "blocked",
          2,
          String(BOARD_SEED_STAGE_IDS.planning),
        ),
      );

      const parked = boardCardStepState(yield* board, BoardCardId.make("blocked"));
      assert.strictEqual(parked?.status, "awaiting-input");
      assert.strictEqual(parked?.awaitingReason, "question");
    }),
  );
});

it.effect("re-entering the turn-end handler while already parked changes nothing", () => {
  const messages = new Map<string, string>();
  return withGovernor(planningBoard("idempotent", messages), ({ pumpDomain, pumpRuntime, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startPlanning({ pumpDomain, board }, "idempotent");
      messages.set(String(threadId), "Which way do you want this to go?");
      yield* pumpRuntime(turnCompleted(threadId));
      const first = boardCardStepState(yield* board, BoardCardId.make("idempotent"));
      assert.strictEqual(first?.awaitingReason, "question");

      // A second turn.completed with the transcript now reading as a plain
      // report must not flip the reason under a human who is mid-answer.
      messages.set(String(threadId), "Still here.");
      yield* pumpRuntime(turnCompleted(threadId));

      const second = boardCardStepState(yield* board, BoardCardId.make("idempotent"));
      assert.strictEqual(second?.status, "awaiting-input");
      assert.strictEqual(second?.awaitingReason, "question");
      assert.strictEqual(second?.updatedAt, first?.updatedAt);
    }),
  );
});

// ── Across a restart ───────────────────────────────────────────────────────
//
// Everything above is the LIVE edge: a turn ends and the reactor parks the step
// on the spot. Boot reconciliation is the other edge, and it used to disagree.
// It read a running step with no live turn as a death — nudging the waiting
// agent with the unattended "nobody will answer you" text, burning an attempt,
// and leaving the step `running`, so the card went on pulsing its blue "being
// worked" dot. On a machine that restarts a few times a day that is where a
// waiting card spends most of its life, so the live fix barely held.

const RESTART_THREAD = ThreadId.make("thread-restart");

/** A step as the database holds it across a restart: human-in-the-loop,
    `running`, and pointing at a thread whose turn ended while we were down. */
const seededStep = (overrides?: Partial<BoardCardStepState>): BoardCardStepState => ({
  cardId: BoardCardId.make("restart"),
  stepId: String(BOARD_SEED_STAGE_IDS.planning),
  stepLabel: null,
  stageLabel: "Planning",
  attempt: 1,
  stallCount: 0,
  lastNudgeAt: null,
  baseTipAtRoundStart: null,
  lastError: null,
  // Meaningless while the step is `running` (and the schema has no null for
  // it), so a leftover value sits here — which is also what keeps the park
  // assertions honest: they read a reason this run DERIVED, not this one.
  awaitingReason: "stopped" as const,
  prompt: "interview the human",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
  mode: "plan",
  runtimeMode: "auto",
  humanInLoop: true,
  maxAttempts: 3,
  timeoutMs: 60_000,
  threadId: RESTART_THREAD,
  status: "running",
  slotHeld: true,
  forceStart: false,
  startedAt: "1969-12-31T00:00:00.000Z",
  updatedAt: "1969-12-31T00:00:00.000Z",
  ...overrides,
});

/** The thread the seeded step points at: it EXISTS — a human can open it and
    answer — but nothing is running in it and no structured question is pending.
    That gap between "present" and "alive" is where a parked step lives. */
const idleShell = (): ReadonlyMap<string, OrchestrationThreadShell> =>
  new Map([
    [
      String(RESTART_THREAD),
      {
        hasPendingUserInput: false,
        session: { activeTurnId: null },
      } as unknown as OrchestrationThreadShell,
    ],
  ]);

const restartBoard = (step: BoardCardStepState, messages: Map<string, string>) => ({
  board: { cards: [planningCard("restart")], stepStates: [step], nextCardNumberByProject: {} },
  settings: settingsWith({
    building: [codexStep],
    planning: codexStep,
    planningHumanInLoop: true,
    globalMaxConcurrent: 3,
  }),
  initialShells: idleShell(),
  threadMessages: messages,
});

it.effect("boot reconcile parks a waiting human-in-the-loop step instead of nudging it", () => {
  const messages = new Map([
    [String(RESTART_THREAD), "Which way should the worktree be provisioned?"],
  ]);
  return withGovernor(restartBoard(seededStep(), messages), ({ board, commands, reactor }) =>
    Effect.gen(function* () {
      // Reconcile is enqueued by `start`; wait for the worker to settle it.
      yield* reactor.drain;
      const parked = boardCardStepState(yield* board, BoardCardId.make("restart"));
      assert.strictEqual(parked?.status, "awaiting-input");
      assert.strictEqual(parked?.awaitingReason, "question");
      // No recovery ran: the human's pause costs no attempt and no stall.
      assert.strictEqual(parked?.attempt, 1);
      assert.strictEqual(parked?.stallCount, 0);
      // And nothing was said to the waiting agent. The nudge this replaces told
      // an agent mid-conversation with a human that its run was unattended.
      assert.isUndefined((yield* commands).find((command) => command.type === "thread.turn.start"));
    }),
  );
});

it.effect("boot reconcile keeps a step parked on a PROSE question parked", () => {
  // The prose park leaves no pending question on the thread, so the thread
  // reads idle — and reconciliation used to read idle as gone and recover it.
  // Every restart un-parked the card and drove it as a stall.
  const messages = new Map([[String(RESTART_THREAD), "Which one do you want?"]]);
  return withGovernor(
    restartBoard(seededStep({ status: "awaiting-input", awaitingReason: "question" }), messages),
    ({ board, reactor }) =>
      Effect.gen(function* () {
        yield* reactor.drain;
        const still = boardCardStepState(yield* board, BoardCardId.make("restart"));
        assert.strictEqual(still?.status, "awaiting-input");
        assert.strictEqual(still?.awaitingReason, "question");
        assert.strictEqual(still?.attempt, 1);
      }),
  );
});

it.effect(
  "boot reconcile still recovers an UNATTENDED step whose turn ended while we were down",
  () => {
    // The behaviour the park must not swallow: with no human in the loop, an idle
    // thread is a death, and recovery is what gets the work moving again.
    const messages = new Map([[String(RESTART_THREAD), "I have finished exploring."]]);
    return withGovernor(
      restartBoard(seededStep({ humanInLoop: false }), messages),
      ({ board, reactor }) =>
        Effect.gen(function* () {
          yield* reactor.drain;
          const recovered = boardCardStepState(yield* board, BoardCardId.make("restart"));
          assert.strictEqual(recovered?.status, "running");
          assert.strictEqual(recovered?.attempt, 2);
        }),
    );
  },
);
