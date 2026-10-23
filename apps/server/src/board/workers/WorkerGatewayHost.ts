/**
 * T3o (T3O-63): what a worker answers when a central server drives its
 * threads. Every `boardWorker.gateway.*` call lands here, and the in-process
 * test transport calls the same methods, so a suite exercises exactly what a
 * real worker runs.
 *
 * It serves THIS server's own threads (`LocalThreadGateway`), never the
 * board router: a worker that is itself a central board must not hand its
 * own workers' threads to another board.
 *
 * A thread spawned here is recorded as relayed to the board that spawned it,
 * so its agent's board tools forward there (`McpRelayHost`), and forgotten
 * once it is deleted. The relay's calls and the spawn take the caller's
 * session, because a board is only the environment id its session claims:
 * the relay binds each board to one session (`McpRelayHost.claim`).
 */
import {
  BoardWorkerGatewayError,
  type AuthSessionId,
  type BoardGatewaySpawnInput,
  type BoardMcpRelayRequest,
  type BoardMcpRelayResponse,
  type EnvironmentId,
  type BoardStageAttachmentsInput,
  type BoardStageAttachmentsResult,
  type BoardCardId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";

import * as ServerConfig from "../../config.ts";
import { boardCardAttachmentsDir, resolveBoardCardAttachmentPath } from "../attachments.ts";
import { LocalThreadGateway } from "../ThreadGateway.ts";
import { BoardRelayStore } from "./BoardRelayStore.ts";
import {
  toWireReadError,
  toWireSignal,
  wireCommand,
  wireRead,
  type WorkerGatewayRpcOf,
} from "./gatewayWire.ts";
import { McpRelayHost, type McpRelayRefused } from "./McpRelayHost.ts";

type CallerBound = "spawn" | "subscribeMcpRelay" | "mcpRelayRespond";

/** The host fails only with the worker's own error: there is no wire
    between it and the gateway it serves. The calls that speak for a board
    also take the session making them. */
export type WorkerGatewayHostShape = Omit<
  WorkerGatewayRpcOf<BoardWorkerGatewayError>,
  CallerBound
> & {
  readonly spawn: (
    input: BoardGatewaySpawnInput,
    caller: AuthSessionId,
  ) => Effect.Effect<void, BoardWorkerGatewayError>;
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
  caller: AuthSessionId,
): WorkerGatewayRpcOf<BoardWorkerGatewayError> => ({
  ...host,
  spawn: (input) => host.spawn(input, caller),
  subscribeMcpRelay: (central) => host.subscribeMcpRelay(central, caller),
  mcpRelayRespond: (response) => host.mcpRelayRespond(response, caller),
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
  const crypto = yield* Crypto.Crypto;

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

  const sha256 = (bytes: Uint8Array) =>
    crypto.digest("SHA-256", bytes).pipe(Effect.map(Hex.encode), Effect.orDie);

  /** Write what changed, ask for what is missing, and drop what the card no
      longer has (prototype K3: the agent reads them by path). */
  const stageAttachments = (input: BoardStageAttachmentsInput) =>
    Effect.gen(function* () {
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
    }).pipe(
      Effect.catchTags({ PlatformError: (error) => Effect.fail(stagingError(error.message)) }),
    );

  return {
    spawn: ({ centralEnvironmentId, ...input }, caller) =>
      Effect.gen(function* () {
        yield* relay
          .claim(centralEnvironmentId, caller)
          .pipe(Effect.mapError(refused("spawn", input.threadId)));
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
      }),
    send: (input) => wireCommand(local.send(input)),
    interrupt: (input) => wireCommand(local.interrupt(input)),
    stopSession: (input) => wireCommand(local.stopSession(input)),
    settle: (input) => wireCommand(local.settle(input)),
    delete: (input) => wireCommand(local.delete(input)),
    armLimitRecovery: (input) => wireCommand(local.armLimitRecovery(input)),
    threadState: (threadId) => wireRead(local.threadState(threadId)),
    threadRecords: (threadIds) =>
      wireRead(local.threadRecords(threadIds)).pipe(Effect.map((records) => [...records.values()])),
    threadsInWorktree: (worktreePath) => wireRead(local.threadsInWorktree(worktreePath)),
    listLiveThreadIds: wireRead(local.listLiveThreadIds()),
    latestAssistantMessage: (threadId) => wireRead(local.latestAssistantMessage(threadId)),
    lastSignalAt: (threadId) => wireRead(local.lastSignalAt(threadId)),
    pendingTurnStartAt: (threadId) => wireRead(local.pendingTurnStartAt(threadId)),
    projects: wireRead(local.projects()),
    project: (projectId) => wireRead(local.project(projectId)),
    subscribeSignals: (afterSequence) =>
      local.signalLog(afterSequence).pipe(
        Stream.map((batch) => ({
          sequence: batch.sequence,
          signals: batch.signals.map(toWireSignal),
        })),
      ),
    todoLogHead: local.todoLogHead,
    readTodoLog: (after, upTo) =>
      local.readTodoLog(after, upTo).pipe(Stream.mapError(toWireReadError)),
    subscribeTodoLog: Stream.unwrap(local.subscribeTodoLog),
    subscribeMcpRelay: (central, caller) =>
      relay.subscribe(central, caller).pipe(Stream.mapError(refused("subscribeMcpRelay"))),
    mcpRelayRespond: (response, caller) =>
      relay.respond(response, caller).pipe(Effect.mapError(refused("mcpRelayRespond"))),
    stageAttachments,
  } satisfies WorkerGatewayHostShape;
});

export const WorkerGatewayHostLive = Layer.effect(WorkerGatewayHost, makeWorkerGatewayHost);
