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
 * so its agent's board tools forward there (`McpRelayHost`).
 */
import {
  BoardWorkerGatewayError,
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
import { McpRelayHost } from "./McpRelayHost.ts";

/** The host fails only with the worker's own error: there is no wire
    between it and the gateway it serves. */
export type WorkerGatewayHostShape = WorkerGatewayRpcOf<BoardWorkerGatewayError>;

export class WorkerGatewayHost extends Context.Service<WorkerGatewayHost, WorkerGatewayHostShape>()(
  "t3/board/workers/WorkerGatewayHost",
) {}

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
    }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(stagingError(error.message))));

  return {
    spawn: ({ centralEnvironmentId, ...input }) =>
      // Recorded first: the agent's first tool call can arrive before the
      // spawn returns.
      store.recordRelayedThread(input.threadId, centralEnvironmentId).pipe(
        Effect.mapError(
          (cause) =>
            new BoardWorkerGatewayError({
              kind: "failed",
              operation: "spawn",
              threadId: input.threadId,
              detail: `Couldn't record the thread for the board: ${String(cause.cause)}`,
            }),
        ),
        Effect.andThen(wireCommand(local.spawn(input))),
      ),
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
    subscribeMcpRelay: (central) => relay.subscribe(central),
    mcpRelayRespond: (response) => relay.respond(response),
    stageAttachments,
  } satisfies WorkerGatewayHostShape;
});

export const WorkerGatewayHostLive = Layer.effect(WorkerGatewayHost, makeWorkerGatewayHost);
