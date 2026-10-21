/**
 * T3o (T3O-62, D19/D20): the central server's worker management, as a service
 * so the RPC handlers, and later MCP tools and agents, all call the same
 * methods.
 *
 * - `add` / `repair`: refuse the wrong server before spending the one-time
 *   token, exchange it for the board's own session, prove the worker speaks
 *   the board-worker protocol, store the token, then record the worker.
 * - `remove`: give the board's session back on the worker if it is reachable,
 *   then forget the token, the snapshot and the record. What removal does to
 *   the cards placed there is D22's, not this file's.
 * - `setDefault`: only to an online worker, or back to `local`.
 * - `setupProject`: clone a board project's remote onto a worker, following
 *   the worker's own clone progress so it survives anyone leaving the page.
 * - `state` / `changes`: the `BoardWorkersState` every board client holds.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  BOARD_WORKER_PROTOCOL_FLOOR,
  BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION,
  BOARD_WORKER_SETUP_LOG_MAX_LENGTH,
  BoardWorkerActionError,
  BoardWorkerAddError,
  boardRepositoryGroupingKey,
  CommandId,
  ProjectId,
  resolveBoardWorkerCheckout,
  type BoardWorker,
  type BoardWorkerAddResult,
  type BoardWorkerHello,
  type BoardWorkerSetup,
  type BoardWorkerSnapshot,
  type BoardWorkersAddInput,
  type BoardWorkersRepairInput,
  type BoardWorkersSetupProjectInput,
  type BoardWorkersState,
  type BoardWorkerId,
  type BoardWorkerView,
  type EnvironmentId,
  type ProjectCloneSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { BoardEngine } from "../BoardEngine.ts";
import { classifyCloneFailure, cloneDestination, cloneFailureMessage } from "./setupFailure.ts";
import {
  encodeWorkerToken,
  readWorkerSnapshot,
  WorkerConnections,
  workerSecretName,
} from "./WorkerConnections.ts";
import {
  boardSessionLabel,
  exchangeWorkerCredential,
  fetchWorkerDescriptor,
  resolveWorkerTarget,
} from "./workerCredential.ts";
import { bootStatus } from "./WorkerSnapshotStore.ts";
import { WorkerTransport, type WorkerRpc, type WorkerRpcError } from "./WorkerTransport.ts";

export interface BoardWorkersShape {
  readonly add: (
    input: BoardWorkersAddInput,
  ) => Effect.Effect<BoardWorkerAddResult, BoardWorkerAddError>;
  readonly repair: (
    input: BoardWorkersRepairInput,
  ) => Effect.Effect<BoardWorkerAddResult, BoardWorkerAddError>;
  readonly remove: (
    workerId: EnvironmentId,
  ) => Effect.Effect<{ readonly revoked: boolean }, BoardWorkerActionError>;
  readonly setDefault: (workerId: BoardWorkerId) => Effect.Effect<void, BoardWorkerActionError>;
  readonly setupProject: (
    input: BoardWorkersSetupProjectInput,
  ) => Effect.Effect<BoardWorkerSetup, BoardWorkerActionError>;
  readonly dismissSetup: (input: {
    readonly projectId: ProjectId;
    readonly workerId: EnvironmentId;
  }) => Effect.Effect<void>;
  /** The board's worker summary now. */
  readonly state: Effect.Effect<BoardWorkersState>;
  /** The summary again after every runtime change — connection status,
      snapshots, setups. Registry changes ride the board log. Each access
      subscribes. */
  readonly changes: Stream.Stream<BoardWorkersState>;
  /** The summary now, then as `changes`, subscribed atomically with the
      first read. */
  readonly states: Stream.Stream<BoardWorkersState>;
}

export class BoardWorkers extends Context.Service<BoardWorkers, BoardWorkersShape>()(
  "t3/board/workers/BoardWorkers",
) {}

/** How long Remove waits for the worker to give the session back. */
const RELEASE_TIMEOUT = "5 seconds";

const setupKey = (workerId: EnvironmentId, projectId: ProjectId) => `${workerId}\u0000${projectId}`;

const actionError = (code: BoardWorkerActionError["code"], message: string) =>
  new BoardWorkerActionError({ code, message });

export const makeBoardWorkers = Effect.gen(function* () {
  const engine = yield* BoardEngine;
  const connections = yield* WorkerConnections;
  const transport = yield* WorkerTransport;
  const secrets = yield* ServerSecretStore;
  const environment = yield* ServerEnvironment;
  const projects = yield* ProjectService;
  const git = yield* GitVcsDriver;
  const http = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;

  const setups = yield* SubscriptionRef.make(new Map<string, BoardWorkerSetup>());
  const followers = yield* FiberMap.make<string>();

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  // A failing random source is a broken host, not something a caller handles.
  const newUuid = crypto.randomUUIDv4().pipe(Effect.orDie);
  const newCommandId = newUuid.pipe(Effect.map(CommandId.make));
  const registry = engine.getReadModel.pipe(
    Effect.map((model) => model.board?.workers ?? ([] as ReadonlyArray<BoardWorker>)),
  );
  const defaultWorkerId = engine.getReadModel.pipe(
    Effect.map((model): BoardWorkerId => model.board?.defaultWorkerId ?? BOARD_LOCAL_WORKER_ID),
  );
  const withHttp = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    effect.pipe(Effect.provideService(HttpClient.HttpClient, http));

  const syncConnections = registry.pipe(Effect.flatMap(connections.sync));

  const state: BoardWorkersShape["state"] = Effect.gen(function* () {
    const workers = yield* registry;
    const runtime = yield* connections.current;
    return {
      defaultWorkerId: yield* defaultWorkerId,
      workers: workers.map((worker): BoardWorkerView => ({
        ...worker,
        status: runtime.get(worker.id)?.status ?? bootStatus(undefined),
        snapshot: runtime.get(worker.id)?.snapshot ?? null,
      })),
      setups: [...(yield* SubscriptionRef.get(setups)).values()],
    };
  });

  /** Board projects with a checkout on a worker, out of all of them. */
  const coverage = (snapshot: BoardWorkerSnapshot) =>
    projects.listShells().pipe(
      Effect.map((shells) => ({
        coveredProjects: shells.filter(
          (shell) =>
            resolveBoardWorkerCheckout(
              boardRepositoryGroupingKey(shell.repositoryIdentity),
              snapshot.checkouts,
            ) !== null,
        ).length,
        totalProjects: shells.length,
      })),
      Effect.orElseSucceed(() => ({ coveredProjects: 0, totalProjects: 0 })),
    );

  /**
   * Prove the worker speaks the board-worker protocol over the session just
   * obtained, and read what it has. A worker that does not is given its
   * session straight back, so a refused add leaves nothing behind on it.
   */
  const probe = (input: {
    readonly url: string;
    readonly accessToken: string;
    readonly workerLabel: string;
    readonly workerVersion: string;
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const link = yield* transport
          .connect({ url: input.url, accessToken: input.accessToken })
          .pipe(
            Effect.mapError((error) =>
              error.reason === "unauthorized"
                ? new BoardWorkerAddError({
                    code: "invalid-credential",
                    message: "The worker refused the board's new session.",
                  })
                : new BoardWorkerAddError({
                    code: "unreachable",
                    message: `The board server can't open a connection to ${input.workerLabel}.`,
                  }),
            ),
          );
        const incompatible = new BoardWorkerAddError({
          code: "incompatible",
          message: `${input.workerLabel} runs T3o ${input.workerVersion}. This board needs ${BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION} or newer on every worker.`,
          workerLabel: input.workerLabel,
          workerVersion: input.workerVersion,
        });
        const hello = yield* link.rpc.hello.pipe(Effect.option);
        if (Option.isNone(hello) || hello.value.protocolVersion < BOARD_WORKER_PROTOCOL_FLOOR) {
          yield* link.rpc.release.pipe(Effect.timeout(RELEASE_TIMEOUT), Effect.ignore);
          return yield* incompatible;
        }
        const snapshot = yield* readWorkerSnapshot(link.rpc).pipe(
          Effect.mapError(
            () =>
              new BoardWorkerAddError({
                code: "unreachable",
                message: `${input.workerLabel} stopped answering while being added.`,
              }),
          ),
        );
        return { hello: hello.value, snapshot };
      }),
    );

  /** Exchange, probe and store: the half of add and re-pair after the worker
      is known to be the right one. */
  const pair = (input: {
    readonly workerId: EnvironmentId;
    readonly httpBaseUrl: string;
    readonly token: string;
    readonly workerLabel: string;
    readonly workerVersion: string;
  }) =>
    Effect.gen(function* () {
      const central = yield* environment.getDescriptor;
      const { accessToken } = yield* withHttp(
        exchangeWorkerCredential({
          target: { httpBaseUrl: input.httpBaseUrl, token: input.token },
          clientLabel: boardSessionLabel(central.label),
        }),
      );
      const probed: { readonly hello: BoardWorkerHello; readonly snapshot: BoardWorkerSnapshot } =
        yield* probe({
          url: input.httpBaseUrl,
          accessToken,
          workerLabel: input.workerLabel,
          workerVersion: input.workerVersion,
        });
      yield* secrets.set(workerSecretName(input.workerId), encodeWorkerToken(accessToken)).pipe(
        Effect.mapError(
          () =>
            new BoardWorkerAddError({
              code: "unreachable",
              message: "The board server couldn't store the worker's credential.",
            }),
        ),
      );
      return probed;
    });

  /** The worker's descriptor, refusing the board server itself. */
  const describe = (httpBaseUrl: string) =>
    Effect.gen(function* () {
      const descriptor = yield* withHttp(fetchWorkerDescriptor(httpBaseUrl));
      if (descriptor.environmentId === (yield* environment.getEnvironmentId)) {
        return yield* new BoardWorkerAddError({
          code: "board-server",
          message:
            "This link is from the board server itself, which is already a worker as “This server (local)”. Use a link from another machine.",
        });
      }
      return descriptor;
    });

  const result = (workerId: EnvironmentId) =>
    Effect.gen(function* () {
      const current = yield* state;
      const worker = current.workers.find((candidate) => candidate.id === workerId);
      if (worker === undefined) {
        return yield* new BoardWorkerAddError({
          code: "not-found",
          message: "The worker was removed while it was being added.",
        });
      }
      return {
        worker,
        ...(worker.snapshot === null
          ? { coveredProjects: 0, totalProjects: 0 }
          : yield* coverage(worker.snapshot)),
      } satisfies BoardWorkerAddResult;
    });

  const dispatchFailure = (code: BoardWorkerAddError["code"], message: string) => () =>
    new BoardWorkerAddError({ code, message });

  const add: BoardWorkersShape["add"] = (input) =>
    Effect.gen(function* () {
      const target = yield* resolveWorkerTarget(input);
      const descriptor = yield* describe(target.httpBaseUrl);
      if (
        input.expectedEnvironmentId !== undefined &&
        descriptor.environmentId !== input.expectedEnvironmentId
      ) {
        return yield* new BoardWorkerAddError({
          code: "different-server",
          message: `That link is for a different server: it's from ${descriptor.label}.`,
          workerLabel: descriptor.label,
        });
      }
      const existing = (yield* registry).find((worker) => worker.id === descriptor.environmentId);
      if (existing !== undefined) {
        return yield* new BoardWorkerAddError({
          code: "already-worker",
          message: `${existing.label} is already a worker.`,
          workerLabel: existing.label,
        });
      }
      const probed = yield* pair({
        workerId: descriptor.environmentId,
        httpBaseUrl: target.httpBaseUrl,
        token: target.token,
        workerLabel: input.label,
        workerVersion: descriptor.serverVersion,
      });
      yield* engine
        .dispatch({
          type: "board.worker.register",
          commandId: yield* newCommandId,
          mode: "add",
          worker: {
            id: descriptor.environmentId,
            label: input.label,
            url: target.httpBaseUrl,
            addedAt: yield* nowIso,
          },
          createdAt: yield* nowIso,
        })
        .pipe(
          Effect.mapError(
            dispatchFailure("already-worker", `${descriptor.label} is already a worker.`),
          ),
        );
      yield* connections.record(descriptor.environmentId, probed.hello, probed.snapshot);
      yield* syncConnections;
      return yield* result(descriptor.environmentId);
    });

  const repair: BoardWorkersShape["repair"] = (input) =>
    Effect.gen(function* () {
      const worker = (yield* registry).find((candidate) => candidate.id === input.workerId);
      if (worker === undefined) {
        return yield* new BoardWorkerAddError({
          code: "not-found",
          message: "That worker isn't on this board any more.",
        });
      }
      const target = yield* resolveWorkerTarget({
        url: input.url ?? worker.url,
        credential: input.credential,
      });
      const descriptor = yield* describe(target.httpBaseUrl);
      if (descriptor.environmentId !== worker.id) {
        return yield* new BoardWorkerAddError({
          code: "different-server",
          message: `You're re-pairing ${worker.label}, but this link is from ${descriptor.label}. Paste a link created on ${worker.label}.`,
          workerLabel: descriptor.label,
        });
      }
      const probed = yield* pair({
        workerId: worker.id,
        httpBaseUrl: target.httpBaseUrl,
        token: target.token,
        workerLabel: worker.label,
        workerVersion: descriptor.serverVersion,
      });
      // Keeps the label, the pinned cards and the limits: only the URL and the
      // session change.
      yield* engine
        .dispatch({
          type: "board.worker.register",
          commandId: yield* newCommandId,
          mode: "repair",
          worker: { ...worker, url: target.httpBaseUrl },
          createdAt: yield* nowIso,
        })
        .pipe(Effect.mapError(dispatchFailure("not-found", "That worker was removed meanwhile.")));
      yield* connections.record(worker.id, probed.hello, probed.snapshot);
      yield* syncConnections;
      yield* connections.restart(worker.id);
      return yield* result(worker.id);
    });

  const remove: BoardWorkersShape["remove"] = (workerId) =>
    Effect.gen(function* () {
      const worker = (yield* registry).find((candidate) => candidate.id === workerId);
      if (worker === undefined) {
        return yield* actionError("not-found", "That worker isn't on this board.");
      }
      if ((yield* defaultWorkerId) === workerId) {
        return yield* actionError("is-default", "Make another worker the default first.");
      }
      // Give the session back first, while the connection that can do it is
      // still up. Unreachable is fine: the human can revoke it on the worker.
      const revoked = yield* connections.get(workerId).pipe(
        Effect.flatMap((rpc) => rpc.release.pipe(Effect.timeout(RELEASE_TIMEOUT))),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      yield* secrets.remove(workerSecretName(workerId)).pipe(Effect.ignore);
      yield* engine
        .dispatch({
          type: "board.worker.remove",
          commandId: yield* newCommandId,
          workerId,
          createdAt: yield* nowIso,
        })
        .pipe(Effect.mapError((cause) => actionError("internal", cause.message)));
      yield* syncConnections;
      yield* dropSetups(workerId);
      return { revoked };
    });

  const setDefault: BoardWorkersShape["setDefault"] = (workerId) =>
    Effect.gen(function* () {
      if ((yield* defaultWorkerId) === workerId) return;
      if (workerId !== BOARD_LOCAL_WORKER_ID) {
        const current = yield* state;
        const worker = current.workers.find((candidate) => candidate.id === workerId);
        if (worker === undefined) {
          return yield* actionError("not-found", "That worker isn't on this board.");
        }
        if (worker.status.state !== "online") {
          return yield* actionError(
            "not-online",
            `${worker.label} is ${worker.status.state}. Only online, compatible, paired workers can be the default.`,
          );
        }
      }
      yield* engine
        .dispatch({
          type: "board.worker.set-default",
          commandId: yield* newCommandId,
          workerId,
          createdAt: yield* nowIso,
        })
        .pipe(Effect.mapError((cause) => actionError("internal", cause.message)));
    });

  // ── Project setup ──────────────────────────────────────────────────

  const putSetup = (setup: BoardWorkerSetup) =>
    SubscriptionRef.update(setups, (map) =>
      new Map(map).set(setupKey(setup.workerId, setup.projectId), setup),
    );

  const patchSetup = (key: string, patch: Partial<BoardWorkerSetup>) =>
    SubscriptionRef.update(setups, (map) => {
      const current = map.get(key);
      return current === undefined ? map : new Map(map).set(key, { ...current, ...patch });
    });

  const dropSetups = (workerId: EnvironmentId) =>
    Effect.gen(function* () {
      const map = yield* SubscriptionRef.get(setups);
      for (const [key, setup] of map) {
        if (setup.workerId !== workerId) continue;
        yield* FiberMap.remove(followers, key);
      }
      yield* SubscriptionRef.set(
        setups,
        new Map([...map].filter(([, setup]) => setup.workerId !== workerId)),
      );
    });

  const failed = (
    workerLabel: string,
    text: string,
    forcedKind?: NonNullable<BoardWorkerSetup["failure"]>["kind"],
  ): NonNullable<BoardWorkerSetup["failure"]> => {
    const kind = forcedKind ?? classifyCloneFailure(text);
    return {
      kind,
      message: cloneFailureMessage(kind, workerLabel),
      log: text.slice(-BOARD_WORKER_SETUP_LOG_MAX_LENGTH),
    };
  };

  /** Follow one clone on the worker until it ends, or the worker goes. */
  const follow = (input: {
    readonly key: string;
    readonly workerId: EnvironmentId;
    readonly workerLabel: string;
    readonly rpc: WorkerRpc;
    readonly workerProjectId: ProjectId;
  }) =>
    Effect.gen(function* () {
      const last = yield* Ref.make<ProjectCloneSnapshot | null>(null);
      const streamed = yield* input.rpc.projectClones.pipe(
        Stream.map((clones) => clones.find((clone) => clone.projectId === input.workerProjectId)),
        Stream.filter((clone): clone is ProjectCloneSnapshot => clone !== undefined),
        Stream.runForEachWhile((clone) =>
          Ref.set(last, clone).pipe(
            Effect.andThen(
              clone.phase === "running"
                ? patchSetup(input.key, { stage: clone.stage, percent: clone.percent })
                : Effect.void,
            ),
            Effect.as(clone.phase === "running"),
          ),
        ),
        Effect.result,
      );
      const final = yield* Ref.get(last);
      const endedAt = yield* nowIso;
      if (streamed._tag === "Failure" || final === null || final.phase === "running") {
        yield* patchSetup(input.key, {
          phase: "failed",
          endedAt,
          failure: failed(input.workerLabel, final?.error ?? "", "worker-offline"),
        });
        return;
      }
      if (final.phase === "done") {
        yield* patchSetup(input.key, { phase: "done", percent: 100, endedAt, failure: null });
        yield* connections.refresh(input.workerId);
        return;
      }
      const log = [final.detail, final.error].filter((line) => line !== null).join("\n");
      yield* patchSetup(input.key, {
        phase: "failed",
        endedAt,
        failure:
          final.phase === "cancelled"
            ? failed(input.workerLabel, log || "The clone was cancelled on the worker.", "unknown")
            : failed(input.workerLabel, log),
      });
    });

  const setupProject: BoardWorkersShape["setupProject"] = (input) =>
    Effect.gen(function* () {
      const current = yield* state;
      const worker = current.workers.find((candidate) => candidate.id === input.workerId);
      if (worker === undefined) {
        return yield* actionError("not-found", "That worker isn't on this board.");
      }
      const project = yield* projects.getShell(input.projectId).pipe(
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      );
      if (project === null) {
        return yield* actionError("not-found", "That project isn't on this board server.");
      }
      // The board pushes to and pulls from `origin` (boardRepository.ts), so
      // that is the remote a worker clones.
      const originUrl = yield* git
        .readConfigValue(project.workspaceRoot, "remote.origin.url")
        .pipe(Effect.orElseSucceed(() => null));
      const remoteUrl = originUrl ?? project.repositoryIdentity?.locator.remoteUrl ?? null;
      if (remoteUrl === null || remoteUrl.trim().length === 0) {
        return yield* actionError(
          "no-remote",
          `${project.title} has no git remote, so it can't be set up on another worker.`,
        );
      }
      const rpc = yield* connections
        .get(worker.id)
        .pipe(
          Effect.mapError(() =>
            actionError("not-online", `${worker.label} is ${worker.status.state}.`),
          ),
        );
      const key = setupKey(worker.id, project.id);
      const previous = (yield* SubscriptionRef.get(setups)).get(key);
      if (previous?.phase === "cloning") return previous;
      const destinationPath =
        input.folder ?? cloneDestination(worker.snapshot?.projectsFolder ?? "~", remoteUrl);
      const startedAt = yield* nowIso;

      // A failed clone the worker still tracks is retried in place; anything
      // else (a new folder, a folder that existed) starts a fresh clone.
      const retryInPlace =
        previous?.phase === "failed" &&
        previous.workerProjectId !== null &&
        previous.destinationPath === destinationPath &&
        previous.failure?.kind !== "folder-exists" &&
        previous.failure?.kind !== "worker-offline";
      const workerProjectId =
        retryInPlace && previous.workerProjectId !== null
          ? previous.workerProjectId
          : ProjectId.make(yield* newUuid);

      const setup: BoardWorkerSetup = {
        projectId: project.id,
        workerId: worker.id,
        workerProjectId: null,
        destinationPath,
        phase: "cloning",
        stage: null,
        percent: null,
        failure: null,
        startedAt,
        endedAt: null,
      };
      const start: Effect.Effect<unknown, WorkerRpcError> = retryInPlace
        ? rpc.retryProjectClone(workerProjectId)
        : rpc.startProjectClone({
            projectId: workerProjectId,
            title: project.title,
            createdAt: startedAt,
            destinationPath,
            remoteUrl,
          });
      const started = yield* Effect.result(start);
      if (started._tag === "Failure") {
        const cause = started.failure.cause;
        const detail =
          typeof cause === "object" && cause !== null && "detail" in cause
            ? String((cause as { readonly detail: unknown }).detail)
            : started.failure.message;
        const failedSetup: BoardWorkerSetup = {
          ...setup,
          phase: "failed",
          endedAt: yield* nowIso,
          failure: failed(worker.label, detail),
        };
        yield* putSetup(failedSetup);
        return failedSetup;
      }
      const cloning: BoardWorkerSetup = { ...setup, workerProjectId };
      yield* putSetup(cloning);
      yield* FiberMap.run(
        followers,
        key,
        follow({ key, workerId: worker.id, workerLabel: worker.label, rpc, workerProjectId }),
      );
      return cloning;
    });

  const dismissSetup: BoardWorkersShape["dismissSetup"] = ({ projectId, workerId }) =>
    Effect.gen(function* () {
      const key = setupKey(workerId, projectId);
      yield* FiberMap.remove(followers, key);
      yield* SubscriptionRef.update(setups, (map) => {
        const next = new Map(map);
        next.delete(key);
        return next;
      });
    });

  // Registry events are in the board log, and the board subscription re-sends
  // the summary when it replays one; these are the changes the log never sees.
  const changes: BoardWorkersShape["changes"] = Stream.merge(
    connections.changes,
    SubscriptionRef.changes(setups).pipe(Stream.drop(1)),
  ).pipe(Stream.mapEffect(() => state));
  const states: BoardWorkersShape["states"] = Stream.merge(
    connections.states,
    SubscriptionRef.changes(setups),
  ).pipe(Stream.mapEffect(() => state));

  // Dial every registered worker from boot.
  yield* syncConnections;

  return {
    add,
    repair,
    remove,
    setDefault,
    setupProject,
    dismissSetup,
    state,
    changes,
    states,
  } satisfies BoardWorkersShape;
});

export const BoardWorkersLive = Layer.effect(BoardWorkers, makeBoardWorkers);
