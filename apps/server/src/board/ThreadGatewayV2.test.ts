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
  MessageId,
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
import { it as effectIt } from "@effect/vitest";
import { assert, describe, it } from "vite-plus/test";

import { EventSinkStreamError } from "../orchestration-v2/EventSink.ts";
import type { ThreadSignal } from "./ThreadGateway.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import {
  boardThreadStateFromShell,
  commandError,
  followStoredEvents,
  makeSignalReader,
} from "./ThreadGatewayV2.ts";

const threadId = ThreadId.make("thread-1");
const messageId = MessageId.make("message-1");
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

const run = (
  status: string,
  startedAt: DateTime.Utc | null = t0,
  overrides: Record<string, unknown> = {},
) => ({
  id: RunId.make("run-1"),
  threadId,
  status,
  requestedAt: t0,
  startedAt,
  userMessageId: messageId,
  ...overrides,
});

type MessageAuthor = { readonly createdBy: string; readonly creationSource: string };

const CLIENT_COMMAND_ID = "8c7f0f0e-6d2b-4a5e-9a1d-0f2b3c4d5e6f";
const HUMAN_MESSAGE = { createdBy: "user", creationSource: "web" } as const;
const BOARD_MESSAGE = { createdBy: "user", creationSource: "server" } as const;

/** A run v2 created, then its message, as one command commits them. */
const requestRun = (
  commandId: string | null,
  author: MessageAuthor,
  overrides: Record<string, unknown> = {},
): ReadonlyArray<ThreadSignal> => {
  const read = makeSignalReader();
  return [
    ...read(stored("run.created", run("starting", null, overrides), commandId)),
    ...read(stored("message.updated", { ...author, id: messageId, role: "user" }, commandId)),
  ];
};

/** A reader for events that carry at most one signal each. */
const singleSignalReader = () => {
  const read = makeSignalReader();
  return (event: OrchestrationV2StoredEvent): ThreadSignal | null => {
    const signals = read(event);
    assert.isAtMost(signals.length, 1, JSON.stringify(signals));
    return signals[0] ?? null;
  };
};

describe("makeSignalReader", () => {
  it("tells a board turn from a human's by the command and the message's author", () => {
    assert.deepStrictEqual(requestRun("server:board-recover-turn:abc", BOARD_MESSAGE), [
      { type: "turn-requested", threadId, byBoard: true, at: "2026-10-20T00:00:00.000Z" },
    ]);
    assert.deepStrictEqual(requestRun(CLIENT_COMMAND_ID, HUMAN_MESSAGE), [
      { type: "turn-requested", threadId, byBoard: false, at: "2026-10-20T00:00:00.000Z" },
    ]);
  });

  it("reads a human's steer that became a follow-up run as a human turn", () => {
    // EffectWorker re-dispatches the steer under its own command id, carrying
    // the human's authorship over.
    assert.include(requestRun("command:steer-follow-up:effect-2", HUMAN_MESSAGE)[0], {
      type: "turn-requested",
      byBoard: false,
    });
    // The board's own steer coming back as a follow-up is not a human's.
    assert.deepStrictEqual(requestRun("command:steer-follow-up:effect-3", BOARD_MESSAGE), []);
  });

  it("reads the engine's limit resume as its own signal, not a human turn", () => {
    assert.deepStrictEqual(requestRun("limit-resume:x:req", BOARD_MESSAGE), [
      { type: "limit-resumed", threadId },
    ]);
  });

  it("raises nothing for a run the engine started to carry on its own work", () => {
    const wakes: ReadonlyArray<readonly [Record<string, unknown>, string | null, MessageAuthor]> = [
      [{ workStartedAt: t0 }, "command:mailbox-accepted:effect-1", HUMAN_MESSAGE],
      [
        { restartContinuationOfRunId: RunId.make("run-0") },
        "command:restart-continuation:run-0",
        { createdBy: "agent", creationSource: "server" },
      ],
      [{ delegatedTaskId: "node-1" }, null, HUMAN_MESSAGE],
      [{}, "provider-continuation:msg-1", { createdBy: "system", creationSource: "provider" }],
      [{}, "server:pr-watch:thread-1:uuid", { createdBy: "system", creationSource: "server" }],
      // A delegated task's question to its parent, queued behind the active
      // run: no wake fields until it starts, so only its author tells.
      [{}, "server:delegated-task-question:key", { createdBy: "agent", creationSource: "server" }],
    ];
    for (const [overrides, commandId, author] of wakes) {
      assert.deepStrictEqual(
        requestRun(commandId, author, overrides),
        [],
        JSON.stringify([overrides, commandId, author]),
      );
    }
  });

  it("waits for the run's own message, not any message on the thread", () => {
    const read = makeSignalReader();
    assert.deepStrictEqual(
      read(stored("run.created", run("starting", null), CLIENT_COMMAND_ID)),
      [],
    );
    assert.deepStrictEqual(
      read(stored("message.updated", { ...HUMAN_MESSAGE, id: MessageId.make("message-other") })),
      [],
    );
    assert.lengthOf(read(stored("message.updated", { ...HUMAN_MESSAGE, id: messageId })), 1);
    // A later update of the same message is not a second request.
    assert.deepStrictEqual(
      read(stored("message.updated", { ...HUMAN_MESSAGE, id: messageId })),
      [],
    );
  });

  it("ends a turn once, at the provider's finish, not again at its checkpoint", () => {
    const read = singleSignalReader();
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

  it("carries the provider's failure text onto the failed turn's end", () => {
    const read = singleSignalReader();
    const failure = {
      id: TurnItemId.make("item-error"),
      runId: RunId.make("run-1"),
      type: "error",
      failure: { class: "usage_limit", message: "Grok prompt request failed: quota." },
    };
    assert.isNull(read(stored("turn-item.updated", failure)));
    assert.deepStrictEqual(read(stored("run.updated", run("failed"))), {
      type: "turn-ended",
      threadId,
      turnRef: "run-1",
      outcome: "failed",
      errorMessage: "Grok prompt request failed: quota.",
    });
  });

  it("reads each terminal status in the board's outcome vocabulary", () => {
    for (const [status, outcome] of [
      ["failed", "failed"],
      ["interrupted", "interrupted"],
      ["cancelled", "cancelled"],
      ["rolled_back", "cancelled"],
    ] as const) {
      const signal = singleSignalReader()(stored("run.updated", run(status)));
      assert.include(signal, { type: "turn-ended", outcome });
    }
  });

  it("reads a run that failed before it started as a turn that never began", () => {
    assert.deepStrictEqual(singleSignalReader()(stored("run.updated", run("failed", null))), {
      type: "turn-start-failed",
      threadId,
      detail: "The turn failed before it started.",
    });
  });

  it("raises a question once, and separates an answer from a cancellation", () => {
    const read = singleSignalReader();
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
    const read = singleSignalReader();
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
    const read = singleSignalReader();
    const item = { id: TurnItemId.make("item-1"), runId: null, type: "run_interrupt_request" };
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

  it("reads a human's Stop before the run started as a Stop, then the turn's end", () => {
    const signals = makeSignalReader()(
      stored("run.updated", run("interrupted", null), "8c7f0f0e-6d2b-4a5e-9a1d-0f2b3c4d5e6f"),
    );
    assert.deepStrictEqual(signals, [
      { type: "interrupt-requested", threadId },
      {
        type: "turn-ended",
        threadId,
        turnRef: "run-1",
        outcome: "interrupted",
        errorMessage: null,
      },
    ]);
    // The board's own interrupt is already tracked by the board.
    assert.deepStrictEqual(
      makeSignalReader()(
        stored("run.updated", run("interrupted", null), "server:board-interrupt-paused:abc"),
      ).map((signal) => signal.type),
      ["turn-ended"],
    );
    // Whose run it was doesn't matter, only who pressed Stop: a human stopping
    // an engine wake before it started is still a human's Stop.
    assert.deepStrictEqual(
      makeSignalReader()(
        stored("run.updated", run("cancelled", null, { workStartedAt: t0 }), CLIENT_COMMAND_ID),
      ).map((signal) => signal.type),
      ["interrupt-requested", "turn-ended"],
    );
  });

  it("does not repeat a Stop the engine already recorded as an interrupt request", () => {
    const read = makeSignalReader();
    const item = {
      id: TurnItemId.make("item-1"),
      runId: RunId.make("run-1"),
      type: "run_interrupt_request",
    };
    assert.lengthOf(read(stored("turn-item.updated", item)), 1);
    assert.deepStrictEqual(
      read(
        stored("run.updated", run("cancelled", null), "8c7f0f0e-6d2b-4a5e-9a1d-0f2b3c4d5e6f"),
      ).map((signal) => signal.type),
      ["turn-ended"],
    );
  });

  it("reads a session coming up", () => {
    assert.deepStrictEqual(singleSignalReader()(stored("provider-session.attached", {})), {
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

describe("commandError", () => {
  const dispatchError = (cause: unknown) =>
    new OrchestratorDispatchError({
      commandId: CommandId.make("server:board-interrupt-paused:abc"),
      commandType: "run.interrupt",
      cause,
    });

  it("reads the engine's stated refusal as a refusal, in its own words", () => {
    const error = commandError(
      "run.interrupt",
      threadId,
    )(dispatchError("Run run-1 is not interruptible."));
    assert.strictEqual(error._tag, "ThreadCommandRefusedError");
    assert.strictEqual(error.detail, "Run run-1 is not interruptible.");
  });

  it("reads a dispatch that wrapped a real failure as a failure", () => {
    const error = commandError("run.interrupt", threadId)(dispatchError(new Error("disk I/O")));
    assert.strictEqual(error._tag, "ThreadCommandFailedError");
    assert.strictEqual(error.detail, "disk I/O");
  });
});

describe("followStoredEvents", () => {
  effectIt.effect("starts after a given cursor and resubscribes from the last event", () => {
    const event = (n: number) => ({ sequence: n }) as unknown as OrchestrationV2StoredEvent;
    const subscribedAfter: Array<number | undefined> = [];
    const sink = {
      latestSequence: () => Effect.succeed(99),
      stream: (input?: { readonly afterSequence?: number }) => {
        subscribedAfter.push(input?.afterSequence);
        return subscribedAfter.length === 1
          ? Stream.make(event(6)).pipe(
              Stream.concat(Stream.fail(new EventSinkStreamError({ afterSequence: 6 }))),
            )
          : Stream.make(event(7));
      },
    };
    return followStoredEvents(sink, Schedule.recurs(1), 5).pipe(
      Stream.map((stored) => stored.sequence),
      Stream.runCollect,
      Effect.map((sequences) => {
        assert.deepStrictEqual(Array.from(sequences), [6, 7]);
        assert.deepStrictEqual(subscribedAfter, [5, 6]);
      }),
    );
  });

  effectIt.effect("resubscribes after the last delivered event when a read fails", () => {
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
    return followStoredEvents(sink, Schedule.recurs(1)).pipe(
      Stream.map((stored) => stored.sequence),
      Stream.runCollect,
      Effect.map((sequences) => {
        assert.deepStrictEqual(Array.from(sequences), [11, 12, 13]);
        assert.deepStrictEqual(subscribedAfter, [10, 12]);
      }),
    );
  });
});
