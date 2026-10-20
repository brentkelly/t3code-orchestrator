/**
 * The thread gateway's contract, run against `ThreadGatewayV1` on the real v1
 * stack (T3O-58).
 *
 * Everything the board relies on the thread engine for, stated in the gateway's
 * own vocabulary: what a spawn leaves behind, which commands are refused, what
 * signals the engine's own events become, and what the reads answer. The
 * orchestration-v2 port reruns this suite against its own gateway; a case that
 * only makes sense for v1 does not belong here.
 *
 * Signals are checked against the events the real engine LOGGED for each
 * command, not hand-built ones, so a drift in upstream's event shapes fails
 * here rather than silently in the supervisor.
 */
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { boardStackEngine, makeBoardStackTestLayer } from "./boardStack.testkit.ts";
import { ThreadGateway, type ThreadSignal, type TodoLogEntry } from "./ThreadGateway.ts";
import { domainSignal, runtimeSignal } from "./ThreadGatewayV1.ts";

const t0 = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-contract");
const workspaceRoot = "/tmp/project-contract";
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };

let seq = 0;
/** Board-minted, as the supervisor mints them: `server:board-<tag>:<uuid>`. */
const boardCommandId = (tag: string) =>
  CommandId.make(
    `server:board-${tag}:00000000-0000-4000-8000-${String((seq += 1)).padStart(12, "0")}`,
  );

const ensureProject = Effect.gen(function* () {
  const engine = yield* boardStackEngine;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-contract-project"),
    projectId,
    title: "Contract project",
    workspaceRoot,
    defaultModelSelection: modelSelection,
    createdAt: t0,
  });
});

/** Spawn a thread through the gateway, in its own worktree. */
const spawn = Effect.fn("spawn")(function* (tag: string) {
  yield* ensureProject;
  const threads = yield* ThreadGateway;
  const threadId = ThreadId.make(`thread-contract-${tag}`);
  yield* threads.spawn({
    commandId: boardCommandId("spawn-thread"),
    threadId,
    projectId,
    title: `Contract ${tag}`,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: `board/${tag}`,
    worktreePath: `/tmp/wt/${tag}`,
    text: "Do the work.",
    attachments: [],
  });
  return threadId;
});

/** The engine's log since `after`, and the head to continue from. */
const loggedSince = (after: number) =>
  Effect.gen(function* () {
    const engine = yield* boardStackEngine;
    const head = yield* engine.latestSequence;
    const events = yield* Stream.runCollect(engine.readEvents(after, head - after));
    return { events: [...events] as ReadonlyArray<OrchestrationEvent>, head };
  });

const signalsOf = (events: ReadonlyArray<OrchestrationEvent>) =>
  events.flatMap((event) => {
    const signal = domainSignal(event);
    return signal === null ? [] : [signal];
  });

const head = Effect.flatMap(boardStackEngine, (engine) => engine.latestSequence);

/** The tag a failed command failed with, or null when it succeeded. */
const refusalTag = (exit: Exit.Exit<unknown, { readonly _tag: string }>) =>
  Exit.isFailure(exit)
    ? Option.getOrNull(Option.map(Cause.findErrorOption(exit.cause), (error) => error._tag))
    : null;

it.layer(makeBoardStackTestLayer("t3o-thread-gateway-contract-"))(
  "ThreadGatewayV1 contract",
  (it) => {
    it.effect("a spawn leaves a live thread with its first turn requested by the board", () =>
      Effect.gen(function* () {
        const before = yield* head;
        const threadId = yield* spawn("spawned");
        const threads = yield* ThreadGateway;

        const state = yield* threads.threadState(threadId);
        assert.isNotNull(state);
        assert.strictEqual(state!.projectId, projectId);
        assert.isFalse(state!.deleted);
        assert.strictEqual(state!.worktreePath, "/tmp/wt/spawned");
        assert.deepStrictEqual(state!.modelSelection, modelSelection);
        // No provider is running in this stack, so nothing has picked the turn
        // up: the thread exists, is not alive, and its turn is pending.
        assert.isFalse(state!.alive);
        assert.isNull(state!.activeTurnRef);
        assert.isNotNull(yield* threads.pendingTurnStartAt(threadId));

        const records = yield* threads.threadRecords([threadId]);
        assert.deepStrictEqual(records.get(threadId), {
          threadId,
          deleted: false,
          archived: false,
          settlementDecided: false,
        });
        assert.include(yield* threads.listLiveThreadIds(), threadId);

        // The turn the spawn asked for reads as the BOARD's, never a human's.
        const { events } = yield* loggedSince(before);
        const requested = signalsOf(events).filter((signal) => signal.type === "turn-requested");
        assert.deepStrictEqual(
          requested.map((signal) => ({ ...signal, at: "" })),
          [{ type: "turn-requested", threadId, byBoard: true, at: "" }],
        );
      }),
    );

    it.effect("a spawn into a project that does not exist is refused and leaves nothing", () =>
      Effect.gen(function* () {
        const threads = yield* ThreadGateway;
        const threadId = ThreadId.make("thread-contract-orphan");
        const exit = yield* Effect.exit(
          threads.spawn({
            commandId: boardCommandId("spawn-thread"),
            threadId,
            projectId: ProjectId.make("project-missing"),
            title: "Orphan",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: "/tmp/wt/orphan",
            text: "Do the work.",
            attachments: [],
          }),
        );
        assert.strictEqual(refusalTag(exit), "ThreadCommandRefusedError");
        assert.isNull(yield* threads.threadState(threadId));
        assert.strictEqual((yield* threads.threadRecords([threadId])).size, 0);
      }),
    );

    it.effect("a turn sent to a thread that does not exist is refused", () =>
      Effect.gen(function* () {
        const threads = yield* ThreadGateway;
        const exit = yield* Effect.exit(
          threads.send({
            commandId: boardCommandId("recover-turn"),
            threadId: ThreadId.make("thread-contract-nobody"),
            text: "Hello?",
            attachments: [],
            runtimeMode: "full-access",
            interactionMode: "default",
          }),
        );
        assert.strictEqual(refusalTag(exit), "ThreadCommandRefusedError");
      }),
    );

    it.effect("send and interrupt become the signals the supervisor reacts to", () =>
      Effect.gen(function* () {
        const threadId = yield* spawn("steered");
        const threads = yield* ThreadGateway;
        const before = yield* head;
        yield* threads.send({
          commandId: boardCommandId("recover-turn"),
          threadId,
          text: "Carry on.",
          attachments: [],
          runtimeMode: "full-access",
          interactionMode: "default",
        });
        yield* threads.interrupt({ commandId: boardCommandId("interrupt-paused"), threadId });
        const { events } = yield* loggedSince(before);
        const signals = signalsOf(events).map((signal) =>
          signal.type === "turn-requested" ? { ...signal, at: "" } : signal,
        );
        assert.deepStrictEqual(signals, [
          { type: "turn-requested", threadId, byBoard: true, at: "" },
          { type: "interrupt-requested", threadId },
        ]);
      }),
    );

    it.effect("a turn a human asked for is not the board's", () =>
      Effect.gen(function* () {
        const threadId = yield* spawn("human");
        const engine = yield* boardStackEngine;
        const before = yield* head;
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("8c7f0f0e-6d2b-4a5e-9a1d-0f2b3c4d5e6f"),
          threadId,
          message: {
            messageId: MessageId.make("msg-contract-human"),
            role: "user",
            text: "Let me steer.",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: "2026-01-01T00:05:00.000Z",
        });
        const { events } = yield* loggedSince(before);
        assert.deepStrictEqual(signalsOf(events), [
          {
            type: "turn-requested",
            threadId,
            byBoard: false,
            at: "2026-01-01T00:05:00.000Z",
          },
        ]);
      }),
    );

    it.effect("a thread whose first turn is still queued refuses a settle", () =>
      Effect.gen(function* () {
        const threadId = yield* spawn("queued");
        const threads = yield* ThreadGateway;
        const exit = yield* Effect.exit(
          threads.settle({ commandId: boardCommandId("release-thread"), threadId, auto: true }),
        );
        assert.strictEqual(refusalTag(exit), "ThreadCommandRefusedError");
        assert.isFalse((yield* threads.threadRecords([threadId])).get(threadId)!.settlementDecided);
      }),
    );

    it.effect("a settle is recorded; an automatic one refuses a thread already settled", () =>
      Effect.gen(function* () {
        yield* ensureProject;
        // A thread with no turn at all: nothing queued, nothing running.
        const threadId = ThreadId.make("thread-contract-settled");
        const engine = yield* boardStackEngine;
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-contract-settled"),
          threadId,
          projectId,
          title: "Settled",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: t0,
        });
        const threads = yield* ThreadGateway;
        assert.isTrue((yield* threads.threadState(threadId))!.autoSettleCandidate);
        yield* threads.settle({ commandId: boardCommandId("settle"), threadId, auto: false });
        assert.isTrue((yield* threads.threadRecords([threadId])).get(threadId)!.settlementDecided);
        const state = yield* threads.threadState(threadId);
        assert.isTrue(state!.settlementDecided);
        assert.isFalse(state!.autoSettleCandidate);

        const again = yield* Effect.exit(
          threads.settle({ commandId: boardCommandId("release-thread"), threadId, auto: true }),
        );
        assert.strictEqual(refusalTag(again), "ThreadCommandRefusedError");
      }),
    );

    // The candidacy the caller read is re-checked at dispatch, so a thread that
    // stopped being a candidate since — here, snoozed — is refused even though
    // the engine's own decider would accept a settle.
    it.effect("an automatic settle refuses a thread that is no longer a candidate", () =>
      Effect.gen(function* () {
        yield* ensureProject;
        const threadId = ThreadId.make("thread-contract-snoozed");
        const engine = yield* boardStackEngine;
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-contract-snoozed"),
          threadId,
          projectId,
          title: "Snoozed",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: t0,
        });
        const threads = yield* ThreadGateway;
        assert.isTrue((yield* threads.threadState(threadId))!.autoSettleCandidate);
        yield* engine.dispatch({
          type: "thread.snooze",
          commandId: CommandId.make("cmd-contract-snooze"),
          threadId,
          snoozedUntil: "2999-01-01T00:00:00.000Z",
        });

        const exit = yield* Effect.exit(
          threads.settle({ commandId: boardCommandId("release-thread"), threadId, auto: true }),
        );
        assert.strictEqual(refusalTag(exit), "ThreadCommandRefusedError");
        assert.isFalse((yield* threads.threadRecords([threadId])).get(threadId)!.settlementDecided);
      }),
    );

    it.effect("a deleted thread reads as deleted, drops out of the live set, and is logged", () =>
      Effect.gen(function* () {
        const threadId = yield* spawn("deleted");
        const threads = yield* ThreadGateway;
        const before = yield* threads.todoLogHead;
        yield* threads.delete({ commandId: boardCommandId("delete-card-thread"), threadId });

        const state = yield* threads.threadState(threadId);
        assert.isTrue(state!.deleted);
        assert.isFalse(state!.alive);
        assert.isTrue((yield* threads.threadRecords([threadId])).get(threadId)!.deleted);
        assert.notInclude(yield* threads.listLiveThreadIds(), threadId);

        const after = yield* threads.todoLogHead;
        const logged = yield* Stream.runCollect(threads.readTodoLog(before, after));
        assert.deepStrictEqual(
          [...logged].flatMap((entry: TodoLogEntry) =>
            entry.signal === null ? [] : [entry.signal],
          ),
          [{ type: "thread-deleted", threadId }],
        );
        // Every position is accounted for, signal or not, so a reader's cursor
        // can reach the head.
        assert.strictEqual([...logged].at(-1)?.cursor, after);
      }),
    );

    it.effect("a plan update is a todo signal carrying the plan, read leniently", () =>
      Effect.gen(function* () {
        const threadId = yield* spawn("todos");
        const threads = yield* ThreadGateway;
        const engine = yield* boardStackEngine;
        const before = yield* threads.todoLogHead;
        yield* engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-contract-plan"),
          threadId,
          activity: {
            id: EventId.make("act-contract-plan"),
            tone: "info",
            kind: "turn.plan.updated",
            summary: "Plan updated",
            payload: {
              plan: [
                { step: "Read the code", status: "completed" },
                { step: "Write the fix", status: "inProgress" },
                { step: "", status: "pending" },
                { step: "Ship it" },
              ],
            },
            turnId: null,
            createdAt: "2026-01-01T00:10:00.000Z",
          },
          createdAt: "2026-01-01T00:10:00.000Z",
        });
        const logged = yield* Stream.runCollect(
          threads.readTodoLog(before, yield* threads.todoLogHead),
        );
        const signals = [...logged].flatMap((entry) =>
          entry.signal === null ? [] : [entry.signal],
        );
        assert.deepStrictEqual(signals, [
          {
            type: "todos-changed",
            threadId,
            todos: [
              { step: "Read the code", status: "completed" },
              { step: "Write the fix", status: "inProgress" },
              { step: "Ship it", status: "pending" },
            ],
            at: "2026-01-01T00:10:00.000Z",
          },
        ]);
      }),
    );

    it.effect("the reads answer about the thread's output and worktree", () =>
      Effect.gen(function* () {
        const threadId = yield* spawn("reads");
        const threads = yield* ThreadGateway;
        const engine = yield* boardStackEngine;
        assert.isNull(yield* threads.latestAssistantMessage(threadId));
        yield* engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("cmd-contract-message"),
          threadId,
          messageId: MessageId.make("msg-contract-reads"),
          delta: "Which branch should I use?",
          createdAt: "2026-01-01T00:20:00.000Z",
        });
        assert.deepStrictEqual(yield* threads.latestAssistantMessage(threadId), {
          text: "Which branch should I use?",
          createdAt: "2026-01-01T00:20:00.000Z",
        });
        assert.strictEqual(yield* threads.lastSignalAt(threadId), "2026-01-01T00:20:00.000Z");

        const inWorktree = yield* threads.threadsInWorktree("/tmp/wt/reads/");
        assert.deepStrictEqual(inWorktree, [{ threadId, deleted: false, sessionLive: false }]);
        assert.deepStrictEqual(yield* threads.threadsInWorktree("/tmp/wt/elsewhere"), []);
      }),
    );

    it.effect("projects are listed, and one reads back with its root", () =>
      Effect.gen(function* () {
        yield* ensureProject;
        const threads = yield* ThreadGateway;
        const listed = (yield* threads.projects()).find((project) => project.id === projectId);
        assert.deepInclude(listed, {
          id: projectId,
          title: "Contract project",
          workspaceRoot,
          deleted: false,
        });
        const detail = yield* threads.project(projectId);
        assert.strictEqual(detail?.workspaceRoot, workspaceRoot);
        assert.isNull(yield* threads.project(ProjectId.make("project-missing")));
      }),
    );
  },
);

it("provider runtime events become the board's turn and question signals", () => {
  const threadId = ThreadId.make("thread-runtime");
  const base = { eventId: "evt", provider: "codex", threadId, createdAt: t0 };
  const signal = (event: object): ThreadSignal | null =>
    runtimeSignal({ ...base, ...event } as unknown as ProviderRuntimeEvent);

  assert.deepStrictEqual(
    signal({
      type: "turn.completed",
      turnId: TurnId.make("turn-1"),
      payload: { state: "failed", errorMessage: "You have hit your usage limit." },
    }),
    {
      type: "turn-ended",
      threadId,
      turnRef: "turn-1",
      outcome: "failed",
      errorMessage: "You have hit your usage limit.",
    },
  );
  assert.deepStrictEqual(signal({ type: "turn.completed", payload: { state: "completed" } }), {
    type: "turn-ended",
    threadId,
    turnRef: undefined,
    outcome: "completed",
    errorMessage: null,
  });
  assert.deepStrictEqual(signal({ type: "user-input.requested", payload: {} }), {
    type: "input-requested",
    threadId,
  });
  // An answer and a cancellation are the same runtime event; only the answer
  // set tells them apart.
  assert.deepStrictEqual(
    signal({ type: "user-input.resolved", payload: { answers: { "Which one?": "A" } } }),
    { type: "input-resolved", threadId, answered: true },
  );
  assert.deepStrictEqual(signal({ type: "user-input.resolved", payload: { answers: {} } }), {
    type: "input-resolved",
    threadId,
    answered: false,
  });
  assert.deepStrictEqual(signal({ type: "session.started", payload: {} }), {
    type: "session-started",
    threadId,
  });
  // A turn STARTING is deliberately not a signal (t3o-34, D5): adapters
  // synthesise it for background output nobody asked for.
  assert.isNull(signal({ type: "turn.started", payload: {} }));
});
