/**
 * The board's side of measured actuals (T3O-87): rows keep the worker and the profile granted
 * then, a provider without a scope of its own reads not measured, a lost key leaves the row
 * partial, and an ended CI pass recomputes its project's learned baseline.
 */
import {
  BoardCardId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardCardStepState,
  type BoardCommand,
  type BoardState,
  type BoardStepReading,
  type BoardWorkerActualsInput,
  type CommandId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { attachBoardDatabase } from "../boardDatabase.ts";
import Migration075 from "../migrations/075_BoardCardActuals.ts";
import { buildingCard } from "../supervisorHarness.testkit.ts";
import { makeBoardActualsRecorder } from "./BoardActualsRecorder.ts";
import { listCardActualsRows } from "./boardActualsStore.ts";

const GiB = 1024 ** 3;
const W1 = EnvironmentId.make("env-w1");
const NOW = "2026-11-13T00:00:00.000Z";

const reading = (overrides: Partial<BoardStepReading> = {}): BoardStepReading => ({
  measured: true,
  reason: null,
  running: true,
  partial: false,
  cpuCoreSeconds: 30,
  peakCpuCores: 3,
  peakRamBytes: 6 * GiB,
  ioReadBytes: 0,
  ioWriteBytes: 0,
  diskBytes: null,
  samples: 4,
  ...overrides,
});

const card = (id: string, overrides: Partial<BoardCard> = {}): BoardCard => ({
  ...buildingCard(id, id),
  placedWorkerId: W1,
  resources: {
    sizing: null,
    grant: {
      profile: { cpuCores: 2, ramGiB: 4, diskGB: 5 },
      heavy: true,
      claimId: null,
      grantedAt: NOW,
      settled: false,
    },
    setup: null,
  },
  ...overrides,
});

const step = (cardId: string, provider: string, threadId: string): BoardCardStepState => ({
  cardId: BoardCardId.make(cardId),
  stepId: "building",
  stepLabel: null,
  stageLabel: "Building",
  attempt: 1,
  stallCount: 0,
  stageEntryRecoveries: 0,
  humanTurnAt: null,
  lastNudgeAt: null,
  baseTipAtRoundStart: null,
  lastError: null,
  awaitingReason: "question",
  stalledReason: "gave-up",
  retryAt: null,
  prompt: "build it",
  providerInstanceId: ProviderInstanceId.make(provider),
  model: "model",
  mode: "build",
  runtimeMode: "full-access",
  humanInLoop: false,
  maxAttempts: 3,
  timeoutMs: 60_000,
  threadId: ThreadId.make(threadId),
  status: "running",
  slotHeld: false,
  forceStart: false,
  queuedBy: null,
  queuedDetail: null,
  startedAt: NOW,
  updatedAt: NOW,
});

const harness = (initial: BoardState) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* attachBoardDatabase();
    yield* Migration075;
    const state = { board: initial, now: NOW };
    const calls: Array<{ readonly workerId: string; readonly input: BoardWorkerActualsInput }> = [];
    const answers = new Map<string, BoardStepReading | null | "unreachable">();
    const commands: Array<BoardCommand> = [];
    const recorder = makeBoardActualsRecorder({
      sql,
      readBoard: Effect.sync(() => state.board),
      dispatch: (command) => Effect.sync(() => void commands.push(command)),
      commandId: (tag) => Effect.succeed(`cmd-${tag}` as CommandId),
      nowIso: Effect.sync(() => state.now),
      relay: (workerId, input) =>
        Effect.sync(() => {
          calls.push({ workerId, input });
          return answers.has(`${input.op}:${input.key}`)
            ? answers.get(`${input.op}:${input.key}`)!
            : null;
        }),
      readyWorkers: () => Effect.succeed([{ cpuCores: 32, ramGiB: 64, diskGB: 500 }]),
      publish: () => Effect.void,
    });
    return { sql, state, calls, answers, commands, recorder };
  });

it.effect("each row keeps its worker and granted profile; Codex reads not measured", () =>
  Effect.gen(function* () {
    const h = yield* harness({
      cards: [card("claude-card"), card("codex-card")],
      nextCardNumberByProject: {},
      stepStates: [
        step("claude-card", "claudeAgent", "t-claude"),
        step("codex-card", "codex", "t-codex"),
      ],
    });
    h.answers.set("read:thread:t-claude", reading());
    yield* h.recorder.sweep();

    const [claude] = yield* listCardActualsRows(h.sql, BoardCardId.make("claude-card"));
    assert.include(claude, { workerId: W1, kind: "agent", endedAt: null });
    assert.deepStrictEqual(claude?.grantedProfile, { cpuCores: 2, ramGiB: 4, diskGB: 5 });
    const [codex] = yield* listCardActualsRows(h.sql, BoardCardId.make("codex-card"));
    assert.include(codex?.reading, { measured: false });
    assert.match(codex?.reading.reason ?? "", /shared scope/);
    // Codex is never asked: its reason is the board's own.
    assert.deepStrictEqual(
      h.calls.map((call) => call.input.key),
      ["thread:t-claude"],
    );

    // Re-placed and re-granted while running: the row still names the first worker and grant.
    h.state.board = {
      ...h.state.board,
      cards: h.state.board.cards.map((current) =>
        current.id === "claude-card"
          ? { ...current, placedWorkerId: EnvironmentId.make("env-w2") }
          : current,
      ),
    };
    // The step stopped, and the worker lost the key (a restart): the stored figures, partial.
    h.state.board = { ...h.state.board, stepStates: [] };
    h.state.now = "2026-11-13T00:10:00.000Z";
    yield* h.recorder.sweep();
    const [ended] = yield* listCardActualsRows(h.sql, BoardCardId.make("claude-card"));
    assert.include(ended, { workerId: W1, endedAt: "2026-11-13T00:10:00.000Z" });
    assert.include(ended?.reading, { running: false, partial: true, cpuCoreSeconds: 30 });
    assert.include(h.calls.at(-1)?.input, { op: "end", key: "thread:t-claude", seen: true });
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("an ended CI pass recomputes its project's learned baseline", () =>
  Effect.gen(function* () {
    const ids = ["c1", "c2", "c3", "c4", "c5"];
    const ci = (id: string, phase: "running" | "passed") =>
      ({
        runId: `run-${id}`,
        entry: 1,
        fixAttempts: 0,
        maxFixAttempts: 2,
        phase,
        steps: [],
      }) as unknown as BoardCard["ci"];
    const h = yield* harness({
      cards: ids.map((id) => card(id, { ci: ci(id, "running") })),
      nextCardNumberByProject: {},
      stepStates: [],
    });
    for (const [index, id] of ids.entries()) {
      h.answers.set(`read:ci:run-${id}`, reading({ peakCpuCores: index + 1 }));
      h.answers.set(
        `end:ci:run-${id}`,
        reading({ running: false, peakCpuCores: index + 1, diskBytes: 3 * 1000 ** 3 }),
      );
    }
    yield* h.recorder.sweep();
    assert.lengthOf(h.commands, 0);
    h.state.board = {
      ...h.state.board,
      cards: h.state.board.cards.map((current) => ({ ...current, ci: ci(current.id, "passed") })),
    };
    h.state.now = "2026-11-13T00:10:00.000Z";
    yield* h.recorder.sweep();
    const recorded = h.commands.find((command) => command.type === "board.project.record-learned");
    assert.ok(recorded !== undefined && recorded.type === "board.project.record-learned");
    // Five cards of 1–5 cores: the 90th percentile is 5; 6 GiB peaks round up to 6.
    assert.include(recorded.learned.cpu, { value: 5, samples: 5 });
    assert.include(recorded.learned.ram, { value: 6 });
    assert.include(recorded.learned.disk, { value: 3 });
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("a not-measured row is written once; a running one not yet measured stays open", () =>
  Effect.gen(function* () {
    const h = yield* harness({
      cards: [card("claude-card"), card("codex-card")],
      nextCardNumberByProject: {},
      stepStates: [
        step("claude-card", "claudeAgent", "t-claude"),
        step("codex-card", "codex", "t-codex"),
      ],
    });
    // The thread has no scope yet: the worker's meter keeps looking.
    h.answers.set(
      "read:thread:t-claude",
      reading({ measured: false, reason: "no scope yet", cpuCoreSeconds: null, samples: 0 }),
    );
    yield* h.recorder.sweep();
    h.state.now = "2026-11-13T00:05:00.000Z";
    yield* h.recorder.sweep();
    const [codex] = yield* listCardActualsRows(h.sql, BoardCardId.make("codex-card"));
    assert.strictEqual(codex?.updatedAt, NOW);
    const [claude] = yield* listCardActualsRows(h.sql, BoardCardId.make("claude-card"));
    assert.ok(claude !== undefined);
    assert.isNull(claude.endedAt);
    // The step ends: its meter entry is ended on the worker, not left behind.
    h.state.board = { ...h.state.board, stepStates: [] };
    yield* h.recorder.sweep();
    assert.include(h.calls.at(-1)?.input, { op: "end", key: "thread:t-claude" });
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

// A pause ends the row and its meter entry; the resumed run starts its figures from 0.
it.effect("a resumed agent step keeps the figures of its run before the pause", () =>
  Effect.gen(function* () {
    const running = step("claude-card", "claudeAgent", "t-claude");
    const h = yield* harness({
      cards: [card("claude-card")],
      nextCardNumberByProject: {},
      stepStates: [running],
    });
    h.answers.set("read:thread:t-claude", reading({ peakRamBytes: 9 * GiB }));
    h.answers.set("end:thread:t-claude", reading({ running: false, peakRamBytes: 9 * GiB }));
    yield* h.recorder.sweep();
    h.state.board = { ...h.state.board, stepStates: [{ ...running, status: "paused" }] };
    yield* h.recorder.sweep();
    h.answers.set("read:thread:t-claude", reading({ peakRamBytes: 2 * GiB }));
    h.state.board = { ...h.state.board, stepStates: [running] };
    h.state.now = "2026-11-13T00:05:00.000Z";
    yield* h.recorder.sweep();
    yield* h.recorder.sweep();
    const rows = yield* listCardActualsRows(h.sql, BoardCardId.make("claude-card"));
    assert.deepStrictEqual(
      rows.map((row) => [row.stepKey, row.reading.peakRamBytes, row.endedAt === null]),
      [
        ["thread:t-claude", 9 * GiB, false],
        ["thread:t-claude#2", 2 * GiB, true],
      ],
    );
    // The resumed run is read and ended under the thread's own key on its worker.
    h.state.board = { ...h.state.board, stepStates: [] };
    yield* h.recorder.sweep();
    assert.include(h.calls.at(-1)?.input, {
      op: "end",
      key: "thread:t-claude",
      threadId: "t-claude",
    });
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("a retried setup is measured apart, and ending the first run leaves the retry's", () =>
  Effect.gen(function* () {
    const setupAt = (startedAt: string) =>
      card("c", {
        worktree: {
          path: "/w/c",
          branch: "board/c",
          status: "ready",
        } as BoardCard["worktree"],
        resources: {
          ...card("c").resources!,
          setup: { status: "running", startedAt, workerId: W1 } as never,
        },
      });
    const first = "2026-11-13T00:00:00.000Z";
    const retry = "2026-11-13T00:01:00.000Z";
    const h = yield* harness({
      cards: [setupAt(first)],
      nextCardNumberByProject: {},
      stepStates: [],
    });
    h.answers.set(`read:setup:/w/c@${first}`, reading());
    yield* h.recorder.sweep();
    h.state.board = { ...h.state.board, cards: [setupAt(retry)] };
    h.answers.set(`read:setup:/w/c@${retry}`, reading());
    yield* h.recorder.sweep();
    const keys = h.calls.map((call) => `${call.input.op}:${call.input.key}`);
    assert.deepStrictEqual(keys, [
      `read:setup:/w/c@${first}`,
      `read:setup:/w/c@${retry}`,
      `end:setup:/w/c@${first}`,
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
