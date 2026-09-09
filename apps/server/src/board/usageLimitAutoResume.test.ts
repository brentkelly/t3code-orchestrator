/**
 * Usage limits: detect, park, auto-resume (T3O-22).
 *
 * The defect: when a provider is out of quota it answers in under a second with
 * the same sentence every time, so the board's five-nudge recovery ladder — which
 * assumes nudging takes time — was spent in TWELVE SECONDS and the card declared
 * dead for the night. Two cards on the live board did exactly that.
 *
 * Driven through the live reactor against the stateful engine double
 * (`withGovernor`), because the behaviour spans the classifier seam, the
 * governor's gate, slot accounting, the decider and the 30s tick.
 *
 * The detector is STUBBED throughout (criterion 25): the suite drives `wait` /
 * `exhausted` / `slow-down` / null verdicts directly rather than crafting
 * provider prose and hoping the classifier agrees. The classifier has three
 * suites of its own in `packages/contracts`, and these tests are about the
 * SUPERVISOR. `setUsageVerdict` is how a thread's verdict changes mid-run, which
 * is the probe story: the same thread refuses once, then answers cleanly.
 *
 * `it.effect` runs on the TestClock, whose "now" is the epoch, so every reset
 * time here sits a fixed distance from it and the clock is advanced explicitly.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  boardCardStepState,
  boardProviderLimit,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardCardStepState,
  type BoardUsageLimitMatch,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { BOARD_STEP_USAGE_LIMIT_RESUME_NUDGE } from "./supervisor.ts";
import {
  cardArchived,
  cardMoved,
  codexStep,
  idleThreadShell,
  makeBoardCard,
  movedToBuilding,
  readyWorktree,
  settingsWith,
  turnCompleted,
  withGovernor,
  type Harness,
} from "./supervisorHarness.testkit.ts";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const claudeStep = { providerInstanceId: claude, prompt: "build it" };

/** An hour past the TestClock epoch — decisively ahead of any backoff rung. */
const RESETS_AT = "1970-01-01T01:00:00.000Z";

const buildingCard = (id: string, orderKey: string): BoardCard =>
  makeBoardCard({
    id,
    stage: String(BOARD_SEED_STAGE_IDS.building),
    orderKey,
    worktree: readyWorktree(id),
  });

/** The provider said "resets at 01:00", unambiguously and in a bare one-liner. */
const waitAt = (resumeAt: string | null = RESETS_AT): BoardUsageLimitMatch => ({
  kind: "wait",
  confidence: "strict",
  resumeAt,
  reason: "You've hit your session limit · resets 2:50am (Pacific/Auckland)",
  ruleId: "claude-code.session-limit",
});

/** The same sentence quoted inside an agent's own long message: real enough to
    back ONE card off, nowhere near enough to freeze a provider (D6). */
const looseWait = (resumeAt: string | null = null): BoardUsageLimitMatch => ({
  ...waitAt(resumeAt),
  confidence: "loose",
});

const exhausted = (): BoardUsageLimitMatch => ({
  kind: "exhausted",
  confidence: "strict",
  resumeAt: null,
  reason: "You exceeded your current quota, please check your plan and billing details",
  ruleId: "openai.insufficient-quota",
});

const slowDown = (): BoardUsageLimitMatch => ({
  kind: "slow-down",
  confidence: "strict",
  resumeAt: null,
  reason: "429 Too Many Requests",
  ruleId: "http.429",
});

/** Every turn the reactor sent into one thread, in order.
 *
 * The WORDS a resumed step is nudged with live nowhere on the card row, so this
 * is the only place a test can read them — and they are the whole point of the
 * resume: a quota park has to be told its window reopened, and a backoff rung
 * has to carry the recovery reminder it would have sent immediately. */
const turnTextsFor = (harness: Harness, threadId: ThreadId) =>
  harness.commands.pipe(
    Effect.map((commands) =>
      commands
        .filter(
          (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
            command.type === "thread.turn.start" && command.threadId === threadId,
        )
        .map((command) => command.message.text),
    ),
  );

const stepOf = (harness: Harness, id: string) =>
  harness.board.pipe(Effect.map((board) => boardCardStepState(board, BoardCardId.make(id))));

const limitOf = (harness: Harness, instanceId: ProviderInstanceId) =>
  harness.board.pipe(Effect.map((board) => boardProviderLimit(board, instanceId)));

/** Move a card into Building and seed its spawned thread's shell as idle, so a
    turn ending on it reads as "the agent stopped" rather than "the thread is
    gone". Returns the thread. */
const startCard = (harness: Harness, id: string, orderKey: string, sequence: number) =>
  Effect.gen(function* () {
    yield* harness.pumpDomain(movedToBuilding(buildingCard(id, orderKey), sequence));
    const state = yield* stepOf(harness, id);
    assert.ok(state?.threadId != null, `card ${id} spawned a thread`);
    const threadId = state.threadId;
    const instanceId = state.providerInstanceId;
    yield* Ref.update(
      harness.shells,
      (current) =>
        new Map([...current, [String(threadId), idleThreadShell(String(threadId), instanceId)]]),
    );
    return threadId;
  });

/** End a turn on a thread with a given verdict from the stubbed detector. */
const endTurn = (harness: Harness, threadId: ThreadId, verdict: BoardUsageLimitMatch | null) =>
  Effect.gen(function* () {
    harness.setUsageVerdict(String(threadId), verdict);
    yield* harness.pumpRuntime(turnCompleted(threadId));
  });

/** Start a card and stop it in one go — the shape most stops arrive in. Only
    usable for the FIRST card to stop on an instance: once a cooldown exists, a
    card that has not already started is withheld and never spawns a thread. */
const stopCard = (
  harness: Harness,
  id: string,
  orderKey: string,
  sequence: number,
  verdict: BoardUsageLimitMatch | null,
) =>
  Effect.gen(function* () {
    const threadId = yield* startCard(harness, id, orderKey, sequence);
    yield* endTurn(harness, threadId, verdict);
    return threadId;
  });

// ── A quota refusal parks the card and cools the provider down ─────────────

it.effect("a strict wait parks the card, costs nothing, and cools the provider down", () =>
  withGovernor(
    {
      board: { cards: [buildingCard("a", "a")], nextCardNumberByProject: {} },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    (harness) =>
      Effect.gen(function* () {
        yield* stopCard(harness, "a", "a", 1, waitAt());

        const parked = yield* stepOf(harness, "a");
        assert.strictEqual(parked?.status, "stalled");
        assert.strictEqual(parked?.stalledReason, "usage-limit");
        assert.strictEqual(parked?.retryAt, RESETS_AT);
        // The provider's own words, so the card says WHY rather than "stalled".
        assert.strictEqual(parked?.lastError, waitAt().reason);
        // D12: the card is not failing, the provider is. A card that hit a limit
        // at midnight would otherwise poll its way to death by 2:30am — twenty
        // minutes before the window reopened.
        assert.strictEqual(parked?.attempt, 1);
        assert.strictEqual(parked?.stallCount, 0);
        assert.strictEqual(parked?.stageEntryRecoveries, 0);
        // And it holds no capacity while it waits.
        assert.isFalse(parked?.slotHeld);
        assert.strictEqual(yield* harness.slots.heldFor(codex), 0);

        const limit = yield* limitOf(harness, codex);
        assert.strictEqual(limit?.kind, "wait");
        assert.strictEqual(limit?.until, RESETS_AT);
        assert.isTrue(limit?.knownTime);
        assert.strictEqual(limit?.blindSince, null);
        assert.strictEqual(limit?.ruleId, "claude-code.session-limit");
        assert.strictEqual(limit?.sourceCardId, BoardCardId.make("a"));
      }),
  ),
);

it.effect("a second card on the instance is withheld before any worktree is cut", () =>
  withGovernor(
    {
      board: {
        // `b` has NO worktree: if the gate ran late, provisioning it would be
        // the visible proof, which is why the fixture leaves it off.
        cards: [
          buildingCard("a", "a"),
          makeBoardCard({ id: "b", stage: String(BOARD_SEED_STAGE_IDS.building), orderKey: "b" }),
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    (harness) =>
      Effect.gen(function* () {
        yield* stopCard(harness, "a", "a", 1, waitAt());
        assert.strictEqual((yield* stepOf(harness, "a"))?.stalledReason, "usage-limit");

        // `b` arrives AFTER the cooldown is recorded and never starts.
        yield* harness.pumpDomain(
          movedToBuilding(
            makeBoardCard({
              id: "b",
              stage: String(BOARD_SEED_STAGE_IDS.building),
              orderKey: "b",
            }),
            2,
          ),
        );
        const held = yield* stepOf(harness, "b");
        assert.notStrictEqual(held?.status, "running");
        assert.strictEqual(held?.threadId, null);
        const card = (yield* harness.board).cards.find(
          (entry) => entry.id === BoardCardId.make("b"),
        );
        assert.strictEqual(card?.worktree, null, "a withheld card cuts no branch");
      }),
  ),
);

it.effect("a card on a DIFFERENT provider instance keeps running throughout", () =>
  withGovernor(
    {
      board: {
        cards: [
          buildingCard("a", "a"),
          makeBoardCard({ id: "other", stage: "planning", orderKey: "b" }),
        ],
        nextCardNumberByProject: {},
      },
      // Two stages on two instances: a usage limit belongs to one provider
      // ACCOUNT, so a cooldown on `codex` must say nothing about `claudeAgent`.
      settings: settingsWith({
        building: [codexStep],
        planning: claudeStep,
        globalMaxConcurrent: 3,
      }),
    },
    (harness) =>
      Effect.gen(function* () {
        yield* stopCard(harness, "a", "a", 1, waitAt());
        assert.strictEqual((yield* limitOf(harness, codex))?.kind, "wait");
        assert.strictEqual(yield* limitOf(harness, claude), null);

        yield* harness.pumpDomain(
          cardMoved(
            makeBoardCard({ id: "other", stage: "planning", orderKey: "b" }),
            "ready",
            "planning",
            2,
          ),
        );
        assert.strictEqual((yield* stepOf(harness, "other"))?.status, "running");
      }),
  ),
);

// ── An exhausted account never sleeps (D16) ───────────────────────────────

it.effect("out of credits escalates immediately, records no cooldown, and starts no polling", () =>
  withGovernor(
    {
      board: {
        cards: [buildingCard("a", "a"), buildingCard("b", "b")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    (harness) =>
      Effect.gen(function* () {
        yield* stopCard(harness, "a", "a", 1, exhausted());

        const parked = yield* stepOf(harness, "a");
        assert.strictEqual(parked?.status, "stalled");
        assert.strictEqual(parked?.stalledReason, "quota-exhausted");
        // Nothing to wait for, so no promise of a retry.
        assert.strictEqual(parked?.retryAt, null);
        assert.strictEqual(parked?.lastError, exhausted().reason);
        // The account is broken, not the card: no budget spent.
        assert.strictEqual(parked?.attempt, 1);

        // The record exists ONLY so the pill can say so. It gates nothing…
        const limit = yield* limitOf(harness, codex);
        assert.strictEqual(limit?.kind, "exhausted");
        assert.strictEqual(limit?.knownTime, false);
        assert.strictEqual(limit?.blindSince, null);

        // …so the next card starts normally and hits the same wall on its own
        // terms, correctly labelled, which needs no cross-card machinery.
        yield* harness.pumpDomain(movedToBuilding(buildingCard("b", "b"), 2));
        assert.strictEqual((yield* stepOf(harness, "b"))?.status, "running");
      }),
  ),
);

it.effect("a slow-down parks nothing and falls through to the ordinary backoff", () =>
  withGovernor(
    {
      board: { cards: [buildingCard("a", "a")], nextCardNumberByProject: {} },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    (harness) =>
      Effect.gen(function* () {
        yield* stopCard(harness, "a", "a", 1, slowDown());
        const parked = yield* stepOf(harness, "a");
        // The retry ladder handles it: a throttle clears well inside the first
        // rung, so gating the whole provider would trade seconds for minutes.
        assert.strictEqual(parked?.stalledReason, "waiting-retry");
        assert.strictEqual(yield* limitOf(harness, codex), null);
        assert.strictEqual(parked?.attempt, 2, "an ordinary retry charges the ladder");
      }),
  ),
);

// ── Loose matches corroborate across cards (D6) ───────────────────────────

it.effect("one loose match backs a single card off; a second from another card promotes", () =>
  withGovernor(
    {
      board: {
        cards: [buildingCard("a", "a"), buildingCard("b", "b"), buildingCard("c", "c")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    (harness) =>
      Effect.gen(function* () {
        yield* stopCard(harness, "a", "a", 1, looseWait());
        // Card-local: no cooldown, the card spends its own poke, and it skips
        // the 2-minute rung because whatever this is, another poke in two
        // minutes will not fix it.
        const first = yield* stepOf(harness, "a");
        assert.strictEqual(first?.stalledReason, "waiting-retry");
        assert.strictEqual(first?.attempt, 2);
        assert.strictEqual(yield* limitOf(harness, codex), null);

        // A DIFFERENT card saying the same thing promotes it to a real cooldown.
        yield* stopCard(harness, "b", "b", 2, looseWait());
        const limit = yield* limitOf(harness, codex);
        assert.strictEqual(limit?.kind, "wait");
        // No readable time, so it polls blind from now.
        assert.isFalse(limit?.knownTime);
        assert.isNotNull(limit?.blindSince);
        assert.strictEqual((yield* stepOf(harness, "b"))?.stalledReason, "usage-limit");

        // …and from then on the third card is withheld like any other.
        yield* harness.pumpDomain(movedToBuilding(buildingCard("c", "c"), 3));
        assert.notStrictEqual((yield* stepOf(harness, "c"))?.status, "running");
      }),
  ),
);

it.effect("a clean turn on the provider zeroes the loose-match tally", () =>
  withGovernor(
    {
      board: {
        cards: [buildingCard("a", "a"), buildingCard("b", "b"), buildingCard("c", "c")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    (harness) =>
      Effect.gen(function* () {
        // One loose match from card `a`…
        yield* stopCard(harness, "a", "a", 1, looseWait());
        // …then a turn the catalogue says nothing about, which is proof the
        // provider is answering. The tally starts over.
        yield* stopCard(harness, "b", "b", 2, null);
        // So a loose match from a THIRD card is the first of a new pair, not the
        // second of the old one, and promotes nothing.
        yield* stopCard(harness, "c", "c", 3, looseWait());
        assert.strictEqual(yield* limitOf(harness, codex), null);
      }),
  ),
);

it.effect("the same card repeating a loose match never promotes on its own", () =>
  withGovernor(
    {
      board: { cards: [buildingCard("a", "a")], nextCardNumberByProject: {} },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    (harness) =>
      Effect.gen(function* () {
        // One confused agent writing repeatedly about quota errors must not be
        // able to freeze a provider by itself — the exact failure the two-card
        // rule exists to prevent.
        const thread = yield* stopCard(harness, "a", "a", 1, looseWait());
        yield* TestClock.adjust(Duration.minutes(31));
        yield* harness.reactor.fireRetries;
        yield* harness.reactor.drain;
        yield* harness.pumpRuntime(turnCompleted(thread));
        assert.strictEqual(yield* limitOf(harness, codex), null);
      }),
  ),
);

// ── One prober wakes, never the fleet (D9) ────────────────────────────────

it.effect("at the reset time exactly one card wakes, and a clean turn frees the rest", () =>
  withGovernor(
    {
      board: {
        cards: [buildingCard("a", "a"), buildingCard("b", "b")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    (harness) =>
      Effect.gen(function* () {
        // Both cards are already running when the limit lands — which is the
        // real shape: a cooldown withholds cards that have not STARTED, and the
        // ones already mid-turn park on their own next turn end.
        const threadA = yield* startCard(harness, "a", "a", 1);
        const threadB = yield* startCard(harness, "b", "b", 2);
        yield* endTurn(harness, threadA, waitAt());
        yield* endTurn(harness, threadB, waitAt());
        assert.strictEqual((yield* stepOf(harness, "b"))?.stalledReason, "usage-limit");

        // Just past the reset time, and no further: the 30s tick runs the probe
        // pass itself, so a longer advance would probe, resume, time the resumed
        // step out and re-park it several times over before the assertions ran.
        yield* TestClock.adjust(Duration.minutes(61));
        yield* harness.reactor.fireProbes;
        yield* harness.reactor.drain;

        // Exactly one. Ten cards arriving together at the moment a provider is
        // most likely to still say no is the failure this exists to remove.
        const statuses = [yield* stepOf(harness, "a"), yield* stepOf(harness, "b")].map(
          (state) => state?.status,
        );
        assert.strictEqual(statuses.filter((status) => status === "running").length, 1);
        assert.strictEqual(statuses.filter((status) => status === "stalled").length, 1);
        const probed = yield* limitOf(harness, codex);
        assert.isNotNull(probed?.probeCardId);

        // The prober's next turn answers cleanly → the cooldown lifts and every
        // OTHER usage-limit park goes back to work.
        const prober = probed?.probeCardId === BoardCardId.make("a") ? threadA : threadB;
        harness.setUsageVerdict(String(prober), null);
        yield* harness.pumpRuntime(turnCompleted(prober));
        assert.strictEqual(yield* limitOf(harness, codex), null);
        yield* harness.reactor.drain;
        for (const id of ["a", "b"]) {
          assert.notStrictEqual(
            (yield* stepOf(harness, id))?.stalledReason,
            "usage-limit",
            `card ${id} is no longer held by a lifted cooldown`,
          );
        }
      }),
  ),
);

it.effect("the woken prober is told its window reopened, not that it was paused", () =>
  withGovernor(
    {
      board: { cards: [buildingCard("a", "a")], nextCardNumberByProject: {} },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    (harness) =>
      Effect.gen(function* () {
        const thread = yield* stopCard(harness, "a", "a", 1, waitAt());
        assert.strictEqual((yield* stepOf(harness, "a"))?.stalledReason, "usage-limit");

        yield* TestClock.adjust(Duration.minutes(61));
        yield* harness.reactor.fireProbes;
        yield* harness.reactor.drain;
        assert.strictEqual((yield* stepOf(harness, "a"))?.status, "running");

        // Nothing stalled and nothing failed here — a provider refused and has
        // since come back — so the agent must not be told it was paused, which
        // is what it heard while the requeue cleared the reason the nudge is
        // chosen from.
        assert.strictEqual(
          (yield* turnTextsFor(harness, thread)).at(-1),
          BOARD_STEP_USAGE_LIMIT_RESUME_NUDGE,
        );
      }),
  ),
);

it.effect("a backoff rung arriving delivers the recovery nudge it deferred", () =>
  withGovernor(
    {
      board: { cards: [buildingCard("a", "a")], nextCardNumberByProject: {} },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    (harness) =>
      Effect.gen(function* () {
        const thread = yield* stopCard(harness, "a", "a", 1, null);
        assert.strictEqual((yield* stepOf(harness, "a"))?.stalledReason, "waiting-retry");

        yield* TestClock.adjust(Duration.minutes(10));
        yield* harness.reactor.fireRetries;
        yield* harness.reactor.drain;
        assert.strictEqual((yield* stepOf(harness, "a"))?.status, "running");

        // D7 defers the WORDS, not the recovery: the nudge is recomposed at
        // delivery from the step row. The unattended run has nobody to answer a
        // question, so the reminders are the only thing that gets the card
        // moving again — and a generic "you were paused" drops every one of them.
        const delivered = (yield* turnTextsFor(harness, thread)).at(-1) ?? "";
        assert.include(delivered, "board_complete_step");
        assert.include(delivered, "todo list");

        // And the reason does not outlive the resume: a step back at work wears
        // no stall, so the next pause cannot inherit this one's words.
        assert.strictEqual((yield* stepOf(harness, "a"))?.stalledReason, "gave-up");
        assert.strictEqual((yield* stepOf(harness, "a"))?.retryAt, null);
      }),
  ),
);

it.effect("a probe refused again reschedules the cooldown and re-parks only the prober", () =>
  withGovernor(
    {
      board: {
        cards: [buildingCard("a", "a"), buildingCard("b", "b")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    (harness) =>
      Effect.gen(function* () {
        const threadA = yield* startCard(harness, "a", "a", 1);
        const threadB = yield* startCard(harness, "b", "b", 2);
        yield* endTurn(harness, threadA, waitAt());
        yield* endTurn(harness, threadB, waitAt());
        // Just past the reset time, and no further: the 30s tick runs the probe
        // pass itself, so a longer advance would probe, resume, time the resumed
        // step out and re-park it several times over before the assertions ran.
        yield* TestClock.adjust(Duration.minutes(61));
        yield* harness.reactor.fireProbes;
        yield* harness.reactor.drain;

        const probed = yield* limitOf(harness, codex);
        const proberId = probed?.probeCardId;
        assert.isNotNull(proberId);
        const proberState = yield* stepOf(harness, String(proberId));
        const proberThread = proberState?.threadId;
        assert.ok(proberThread != null);

        // Still refused. The other cards never knew the probe happened.
        yield* harness.pumpRuntime(turnCompleted(proberThread));
        const rescheduled = yield* limitOf(harness, codex);
        assert.strictEqual(rescheduled?.kind, "wait");
        assert.strictEqual(
          (yield* stepOf(harness, String(proberId)))?.stalledReason,
          "usage-limit",
          "the prober goes back to waiting",
        );
      }),
  ),
);

it.effect("a probe that turns out to be a billing wall escalates every card it held", () =>
  withGovernor(
    {
      board: {
        cards: [buildingCard("a", "a"), buildingCard("b", "b")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    (harness) =>
      Effect.gen(function* () {
        const threadA = yield* startCard(harness, "a", "a", 1);
        const threadB = yield* startCard(harness, "b", "b", 2);
        yield* endTurn(harness, threadA, waitAt());
        yield* endTurn(harness, threadB, waitAt());
        // Just past the reset time, and no further: the 30s tick runs the probe
        // pass itself, so a longer advance would probe, resume, time the resumed
        // step out and re-park it several times over before the assertions ran.
        yield* TestClock.adjust(Duration.minutes(61));
        yield* harness.reactor.fireProbes;
        yield* harness.reactor.drain;

        const proberId = (yield* limitOf(harness, codex))?.probeCardId;
        assert.isNotNull(proberId);
        const proberThread = (yield* stepOf(harness, String(proberId)))?.threadId;
        assert.ok(proberThread != null);

        // The window we thought would reset turns out to have been a billing
        // wall all along.
        harness.setUsageVerdict(String(proberThread), exhausted());
        yield* harness.pumpRuntime(turnCompleted(proberThread));
        assert.strictEqual((yield* limitOf(harness, codex))?.kind, "exhausted");
        assert.strictEqual(
          (yield* stepOf(harness, String(proberId)))?.stalledReason,
          "quota-exhausted",
        );
      }),
  ),
);

it.effect("a cooldown holding no parked card is cleared rather than probed", () =>
  withGovernor(
    {
      board: { cards: [buildingCard("a", "a")], nextCardNumberByProject: {} },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    (harness) =>
      Effect.gen(function* () {
        yield* stopCard(harness, "a", "a", 1, waitAt());
        // The one card it held is archived. Holding the gate shut against cards
        // nobody parked would withhold fresh work for no reason.
        yield* harness.pumpDomain(cardArchived(buildingCard("a", "a"), 9));
        // Just past the reset time, and no further: the 30s tick runs the probe
        // pass itself, so a longer advance would probe, resume, time the resumed
        // step out and re-park it several times over before the assertions ran.
        yield* TestClock.adjust(Duration.minutes(61));
        yield* harness.reactor.fireProbes;
        yield* harness.reactor.drain;
        assert.strictEqual(yield* limitOf(harness, codex), null);
      }),
  ),
);

it.effect("any clean turn on the instance lifts the cooldown, board thread or not", () =>
  withGovernor(
    {
      board: {
        cards: [buildingCard("a", "a"), buildingCard("b", "b")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      // A thread the board does not own, on the same provider account.
      initialShells: new Map([["thread-human", idleThreadShell("thread-human", codex)]]),
    },
    (harness) =>
      Effect.gen(function* () {
        yield* stopCard(harness, "a", "a", 1, waitAt());
        assert.strictEqual((yield* limitOf(harness, codex))?.kind, "wait");

        // A human's own chat answers on the same account. If the provider is
        // demonstrably answering, there is nothing left to wait for.
        yield* harness.pumpRuntime(turnCompleted(ThreadId.make("thread-human")));
        assert.strictEqual(yield* limitOf(harness, codex), null);
        assert.notStrictEqual((yield* stepOf(harness, "a"))?.stalledReason, "usage-limit");
      }),
  ),
);

// ── Only this feature's own parks are ever resumed (D9) ───────────────────

it.effect("a card parked on an unanswered question is never resumed by a lifting cooldown", () =>
  withGovernor(
    {
      board: {
        cards: [buildingCard("a", "a"), buildingCard("asked", "b")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    (harness) =>
      Effect.gen(function* () {
        // `asked` stops with a real pending question — a state that has nothing
        // to do with the provider, and which a provider coming back says nothing
        // about. Resuming it would shove an unanswered question back into work.
        yield* harness.pumpDomain(movedToBuilding(buildingCard("asked", "b"), 1));
        const askedThread = (yield* stepOf(harness, "asked"))?.threadId;
        assert.ok(askedThread != null);
        yield* Ref.update(
          harness.shells,
          (current) =>
            new Map([
              ...current,
              [
                String(askedThread),
                {
                  ...idleThreadShell(String(askedThread), codex),
                  hasPendingUserInput: true,
                } as never,
              ],
            ]),
        );
        yield* harness.pumpRuntime(turnCompleted(askedThread));
        assert.strictEqual((yield* stepOf(harness, "asked"))?.status, "awaiting-input");

        yield* stopCard(harness, "a", "a", 2, waitAt());
        // Just past the reset time, and no further: the 30s tick runs the probe
        // pass itself, so a longer advance would probe, resume, time the resumed
        // step out and re-park it several times over before the assertions ran.
        yield* TestClock.adjust(Duration.minutes(61));
        yield* harness.reactor.fireProbes;
        yield* harness.reactor.drain;

        // The prober can only ever be the usage-limit park.
        assert.strictEqual((yield* stepOf(harness, "asked"))?.status, "awaiting-input");
      }),
  ),
);

// ── Human-in-the-loop is out of scope entirely (D11) ──────────────────────

it.effect("a human-in-the-loop step is never parked by a limit, and records no cooldown", () =>
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
    (harness) =>
      Effect.gen(function* () {
        yield* harness.pumpDomain(
          cardMoved(
            makeBoardCard({ id: "plan", stage: "planning", orderKey: "m" }),
            "ready",
            "planning",
            1,
          ),
        );
        const thread = (yield* stepOf(harness, "plan"))?.threadId;
        assert.ok(thread != null);
        yield* Ref.update(
          harness.shells,
          (current) =>
            new Map([...current, [String(thread), idleThreadShell(String(thread), codex)]]),
        );
        // An unmistakable refusal — which this step must never even be asked
        // about. Planning is an interview: a stopped planning card is waiting on
        // a person whatever the provider is doing, and agents there routinely
        // stop by asking in PROSE, which is a legitimate stop.
        harness.setUsageVerdict(String(thread), waitAt());
        yield* harness.pumpRuntime(turnCompleted(thread));

        const parked = yield* stepOf(harness, "plan");
        assert.strictEqual(parked?.status, "awaiting-input");
        assert.notStrictEqual(parked?.stalledReason, "usage-limit");
        assert.strictEqual(yield* limitOf(harness, codex), null, "no cooldown, no tally");
      }),
  ),
);

// ── The retry ladder, and the budget (D7/D12) ─────────────────────────────

it.effect("a non-quota stall climbs 2, 4, 8 minutes, releasing its slot between rungs", () =>
  withGovernor(
    {
      board: { cards: [buildingCard("a", "a")], nextCardNumberByProject: {} },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    (harness) =>
      Effect.gen(function* () {
        const thread = yield* stopCard(harness, "a", "a", 1, null);
        const rungs: Array<number> = [];
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const parked = yield* stepOf(harness, "a");
          assert.strictEqual(parked?.status, "stalled");
          assert.strictEqual(parked?.stalledReason, "waiting-retry");
          assert.isFalse(parked?.slotHeld, "a waiting card holds no capacity");
          assert.strictEqual(yield* harness.slots.heldFor(codex), 0);
          assert.ok(parked?.retryAt != null);
          rungs.push(Date.parse(parked.retryAt) - (yield* Clock.currentTimeMillis));

          // Past the rung but well inside the step's own 30-minute timeout, so
          // the tick's timeout sweep cannot fire and re-park the resumed step —
          // this test is about the ladder, not the sweep.
          yield* TestClock.adjust(Duration.minutes(10));
          yield* harness.reactor.fireRetries;
          yield* harness.reactor.drain;
          assert.strictEqual((yield* stepOf(harness, "a"))?.status, "running");
          yield* harness.pumpRuntime(turnCompleted(thread));
        }
        // 2, 4, 8 minutes, each jittered by at most a minute either way.
        const minutes = rungs.map((ms) => Math.round(ms / 60_000));
        assert.deepStrictEqual(
          minutes.map((value, index) => Math.abs(value - [2, 4, 8][index]!) <= 1),
          [true, true, true],
          `expected 2/4/8-minute rungs, got ${minutes.join(", ")}`,
        );
      }),
  ),
);

it.effect("a resume that stops again keeps climbing, and never resets the stage ceiling", () =>
  withGovernor(
    {
      board: { cards: [buildingCard("a", "a")], nextCardNumberByProject: {} },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    (harness) =>
      Effect.gen(function* () {
        const thread = yield* stopCard(harness, "a", "a", 1, null);
        assert.strictEqual((yield* stepOf(harness, "a"))?.attempt, 2);

        // Second stall, no progress in between: the ladder keeps climbing.
        yield* TestClock.adjust(Duration.minutes(10));
        yield* harness.reactor.fireRetries;
        yield* harness.reactor.drain;
        yield* harness.pumpRuntime(turnCompleted(thread));
        const climbing = yield* stepOf(harness, "a");
        assert.strictEqual(climbing?.attempt, 3);
        assert.strictEqual(climbing?.stallCount, 2);
        // The stage ceiling is NOT reset by any of this — it is the only thing
        // that bounds a card looping productively-looking for ever.
        assert.strictEqual(climbing?.stageEntryRecoveries, 2);
      }),
  ),
);

// ── A cooldown survives a restart (D2) ────────────────────────────────────

it.effect("boot reconcile honours a live cooldown and nudges nothing behind it", () =>
  withGovernor(
    {
      board: {
        cards: [buildingCard("a", "a")],
        stepStates: [parkedByLimit("a")],
        providerLimits: [
          {
            providerInstanceId: codex,
            kind: "wait",
            until: RESETS_AT,
            detectedAt: "1970-01-01T00:00:00.000Z",
            lastCheckedAt: "1970-01-01T00:00:00.000Z",
            reason: waitAt().reason,
            ruleId: "claude-code.session-limit",
            sourceCardId: BoardCardId.make("a"),
            knownTime: true,
            blindSince: null,
            probeCardId: null,
            setByHuman: false,
          },
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    (harness) =>
      Effect.gen(function* () {
        // The observed burn began at a boot reconcile. An in-memory cooldown
        // would be lost here and every parked card re-nudged the moment the
        // server came back — the same bug, reintroduced by its own fix.
        yield* harness.reactor.reconcile;
        yield* harness.reactor.drain;
        const parked = yield* stepOf(harness, "a");
        assert.strictEqual(parked?.status, "stalled");
        assert.strictEqual(parked?.stalledReason, "usage-limit");
        assert.strictEqual(parked?.attempt, 1, "boot spent nothing");
        assert.strictEqual((yield* limitOf(harness, codex))?.kind, "wait");
      }),
  ),
);

it.effect("seven days of learning nothing gives up and hands every card to a human", () =>
  withGovernor(
    {
      board: {
        cards: [buildingCard("a", "a")],
        stepStates: [parkedByLimit("a")],
        // A blind poll that started eight days ago: the provider never named a
        // time and never came back. Blind-polling a wall for a ninth day is
        // pure waste, and on a metered provider it is a ninth day of failing
        // requests.
        providerLimits: [
          {
            providerInstanceId: codex,
            kind: "wait",
            until: "1970-01-01T00:00:00.000Z",
            detectedAt: "1969-12-24T00:00:00.000Z",
            lastCheckedAt: "1969-12-31T00:00:00.000Z",
            reason: waitAt().reason,
            ruleId: "grok.weekly-limit",
            sourceCardId: BoardCardId.make("a"),
            knownTime: false,
            blindSince: "1969-12-24T00:00:00.000Z",
            probeCardId: null,
            setByHuman: false,
          },
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    (harness) =>
      Effect.gen(function* () {
        yield* harness.reactor.fireProbes;
        yield* harness.reactor.drain;
        // The cooldown is gone and the card says so in the provider's own
        // words, rather than sitting silently on a window that never reopened.
        assert.strictEqual(yield* limitOf(harness, codex), null);
        const escalated = yield* stepOf(harness, "a");
        assert.strictEqual(escalated?.status, "stalled");
        assert.strictEqual(escalated?.stalledReason, "gave-up");
        assert.strictEqual(escalated?.retryAt, null);
        assert.strictEqual(escalated?.lastError, waitAt().reason);
      }),
  ),
);

/** A step already parked behind a cooldown, as a restart finds it. */
function parkedByLimit(id: string): BoardCardStepState {
  return {
    cardId: BoardCardId.make(id),
    stepId: String(BOARD_SEED_STAGE_IDS.building),
    stepLabel: "Building",
    stageLabel: "Building",
    attempt: 1,
    stallCount: 0,
    stageEntryRecoveries: 0,
    lastNudgeAt: null,
    baseTipAtRoundStart: null,
    lastError: waitAt().reason,
    awaitingReason: "question",
    stalledReason: "usage-limit",
    retryAt: RESETS_AT,
    prompt: "build it",
    providerInstanceId: codex,
    model: "gpt-5-codex",
    mode: "build",
    runtimeMode: "auto",
    humanInLoop: false,
    maxAttempts: 3,
    timeoutMs: 30 * 60_000,
    status: "stalled",
    slotHeld: false,
    forceStart: false,
    threadId: null,
    startedAt: null,
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}
