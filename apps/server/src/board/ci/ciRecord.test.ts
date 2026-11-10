/**
 * T3O-59 — the CI record decider: a held pass keeps why (and whether the
 * machine was to blame), and a late report from a held or stopped pass can't
 * move the card's steps or start a fix.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardRecordCiCommand,
  CommandId,
  type BoardCard,
  type BoardCardCi,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { makeBoardCard, NOW } from "../supervisorHarness.testkit.ts";
import { decideBoardCiRecord } from "./ciRecord.ts";

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
      reason: "Disk nearly full on z5: 0.4 GB free. Retry CI, or Skip CI.",
      machine: true,
    }),
  );
  assert.isTrue(decided.ok);
  if (!decided.ok) return;
  const held = decided.payload.card.ci!;
  assert.strictEqual(held.phase, "held");
  assert.strictEqual(held.stopReason, "Disk nearly full on z5: 0.4 GB free. Retry CI, or Skip CI.");
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

it("a finish-pass recorded before held reasons existed still decodes", () => {
  const decoded = Schema.decodeUnknownSync(BoardCardRecordCiCommand)({
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
