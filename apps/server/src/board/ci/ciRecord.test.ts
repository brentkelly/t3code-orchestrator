/**
 * T3O-59 — the CI record decider: a held pass keeps why (and whether the
 * machine was to blame), and a late report from a held or stopped pass can't
 * move the card's steps or start a fix.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardRecordCiCommand,
  boardCiStepsFromLegacy,
  CommandId,
  ThreadId,
  type BoardCard,
  type BoardCardCi,
  type BoardCiHeadline,
  type BoardCiPassStep,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { makeBoardCard, NOW } from "../supervisorHarness.testkit.ts";
import { decideBoardCiRecord } from "./ciRecord.ts";

const decodeRecordCiCommand = Schema.decodeSync(BoardCardRecordCiCommand);

const ci = (phase: BoardCardCi["phase"]): BoardCardCi => ({
  runId: "run-1",
  entry: 1,
  fixAttempts: 0,
  maxFixAttempts: 2,
  phase,
  steps: [
    { name: "Lint", status: "passed", startedAt: NOW, finishedAt: NOW },
    { name: "Test", status: "running", startedAt: NOW, finishedAt: null },
  ],
});

const inCi = (phase: BoardCardCi["phase"]): BoardCard => ({
  ...makeBoardCard({ id: "card-ci", stage: BOARD_SEED_STAGE_IDS.ci, orderKey: "m" }),
  ci: ci(phase),
});

const record = (action: BoardCardRecordCiCommand["action"]): BoardCardRecordCiCommand => ({
  type: "board.card.record-ci",
  commandId: CommandId.make("cmd-ci"),
  cardId: inCi("running").id,
  action,
  createdAt: NOW,
});

it("a held pass keeps its reason and machine flag, its unfinished steps cancelled", () => {
  const decided = decideBoardCiRecord(
    inCi("running"),
    record({
      kind: "finish-pass",
      runId: "run-1",
      result: "interrupted",
      reason: "Disk nearly full on z5: 0.4 GiB free. Retry CI, or Skip CI.",
      machine: true,
    }),
  );
  assert.isTrue(decided.ok);
  if (!decided.ok) return;
  const held = decided.payload.card.ci!;
  assert.strictEqual(held.phase, "held");
  assert.strictEqual(
    held.stopReason,
    "Disk nearly full on z5: 0.4 GiB free. Retry CI, or Skip CI.",
  );
  assert.strictEqual(held.machine, true);
  assert.deepStrictEqual(
    held.steps.map((step) => step.status),
    ["passed", "cancelled"],
  );
  assert.deepStrictEqual(decided.payload.settled, [
    { runId: "run-1", outcome: "interrupted", finishedAt: NOW },
  ]);
});

it("a hold without a reason, as before, carries none", () => {
  const decided = decideBoardCiRecord(
    inCi("running"),
    record({ kind: "finish-pass", runId: "run-1", result: "interrupted" }),
  );
  assert.isTrue(decided.ok && decided.payload.card.ci?.phase === "held");
  assert.isTrue(decided.ok && decided.payload.card.ci?.stopReason === undefined);
  assert.isTrue(decided.ok && decided.payload.card.ci?.machine === undefined);
});

it("a late step report leaves a held or stopped card's steps alone; its row still takes it", () => {
  for (const phase of ["held", "stopped"] as const) {
    const card = inCi(phase);
    const decided = decideBoardCiRecord(
      card,
      record({
        kind: "step",
        runId: "run-1",
        index: 1,
        step: {
          name: "Test",
          command: "vp test",
          timeoutMinutes: 5,
          status: "failed",
          startedAt: NOW,
          finishedAt: NOW,
          exitCode: 1,
          tail: "",
        },
      }),
    );
    assert.isTrue(decided.ok, phase);
    if (decided.ok) assert.deepStrictEqual(decided.payload.card.ci, card.ci, phase);
  }
});

it("a fix starts only on a running pass", () => {
  for (const phase of ["held", "stopped", "fixing", "queued"] as const) {
    const decided = decideBoardCiRecord(inCi(phase), record({ kind: "begin-fix", runId: "run-1" }));
    assert.isFalse(decided.ok, phase);
  }
  const running = decideBoardCiRecord(
    inCi("running"),
    record({ kind: "begin-fix", runId: "run-1" }),
  );
  assert.isTrue(running.ok && running.payload.card.ci?.phase === "fixing");
});

it("a late finish settles only its row: the card's newer or settled pass is left alone", () => {
  // A hold for a pass Retry already replaced keeps the new pass.
  const replaced = { ...inCi("running"), ci: { ...ci("running"), runId: "run-2" } };
  const stale = decideBoardCiRecord(
    replaced,
    record({ kind: "finish-pass", runId: "run-1", result: "interrupted", reason: "Stopped." }),
  );
  assert.isTrue(stale.ok);
  if (stale.ok) {
    assert.deepStrictEqual(stale.payload.card.ci, replaced.ci);
    assert.deepStrictEqual(stale.payload.settled, [
      { runId: "run-1", outcome: "interrupted", finishedAt: NOW },
    ]);
  }
  // A second hold keeps the first reason; a late pass doesn't undo a hold.
  const held = { ...inCi("held"), ci: { ...ci("held"), stopReason: "Stopped by you." } };
  for (const result of ["interrupted", "passed"] as const) {
    const decided = decideBoardCiRecord(
      held,
      record({ kind: "finish-pass", runId: "run-1", result, reason: "Lost." }),
    );
    assert.isTrue(decided.ok, result);
    if (decided.ok) assert.deepStrictEqual(decided.payload.card.ci, held.ci, result);
  }
});

it("a fix's re-run starts only on a pass still being fixed", () => {
  const start = (fixThreadId: ThreadId | null) =>
    record({
      kind: "start-pass",
      runId: "run-2",
      entry: 1,
      ordinal: 2,
      steps: boardCiStepsFromLegacy([{ name: "Test", command: "vp test", timeoutMinutes: 5 }]),
      maxFixAttempts: 2,
      logDir: "/tmp/ci/run-2",
      queued: true,
      fixThreadId,
    });
  assert.isFalse(decideBoardCiRecord(inCi("held"), start(ThreadId.make("thread-fix"))).ok);
  assert.isTrue(decideBoardCiRecord(inCi("fixing"), start(ThreadId.make("thread-fix"))).ok);
  assert.isTrue(decideBoardCiRecord(inCi("held"), start(null)).ok);
});

it("a finish-pass recorded before held reasons existed still decodes", () => {
  const decoded = decodeRecordCiCommand({
    type: "board.card.record-ci",
    commandId: "cmd-old",
    cardId: "card-ci",
    action: { kind: "finish-pass", runId: "run-1", result: "interrupted" },
    createdAt: NOW,
  });
  assert.deepStrictEqual(decoded.action, {
    kind: "finish-pass",
    runId: "run-1",
    result: "interrupted",
  });
});

const headline = (why: string, machine = false): BoardCiHeadline => ({
  what: "Test",
  why,
  machine,
  logLine: 4,
  logOffset: 120,
  source: "pattern",
});

const failedStep = (why: string): BoardCiPassStep => ({
  name: "Test",
  command: "vp test",
  timeoutMinutes: 5,
  status: "failed",
  startedAt: NOW,
  finishedAt: NOW,
  exitCode: 1,
  tail: "",
  headline: headline(why),
});

it("T3O-61: the card heads with its first failing step, and the next pass clears it", () => {
  const first = decideBoardCiRecord(
    inCi("running"),
    record({ kind: "step", runId: "run-1", index: 1, step: failedStep("first") }),
  );
  assert.isTrue(first.ok);
  if (!first.ok) return;
  assert.deepStrictEqual(first.payload.card.ci?.headline, headline("first"));
  const second = decideBoardCiRecord(
    first.payload.card,
    record({ kind: "step", runId: "run-1", index: 0, step: failedStep("second") }),
  );
  assert.isTrue(second.ok && second.payload.card.ci?.headline?.why === "first");
  if (!second.ok) return;
  const restarted = decideBoardCiRecord(
    second.payload.card,
    record({
      kind: "start-pass",
      runId: "run-2",
      entry: 1,
      ordinal: 2,
      steps: boardCiStepsFromLegacy([{ name: "Test", command: "vp test", timeoutMinutes: 5 }]),
      maxFixAttempts: 2,
      logDir: "/tmp/ci/run-2",
      queued: false,
      fixThreadId: null,
    }),
  );
  assert.isTrue(restarted.ok && restarted.payload.card.ci?.headline === undefined);
});

it("T3O-61: a machine hold carries the headline when the step's own record hasn't landed", () => {
  const decided = decideBoardCiRecord(
    inCi("running"),
    record({
      kind: "finish-pass",
      runId: "run-1",
      result: "interrupted",
      reason: "Machine problem on box: Missing system library: libnspr4.so. Then Retry CI.",
      machine: true,
      headline: headline("Missing system library: libnspr4.so", true),
    }),
  );
  assert.isTrue(decided.ok);
  if (!decided.ok) return;
  assert.strictEqual(decided.payload.card.ci?.phase, "held");
  assert.strictEqual(decided.payload.card.ci?.machine, true);
  assert.deepStrictEqual(
    decided.payload.card.ci?.headline,
    headline("Missing system library: libnspr4.so", true),
  );
  assert.strictEqual(decided.payload.card.ciRoundTrips, 0);
  assert.strictEqual(decided.payload.card.ci?.fixAttempts, 0);
});
