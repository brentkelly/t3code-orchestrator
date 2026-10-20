/**
 * An in-memory `ThreadGateway` (T3O-58), for suites that stub the board's
 * world rather than build the real stack.
 *
 * It models the thread engine only as far as the board depends on it:
 *
 * - **Records** are the threads that exist — what the decider and the release
 *   sweep read. A spawn adds one; a delete removes it.
 * - **States** are what `threadState` answers — the live view the supervisor
 *   decides on. A spawned thread has a record but NO state until a test sets
 *   one, so "is it alive" is always the fixture's explicit answer.
 * - Two invariants are enforced, because the board relies on them: a turn
 *   cannot be sent to a thread that does not exist, and a settle is refused
 *   while the thread is mid-turn (and an automatic one once a thread is
 *   already settled).
 *
 * Every call is recorded in order, refused or not, so a test can assert HOW a
 * thread was steered as well as what came of it.
 */
import { ProjectId, ProviderInstanceId, ThreadId, type ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  deletedThreadState,
  ThreadCommandRefusedError,
  ThreadGateway,
  type BoardAssistantMessage,
  type BoardProjectDetail,
  type BoardSessionStatus,
  type BoardThreadRecord,
  type BoardThreadState,
  type ThreadGatewayShape,
  type ThreadSendInput,
  type ThreadSettleInput,
  type ThreadSignal,
  type ThreadSpawnInput,
  type ThreadTargetInput,
  type TodoLogEntry,
  type TodoSignal,
} from "./ThreadGateway.ts";

/** One call the board made, in gateway vocabulary. */
export type ThreadGatewayCall =
  | ({ readonly type: "thread.spawn" } & ThreadSpawnInput)
  | ({ readonly type: "thread.send" } & ThreadSendInput)
  | ({ readonly type: "thread.interrupt" } & ThreadTargetInput)
  | ({ readonly type: "thread.stop-session" } & ThreadTargetInput)
  | ({ readonly type: "thread.settle" } & ThreadSettleInput)
  | ({ readonly type: "thread.delete" } & ThreadTargetInput);

/** The fields a fixture sets on a thread; everything derived is computed. */
export interface FakeThreadInput {
  readonly projectId?: ProjectId;
  readonly sessionStatus?: BoardSessionStatus;
  readonly activeTurnRef?: string | null;
  readonly awaitingUserInput?: boolean;
  /** A permission prompt is outstanding. Answerable only mid-turn. */
  readonly pendingApproval?: boolean;
  readonly backgroundWork?: "working" | "monitoring" | null;
  readonly archived?: boolean;
  readonly settlementDecided?: boolean;
  readonly worktreePath?: string | null;
  readonly modelSelection?: ModelSelection | null;
}

const DEFAULT_PROJECT_ID = ProjectId.make("project-1");

const DEFAULT_MODEL_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

/**
 * A thread state with the derived fields computed the way the v1 gateway
 * computes them, so a fixture states facts and never a contradiction.
 */
export const fakeThreadState = (
  threadId: string,
  input: FakeThreadInput = {},
): BoardThreadState => {
  const sessionStatus = input.sessionStatus ?? "idle";
  const activeTurnRef = input.activeTurnRef ?? null;
  const awaitingUserInput = input.awaitingUserInput ?? false;
  const backgroundWork = input.backgroundWork ?? null;
  const archived = input.archived ?? false;
  const settlementDecided = input.settlementDecided ?? false;
  const midTurn = sessionStatus === "starting" || sessionStatus === "running";
  const awaitingPermission = (input.pendingApproval ?? false) && midTurn;
  const failed = sessionStatus === "error";
  return {
    threadId: ThreadId.make(threadId),
    projectId: input.projectId ?? DEFAULT_PROJECT_ID,
    deleted: false,
    archived,
    settlementDecided,
    sessionStatus,
    activeTurnRef,
    awaitingUserInput,
    awaitingPermission,
    backgroundWork,
    alive: !failed && (awaitingUserInput || activeTurnRef !== null),
    waitingOnBackground:
      !awaitingUserInput && !awaitingPermission && !midTurn && !failed && backgroundWork !== null,
    autoSettleCandidate:
      !archived &&
      !settlementDecided &&
      !(input.pendingApproval ?? false) &&
      !awaitingUserInput &&
      !midTurn &&
      backgroundWork === null,
    worktreePath: input.worktreePath ?? null,
    modelSelection:
      input.modelSelection === undefined ? DEFAULT_MODEL_SELECTION : input.modelSelection,
  };
};

/** A thread mid-turn: what boot reconcile must read as ALIVE. */
export const aliveThread = (threadId: string, input: FakeThreadInput = {}) =>
  fakeThreadState(threadId, { sessionStatus: "running", activeTurnRef: "turn-live", ...input });

/** A thread as a server restart leaves it (t3o-10): the session is marked
    `error` while the killed turn's ref LINGERS — the stale ref is the point
    of the fixture, it is what used to read as alive. */
export const failedThread = (
  threadId: string,
  options?: { readonly staleActiveTurnRef?: boolean },
) =>
  fakeThreadState(threadId, {
    sessionStatus: "error",
    activeTurnRef: options?.staleActiveTurnRef === false ? null : "turn-killed",
  });

/** A thread between turns: the agent has stopped, nothing is pending. */
export const idleThread = (
  threadId: string,
  instanceId: ProviderInstanceId = ProviderInstanceId.make("codex"),
) =>
  fakeThreadState(threadId, {
    sessionStatus: "idle",
    modelSelection: { instanceId, model: "gpt-5-codex" },
  });

export interface FakeThreadGatewayOptions {
  readonly projects?: ReadonlyArray<BoardProjectDetail>;
  /** Threads that exist before the test starts, with their live view. */
  readonly threads?: ReadonlyMap<string, BoardThreadState>;
  /** Refuse every spawn — a thread the engine will not create. */
  readonly rejectSpawn?: boolean;
  /** Runs before every call is recorded and applied. */
  readonly onCall?: (call: ThreadGatewayCall) => Effect.Effect<void>;
  readonly latestAssistantMessage?: (threadId: ThreadId) => BoardAssistantMessage | null;
  readonly lastSignalAt?: (threadId: ThreadId) => string | null;
  readonly pendingTurnStartAt?: (threadId: ThreadId) => string | null;
}

interface FakeRecord extends BoardThreadRecord {
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
}

export interface FakeThreadGateway {
  readonly gateway: ThreadGatewayShape;
  readonly layer: Layer.Layer<ThreadGateway>;
  /** Every call, in order, refused ones included. */
  readonly calls: Effect.Effect<ReadonlyArray<ThreadGatewayCall>>;
  /** What `threadState` answers. Set one to change a thread's live view. */
  readonly states: Ref.Ref<ReadonlyMap<string, BoardThreadState>>;
  /** Threads that actually settled, as opposed to every settle asked for. */
  readonly settled: Effect.Effect<ReadonlySet<string>>;
  /** Deliver a live signal to `observe`. Buffered, so it is never lost to a
      subscriber that has not attached yet. */
  readonly emit: (signal: ThreadSignal) => Effect.Effect<void>;
  /** Append a todo signal to the durable todo log. */
  readonly appendTodo: (signal: TodoSignal | null) => Effect.Effect<number>;
}

const recordOf = (state: BoardThreadState): FakeRecord => ({
  threadId: state.threadId,
  projectId: state.projectId,
  worktreePath: state.worktreePath,
  deleted: state.deleted,
  archived: state.archived,
  settlementDecided: state.settlementDecided,
});

export const makeFakeThreadGateway = (options: FakeThreadGatewayOptions = {}) =>
  Effect.gen(function* () {
    const initial = options.threads ?? new Map<string, BoardThreadState>();
    const states = yield* Ref.make<ReadonlyMap<string, BoardThreadState>>(initial);
    const records = yield* Ref.make<ReadonlyMap<string, FakeRecord>>(
      new Map([...initial.entries()].map(([id, state]) => [id, recordOf(state)])),
    );
    const calls = yield* Ref.make<ReadonlyArray<ThreadGatewayCall>>([]);
    const settled = yield* Ref.make<ReadonlySet<string>>(new Set());
    const signals = yield* Queue.unbounded<ThreadSignal>();
    const todoLog = yield* Ref.make<ReadonlyArray<TodoLogEntry>>([]);
    const todoPubSub = yield* PubSub.unbounded<TodoLogEntry>();
    const projects = options.projects ?? [];

    const record = (call: ThreadGatewayCall) =>
      (options.onCall?.(call) ?? Effect.void).pipe(
        Effect.andThen(Ref.update(calls, (current) => [...current, call])),
      );

    const refuse = (command: string, threadId: ThreadId, detail: string) =>
      Effect.fail(new ThreadCommandRefusedError({ command, threadId, detail }));

    /** Present and not deleted — a thread a command can still target. */
    const exists = (threadId: ThreadId) =>
      Effect.all([Ref.get(records), Ref.get(states)]).pipe(
        Effect.map(
          ([currentRecords, currentStates]) =>
            !(
              currentRecords.get(String(threadId))?.deleted ??
              currentStates.get(String(threadId))?.deleted ??
              true
            ),
        ),
      );

    const updateRecord = (threadId: ThreadId, change: (record: FakeRecord) => FakeRecord) =>
      Ref.update(records, (current) => {
        const existing = current.get(String(threadId));
        if (existing === undefined) return current;
        return new Map(current).set(String(threadId), change(existing));
      });

    const gateway: ThreadGatewayShape = {
      spawn: (input) =>
        Effect.gen(function* () {
          yield* record({ type: "thread.spawn", ...input });
          if (options.rejectSpawn === true) {
            return yield* refuse("spawn", input.threadId, "Refusing to create the thread.");
          }
          yield* Ref.update(records, (current) =>
            new Map(current).set(String(input.threadId), {
              threadId: input.threadId,
              projectId: input.projectId,
              worktreePath: input.worktreePath,
              deleted: false,
              archived: false,
              settlementDecided: false,
            }),
          );
        }),
      send: (input) =>
        Effect.gen(function* () {
          yield* record({ type: "thread.send", ...input });
          if (!(yield* exists(input.threadId))) {
            return yield* refuse("send", input.threadId, "The thread does not exist.");
          }
        }),
      interrupt: (input) => record({ type: "thread.interrupt", ...input }),
      stopSession: (input) => record({ type: "thread.stop-session", ...input }),
      settle: (input) =>
        Effect.gen(function* () {
          yield* record({ type: "thread.settle", ...input });
          const state = (yield* Ref.get(states)).get(String(input.threadId));
          if (state?.sessionStatus === "starting" || state?.sessionStatus === "running") {
            return yield* refuse("settle", input.threadId, "The thread is busy.");
          }
          if (input.auto && (yield* Ref.get(settled)).has(String(input.threadId))) {
            return yield* refuse("settle", input.threadId, "Already settled.");
          }
          yield* Ref.update(settled, (current) => new Set(current).add(String(input.threadId)));
          yield* updateRecord(input.threadId, (current) => ({
            ...current,
            settlementDecided: true,
          }));
        }),
      delete: (input) =>
        Effect.gen(function* () {
          yield* record({ type: "thread.delete", ...input });
          // As the real engine does: the thread stays readable, as deleted.
          const id = String(input.threadId);
          const projectId =
            (yield* Ref.get(records)).get(id)?.projectId ??
            (yield* Ref.get(states)).get(id)?.projectId;
          if (projectId === undefined) return;
          yield* updateRecord(input.threadId, (current) => ({ ...current, deleted: true }));
          yield* Ref.update(states, (current) =>
            new Map(current).set(id, deletedThreadState(input.threadId, projectId)),
          );
        }),

      threadState: (threadId) =>
        Ref.get(states).pipe(Effect.map((current) => current.get(String(threadId)) ?? null)),
      threadRecords: (threadIds) =>
        Ref.get(records).pipe(
          Effect.map((current) => {
            const found = new Map<ThreadId, BoardThreadRecord>();
            for (const threadId of threadIds) {
              const entry = current.get(String(threadId));
              if (entry !== undefined) found.set(threadId, entry);
            }
            return found;
          }),
        ),
      threadsInWorktree: (worktreePath) =>
        Effect.all([Ref.get(records), Ref.get(states)]).pipe(
          Effect.map(([currentRecords, currentStates]) =>
            [...currentRecords.values()]
              .filter((entry) => entry.worktreePath === worktreePath)
              .map((entry) => {
                const status = currentStates.get(String(entry.threadId))?.sessionStatus ?? "none";
                return {
                  threadId: entry.threadId,
                  deleted: entry.deleted,
                  sessionLive: status !== "none" && status !== "stopped",
                };
              }),
          ),
        ),
      listLiveThreadIds: () =>
        Ref.get(records).pipe(
          Effect.map((current) =>
            [...current.values()].filter((entry) => !entry.deleted).map((entry) => entry.threadId),
          ),
        ),
      latestAssistantMessage: (threadId) =>
        Effect.succeed(options.latestAssistantMessage?.(threadId) ?? null),
      lastSignalAt: (threadId) => Effect.succeed(options.lastSignalAt?.(threadId) ?? null),
      pendingTurnStartAt: (threadId) =>
        Effect.succeed(options.pendingTurnStartAt?.(threadId) ?? null),

      projects: () => Effect.succeed(projects),
      project: (projectId) =>
        Effect.succeed(projects.find((project) => project.id === projectId) ?? null),

      observe: Stream.fromQueue(signals),

      todoLogHead: Ref.get(todoLog).pipe(Effect.map((log) => log.length)),
      readTodoLog: (after, upTo) =>
        Stream.unwrap(
          Ref.get(todoLog).pipe(
            Effect.map((log) =>
              Stream.fromIterable(
                log.filter((entry) => entry.cursor > after && entry.cursor <= upTo),
              ),
            ),
          ),
        ),
      subscribeTodoLog: PubSub.subscribe(todoPubSub).pipe(Effect.map(Stream.fromSubscription)),
    };

    return {
      gateway,
      layer: Layer.succeed(ThreadGateway, gateway),
      calls: Ref.get(calls),
      states,
      settled: Ref.get(settled),
      emit: (signal) => Queue.offer(signals, signal).pipe(Effect.asVoid),
      appendTodo: (signal) =>
        Effect.gen(function* () {
          const log = yield* Ref.updateAndGet(todoLog, (current) => [
            ...current,
            { cursor: current.length + 1, signal },
          ]);
          const entry = log[log.length - 1]!;
          yield* PubSub.publish(todoPubSub, entry);
          return entry.cursor;
        }),
    } satisfies FakeThreadGateway;
  });

/** A gateway that knows nothing and refuses nothing — for suites whose
    subject never touches a thread. */
export const inertThreadGateway = (
  overrides: Partial<ThreadGatewayShape> = {},
): ThreadGatewayShape => ({
  spawn: () => Effect.void,
  send: () => Effect.void,
  interrupt: () => Effect.void,
  stopSession: () => Effect.void,
  settle: () => Effect.void,
  delete: () => Effect.void,
  threadState: () => Effect.succeed(null),
  threadRecords: () => Effect.succeed(new Map()),
  threadsInWorktree: () => Effect.succeed([]),
  listLiveThreadIds: () => Effect.succeed([]),
  latestAssistantMessage: () => Effect.succeed(null),
  lastSignalAt: () => Effect.succeed(null),
  pendingTurnStartAt: () => Effect.succeed(null),
  projects: () => Effect.succeed([]),
  project: () => Effect.succeed(null),
  observe: Stream.never,
  todoLogHead: Effect.succeed(0),
  readTodoLog: () => Stream.empty,
  subscribeTodoLog: Effect.succeed(Stream.never),
  ...overrides,
});
