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
  | "actuals";

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
};

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
    send: Effect.fn("WorkerGatewayHost.send")(function* (input, _caller) {
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
    actuals: (input, caller) =>
      caller.boardId === null
        ? Effect.fail(noBoard("actuals"))
        : Option.isNone(actualsMeter)
          ? Effect.succeed(null)
          : actualsMeter.value.relay(input),
    interrupt: (input) => wireCommand(local.interrupt(input)),
    stopSession: (input) => wireCommand(local.stopSession(input)),
    settle: (input) => wireCommand(local.settle(input)),
    delete: (input) => wireCommand(local.delete(input)),
    armLimitRecovery: (input) => wireCommand(local.armLimitRecovery(input)),
    answerPendingInput: (input) => wireCommand(local.answerPendingInput(input)),
    linkPullRequest: (input) => wireCommand(local.linkPullRequest(input)),
    unlinkPullRequest: (input) => wireCommand(local.unlinkPullRequest(input)),
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
    // The card's CI steps, run here where its worktree is.
    runCi: (input) =>
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
      ),
    // A step's log, followed until the central server closes it.
    readCiLog: (input) =>
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
          ),
  } satisfies WorkerGatewayHostShape;
});

export const WorkerGatewayHostLive = Layer.effect(WorkerGatewayHost, makeWorkerGatewayHost);
