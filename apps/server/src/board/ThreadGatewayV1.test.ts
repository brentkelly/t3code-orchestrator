/**
 * How the v1 gateway reads a thread shell into the board's `BoardThreadState`
 * (T3O-58). These rules used to live in the supervisor; they moved with the
 * shell, so they are pinned here.
 */
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { boardThreadStateFromShell } from "./ThreadGatewayV1.ts";

const NOW = "2026-01-01T00:10:00.000Z";

const shell = (overrides: Record<string, unknown> = {}): OrchestrationThreadShell =>
  ({
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    worktreePath: "/tmp/wt/one",
    createdAt: "2026-01-01T00:00:00.000Z",
    latestUserMessageAt: null,
    latestTurn: null,
    hasPendingUserInput: false,
    hasPendingApprovals: false,
    backgroundLiveness: null,
    archivedAt: null,
    settledOverride: null,
    autoSettleDisabledAt: null,
    pullRequests: [],
    session: { status: "ready", activeTurnId: null },
    ...overrides,
  }) as unknown as OrchestrationThreadShell;

describe("boardThreadStateFromShell", () => {
  it("a thread mid-turn is alive and not a settle candidate", () => {
    const state = boardThreadStateFromShell(
      shell({ session: { status: "running", activeTurnId: "turn-1" } }),
      NOW,
    );
    assert.strictEqual(state.sessionStatus, "running");
    assert.strictEqual(state.activeTurnRef, "turn-1");
    assert.isTrue(state.alive);
    assert.isFalse(state.autoSettleCandidate);
  });

  it("an errored session is dead even with the killed turn's id lingering (t3o-10, D1)", () => {
    const state = boardThreadStateFromShell(
      shell({
        hasPendingUserInput: true,
        session: { status: "error", activeTurnId: "turn-killed" },
      }),
      NOW,
    );
    assert.strictEqual(state.activeTurnRef, "turn-killed");
    assert.isFalse(state.alive);
  });

  it("a pending question keeps an idle thread alive", () => {
    const state = boardThreadStateFromShell(shell({ hasPendingUserInput: true }), NOW);
    assert.isTrue(state.awaitingUserInput);
    assert.isTrue(state.alive);
  });

  it("a permission prompt counts only while a turn can still answer it (T3O-16)", () => {
    const live = boardThreadStateFromShell(
      shell({ hasPendingApprovals: true, session: { status: "running", activeTurnId: "t" } }),
      NOW,
    );
    assert.isTrue(live.awaitingPermission);
    const orphaned = boardThreadStateFromShell(
      shell({ hasPendingApprovals: true, session: { status: "stopped", activeTurnId: null } }),
      NOW,
    );
    assert.isFalse(orphaned.awaitingPermission);
  });

  it("background work after the turn ended is a wait, not a stop (T3O-20)", () => {
    const state = boardThreadStateFromShell(shell({ backgroundLiveness: "monitoring" }), NOW);
    assert.strictEqual(state.backgroundWork, "monitoring");
    assert.isTrue(state.waitingOnBackground);
    assert.isFalse(state.alive);
    assert.isFalse(state.autoSettleCandidate);
  });

  it("v1's resting statuses read as idle, and an idle thread can be settled", () => {
    for (const status of ["ready", "idle", "interrupted"]) {
      const state = boardThreadStateFromShell(
        shell({ session: { status, activeTurnId: null } }),
        NOW,
      );
      assert.strictEqual(state.sessionStatus, "idle");
      assert.isTrue(state.autoSettleCandidate);
    }
    assert.strictEqual(
      boardThreadStateFromShell(shell({ session: null }), NOW).sessionStatus,
      "none",
    );
  });

  it("a settle decision and an archive are carried", () => {
    const state = boardThreadStateFromShell(
      shell({ settledOverride: "unsettled", archivedAt: "2026-01-01T00:05:00.000Z" }),
      NOW,
    );
    assert.isTrue(state.settlementDecided);
    assert.isTrue(state.archived);
    assert.isFalse(state.autoSettleCandidate);
  });
});
