/**
 * What a worker answers when a central server drives its threads. It serves this
 * server's own threads, never the board router: a worker that is itself a board
 * must not hand its own workers' threads on. Spawn and relay calls take the
 * caller's session, since a board is only the environment id its session claims.
 */
import {
  BoardWorkerGatewayError,
  type AuthSessionId,
  type BoardGatewaySpawnInput,
  type BoardMcpRelayRequest,
  type BoardMcpRelayResponse,
  type EnvironmentId,
  type BoardStageAttachmentsInput,
  type BoardWorkerCiProgress,
  type BoardStageAttachmentsResult,
  type BoardCardId,
  type BoardCapacityClaimInput,
  type BoardCapacityClaimResult,
  type BoardGatewaySendInput,
  type BoardSyncCardsInput,
  type BoardSyncCardsResult,
  type BoardWorkerCapacitySnapshot,
  type BoardCardSetupProgress,
  type BoardWorkerCheckReadinessInput,
  type BoardWorkerReadiness,
  type BoardWorkerRunSetupInput,
  type BoardWorkerSetupState,
  type BoardStepReading,
  type BoardWorkerActualsInput,
  type BoardCapacityHoldInput,
  type BoardCapacityHoldResult,
  type BoardWorkerReadCiLogInput,
  type BoardWorkerRunCiInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as Base64 from "effect/encoding/Base64";

import * as ServerConfig from "../../config.ts";
import { boardCardAttachmentsDir, resolveBoardCardAttachmentPath } from "../attachments.ts";
import { LocalThreadGateway, type TodoLogEntry } from "../ThreadGateway.ts";
import { BoardRelayStore } from "./BoardRelayStore.ts";
import { BoardActualsMeter } from "../actuals/BoardActualsMeter.ts";
import {
  toWireReadError,
  toWireSignal,
  wireCommand,
  wireRead,
  type WireTodoLogEntry,
  type WorkerGatewayRpcOf,
} from "./gatewayWire.ts";
import {
  BoardWorkerCapacity,
  type BoardWorkerCapacityShape,
} from "../capacity/BoardWorkerCapacity.ts";
import { McpRelayHost, type McpRelayRefused } from "./McpRelayHost.ts";
import { BoardCiRunner, boardCiLogDir } from "../ci/BoardCiRunner.ts";
import { toWireCiDone } from "../ci/remoteCiRunner.ts";
import { isSafeBoardCiLogTarget, readBoardCiLogFile } from "../ci/ciLog.ts";

type CallerBound =
  | "spawn"
  | "send"
  | "subscribeMcpRelay"
  | "mcpRelayRespond"
  | "claimCapacity"
  | "hold"
  | "releaseHold"
  | "syncCards"
  | "subscribeCapacity"
  | "runSetup"
  | "setupState"
  | "cancelSetup"
  | "readSetupLog"
  | "checkReadiness"
  | "readinessOutput"
  | "actuals"
  | ThreadMutation
  | "runCi"
  | "readCiLog";

/** The calls that change a thread: only the board that placed it may make them. */
type ThreadMutation =
  | "interrupt"
  | "stopSession"
  | "settle"
  | "delete"
  | "armLimitRecovery"
  | "answerPendingInput"
  | "linkPullRequest"
  | "unlinkPullRequest";

type Rpc = WorkerGatewayRpcOf<BoardWorkerGatewayError>;
type WithCaller<K extends keyof Rpc> = Rpc[K] extends (input: infer I) => infer R
  ? (input: I, caller: GatewayCaller) => R
  : never;

/** Who is calling: the session, and the board its `t3o-board:<id>` subject names (T3O-86). */
export interface GatewayCaller {
  readonly sessionId: AuthSessionId;
  readonly boardId: string | null;
}

const withoutUsage = (entry: TodoLogEntry): WireTodoLogEntry =>
  entry.signal?.type === "usage-recorded"
    ? { cursor: entry.cursor, signal: null }
    : { cursor: entry.cursor, signal: entry.signal };

/** The host fails only with the worker's own error: there is no wire
    between it and the gateway it serves. The calls that speak for a board
    also take the session making them. */
export type WorkerGatewayHostShape = Omit<
  WorkerGatewayRpcOf<BoardWorkerGatewayError>,
  CallerBound
> & {
  readonly spawn: (
    input: BoardGatewaySpawnInput,
    caller: GatewayCaller,
  ) => Effect.Effect<void, BoardWorkerGatewayError>;
  readonly send: (
    input: BoardGatewaySendInput,
    caller: GatewayCaller,
  ) => Effect.Effect<void, BoardWorkerGatewayError>;
  readonly claimCapacity: (
    input: BoardCapacityClaimInput,
    caller: GatewayCaller,
  ) => Effect.Effect<BoardCapacityClaimResult, BoardWorkerGatewayError>;
  readonly syncCards: (
    input: BoardSyncCardsInput,
    caller: GatewayCaller,
  ) => Effect.Effect<BoardSyncCardsResult, BoardWorkerGatewayError>;
  /** T3o: a hold for one of the calling board's cards (T3O-87). */
  readonly hold: (
    input: BoardCapacityHoldInput,
    caller: GatewayCaller,
  ) => Effect.Effect<BoardCapacityHoldResult, BoardWorkerGatewayError>;
  readonly releaseHold: (
    cardId: string,
    caller: GatewayCaller,
  ) => Effect.Effect<void, BoardWorkerGatewayError>;
  readonly subscribeCapacity: (
    caller: GatewayCaller,
  ) => Stream.Stream<BoardWorkerCapacitySnapshot, BoardWorkerGatewayError>;
  readonly runSetup: (
    input: BoardWorkerRunSetupInput,
    caller: GatewayCaller,
  ) => Stream.Stream<BoardCardSetupProgress, BoardWorkerGatewayError>;
  readonly setupState: (
    worktreePath: string,
    caller: GatewayCaller,
  ) => Effect.Effect<BoardWorkerSetupState, BoardWorkerGatewayError>;
  readonly cancelSetup: (
    worktreePath: string,
    caller: GatewayCaller,
  ) => Effect.Effect<void, BoardWorkerGatewayError>;
  readonly readSetupLog: (
    worktreePath: string,
    caller: GatewayCaller,
  ) => Effect.Effect<string, BoardWorkerGatewayError>;
  readonly checkReadiness: (
    input: BoardWorkerCheckReadinessInput,
    caller: GatewayCaller,
  ) => Effect.Effect<BoardWorkerReadiness, BoardWorkerGatewayError>;
  readonly readinessOutput: (
    repositoryKey: string | null,
    path: string,
    caller: GatewayCaller,
  ) => Effect.Effect<string | null, BoardWorkerGatewayError>;
  /** T3o: a step's measured actuals, for a board's own session (T3O-87). */
  readonly actuals: (
    input: BoardWorkerActualsInput,
    caller: GatewayCaller,
  ) => Effect.Effect<BoardStepReading | null, BoardWorkerGatewayError>;
  readonly subscribeMcpRelay: (
    centralEnvironmentId: EnvironmentId,
    caller: AuthSessionId,
  ) => Stream.Stream<BoardMcpRelayRequest, BoardWorkerGatewayError>;
  readonly mcpRelayRespond: (
    response: BoardMcpRelayResponse,
    caller: AuthSessionId,
  ) => Effect.Effect<void, BoardWorkerGatewayError>;
  readonly runCi: WithCaller<"runCi">;
  readonly readCiLog: WithCaller<"readCiLog">;
} & { readonly [K in ThreadMutation]: WithCaller<K> };

/** The host as one session sees it: the in-process test transport's view. */
export const hostForSession = (
  host: WorkerGatewayHostShape,
  caller: GatewayCaller,
): WorkerGatewayRpcOf<BoardWorkerGatewayError> => ({
  ...host,
  spawn: (input) => host.spawn(input, caller),
  send: (input) => host.send(input, caller),
  subscribeMcpRelay: (central) => host.subscribeMcpRelay(central, caller.sessionId),
  mcpRelayRespond: (response) => host.mcpRelayRespond(response, caller.sessionId),
  claimCapacity: (input) => host.claimCapacity(input, caller),
  hold: (input) => host.hold(input, caller),
  releaseHold: (cardId) => host.releaseHold(cardId, caller),
  syncCards: (input) => host.syncCards(input, caller),
  subscribeCapacity: host.subscribeCapacity(caller),
  runSetup: (input) => host.runSetup(input, caller),
  setupState: (path) => host.setupState(path, caller),
  cancelSetup: (path) => host.cancelSetup(path, caller),
  readSetupLog: (path) => host.readSetupLog(path, caller),
  checkReadiness: (input) => host.checkReadiness(input, caller),
  readinessOutput: (key, path) => host.readinessOutput(key, path, caller),
  actuals: (input) => host.actuals(input, caller),
  interrupt: (input) => host.interrupt(input, caller),
  stopSession: (input) => host.stopSession(input, caller),
  settle: (input) => host.settle(input, caller),
  delete: (input) => host.delete(input, caller),
  armLimitRecovery: (input) => host.armLimitRecovery(input, caller),
  answerPendingInput: (input) => host.answerPendingInput(input, caller),
  linkPullRequest: (input) => host.linkPullRequest(input, caller),
  unlinkPullRequest: (input) => host.unlinkPullRequest(input, caller),
  runCi: (input) => host.runCi(input, caller),
  readCiLog: (input) => host.readCiLog(input, caller),
});

export class WorkerGatewayHost extends Context.Service<WorkerGatewayHost, WorkerGatewayHostShape>()(
  "t3/board/workers/WorkerGatewayHost",
) {}

const refused =
  (operation: string, threadId: string | null = null) =>
  (error: McpRelayRefused) =>
    new BoardWorkerGatewayError({ kind: "refused", operation, threadId, detail: error.detail });

const stagingError = (detail: string) =>
  new BoardWorkerGatewayError({
    kind: "failed",
    operation: "stageAttachments",
    threadId: null,
    detail,
  });

export const makeWorkerGatewayHost = Effect.gen(function* () {
  const local = yield* LocalThreadGateway;
  const store = yield* BoardRelayStore;
  const relay = yield* McpRelayHost;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const ciRunner = yield* BoardCiRunner;
  // T3o: optional so a harness without capacity still serves threads (T3O-86).
  const capacity = yield* Effect.serviceOption(BoardWorkerCapacity);
  // T3o: optional so a harness without the meter answers "nothing measured" (T3O-87).
  const actualsMeter = yield* Effect.serviceOption(BoardActualsMeter);

  const noBoard = (operation: string) =>
    new BoardWorkerGatewayError({
      kind: "refused",
      operation,
      threadId: null,
      detail: "Only a board's own session may call this on a worker.",
    });
  const capacityOf = (
    operation: string,
    caller: GatewayCaller,
  ): Effect.Effect<
    { readonly service: BoardWorkerCapacityShape; readonly boardId: string },
    BoardWorkerGatewayError
  > => {
    if (caller.boardId === null) return Effect.fail(noBoard(operation));
    if (Option.isNone(capacity)) {
      return Effect.fail(
        new BoardWorkerGatewayError({
          kind: "failed",
          operation,
          threadId: null,
          detail: "This worker has no capacity service.",
        }),
      );
    }
    return Effect.succeed({ service: capacity.value, boardId: caller.boardId });
  };
  const ownWorktree = (operation: string, caller: GatewayCaller, worktreePath: string) =>
    capacityOf(operation, caller).pipe(
      Effect.flatMap(({ service, boardId }) =>
        service.boardHoldsWorktree(boardId, worktreePath).pipe(
          Effect.flatMap((holds) =>
            holds
              ? Effect.succeed(service)
              : Effect.fail(
                  new BoardWorkerGatewayError({
                    kind: "refused",
                    operation,
                    threadId: null,
                    detail: `${worktreePath} is not one of this board's worktrees here.`,
                  }),
                ),
          ),
        ),
      ),
    );
  /** Whether the caller's board placed this thread, by the record its spawn wrote. A thread no
      board placed is the worker's own, unless it is gone (a retried delete). */
  const placedByCaller = Effect.fn("WorkerGatewayHost.placedByCaller")(function* (
    caller: GatewayCaller,
    threadId: ThreadId,
  ) {
    if (caller.boardId === null) return false;
    const central = yield* store
      .relayedThreadCentral(threadId)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (central === undefined) return false;
    if (central !== null) return central === caller.boardId;
    const state = yield* local.threadState(threadId).pipe(Effect.orElseSucceed(() => null));
    return state === null || state.deleted;
  });
  const ownThread = (operation: string, caller: GatewayCaller, threadId: ThreadId) =>
    caller.boardId === null
      ? Effect.fail(noBoard(operation))
      : placedByCaller(caller, threadId).pipe(
          Effect.flatMap((placed) =>
            placed
              ? Effect.void
              : Effect.fail(
                  new BoardWorkerGatewayError({
                    kind: "refused",
                    operation,
                    threadId,
                    detail: "That thread isn't one this board placed here.",
                  }),
                ),
          ),
        );
  const holdsWorktree = (caller: GatewayCaller, worktreePath: string) =>
    caller.boardId === null || Option.isNone(capacity)
      ? Effect.succeed(false)
      : capacity.value.boardHoldsWorktree(caller.boardId, worktreePath);
  /** The CI runs each board started here, so only that board reads or ends their actuals. */
  const ciRunBoards = new Map<string, string>();
  const MAX_CI_RUNS = 500;
  /** Null when a meter key isn't provably the caller's: the meter has nothing for it to say. */
  const ownedActuals = Effect.fn("WorkerGatewayHost.ownedActuals")(function* (
    input: BoardWorkerActualsInput,
    caller: GatewayCaller,
  ) {
    const separator = input.key.indexOf(":");
    const kind = input.key.slice(0, separator);
    const rest = input.key.slice(separator + 1);
    let owned = false;
    if (kind === "thread") {
      owned =
        (input.threadId === undefined || input.threadId === rest) &&
        (yield* placedByCaller(caller, rest as ThreadId));
    } else if (kind === "ci") {
      owned = input.threadId === undefined && ciRunBoards.get(rest) === caller.boardId;
    } else if (kind === "setup") {
      const at = rest.lastIndexOf("@");
      owned =
        input.threadId === undefined && at > 0 && (yield* holdsWorktree(caller, rest.slice(0, at)));
    }
    if (!owned) return null;
    // Disk is measured only in this board's own worktree.
    if (input.worktreePath !== undefined && !(yield* holdsWorktree(caller, input.worktreePath))) {
      const { worktreePath: _dropped, ...kept } = input;
      return kept;
    }
    return input;
  });
  /**
   * A board's new turn waits while the worker is at its agent cap (`agent-cap`). Admitted, it
   * counts as running at once, so several boards' spawns can't all pass the same check.
   */
  const refuseOverAgentCap = (
    operation: string,
    threadId: string,
    providerInstanceId: string | null,
  ) =>
    Option.match(capacity, {
      onNone: () => Effect.void,
      onSome: (service) =>
        service.reserveAgent(threadId, providerInstanceId).pipe(
          Effect.flatMap((refusal) =>
            refusal === null
              ? Effect.void
              : Effect.fail(
                  new BoardWorkerGatewayError({
                    kind: "refused",
                    operation,
                    threadId,
                    detail: refusal,
                    reason: "agent-cap",
                  }),
                ),
          ),
        ),
    });

  const releaseAgentStart = (threadId: string) =>
    Option.match(capacity, {
      onNone: () => Effect.void,
      onSome: (service) => service.releaseAgent(threadId),
    });

  // A deleted thread makes no more board calls; its relay record goes too,
  // however it was deleted.
  yield* local.observe.pipe(
    Stream.runForEach((signal) =>
      signal.type === "thread-deleted"
        ? store
            .forgetRelayedThread(signal.threadId)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("board relay: a deleted thread's record was kept", { cause }),
              ),
            )
        : Effect.void,
    ),
    Effect.forkScoped,
  );

  const sha256 = (bytes: Uint8Array) => digest.digestHex(Digest.sha256, bytes);

  /** Write what changed, ask for what is missing, and drop what the card no
      longer has (prototype K3: the agent reads them by path). */
  const stageAttachments = Effect.fn("WorkerGatewayHost.stageAttachments")(
    function* (input: BoardStageAttachmentsInput) {
      const cardId = input.cardId as BoardCardId;
      const dir = boardCardAttachmentsDir({ path, stateDir: config.stateDir, cardId });
      if (dir === null) return yield* stagingError(`'${input.cardId}' is not a card id.`);
      yield* fs.makeDirectory(dir, { recursive: true });
      const needed: Array<string> = [];
      let written = 0;
      for (const file of input.files) {
        const target = resolveBoardCardAttachmentPath({
          path,
          stateDir: config.stateDir,
          cardId,
          name: file.name,
        });
        if (target === null) return yield* stagingError(`'${file.name}' is not a file name.`);
        const existing = yield* fs.readFile(target).pipe(Effect.option);
        if (existing._tag === "Some" && (yield* sha256(existing.value)) === file.sha256) continue;
        if (file.contentBase64 === undefined) {
          needed.push(file.name);
          continue;
        }
        const bytes = Base64.decode(file.contentBase64);
        if (Result.isFailure(bytes)) return yield* stagingError(`'${file.name}' is not base64.`);
        if ((yield* sha256(bytes.success)) !== file.sha256) {
          return yield* stagingError(`'${file.name}' does not match its hash.`);
        }
        yield* fs.writeFile(target, bytes.success);
        written += 1;
      }
      const keep = new Set(input.files.map((file) => file.name));
      for (const name of yield* fs.readDirectory(dir)) {
        if (!keep.has(name)) yield* fs.remove(path.join(dir, name)).pipe(Effect.ignore);
      }
      return { needed, written, stateDir: config.stateDir } satisfies BoardStageAttachmentsResult;
    },
    Effect.catchTags({ PlatformError: (error) => Effect.fail(stagingError(error.message)) }),
  );

  const runCiHere = (input: BoardWorkerRunCiInput) =>
    Stream.callback<BoardWorkerCiProgress>((queue) =>
      ciRunner
        .run(
          {
            runId: input.runId,
            cwd: input.worktreePath,
            steps: input.steps,
            logDir: boardCiLogDir(input.worktreePath, input.runId),
            ...(input.indexOffset === undefined ? {} : { indexOffset: input.indexOffset }),
            ...(input.stopOnFailure === false ? { stopOnFailure: false } : {}),
          },
          (progress) =>
            Queue.offer(queue, { _tag: "step", ...progress } as const).pipe(Effect.asVoid),
        )
        .pipe(
          Effect.flatMap((outcome) => Queue.offer(queue, toWireCiDone(outcome))),
          Effect.andThen(Queue.end(queue)),
        ),
    );
  // A step's log, followed until the central server closes it.
  const readCiLogHere = (input: BoardWorkerReadCiLogInput) =>
    isSafeBoardCiLogTarget(input.runId, input.index)
      ? readBoardCiLogFile(
          path.join(boardCiLogDir(input.worktreePath, input.runId), `${input.index}.log`),
          input,
        )
      : Stream.fail(
          new BoardWorkerGatewayError({
            kind: "refused",
            operation: "readCiLog",
            threadId: null,
            detail: "That isn't a CI log this worker keeps.",
          }),
        );

  return {
    spawn: Effect.fn("WorkerGatewayHost.spawn")(function* (
      { centralEnvironmentId, ...input },
      caller,
    ) {
      yield* relay
        .claim(centralEnvironmentId, caller.sessionId)
        .pipe(Effect.mapError(refused("spawn", input.threadId)));
      yield* refuseOverAgentCap("spawn", input.threadId, input.modelSelection.instanceId);
      // Anything that stops the spawn hands its agent slot back.
      yield* Effect.gen(function* () {
        // Recorded first: the agent's first tool call can arrive before the
        // spawn returns. A thread another board placed stays that board's.
        const recordFailed = (cause: { readonly cause?: unknown }) =>
          new BoardWorkerGatewayError({
            kind: "failed",
            operation: "spawn",
            threadId: input.threadId,
            detail: `Couldn't record the thread for the board: ${String(cause.cause)}`,
          });
        const current = yield* store
          .relayedThreadCentral(input.threadId)
          .pipe(Effect.mapError(recordFailed));
        if (current !== null && current !== centralEnvironmentId) {
          return yield* new BoardWorkerGatewayError({
            kind: "refused",
            operation: "spawn",
            threadId: input.threadId,
            detail: "That thread belongs to another board.",
          });
        }
        yield* store
          .recordRelayedThread(input.threadId, centralEnvironmentId)
          .pipe(Effect.mapError(recordFailed));
        yield* wireCommand(local.spawn(input));
      }).pipe(Effect.tapError(() => releaseAgentStart(input.threadId)));
    }),
    send: Effect.fn("WorkerGatewayHost.send")(function* (input, caller) {
      yield* ownThread("send", caller, input.threadId);
      // A turn the board sends on an existing thread waits at the cap too, unless the thread
      // is already running (a steer joins its turn).
      const state = yield* local.threadState(input.threadId).pipe(Effect.orElseSucceed(() => null));
      if (state === null || state.activeTurnRef === null) {
        yield* refuseOverAgentCap(
          "send",
          input.threadId,
          state?.modelSelection?.instanceId ?? null,
        );
      }
      yield* wireCommand(local.send(input)).pipe(
        Effect.tapError(() => releaseAgentStart(input.threadId)),
      );
    }),
    claimCapacity: (input, caller) =>
      capacityOf("claimCapacity", caller).pipe(
        Effect.flatMap(({ service, boardId }) => service.claim(boardId, input)),
      ),
    hold: (input, caller) =>
      capacityOf("hold", caller).pipe(
        Effect.flatMap(({ service, boardId }) => service.hold(boardId, input)),
      ),
    releaseHold: (cardId, caller) =>
      capacityOf("releaseHold", caller).pipe(
        Effect.flatMap(({ service, boardId }) => service.releaseHold(boardId, cardId)),
      ),
    syncCards: (input, caller) =>
      capacityOf("syncCards", caller).pipe(
        Effect.flatMap(({ service, boardId }) => service.syncCards(boardId, input)),
      ),
    subscribeCapacity: (caller) =>
      Stream.unwrap(
        capacityOf("subscribeCapacity", caller).pipe(
          Effect.map(({ service, boardId }) => service.subscribe(boardId)),
        ),
      ),
    // A card's setup is its board's alone: the worktree must be one of that board's cards.
    runSetup: (input, caller) =>
      Stream.unwrap(
        ownWorktree("runSetup", caller, input.worktreePath).pipe(
          Effect.map((service) => service.runSetup(input)),
        ),
      ),
    setupState: (worktreePath, caller) =>
      ownWorktree("setupState", caller, worktreePath).pipe(
        Effect.flatMap((service) => service.setupState(worktreePath)),
      ),
    cancelSetup: (worktreePath, caller) =>
      ownWorktree("cancelSetup", caller, worktreePath).pipe(
        Effect.flatMap((service) => service.cancelSetup(worktreePath)),
      ),
    readSetupLog: (worktreePath, caller) =>
      ownWorktree("readSetupLog", caller, worktreePath).pipe(
        Effect.flatMap((service) => service.readSetupLog(worktreePath)),
      ),
    checkReadiness: (input, caller) =>
      capacityOf("checkReadiness", caller).pipe(
        Effect.flatMap(({ service, boardId }) => service.checkReadiness(boardId, input)),
      ),
    readinessOutput: (repositoryKey, path, caller) =>
      capacityOf("readinessOutput", caller).pipe(
        Effect.flatMap(({ service, boardId }) =>
          service.readinessOutput(boardId, repositoryKey, path),
        ),
      ),
    actuals: Effect.fn("WorkerGatewayHost.actuals")(function* (input, caller) {
      if (caller.boardId === null) return yield* noBoard("actuals");
      if (Option.isNone(actualsMeter)) return null;
      const owned = yield* ownedActuals(input, caller);
      if (owned === null) return null;
      const reading = yield* actualsMeter.value.relay(owned);
      if (owned.op === "end" && owned.key.startsWith("ci:")) {
        ciRunBoards.delete(owned.key.slice("ci:".length));
      }
      return reading;
    }),
    interrupt: (input, caller) =>
      ownThread("interrupt", caller, input.threadId).pipe(
        Effect.andThen(wireCommand(local.interrupt(input))),
      ),
    stopSession: (input, caller) =>
      ownThread("stopSession", caller, input.threadId).pipe(
        Effect.andThen(wireCommand(local.stopSession(input))),
      ),
    settle: (input, caller) =>
      ownThread("settle", caller, input.threadId).pipe(
        Effect.andThen(wireCommand(local.settle(input))),
      ),
    delete: (input, caller) =>
      ownThread("delete", caller, input.threadId).pipe(
        Effect.andThen(wireCommand(local.delete(input))),
      ),
    armLimitRecovery: (input, caller) =>
      ownThread("armLimitRecovery", caller, input.threadId).pipe(
        Effect.andThen(wireCommand(local.armLimitRecovery(input))),
      ),
    answerPendingInput: (input, caller) =>
      ownThread("answerPendingInput", caller, input.threadId).pipe(
        Effect.andThen(wireCommand(local.answerPendingInput(input))),
      ),
    linkPullRequest: (input, caller) =>
      ownThread("linkPullRequest", caller, input.threadId).pipe(
        Effect.andThen(wireCommand(local.linkPullRequest(input))),
      ),
    unlinkPullRequest: (input, caller) =>
      ownThread("unlinkPullRequest", caller, input.threadId).pipe(
        Effect.andThen(wireCommand(local.unlinkPullRequest(input))),
      ),
    threadState: (threadId) => wireRead(local.threadState(threadId)),
    threadRecords: (threadIds) =>
      wireRead(local.threadRecords(threadIds)).pipe(Effect.map((records) => [...records.values()])),
    threadsInWorktree: (worktreePath) => wireRead(local.threadsInWorktree(worktreePath)),
    listLiveThreadIds: wireRead(local.listLiveThreadIds()),
    latestAssistantMessage: (threadId) => wireRead(local.latestAssistantMessage(threadId)),
    lastSignalAt: (threadId) => wireRead(local.lastSignalAt(threadId)),
    pendingTurnStartAt: (threadId) => wireRead(local.pendingTurnStartAt(threadId)),
    subagentAwaitingApproval: (threadId) => wireRead(local.subagentAwaitingApproval(threadId)),
    projects: wireRead(local.projects()),
    project: (projectId) => wireRead(local.project(projectId)),
    subscribeSignals: (afterSequence, withUsage) =>
      local.signalLog(afterSequence, { withUsage: withUsage === true }).pipe(
        Stream.map((batch) => ({
          sequence: batch.sequence,
          signals: batch.signals.map(toWireSignal),
        })),
      ),
    todoLogHead: local.todoLogHead,
    // T3o: usage rides only the signal stream a central asks it of, so the todo log's
    // wire entries keep the todo signals an older central decodes.
    readTodoLog: (after, upTo) =>
      local
        .readTodoLog(after, upTo)
        .pipe(Stream.map(withoutUsage), Stream.mapError(toWireReadError)),
    subscribeTodoLog: Stream.unwrap(local.subscribeTodoLog).pipe(Stream.map(withoutUsage)),
    subscribeMcpRelay: (central, caller) =>
      relay.subscribe(central, caller).pipe(Stream.mapError(refused("subscribeMcpRelay"))),
    mcpRelayRespond: (response, caller) =>
      relay.respond(response, caller).pipe(Effect.mapError(refused("mcpRelayRespond"))),
    stageAttachments,
    // The card's CI steps, run here where its worktree is: one of the calling board's own.
    runCi: (input, caller) =>
      Stream.unwrap(
        ownWorktree("runCi", caller, input.worktreePath).pipe(
          Effect.andThen(capacityOf("runCi", caller)),
          Effect.map(({ boardId }) => {
            ciRunBoards.delete(input.runId);
            ciRunBoards.set(input.runId, boardId);
            for (const runId of ciRunBoards.keys()) {
              if (ciRunBoards.size <= MAX_CI_RUNS) break;
              ciRunBoards.delete(runId);
            }
            return runCiHere(input);
          }),
        ),
      ),
    readCiLog: (input, caller) =>
      Stream.unwrap(
        ownWorktree("readCiLog", caller, input.worktreePath).pipe(
          Effect.map(() => readCiLogHere(input)),
        ),
      ),
  } satisfies WorkerGatewayHostShape;
});

export const WorkerGatewayHostLive = Layer.effect(WorkerGatewayHost, makeWorkerGatewayHost);
