/**
 * The v2 gateway's pure halves (T3O-59): how stored engine events become the
 * supervisor's signals, and how a thread shell reads as the board's thread
 * state. The contract suite drives the same code through the real engine; these
 * pin the cases that engine never produces without a provider — a run's
 * repeated terminal updates, a question answered or cancelled, a usage limit.
 */
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { assert, describe, it } from "vite-plus/test";

import { EventSinkStreamError } from "../orchestration-v2/EventSink.ts";
import {
  boardThreadStateFromShell,
  followStoredEvents,
  makeSignalReader,
} from "./ThreadGatewayV2.ts";

const threadId = ThreadId.make("thread-1");
const t0 = DateTime.makeUnsafe("2026-10-20T00:00:00.000Z");

let sequence = 0;
const stored = (
  type: string,
  payload: object,
  commandId: string | null = null,
): OrchestrationV2StoredEvent =>
  ({
    sequence: (sequence += 1),
    commandId: commandId === null ? null : CommandId.make(commandId),
    event: { type, id: EventId.make(`evt-${sequence}`), threadId, occurredAt: t0, payload },
  }) as unknown as OrchestrationV2StoredEvent;

const run = (status: string, startedAt: DateTime.Utc | null = t0) => ({
  id: RunId.make("run-1"),
  threadId,
  status,
  requestedAt: t0,
  startedAt,
});

describe("makeSignalReader", () => {
  it("tells a board turn from a human's by the command that asked for it", () => {
    const read = makeSignalReader();
    assert.deepStrictEqual(
      read(stored("run.created", run("starting", null), "server:board-recover-turn:abc")),
      { type: "turn-requested", threadId, byBoard: true, at: "2026-10-20T00:00:00.000Z" },
    );
    // A usage-limit resume is the engine acting for the user, not the board.
    assert.include(read(stored("run.created", run("starting", null), "limit-resume:x")), {
      byBoard: false,
    });
  });

  it("ends a turn once, at the provider's finish, not again at its checkpoint", () => {
    const read = makeSignalReader();
    assert.isNull(read(stored("run.updated", run("running"))));
    assert.deepStrictEqual(read(stored("run.updated", run("waiting"))), {
      type: "turn-ended",
      threadId,
      turnRef: "run-1",
      outcome: "completed",
      errorMessage: null,
    });
    assert.isNull(read(stored("run.updated", run("completed"))));
  });

  it("reads each terminal status in the board's outcome vocabulary", () => {
    for (const [status, outcome] of [
      ["failed", "failed"],
      ["interrupted", "interrupted"],
      ["cancelled", "cancelled"],
      ["rolled_back", "cancelled"],
    ] as const) {
      const signal = makeSignalReader()(stored("run.updated", run(status)));
      assert.include(signal, { type: "turn-ended", outcome });
    }
  });

  it("reads a run that failed before it started as a turn that never began", () => {
    assert.deepStrictEqual(makeSignalReader()(stored("run.updated", run("failed", null))), {
      type: "turn-start-failed",
      threadId,
      detail: "The turn failed before it started.",
    });
  });

  it("raises a question once, and separates an answer from a cancellation", () => {
    const read = makeSignalReader();
    const request = (id: string, status: string, answers?: object) => ({
      id: RuntimeRequestId.make(id),
      threadId,
      kind: "user_input",
      status,
      ...(answers === undefined ? {} : { answers }),
    });
    assert.deepStrictEqual(read(stored("runtime-request.updated", request("q1", "pending"))), {
      type: "input-requested",
      threadId,
    });
    assert.isNull(read(stored("runtime-request.updated", request("q1", "pending"))));
    assert.deepStrictEqual(
      read(stored("runtime-request.updated", request("q1", "resolved", { which: "A" }))),
      { type: "input-resolved", threadId, answered: true },
    );
    assert.deepStrictEqual(read(stored("runtime-request.updated", request("q2", "cancelled"))), {
      type: "input-resolved",
      threadId,
      answered: false,
    });
  });

  it("reads an answered permission prompt, and ignores an auth refresh", () => {
    const read = makeSignalReader();
    const request = (kind: string, status: string) => ({
      id: RuntimeRequestId.make(`${kind}-${status}`),
      threadId,
      kind,
      status,
    });
    assert.isNull(read(stored("runtime-request.updated", request("permission", "pending"))));
    assert.deepStrictEqual(
      read(stored("runtime-request.updated", request("permission", "resolved"))),
      { type: "approval-responded", threadId },
    );
    assert.isNull(read(stored("runtime-request.updated", request("auth_refresh", "resolved"))));
  });

  it("reads a Stop once, from the interrupt request the engine records", () => {
    const read = makeSignalReader();
    const item = { id: TurnItemId.make("item-1"), type: "run_interrupt_request" };
    assert.deepStrictEqual(read(stored("turn-item.updated", item)), {
      type: "interrupt-requested",
      threadId,
    });
    assert.isNull(read(stored("turn-item.updated", item)));
    assert.isNull(
      read(
        stored("turn-item.updated", { id: TurnItemId.make("item-2"), type: "assistant_message" }),
      ),
    );
  });

  it("reads a session coming up", () => {
    assert.deepStrictEqual(makeSignalReader()(stored("provider-session.attached", {})), {
      type: "session-started",
      threadId,
    });
  });
});

const shell = (overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell =>
  ({
    id: threadId,
    projectId: ProjectId.make("project-1"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    worktreePath: "/tmp/wt",
    latestRunId: RunId.make("run-1"),
    activeRunId: null,
    activeProviderThreadId: null,
    activityRunStatus: null,
    status: "completed",
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    archivedAt: null,
    settledOverride: null,
    pinnedAt: null,
    autoSettleDisabledAt: null,
    snoozedUntil: null,
    deletedAt: null,
    limitRecovery: null,
    updatedAt: t0,
    ...overrides,
  }) as unknown as OrchestrationV2ThreadShell;

describe("boardThreadStateFromShell", () => {
  const nowMs = Date.parse("2026-10-20T01:00:00.000Z");

  it("reads a live run as alive and a failed one as dead", () => {
    const live = boardThreadStateFromShell(
      shell({ activeRunId: RunId.make("run-1"), activityRunStatus: "running", status: "running" }),
      nowMs,
    );
    assert.include(live, { alive: true, sessionStatus: "running", activeTurnRef: "run-1" });
    const failed = boardThreadStateFromShell(shell({ status: "failed" }), nowMs);
    assert.include(failed, { alive: false, sessionStatus: "error" });
    assert.isNull(failed.usageLimit);
  });

  it("reads a usage-limited run, and whether the engine will resume it itself", () => {
    const limited = {
      status: "failed" as const,
      lastErrorClass: "usage_limit" as const,
      lastError: "Usage limit reached.",
      usageLimitResetAt: "2026-10-20T05:00:00.000Z",
      latestRunCompletedAt: DateTime.makeUnsafe("2026-10-20T00:30:00.000Z"),
    };
    assert.deepStrictEqual(boardThreadStateFromShell(shell(limited), nowMs).usageLimit, {
      resetAt: "2026-10-20T05:00:00.000Z",
      message: "Usage limit reached.",
      resumeArmed: false,
    });
    const armed = shell({
      ...limited,
      limitRecovery: {
        runId: RunId.make("run-1"),
        resetAt: "2026-10-20T05:00:00.000Z",
        autoResume: true,
      },
    } as Partial<OrchestrationV2ThreadShell>);
    assert.isTrue(boardThreadStateFromShell(armed, nowMs).usageLimit!.resumeArmed);
    // Recovery armed for an EARLIER failure says nothing about this one.
    const stale = shell({
      ...limited,
      limitRecovery: {
        runId: RunId.make("run-0"),
        resetAt: "2026-10-20T05:00:00.000Z",
        autoResume: true,
      },
    } as Partial<OrchestrationV2ThreadShell>);
    assert.isFalse(boardThreadStateFromShell(stale, nowMs).usageLimit!.resumeArmed);
  });

  it("reads an arm v2 will never act on as not armed, so the board still wakes it", () => {
    const armed = {
      status: "failed" as const,
      lastErrorClass: "usage_limit" as const,
      lastError: "Usage limit reached.",
      usageLimitResetAt: "2026-10-20T05:00:00.000Z",
      latestRunCompletedAt: DateTime.makeUnsafe("2026-10-20T00:30:00.000Z"),
      limitRecovery: {
        runId: RunId.make("run-1"),
        resetAt: "2026-10-20T05:00:00.000Z",
        autoResume: true,
      },
    };
    const refused: ReadonlyArray<Record<string, unknown>> = [
      { archivedAt: t0 },
      { settledOverride: "settled" },
      {
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("q1"),
          kind: "user_input",
          createdAt: t0,
        },
      },
      // A reset no later than the failure: v2 refuses it rather than loop.
      { latestRunCompletedAt: DateTime.makeUnsafe("2026-10-20T06:00:00.000Z") },
    ];
    for (const overrides of refused) {
      const state = boardThreadStateFromShell(
        shell({ ...armed, ...overrides } as Partial<OrchestrationV2ThreadShell>),
        nowMs,
      );
      assert.isFalse(state.usageLimit!.resumeArmed, JSON.stringify(Object.keys(overrides)));
    }
  });

  it("holds a thread with a question live, even between runs", () => {
    const asking = boardThreadStateFromShell(
      shell({
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("q1"),
          kind: "user_input",
          createdAt: DateTime.makeUnsafe(nowMs),
        },
      }),
      nowMs,
    );
    assert.include(asking, { alive: true, awaitingUserInput: true, autoSettleCandidate: false });
  });
});

describe("followStoredEvents", () => {
  it("resubscribes after the last delivered event when a read fails", async () => {
    const event = (n: number) => ({ sequence: n }) as unknown as OrchestrationV2StoredEvent;
    const subscribedAfter: Array<number | undefined> = [];
    const sink = {
      latestSequence: () => Effect.succeed(10),
      stream: (input?: { readonly afterSequence?: number }) => {
        subscribedAfter.push(input?.afterSequence);
        return subscribedAfter.length === 1
          ? Stream.make(event(11), event(12)).pipe(
              Stream.concat(Stream.fail(new EventSinkStreamError({ afterSequence: 12 }))),
            )
          : Stream.make(event(13));
      },
    };
    const sequences = await Effect.runPromise(
      followStoredEvents(sink, Schedule.recurs(1)).pipe(
        Stream.map((stored) => stored.sequence),
        Stream.runCollect,
      ),
    );
    assert.deepStrictEqual(Array.from(sequences), [11, 12, 13]);
    assert.deepStrictEqual(subscribedAfter, [10, 12]);
  });
});
