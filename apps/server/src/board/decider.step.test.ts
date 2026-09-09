import {
  BoardCardId,
  BoardStageId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardCardStepState,
  type BoardState,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { boardDecidedEvents, decideBoardCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");

// The frozen execution config the reactor resolves at stage entry and stamps
// onto the run row (D12) — the single seeded step per stage (D1) replaces the
// old multi-step recipe snapshot.
const frozenConfig = {
  prompt: "do it",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
  mode: "build" as const,
  runtimeMode: "auto" as const,
  humanInLoop: false,
  maxAttempts: 3,
  timeoutMs: 1000,
  baseTipAtRoundStart: null,
  lastError: null,
};

function makeCard(overrides: Omit<Partial<BoardCard>, "id"> & { readonly id: string }): BoardCard {
  return {
    key: "T3-1",
    cardNumber: 1,
    projectId,
    labels: [],
    stage: BoardStageId.make("building"),
    orderKey: "m",
    title: "Card",
    briefRef: null,
    dependsOn: [],
    parentCardId: null,
    sourcePlanId: null,
    threadLinks: [],
    attachments: [],
    externalRef: null,
    humanInLoop: null,
    reviewOverrides: null,
    modelOverrides: null,
    splitRationale: null,
    baseBranch: null,
    scheduledStartAt: null,
    worktree: null,
    pullRequest: null,
    pullRequestHistory: [],
    pullRequestFloor: null,
    blocked: false,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
    id: BoardCardId.make(overrides.id),
  };
}

function makeReadModel(board: BoardState): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    board,
    updatedAt: NOW,
  };
}

const stepState = (
  cardId: string,
  status: BoardCardStepState["status"],
  overrides: Partial<BoardCardStepState> = {},
): BoardCardStepState => ({
  cardId: BoardCardId.make(cardId),
  stepId: "build",
  stepLabel: "Build",
  stageLabel: "Building",
  attempt: 1,
  stallCount: 0,
  stageEntryRecoveries: 0,
  awaitingReason: "question",
  lastNudgeAt: null,
  ...frozenConfig,
  threadId: ThreadId.make("thread-1"),
  status,
  slotHeld: true,
  forceStart: false,
  startedAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const decide = (
  command: Parameters<typeof decideBoardCommand>[0]["command"],
  readModel: OrchestrationReadModel,
) =>
  decideBoardCommand({ command, readModel }).pipe(
    Effect.map(boardDecidedEvents),
    Effect.map((events) => events[0]!),
    Effect.provide(NodeServices.layer),
  );

const decideFail = (
  command: Parameters<typeof decideBoardCommand>[0]["command"],
  readModel: OrchestrationReadModel,
) => Effect.flip(decide(command, readModel));

it.effect("select-step records a pending step, freezing the stage's config onto the run row", () =>
  Effect.gen(function* () {
    const card = makeCard({ id: "card-1" });
    const event = yield* decide(
      {
        type: "board.card.select-step",
        commandId: CommandId.make("c1"),
        cardId: card.id,
        stepId: "build",
        stepLabel: "Build",
        stageLabel: "Building",
        ...frozenConfig,
        createdAt: NOW,
      },
      makeReadModel({ cards: [card], nextCardNumberByProject: {} }),
    );
    assert.strictEqual(event.type, "board.card-step-selected");
    if (event.type === "board.card-step-selected") {
      assert.strictEqual(event.payload.state.status, "pending");
      assert.strictEqual(event.payload.state.attempt, 1);
      // Omitting `priorRecoveries` is a genuine stage entry: the stage's
      // recovery spend starts over (T3O-12, D4).
      assert.strictEqual(event.payload.state.stageEntryRecoveries, 0);
      assert.strictEqual(event.payload.state.slotHeld, false);
      // The frozen config (D12) is stamped verbatim onto the run row.
      assert.strictEqual(event.payload.state.prompt, "do it");
      assert.strictEqual(event.payload.state.mode, "build");
      assert.strictEqual(event.payload.state.providerInstanceId, "codex");
    }
  }),
);

it.effect("select-step stamps the measured base tip onto the run row (t3o-24, D1)", () =>
  Effect.gen(function* () {
    const card = makeCard({ id: "card-1" });
    const event = yield* decide(
      {
        type: "board.card.select-step",
        commandId: CommandId.make("c1"),
        cardId: card.id,
        stepId: "review@1",
        stepLabel: "Review · round 1",
        stageLabel: "Code review",
        ...frozenConfig,
        baseTipAtRoundStart: "sha-round-start",
        createdAt: NOW,
      },
      makeReadModel({ cards: [card], nextCardNumberByProject: {} }),
    );
    assert.strictEqual(event.type, "board.card-step-selected");
    if (event.type === "board.card-step-selected") {
      // Verbatim, like every other frozen field — staleness at the crossing is
      // a plain inequality against this.
      assert.strictEqual(event.payload.state.baseTipAtRoundStart, "sha-round-start");
    }
  }),
);

it.effect(
  "T3O-12: select-step carries the stage entry's RECOVERIES forward while `attempt` resets",
  () =>
    Effect.gen(function* () {
      const card = makeCard({ id: "card-1" });
      const event = yield* decide(
        {
          type: "board.card.select-step",
          commandId: CommandId.make("c1"),
          cardId: card.id,
          stepId: "triage@6",
          stepLabel: "Triage · round 6",
          stageLabel: "Code review",
          ...frozenConfig,
          // The review loop crossing a phase boundary: the projector keeps one
          // step-state row per card, so the ceiling's counter has to ride the
          // command or it would reset on every phase.
          priorRecoveries: 7,
          createdAt: NOW,
        },
        makeReadModel({ cards: [card], nextCardNumberByProject: {} }),
      );
      assert.strictEqual(event.type, "board.card-step-selected");
      if (event.type === "board.card-step-selected") {
        assert.strictEqual(event.payload.state.stageEntryRecoveries, 7);
        // `attempt` does NOT ride along any more. It used to carry the stage
        // entry's cumulative total so the ceiling could be read off it, which
        // is what displayed "attempt 45" beside "maxAttempts 5" on a long
        // review loop. A new phase is a new step and counts its own (D5).
        assert.strictEqual(event.payload.state.attempt, 1);
        // And a fresh step's stall streak starts empty regardless.
        assert.strictEqual(event.payload.state.stallCount, 0);
      }
    }),
);

it.effect(
  "select-step refuses a new step while the current one is still live (D4: one at a time)",
  () =>
    Effect.gen(function* () {
      const card = makeCard({ id: "card-1" });
      const failure = yield* decideFail(
        {
          type: "board.card.select-step",
          commandId: CommandId.make("c1"),
          cardId: card.id,
          stepId: "build",
          stepLabel: "Build",
          stageLabel: "Building",
          ...frozenConfig,
          createdAt: NOW,
        },
        makeReadModel({
          cards: [card],
          stepStates: [stepState("card-1", "running")],
          nextCardNumberByProject: {},
        }),
      );
      assert.include(String(failure), "live step");
    }),
);

it.effect("admit-step admitted → running with a thread and a held slot; queued → no thread", () =>
  Effect.gen(function* () {
    const card = makeCard({ id: "card-1" });
    const board = makeReadModel({
      cards: [card],
      stepStates: [
        stepState("card-1", "pending", { threadId: null, slotHeld: false, startedAt: null }),
      ],
      nextCardNumberByProject: {},
    });
    const admitted = yield* decide(
      {
        type: "board.card.admit-step",
        commandId: CommandId.make("c1"),
        cardId: card.id,
        stepId: "build",
        admitted: true,
        threadId: ThreadId.make("thread-1"),
        createdAt: NOW,
      },
      board,
    );
    assert.strictEqual(admitted.type, "board.card-step-admitted");
    if (admitted.type === "board.card-step-admitted") {
      assert.strictEqual(admitted.payload.state.status, "running");
      assert.strictEqual(admitted.payload.state.slotHeld, true);
      assert.strictEqual(admitted.payload.state.threadId, "thread-1");
    }
    const queued = yield* decide(
      {
        type: "board.card.admit-step",
        commandId: CommandId.make("c2"),
        cardId: card.id,
        stepId: "build",
        admitted: false,
        threadId: null,
        createdAt: NOW,
      },
      board,
    );
    if (queued.type === "board.card-step-admitted") {
      assert.strictEqual(queued.payload.state.status, "queued");
      assert.strictEqual(queued.payload.state.slotHeld, false);
      assert.strictEqual(queued.payload.state.threadId, null);
    }
  }),
);

it.effect("force-start-step marks a queued step for admission over the cap (t3o-33)", () =>
  Effect.gen(function* () {
    const card = makeCard({ id: "card-1" });
    const board = makeReadModel({
      cards: [card],
      stepStates: [
        stepState("card-1", "queued", { threadId: null, slotHeld: false, startedAt: null }),
      ],
      nextCardNumberByProject: {},
    });
    const event = yield* decide(
      {
        type: "board.card.force-start-step",
        commandId: CommandId.make("c1"),
        cardId: card.id,
        createdAt: NOW,
      },
      board,
    );
    assert.strictEqual(event.type, "board.card-step-force-start-requested");
    if (event.type === "board.card-step-force-start-requested") {
      assert.strictEqual(event.payload.state.forceStart, true);
      // Still queued and still slotless: the request records an intent, and the
      // governor is the only thing that admits anything.
      assert.strictEqual(event.payload.state.status, "queued");
      assert.strictEqual(event.payload.state.slotHeld, false);
    }
  }),
);

it.effect("force-start-step refuses a step that is not queued (t3o-33)", () =>
  Effect.gen(function* () {
    const card = makeCard({ id: "card-1" });
    const error = yield* decideFail(
      {
        type: "board.card.force-start-step",
        commandId: CommandId.make("c1"),
        cardId: card.id,
        createdAt: NOW,
      },
      makeReadModel({
        cards: [card],
        stepStates: [stepState("card-1", "running")],
        nextCardNumberByProject: {},
      }),
    );
    assert.include(error.message, "not queued");
  }),
);

it.effect("force-start-step refuses a card with no live step (t3o-33)", () =>
  Effect.gen(function* () {
    const card = makeCard({ id: "card-1" });
    const error = yield* decideFail(
      {
        type: "board.card.force-start-step",
        commandId: CommandId.make("c1"),
        cardId: card.id,
        createdAt: NOW,
      },
      makeReadModel({ cards: [card], stepStates: [], nextCardNumberByProject: {} }),
    );
    assert.include(error.message, "no live step");
  }),
);

it.effect("admit-step spends the force-start override rather than carrying it (t3o-33)", () =>
  Effect.gen(function* () {
    const card = makeCard({ id: "card-1" });
    const event = yield* decide(
      {
        type: "board.card.admit-step",
        commandId: CommandId.make("c1"),
        cardId: card.id,
        stepId: "build",
        admitted: true,
        threadId: ThreadId.make("thread-1"),
        createdAt: NOW,
      },
      makeReadModel({
        cards: [card],
        stepStates: [
          stepState("card-1", "queued", {
            threadId: null,
            slotHeld: false,
            startedAt: null,
            forceStart: true,
          }),
        ],
        nextCardNumberByProject: {},
      }),
    );
    assert.strictEqual(event.type, "board.card-step-admitted");
    if (event.type === "board.card-step-admitted") {
      assert.strictEqual(event.payload.state.forceStart, false);
    }
  }),
);

it.effect(
  "recover-step increments the counters and lands the step in stalled, releasing its slot, when giving up (t3o-17)",
  () =>
    Effect.gen(function* () {
      const card = makeCard({ id: "card-1" });
      const board = makeReadModel({
        cards: [card],
        stepStates: [
          stepState("card-1", "running", {
            attempt: 3,
            stallCount: 4,
            stageEntryRecoveries: 6,
            slotHeld: true,
          }),
        ],
        nextCardNumberByProject: {},
      });
      const event = yield* decide(
        {
          type: "board.card.recover-step",
          commandId: CommandId.make("c1"),
          cardId: card.id,
          stepId: "build",
          threadId: ThreadId.make("thread-1"),
          escalateToHuman: true,
          progressed: false,
          createdAt: NOW,
        },
        board,
      );
      if (event.type === "board.card-step-recovered") {
        // attempt counts this step's invocations (D1); stallCount extends the
        // streak; the recovery total is what the runaway ceiling reads, and an
        // escalation is itself a recovery (T3O-12, D4).
        assert.strictEqual(event.payload.state.attempt, 4);
        assert.strictEqual(event.payload.state.stallCount, 5);
        assert.strictEqual(event.payload.state.stageEntryRecoveries, 7);
        // Giving up is the distinct `stalled` status, not `awaiting-input` (D3),
        // and releases the slot (D4).
        assert.strictEqual(event.payload.state.status, "stalled");
        assert.strictEqual(event.payload.state.slotHeld, false);
        assert.strictEqual(event.payload.state.lastNudgeAt, NOW);
      }
    }),
);

it.effect(
  "recover-step resets stallCount on progress and keeps the slot on an ordinary retry (t3o-17)",
  () =>
    Effect.gen(function* () {
      const card = makeCard({ id: "card-1" });
      const board = makeReadModel({
        cards: [card],
        stepStates: [
          stepState("card-1", "running", {
            attempt: 3,
            stallCount: 4,
            stageEntryRecoveries: 6,
            slotHeld: true,
          }),
        ],
        nextCardNumberByProject: {},
      });
      const event = yield* decide(
        {
          type: "board.card.recover-step",
          commandId: CommandId.make("c1"),
          cardId: card.id,
          stepId: "build",
          threadId: ThreadId.make("thread-1"),
          escalateToHuman: false,
          progressed: true,
          createdAt: NOW,
        },
        board,
      );
      if (event.type === "board.card-step-recovered") {
        assert.strictEqual(event.payload.state.attempt, 4);
        // Progress forgets the streak; this stall is #1 of a new one.
        assert.strictEqual(event.payload.state.stallCount, 1);
        // A nudge is a recovery too, whether or not it progressed: the ceiling
        // bounds recovery SPEND, and a step that keeps needing rescuing is
        // exactly what it is there to stop (T3O-12, D4).
        assert.strictEqual(event.payload.state.stageEntryRecoveries, 7);
        assert.strictEqual(event.payload.state.status, "running");
        assert.strictEqual(event.payload.state.slotHeld, true);
      }
    }),
);

it.effect(
  "resume-step clears the stop and returns the step to running, charging no attempt (t3o-17, D3)",
  () =>
    Effect.gen(function* () {
      const card = makeCard({ id: "card-1" });
      const board = makeReadModel({
        cards: [card],
        stepStates: [
          stepState("card-1", "stalled", {
            attempt: 3,
            stallCount: 3,
            stageEntryRecoveries: 4,
            slotHeld: false,
            forceStart: false,
            lastError: "turn/setPermissionMode failed",
            lastNudgeAt: "2025-12-31T00:00:00.000Z",
          }),
        ],
        nextCardNumberByProject: {},
      });
      const event = yield* decide(
        {
          type: "board.card.resume-step",
          commandId: CommandId.make("c1"),
          cardId: card.id,
          stepId: "build",
          createdAt: NOW,
        },
        board,
      );
      assert.strictEqual(event.type, "board.card-step-recovered");
      if (event.type === "board.card-step-recovered") {
        assert.strictEqual(event.payload.state.status, "running");
        // The reason no longer describes what is happening, so the card stops
        // rendering it.
        assert.strictEqual(event.payload.state.lastError, null);
        // The human intervening is progress: the ladder counts from zero again
        // instead of re-escalating on their first quiet turn.
        assert.strictEqual(event.payload.state.stallCount, 0);
        // No board invocation happened, so neither the per-step ledger nor the
        // stage-entry recovery ceiling is charged for the human's own turn
        // (T3O-12, D7) — charging it would escalate the card again the moment
        // their turn ended.
        assert.strictEqual(event.payload.state.attempt, 3);
        assert.strictEqual(event.payload.state.stageEntryRecoveries, 4);
        // The slot escalation released is TAKEN BACK (T3O-23): a build step
        // running on `slotHeld: false` would occupy a worker invisibly and skip
        // its release at settle. The reactor performs the matching
        // `slots.restore` when the dispatch lands.
        assert.strictEqual(event.payload.state.slotHeld, true);
        // The timeout sweep measures from the takeover, not from the stop.
        assert.strictEqual(event.payload.state.lastNudgeAt, NOW);
      }
    }),
);

it.effect("resume-step refuses a step that is not parked (t3o-17, D3; T3O-23)", () =>
  Effect.gen(function* () {
    const card = makeCard({ id: "card-1" });
    const board = makeReadModel({
      cards: [card],
      stepStates: [stepState("card-1", "running")],
      nextCardNumberByProject: {},
    });
    const failure = yield* decideFail(
      {
        type: "board.card.resume-step",
        commandId: CommandId.make("c1"),
        cardId: card.id,
        stepId: "build",
        createdAt: NOW,
      },
      board,
    );
    assert.include(String(failure), "not parked");
  }),
);

it.effect("settle-step releases the slot and is idempotent (a double settle advances once)", () =>
  Effect.gen(function* () {
    const card = makeCard({ id: "card-1" });
    const running = makeReadModel({
      cards: [card],
      stepStates: [stepState("card-1", "running")],
      nextCardNumberByProject: {},
    });
    const first = yield* decide(
      {
        type: "board.card.settle-step",
        commandId: CommandId.make("c1"),
        cardId: card.id,
        stepId: "build",
        outcome: "succeeded",
        createdAt: NOW,
      },
      running,
    );
    assert.strictEqual(first.type, "board.card-step-settled");
    if (first.type !== "board.card-step-settled") return;
    assert.strictEqual(first.payload.state.status, "succeeded");
    assert.strictEqual(first.payload.state.slotHeld, false);

    // A retried settle over the now-terminal state re-emits the SAME terminal
    // record — no second release, no double transition (D4 Release idempotency).
    const settled = makeReadModel({
      cards: [card],
      stepStates: [first.payload.state],
      nextCardNumberByProject: {},
    });
    const second = yield* decide(
      {
        type: "board.card.settle-step",
        commandId: CommandId.make("c2"),
        cardId: card.id,
        stepId: "build",
        outcome: "failed",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      settled,
    );
    if (second.type === "board.card-step-settled") {
      assert.strictEqual(second.payload.state.status, "succeeded"); // first outcome wins
      assert.strictEqual(second.payload.state.slotHeld, false);
      assert.strictEqual(second.payload.state.updatedAt, NOW); // unchanged: no re-transition
    }
  }),
);

it.effect("await-step-input only fires on a running step (D13: no retry consumed)", () =>
  Effect.gen(function* () {
    const card = makeCard({ id: "card-1" });
    const event = yield* decide(
      {
        type: "board.card.await-step-input",
        commandId: CommandId.make("c1"),
        cardId: card.id,
        stepId: "build",
        reason: "question",
        createdAt: NOW,
      },
      makeReadModel({
        cards: [card],
        stepStates: [stepState("card-1", "running")],
        nextCardNumberByProject: {},
      }),
    );
    if (event.type === "board.card-step-awaiting-input") {
      assert.strictEqual(event.payload.state.status, "awaiting-input");
      assert.strictEqual(event.payload.state.attempt, 1); // unchanged — a question is not a retry
    }
  }),
);

// ── A human stop parks the step (T3O-23) ────────────────────────────────

it.effect("pause-step parks a running step and gives its slot back (T3O-23)", () =>
  Effect.gen(function* () {
    const card = makeCard({ id: "card-1" });
    const board = makeReadModel({
      cards: [card],
      stepStates: [
        stepState("card-1", "running", {
          attempt: 3,
          stallCount: 2,
          stageEntryRecoveries: 4,
          slotHeld: true,
          lastError: "turn/setPermissionMode failed",
        }),
      ],
      nextCardNumberByProject: {},
    });
    const event = yield* decide(
      {
        type: "board.card.pause-step",
        commandId: CommandId.make("c1"),
        cardId: card.id,
        stepId: "build",
        createdAt: NOW,
      },
      board,
    );
    assert.strictEqual(event.type, "board.card-step-paused");
    if (event.type === "board.card-step-paused") {
      assert.strictEqual(event.payload.state.status, "paused");
      // Nothing is running, so the card must not hold capacity for a weekend.
      assert.strictEqual(event.payload.state.slotHeld, false);
      // The human asked for this: it is not a stall and it spends none of the
      // recovery budget, or stopping a card twice would escalate it.
      assert.strictEqual(event.payload.state.stallCount, 2);
      assert.strictEqual(event.payload.state.attempt, 3);
      assert.strictEqual(event.payload.state.stageEntryRecoveries, 4);
      // A deliberate stop is not a failure, so the card stops wearing one.
      assert.strictEqual(event.payload.state.lastError, null);
      // The thread and its worktree are kept — that is the whole point.
      assert.strictEqual(event.payload.state.threadId, ThreadId.make("thread-1"));
    }
  }),
);

it.effect("pause-step also parks a step the agent had already parked on a question", () =>
  Effect.gen(function* () {
    const card = makeCard({ id: "card-1" });
    const board = makeReadModel({
      cards: [card],
      stepStates: [stepState("card-1", "awaiting-input", { slotHeld: false })],
      nextCardNumberByProject: {},
    });
    const event = yield* decide(
      {
        type: "board.card.pause-step",
        commandId: CommandId.make("c1"),
        cardId: card.id,
        stepId: "build",
        createdAt: NOW,
      },
      board,
    );
    if (event.type === "board.card-step-paused") {
      assert.strictEqual(event.payload.state.status, "paused");
    }
  }),
);

it.effect("pause-step refuses a step with no turn to stop (T3O-23)", () =>
  Effect.gen(function* () {
    const card = makeCard({ id: "card-1" });
    // `queued` holds no slot and has nothing running; `paused` is already there;
    // a terminal step is over. `stalled` is NOT here — a human's Stop outranks
    // an escalation that won the ordering race by a beat, see below.
    for (const status of ["queued", "paused", "succeeded"] as const) {
      const board = makeReadModel({
        cards: [card],
        stepStates: [stepState("card-1", status)],
        nextCardNumberByProject: {},
      });
      const failure = yield* decideFail(
        {
          type: "board.card.pause-step",
          commandId: CommandId.make("c1"),
          cardId: card.id,
          stepId: "build",
          createdAt: NOW,
        },
        board,
      );
      assert.include(String(failure), "nothing to pause");
    }
  }),
);

it.effect("pause-step overrides an escalation that won the ordering race (T3O-23)", () =>
  Effect.gen(function* () {
    const card = makeCard({ id: "card-1" });
    const board = makeReadModel({
      cards: [card],
      stepStates: [stepState("card-1", "stalled", { slotHeld: false })],
      nextCardNumberByProject: {},
    });
    const event = yield* decide(
      {
        type: "board.card.pause-step",
        commandId: CommandId.make("c1"),
        cardId: card.id,
        stepId: "build",
        createdAt: NOW,
      },
      board,
    );
    assert.strictEqual(event.type, "board.card-step-paused");
    if (event.type === "board.card-step-paused") {
      // The human asked for a stop, so they get the neutral `Paused`, not the
      // loud "Needs a human" a recovery escalation left behind a beat earlier.
      assert.strictEqual(event.payload.state.status, "paused");
      assert.strictEqual(event.payload.state.slotHeld, false);
    }
  }),
);

it.effect("requeue-step sends a parked step back to the queue, keeping its thread (T3O-23)", () =>
  Effect.gen(function* () {
    const card = makeCard({ id: "card-1" });
    // Every parked status is resumable this way — a human stop, a stall
    // recovery gave up on, and an unanswered question.
    for (const status of ["paused", "stalled", "awaiting-input"] as const) {
      const board = makeReadModel({
        cards: [card],
        stepStates: [
          stepState("card-1", status, {
            attempt: 2,
            stallCount: 3,
            stageEntryRecoveries: 4,
            slotHeld: false,
            lastError: "something broke",
          }),
        ],
        nextCardNumberByProject: {},
      });
      const event = yield* decide(
        {
          type: "board.card.requeue-step",
          commandId: CommandId.make("c1"),
          cardId: card.id,
          createdAt: NOW,
        },
        board,
      );
      assert.strictEqual(event.type, "board.card-step-recovered");
      if (event.type === "board.card-step-recovered") {
        // Back through the governor, holding nothing: the card shows `Queued`
        // while it waits, which is visible rather than a lying spinner.
        assert.strictEqual(event.payload.state.status, "queued");
        assert.strictEqual(event.payload.state.slotHeld, false);
        assert.strictEqual(event.payload.state.startedAt, null);
        // The thread is RETAINED, so admission nudges the conversation the
        // agent already has instead of spawning a second one.
        assert.strictEqual(event.payload.state.threadId, ThreadId.make("thread-1"));
        // A human intervening is progress, exactly as it is on `resume-step`.
        assert.strictEqual(event.payload.state.stallCount, 0);
        assert.strictEqual(event.payload.state.lastError, null);
        // The board invoked nothing, so neither ledger is charged.
        assert.strictEqual(event.payload.state.attempt, 2);
        assert.strictEqual(event.payload.state.stageEntryRecoveries, 4);
      }
    }
  }),
);

it.effect("recover-step refuses a step a human paused (T3O-23)", () =>
  Effect.gen(function* () {
    const card = makeCard({ id: "card-1" });
    const board = makeReadModel({
      cards: [card],
      stepStates: [stepState("card-1", "paused", { slotHeld: false })],
      nextCardNumberByProject: {},
    });
    // The backstop behind the reactor's own guards: recovery would either nudge
    // the agent back to work or escalate the card to `stalled`, and either way
    // the board would have undone the stop the human asked for.
    const failure = yield* decideFail(
      {
        type: "board.card.recover-step",
        commandId: CommandId.make("c1"),
        cardId: card.id,
        stepId: "build",
        threadId: ThreadId.make("thread-1"),
        escalateToHuman: false,
        progressed: false,
        createdAt: NOW,
      },
      board,
    );
    assert.include(String(failure), "is paused");
  }),
);

it.effect("requeue-step refuses a step that is not parked (T3O-23)", () =>
  Effect.gen(function* () {
    const card = makeCard({ id: "card-1" });
    const board = makeReadModel({
      cards: [card],
      stepStates: [stepState("card-1", "running")],
      nextCardNumberByProject: {},
    });
    const failure = yield* decideFail(
      {
        type: "board.card.requeue-step",
        commandId: CommandId.make("c1"),
        cardId: card.id,
        createdAt: NOW,
      },
      board,
    );
    assert.include(String(failure), "not parked");
  }),
);

it.effect("resume-step un-parks a paused step and takes its slot back (T3O-23)", () =>
  Effect.gen(function* () {
    const card = makeCard({ id: "card-1" });
    const board = makeReadModel({
      cards: [card],
      stepStates: [stepState("card-1", "paused", { slotHeld: false })],
      nextCardNumberByProject: {},
    });
    const event = yield* decide(
      {
        type: "board.card.resume-step",
        commandId: CommandId.make("c1"),
        cardId: card.id,
        stepId: "build",
        createdAt: NOW,
      },
      board,
    );
    if (event.type === "board.card-step-recovered") {
      assert.strictEqual(event.payload.state.status, "running");
      // The human typed in the thread themselves, so the agent is already
      // working: the slot is taken, not requested.
      assert.strictEqual(event.payload.state.slotHeld, true);
    }
  }),
);

it.effect("resume-step takes no slot for a plan-mode step, which never holds one", () =>
  Effect.gen(function* () {
    const card = makeCard({ id: "card-1" });
    const board = makeReadModel({
      cards: [card],
      stepStates: [stepState("card-1", "paused", { mode: "plan", slotHeld: false })],
      nextCardNumberByProject: {},
    });
    const event = yield* decide(
      {
        type: "board.card.resume-step",
        commandId: CommandId.make("c1"),
        cardId: card.id,
        stepId: "build",
        createdAt: NOW,
      },
      board,
    );
    if (event.type === "board.card-step-recovered") {
      assert.strictEqual(event.payload.state.slotHeld, false);
    }
  }),
);

it.effect("await-step-input releases the step's slot (T3O-23)", () =>
  Effect.gen(function* () {
    const card = makeCard({ id: "card-1" });
    const board = makeReadModel({
      cards: [card],
      stepStates: [stepState("card-1", "running", { slotHeld: true })],
      nextCardNumberByProject: {},
    });
    const event = yield* decide(
      {
        type: "board.card.await-step-input",
        commandId: CommandId.make("c1"),
        cardId: card.id,
        stepId: "build",
        reason: "question",
        createdAt: NOW,
      },
      board,
    );
    assert.strictEqual(event.type, "board.card-step-awaiting-input");
    if (event.type === "board.card-step-awaiting-input") {
      assert.strictEqual(event.payload.state.status, "awaiting-input");
      // A card can sit on an unanswered question all weekend, and nothing is
      // running while it does.
      assert.strictEqual(event.payload.state.slotHeld, false);
    }
  }),
);

it.effect("admit-step refreshes lastNudgeAt so a requeued step is not instantly overdue", () =>
  Effect.gen(function* () {
    const card = makeCard({ id: "card-1" });
    const board = makeReadModel({
      cards: [card],
      stepStates: [
        stepState("card-1", "queued", {
          threadId: null,
          slotHeld: false,
          startedAt: null,
          // The step ran, was paused, and sat in the queue for hours.
          lastNudgeAt: "2025-12-31T00:00:00.000Z",
        }),
      ],
      nextCardNumberByProject: {},
    });
    const event = yield* decide(
      {
        type: "board.card.admit-step",
        commandId: CommandId.make("c1"),
        cardId: card.id,
        stepId: "build",
        admitted: true,
        threadId: ThreadId.make("thread-1"),
        createdAt: NOW,
      },
      board,
    );
    if (event.type === "board.card-step-admitted") {
      // `sweepTimeouts` prefers `lastNudgeAt` over `startedAt`, so a stale one
      // would make the step overdue the instant it was admitted.
      assert.strictEqual(event.payload.state.lastNudgeAt, NOW);
      assert.strictEqual(event.payload.state.startedAt, NOW);
    }
  }),
);
