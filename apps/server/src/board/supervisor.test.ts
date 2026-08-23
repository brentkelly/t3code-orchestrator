import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  BoardStageId,
  PositiveInt,
  ProviderInstanceId,
  type BoardCardStepState,
  type BoardConcurrencySettings,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
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
  // counters, a progressedSinceLastNudge boolean, the invocation total and the
  // ceiling), never git or a database. Every case here is a plain function call.
  const decide = (input: {
    readonly attempt?: number;
    readonly stallCount: number;
    readonly maxAttempts?: number;
    readonly progressedSinceLastNudge?: boolean;
    readonly hasTodoList?: boolean;
    readonly stageEntryInvocations?: number;
    readonly maxInvocationsPerStageEntry?: number;
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
      // t3o-18 D16: default to "the thread keeps a list", so the todo-specific
      // assertions below are the only ones that see the extra nudge line.
      hasTodoList: input.hasTodoList ?? true,
      stageEntryInvocations: input.stageEntryInvocations ?? 0,
      maxInvocationsPerStageEntry: input.maxInvocationsPerStageEntry ?? 20,
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

  it("t3o-18 D16: a nudged thread with NO todo list is asked to write one; one with a list is not", () => {
    const without = decide({ stallCount: 0, hasTodoList: false });
    assert.strictEqual(without.kind, "resume");
    if (without.kind === "resume") {
      assert.include(without.nudge, "todo list");
      assert.include(without.nudge, "write one");
    }
    const withList = decide({ stallCount: 0, hasTodoList: true });
    assert.strictEqual(withList.kind, "resume");
    if (withList.kind === "resume") assert.notInclude(withList.nudge, "write one");
  });

  // t3o-19 AC 11: the escalation a human reads names the STEP only when the
  // stage has steps. On every other stage `stepLabel` is null and naming a
  // step would invent one.
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
      hasTodoList: true,
      stageEntryInvocations: 0,
      maxInvocationsPerStageEntry: 20,
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
      hasTodoList: true,
      stageEntryInvocations: 0,
      maxInvocationsPerStageEntry: 20,
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
        const resumed = decide({ stallCount: 0, hasTodoList: false });
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

  it("t3o-18 D16: the unattended postamble asks for a todo list; the human-in-the-loop one does not", () => {
    const step = { stepId: "building", stepLabel: null, prompt: "Do the work" };
    const card = { key: "T3O-1", title: "Card", stage: BOARD_SEED_STAGE_IDS.building };
    const unattended = composeStepPrompt({
      card,
      stageLabel: "Building",
      step: { ...step, humanInLoop: false },
      role: "build",
    });
    assert.include(unattended, "todo list");
    // AC 25: nagging a conversational turn into a todo list for a one-line
    // answer is noise, and these steps are not stall-supervised anyway.
    const humanInLoop = composeStepPrompt({
      card,
      stageLabel: "Building",
      step: { ...step, humanInLoop: true },
      role: "build",
    });
    assert.notInclude(humanInLoop, "todo list");
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

  it("crit 11/13: crossing the per-stage-entry invocation ceiling stalls the stage even when no single step exhausted maxAttempts", () => {
    // stallCount is nowhere near maxAttempts, but the stage entry's total
    // invocations cross the ceiling — the runaway backstop escalates regardless.
    // Generic over any stage's invocation count, so a t3o-16 review loop cannot
    // exceed the ceiling silently.
    const capped = decide({
      stallCount: 0,
      maxAttempts: 5,
      stageEntryInvocations: 20,
      maxInvocationsPerStageEntry: 20,
    });
    assert.strictEqual(capped.kind, "escalate");
    if (capped.kind === "escalate") {
      assert.include(capped.question, "21 agent invocations");
      assert.include(capped.question, "20 allowed");
    }
    // One below the ceiling still resumes.
    assert.strictEqual(
      decide({
        stallCount: 0,
        stageEntryInvocations: 18,
        maxInvocationsPerStageEntry: 20,
      }).kind,
      "resume",
    );
  });
});

describe("reconcileStepDecision (boot reconciliation)", () => {
  it("advances a step that completed while the server was down", () => {
    assert.deepStrictEqual(
      reconcileStepDecision({ status: "running", threadAlive: false, hasSucceeded: true }),
      { kind: "advance" },
    );
  });

  it("resumes watching a running step whose thread is still alive", () => {
    assert.deepStrictEqual(
      reconcileStepDecision({ status: "running", threadAlive: true, hasSucceeded: false }),
      { kind: "resume-watch" },
    );
  });

  it("recovers a running step whose thread is gone (routine, not an error)", () => {
    assert.deepStrictEqual(
      reconcileStepDecision({ status: "running", threadAlive: false, hasSucceeded: false }),
      { kind: "recover" },
    );
  });

  it("keeps waiting on an awaiting-input step whose question thread survives", () => {
    assert.deepStrictEqual(
      reconcileStepDecision({ status: "awaiting-input", threadAlive: true, hasSucceeded: false }),
      { kind: "resume-watch" },
    );
  });

  it("re-offers a queued/pending step to the governor (t3o-11): reschedule, not recover", () => {
    // A slotless, never-started step is placed by the governor's schedule pass,
    // not treated as a stall — recovering it would burn an attempt on work that
    // never ran (D11).
    assert.deepStrictEqual(
      reconcileStepDecision({ status: "queued", threadAlive: false, hasSucceeded: false }),
      { kind: "reschedule" },
    );
    assert.deepStrictEqual(
      reconcileStepDecision({ status: "pending", threadAlive: false, hasSucceeded: false }),
      { kind: "reschedule" },
    );
  });

  it("still recovers a completing step whose settle never landed", () => {
    assert.deepStrictEqual(
      reconcileStepDecision({ status: "completing", threadAlive: false, hasSucceeded: false }),
      { kind: "recover" },
    );
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
    ...overrides,
  });

  it("uses the per-instance cap when set", () => {
    const limit = resolveBoardConcurrencyLimit(
      concurrency({
        perInstance: { [ProviderInstanceId.make("codex")]: PositiveInt.make(1) },
      }),
      ProviderInstanceId.make("codex"),
    );
    assert.deepStrictEqual(limit, { perInstance: 1, global: 3 });
  });

  it("falls back to the global ceiling (null per-instance) for an uncapped instance", () => {
    const limit = resolveBoardConcurrencyLimit(
      concurrency({
        perInstance: { [ProviderInstanceId.make("codex")]: PositiveInt.make(1) },
      }),
      ProviderInstanceId.make("claude"),
    );
    assert.deepStrictEqual(limit, { perInstance: null, global: 3 });
  });

  it("treats an explicit null cap the same as an absent one (clearing an override)", () => {
    const limit = resolveBoardConcurrencyLimit(
      concurrency({
        perInstance: { [ProviderInstanceId.make("codex")]: null },
      }),
      ProviderInstanceId.make("codex"),
    );
    assert.deepStrictEqual(limit, { perInstance: null, global: 3 });
  });
});
