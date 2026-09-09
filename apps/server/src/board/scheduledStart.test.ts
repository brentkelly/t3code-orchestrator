/**
 * Scheduled starts (T3O-19): one nullable instant on the card that holds it
 * still until its moment, then makes the move the supervisor would otherwise
 * have made now — and clears itself doing it.
 *
 * Driven through the live reactor against the stateful engine double
 * (`withGovernor`), because the behaviour spans the governor's gate, the slot
 * accounting, worktree provisioning, the decider and the 30s tick.
 *
 * `it.effect` runs on the TestClock, whose "now" is the epoch, so FUTURE and
 * PAST fixtures sit an hour either side of it. Nothing here sleeps, polls or
 * advances the clock: the tick is driven by calling the reactor's own
 * `fireSchedules` hook, exactly as the timeout-sweep suite drives `sweep`.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  boardCardStepState,
  ProviderInstanceId,
  type BoardCard,
  type BoardCardStepState,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  aliveThreadShell,
  idleThreadShell,
  cardScheduleUpdated,
  cardTitleUpdated,
  codexStep,
  makeBoardCard,
  movedToBuilding,
  readyWorktree,
  settingsWith,
  stepStatus,
  turnInterruptRequested,
  withGovernor,
  type Harness,
} from "./supervisorHarness.testkit.ts";

const codex = ProviderInstanceId.make("codex");

/** A step a human force-started (t3o-33) on a card that also carries a
    schedule — the one state in which the gate's `forceStart` bypass is
    reachable. */
const forcedQueuedStep = (id: string): BoardCardStepState => ({
  cardId: BoardCardId.make(id),
  stepId: String(BOARD_SEED_STAGE_IDS.building),
  stepLabel: "Building",
  stageLabel: "Building",
  attempt: 1,
  stallCount: 0,
  stageEntryRecoveries: 0,
  lastNudgeAt: null,
  baseTipAtRoundStart: null,
  lastError: null,
  awaitingReason: "question",
  stalledReason: "gave-up",
  retryAt: null,
  prompt: "build it",
  providerInstanceId: codex,
  model: "gpt-5-codex",
  mode: "build",
  runtimeMode: "auto",
  humanInLoop: false,
  maxAttempts: 3,
  timeoutMs: 60_000,
  status: "queued",
  slotHeld: false,
  forceStart: true,
  threadId: null,
  startedAt: null,
  updatedAt: "1970-01-01T00:00:00.000Z",
});

/** One hour after the TestClock epoch: decisively not yet due. */
const FUTURE = "1970-01-01T01:00:00.000Z";
/** One hour before it: decisively due, and the "a past time means now" case. */
const PAST = "1969-12-31T23:00:00.000Z";

const commandTypes = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.map((command) => command.type);

/** A card mid-drag into Building, with the schedule the test wants. `worktree`
    is left off deliberately in the un-provisioned cases: the gate must be
    reached before `ensureWorktree`, and a fixture that arrived with one could
    never show that. */
const scheduledCard = (input: {
  readonly id: string;
  readonly scheduledStartAt?: string | null;
  readonly provisioned?: boolean;
}): BoardCard =>
  makeBoardCard({
    id: input.id,
    stage: "building",
    orderKey: "m",
    scheduledStartAt: input.scheduledStartAt ?? null,
    worktree: input.provisioned === false ? null : readyWorktree(input.id),
  });

const oneCard = (card: BoardCard, globalMaxConcurrent = 3) => ({
  board: { cards: [card], nextCardNumberByProject: {} },
  settings: settingsWith({ building: [codexStep], globalMaxConcurrent }),
});

/** Drive a card into a running, unattended build step. */
const startBuild = (h: Pick<Harness, "pumpDomain" | "board">, card: BoardCard) =>
  Effect.gen(function* () {
    yield* h.pumpDomain(movedToBuilding(card, 1));
    const state = boardCardStepState(yield* h.board, card.id);
    assert.strictEqual(state?.status, "running");
    assert.isNotNull(state?.threadId);
    return state!.threadId!;
  });

// ── The gate: a scheduled card costs nothing while it waits ───────────────

it.effect(
  "a card scheduled for later is not admitted, holds no slot and provisions no worktree",
  () =>
    withGovernor(
      oneCard(scheduledCard({ id: "held", scheduledStartAt: FUTURE, provisioned: false })),
      ({ pumpDomain, board, slots, commands }) =>
        Effect.gen(function* () {
          yield* pumpDomain(
            movedToBuilding(
              scheduledCard({ id: "held", scheduledStartAt: FUTURE, provisioned: false }),
              1,
            ),
          );

          const state = boardCardStepState(yield* board, BoardCardId.make("held"));
          // Selected, but never offered to the governor: `pending`, not
          // `queued`, so it takes no position ahead of cards genuinely waiting
          // on an agent and every other card's queue number stays right.
          assert.strictEqual(state?.status, "pending");
          assert.strictEqual(state?.slotHeld, false);
          assert.strictEqual(yield* slots.heldTotal, 0);
          // The gate sits BEFORE `ensureWorktree` (D2): a card scheduled for
          // tomorrow morning must not hold a checkout overnight, nor cut its
          // branch from a base that will have moved by the time it runs.
          const card = (yield* board).cards.find(
            (candidate) => candidate.id === BoardCardId.make("held"),
          );
          assert.isNull(card?.worktree ?? null);
          assert.notInclude(commandTypes(yield* commands), "thread.create");
        }),
    ),
);

it.effect("a plan-mode step is never withheld by a schedule", () =>
  withGovernor(
    {
      board: {
        cards: [
          makeBoardCard({
            id: "planning",
            stage: String(BOARD_SEED_STAGE_IDS.planning),
            orderKey: "m",
            scheduledStartAt: FUTURE,
          }),
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({
        building: [codexStep],
        globalMaxConcurrent: 3,
        planning: codexStep,
      }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(
          movedToBuilding(
            makeBoardCard({
              id: "planning",
              stage: String(BOARD_SEED_STAGE_IDS.planning),
              orderKey: "m",
              scheduledStartAt: FUTURE,
            }),
            1,
          ),
        );

        // What makes the create dialog's promise true: "no effect unless the
        // card has reached Ready or Building by then — planning and approval
        // still need you". A withheld planning step would make the copy a lie
        // and strand the card behind a gate it can never pass.
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("planning")), "running");
      }),
  ),
);

it.effect("a force-started step is admitted despite a schedule (the gate's one bypass)", () =>
  withGovernor(
    {
      board: {
        cards: [scheduledCard({ id: "forced", scheduledStartAt: FUTURE })],
        stepStates: [forcedQueuedStep("forced")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ board, reactor, commands }) =>
      Effect.gen(function* () {
        // Reconcile ends in a scheduling pass, which is the governor path the
        // gate lives on.
        yield* reactor.reconcile;
        yield* reactor.drain;

        // "Start it anyway" beats a time the same human set earlier, exactly as
        // it beats the concurrency cap. Nothing else in the board can reach a
        // scheduled step's `forceStart`, so this is a defensive guard rather
        // than a button — but a gate that ignored the override would be a card
        // whose "start anyway" silently did nothing.
        // Asserted on the ADMISSION rather than on the step's later status: the
        // gate's job is to let this candidate reach the governor, and what
        // happens to the step afterwards (this fixture seeds no thread shell, so
        // a second reconcile pass reads its spawned thread as gone and parks it
        // for a retry) is a different mechanism's business.
        assert.include(commandTypes(yield* commands), "board.card.admit-step");
      }),
  ),
);

// ── Firing: the move happens, and the time does not survive it ────────────

it.effect("the tick fires a due card with no other event to prompt it, and clears the time", () =>
  withGovernor(
    oneCard(scheduledCard({ id: "due", scheduledStartAt: FUTURE, provisioned: false })),
    ({ pumpDomain, board, reactor, slots }) =>
      Effect.gen(function* () {
        yield* pumpDomain(
          movedToBuilding(
            scheduledCard({ id: "due", scheduledStartAt: FUTURE, provisioned: false }),
            1,
          ),
        );
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("due")), "pending");

        // The card's time arrives. Nothing else happens on the board — no move,
        // no completion, no click — so the tick is the only thing that can
        // start it.
        yield* pumpDomain(
          cardScheduleUpdated(scheduledCard({ id: "due", provisioned: false }), PAST, 2),
        );
        yield* reactor.fireSchedules;
        yield* reactor.drain;

        const card = (yield* board).cards.find(
          (candidate) => candidate.id === BoardCardId.make("due"),
        );
        // AC3: the time does not survive its own firing. Without the clear, one
        // decision made before the build would re-gate Code review and every
        // stage after it.
        assert.isNull(card?.scheduledStartAt ?? null);
        // …and provisioning happens now, at the due moment, rather than having
        // held a checkout since the schedule was set.
        assert.strictEqual(card?.worktree?.status, "ready");
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("due")), "running");
        assert.strictEqual(yield* slots.heldTotal, 1);
      }),
  ),
);

it.effect("the clear lands before the admit", () =>
  withGovernor(
    oneCard(scheduledCard({ id: "order", scheduledStartAt: FUTURE })),
    ({ pumpDomain, commands }) =>
      Effect.gen(function* () {
        const held = scheduledCard({ id: "order", scheduledStartAt: FUTURE });
        yield* pumpDomain(movedToBuilding(held, 1));
        // Nothing has been admitted yet — the gate is holding it — so the two
        // indices below can only come from the firing itself.
        assert.notInclude(commandTypes(yield* commands), "board.card.admit-step");

        yield* pumpDomain(cardScheduleUpdated(held, PAST, 2));

        const types = commandTypes(yield* commands);
        const cleared = types.indexOf("board.card.update");
        const admitted = types.indexOf("board.card.admit-step");
        assert.isAbove(cleared, -1);
        assert.isAbove(admitted, -1);
        // D4. A crash between the two must leave a cleared-but-unstarted card,
        // which the next pass starts — never a started card still carrying a
        // stale time that would re-gate its next stage.
        assert.isBelow(cleared, admitted);
      }),
  ),
);

it.effect("a card whose schedule is in the past is admitted the moment it is set", () =>
  withGovernor(oneCard(scheduledCard({ id: "past" })), ({ pumpDomain, board }) =>
    Effect.gen(function* () {
      yield* pumpDomain(movedToBuilding(scheduledCard({ id: "past", scheduledStartAt: PAST }), 1));

      // A past time means "now" (D6): the picker refuses none, and the card
      // must not sit holding a pill for a moment that has already gone.
      const card = (yield* board).cards.find(
        (candidate) => candidate.id === BoardCardId.make("past"),
      );
      assert.strictEqual(stepStatus(yield* board, BoardCardId.make("past")), "running");
      assert.isNull(card?.scheduledStartAt ?? null);
    }),
  ),
);

// ── Setting a time on a card that is working right now ────────────────────

it.effect("scheduling a running card stops the agent and gives its slot back", () =>
  withGovernor(
    oneCard(scheduledCard({ id: "pause" })),
    ({ pumpDomain, board, slots, commands, shells }) =>
      Effect.gen(function* () {
        const threadId = yield* startBuild({ pumpDomain, board }, scheduledCard({ id: "pause" }));
        assert.strictEqual(yield* slots.heldTotal, 1);
        // The spawned thread has a LIVE turn: interrupting is only meaningful
        // against one, and a shell without it would let the assertion below
        // pass for the wrong reason.
        yield* Ref.set(shells, new Map([[String(threadId), aliveThreadShell(String(threadId))]]));

        yield* pumpDomain(cardScheduleUpdated(scheduledCard({ id: "pause" }), FUTURE, 2));

        // D13: the popover says setting a time on a working card stops it, and
        // this is that promise. The thread and worktree are kept, so the resume
        // picks the conversation up rather than starting over.
        const state = boardCardStepState(yield* board, BoardCardId.make("pause"));
        assert.strictEqual(state?.status, "paused");
        assert.strictEqual(state?.slotHeld, false);
        assert.isNotNull(state?.threadId);
        assert.strictEqual(yield* slots.heldTotal, 0);
        // The agent is stopped, not merely marked stopped.
        assert.include(commandTypes(yield* commands), "thread.turn.interrupt");
      }),
  ),
);

it.effect("the freed slot goes straight to a card that was waiting for one", () =>
  withGovernor(
    {
      board: {
        cards: [scheduledCard({ id: "aaa" }), scheduledCard({ id: "bbb" })],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 1 }),
    },
    ({ pumpDomain, board, slots }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(scheduledCard({ id: "aaa" }), 1));
        yield* pumpDomain(movedToBuilding(scheduledCard({ id: "bbb" }), 2));
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("aaa")), "running");
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("bbb")), "queued");

        yield* pumpDomain(cardScheduleUpdated(scheduledCard({ id: "aaa" }), FUTURE, 3));

        // The whole point of releasing the slot: it flows to the queue within a
        // beat, not at some unrelated step boundary.
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("aaa")), "paused");
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("bbb")), "running");
        assert.strictEqual(yield* slots.heldTotal, 1);
      }),
  ),
);

it.effect("a step already parked on a question is left parked, not re-parked", () =>
  withGovernor(oneCard(scheduledCard({ id: "asking" })), ({ pumpDomain, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startBuild({ pumpDomain, board }, scheduledCard({ id: "asking" }));
      yield* pumpDomain(turnInterruptRequested(threadId, 2));
      assert.strictEqual(stepStatus(yield* board, BoardCardId.make("asking")), "paused");

      yield* pumpDomain(cardScheduleUpdated(scheduledCard({ id: "asking" }), FUTURE, 3));

      // Nothing to stop, and re-parking would only churn a delta. The time
      // schedules its EXIT; the card keeps the state it is in.
      assert.strictEqual(stepStatus(yield* board, BoardCardId.make("asking")), "paused");
    }),
  ),
);

// ── Getting back out, in every state ──────────────────────────────────────

it.effect("clearing a schedule resumes a paused card on the thread it already had", () =>
  withGovernor(oneCard(scheduledCard({ id: "resume" })), ({ pumpDomain, board, slots, shells }) =>
    Effect.gen(function* () {
      const threadId = yield* startBuild({ pumpDomain, board }, scheduledCard({ id: "resume" }));
      // The thread the step is paused on still EXISTS — which is what makes
      // resuming into it possible at all. A missing shell reads as a dead
      // thread and respawns, so the assertion below would pass vacuously.
      yield* Ref.set(shells, new Map([[String(threadId), idleThreadShell(String(threadId))]]));
      yield* pumpDomain(cardScheduleUpdated(scheduledCard({ id: "resume" }), FUTURE, 2));
      assert.strictEqual(stepStatus(yield* board, BoardCardId.make("resume")), "paused");

      yield* pumpDomain(
        cardScheduleUpdated(
          { ...scheduledCard({ id: "resume" }), scheduledStartAt: FUTURE },
          null,
          3,
        ),
      );

      // D6: clearing is the reverse state AND the "start now" button. A card
      // that could only be released by waiting would be the one-way door
      // AGENTS.md forbids.
      const state = boardCardStepState(yield* board, BoardCardId.make("resume"));
      assert.strictEqual(state?.status, "running");
      // The SAME thread: the agent picks up the conversation it was having.
      assert.strictEqual(state?.threadId, threadId);
      assert.strictEqual(yield* slots.heldTotal, 1);
    }),
  ),
);

it.effect("a timed resume respawns when the paused step's thread is gone", () =>
  withGovernor(oneCard(scheduledCard({ id: "dead" })), ({ pumpDomain, board, commands }) =>
    Effect.gen(function* () {
      const threadId = yield* startBuild({ pumpDomain, board }, scheduledCard({ id: "dead" }));
      yield* pumpDomain(cardScheduleUpdated(scheduledCard({ id: "dead" }), FUTURE, 2));
      assert.strictEqual(stepStatus(yield* board, BoardCardId.make("dead")), "paused");
      const spawnsBeforeResume = commandTypes(yield* commands).filter(
        (type) => type === "thread.create",
      ).length;

      // No shell was ever seeded for the spawned thread, so it reads as gone —
      // a thread deleted, or a provider session that did not survive. The
      // resume must still start the stage rather than nudging a dead
      // conversation and reporting success.
      yield* pumpDomain(
        cardScheduleUpdated(
          { ...scheduledCard({ id: "dead" }), scheduledStartAt: FUTURE },
          null,
          3,
        ),
      );

      const state = boardCardStepState(yield* board, BoardCardId.make("dead"));
      assert.strictEqual(state?.status, "running");
      assert.notStrictEqual(state?.threadId, threadId);
      assert.isAbove(
        commandTypes(yield* commands).filter((type) => type === "thread.create").length,
        spawnsBeforeResume,
      );
    }),
  ),
);

it.effect("a due card with no free agent queues honestly rather than pretending", () =>
  withGovernor(
    {
      board: {
        cards: [
          scheduledCard({ id: "busy" }),
          scheduledCard({ id: "waiting", scheduledStartAt: FUTURE }),
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 1 }),
    },
    ({ pumpDomain, board, reactor, slots }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(scheduledCard({ id: "busy" }), 1));
        yield* pumpDomain(
          movedToBuilding(scheduledCard({ id: "waiting", scheduledStartAt: FUTURE }), 2),
        );
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("busy")), "running");
        // Held by its schedule, so it is `pending` — not `queued`, and not
        // counted against the card genuinely waiting for an agent.
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("waiting")), "pending");

        yield* pumpDomain(
          cardScheduleUpdated(scheduledCard({ id: "waiting", scheduledStartAt: FUTURE }), PAST, 3),
        );
        yield* reactor.fireSchedules;
        yield* reactor.drain;

        // Its time came and the only agent is busy. It joins the queue and says
        // `Queued`, which is the honest answer — the schedule promised a start
        // no earlier than then, not a start exactly then.
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("waiting")), "queued");
        assert.strictEqual(yield* slots.heldTotal, 1);
        const card = (yield* board).cards.find(
          (candidate) => candidate.id === BoardCardId.make("waiting"),
        );
        assert.isNull(card?.scheduledStartAt ?? null);
      }),
  ),
);

it.effect("clearing a schedule admits a card the gate was withholding", () =>
  withGovernor(
    oneCard(scheduledCard({ id: "release", scheduledStartAt: FUTURE, provisioned: false })),
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        const held = scheduledCard({ id: "release", scheduledStartAt: FUTURE, provisioned: false });
        yield* pumpDomain(movedToBuilding(held, 1));
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("release")), "pending");

        yield* pumpDomain(cardScheduleUpdated(held, null, 2));

        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("release")), "running");
      }),
  ),
);

it.effect("a manual resume clears the time, so the card is not re-paused later", () =>
  withGovernor(oneCard(scheduledCard({ id: "manual" })), ({ pumpDomain, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startBuild({ pumpDomain, board }, scheduledCard({ id: "manual" }));
      yield* pumpDomain(cardScheduleUpdated(scheduledCard({ id: "manual" }), FUTURE, 2));
      assert.strictEqual(stepStatus(yield* board, BoardCardId.make("manual")), "paused");

      // The human went back to the thread and typed. They have overtaken the
      // decision they made earlier, so the 9pm resume must not become a 9pm
      // re-pause of work they restarted at 3pm (D6).
      yield* pumpDomain({
        type: "thread.turn-start-requested",
        sequence: 3,
        payload: { threadId },
      } as never);

      const card = (yield* board).cards.find(
        (candidate) => candidate.id === BoardCardId.make("manual"),
      );
      assert.isNull(card?.scheduledStartAt ?? null);
      assert.strictEqual(stepStatus(yield* board, BoardCardId.make("manual")), "running");
    }),
  ),
);

// ── An unrelated edit is not a schedule edit ──────────────────────────────

it.effect("an edit that does not name the schedule leaves a parked card parked", () =>
  withGovernor(oneCard(scheduledCard({ id: "title" })), ({ pumpDomain, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startBuild({ pumpDomain, board }, scheduledCard({ id: "title" }));
      yield* pumpDomain(turnInterruptRequested(threadId, 2));
      assert.strictEqual(stepStatus(yield* board, BoardCardId.make("title")), "paused");

      yield* pumpDomain(cardTitleUpdated(scheduledCard({ id: "title" }), 3));

      // The payload key is what tells a schedule edit from a title edit. Read
      // as a clear, this would resume a card a human deliberately stopped.
      assert.strictEqual(stepStatus(yield* board, BoardCardId.make("title")), "paused");
    }),
  ),
);

// ── The sweep is quiet when it has nothing to do ──────────────────────────

it.effect("the tick leaves a card whose time has not arrived alone", () =>
  withGovernor(
    oneCard(scheduledCard({ id: "quiet", scheduledStartAt: FUTURE, provisioned: false })),
    ({ pumpDomain, board, reactor, commands }) =>
      Effect.gen(function* () {
        const held = scheduledCard({ id: "quiet", scheduledStartAt: FUTURE, provisioned: false });
        yield* pumpDomain(movedToBuilding(held, 1));

        yield* reactor.fireSchedules;
        yield* reactor.drain;

        const card = (yield* board).cards.find(
          (candidate) => candidate.id === BoardCardId.make("quiet"),
        );
        assert.strictEqual(card?.scheduledStartAt, FUTURE);
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("quiet")), "pending");
        assert.notInclude(commandTypes(yield* commands), "board.card.update");
      }),
  ),
);

it.effect("an archived card's schedule never fires", () =>
  withGovernor(
    {
      board: {
        cards: [
          {
            ...makeBoardCard({
              id: "gone",
              stage: "building",
              orderKey: "m",
              scheduledStartAt: PAST,
            }),
            archivedAt: "1970-01-01T00:00:00.000Z" as BoardCard["archivedAt"],
          },
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ reactor, commands }) =>
      Effect.gen(function* () {
        yield* reactor.fireSchedules;
        yield* reactor.drain;

        assert.notInclude(commandTypes(yield* commands), "board.card.update");
      }),
  ),
);
