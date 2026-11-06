/**
 * T3O-44 — the Continuous integration stage, driven through the supervisor
 * reactor with a scripted CI runner: a pass moves the card on, a failure gets
 * a fix agent or goes back to review, a restart re-runs from the top, and Skip
 * CI stops everything and moves the card. Projects without CI are unchanged.
 */
import {
  BOARD_SEED_STAGES,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  BoardStageId,
  boardCiFixStepId,
  resolveT3oProjectFile,
  withBoardProjectConfigVersion,
  boardCiAgentStepId,
  type BoardCiStep,
  type BoardCard,
  type BoardCiStepDefinition,
  type BoardEvent,
  type BoardState,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  BoardCiRunner,
  type BoardCiRunnerShape,
  type BoardCiRunResult,
} from "./ci/BoardCiRunner.ts";
import { BOARD_CI_SLOT_INSTANCE } from "./ci/ciPasses.ts";
import {
  NOW,
  buildingCard,
  cardArchived,
  cardDeleted,
  movedToBuilding,
  stepCompleted,
  cardMoved,
  cardStage,
  codexStep,
  makeBoardCard,
  otherProjectId,
  projectId,
  readyWorktree,
  settingsWith,
  stepStatus,
  withGovernor,
  type Harness,
  type HarnessEvent,
} from "./supervisorHarness.testkit.ts";

const { ci, review, merge } = BOARD_SEED_STAGE_IDS;
const STEPS: ReadonlyArray<BoardCiStepDefinition> = [
  { name: "Lint", command: "vp lint", timeoutMinutes: 30 },
  { name: "Test", command: "vp test", timeoutMinutes: 30 },
];

const ciFile = (extra: Record<string, unknown> = {}) => ({
  stages: { settings: { ci: { steps: STEPS, ...extra } } },
});

const configFrom = (raw: unknown) => {
  const resolved = resolveT3oProjectFile({
    raw,
    board: { cards: [], stages: BOARD_SEED_STAGES, nextCardNumberByProject: {} },
    projectId,
    now: NOW,
  });
  return {
    resolved,
    config: withBoardProjectConfigVersion({
      ...resolved.delta,
      dismissedImportSha: null,
      lastChangedBy: null,
    }),
  };
};

const ciConfig = (extra: Record<string, unknown> = {}) => configFrom(ciFile(extra)).config;

type Script = BoardCiRunResult | "hang";

/** A runner that plays back one script per pass, reporting each step it
    "runs" the way the real one does, and counts its calls. */
const scriptedRunner = (scripts: ReadonlyArray<Script>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const runner: BoardCiRunnerShape = {
      run: (request, emit) =>
        Effect.gen(function* () {
          const call = yield* Ref.getAndUpdate(calls, (n) => n + 1);
          const script = scripts[call] ?? { result: "passed", failedIndex: null };
          if (script === "hang") return yield* Effect.never;
          const last = script.failedIndex ?? request.steps.length - 1;
          for (const [index, step] of request.steps.entries()) {
            if (index > last) break;
            const failed = index === script.failedIndex;
            yield* emit({
              index,
              step: {
                ...step,
                status: failed ? "failed" : "passed",
                startedAt: NOW,
                finishedAt: NOW,
                exitCode: failed ? 1 : 0,
                tail: failed ? "error: it broke" : "",
              },
            });
          }
          return script;
        }),
    };
    return { runner, calls: Ref.get(calls) };
  });

const card = (id: string, stage: string, extra: Partial<BoardCard> = {}): BoardCard => ({
  ...makeBoardCard({ id, stage, orderKey: "m", worktree: readyWorktree(id) }),
  ...extra,
});

const boardWith = (cards: ReadonlyArray<BoardCard>, config = ciConfig()): BoardState => ({
  cards,
  stages: BOARD_SEED_STAGES,
  nextCardNumberByProject: {},
  projectStageConfigs: { [projectId]: config },
});

/** What the projection does with the move before the reactor hears it. */
const enterCi = (h: Harness, moved: BoardCard, sequence: number) =>
  Effect.gen(function* () {
    // Boot reconcile first, so it finds the card where the fixture put it.
    yield* h.reactor.drain;
    const inCi = { ...moved, stage: ci };
    yield* Ref.update(h.model, (model) => ({
      ...model,
      board: {
        ...model.board!,
        cards: model.board!.cards.map((existing) => (existing.id === moved.id ? inCi : existing)),
      },
    }));
    yield* h.pumpDomain(cardMoved(inCi, review, ci, sequence));
  });

/** Enter CI and let every pass that follows run to its end. */
const enterCiAndRun = (h: Harness, moved: BoardCard, sequence: number) =>
  enterCi(h, moved, sequence).pipe(Effect.andThen(h.reactor.drainCi));

const fixCompleted = (
  cardId: BoardCardId,
  stepId: string,
  payload: unknown,
  sequence: number,
): HarnessEvent =>
  ({
    type: "board.card-step-completed",
    sequence,
    payload: {
      cardId,
      completion: {
        cardId,
        stepId,
        outcome: "succeeded",
        summary: "fix report",
        payload: JSON.stringify(payload),
        threadId: null,
        completedAt: NOW,
      },
    },
  }) as unknown as HarnessEvent;

const ciRecords = (decided: ReadonlyArray<HarnessEvent>) =>
  decided.filter(
    (event): event is Extract<BoardEvent, { type: "board.card-ci-recorded" }> =>
      event.type === "board.card-ci-recorded",
  );

const settings = settingsWith({ building: [codexStep], globalMaxConcurrent: 3 });

const live = (h: Harness, id: BoardCardId) =>
  h.board.pipe(Effect.map((board) => board.cards.find((candidate) => candidate.id === id)!));

it.effect("a pass runs no agent and moves the card to Ready for merge", () =>
  Effect.gen(function* () {
    const { runner, calls } = yield* scriptedRunner([{ result: "passed", failedIndex: null }]);
    const subject = card("pass", review);
    yield* withGovernor({ board: boardWith([subject]), settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCiAndRun(h, subject, 1);
        assert.strictEqual(yield* calls, 1);
        assert.strictEqual(cardStage(yield* h.board, subject.id), merge);
        const moved = yield* live(h, subject.id);
        assert.isNull(moved.ci);
        assert.isNull(stepStatus(yield* h.board, subject.id));
        const records = ciRecords(yield* h.decided);
        assert.deepStrictEqual(
          records.map((record) => record.payload.action.kind),
          ["start-pass", "step", "step", "finish-pass"],
        );
        assert.strictEqual(records.at(-1)!.payload.activity?.ciOutcome, "passed");
        const spawned = (yield* h.commands).filter((command) => command.type === "thread.spawn");
        assert.lengthOf(spawned, 0);
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("a failure gets a fix agent; its fix re-runs every step from the top", () =>
  Effect.gen(function* () {
    const { runner, calls } = yield* scriptedRunner([
      { result: "failed", failedIndex: 1 },
      { result: "passed", failedIndex: null },
    ]);
    const subject = card("fix", review);
    yield* withGovernor({ board: boardWith([subject]), settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCiAndRun(h, subject, 1);
        const fixing = yield* live(h, subject.id);
        assert.strictEqual(fixing.stage, ci);
        assert.strictEqual(fixing.ci?.phase, "fixing");
        assert.strictEqual(fixing.ci?.fixAttempts, 1);
        const fixStep = boardCiFixStepId(1, 1);
        const state = stepStatus(yield* h.board, subject.id);
        assert.isNotNull(state);
        const select = (yield* h.commands).find(
          (command) => command.type === "board.card.select-step",
        );
        assert.isDefined(select);
        if (select?.type !== "board.card.select-step") return;
        assert.strictEqual(select.stepId, fixStep);
        assert.strictEqual(select.stepLabel, "CI fix 1 of 2");
        assert.strictEqual(select.mode, "build");
        assert.isFalse(select.humanInLoop);
        assert.include(select.prompt, 'CI step "Test" failed');

        yield* h.pumpDomain(
          fixCompleted(subject.id, fixStep, { verdict: "fixed", finding: "Fixed lint" }, 2),
        );
        yield* h.reactor.drainCi;
        assert.strictEqual(yield* calls, 2);
        assert.strictEqual(cardStage(yield* h.board, subject.id), merge);
        const settled = ciRecords(yield* h.decided).flatMap((record) => record.payload.settled);
        assert.isTrue(settled.some((entry) => entry.outcome === "fixed-in-place"));
        assert.isTrue(settled.some((entry) => entry.outcome === "passed"));
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("a fix agent's return-to-review sends the card back for a fresh round", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner([{ result: "failed", failedIndex: 0 }]);
    const subject = card("back", review);
    yield* withGovernor({ board: boardWith([subject]), settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCiAndRun(h, subject, 1);
        yield* h.pumpDomain(
          fixCompleted(
            subject.id,
            boardCiFixStepId(1, 1),
            { verdict: "return-to-review", finding: "The migration is wrong." },
            2,
          ),
        );
        const sent = yield* live(h, subject.id);
        assert.strictEqual(sent.stage, review);
        assert.isNull(sent.ci);
        assert.deepStrictEqual(sent.ciLastOutcome, {
          kind: "sent-back",
          stepName: "Lint",
          fixAttemptsUsed: 1,
          finding: "The migration is wrong.",
          round: 1,
        });
        // A fresh round: the review-overrides path floors the budget at it.
        assert.strictEqual(sent.reviewOverrides?.runThroughRound, 1);
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("with no fixes left, a failure goes straight back to review and buys a round", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner([{ result: "failed", failedIndex: 1 }]);
    const subject = card("capped", review);
    const board = {
      ...boardWith([subject], ciConfig({ maxFixAttempts: 0 })),
      // Three review rounds already run: the card's budget is used up.
      stepCompletions: [1, 2, 3].map((round) => ({
        cardId: subject.id,
        stepId: `adjudicate@${round}`,
        outcome: "succeeded" as const,
        summary: "",
        payload: null,
        threadId: null,
        completedAt: NOW,
      })),
    };
    yield* withGovernor({ board, settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCiAndRun(h, subject, 1);
        const sent = yield* live(h, subject.id);
        assert.strictEqual(sent.stage, review);
        assert.strictEqual(sent.ciLastOutcome?.kind, "sent-back");
        assert.strictEqual(sent.ciLastOutcome?.fixAttemptsUsed, 0);
        assert.include(sent.ciLastOutcome?.finding ?? "", 'CI step "Test"');
        assert.strictEqual(sent.reviewOverrides?.runThroughRound, 4);
        assert.strictEqual(sent.ciLastOutcome?.round, 4);
        const spawned = (yield* h.commands).filter((command) => command.type === "thread.spawn");
        assert.lengthOf(spawned, 0);
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("the board's own advance carries a card into CI", () =>
  Effect.gen(function* () {
    // A project stage between review and CI that auto-advances: finishing it
    // is the board's move into CI, as a stale-base return re-entering review
    // and converging would be.
    const { runner, calls } = yield* scriptedRunner([{ result: "passed", failedIndex: null }]);
    const raw = {
      stages: {
        add: [
          {
            id: "qa",
            label: "QA",
            after: "review",
            autoExecute: true,
            autoAdvance: true,
            prompt: "QA it.",
          },
        ],
        settings: { ci: { steps: STEPS } },
      },
    };
    const { resolved, config } = configFrom(raw);
    const qa = resolved.createStages[0]!.stageId;
    const subject = card("qa", qa);
    yield* withGovernor(
      {
        board: {
          cards: [subject],
          stages: [...BOARD_SEED_STAGES, ...resolved.createStages],
          nextCardNumberByProject: {},
          projectStageConfigs: { [projectId]: config },
        },
        settings,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(cardMoved(subject, review, qa, 1));
          yield* h.pumpDomain(fixCompleted(subject.id, String(qa), {}, 2));
          assert.strictEqual(cardStage(yield* h.board, subject.id), ci);
          // The move is the pipeline's, so CI's human rules let it through.
          const move = (yield* h.commands).find(
            (command) => command.type === "board.card.pipeline-move",
          );
          assert.isDefined(move);
          assert.strictEqual(yield* calls, 0);
        }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("a project without CI moves review → merge exactly as before", () =>
  Effect.gen(function* () {
    const { runner, calls } = yield* scriptedRunner([]);
    const subject = { ...card("plain", review), projectId: otherProjectId };
    yield* withGovernor({ board: boardWith([subject]), settings }, (h) =>
      Effect.gen(function* () {
        const board = yield* h.board;
        assert.isNull((yield* Effect.succeed(board)).projectStageConfigs?.[otherProjectId] ?? null);
        yield* h.pumpDomain(cardMoved({ ...subject, stage: merge }, review, merge, 1));
        assert.strictEqual(yield* calls, 0);
        assert.lengthOf(ciRecords(yield* h.decided), 0);
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("a restart marks the cut-off pass interrupted and runs again from the top", () =>
  Effect.gen(function* () {
    const { runner, calls } = yield* scriptedRunner([{ result: "passed", failedIndex: null }]);
    const subject = card("restart", ci, {
      ci: {
        runId: "ci-before-restart",
        entry: 1,
        fixAttempts: 0,
        maxFixAttempts: 2,
        phase: "running",
        steps: STEPS.map((step, index) => ({
          name: step.name,
          status: index === 0 ? ("passed" as const) : ("running" as const),
          startedAt: NOW,
          finishedAt: index === 0 ? NOW : null,
        })),
      },
    });
    yield* withGovernor({ board: boardWith([subject]), settings }, (h) =>
      Effect.gen(function* () {
        yield* h.reactor.drainCi;
        assert.strictEqual(yield* calls, 1);
        const settled = ciRecords(yield* h.decided).flatMap((record) => record.payload.settled);
        assert.deepInclude(settled, {
          runId: "ci-before-restart",
          outcome: "interrupted",
          finishedAt: settled.find((entry) => entry.runId === "ci-before-restart")!.finishedAt!,
        });
        assert.strictEqual(cardStage(yield* h.board, subject.id), merge);
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("a restart leaves a held pass held for a human", () =>
  Effect.gen(function* () {
    const { runner, calls } = yield* scriptedRunner([{ result: "passed", failedIndex: null }]);
    const subject = card("held", ci, {
      ci: {
        runId: "ci-held",
        entry: 1,
        fixAttempts: 0,
        maxFixAttempts: 2,
        phase: "held",
        steps: STEPS.map((step) => ({
          name: step.name,
          status: "cancelled" as const,
          startedAt: null,
          finishedAt: null,
        })),
      },
    });
    yield* withGovernor({ board: boardWith([subject]), settings }, (h) =>
      Effect.gen(function* () {
        yield* h.reactor.drainCi;
        assert.strictEqual(yield* calls, 0);
        const held = yield* live(h, subject.id);
        assert.strictEqual(held.stage, ci);
        assert.strictEqual(held.ci?.phase, "held");
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("Skip CI stops the pass, records who skipped it, and moves the card on", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner(["hang"]);
    const subject = card("skip", review);
    yield* withGovernor({ board: boardWith([subject]), settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCi(h, subject, 1);
        assert.strictEqual((yield* live(h, subject.id)).ci?.phase, "queued");
        const result = yield* h.reactor.skipCi(subject.id, () => Effect.void);
        assert.deepStrictEqual(result, { outcome: "skipped", toStage: merge });
        yield* h.reactor.drain;
        const skipped = yield* live(h, subject.id);
        assert.strictEqual(skipped.stage, merge);
        assert.deepStrictEqual(skipped.ciLastOutcome, { kind: "skipped", actor: "You" });
        const records = ciRecords(yield* h.decided);
        assert.isTrue(
          records.some((record) =>
            record.payload.settled.some((entry) => entry.outcome === "skipped"),
          ),
        );
        // Skipped, not also cancelled: the pass was stopped quietly first.
        assert.isFalse(
          records.some((record) =>
            record.payload.settled.some((entry) => entry.outcome === "cancelled"),
          ),
        );
        assert.deepStrictEqual(yield* h.reactor.skipCi(subject.id, () => Effect.void), {
          outcome: "not-in-ci",
        });
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("dragging a card back out of CI cancels its pass", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner(["hang"]);
    const subject = card("dragged", review);
    yield* withGovernor({ board: boardWith([subject]), settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCi(h, subject, 1);
        yield* Ref.update(h.model, (model) => ({
          ...model,
          board: {
            ...model.board!,
            cards: model.board!.cards.map((existing) =>
              existing.id === subject.id ? { ...existing, stage: review, ci: null } : existing,
            ),
          },
        }));
        yield* h.pumpDomain(
          cardMoved({ ...subject, stage: BoardStageId.make(review) }, ci, review, 2),
        );
        // The pass fiber is stopped and its slot freed; the move's own decision
        // settles the row (ciProjection.test.ts).
        yield* h.reactor.drainCi;
        assert.strictEqual(yield* h.slots.heldFor(BOARD_CI_SLOT_INSTANCE), 0);
        assert.isNull((yield* live(h, subject.id)).ci);
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("a queued pass starts when an agent step frees the slot", () =>
  Effect.gen(function* () {
    const { runner, calls } = yield* scriptedRunner([{ result: "passed", failedIndex: null }]);
    const blocker = buildingCard("blocker", "b");
    const subject = card("waiting", review);
    const oneSlot = settingsWith({ building: [codexStep], globalMaxConcurrent: 1 });
    yield* withGovernor({ board: boardWith([blocker, subject]), settings: oneSlot }, (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(movedToBuilding(blocker, 1));
        assert.strictEqual(stepStatus(yield* h.board, blocker.id), "running");
        yield* enterCiAndRun(h, subject, 2);
        assert.strictEqual(yield* calls, 0);
        assert.strictEqual((yield* live(h, subject.id)).ci?.phase, "queued");

        yield* h.pumpDomain(stepCompleted(blocker.id, "blocked", 3));
        yield* h.reactor.drainCi;
        assert.strictEqual(yield* calls, 1);
        assert.strictEqual(cardStage(yield* h.board, subject.id), merge);
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

/** The fixture's card as the projection leaves it after a decision. */
const setCard = (h: Harness, id: BoardCardId, next: BoardCard | null) =>
  Ref.update(h.model, (model) => ({
    ...model,
    board: {
      ...model.board!,
      cards: model.board!.cards.flatMap((existing) =>
        existing.id !== id ? [existing] : next === null ? [] : [next],
      ),
    },
  }));

it.effect("archiving a card in CI stops its pass, frees the slot and settles the row", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner(["hang"]);
    const subject = card("archived-in-ci", review);
    yield* withGovernor({ board: boardWith([subject]), settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCi(h, subject, 1);
        assert.strictEqual(yield* h.slots.heldFor(BOARD_CI_SLOT_INSTANCE), 1);
        const runId = (yield* live(h, subject.id)).ci!.runId;
        const archived = { ...(yield* live(h, subject.id)), archivedAt: NOW };
        yield* setCard(h, subject.id, archived);
        yield* h.pumpDomain(cardArchived(archived, 2));
        yield* h.reactor.drainCi;
        assert.strictEqual(yield* h.slots.heldFor(BOARD_CI_SLOT_INSTANCE), 0);
        const settled = ciRecords(yield* h.decided).flatMap((record) => record.payload.settled);
        assert.isTrue(
          settled.some((entry) => entry.runId === runId && entry.outcome === "cancelled"),
        );
        assert.isNull((yield* live(h, subject.id)).ci);
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("a queued pass of an archived card never starts", () =>
  Effect.gen(function* () {
    const { runner, calls } = yield* scriptedRunner([{ result: "passed", failedIndex: null }]);
    const blocker = buildingCard("blocker", "b");
    const subject = card("archived-queued", review);
    const oneSlot = settingsWith({ building: [codexStep], globalMaxConcurrent: 1 });
    yield* withGovernor({ board: boardWith([blocker, subject]), settings: oneSlot }, (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(movedToBuilding(blocker, 1));
        yield* enterCi(h, subject, 2);
        assert.strictEqual((yield* live(h, subject.id)).ci?.phase, "queued");
        const archived = { ...(yield* live(h, subject.id)), archivedAt: NOW };
        yield* setCard(h, subject.id, archived);
        yield* h.pumpDomain(cardArchived(archived, 3));
        yield* h.pumpDomain(stepCompleted(blocker.id, "blocked", 4));
        yield* h.reactor.drainCi;
        assert.strictEqual(yield* calls, 0);
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("deleting a card in CI stops its pass and frees the slot", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner(["hang"]);
    const subject = card("deleted-in-ci", review);
    yield* withGovernor({ board: boardWith([subject]), settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCi(h, subject, 1);
        assert.strictEqual(yield* h.slots.heldFor(BOARD_CI_SLOT_INSTANCE), 1);
        const doomed = yield* live(h, subject.id);
        yield* setCard(h, subject.id, null);
        yield* h.pumpDomain(cardDeleted(doomed, 2, null));
        yield* h.reactor.drainCi;
        assert.strictEqual(yield* h.slots.heldFor(BOARD_CI_SLOT_INSTANCE), 0);
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("switching CI off moves the project's cards on from CI, auto-merge disarmed", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner(["hang"]);
    const subject = card("off", review);
    yield* withGovernor({ board: boardWith([subject]), settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCi(h, subject, 1);
        assert.strictEqual(cardStage(yield* h.board, subject.id), ci);
        const off = withBoardProjectConfigVersion({ ...ciConfig(), stageSwitches: {} });
        yield* Ref.update(h.model, (model) => ({
          ...model,
          board: { ...model.board!, projectStageConfigs: { [projectId]: off } },
        }));
        yield* h.pumpDomain({
          type: "board.project-stage-config-set",
          sequence: 2,
          payload: {
            projectId,
            config: off,
            upserts: [],
            deletedStageIds: [],
            cause: "ci-enabled",
          },
        } as unknown as HarnessEvent);
        assert.strictEqual(cardStage(yield* h.board, subject.id), merge);
        const disarm = (yield* h.commands).find(
          (command) => command.type === "board.card.set-automation",
        );
        assert.deepStrictEqual(
          disarm === undefined
            ? null
            : { autoMerge: (disarm as { autoMerge?: boolean }).autoMerge },
          { autoMerge: false },
        );
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("a send-back counts a round trip, and at the limit CI stops for a human", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner([
      { result: "failed", failedIndex: 1 },
      { result: "failed", failedIndex: 1 },
      { result: "passed", failedIndex: null },
    ]);
    const below = card("below", review);
    const atLimit = { ...card("limit", review), ciRoundTrips: 1 };
    const board = boardWith([below, atLimit], ciConfig({ maxFixAttempts: 0, maxRoundTrips: 1 }));
    yield* withGovernor({ board, settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCiAndRun(h, below, 1);
        const sent = yield* live(h, below.id);
        assert.strictEqual(sent.stage, review);
        assert.strictEqual(sent.ciRoundTrips, 1);

        yield* enterCiAndRun(h, atLimit, 2);
        const stopped = yield* live(h, atLimit.id);
        assert.strictEqual(stopped.stage, ci);
        assert.strictEqual(stopped.ci?.phase, "stopped");
        assert.include(stopped.ci?.stopReason ?? "", "after 1 round trip");
        assert.strictEqual(
          ciRecords(yield* h.decided).at(-1)?.payload.activity?.kind,
          "card-ci-stopped",
        );

        // Retry CI starts afresh (no round trips), and this time it passes.
        assert.deepStrictEqual(yield* h.reactor.retryCi(atLimit.id), { outcome: "retried" });
        yield* h.reactor.drainCi;
        const retried = yield* live(h, atLimit.id);
        assert.strictEqual(retried.ciRoundTrips, 0);
        assert.strictEqual(retried.stage, merge);
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("send back to review anyway starts the round trips again", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner([{ result: "failed", failedIndex: 1 }]);
    const subject = { ...card("anyway", review), ciRoundTrips: 2 };
    const board = boardWith([subject], ciConfig({ maxFixAttempts: 0, maxRoundTrips: 2 }));
    yield* withGovernor({ board, settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCiAndRun(h, subject, 1);
        assert.strictEqual((yield* live(h, subject.id)).ci?.phase, "stopped");
        assert.deepStrictEqual(yield* h.reactor.ciSendBack(subject.id), { outcome: "sent-back" });
        const sent = yield* live(h, subject.id);
        assert.strictEqual(sent.stage, review);
        assert.strictEqual(sent.ciRoundTrips, 0);
        assert.strictEqual(sent.ciLastOutcome?.kind, "sent-back");
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

const mixedConfig = (steps: ReadonlyArray<BoardCiStep>) =>
  withBoardProjectConfigVersion({
    ...ciConfig(),
    ci: { steps },
  });

const SCRIPT_A: BoardCiStep = {
  kind: "script",
  id: "lint",
  name: "Lint",
  parallel: false,
  command: "vp lint",
  timeoutMinutes: 30,
};
const SCRIPT_B: BoardCiStep = { ...SCRIPT_A, id: "test", name: "Test", command: "vp test" };

it.effect("an agent step runs as a card step between script segments, then the pass goes on", () =>
  Effect.gen(function* () {
    const { runner, calls } = yield* scriptedRunner([
      { result: "passed", failedIndex: null },
      { result: "passed", failedIndex: null },
    ]);
    const subject = card("agent", review);
    const agentStep: BoardCiStep = {
      kind: "agent",
      id: "audit",
      name: "Migration review",
      parallel: false,
      prompt: "Check every migration is reversible.",
      model: null,
      timeoutMinutes: 20,
    };
    const board = boardWith([subject], mixedConfig([SCRIPT_A, agentStep, SCRIPT_B]));
    yield* withGovernor({ board, settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCiAndRun(h, subject, 1);
        assert.strictEqual(yield* calls, 1);
        const selected = (yield* h.commands).find(
          (command) =>
            command.type === "board.card.select-step" &&
            (command as { stepId: string }).stepId.startsWith("ci@"),
        ) as { stepId: string; prompt: string; timeoutMs: number } | undefined;
        assert.isDefined(selected);
        assert.include(selected!.prompt, "Check every migration is reversible.");
        assert.include(selected!.prompt, "Steps after this one: Test.");
        assert.strictEqual(selected!.timeoutMs, 20 * 60_000);
        yield* h.pumpDomain(
          fixCompleted(subject.id, selected!.stepId, { verdict: "passed", summary: "All good" }, 2),
        );
        yield* h.reactor.drainCi;
        assert.strictEqual(yield* calls, 2);
        assert.strictEqual(cardStage(yield* h.board, subject.id), merge);
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect(
  "a later segment that can't reach the worker holds the pass, and Retry CI restarts it",
  () =>
    Effect.gen(function* () {
      const { runner } = yield* scriptedRunner([{ result: "passed", failedIndex: null }]);
      const subject = card("agent-held", review);
      const agentStep: BoardCiStep = {
        kind: "agent",
        id: "audit",
        name: "Audit",
        parallel: false,
        prompt: "Audit it.",
        model: null,
        timeoutMinutes: 30,
      };
      const board = boardWith([subject], mixedConfig([SCRIPT_A, agentStep, SCRIPT_B]));
      yield* withGovernor({ board, settings }, (h) =>
        Effect.gen(function* () {
          yield* enterCiAndRun(h, subject, 1);
          const stepId = boardCiAgentStepId((yield* live(h, subject.id)).ci!.runId, 1);
          // The card is moved to a worker this board has no connection to.
          yield* Ref.update(h.model, (model) => ({
            ...model,
            board: {
              ...model.board!,
              cards: model.board!.cards.map((existing) =>
                existing.id === subject.id
                  ? { ...existing, placedWorkerId: "worker-gone" as never }
                  : existing,
              ),
            },
          }));
          yield* h.pumpDomain(
            fixCompleted(subject.id, stepId, { verdict: "passed", summary: "ok" }, 2),
          );
          yield* h.reactor.drainCi;
          assert.strictEqual((yield* live(h, subject.id)).ci?.phase, "held");
          assert.deepStrictEqual(yield* h.reactor.retryCi(subject.id), { outcome: "retried" });
        }),
      ).pipe(Effect.provideService(BoardCiRunner, runner));
    }),
);

it.effect("a failed agent verdict is the pass's failure: a fix agent gets it", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner([{ result: "passed", failedIndex: null }]);
    const subject = card("agent-fail", review);
    const agentStep: BoardCiStep = {
      kind: "agent",
      id: "audit",
      name: "Audit",
      parallel: false,
      prompt: "Audit it.",
      model: null,
      timeoutMinutes: 30,
    };
    const board = boardWith([subject], mixedConfig([SCRIPT_A, agentStep]));
    yield* withGovernor({ board, settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCiAndRun(h, subject, 1);
        const stepId = boardCiAgentStepId((yield* live(h, subject.id)).ci!.runId, 1);
        yield* h.pumpDomain(
          fixCompleted(
            subject.id,
            stepId,
            {
              verdict: "failed",
              summary: "One migration drops a column",
              failures: [{ title: "Irreversible", file: "db/007.sql", line: 3 }],
            },
            2,
          ),
        );
        const fix = (yield* h.commands).find(
          (command) =>
            command.type === "board.card.select-step" &&
            (command as { stepId: string }).stepId.startsWith("ci-fix@"),
        ) as { prompt: string } | undefined;
        assert.isDefined(fix);
        assert.include(fix!.prompt, "Irreversible (db/007.sql:3)");
        assert.strictEqual((yield* live(h, subject.id)).ci?.phase, "fixing");
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

const FORGE: BoardCiStep = {
  kind: "forge-checks",
  id: "gh",
  name: "GitHub checks",
  parallel: false,
  only: [],
  appearTimeoutMinutes: 10,
  whenNoChecks: "pass",
  timeoutMinutes: 60,
};

const prOpen = {
  number: 7,
  url: "https://example.test/pull/7",
  state: "open" as const,
  title: "Feature",
  headBranch: "board/forge",
  baseRef: "main",
  checkedAt: NOW,
};
/** What the forge lookup answers, so the link a refresh reads stays put. */
const foundPr = {
  number: 7,
  title: "Feature",
  url: "https://example.test/pull/7",
  baseRef: "main",
  headRef: "board/forge",
  state: "open" as const,
};
const mergeStateWith = (checks: { passed: number; pending: number; failed: number }) => ({
  mergeable: "unknown" as const,
  blockedReason: null,
  checks: {
    total: checks.passed + checks.pending + checks.failed,
    ...checks,
    failing: checks.failed > 0 ? ["ci/e2e"] : [],
    running: checks.pending > 0 ? ["ci/build"] : [],
  },
  headSha: "sha-1",
  checksUnread: false,
});

it.effect("a forge-checks step waits on the pull request's checks, then passes", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner([{ result: "passed", failedIndex: null }]);
    const subject = card("forge", review, { pullRequest: prOpen as never });
    const forge: BoardCiStep = {
      kind: "forge-checks",
      id: "gh",
      name: "GitHub checks",
      parallel: false,
      only: [],
      appearTimeoutMinutes: 10,
      whenNoChecks: "pass",
      timeoutMinutes: 60,
    };
    let state = mergeStateWith({ passed: 1, pending: 1, failed: 0 });
    yield* withGovernor(
      {
        board: boardWith([subject], mixedConfig([SCRIPT_A, forge])),
        settings,
        pullRequest: foundPr,
        mergeStateOf: () => state,
      },
      (h) =>
        Effect.gen(function* () {
          yield* enterCiAndRun(h, subject, 1);
          assert.strictEqual(cardStage(yield* h.board, subject.id), ci);
          assert.isAbove((yield* h.mergeStateProbes).length, 0);
          state = mergeStateWith({ passed: 2, pending: 0, failed: 0 });
          yield* h.reactor.sweep;
          assert.strictEqual(cardStage(yield* h.board, subject.id), merge);
        }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("a failing forge check (matched by its filter) fails the pass", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner([{ result: "passed", failedIndex: null }]);
    const failing = card("forge-fail", review, { pullRequest: prOpen as never });
    yield* withGovernor(
      {
        board: boardWith(
          [failing],
          withBoardProjectConfigVersion({
            ...mixedConfig([SCRIPT_A, { ...FORGE, only: ["ci/*"] }]),
            overrides: { ci: { maxFixAttempts: 0, maxRoundTrips: 3 } },
          }),
        ),
        settings,
        pullRequest: foundPr,
        mergeState: mergeStateWith({ passed: 1, pending: 0, failed: 1 }),
      },
      (h) =>
        Effect.gen(function* () {
          yield* enterCiAndRun(h, failing, 1);
          const sent = yield* live(h, failing.id);
          assert.strictEqual(sent.stage, review);
          assert.include(sent.ciLastOutcome?.finding ?? "", "ci/e2e");
        }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("a forge-checks step with no pull request holds the card for a human", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner([{ result: "passed", failedIndex: null }]);
    const noPr = card("forge-nopr", review);
    yield* withGovernor(
      { board: boardWith([noPr], mixedConfig([SCRIPT_A, FORGE])), settings },
      (h) =>
        Effect.gen(function* () {
          yield* enterCiAndRun(h, noPr, 1);
          const held = yield* live(h, noPr.id);
          assert.strictEqual(held.stage, ci);
          assert.strictEqual(held.ci?.phase, "held");
          // Send back is for a stopped pass; a held one is retried or skipped.
          assert.deepStrictEqual(yield* h.reactor.ciSendBack(noPr.id), {
            outcome: "not-stopped",
          });
        }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);
