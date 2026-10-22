/**
 * T3o (T3O-63, D9/D19): the board's gateway onto ONE worker's threads.
 *
 * A thin proxy over the worker's own gateway (`boardWorker.gateway.*`). The
 * only translation is the project: a board project is a central-server
 * project, and on a worker it is the checkout whose repository grouping key
 * matches (D20). Thread ids are the same on both sides.
 *
 * A worker the board cannot reach right now fails every call with a
 * `WorkerUnavailable` cause, except `threadState`, which answers `unknown`:
 * a thread the board cannot see is not a thread that is gone (D22).
 *
 * Signals and the todo log are not here: the `WorkerSignalFeed` follows every
 * worker's at once, with its cursor, and the router merges it.
 */
import {
  boardRepositoryGroupingKey,
  resolveBoardWorkerCheckout,
  type BoardWorkerCheckout,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";

import {
  ThreadCommandFailedError,
  ThreadCommandRefusedError,
  ThreadReadError,
  UNKNOWN_THREAD_STATE,
  type BoardThreadRecord,
  type LocalThreadGatewayShape,
  type ThreadCommandError,
  type ThreadGatewayShape,
  type ThreadSpawnInput,
} from "../ThreadGateway.ts";
import {
  fromWireCommandError,
  fromWireReadError,
  type WorkerGatewayCallError,
} from "./gatewayWire.ts";
import type { WorkerConnectionsShape, WorkerUnavailable } from "./WorkerConnections.ts";
import type { WorkerRpc } from "./WorkerTransport.ts";

/** The thread-scoped half of the gateway: what a worker's threads answer. */
export type RemoteThreadGatewayShape = Pick<
  ThreadGatewayShape,
  | "spawn"
  | "send"
  | "interrupt"
  | "stopSession"
  | "settle"
  | "delete"
  | "armLimitRecovery"
  | "threadState"
  | "threadRecords"
  | "listLiveThreadIds"
  | "latestAssistantMessage"
  | "lastSignalAt"
  | "pendingTurnStartAt"
>;

export interface RemoteThreadGatewayDeps {
  readonly workerId: EnvironmentId;
  readonly connections: WorkerConnectionsShape;
  /** The central server's own gateway: its projects are the board's. */
  readonly local: Pick<LocalThreadGatewayShape, "projects" | "project">;
  readonly centralEnvironmentId: EnvironmentId;
  readonly fileSystem: FileSystem.FileSystem;
  readonly crypto: Crypto.Crypto;
}

const unavailableCommand = (command: string, threadId: ThreadId) => (cause: WorkerUnavailable) =>
  new ThreadCommandFailedError({ command, threadId, detail: cause.message, cause });

const unavailableRead = (operation: string) => (cause: WorkerUnavailable) =>
  new ThreadReadError({ operation, detail: cause.message, cause });

/**
 * Copy a card's brief files onto a worker, sending only what changed: the
 * worker names the files whose hash it lacks, and only those travel. Used at
 * spawn and again by a relayed card context, so a file added after the spawn
 * is on the worker by the time its path is handed out.
 */
export const stageCardFilesOnWorker = (input: {
  readonly rpc: WorkerRpc;
  readonly fileSystem: FileSystem.FileSystem;
  readonly crypto: Crypto.Crypto;
  readonly staging: NonNullable<ThreadSpawnInput["stageAttachments"]>;
}) =>
  Effect.gen(function* () {
    const { rpc, staging } = input;
    const files = yield* Effect.forEach(staging.files, (file) =>
      input.fileSystem
        .readFile(file.path)
        .pipe(
          Effect.flatMap((bytes) =>
            input.crypto
              .digest("SHA-256", bytes)
              .pipe(Effect.map((digest) => ({ name: file.name, hash: Hex.encode(digest), bytes }))),
          ),
        ),
    );
    const first = yield* rpc.gateway.stageAttachments({
      cardId: staging.cardId,
      files: files.map((file) => ({ name: file.name, sha256: file.hash })),
    });
    if (first.needed.length === 0) return;
    const needed = new Set(first.needed);
    yield* rpc.gateway.stageAttachments({
      cardId: staging.cardId,
      files: files.map((file) => ({
        name: file.name,
        sha256: file.hash,
        ...(needed.has(file.name) ? { contentBase64: Base64.encode(file.bytes) } : {}),
      })),
    });
  });

export const makeRemoteThreadGateway = (
  deps: RemoteThreadGatewayDeps,
): RemoteThreadGatewayShape => {
  const { workerId, connections, local } = deps;
  const link = connections.get(workerId);

  const checkouts = connections.current.pipe(
    Effect.map((runtime) => runtime.get(workerId)?.snapshot?.checkouts ?? []),
  );

  /** The worker's checkout of a board project, with the project's own root. */
  const checkoutFor = (projectId: ProjectId, threadId: ThreadId) =>
    Effect.gen(function* () {
      const detail = yield* local.project(projectId).pipe(
        Effect.mapError(
          (cause) =>
            new ThreadCommandFailedError({
              command: "spawn",
              threadId,
              detail: cause.detail,
              cause,
            }),
        ),
      );
      const checkout: BoardWorkerCheckout | null =
        detail === null
          ? null
          : resolveBoardWorkerCheckout(
              boardRepositoryGroupingKey(detail.repositoryIdentity),
              yield* checkouts,
            );
      if (detail === null || checkout === null) {
        return yield* new ThreadCommandRefusedError({
          command: "spawn",
          threadId,
          detail: `Project '${projectId}' has no checkout on worker ${workerId}.`,
        });
      }
      return { checkout, centralRoot: detail.workspaceRoot };
    });

  /** The board project a worker project is a checkout of, or the worker's own
      id when none matches — a thread never loses its project. */
  const centralProjectOf = (workerProjectId: ProjectId) =>
    Effect.gen(function* () {
      const key =
        (yield* checkouts).find((checkout) => checkout.projectId === workerProjectId)
          ?.repositoryKey ?? null;
      if (key === null) return workerProjectId;
      for (const project of yield* local.projects()) {
        const detail = yield* local.project(project.id);
        if (detail !== null && boardRepositoryGroupingKey(detail.repositoryIdentity) === key) {
          return project.id;
        }
      }
      return workerProjectId;
    });

  /** Copy a card's brief files onto the worker, sending only what changed. */
  const stage = (staging: NonNullable<ThreadSpawnInput["stageAttachments"]>, threadId: ThreadId) =>
    link.pipe(
      Effect.flatMap((rpc) =>
        stageCardFilesOnWorker({
          rpc,
          fileSystem: deps.fileSystem,
          crypto: deps.crypto,
          staging,
        }),
      ),
      Effect.mapError(
        (cause): ThreadCommandError =>
          new ThreadCommandFailedError({
            command: "spawn",
            threadId,
            detail: `Couldn't copy the card's files to worker ${workerId}.`,
            cause,
          }),
      ),
    );

  const command =
    <I extends { readonly threadId: ThreadId }, A>(
      name: string,
      run: (rpc: WorkerRpc, input: I) => Effect.Effect<A, WorkerGatewayCallError>,
    ) =>
    (input: I): Effect.Effect<A, ThreadCommandError> =>
      link.pipe(
        Effect.mapError(unavailableCommand(name, input.threadId)),
        Effect.flatMap((rpc) =>
          run(rpc, input).pipe(Effect.mapError(fromWireCommandError(name, input.threadId))),
        ),
      );

  const read = <A>(
    name: string,
    run: (rpc: WorkerRpc) => Effect.Effect<A, WorkerGatewayCallError>,
  ): Effect.Effect<A, ThreadReadError> =>
    link.pipe(
      Effect.mapError(unavailableRead(name)),
      Effect.flatMap((rpc) => run(rpc).pipe(Effect.mapError(fromWireReadError(name)))),
    );

  return {
    spawn: (input) =>
      Effect.gen(function* () {
        const { checkout, centralRoot } = yield* checkoutFor(input.projectId, input.threadId);
        if (input.stageAttachments !== undefined) {
          yield* stage(input.stageAttachments, input.threadId);
        }
        const rpc = yield* link.pipe(Effect.mapError(unavailableCommand("spawn", input.threadId)));
        yield* rpc.gateway
          .spawn({
            commandId: input.commandId,
            threadId: input.threadId,
            projectId: checkout.projectId,
            title: input.title,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            branch: input.branch,
            // A thread with no worktree runs in the project root, which is
            // the worker's checkout; a worktree path is already the worker's.
            worktreePath:
              input.branch === null && input.worktreePath === centralRoot
                ? checkout.workspaceRoot
                : input.worktreePath,
            text: input.text,
            // Uploads live in this server's attachment store; the worker reads
            // the brief's files from where they were staged instead.
            attachments: [],
            centralEnvironmentId: deps.centralEnvironmentId,
          })
          .pipe(Effect.mapError(fromWireCommandError("spawn", input.threadId)));
      }),
    send: command("send", (rpc, input: Parameters<ThreadGatewayShape["send"]>[0]) =>
      rpc.gateway.send({ ...input, attachments: [] }),
    ),
    interrupt: command("interrupt", (rpc, input) => rpc.gateway.interrupt(input)),
    stopSession: command("stopSession", (rpc, input) => rpc.gateway.stopSession(input)),
    settle: command("settle", (rpc, input: Parameters<ThreadGatewayShape["settle"]>[0]) =>
      rpc.gateway.settle(input),
    ),
    delete: command("delete", (rpc, input) => rpc.gateway.delete(input)),
    armLimitRecovery: command("armLimitRecovery", (rpc, input) =>
      rpc.gateway.armLimitRecovery(input),
    ),
    threadState: (threadId) =>
      Effect.gen(function* () {
        const rpc = yield* link.pipe(Effect.option);
        if (rpc._tag === "None") return UNKNOWN_THREAD_STATE;
        const answer = yield* rpc.value.gateway.threadState(threadId).pipe(Effect.result);
        if (answer._tag === "Failure") {
          // The link went between the lookup and the answer: still unknown.
          if (answer.failure._tag === "WorkerRpcError") return UNKNOWN_THREAD_STATE;
          return yield* fromWireReadError("threadState")(answer.failure);
        }
        const state = answer.success;
        if (state === null) return null;
        return { ...state, projectId: yield* centralProjectOf(state.projectId) };
      }),
    threadRecords: (threadIds) =>
      read("threadRecords", (rpc) => rpc.gateway.threadRecords(threadIds)).pipe(
        Effect.map(
          (records) =>
            new Map(
              records.map((record): [ThreadId, BoardThreadRecord] => [record.threadId, record]),
            ),
        ),
      ),
    listLiveThreadIds: () => read("listLiveThreadIds", (rpc) => rpc.gateway.listLiveThreadIds),
    latestAssistantMessage: (threadId) =>
      read("latestAssistantMessage", (rpc) => rpc.gateway.latestAssistantMessage(threadId)),
    lastSignalAt: (threadId) => read("lastSignalAt", (rpc) => rpc.gateway.lastSignalAt(threadId)),
    pendingTurnStartAt: (threadId) =>
      read("pendingTurnStartAt", (rpc) => rpc.gateway.pendingTurnStartAt(threadId)),
  };
};
