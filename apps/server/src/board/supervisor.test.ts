import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  BoardStageId,
  EnvironmentId,
  PositiveInt,
  ProviderInstanceId,
  type BoardCardStepState,
  type BoardConcurrencySettings,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  boardBackgroundCheckInCharged,
  boardBackgroundCheckInDueMs,
  boardBackgroundCheckInNudge,
  boardRecoveryNudge,
  composeStepPrompt,
  orderBoardQueue,
  reconcileStepDecision,
  recoveryDecision,
  resolveBoardConcurrencyLimit,
  type BoardQueueCandidate,
  type ComposeStepPromptStep,
} from "./supervisor.ts";

// The frozen run-row fields a spawn needs (t3o-15, D12). `humanInLoop` false is
// an unattended run, whose postamble carries the completion-contract /
// never-prose stance. `stepLabel` defaults to NULL because Building — like
// every stage but the review loop — has no steps (t3o-19, D4).
const step = (overrides: Partial<ComposeStepPromptStep> = {}): ComposeStepPromptStep => ({
  stepId: "building",
  stepLabel: null,
  prompt: "Implement the brief.",
  humanInLoop: false,
  ...overrides,
});

describe("composeStepPrompt (D5 envelope)", () => {
  it("has preamble (card context), body (template) and postamble (completion contract)", () => {
    const prompt = composeStepPrompt({
      card: { key: "T3-1", title: "Ship it", stage: BoardStageId.make("building") },
      stageLabel: "Building",
      step: step(),
      role: "build",
    });
    // Preamble: card key, title, stage, context pointer. No step line —
    // Building has no steps (t3o-19, D4).
    assert.include(prompt, "T3-1");
    assert.include(prompt, "Ship it");
    assert.include(prompt, "Stage: Building.");
    assert.notInclude(prompt, "Step:");
    assert.include(prompt, "board_get_card_context");
    // Body: the frozen step prompt verbatim.
    assert.include(prompt, "Implement the brief.");
    // Postamble: the completion contract and the never-prose rule.
    assert.include(prompt, "board_complete_step");
    assert.include(prompt, "never end a turn with an unanswered question in prose");
  });

  it("words the question mechanism without naming a provider", () => {
    const prompt = composeStepPrompt({
      card: { key: "T3-1", title: "x", stage: BoardStageId.make("building") },
      stageLabel: "Building",
      step: step(),
      role: "build",
    });
    assert.include(prompt, "user-input request");
    for (const vendor of ["Codex", "Claude", "Cursor", "Gemini", "Grok", "OpenCode"]) {
      assert.notInclude(prompt, vendor);
    }
  });

  it("carries no attempt counter: the retry ladder is supervisor bookkeeping", () => {
    const prompt = composeStepPrompt({
      card: { key: "T3-1", title: "Ship it", stage: BoardStageId.make("building") },
      stageLabel: "Building",
      step: step(),
      role: "build",
    });
    assert.notInclude(prompt, "attempt");
  });
});

// NOTE (t3o-15): the `selectNextStep (D4)` suite was deleted. Each stage now
// runs exactly ONE step whose config is frozen onto the card's step-state row at
// stage entry, so there is no multi-step recipe to pick a "next step" from —
// `selectNextStep` and `BoardResolvedRecipe` no longer exist.

describe("recoveryDecision (t3o-17 consecutive-stall recovery, bounded, PURE)", () => {
  // crit 5: recoveryDecision is pure — driven only by scalars (the stall
  // counters, a progressedSinceLastNudge boolean, the recovery total and the
  // ceiling), never git or a database. Every case here is a plain function call.
  const decide = (input: {
    readonly attempt?: number;
    readonly stallCount: number;
    readonly maxAttempts?: number;
    readonly progressedSinceLastNudge?: boolean;
    readonly stageEntryRecoveries?: number;
    readonly maxRecoveriesPerStageEntry?: number;
    readonly endedWithQuestion?: boolean;
  }) =>
    recoveryDecision({
      stepState: {
        attempt: input.attempt ?? input.stallCount + 1,
        stallCount: input.stallCount,
        maxAttempts: input.maxAttempts ?? 5,
        stepLabel: null,
        stageLabel: "Building",
      } satisfies Pick<
        BoardCardStepState,
        "attempt" | "stallCount" | "maxAttempts" | "stepLabel" | "stageLabel"
      >,
      progressedSinceLastNudge: input.progressedSinceLastNudge ?? false,
      // t3o-34 D6: default to "the turn ended with no question", so the
      // question-specific case is the one that opts in.
      endedWithQuestion: input.endedWithQuestion ?? false,
      stageEntryRecoveries: input.stageEntryRecoveries ?? 0,
      maxRecoveriesPerStageEntry: input.maxRecoveriesPerStageEntry ?? 20,
    });

  it("resumes with a nudge within budget, adding an outstanding summary on the third consecutive stall", () => {
    const first = decide({ stallCount: 0 });
    assert.strictEqual(first.kind, "resume");
    if (first.kind === "resume") {
      assert.strictEqual(first.stallCount, 1);
      assert.notInclude(first.nudge, "outstanding");
    }
    const third = decide({ stallCount: 2 });
    assert.strictEqual(third.kind, "resume");
    if (third.kind === "resume") {
      assert.strictEqual(third.stallCount, 3);
      assert.include(third.nudge, "outstanding");
    }
  });

  it("crit 1: a progress signal between two stalls holds stallCount at 1, not 2, and does not escalate", () => {
    // First stall: no progress → streak length 1.
    const firstStall = decide({ stallCount: 0, progressedSinceLastNudge: false });
    assert.strictEqual(firstStall.kind, "resume");
    assert.strictEqual(firstStall.kind === "resume" ? firstStall.stallCount : -1, 1);
    // The thread's todo list advanced; the second stall resolves progressed=true,
    // so the prior streak is forgotten and this is stall #1 of a new one — 1, not 2.
    const secondStall = decide({ stallCount: 1, progressedSinceLastNudge: true });
    assert.strictEqual(secondStall.kind, "resume");
    assert.strictEqual(secondStall.kind === "resume" ? secondStall.stallCount : -1, 1);
  });

  it("T3O-22: no recovery nudge asks for a todo list, at any rung of the ladder", () => {
    for (const stallCount of [0, 2]) {
      const resumed = decide({ stallCount });
      assert.strictEqual(resumed.kind, "resume");
      if (resumed.kind === "resume") {
        assert.notInclude(resumed.nudge, "todo list");
        assert.notInclude(resumed.nudge, "task/plan tool");
      }
    }
  });

  // t3o-19 AC 11: the escalation a human reads names the STEP only when the
  // stage has steps. On every other stage `stepLabel` is null and naming a
  // step would invent one.
  // t3o-34 D6: the unattended half of blocked-agent handling. A human-in-the-loop
  // run never reaches recovery, so the only agent that gets nudged here is one
  // whose question nobody will ever answer — and saying so is what stops it
  // asking again on the next turn and marching up the stall ladder.
  it("tells a nudged unattended agent to decide its own question, and stays quiet otherwise", () => {
    const asked = decide({ stallCount: 1, endedWithQuestion: true });
    assert.strictEqual(asked.kind, "resume");
    if (asked.kind === "resume") {
      assert.include(asked.nudge, "unattended and nobody will answer it");
      assert.include(asked.nudge, "decide it yourself");
      // It answers the question FIRST, then repeats the standing instruction.
      assert.isBelow(
        asked.nudge.indexOf("unattended and nobody will answer it"),
        asked.nudge.indexOf("board_complete_step"),
      );
    }
    const quiet = decide({ stallCount: 1 });
    assert.strictEqual(quiet.kind, "resume");
    if (quiet.kind === "resume") assert.notInclude(quiet.nudge, "nobody will answer");
  });

  // The outstanding-work reminder keeps the position it has always had relative
  // to the "continue where you left off" line, whatever else is prepended.
  it("keeps the third-stall summary reminder ahead of the continue instruction", () => {
    const both = decide({ stallCount: 3, endedWithQuestion: true });
    assert.strictEqual(both.kind, "resume");
    if (both.kind === "resume") {
      assert.isBelow(
        both.nudge.indexOf("Summarise what is still outstanding"),
        both.nudge.indexOf("Continue where you left off"),
      );
    }
  });

  it("names the stage, not a step, when the stage has no steps", () => {
    const unstepped = decide({ stallCount: 4 });
    assert.strictEqual(unstepped.kind, "escalate");
    if (unstepped.kind === "escalate") {
      assert.include(unstepped.question, 'Stage "Building"');
      assert.notInclude(unstepped.question, "Step");
    }
    // A pre-020 row froze neither name. The human being escalated to should
    // not be shown `Stage "null"`.
    const unnamed = recoveryDecision({
      stepState: { attempt: 5, stallCount: 4, maxAttempts: 5, stepLabel: null, stageLabel: null },
      progressedSinceLastNudge: false,
      stageEntryRecoveries: 0,
      maxRecoveriesPerStageEntry: 20,
      endedWithQuestion: false,
    });
    assert.strictEqual(unnamed.kind, "escalate");
    if (unnamed.kind === "escalate") {
      assert.include(unnamed.question, "This stage has now stalled");
      assert.notInclude(unnamed.question, "null");
    }
    const stepped = recoveryDecision({
      stepState: {
        attempt: 5,
        stallCount: 4,
        maxAttempts: 5,
        stepLabel: "Review · round 1",
        stageLabel: "Code review",
      },
      progressedSinceLastNudge: false,
      stageEntryRecoveries: 0,
      maxRecoveriesPerStageEntry: 20,
      endedWithQuestion: false,
    });
    assert.strictEqual(stepped.kind, "escalate");
    if (stepped.kind === "escalate") {
      assert.include(stepped.question, 'Step "Review · round 1"');
    }
  });

  it("t3o-18 D16: no envelope, nudge or escalation names a deleted tool", () => {
    const texts = [
      composeStepPrompt({
        card: { key: "T3O-1", title: "Card", stage: BOARD_SEED_STAGE_IDS.building },
        stageLabel: "Building",
        step: { stepId: "building", stepLabel: null, prompt: "Do the work", humanInLoop: false },
        role: "build",
      }),
      composeStepPrompt({
        card: { key: "T3O-1", title: "Card", stage: BOARD_SEED_STAGE_IDS.building },
        stageLabel: "Building",
        step: { stepId: "building", stepLabel: null, prompt: "Do the work", humanInLoop: true },
        role: "build",
      }),
      (() => {
        const resumed = decide({ stallCount: 0 });
        return resumed.kind === "resume" ? resumed.nudge : "";
      })(),
      (() => {
        const escalated = decide({ stallCount: 4 });
        return escalated.kind === "escalate" ? escalated.question : "";
      })(),
    ];
    for (const text of texts) {
      assert.notInclude(text, "board_report_progress");
      assert.notInclude(text, "board_request_input");
    }
  });

  it("T3O-22: neither postamble asks for a todo list; only the unattended one asks for commits", () => {
    const step = { stepId: "building", stepLabel: null, prompt: "Do the work" };
    const card = { key: "T3O-1", title: "Card", stage: BOARD_SEED_STAGE_IDS.building };
    const unattended = composeStepPrompt({
      card,
      stageLabel: "Building",
      step: { ...step, humanInLoop: false },
      role: "build",
    });
    // Claude Code ships no todo tool on Claude 5-era models, so asking for a
    // list made agents report a missing tool instead of working.
    assert.notInclude(unattended, "todo list");
    assert.notInclude(unattended, "task/plan tool");
    assert.include(unattended, "Commit as you go");
    // AC 25: human-in-the-loop steps are not stall-supervised, so they carry no
    // progress instruction at all.
    const humanInLoop = composeStepPrompt({
      card,
      stageLabel: "Building",
      step: { ...step, humanInLoop: true },
      role: "build",
    });
    assert.notInclude(humanInLoop, "todo list");
    assert.notInclude(humanInLoop, "task/plan tool");
    assert.notInclude(humanInLoop, "Commit as you go");
  });

  it("crit 2: five consecutive stalls with no progress escalate on the fifth", () => {
    // Four resume, the fifth escalates (maxAttempts 5 measured on stallCount).
    for (let stallCount = 0; stallCount < 4; stallCount += 1) {
      assert.strictEqual(decide({ stallCount }).kind, "resume");
    }
    const fifth = decide({ stallCount: 4 });
    assert.strictEqual(fifth.kind, "escalate");
    if (fifth.kind === "escalate") {
      assert.strictEqual(fifth.stallCount, 5);
      assert.include(fifth.question, "5 times in a row");
      assert.include(fifth.question, "retry");
      assert.include(fifth.question, "switch");
      assert.include(fifth.question, "manually");
    }
  });

  it("crit 3: a progress signal resets a nearly-exhausted streak so it does not escalate", () => {
    // Four stalls deep, but a commit/report landed since the last nudge: the
    // streak resets, so the next stall is #1 again — resume, not escalate.
    const reset = decide({ stallCount: 4, progressedSinceLastNudge: true });
    assert.strictEqual(reset.kind, "resume");
    assert.strictEqual(reset.kind === "resume" ? reset.stallCount : -1, 1);
  });

  it("crit 4: attempt keeps counting across stall-count resets", () => {
    // A high cumulative attempt with a freshly-reset stall streak still resumes,
    // and reports the growing attempt number for display.
    const decision = decide({ attempt: 8, stallCount: 4, progressedSinceLastNudge: true });
    assert.strictEqual(decision.kind, "resume");
    assert.strictEqual(decision.kind === "resume" ? decision.attempt : -1, 9);
  });

  it("crit 11/13: crossing the per-stage-entry RECOVERY ceiling stalls the stage even when no single step exhausted maxAttempts", () => {
    // stallCount is nowhere near maxAttempts, but the stage entry's total
    // recoveries cross the ceiling — the runaway backstop escalates regardless.
    // Generic over any stage's recovery count, so a stage whose steps each inch
    // forward (resetting stallCount) and never finish cannot run forever.
    const capped = decide({
      stallCount: 0,
      maxAttempts: 5,
      stageEntryRecoveries: 20,
      maxRecoveriesPerStageEntry: 20,
    });
    assert.strictEqual(capped.kind, "escalate");
    if (capped.kind === "escalate") {
      // The human being escalated to reads this: it must name recoveries, not
      // the invocation total that no longer exists (T3O-12, D4).
      assert.include(capped.question, "21 recoveries");
      assert.include(capped.question, "20 allowed");
      assert.notInclude(capped.question, "invocations");
    }
    // One below the ceiling still resumes.
    assert.strictEqual(
      decide({
        stallCount: 0,
        stageEntryRecoveries: 18,
        maxRecoveriesPerStageEntry: 20,
      }).kind,
      "resume",
    );
  });

  it("T3O-12: planned work never reaches the ceiling — a long review loop with no recoveries takes the ladder", () => {
    // The regression this card exists for. Ten review rounds is 30 PLANNED
    // steps; the old ceiling summed `attempt`, so past ~round 7 it was
    // permanently blown and the first stall of any kind escalated instantly
    // with no nudge and no ladder. Raising the round budget is what pushed a
    // healthy loop over it — literally "extra rounds gives error".
    //
    // With the ceiling counting recoveries, a loop that has needed none is
    // nowhere near it however long it has legitimately run, so an ordinary
    // stall gets the ordinary nudge.
    const nudged = decide({ stallCount: 0, stageEntryRecoveries: 0, attempt: 1 });
    assert.strictEqual(nudged.kind, "resume");

    // And the ladder is still what escalates a genuinely wedged step: the
    // ceiling is not doing that job for it.
    const laddered = decide({ stallCount: 4, maxAttempts: 5, stageEntryRecoveries: 0 });
    assert.strictEqual(laddered.kind, "escalate");
    if (laddered.kind === "escalate") {
      assert.include(laddered.question, "stalled 5 times in a row");
    }
  });
});

describe("reconcileStepDecision (boot reconciliation)", () => {
  /** Unattended and thread-gone by default — the shape most of these assert.
      `threadAlive` implies `threadPresent`, so passing alive sets both. */
  const decide = (
    input: Partial<Parameters<typeof reconcileStepDecision>[0]> &
      Pick<Parameters<typeof reconcileStepDecision>[0], "status">,
  ) =>
    reconcileStepDecision({
      threadAlive: false,
      threadPresent: input.threadAlive ?? false,
      humanInLoop: false,
      hasSucceeded: false,
      ...input,
    });

  it("advances a step that completed while the server was down", () => {
    assert.deepStrictEqual(decide({ status: "running", hasSucceeded: true }), { kind: "advance" });
  });

  it("resumes watching a running step whose thread is still alive", () => {
    assert.deepStrictEqual(decide({ status: "running", threadAlive: true }), {
      kind: "resume-watch",
    });
  });

  it("recovers a running step whose thread is gone (routine, not an error)", () => {
    assert.deepStrictEqual(decide({ status: "running" }), { kind: "recover" });
  });

  it("parks a human-in-the-loop step whose thread is present but idle", () => {
    // The defect this covers (t3o-34): a planning agent that asked its question
    // in prose and stopped was recovered at every boot — nudged with the
    // unattended "nobody will answer you" text, an attempt burned, and the step
    // left `running`, so the card pulsed its blue "being worked" dot for as long
    // as it waited. It is waiting on the human, exactly as the live turn-ended
    // path already decides.
    assert.deepStrictEqual(decide({ status: "running", humanInLoop: true, threadPresent: true }), {
      kind: "park",
    });
  });

  it("still recovers a human-in-the-loop step whose thread is gone", () => {
    // Nothing left to park on: there is no thread for the human to answer in.
    assert.deepStrictEqual(decide({ status: "running", humanInLoop: true }), { kind: "recover" });
  });

  it("leaves a paused step exactly where the human put it (T3O-23)", () => {
    // The same shape `stalled` has: non-terminal, so boot reconciliation keeps
    // re-reading it, but supervision does not drive it. Recovering it would be
    // the board undoing a human's stop across a restart — and unlike a stall,
    // this one is the user's own instruction, so a live thread makes no
    // difference either way.
    assert.deepStrictEqual(decide({ status: "paused" }), { kind: "resume-watch" });
    assert.deepStrictEqual(decide({ status: "paused", threadAlive: true }), {
      kind: "resume-watch",
    });
    assert.deepStrictEqual(decide({ status: "paused", humanInLoop: true }), {
      kind: "resume-watch",
    });
  });

  it("keeps waiting on an awaiting-input step whose question thread survives", () => {
    assert.deepStrictEqual(decide({ status: "awaiting-input", threadAlive: true }), {
      kind: "resume-watch",
    });
  });

  it("keeps waiting on a step parked for a PROSE question, which leaves no liveness", () => {
    // A prose question parks the step with no pending question on the thread, so
    // the thread reads idle. Keyed on liveness, a restart un-parked it and drove
    // it as a stall — t3o-34's fix lasting exactly until the server bounced.
    assert.deepStrictEqual(decide({ status: "awaiting-input", threadPresent: true }), {
      kind: "resume-watch",
    });
  });

  it("recovers an awaiting-input step whose thread is gone", () => {
    assert.deepStrictEqual(decide({ status: "awaiting-input" }), { kind: "recover" });
  });

  it("re-offers a queued/pending step to the governor (t3o-11): reschedule, not recover", () => {
    // A slotless, never-started step is placed by the governor's schedule pass,
    // not treated as a stall — recovering it would burn an attempt on work that
    // never ran (D11).
    assert.deepStrictEqual(decide({ status: "queued" }), { kind: "reschedule" });
    assert.deepStrictEqual(decide({ status: "pending" }), { kind: "reschedule" });
  });

  it("still recovers a completing step whose settle never landed", () => {
    assert.deepStrictEqual(decide({ status: "completing" }), { kind: "recover" });
  });
});

describe("orderBoardQueue (governor ordering, t3o-11 D11)", () => {
  const candidate = (overrides: Partial<BoardQueueCandidate>): BoardQueueCandidate => ({
    cardId: BoardCardId.make("card"),
    stepId: "build",
    providerInstanceId: ProviderInstanceId.make("codex"),
    // Stage position in board order (t3o-15): Building is index 4, Code review 5
    // in the seed stage list — higher is later, and later ranks first.
    stageOrder: 4,
    started: false,
    orderKey: "m",
    ...overrides,
  });
  const keys = (cs: ReadonlyArray<BoardQueueCandidate>) => cs.map((c) => String(c.cardId));

  it("orders by drag order among peers of the same stage and started-ness", () => {
    const ordered = orderBoardQueue([
      candidate({ cardId: BoardCardId.make("c"), orderKey: "t" }),
      candidate({ cardId: BoardCardId.make("a"), orderKey: "c" }),
      candidate({ cardId: BoardCardId.make("b"), orderKey: "m" }),
    ]);
    assert.deepStrictEqual(keys(ordered), ["a", "b", "c"]);
  });

  it("puts a later stage first (finishing beats starting)", () => {
    const ordered = orderBoardQueue([
      candidate({ cardId: BoardCardId.make("building"), stageOrder: 4, orderKey: "a" }),
      candidate({ cardId: BoardCardId.make("review"), stageOrder: 5, orderKey: "z" }),
    ]);
    // Even with a much larger orderKey, the review-stage card outranks the
    // building one — a nearly-done card is never starved by new work.
    assert.deepStrictEqual(keys(ordered), ["review", "building"]);
  });

  it("ranks a started (mid-stage) card above an unstarted one, over drag order", () => {
    const ordered = orderBoardQueue([
      candidate({ cardId: BoardCardId.make("unstarted"), started: false, orderKey: "a" }),
      candidate({ cardId: BoardCardId.make("started"), started: true, orderKey: "z" }),
    ]);
    // Started-before-unstarted (rule 2) dominates drag order (rule 3): the
    // half-done card is not overtaken by fresh work, the starvation mitigation.
    assert.deepStrictEqual(keys(ordered), ["started", "unstarted"]);
  });

  it("applies the three rules as one total order (stage → started → drag)", () => {
    const ordered = orderBoardQueue([
      candidate({
        cardId: BoardCardId.make("b-unstarted-late"),
        stageOrder: 4,
        started: false,
        orderKey: "z",
      }),
      candidate({
        cardId: BoardCardId.make("b-started"),
        stageOrder: 4,
        started: true,
        orderKey: "m",
      }),
      candidate({
        cardId: BoardCardId.make("b-unstarted-early"),
        stageOrder: 4,
        started: false,
        orderKey: "a",
      }),
      candidate({
        cardId: BoardCardId.make("review"),
        stageOrder: 5,
        started: false,
        orderKey: "z",
      }),
    ]);
    assert.deepStrictEqual(keys(ordered), [
      "review", // later stage first
      "b-started", // then started before unstarted
      "b-unstarted-early", // then drag order among unstarted
      "b-unstarted-late",
    ]);
  });
});

describe("resolveBoardConcurrencyLimit (t3o-11 D11)", () => {
  const concurrency = (
    overrides: Partial<BoardConcurrencySettings> = {},
  ): BoardConcurrencySettings => ({
    perInstance: {},
    globalMaxConcurrent: 3,
    workers: {},
    ...overrides,
  });

  it("uses the per-instance cap when set", () => {
    const limit = resolveBoardConcurrencyLimit(
      concurrency({
        perInstance: { [ProviderInstanceId.make("codex")]: PositiveInt.make(1) },
      }),
      ProviderInstanceId.make("codex"),
    );
    assert.deepStrictEqual(limit, { global: 3, worker: 3, perInstance: 1 });
  });

  it("falls back to the global ceiling (null per-instance) for an uncapped instance", () => {
    const limit = resolveBoardConcurrencyLimit(
      concurrency({
        perInstance: { [ProviderInstanceId.make("codex")]: PositiveInt.make(1) },
      }),
      ProviderInstanceId.make("claude"),
    );
    assert.deepStrictEqual(limit, { global: 3, worker: 3, perInstance: null });
  });

  it("treats an explicit null cap the same as an absent one (clearing an override)", () => {
    const limit = resolveBoardConcurrencyLimit(
      concurrency({
        perInstance: { [ProviderInstanceId.make("codex")]: null },
      }),
      ProviderInstanceId.make("codex"),
    );
    assert.deepStrictEqual(limit, { global: 3, worker: 3, perInstance: null });
  });
});

describe("resolveBoardConcurrencyLimit per worker (T3O-65)", () => {
  const linuxBox = EnvironmentId.make("env-linux-box");
  const settings: BoardConcurrencySettings = {
    perInstance: { [ProviderInstanceId.make("codex")]: PositiveInt.make(2) },
    globalMaxConcurrent: 8,
    workers: {
      [linuxBox]: {
        maxConcurrent: PositiveInt.make(4),
        perInstance: { [ProviderInstanceId.make("claude")]: PositiveInt.make(3) },
      },
    },
  };

  it("migrates today's limit and caps to this server", () => {
    // The global limit is both the board limit and local's worker limit; the
    // per-instance caps are local's.
    assert.deepStrictEqual(
      resolveBoardConcurrencyLimit(settings, ProviderInstanceId.make("codex")),
      {
        global: 8,
        worker: 8,
        perInstance: 2,
      },
    );
  });

  it("reads a worker's own limit and caps, and nothing of local's", () => {
    assert.deepStrictEqual(
      resolveBoardConcurrencyLimit(settings, ProviderInstanceId.make("claude"), linuxBox),
      { global: 8, worker: 4, perInstance: 3 },
    );
    assert.deepStrictEqual(
      resolveBoardConcurrencyLimit(settings, ProviderInstanceId.make("codex"), linuxBox),
      { global: 8, worker: 4, perInstance: null },
    );
  });

  it("an explicit local limit overrides the inherited one, and null removes it", () => {
    const set = (maxConcurrent: number | null): BoardConcurrencySettings => ({
      ...settings,
      workers: {
        local: {
          maxConcurrent: maxConcurrent === null ? null : PositiveInt.make(maxConcurrent),
          perInstance: { [ProviderInstanceId.make("codex")]: null },
        },
      },
    });
    assert.deepStrictEqual(resolveBoardConcurrencyLimit(set(2), ProviderInstanceId.make("codex")), {
      global: 8,
      worker: 2,
      // The local entry's null clears the legacy cap.
      perInstance: null,
    });
    assert.strictEqual(
      resolveBoardConcurrencyLimit(set(null), ProviderInstanceId.make("codex")).worker,
      null,
    );
  });

  it("a provider cap above its worker limit reads as the worker limit", () => {
    const capped: BoardConcurrencySettings = {
      ...settings,
      workers: {
        [linuxBox]: {
          maxConcurrent: PositiveInt.make(2),
          perInstance: { [ProviderInstanceId.make("claude")]: PositiveInt.make(5) },
        },
      },
    };
    assert.deepStrictEqual(
      resolveBoardConcurrencyLimit(capped, ProviderInstanceId.make("claude"), linuxBox),
      { global: 8, worker: 2, perInstance: null },
    );
  });
});

describe("background-wait check-ins (T3O-20)", () => {
  const minute = 60_000;
  const due = (checkInsSent: number) =>
    boardBackgroundCheckInDueMs({ sinceMs: 0, checkInsSent }) / minute;

  it("goes out at +5, +15 and +30 minutes, then every 30", () => {
    assert.deepStrictEqual([0, 1, 2, 3, 4, 5].map(due), [5, 15, 30, 60, 90, 120]);
  });

  it("measures from when the wait began", () => {
    assert.strictEqual(
      boardBackgroundCheckInDueMs({ sinceMs: 1_000, checkInsSent: 0 }),
      1_000 + 5 * minute,
    );
  });

  it("is free for the first half hour and charged after", () => {
    assert.deepStrictEqual([0, 1, 2, 3, 4].map(boardBackgroundCheckInCharged), [
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  it("asks the agent to verify its work rather than reading as a failure", () => {
    const text = boardBackgroundCheckInNudge();
    assert.include(text, "verify it is still alive");
    assert.include(text, "board_complete_step");
    assert.include(text, "end your turn again");
    assert.notInclude(text, "your work is not finished");
    assert.notInclude(text, "todo list");
    assert.notStrictEqual(text, boardRecoveryNudge({ stallCount: 1, endedWithQuestion: false }));
  });

  it("T3O-22: neither the check-in nor a late recovery nudge asks for a todo list", () => {
    for (const text of [
      boardBackgroundCheckInNudge(),
      boardRecoveryNudge({ stallCount: 1, endedWithQuestion: false }),
      boardRecoveryNudge({ stallCount: 3, endedWithQuestion: true }),
    ]) {
      assert.notInclude(text, "todo list");
      assert.notInclude(text, "task/plan tool");
    }
  });
});
