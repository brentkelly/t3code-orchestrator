/**
 * How the v1 gateway reads a thread shell into the board's `BoardThreadState`
 * (T3O-58). These rules used to live in the supervisor; they moved with the
 * shell, so they are pinned here. Also the spawn compensation the contract
 * suite cannot reach on a real stack.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { boardThreadStateFromShell, makeThreadGatewayV1 } from "./ThreadGatewayV1.ts";

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

/** A spawn on an engine that creates the thread and refuses its first turn —
    which the real v1 stack cannot produce without a provider. */
const spawnAgainstRefusingEngine = Effect.gen(function* () {
  const dispatched: Array<OrchestrationCommand> = [];
  const engine = Layer.mock(OrchestrationEngineService)({
    dispatch: (command) => {
      dispatched.push(command);
      return command.type === "thread.turn.start"
        ? Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "the provider refused the turn",
            }),
          )
        : Effect.succeed({ sequence: dispatched.length });
    },
  });
  const exit = yield* Effect.gen(function* () {
    const threads = yield* makeThreadGatewayV1;
    return yield* Effect.exit(
      threads.spawn({
        commandId: CommandId.make("server:board-spawn-thread:1"),
        threadId: ThreadId.make("thread-refused"),
        projectId: ProjectId.make("project-1"),
        title: "Refused",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "board/refused",
        worktreePath: "/tmp/wt/refused",
        text: "Do the work.",
        attachments: [],
      }),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        engine,
        Layer.mock(ProjectionSnapshotQuery)({}),
        Layer.mock(ProviderService)({}),
        // Never queried: a spawn only dispatches.
        Layer.succeed(SqlClient.SqlClient, {} as never),
        NodeServices.layer,
      ),
    ),
  );
  return { exit, dispatched };
});

describe("ThreadGatewayV1 spawn", () => {
  it.effect("a refused first turn deletes the thread it created and reports the refusal", () =>
    Effect.gen(function* () {
      const { exit, dispatched } = yield* spawnAgainstRefusingEngine;
      assert.isTrue(Exit.isFailure(exit));
      const error = Exit.isFailure(exit)
        ? Option.getOrNull(Cause.findErrorOption(exit.cause))
        : null;
      assert.strictEqual(error?._tag, "ThreadCommandRefusedError");
      assert.deepStrictEqual(
        dispatched.map((command) => [command.type, command.commandId]),
        [
          ["thread.create", "server:board-spawn-thread:1"],
          ["thread.turn.start", "server:board-spawn-thread:1:turn"],
          ["thread.delete", "server:board-spawn-thread:1:cleanup"],
        ],
      );
    }),
  );
});
