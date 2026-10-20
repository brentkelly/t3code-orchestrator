/**
 * The thread gateway's contract, run against `ThreadGatewayV2` on the real
 * orchestration-v2 stack (T3O-58, T3O-59).
 *
 * Everything the board relies on the thread engine for, stated in the gateway's
 * own vocabulary: what a spawn leaves behind, which commands are refused, what
 * signals the engine's own events become, and what the reads answer.
 *
 * Signals are checked against the events the real engine LOGGED for each
 * command, not hand-built ones, so a drift in upstream's event shapes fails
 * here rather than silently in the supervisor. The stack runs no provider, so
 * what a provider would write (a plan, an assistant message) is written to the
 * engine's own event sink, which projects it exactly as a provider's would.
 */
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import { boardStackEngine, makeBoardStackTestLayer } from "./boardStack.testkit.ts";
import { ThreadGateway, type ThreadSignal, type TodoLogEntry } from "./ThreadGateway.ts";
import { makeSignalReader } from "./ThreadGatewayV2.ts";

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

/** A thread with no turn at all: nothing queued, nothing running. */
const createIdleThread = Effect.fn("createIdleThread")(function* (tag: string) {
  yield* ensureProject;
  const engine = yield* boardStackEngine;
  const threadId = ThreadId.make(`thread-contract-${tag}`);
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`cmd-contract-${tag}`),
    threadId,
    projectId,
    title: tag,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
  return threadId;
});

/** The engine's log since `after`. */
const loggedSince = (after: number) =>
  Effect.gen(function* () {
    const engine = yield* boardStackEngine;
    const head = yield* engine.latestSequence;
    const events = yield* Stream.runCollect(engine.readEvents(after, head));
    return [...events] as ReadonlyArray<OrchestrationV2StoredEvent>;
  });

const signalsOf = (events: ReadonlyArray<OrchestrationV2StoredEvent>) => {
  const read = makeSignalReader();
  return events.flatMap((event) => {
    const signal = read(event);
    return signal === null ? [] : [signal];
  });
};

const head = Effect.flatMap(boardStackEngine, (engine) => engine.latestSequence);

/** Write what a provider would, through the engine's own sink. */
const providerWrites = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  Effect.flatMap(EventSink.EventSinkV2, (sink) => sink.write({ events })).pipe(Effect.orDie);

/** The tag a failed command failed with, or null when it succeeded. */
const refusalTag = (exit: Exit.Exit<unknown, { readonly _tag: string }>) =>
  Exit.isFailure(exit)
    ? Option.getOrNull(Option.map(Cause.findErrorOption(exit.cause), (error) => error._tag))
    : null;

const at = (iso: string) => DateTime.makeUnsafe(iso);
const withoutAt = (signals: ReadonlyArray<ThreadSignal>) =>
  signals.map((signal) =>
    signal.type === "turn-requested" || signal.type === "todos-changed"
      ? { ...signal, at: "" }
      : signal,
  );

it.layer(makeBoardStackTestLayer("t3o-thread-gateway-contract-"))(
  "ThreadGatewayV2 contract",
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
        assert.isNull(state!.usageLimit);
        // No provider runs in this stack, so the turn never starts: it is
        // requested, and its run holds the thread live while it waits.
        assert.isNotNull(yield* threads.pendingTurnStartAt(threadId));
        assert.isTrue(state!.alive);

        const records = yield* threads.threadRecords([threadId]);
        assert.deepStrictEqual(records.get(threadId), {
          threadId,
          deleted: false,
          archived: false,
          settlementDecided: false,
        });
        assert.include(yield* threads.listLiveThreadIds(), threadId);

        // The turn the spawn asked for reads as the BOARD's, never a human's.
        const requested = signalsOf(yield* loggedSince(before)).filter(
          (signal) => signal.type === "turn-requested",
        );
        assert.deepStrictEqual(withoutAt(requested), [
          { type: "turn-requested", threadId, byBoard: true, at: "" },
        ]);
      }),
    );

    it.effect("a planning spawn runs in the project root, with no worktree of its own (D6)", () =>
      Effect.gen(function* () {
        yield* ensureProject;
        const threads = yield* ThreadGateway;
        const threadId = ThreadId.make("thread-contract-planning");
        yield* threads.spawn({
          commandId: boardCommandId("spawn-thread"),
          threadId,
          projectId,
          title: "Planning",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: workspaceRoot,
          text: "Plan it.",
          attachments: [],
        });
        assert.isNull((yield* threads.threadState(threadId))!.worktreePath);
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

    it.effect("a board turn on an idle thread is the board's, and takes the stage's modes", () =>
      Effect.gen(function* () {
        const threadId = yield* createIdleThread("sent");
        const threads = yield* ThreadGateway;
        const before = yield* head;
        yield* threads.send({
          commandId: boardCommandId("recover-turn"),
          threadId,
          text: "Carry on.",
          attachments: [],
          runtimeMode: "approval-required",
          interactionMode: "plan",
        });
        assert.deepStrictEqual(withoutAt(signalsOf(yield* loggedSince(before))), [
          { type: "turn-requested", threadId, byBoard: true, at: "" },
        ]);
        const shell = yield* threads.threadState(threadId);
        assert.isNotNull(yield* threads.pendingTurnStartAt(threadId));
        assert.isTrue(shell!.alive);
      }),
    );

    it.effect("an interrupt reaches the engine, and one with no run is refused", () =>
      Effect.gen(function* () {
        const threadId = yield* spawn("interrupted");
        const threads = yield* ThreadGateway;
        const before = yield* head;
        yield* threads.interrupt({ commandId: boardCommandId("interrupt-paused"), threadId });
        const signals = signalsOf(yield* loggedSince(before));
        // A run interrupted before its provider started ends there and then.
        assert.isTrue(
          signals.some(
            (signal) =>
              (signal.type === "turn-ended" && signal.outcome === "interrupted") ||
              signal.type === "interrupt-requested",
          ),
          JSON.stringify(signals),
        );
        assert.isNull((yield* threads.threadState(threadId))!.activeTurnRef);

        const idle = yield* createIdleThread("interrupt-idle");
        const exit = yield* Effect.exit(
          threads.interrupt({ commandId: boardCommandId("interrupt-paused"), threadId: idle }),
        );
        assert.strictEqual(refusalTag(exit), "ThreadCommandRefusedError");
      }),
    );

    it.effect("a turn a human asked for is not the board's", () =>
      Effect.gen(function* () {
        const threadId = yield* createIdleThread("human");
        const engine = yield* boardStackEngine;
        const before = yield* head;
        yield* engine.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("8c7f0f0e-6d2b-4a5e-9a1d-0f2b3c4d5e6f"),
          threadId,
          messageId: MessageId.make("msg-contract-human"),
          text: "Let me steer.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        assert.deepStrictEqual(withoutAt(signalsOf(yield* loggedSince(before))), [
          { type: "turn-requested", threadId, byBoard: false, at: "" },
        ]);
      }),
    );

    it.effect("a thread whose first turn is still waiting to start refuses a settle", () =>
      Effect.gen(function* () {
        const threadId = yield* spawn("queued");
        const threads = yield* ThreadGateway;
        for (const auto of [true, false]) {
          const exit = yield* Effect.exit(
            threads.settle({ commandId: boardCommandId("release-thread"), threadId, auto }),
          );
          assert.strictEqual(refusalTag(exit), "ThreadCommandRefusedError");
        }
        assert.isFalse((yield* threads.threadRecords([threadId])).get(threadId)!.settlementDecided);
      }),
    );

    it.effect("a settle is recorded; an automatic one refuses a thread already settled", () =>
      Effect.gen(function* () {
        const threadId = yield* createIdleThread("settled");
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

    it.effect("an automatic settle settles a candidate", () =>
      Effect.gen(function* () {
        const threadId = yield* createIdleThread("auto-settled");
        const threads = yield* ThreadGateway;
        yield* threads.settle({
          commandId: boardCommandId("release-thread"),
          threadId,
          auto: true,
        });
        assert.isTrue((yield* threads.threadState(threadId))!.settlementDecided);
      }),
    );

    // Candidacy is re-checked at dispatch, so a thread that stopped being a
    // candidate since — here, snoozed — is refused.
    it.effect("an automatic settle refuses a thread that is no longer a candidate", () =>
      Effect.gen(function* () {
        const threadId = yield* createIdleThread("snoozed");
        const threads = yield* ThreadGateway;
        const engine = yield* boardStackEngine;
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
        const threadId = yield* createIdleThread("deleted");
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

    it.effect("a todo list is a todo signal carrying its steps, in the board's vocabulary", () =>
      Effect.gen(function* () {
        const threadId = yield* createIdleThread("todos");
        const threads = yield* ThreadGateway;
        const before = yield* threads.todoLogHead;
        yield* providerWrites([
          {
            type: "plan.updated",
            id: EventId.make("evt-contract-plan"),
            threadId,
            occurredAt: at("2026-01-01T00:10:00.000Z"),
            payload: {
              id: PlanId.make("plan-contract"),
              threadId,
              runId: null,
              nodeId: NodeId.make("node-contract-plan"),
              status: "active",
              kind: "todo_list",
              steps: [
                { id: "s1", text: "Read the code", status: "completed" },
                { id: "s2", text: "Write the fix", status: "running" },
                { id: "s3", text: "Ship it", status: "pending" },
              ],
            },
          } as unknown as OrchestrationV2DomainEvent,
        ]);
        const logged = yield* Stream.runCollect(
          threads.readTodoLog(before, yield* threads.todoLogHead),
        );
        assert.deepStrictEqual(
          [...logged].flatMap((entry) => (entry.signal === null ? [] : [entry.signal])),
          [
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
          ],
        );
      }),
    );

    it.effect("the live todo tail attaches before the head is read, losing nothing", () =>
      Effect.gen(function* () {
        const threadId = yield* createIdleThread("todo-tail");
        const threads = yield* ThreadGateway;
        const entries = yield* Effect.scoped(
          Effect.gen(function* () {
            const tail = yield* threads.subscribeTodoLog;
            yield* threads.delete({ commandId: boardCommandId("delete-card-thread"), threadId });
            return yield* Stream.runCollect(
              tail.pipe(
                Stream.filter((entry) => entry.signal !== null),
                Stream.take(1),
              ),
            );
          }),
        );
        assert.deepStrictEqual(
          [...entries].map((entry) => entry.signal),
          [{ type: "thread-deleted", threadId }],
        );
      }),
    );

    it.effect("the reads answer about the thread's output and worktree", () =>
      Effect.gen(function* () {
        const threadId = yield* spawn("reads");
        const threads = yield* ThreadGateway;
        assert.isNull(yield* threads.latestAssistantMessage(threadId));
        assert.isNotNull(yield* threads.lastSignalAt(threadId));

        const inWorktree = yield* threads.threadsInWorktree("/tmp/wt/reads/");
        assert.deepStrictEqual(
          inWorktree.map((entry) => ({ threadId: entry.threadId, deleted: entry.deleted })),
          [{ threadId, deleted: false }],
        );
        assert.deepStrictEqual(yield* threads.threadsInWorktree("/tmp/wt/elsewhere"), []);
      }),
    );

    // T3O-12: the timeout sweep's life sign moves with the agent's output, here
    // a todo list rewritten deep in a turn that writes no prose.
    it.effect("the last signal moves with the thread's activity", () =>
      Effect.gen(function* () {
        const threadId = yield* spawn("signal");
        const threads = yield* ThreadGateway;
        const before = yield* threads.lastSignalAt(threadId);
        assert.isNotNull(before);
        yield* providerWrites([
          {
            type: "plan.updated",
            id: EventId.make("evt-contract-signal-plan"),
            threadId,
            occurredAt: at("2099-01-01T00:00:00.000Z"),
            payload: {
              id: PlanId.make("plan-contract-signal"),
              threadId,
              runId: null,
              nodeId: NodeId.make("node-contract-signal"),
              status: "active",
              kind: "todo_list",
              steps: [{ id: "s1", text: "Keep going", status: "running" }],
            },
          } as unknown as OrchestrationV2DomainEvent,
        ]);
        const after = yield* threads.lastSignalAt(threadId);
        assert.isTrue(after! > before!, `${before} -> ${after}`);
      }),
    );

    // T3O-18: a turn exists from the moment it is asked for, and is pending
    // until it runs. Without this, the previous turn's completion parks a step
    // whose human has already sent the next message.
    it.effect("a requested turn is pending until it runs, and not once it is gone", () =>
      Effect.gen(function* () {
        const threadId = yield* createIdleThread("pending");
        const threads = yield* ThreadGateway;
        const engine = yield* boardStackEngine;
        assert.isNull(yield* threads.pendingTurnStartAt(threadId));
        yield* engine.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd-contract-pending-turn"),
          threadId,
          messageId: MessageId.make("msg-contract-pending"),
          text: "Next, please.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        assert.isNotNull(yield* threads.pendingTurnStartAt(threadId));
        yield* threads.interrupt({ commandId: boardCommandId("interrupt-paused"), threadId });
        assert.isNull(yield* threads.pendingTurnStartAt(threadId));
      }),
    );

    it.effect("a thread that is not limited has no recovery to arm", () =>
      Effect.gen(function* () {
        const threadId = yield* createIdleThread("unlimited");
        const threads = yield* ThreadGateway;
        assert.isFalse(
          yield* threads.armLimitRecovery({ commandId: boardCommandId("limit-arm"), threadId }),
        );
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
        assert.deepStrictEqual(listed?.scripts, []);
        const detail = yield* threads.project(projectId);
        assert.strictEqual(detail?.workspaceRoot, workspaceRoot);
        assert.isNull(yield* threads.project(ProjectId.make("project-missing")));
      }),
    );
  },
);
