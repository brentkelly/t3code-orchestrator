// @effect-diagnostics nodeBuiltinImport:off
/**
 * The CI stage through the reactor with a scripted runner: pass moves on,
 * failure gets a fix agent or a human, restart re-runs, Stop on failure = No
 * runs every step, Skip CI moves the card. Projects without CI are unchanged.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  BOARD_SEED_STAGES,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  BoardStageId,
  EnvironmentId,
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
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import {
  BoardCiRunner,
  type BoardCiRunRequest,
  type BoardCiRunnerShape,
  type BoardCiRunResult,
} from "./ci/BoardCiRunner.ts";
import { BoardDiskSpace } from "./ci/diskSpace.ts";
import { layerTest } from "../config.ts";
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
  type HarnessCommand,
  type HarnessEvent,
} from "./supervisorHarness.testkit.ts";
import { makeFakeCapacity, roomForCards } from "./capacity/capacityClient.testkit.ts";

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

/** `drop` is a worker connection closing mid-run: the stream is interrupted
    under a pass nobody cancelled. */
type Script =
  | Extract<BoardCiRunResult, { result: "unavailable" }>
  | (Omit<Extract<BoardCiRunResult, { result: "passed" | "failed" }>, "ranAll"> & {
      /** More failing steps (request indexes) when the pass runs every step. */
      readonly alsoFailed?: ReadonlyArray<number>;
      /** Force `ranAll`, as an older worker that sends none reads (false). */
      readonly ranAll?: boolean;
    })
  | "hang"
  | "drop";

/** A runner that plays back one script per pass, reporting each step it
    "runs" the way the real one does, and counts its calls. With
    `stopOnFailure: false` it runs every step, as the real one does. */
const scriptedRunner = (scripts: ReadonlyArray<Script>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const requests = yield* Ref.make<ReadonlyArray<BoardCiRunRequest>>([]);
    const runner: BoardCiRunnerShape = {
      run: (request, emit) =>
        Effect.gen(function* () {
          const call = yield* Ref.getAndUpdate(calls, (n) => n + 1);
          yield* Ref.update(requests, (all) => [...all, request]);
          const script = scripts[call] ?? { result: "passed", failedIndex: null };
          if (script === "hang") return yield* Effect.never;
          if (script === "drop") return yield* Effect.interrupt;
          if (script.result === "unavailable") return script;
          const runsAll = request.stopOnFailure === false && script.ranAll !== false;
          const failing = new Set([
            ...(script.failedIndex === null ? [] : [script.failedIndex]),
            ...(script.alsoFailed ?? []),
          ]);
          const last = runsAll
            ? request.steps.length - 1
            : (script.failedIndex ?? request.steps.length - 1);
          for (const [index, step] of request.steps.entries()) {
            if (index > last) break;
            const failed = failing.has(index);
            yield* emit({
              index,
              step: {
                ...step,
                status: failed ? "failed" : "passed",
                startedAt: NOW,
                finishedAt: NOW,
                exitCode: failed ? 1 : 0,
                tail: failed ? "error: it broke" : "",
                ...(failed && script.result === "failed" && script.headline !== undefined
                  ? { headline: script.headline }
                  : {}),
              },
            });
          }
          const { alsoFailed: _alsoFailed, ...result } = script;
          return {
            ...result,
            ranAll: script.ranAll ?? (runsAll || last === request.steps.length - 1),
          };
        }),
    };
    return { runner, calls: Ref.get(calls), requests: Ref.get(requests) };
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

const lintHeadline = {
  what: "Test → lint",
  why: "No files matching the pattern",
  machine: false,
  logLine: 7,
  logOffset: 210,
  source: "pattern" as const,
};

const libraryHeadline = {
  what: "Test",
  why: "Missing system library: libnspr4.so",
  machine: true,
  logLine: 3,
  logOffset: 90,
  source: "machine" as const,
  hint: "Install the package that provides libnspr4.so.",
};

it.effect("T3O-61 (Z5-307): a machine failure holds the card and starts no fix agent", () =>
  Effect.gen(function* () {
    const { runner, calls } = yield* scriptedRunner([
      { result: "failed", failedIndex: 1, exitCode: 127, headline: libraryHeadline },
    ]);
    const subject = card("machine", review);
    yield* withGovernor({ board: boardWith([subject]), settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCiAndRun(h, subject, 1);
        assert.strictEqual(yield* calls, 1);
        const held = yield* live(h, subject.id);
        assert.strictEqual(held.stage, ci);
        assert.strictEqual(held.ci?.phase, "held");
        assert.strictEqual(held.ci?.machine, true);
        assert.strictEqual(held.ci?.fixAttempts, 0);
        assert.strictEqual(held.ciRoundTrips, 0);
        assert.deepStrictEqual(held.ci?.headline, libraryHeadline);
        assert.match(
          held.ci?.stopReason ?? "",
          /^Machine problem on .+: Missing system library: libnspr4\.so\. Install the package that provides libnspr4\.so\. Then Retry CI\.$/,
        );
        const commands = yield* h.commands;
        assert.isFalse(commands.some((command) => command.type === "board.card.select-step"));
        const actions = ciRecords(yield* h.decided).map((record) => record.payload.action);
        assert.isFalse(actions.some((action) => action.kind === "begin-fix"));
        assert.isFalse(
          actions.some((action) => action.kind === "finish-pass" && action.result === "failed"),
        );
        assert.isTrue(
          commands.some(
            (command) =>
              command.type === "board.card.record-note" &&
              JSON.stringify(command).includes("Machine problem on"),
          ),
        );
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("T3O-61: a code failure's fix agent is told what failed and why first", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner([
      { result: "failed", failedIndex: 1, exitCode: 1, headline: lintHeadline },
    ]);
    const subject = card("code", review);
    yield* withGovernor({ board: boardWith([subject]), settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCiAndRun(h, subject, 1);
        const fixing = yield* live(h, subject.id);
        assert.strictEqual(fixing.ci?.phase, "fixing");
        assert.deepStrictEqual(fixing.ci?.headline, lintHeadline);
        const select = (yield* h.commands).find(
          (command) => command.type === "board.card.select-step",
        );
        if (select?.type !== "board.card.select-step") return assert.fail("no fix step");
        assert.include(
          select.prompt,
          "What failed: Test → lint: No files matching the pattern (log line 7)",
        );
        assert.isBelow(
          select.prompt.indexOf("What failed:"),
          select.prompt.indexOf("The last lines of its output:"),
        );
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("a failure gets a fix agent; its fix re-runs every step from the top", () =>
  Effect.gen(function* () {
    const { runner, calls, requests } = yield* scriptedRunner([
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
        assert.strictEqual(select.stepLabel, "CI fix 1 of 3");
        assert.strictEqual(fixing.ci?.fixIssues, 1);
        // Stop on failure is Yes by default: the runner is told nothing.
        assert.isUndefined((yield* requests)[0]?.stopOnFailure);
        assert.isUndefined(fixing.ci?.continueOnFailure);
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

it.effect("a fix agent's cannot-fix stops the card for a human, never back to review", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner([{ result: "failed", failedIndex: 0 }]);
    const subject = card("back", review);
    yield* withGovernor({ board: boardWith([subject]), settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCiAndRun(h, subject, 1);
        const runId = (yield* live(h, subject.id)).ci!.runId;
        yield* h.pumpDomain(
          fixCompleted(
            subject.id,
            boardCiFixStepId(1, 1),
            {
              verdict: "cannot-fix",
              finding: "The migration needs a database this worktree doesn't have.",
              issues: [{ id: "s0", status: "cannot-fix" }],
            },
            2,
          ),
        );
        const stopped = yield* live(h, subject.id);
        assert.strictEqual(stopped.stage, ci);
        assert.strictEqual(stopped.ci?.phase, "stopped");
        assert.strictEqual(
          stopped.ci?.stopReason,
          "The fix agent couldn't fix Lint: The migration needs a database this worktree doesn't have.",
        );
        assert.isNull(stopped.ciLastOutcome);
        const stop = ciRecords(yield* h.decided).at(-1)!;
        assert.strictEqual(stop.payload.activity?.kind, "card-ci-stopped");
        const settledStop = stop.payload.settled.find((entry) => entry.runId === runId);
        assert.strictEqual(settledStop?.outcome, "stopped");
        assert.isDefined(settledStop?.fixThreadId);
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);
it.effect("with no fixes allowed, a failure stops for a human and runs no agent", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner([{ result: "failed", failedIndex: 1 }]);
    const subject = card("capped", review);
    const board = boardWith([subject], ciConfig({ maxFixAttempts: 0 }));
    yield* withGovernor({ board, settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCiAndRun(h, subject, 1);
        const stopped = yield* live(h, subject.id);
        assert.strictEqual(stopped.stage, ci);
        assert.strictEqual(stopped.ci?.phase, "stopped");
        assert.strictEqual(stopped.ci?.stopReason, "CI failed: Test.");
        assert.isNull(stopped.ciLastOutcome);
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
        // The pass fiber is stopped; the move's own decision
        // settles the row (ciProjection.test.ts).
        yield* h.reactor.drainCi;
        assert.isNull((yield* live(h, subject.id)).ci);
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("a queued pass starts when an agent step frees its worker's room (T3O-86)", () =>
  Effect.gen(function* () {
    const { runner, calls } = yield* scriptedRunner([{ result: "passed", failedIndex: null }]);
    const blocker = buildingCard("blocker", "b");
    const subject = card("waiting", review);
    const oneSlot = settingsWith({ building: [codexStep], globalMaxConcurrent: 1 });
    yield* withGovernor(
      { board: boardWith([blocker, subject]), settings: oneSlot, capacityFor: 1 },
      (h) =>
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

it.effect("CI that must re-create its worktree waits for room, then starts by itself", () =>
  Effect.gen(function* () {
    const { runner, calls } = yield* scriptedRunner([{ result: "passed", failedIndex: null }]);
    const subject = card("recut", review, {
      worktree: { ...readyWorktree("recut"), path: null, status: "reclaimed" },
    });
    const capacity = yield* makeFakeCapacity(roomForCards(1));
    // Another board holds every core on the worker.
    capacity.external.set(BOARD_LOCAL_WORKER_ID, { cpuCores: 3, ramGiB: 0, diskGB: 0 });
    yield* withGovernor({ board: boardWith([subject]), settings, capacity }, (h) =>
      Effect.gen(function* () {
        yield* enterCiAndRun(h, subject, 1);
        assert.strictEqual(yield* calls, 0);
        const notes = (yield* h.commands).filter(
          (command) => command.type === "board.card.record-note",
        );
        assert.lengthOf(notes, 1);
        assert.include(JSON.stringify(notes[0]), "waiting for room");
        // CI's own retry waits for it: no hold that the refresh would drop and CI take again.
        assert.deepStrictEqual(capacity.holds, []);
        capacity.external.delete(BOARD_LOCAL_WORKER_ID);
        yield* capacity.publish(BOARD_LOCAL_WORKER_ID);
        // The snapshot's pass runs after up to 2 s of jitter.
        yield* TestClock.adjust(2_000);
        yield* h.reactor.drain;
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

it.effect("archiving a card in CI stops its pass and settles the row", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner(["hang"]);
    const subject = card("archived-in-ci", review);
    yield* withGovernor({ board: boardWith([subject]), settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCi(h, subject, 1);
        const runId = (yield* live(h, subject.id)).ci!.runId;
        const archived = { ...(yield* live(h, subject.id)), archivedAt: NOW };
        yield* setCard(h, subject.id, archived);
        yield* h.pumpDomain(cardArchived(archived, 2));
        yield* h.reactor.drainCi;
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
    yield* withGovernor(
      { board: boardWith([blocker, subject]), settings: oneSlot, capacityFor: 1 },
      (h) =>
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

it.effect("deleting a card in CI stops its pass", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner(["hang"]);
    const subject = card("deleted-in-ci", review);
    yield* withGovernor({ board: boardWith([subject]), settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCi(h, subject, 1);
        const doomed = yield* live(h, subject.id);
        yield* setCard(h, subject.id, null);
        yield* h.pumpDomain(cardDeleted(doomed, 2, null));
        yield* h.reactor.drainCi;
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

it.effect("after the last fix attempt the card stops in CI, and Retry CI starts afresh", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner([
      { result: "failed", failedIndex: 1 },
      { result: "failed", failedIndex: 1 },
      { result: "passed", failedIndex: null },
    ]);
    const subject = card("limit", review);
    const board = boardWith([subject], ciConfig({ maxFixAttempts: 1 }));
    yield* withGovernor({ board, settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCiAndRun(h, subject, 1);
        assert.strictEqual((yield* live(h, subject.id)).ci?.phase, "fixing");
        yield* h.pumpDomain(
          fixCompleted(subject.id, boardCiFixStepId(1, 1), { verdict: "fixed", finding: "" }, 2),
        );
        yield* h.reactor.drainCi;
        const stopped = yield* live(h, subject.id);
        assert.strictEqual(stopped.stage, ci);
        assert.strictEqual(stopped.ci?.phase, "stopped");
        assert.strictEqual(stopped.ci?.stopReason, "CI still failing after 1 fix: Test.");
        const sentBack = ciRecords(yield* h.decided).filter(
          (record) => record.payload.action.kind === "send-back",
        );
        assert.lengthOf(sentBack, 0);

        // Retry CI starts afresh, with new fix attempts, and this time it passes.
        assert.deepStrictEqual(yield* h.reactor.retryCi(subject.id), { outcome: "retried" });
        yield* h.reactor.drainCi;
        assert.strictEqual(cardStage(yield* h.board, subject.id), merge);
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);
it.effect(
  "send back to review anyway names every failed step and starts the round trips again",
  () =>
    Effect.gen(function* () {
      const { runner } = yield* scriptedRunner([
        { result: "failed", failedIndex: 0, alsoFailed: [1] },
      ]);
      const subject = { ...card("anyway", review), ciRoundTrips: 2 };
      const board = boardWith(
        [subject],
        withBoardProjectConfigVersion({
          ...ciConfig({ maxFixAttempts: 0 }),
          ci: { ...ciConfig().ci, stopOnFailure: false },
        }),
      );
      yield* withGovernor({ board, settings }, (h) =>
        Effect.gen(function* () {
          yield* enterCiAndRun(h, subject, 1);
          const stopped = yield* live(h, subject.id);
          assert.strictEqual(stopped.ci?.phase, "stopped");
          assert.strictEqual(stopped.ci?.stopReason, "CI failed: Lint, Test.");
          assert.deepStrictEqual(yield* h.reactor.ciSendBack(subject.id), { outcome: "sent-back" });
          const sent = yield* live(h, subject.id);
          assert.strictEqual(sent.stage, review);
          assert.strictEqual(sent.ciRoundTrips, 0);
          assert.strictEqual(sent.ciLastOutcome?.kind, "sent-back");
          const finding = sent.ciLastOutcome?.finding ?? "";
          assert.isTrue(finding.startsWith("CI failed at Lint, Test."));
          assert.include(finding, 'CI step "Test" (`vp test`) exited with code 1.');
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

it.effect("a later segment that must re-create its worktree waits for room, not for a human", () =>
  Effect.gen(function* () {
    const { runner, calls } = yield* scriptedRunner([
      { result: "passed", failedIndex: null },
      { result: "passed", failedIndex: null },
    ]);
    const subject = card("agent-recut", review);
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
    const capacity = yield* makeFakeCapacity(roomForCards(1));
    yield* withGovernor({ board, settings, capacity }, (h) =>
      Effect.gen(function* () {
        yield* enterCiAndRun(h, subject, 1);
        const stepId = boardCiAgentStepId((yield* live(h, subject.id)).ci!.runId, 1);
        // The worktree is reclaimed while the agent step runs, and another board fills the worker.
        yield* Ref.update(h.model, (model) => ({
          ...model,
          board: {
            ...model.board!,
            cards: model.board!.cards.map((existing) =>
              existing.id === subject.id
                ? {
                    ...existing,
                    worktree: { ...existing.worktree!, path: null, status: "reclaimed" as const },
                  }
                : existing,
            ),
          },
        }));
        capacity.external.set(BOARD_LOCAL_WORKER_ID, { cpuCores: 3, ramGiB: 0, diskGB: 0 });
        yield* h.pumpDomain(
          fixCompleted(subject.id, stepId, { verdict: "passed", summary: "ok" }, 2),
        );
        yield* h.reactor.drainCi;
        assert.strictEqual(yield* calls, 1);
        // The orphan sweep holds a pass on its second sighting; a wait for room is not one.
        yield* h.reactor.sweep;
        yield* h.reactor.sweep;
        assert.notStrictEqual((yield* live(h, subject.id)).ci?.phase, "held");

        capacity.external.delete(BOARD_LOCAL_WORKER_ID);
        yield* capacity.publish(BOARD_LOCAL_WORKER_ID);
        yield* TestClock.adjust(2_000);
        yield* h.reactor.drain;
        yield* h.reactor.drainCi;
        assert.strictEqual(yield* calls, 2);
        assert.strictEqual(cardStage(yield* h.board, subject.id), merge);
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

it.effect("with the pass record unreadable, the fix's issues still name the step that failed", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner([{ result: "passed", failedIndex: null }]);
    const subject = card("agent-lost", review);
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
    yield* withGovernor({ board, settings, ciPassesUnreadable: true }, (h) =>
      Effect.gen(function* () {
        yield* enterCiAndRun(h, subject, 1);
        const stepId = boardCiAgentStepId((yield* live(h, subject.id)).ci!.runId, 1);
        yield* h.pumpDomain(
          fixCompleted(
            subject.id,
            stepId,
            { verdict: "failed", summary: "Bad", failures: [{ title: "Irreversible" }] },
            2,
          ),
        );
        const fix = (yield* h.commands).find(
          (command) =>
            command.type === "board.card.select-step" &&
            (command as { stepId: string }).stepId.startsWith("ci-fix@"),
        ) as { prompt: string; stepId: string } | undefined;
        assert.isDefined(fix);
        assert.include(fix!.prompt, "[s1-1] Audit: Irreversible");
        yield* h.pumpDomain(
          fixCompleted(
            subject.id,
            fix!.stepId,
            { verdict: "cannot-fix", issues: [{ id: "s1-1", status: "cannot-fix" }] },
            3,
          ),
        );
        assert.strictEqual(
          (yield* live(h, subject.id)).ci?.stopReason,
          "The fix agent couldn't fix Audit.",
        );
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
            overrides: { ci: { maxFixAttempts: 0 } },
          }),
        ),
        settings,
        pullRequest: foundPr,
        mergeState: mergeStateWith({ passed: 1, pending: 0, failed: 1 }),
      },
      (h) =>
        Effect.gen(function* () {
          yield* enterCiAndRun(h, failing, 1);
          const stopped = yield* live(h, failing.id);
          assert.strictEqual(stopped.stage, ci);
          assert.strictEqual(stopped.ci?.phase, "stopped");
          assert.strictEqual(stopped.ci?.stopReason, "CI failed: GitHub checks.");
          assert.strictEqual(stopped.ci?.steps[1]?.status, "failed");
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

const noStopConfig = (steps: ReadonlyArray<BoardCiStep>) =>
  withBoardProjectConfigVersion({ ...ciConfig(), ci: { steps, stopOnFailure: false } });

it.effect(
  "Stop on failure No: script, agent and script all run after failures, then one fix gets every issue",
  () =>
    Effect.gen(function* () {
      const { runner, calls, requests } = yield* scriptedRunner([
        { result: "failed", failedIndex: 0 },
        { result: "passed", failedIndex: null },
      ]);
      const subject = card("no-stop", review);
      const agentStep: BoardCiStep = {
        kind: "agent",
        id: "audit",
        name: "Audit",
        parallel: false,
        prompt: "Audit it.",
        model: null,
        timeoutMinutes: 30,
      };
      const board = boardWith([subject], noStopConfig([SCRIPT_A, agentStep, SCRIPT_B]));
      yield* withGovernor({ board, settings }, (h) =>
        Effect.gen(function* () {
          yield* enterCiAndRun(h, subject, 1);
          assert.strictEqual((yield* requests)[0]?.stopOnFailure, false);
          const running = yield* live(h, subject.id);
          assert.isTrue(running.ci?.continueOnFailure);
          assert.strictEqual(running.ci?.phase, "running");
          assert.deepStrictEqual(
            running.ci?.steps.map((step) => step.status),
            ["failed", "running", "pending"],
          );
          // A flip mid-pass applies from the next pass, not this one.
          yield* Ref.update(h.model, (model) => ({
            ...model,
            board: {
              ...model.board!,
              projectStageConfigs: {
                ...model.board!.projectStageConfigs,
                [projectId]: withBoardProjectConfigVersion({
                  ...ciConfig(),
                  ci: { steps: [SCRIPT_A, agentStep, SCRIPT_B] },
                }),
              },
            },
          }));
          yield* h.pumpDomain(
            fixCompleted(
              subject.id,
              boardCiAgentStepId(running.ci!.runId, 1),
              {
                verdict: "failed",
                summary: "One migration drops a column",
                failures: [{ title: "Irreversible", file: "db/007.sql", line: 3 }],
              },
              2,
            ),
          );
          yield* h.reactor.drainCi;
          assert.strictEqual(yield* calls, 2);
          const fixing = yield* live(h, subject.id);
          assert.deepStrictEqual(
            fixing.ci?.steps.map((step) => step.status),
            ["failed", "failed", "passed"],
          );
          assert.strictEqual(fixing.ci?.phase, "fixing");
          assert.strictEqual(fixing.ci?.fixIssues, 2);
          const passed = ciRecords(yield* h.decided).some(
            (record) =>
              record.payload.action.kind === "finish-pass" &&
              record.payload.action.result === "passed",
          );
          assert.isFalse(passed);
          const fixes = (yield* h.commands).filter(
            (command) =>
              command.type === "board.card.select-step" &&
              (command as { stepId: string }).stepId.startsWith("ci-fix@"),
          ) as unknown as ReadonlyArray<{ prompt: string }>;
          assert.lengthOf(fixes, 1);
          assert.include(fixes[0]!.prompt, '2 CI steps failed: "Lint", "Audit".');
          assert.include(fixes[0]!.prompt, "[s0] Lint: Lint failed");
          assert.include(fixes[0]!.prompt, "[s1-1] Audit: Irreversible (db/007.sql:3)");
        }),
      ).pipe(Effect.provideService(BoardCiRunner, runner));
    }),
);

it.effect("Stop on failure No, from an older worker that stopped early: the pass fails there", () =>
  Effect.gen(function* () {
    const { runner, calls } = yield* scriptedRunner([
      { result: "failed", failedIndex: 0, ranAll: false },
    ]);
    const subject = card("old-worker", review);
    const board = boardWith([subject], noStopConfig(mixedConfig([SCRIPT_A, SCRIPT_B]).ci.steps));
    yield* withGovernor({ board, settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCiAndRun(h, subject, 1);
        assert.strictEqual(yield* calls, 1);
        const fixing = yield* live(h, subject.id);
        assert.strictEqual(fixing.ci?.phase, "fixing");
        assert.deepStrictEqual(
          fixing.ci?.steps.map((step) => step.status),
          ["failed", "pending"],
        );
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("a pass whose record can't be read is held, never passed", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner([{ result: "passed", failedIndex: null }]);
    const subject = card("lost", review);
    yield* withGovernor({ board: boardWith([subject]), settings, ciPassesUnreadable: true }, (h) =>
      Effect.gen(function* () {
        yield* enterCiAndRun(h, subject, 1);
        assert.strictEqual(cardStage(yield* h.board, subject.id), ci);
        assert.strictEqual((yield* live(h, subject.id)).ci?.phase, "held");
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

// ── A pass never wedges ──────────────────────────────────────────

type RecordCiAction = Extract<HarnessCommand, { type: "board.card.record-ci" }>["action"];

/** Fail the board's CI writes `lost` matches while `full` is set, the way a
    full disk fails the board database's writes. */
const failingWrites = (lost: (action: RecordCiAction) => boolean) => {
  const disk = { full: false };
  const onDispatch = (command: HarnessCommand) =>
    disk.full && command.type === "board.card.record-ci" && lost(command.action)
      ? Effect.die(new Error("SQLITE_FULL: database or disk is full"))
      : Effect.void;
  return { disk, onDispatch };
};

const lastStepAndFinish = (action: RecordCiAction) =>
  action.kind === "finish-pass" || (action.kind === "step" && action.index === 1);

it.effect(
  "T3O-61: a machine hold that can't be saved keeps its reason when the sweep holds it",
  () =>
    Effect.gen(function* () {
      const { runner } = yield* scriptedRunner([
        { result: "failed", failedIndex: 1, exitCode: 127, headline: libraryHeadline },
      ]);
      const subject = card("machine-lost", review);
      const { disk, onDispatch } = failingWrites(lastStepAndFinish);
      yield* withGovernor({ board: boardWith([subject]), settings, onDispatch }, (h) =>
        Effect.gen(function* () {
          disk.full = true;
          yield* enterCiAndRun(h, subject, 1);
          disk.full = false;
          assert.strictEqual((yield* live(h, subject.id)).ci?.phase, "running");
          yield* h.reactor.sweep;
          yield* h.reactor.sweep;
          const held = (yield* live(h, subject.id)).ci;
          assert.strictEqual(held?.phase, "held");
          assert.strictEqual(held?.machine, true);
          assert.deepStrictEqual(held?.headline, libraryHeadline);
          assert.match(held?.stopReason ?? "", /^Machine problem on .+: Missing system library/);
        }),
      ).pipe(Effect.provideService(BoardCiRunner, runner));
    }),
);

it.effect(
  "a result whose record can't be saved is held on the second sweep with its exit code, and Retry CI runs it again",
  () =>
    Effect.gen(function* () {
      const { runner } = yield* scriptedRunner([
        { result: "failed", failedIndex: 1, exitCode: 3 },
        "hang",
      ]);
      const subject = card("lost", review);
      const { disk, onDispatch } = failingWrites(lastStepAndFinish);
      yield* withGovernor({ board: boardWith([subject]), settings, onDispatch }, (h) =>
        Effect.gen(function* () {
          disk.full = true;
          yield* enterCiAndRun(h, subject, 1);
          disk.full = false;
          // The script's end was never recorded: the pass reads as running.
          assert.strictEqual((yield* live(h, subject.id)).ci?.phase, "running");
          assert.isFalse(
            (yield* h.commands).some(
              (command) =>
                command.type === "board.card.select-step" &&
                (command as { stepId: string }).stepId.startsWith("ci-fix@"),
            ),
          );
          yield* h.reactor.sweep;
          assert.strictEqual((yield* live(h, subject.id)).ci?.phase, "running");
          yield* h.reactor.sweep;
          const held = (yield* live(h, subject.id)).ci;
          assert.strictEqual(held?.phase, "held");
          assert.strictEqual(
            held?.stopReason,
            "The CI script ended (exit code 3) but its result couldn't be saved. Retry CI.",
          );
          const lost = held!.runId;
          assert.deepStrictEqual(yield* h.reactor.retryCi(subject.id), { outcome: "retried" });
          const retried = (yield* live(h, subject.id)).ci;
          assert.notStrictEqual(retried?.runId, lost);
          assert.strictEqual(retried?.phase, "queued");
        }),
      ).pipe(Effect.provideService(BoardCiRunner, runner));
    }),
);

it.effect("Retry CI restarts a pass with nothing behind it before the sweep holds it", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner([
      { result: "failed", failedIndex: 1, exitCode: 3 },
      "hang",
    ]);
    const subject = card("lost-retry", review);
    const { disk, onDispatch } = failingWrites(lastStepAndFinish);
    yield* withGovernor({ board: boardWith([subject]), settings, onDispatch }, (h) =>
      Effect.gen(function* () {
        disk.full = true;
        yield* enterCiAndRun(h, subject, 1);
        disk.full = false;
        const stuck = (yield* live(h, subject.id)).ci!.runId;
        assert.deepStrictEqual(yield* h.reactor.retryCi(subject.id), { outcome: "retried" });
        assert.notStrictEqual((yield* live(h, subject.id)).ci?.runId, stuck);
        const settled = ciRecords(yield* h.decided).flatMap((record) => record.payload.settled);
        assert.isTrue(
          settled.some((entry) => entry.runId === stuck && entry.outcome === "interrupted"),
        );
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("Retry CI on a stuck pass that can't start holds that pass with the real reason", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner([{ result: "failed", failedIndex: 1, exitCode: 3 }]);
    const subject = card("lost-no-steps", review);
    const { disk, onDispatch } = failingWrites(lastStepAndFinish);
    yield* withGovernor({ board: boardWith([subject]), settings, onDispatch }, (h) =>
      Effect.gen(function* () {
        disk.full = true;
        yield* enterCiAndRun(h, subject, 1);
        disk.full = false;
        const stuck = (yield* live(h, subject.id)).ci!.runId;
        yield* Ref.update(h.model, (model) => ({
          ...model,
          // The card now sits on a worker this server has no connection to.
          board: {
            ...model.board!,
            cards: model.board!.cards.map((existing) =>
              existing.id === subject.id
                ? { ...existing, placedWorkerId: EnvironmentId.make("env-worker-gone") }
                : existing,
            ),
          },
        }));
        assert.deepStrictEqual(yield* h.reactor.retryCi(subject.id), { outcome: "retried" });
        const held = (yield* live(h, subject.id)).ci;
        assert.strictEqual(held?.runId, stuck);
        assert.strictEqual(held?.phase, "held");
        assert.strictEqual(
          held?.stopReason,
          "CI can't reach the card's worker. Retry CI, or Skip CI.",
        );
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("a pass still running is never held by the sweep", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner(["hang"]);
    const hanging = card("sweep-hang", review);
    yield* withGovernor({ board: boardWith([hanging]), settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCi(h, hanging, 1);
        yield* h.reactor.drain;
        for (let sweep = 0; sweep < 3; sweep++) yield* h.reactor.sweep;
        assert.strictEqual((yield* live(h, hanging.id)).ci?.phase, "queued");
        assert.deepStrictEqual(yield* h.reactor.retryCi(hanging.id), { outcome: "running" });
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("an agent step at work is never held by the sweep", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner([{ result: "passed", failedIndex: null }]);
    const agentCard = card("sweep-agent", review);
    const agentStep: BoardCiStep = {
      kind: "agent",
      id: "audit",
      name: "Audit",
      parallel: false,
      prompt: "Audit it.",
      model: null,
      timeoutMinutes: 30,
    };
    yield* withGovernor(
      { board: boardWith([agentCard], mixedConfig([SCRIPT_A, agentStep])), settings },
      (h) =>
        Effect.gen(function* () {
          yield* enterCiAndRun(h, agentCard, 1);
          assert.isNotNull(stepStatus(yield* h.board, agentCard.id));
          for (let sweep = 0; sweep < 3; sweep++) yield* h.reactor.sweep;
          assert.strictEqual((yield* live(h, agentCard.id)).ci?.phase, "running");
          assert.deepStrictEqual(yield* h.reactor.retryCi(agentCard.id), { outcome: "running" });
        }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("a lost result after an agent step is held: the agent's settled step doesn't count", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner([
      { result: "passed", failedIndex: null },
      { result: "passed", failedIndex: null },
    ]);
    const subject = card("lost-mixed", review);
    const agentStep: BoardCiStep = {
      kind: "agent",
      id: "audit",
      name: "Audit",
      parallel: false,
      prompt: "Audit it.",
      model: null,
      timeoutMinutes: 30,
    };
    const { disk, onDispatch } = failingWrites((action) => action.kind === "finish-pass");
    yield* withGovernor(
      {
        board: boardWith([subject], mixedConfig([SCRIPT_A, agentStep, SCRIPT_B])),
        settings,
        onDispatch,
      },
      (h) =>
        Effect.gen(function* () {
          yield* enterCiAndRun(h, subject, 1);
          const stepId = boardCiAgentStepId((yield* live(h, subject.id)).ci!.runId, 1);
          disk.full = true;
          yield* h.pumpDomain(
            fixCompleted(subject.id, stepId, { verdict: "passed", summary: "ok" }, 2),
          );
          yield* h.reactor.drainCi;
          disk.full = false;
          assert.strictEqual(cardStage(yield* h.board, subject.id), ci);
          assert.strictEqual((yield* live(h, subject.id)).ci?.phase, "running");
          yield* h.reactor.sweep;
          yield* h.reactor.sweep;
          const held = (yield* live(h, subject.id)).ci;
          assert.strictEqual(held?.phase, "held");
          assert.include(held?.stopReason ?? "", "exit code 0");
        }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("a worker connection that closes mid-run holds the pass as unable to run", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner(["drop"]);
    const subject = card("dropped", review);
    yield* withGovernor({ board: boardWith([subject]), settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCiAndRun(h, subject, 1);
        const held = (yield* live(h, subject.id)).ci;
        assert.strictEqual(held?.phase, "held");
        // Its own "Retry CI" isn't repeated.
        assert.strictEqual(held?.stopReason, "The worker connection closed mid-run. Retry CI.");
        assert.isUndefined(held?.machine);
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("Stop CI holds a queued or running pass, and Retry CI runs it again", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner(["hang", "hang"]);
    const subject = card("stop", review);
    yield* withGovernor({ board: boardWith([subject]), settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCi(h, subject, 1);
        yield* h.reactor.drain;
        assert.deepStrictEqual(yield* h.reactor.retryCi(subject.id, "stop"), {
          outcome: "stopped",
        });
        const held = (yield* live(h, subject.id)).ci;
        assert.strictEqual(held?.phase, "held");
        assert.strictEqual(held?.stopReason, "Stopped by you. Retry CI to run it again.");
        assert.strictEqual(yield* h.slots.heldTotal, 0);
        // Nothing left to stop.
        assert.deepStrictEqual(yield* h.reactor.retryCi(subject.id, "stop"), {
          outcome: "not-running",
        });
        assert.deepStrictEqual(yield* h.reactor.retryCi(subject.id), { outcome: "retried" });
        const retried = (yield* live(h, subject.id)).ci;
        assert.notStrictEqual(retried?.runId, held?.runId);
        assert.strictEqual(retried?.phase, "queued");
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect.each(["failed", "passed"] as const)(
  "Stop CI landing as a %s result is recorded wins: the card stays held in CI",
  (result) =>
    Effect.gen(function* () {
      const { runner } = yield* scriptedRunner([
        result === "failed"
          ? { result: "failed", failedIndex: 1, exitCode: 1 }
          : { result: "passed", failedIndex: null },
      ]);
      const subject = card(`stop-race-${result}`, review);
      // The stop lands after the result handler's liveness read, just before
      // its record.
      const stopper: { stop: Effect.Effect<unknown> | null } = { stop: null };
      const onDispatch = (command: HarnessCommand) => {
        const stop = stopper.stop;
        if (
          stop === null ||
          command.type !== "board.card.record-ci" ||
          command.action.kind !== "finish-pass" ||
          command.action.result !== result
        ) {
          return Effect.void;
        }
        stopper.stop = null;
        return Effect.asVoid(stop);
      };
      yield* withGovernor(
        { board: boardWith([subject], ciConfig({ maxFixAttempts: 0 })), settings, onDispatch },
        (h) =>
          Effect.gen(function* () {
            stopper.stop = h.reactor.retryCi(subject.id, "stop");
            yield* enterCiAndRun(h, subject, 1);
            const held = yield* live(h, subject.id);
            assert.strictEqual(held.stage, ci);
            assert.strictEqual(held.ci?.phase, "held");
            assert.strictEqual(held.ci?.stopReason, "Stopped by you. Retry CI to run it again.");
          }),
      ).pipe(Effect.provideService(BoardCiRunner, runner));
    }),
);

it.effect("Stop CI landing as a fix begins wins: no fix agent starts on the held pass", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner([{ result: "failed", failedIndex: 1, exitCode: 1 }]);
    const subject = card("stop-begin-fix", review);
    // The stop lands after begin-fix, just before the fix step is selected.
    const stopper: { stop: Effect.Effect<unknown> | null } = { stop: null };
    const onDispatch = (command: HarnessCommand) => {
      const stop = stopper.stop;
      if (stop === null || command.type !== "board.card.select-step") return Effect.void;
      stopper.stop = null;
      return Effect.asVoid(stop);
    };
    yield* withGovernor({ board: boardWith([subject]), settings, onDispatch }, (h) =>
      Effect.gen(function* () {
        stopper.stop = h.reactor.retryCi(subject.id, "stop");
        yield* enterCiAndRun(h, subject, 1);
        const held = yield* live(h, subject.id);
        assert.strictEqual(held.stage, ci);
        assert.strictEqual(held.ci?.phase, "held");
        assert.strictEqual(stepStatus(yield* h.board, subject.id), null);
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("Stop CI landing as a segment starts holds the pass and cancels the segment", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const holdReached = yield* Deferred.make<void>();
    const runner: BoardCiRunnerShape = {
      run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    };
    const subject = card("stop-segment-race", review);
    const stateDir = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-ci-stop-race-")),
    );
    // The stop's cancel runs during the segment's disk check, before its
    // liveness re-read; its hold lands only once the segment has started.
    const race: { stop: Effect.Effect<unknown> | null; fiber: Fiber.Fiber<unknown> | null } = {
      stop: null,
      fiber: null,
    };
    const onDispatch = (command: HarnessCommand) =>
      command.type === "board.card.record-ci" &&
      command.action.kind === "finish-pass" &&
      command.action.result === "interrupted"
        ? Deferred.succeed(holdReached, undefined).pipe(Effect.andThen(Deferred.await(started)))
        : Effect.void;
    const freeBytes = () =>
      Effect.gen(function* () {
        const stop = race.stop;
        if (stop !== null) {
          race.stop = null;
          race.fiber = yield* Effect.forkDetach(stop);
          yield* Deferred.await(holdReached);
        }
        return 100 * 1024 ** 3;
      });
    yield* withGovernor(
      {
        board: boardWith([subject]),
        settings,
        onDispatch,
        serverConfig: layerTest(process.cwd(), stateDir).pipe(
          Layer.provide(NodeServices.layer),
          Layer.orDie,
        ),
      },
      (h) =>
        Effect.gen(function* () {
          race.stop = h.reactor.retryCi(subject.id, "stop");
          yield* enterCi(h, subject, 1);
          yield* h.reactor.drain;
          assert.deepStrictEqual(yield* Fiber.join(race.fiber!), { outcome: "stopped" });
          assert.strictEqual((yield* live(h, subject.id)).ci?.phase, "held");
          // Nothing still runs on the held pass, so its slot is free.
          assert.strictEqual(yield* h.slots.heldTotal, 0);
          yield* h.reactor.drainCi;
        }),
    ).pipe(
      Effect.provideService(BoardCiRunner, runner),
      Effect.provideService(BoardDiskSpace, { freeBytes }),
    );
  }),
);

it.effect("Stop CI while a fix agent works abandons its step and holds the pass", () =>
  Effect.gen(function* () {
    const { runner } = yield* scriptedRunner([{ result: "failed", failedIndex: 1, exitCode: 1 }]);
    const subject = card("stop-fix", review);
    yield* withGovernor({ board: boardWith([subject]), settings }, (h) =>
      Effect.gen(function* () {
        yield* enterCiAndRun(h, subject, 1);
        assert.strictEqual((yield* live(h, subject.id)).ci?.phase, "fixing");
        assert.deepStrictEqual(yield* h.reactor.retryCi(subject.id, "stop"), {
          outcome: "stopped",
        });
        yield* h.reactor.drain;
        assert.strictEqual(stepStatus(yield* h.board, subject.id), "abandoned");
        const held = (yield* live(h, subject.id)).ci;
        assert.strictEqual(held?.phase, "held");
        assert.strictEqual(held?.stopReason, "Stopped by you. Retry CI to run it again.");
        assert.strictEqual(cardStage(yield* h.board, subject.id), ci);
      }),
    ).pipe(Effect.provideService(BoardCiRunner, runner));
  }),
);

it.effect("a nearly full disk on this server holds the pass as a machine problem", () =>
  Effect.gen(function* () {
    const { runner, calls } = yield* scriptedRunner([{ result: "passed", failedIndex: null }]);
    const subject = card("full-disk", review);
    const stateDir = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-ci-disk-")),
    );
    const checked: string[] = [];
    yield* withGovernor(
      {
        board: boardWith([subject]),
        settings,
        serverConfig: layerTest(process.cwd(), stateDir).pipe(
          Layer.provide(NodeServices.layer),
          Layer.orDie,
        ),
      },
      (h) =>
        Effect.gen(function* () {
          yield* enterCiAndRun(h, subject, 1);
          assert.strictEqual(yield* calls, 0);
          const held = (yield* live(h, subject.id)).ci;
          assert.strictEqual(held?.phase, "held");
          assert.strictEqual(held?.machine, true);
          assert.match(held?.stopReason ?? "", /^Disk nearly full on .+: 0\.5 GiB free\. Retry CI/);
          assert.isTrue(checked.every((path) => path.startsWith(stateDir)));
          assert.isAbove(checked.length, 0);
        }),
    ).pipe(
      Effect.provideService(BoardCiRunner, runner),
      Effect.provideService(BoardDiskSpace, {
        freeBytes: (path) => Effect.sync(() => (checked.push(path), 0.5 * 1024 ** 3)),
      }),
    );
  }),
);
