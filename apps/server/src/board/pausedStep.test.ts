/**
 * A human stop sticks, and every parked step frees its slot (T3O-23).
 *
 * Two supervisor defects with one shape. Interrupting an unattended step's turn
 * used to be undone within a beat — `handleTurnCompleted` saw a turn that ended
 * with no pending question, fell through to `recoverStep`, and nudged the agent
 * straight back to work, so there was no way to stop a card mid-build. And a
 * step parked on a question kept its concurrency slot, so a card could sit on an
 * unanswered question all weekend holding a worker.
 *
 * Driven through the live reactor against the stateful engine double
 * (`withGovernor`), because the behaviour spans the interrupt handler, the
 * decider, the governor's slot accounting and boot reconciliation.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  boardCardStepState,
  ProviderInstanceId,
  ThreadId,
  type BoardCardStepState,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { BOARD_STEP_RESUME_NUDGE } from "./supervisor.ts";
import {
  aliveThreadShell,
  buildingCard,
  cardMoved,
  codexStep,
  idleThreadShell,
  makeBoardCard,
  movedToBuilding,
  NOW,
  readyWorktree,
  settingsWith,
  stepCompleted,
  stepRequeued,
  stepStatus,
  turnCompleted,
  turnInterruptRequested,
  userInputRequested,
  withGovernor,
  type Harness,
} from "./supervisorHarness.testkit.ts";

const codex = ProviderInstanceId.make("codex");

/** A human turn arriving on a thread — the signal that a parked step is being
    worked again (t3o-17 D3; t3o-34 D5; T3O-23). */
const turnStartRequested = (threadId: ThreadId, sequence: number): OrchestrationEvent =>
  ({
    type: "thread.turn-start-requested",
    sequence,
    payload: { threadId },
  }) as unknown as OrchestrationEvent;

/** One unattended build card, the shape every stop test starts from. */
const oneBuildCard = (id: string, globalMaxConcurrent = 3) => ({
  board: { cards: [buildingCard(id, "m")], nextCardNumberByProject: {} },
  settings: settingsWith({ building: [codexStep], globalMaxConcurrent }),
});

/** Drive a card into a running, unattended build step and hand back its thread.
    Every test here starts from exactly this state. */
const startBuild = (h: Pick<Harness, "pumpDomain" | "board">, id: string, sequence = 1) =>
  Effect.gen(function* () {
    yield* h.pumpDomain(movedToBuilding(buildingCard(id, "m"), sequence));
    const state = boardCardStepState(yield* h.board, BoardCardId.make(id));
    assert.strictEqual(state?.status, "running");
    assert.strictEqual(state?.humanInLoop, false);
    assert.isNotNull(state?.threadId);
    return state!.threadId!;
  });

const commandTypes = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.map((command) => command.type);

// ── Bug 1: the stop sticks ────────────────────────────────────────────────

it.effect(
  "a human interrupt parks an unattended build step, frees its slot, and the trailing turn.completed does not un-park it",
  () =>
    withGovernor(oneBuildCard("stop"), ({ pumpDomain, pumpRuntime, board, slots, commands }) =>
      Effect.gen(function* () {
        const threadId = yield* startBuild({ pumpDomain, board }, "stop");
        assert.strictEqual(yield* slots.heldTotal, 1);

        yield* pumpDomain(turnInterruptRequested(threadId, 2));

        const paused = boardCardStepState(yield* board, BoardCardId.make("stop"));
        assert.strictEqual(paused?.status, "paused");
        // Bug 2's half, on the stop path: nothing is running, so the worker is
        // given back rather than held until somebody notices.
        assert.strictEqual(paused?.slotHeld, false);
        assert.strictEqual(yield* slots.heldTotal, 0);

        // THE headline regression. The interrupted turn's completion arrives a
        // beat later; before this it fell through to `recoverStep` and nudged
        // the agent straight back to work.
        yield* pumpRuntime(turnCompleted(threadId));

        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("stop")), "paused");
        assert.notInclude(commandTypes(yield* commands), "board.card.recover-step");
      }),
    ),
);

it.effect("pausing charges no stall, no attempt and no recovery budget", () =>
  withGovernor(oneBuildCard("budget"), ({ pumpDomain, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startBuild({ pumpDomain, board }, "budget");
      const before = boardCardStepState(yield* board, BoardCardId.make("budget"));

      yield* pumpDomain(turnInterruptRequested(threadId, 2));

      const paused = boardCardStepState(yield* board, BoardCardId.make("budget"));
      assert.strictEqual(paused?.status, "paused");
      // The human asked for this, so it is not a stall and it spends none of
      // the recovery ladder — otherwise stopping a card twice would escalate it.
      assert.strictEqual(paused?.stallCount, before?.stallCount);
      assert.strictEqual(paused?.attempt, before?.attempt);
      assert.strictEqual(paused?.stageEntryRecoveries, before?.stageEntryRecoveries);
      assert.strictEqual(paused?.threadId, threadId);
    }),
  ),
);

it.effect("pausing re-interrupts a turn the projection still shows as live", () =>
  withGovernor(oneBuildCard("race"), ({ pumpDomain, board, shells, commands }) =>
    Effect.gen(function* () {
      const threadId = yield* startBuild({ pumpDomain, board }, "race");
      yield* Ref.update(
        shells,
        (current) => new Map([...current, [String(threadId), aliveThreadShell(String(threadId))]]),
      );

      yield* pumpDomain(turnInterruptRequested(threadId, 2));

      // Closes the ordering race against `recoverStep`: if `turn.completed` was
      // processed first, a fresh nudge turn is already running, and a step that
      // says `Paused` while an agent works is the lie this exists to prevent.
      const interrupts = (yield* commands).filter(
        (command) => command.type === "thread.turn.interrupt",
      );
      assert.strictEqual(interrupts.length, 1);
    }),
  ),
);

/** A running, unattended build step one stall short of `maxAttempts` — the end
    of the recovery ladder, where the next unproductive stop escalates instead of
    nudging. Seeded rather than driven, because reaching the ceiling through the
    reactor takes `maxAttempts` full recovery cycles that have nothing to do with
    what this asserts. */
const atTheCeiling = (id: string): BoardCardStepState => ({
  cardId: BoardCardId.make(id),
  stepId: "building",
  stepLabel: "Building",
  stageLabel: "Building",
  attempt: 1,
  stallCount: 2,
  stageEntryRecoveries: 0,
  humanTurnAt: null,
  lastNudgeAt: null,
  baseTipAtRoundStart: null,
  lastError: null,
  awaitingReason: "question",
  prompt: "build it",
  providerInstanceId: codex,
  model: "gpt-5-codex",
  mode: "build",
  runtimeMode: "auto",
  humanInLoop: false,
  maxAttempts: 3,
  timeoutMs: 60_000,
  threadId: ThreadId.make(`thread-${id}`),
  status: "running",
  // The escalation gives the slot back itself; starting at false keeps this
  // test's slot assertion about the PAUSE and nothing else.
  slotHeld: false,
  forceStart: false,
  startedAt: NOW,
  updatedAt: NOW,
});

it.effect("a human stop still parks the card when an escalation won the ordering race", () =>
  withGovernor(
    {
      board: {
        cards: [
          makeBoardCard({
            id: "lost-stop",
            stage: "building",
            orderKey: "m",
            worktree: readyWorktree("lost-stop"),
          }),
        ],
        stepStates: [atTheCeiling("lost-stop")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: new Map([["thread-lost-stop", idleThreadShell("thread-lost-stop")]]),
    },
    ({ pumpDomain, pumpRuntime, board, slots }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-lost-stop");

        // The reverse interleaving. Both streams merge into ONE serialised
        // worker with no ordering guarantee, so the interrupted turn's
        // `turn.completed` can be processed BEFORE the interrupt — and with no
        // ladder budget left that routes through `recoverStep` to ESCALATE
        // rather than to a nudge.
        yield* pumpRuntime(turnCompleted(threadId));
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("lost-stop")), "stalled");

        yield* pumpDomain(turnInterruptRequested(threadId, 2));

        // The human's Stop is authoritative over an escalation that landed a
        // beat earlier: they get the neutral `Paused` they asked for, not the
        // loud "Needs a human" chip. Before this the pause guard refused a
        // `stalled` step and the Stop was dropped on the floor.
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("lost-stop")), "paused");
        // The escalation already released the slot; the pause must not release a
        // second one — an undercount is as damaging as a leak.
        assert.strictEqual(yield* slots.heldTotal, 0);
      }),
  ),
);

it.effect("a paused step is never nudged by the timeout sweep", () =>
  withGovernor(oneBuildCard("sweep"), ({ pumpDomain, board, commands, reactor }) =>
    Effect.gen(function* () {
      const threadId = yield* startBuild({ pumpDomain, board }, "sweep");
      yield* pumpDomain(turnInterruptRequested(threadId, 2));

      // The sweep enforces `timeoutMs` on unattended running steps; a paused one
      // is not running, and driving it would be the board undoing a human stop
      // on a timer.
      yield* reactor.sweep;
      yield* reactor.drain;

      assert.strictEqual(stepStatus(yield* board, BoardCardId.make("sweep")), "paused");
      assert.notInclude(commandTypes(yield* commands), "board.card.recover-step");
    }),
  ),
);

it.effect("boot reconciliation leaves a paused step alone and restores no slot", () =>
  withGovernor(oneBuildCard("reboot"), ({ pumpDomain, board, slots, reactor, commands }) =>
    Effect.gen(function* () {
      const threadId = yield* startBuild({ pumpDomain, board }, "reboot");
      yield* pumpDomain(turnInterruptRequested(threadId, 2));
      assert.strictEqual(yield* slots.heldTotal, 0);

      yield* reactor.reconcile;
      yield* reactor.drain;

      assert.strictEqual(stepStatus(yield* board, BoardCardId.make("reboot")), "paused");
      // A paused step released its slot, so reconcile must not re-take one — an
      // over-count halves throughput exactly as a leak does.
      assert.strictEqual(yield* slots.heldTotal, 0);
      assert.notInclude(commandTypes(yield* commands), "board.card.recover-step");
    }),
  ),
);

// ── The board's own interrupts are not a human stop ───────────────────────

it.effect("the board interrupting a thread it abandoned does not pause the card", () =>
  withGovernor(oneBuildCard("abandon"), ({ pumpDomain, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startBuild({ pumpDomain, board }, "abandon");
      // A drag out of Building: the reactor settles the leftover step abandoned
      // and interrupts its thread, which emits the very same event a human Stop
      // does. Reading that as a human stop would park a card that has moved on.
      const moved = makeBoardCard({ id: "abandon", stage: "review", orderKey: "m" });
      yield* pumpDomain(cardMoved(moved, "building", "review", 2));

      yield* pumpDomain(turnInterruptRequested(threadId, 3));

      assert.notStrictEqual(stepStatus(yield* board, BoardCardId.make("abandon")), "paused");
    }),
  ),
);

// ── Getting back out ──────────────────────────────────────────────────────

it.effect("a human turn in the paused step's thread resumes it and re-takes the slot", () =>
  withGovernor(oneBuildCard("typed"), ({ pumpDomain, board, slots }) =>
    Effect.gen(function* () {
      const threadId = yield* startBuild({ pumpDomain, board }, "typed");
      yield* pumpDomain(turnInterruptRequested(threadId, 2));
      assert.strictEqual(yield* slots.heldTotal, 0);

      // The human typed in the thread themselves, so the agent is ALREADY
      // working: rendering `Queued` here would be a lying label, and the step
      // takes its slot rather than asking for one.
      yield* pumpDomain(turnStartRequested(threadId, 3));

      const resumed = boardCardStepState(yield* board, BoardCardId.make("typed"));
      assert.strictEqual(resumed?.status, "running");
      assert.strictEqual(resumed?.slotHeld, true);
      assert.strictEqual(yield* slots.heldTotal, 1);
    }),
  ),
);

it.effect("Resume sends a paused step through the queue and nudges its EXISTING thread", () =>
  withGovernor(oneBuildCard("resume"), ({ pumpDomain, board, shells, slots, commands }) =>
    Effect.gen(function* () {
      const threadId = yield* startBuild({ pumpDomain, board }, "resume");
      // The thread has to still EXIST for the resume to reuse it; a gone
      // thread falls through to an ordinary spawn, which is the right
      // recovery and a different test's business.
      yield* Ref.update(
        shells,
        (current) => new Map([...current, [String(threadId), idleThreadShell(String(threadId))]]),
      );
      yield* pumpDomain(turnInterruptRequested(threadId, 2));
      const paused = boardCardStepState(yield* board, BoardCardId.make("resume"));
      assert.strictEqual(paused?.status, "paused");

      const spawnsBefore = commandTypes(yield* commands).filter(
        (type) => type === "thread.create",
      ).length;

      // The card's Resume button: back to `queued`, holding no slot, and the
      // governor admits it the ordinary way.
      yield* pumpDomain(stepRequeued(paused!, 3));

      const admitted = boardCardStepState(yield* board, BoardCardId.make("resume"));
      assert.strictEqual(admitted?.status, "running");
      assert.strictEqual(admitted?.threadId, threadId);
      assert.strictEqual(yield* slots.heldTotal, 1);

      // No SECOND thread, and no full step prompt: the agent's context, todo
      // list and half-finished work all live in the thread it already has.
      const after = yield* commands;
      assert.strictEqual(
        commandTypes(after).filter((type) => type === "thread.create").length,
        spawnsBefore,
      );
      const turns = after.filter(
        (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
          command.type === "thread.turn.start",
      );
      assert.strictEqual(turns.at(-1)?.message.text, BOARD_STEP_RESUME_NUDGE);
    }),
  ),
);

it.effect("Resume continues a paused PLANNING conversation rather than restarting it", () =>
  withGovernor(
    {
      board: {
        cards: [makeBoardCard({ id: "plan", stage: "planning", orderKey: "m" })],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({
        building: [codexStep],
        planning: codexStep,
        planningHumanInLoop: true,
        globalMaxConcurrent: 3,
      }),
    },
    ({ pumpDomain, board, shells, slots, commands }) =>
      Effect.gen(function* () {
        yield* pumpDomain(
          cardMoved(
            makeBoardCard({ id: "plan", stage: "planning", orderKey: "m" }),
            "sprint",
            "planning",
            1,
          ),
        );
        const running = boardCardStepState(yield* board, BoardCardId.make("plan"));
        assert.strictEqual(running?.status, "running");
        // A plan-mode step holds no slot at all (D5), so the only thing Resume
        // has to get right here is the CONVERSATION.
        assert.strictEqual(running?.mode, "plan");
        assert.strictEqual(yield* slots.heldTotal, 0);
        const threadId = running!.threadId!;
        yield* Ref.update(
          shells,
          (current) => new Map([...current, [String(threadId), idleThreadShell(String(threadId))]]),
        );

        yield* pumpDomain(turnInterruptRequested(threadId, 2));
        const paused = boardCardStepState(yield* board, BoardCardId.make("plan"));
        assert.strictEqual(paused?.status, "paused");
        const spawnsBefore = commandTypes(yield* commands).filter(
          (type) => type === "thread.create",
        ).length;

        // Nothing withholds a plan step, so `queued` was unreachable before
        // this — and a schedule pass that skipped it would wedge the card in
        // the queue with nobody left to admit it.
        yield* pumpDomain(stepRequeued(paused!, 3));

        const resumed = boardCardStepState(yield* board, BoardCardId.make("plan"));
        assert.strictEqual(resumed?.status, "running");
        assert.strictEqual(resumed?.threadId, threadId);
        assert.strictEqual(
          commandTypes(yield* commands).filter((type) => type === "thread.create").length,
          spawnsBefore,
        );
      }),
  ),
);

it.effect("a step admitted out of the queue is not instantly overdue", () =>
  withGovernor(oneBuildCard("nudged-at"), ({ pumpDomain, board, shells }) =>
    Effect.gen(function* () {
      const threadId = yield* startBuild({ pumpDomain, board }, "nudged-at");
      yield* Ref.update(
        shells,
        (current) => new Map([...current, [String(threadId), idleThreadShell(String(threadId))]]),
      );
      yield* pumpDomain(turnInterruptRequested(threadId, 2));
      const paused = boardCardStepState(yield* board, BoardCardId.make("nudged-at"));

      yield* pumpDomain(stepRequeued(paused!, 3));

      // `sweepTimeouts` measures from `lastNudgeAt` in preference to
      // `startedAt`, so a step that sat queued for hours would be overdue the
      // instant it was admitted if admission did not move it.
      const admitted = boardCardStepState(yield* board, BoardCardId.make("nudged-at"));
      assert.strictEqual(admitted?.lastNudgeAt, admitted?.startedAt);
    }),
  ),
);

// ── Bug 2: a step parked on a QUESTION frees its slot too ─────────────────

it.effect("a card parked on a question frees capacity for the next card", () =>
  withGovernor(
    {
      board: {
        cards: [buildingCard("card-a", "a"), buildingCard("card-b", "b")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 1 }),
    },
    ({ pumpDomain, pumpRuntime, board, slots }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(buildingCard("card-a", "a"), 1));
        yield* pumpDomain(movedToBuilding(buildingCard("card-b", "b"), 2));
        const queued = yield* board;
        assert.strictEqual(stepStatus(queued, BoardCardId.make("card-b")), "queued");
        const threadA = boardCardStepState(queued, BoardCardId.make("card-a"))?.threadId;
        assert.isNotNull(threadA);

        // card-a's agent asks a question. Nobody is working on it from here on,
        // and before this it went on holding the only slot for as long as the
        // question went unanswered.
        yield* pumpRuntime(userInputRequested(threadA!));

        const parked = yield* board;
        assert.strictEqual(stepStatus(parked, BoardCardId.make("card-a")), "awaiting-input");
        assert.strictEqual(boardCardStepState(parked, BoardCardId.make("card-a"))?.slotHeld, false);
        // The freed slot flows to the queue within a beat, not at the next step
        // boundary — that is what the release is for.
        assert.strictEqual(stepStatus(parked, BoardCardId.make("card-b")), "running");
        assert.strictEqual(yield* slots.heldTotal, 1);
      }),
  ),
);

it.effect("slot accounting returns to zero across park → resume → settle", () =>
  withGovernor(oneBuildCard("balance"), ({ pumpDomain, pumpRuntime, board, slots }) =>
    Effect.gen(function* () {
      const threadId = yield* startBuild({ pumpDomain, board }, "balance");
      assert.strictEqual(yield* slots.heldTotal, 1);

      yield* pumpRuntime(userInputRequested(threadId));
      // Both halves: the persisted flag on the row, which is what the settle
      // path reads, and the in-memory count the governor caps against.
      assert.strictEqual(
        boardCardStepState(yield* board, BoardCardId.make("balance"))?.slotHeld,
        false,
      );
      assert.strictEqual(yield* slots.heldTotal, 0);

      // The human answers, so the step is running again and takes a slot back.
      yield* pumpDomain(turnStartRequested(threadId, 2));
      assert.strictEqual(yield* slots.heldTotal, 1);

      // …and releases it exactly once at the terminal outcome. A second release
      // here would floor at zero and silently under-count throughput forever.
      yield* pumpDomain(
        stepCompleted(
          BoardCardId.make("balance"),
          "succeeded",
          3,
          String(BOARD_SEED_STAGE_IDS.building),
        ),
      );
      assert.strictEqual(yield* slots.heldTotal, 0);
      assert.strictEqual(yield* slots.heldFor(codex), 0);
    }),
  ),
);
