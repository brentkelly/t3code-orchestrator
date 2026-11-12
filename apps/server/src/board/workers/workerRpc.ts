/**
 * Worker RPC handlers for `board/rpc.ts`. `board.workers.*` run on the central
 * server for its clients; `boardWorker.*` run on a worker for the central server
 * that dialed it, and every T3o server answers them.
 */
import {
  BOARD_WORKER_PROTOCOL_VERSION,
  BOARD_WORKER_RPC_SCOPES,
  BOARD_WORKER_WS_METHODS,
  BOARD_WORKERS_WS_METHODS,
  BoardWorkerRequestError,
  EnvironmentAuthorizationError,
  type BoardWorkerIdInput,
  type BoardWorkerMintUserSessionInput,
  type BoardWorkerReleaseInput,
  type BoardWorkerRevokeUserSessionsInput,
  type BoardWorkersCancelJoinCodeInput,
  type BoardWorkersDismissSetupInput,
  type BoardWorkersRenameInput,
  type BoardWorkersSetDefaultInput,
  type BoardWorkersSetupProjectInput,
  boardIdOfBoardSubject,
  T3O_BOARD_USER_SUBJECT_PREFIX,
  t3oBoardSubject,
  t3oBoardUserSubject,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import packageJson from "../../../package.json" with { type: "json" };
import { EnvironmentAuth, type AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { BoardWorkers } from "./BoardWorkers.ts";
import * as ManagedLimits from "../../policy/managedLimits.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";

/** How long the worker lets its answer to `release` reach the board before
    revoking the session that carries it. */
const RELEASE_GRACE = "250 millis";

/** How long a board user's worker session lives; the board re-mints on a 401. */
const USER_SESSION_TTL = Duration.hours(24);

/**
 * Revoke every session a worker issued for one board: the board's own and each of its
 * users'. Remove, `t3o-worker leave` and a refused credential all end here.
 */
export const revokeBoardSessions = Effect.fn("boardWorker.revokeBoardSessions")(function* (
  service: EnvironmentAuth["Service"],
  boardId: string,
) {
  if (boardId.length === 0) return 0;
  const own = t3oBoardSubject(boardId);
  const userPrefix = `${T3O_BOARD_USER_SUBJECT_PREFIX}${boardId}:`;
  const sessions = yield* service.listSessions();
  let revoked = 0;
  for (const session of sessions) {
    if (session.subject !== own && !session.subject.startsWith(userPrefix)) continue;
    yield* service.revokeSession(session.sessionId).pipe(Effect.ignore);
    revoked += 1;
  }
  return revoked;
});

/** Revoke a board's user sessions whose board session is no longer alive there. */
export const reconcileBoardUserSessions = Effect.fn("boardWorker.reconcileBoardUserSessions")(
  function* (
    service: EnvironmentAuth["Service"],
    boardId: string,
    liveBoardSessionIds: ReadonlyArray<string>,
  ) {
    const live = new Set(liveBoardSessionIds);
    const userPrefix = `${T3O_BOARD_USER_SUBJECT_PREFIX}${boardId}:`;
    const sessions = yield* service.listSessions();
    let revoked = 0;
    for (const session of sessions) {
      if (!session.subject.startsWith(userPrefix)) continue;
      if (live.has(session.subject.slice(userPrefix.length))) continue;
      yield* service.revokeSession(session.sessionId).pipe(Effect.ignore);
      revoked += 1;
    }
    return revoked;
  },
);

const requestError = (message: string) => (cause: unknown) =>
  new BoardWorkerRequestError({ message, cause });

/** Services are read per call, so building the handler record needs none of
    them: a worker answers `boardWorker.*` whether or not it hosts a board. */
export const boardWorkerRpcHandlers = (currentSession: AuthenticatedSession) =>
  Effect.sync(() => {
    const workers = BoardWorkers;
    const environment = ServerEnvironment;
    const projects = ProjectService;
    const providers = ProviderRegistry;
    const settings = ServerSettingsService;
    const auth = EnvironmentAuth;

    const authorized = <A, E, R>(
      method: keyof typeof BOARD_WORKER_RPC_SCOPES,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> => {
      const requiredScope = BOARD_WORKER_RPC_SCOPES[method];
      return currentSession.scopes.includes(requiredScope)
        ? effect
        : Effect.fail(
            new EnvironmentAuthorizationError({
              message: `The authenticated token is missing required scope: ${requiredScope}.`,
              requiredScope,
            }),
          );
    };

    return {
      // ── Central server: managing this board's workers ───────────────
      [BOARD_WORKERS_WS_METHODS.createJoinCode]: (_input: Record<string, never>) =>
        authorized(
          BOARD_WORKERS_WS_METHODS.createJoinCode,
          Effect.flatMap(workers, (service) => service.createJoinCode),
        ),
      [BOARD_WORKERS_WS_METHODS.cancelJoinCode]: (input: BoardWorkersCancelJoinCodeInput) =>
        authorized(
          BOARD_WORKERS_WS_METHODS.cancelJoinCode,
          Effect.flatMap(workers, (service) => service.cancelJoinCode(input.codeId)),
        ),
      [BOARD_WORKERS_WS_METHODS.rename]: (input: BoardWorkersRenameInput) =>
        authorized(
          BOARD_WORKERS_WS_METHODS.rename,
          Effect.flatMap(workers, (service) => service.rename(input)),
        ),
      [BOARD_WORKERS_WS_METHODS.threadAccess]: (input: BoardWorkerIdInput) =>
        authorized(
          BOARD_WORKERS_WS_METHODS.threadAccess,
          Effect.gen(function* () {
            const service = yield* workers;
            const sessions = yield* Effect.flatMap(auth, (a) => a.listSessions()).pipe(
              Effect.orElseSucceed(() => []),
            );
            const client = sessions.find(
              (session) => session.sessionId === currentSession.sessionId,
            )?.client;
            return yield* service.threadAccess(input.workerId, {
              sessionId: currentSession.sessionId,
              scopes: currentSession.scopes,
              deviceLabel: client?.label ?? client?.browser ?? client?.deviceType ?? "Browser",
            });
          }),
        ),
      [BOARD_WORKERS_WS_METHODS.remove]: (input: BoardWorkerIdInput) =>
        authorized(
          BOARD_WORKERS_WS_METHODS.remove,
          Effect.flatMap(workers, (service) => service.remove(input.workerId)),
        ),
      [BOARD_WORKERS_WS_METHODS.removePreview]: (input: BoardWorkerIdInput) =>
        authorized(
          BOARD_WORKERS_WS_METHODS.removePreview,
          Effect.flatMap(workers, (service) => service.removePreview(input.workerId)),
        ),
      [BOARD_WORKERS_WS_METHODS.setDefault]: (input: BoardWorkersSetDefaultInput) =>
        authorized(
          BOARD_WORKERS_WS_METHODS.setDefault,
          Effect.flatMap(workers, (service) => service.setDefault(input.workerId)),
        ),
      [BOARD_WORKERS_WS_METHODS.setupProject]: (input: BoardWorkersSetupProjectInput) =>
        authorized(
          BOARD_WORKERS_WS_METHODS.setupProject,
          Effect.flatMap(workers, (service) => service.setupProject(input)),
        ),
      [BOARD_WORKERS_WS_METHODS.dismissSetup]: (input: BoardWorkersDismissSetupInput) =>
        authorized(
          BOARD_WORKERS_WS_METHODS.dismissSetup,
          Effect.flatMap(workers, (service) => service.dismissSetup(input)),
        ),

      // ── Worker: answering a central server ──────────────────────────
      [BOARD_WORKER_WS_METHODS.hello]: (_input: Record<string, never>) =>
        authorized(
          BOARD_WORKER_WS_METHODS.hello,
          Effect.flatMap(environment, (service) => service.getEnvironmentId).pipe(
            Effect.map((environmentId) => ({
              protocolVersion: BOARD_WORKER_PROTOCOL_VERSION,
              environmentId,
              t3oVersion: packageJson.version,
              sessionExpiresAt:
                currentSession.expiresAt === undefined
                  ? null
                  : DateTime.formatIso(currentSession.expiresAt),
            })),
          ),
        ),
      [BOARD_WORKER_WS_METHODS.projects]: (_input: Record<string, never>) =>
        authorized(
          BOARD_WORKER_WS_METHODS.projects,
          Effect.flatMap(projects, (service) => service.listShells()).pipe(
            Effect.map((shells) => ({
              projects: shells.map((shell) => ({
                projectId: shell.id,
                title: shell.title,
                workspaceRoot: shell.workspaceRoot,
                repositoryIdentity: shell.repositoryIdentity ?? null,
              })),
            })),
            Effect.mapError(requestError("Couldn't list this server's projects.")),
          ),
        ),
      [BOARD_WORKER_WS_METHODS.providers]: (_input: Record<string, never>) =>
        authorized(
          BOARD_WORKER_WS_METHODS.providers,
          Effect.gen(function* () {
            const current = yield* Effect.flatMap(providers, (service) => service.getProviders);
            const serverSettings = yield* Effect.flatMap(
              settings,
              (service) => service.getSettings,
            ).pipe(Effect.mapError(requestError("Couldn't read this server's settings.")));
            const folder = serverSettings.addProjectBaseDirectory.trim();
            return {
              providers: current.map((provider) => ({
                instanceId: provider.instanceId,
                driver: provider.driver,
                displayName: provider.displayName ?? null,
                enabled: provider.enabled,
                models: provider.models.map((model) => ({ slug: model.slug, name: model.name })),
              })),
              projectsFolder: folder.length > 0 ? folder : null,
            };
          }),
        ),
      // Upstream won't let a session revoke itself over HTTP, so the worker does it a
      // moment after answering: the revocation closes the socket the answer travels on.
      // Only `all` (Remove) reaches the board's other sessions; a renewal's release must
      // leave the successor it just stored alone.
      [BOARD_WORKER_WS_METHODS.release]: (input: BoardWorkerReleaseInput) =>
        authorized(
          BOARD_WORKER_WS_METHODS.release,
          Effect.flatMap(auth, (service) =>
            input.all === true
              ? revokeBoardSessions(service, boardIdOfBoardSubject(currentSession.subject) ?? "")
              : service.revokeSession(currentSession.sessionId),
          ).pipe(Effect.delay(RELEASE_GRACE), Effect.ignore, Effect.forkDetach, Effect.asVoid),
        ),
      [BOARD_WORKER_WS_METHODS.mintUserSession]: (input: BoardWorkerMintUserSessionInput) =>
        authorized(
          BOARD_WORKER_WS_METHODS.mintUserSession,
          Effect.gen(function* () {
            const boardId = boardIdOfBoardSubject(currentSession.subject);
            if (boardId === null) {
              return yield* new BoardWorkerRequestError({ message: "Board sessions only." });
            }
            const policy = yield* Effect.serviceOption(ManagedPolicy.ManagedPolicy);
            if (policy._tag === "Some" && !ManagedLimits.allowsRemoteClients(policy.value)) {
              return yield* new BoardWorkerRequestError({
                message: "This worker's managed policy doesn't allow remote clients.",
              });
            }
            // Never wider than the board's own session here.
            const scopes = input.scopes.filter((scope): scope is AuthEnvironmentScope =>
              currentSession.scopes.includes(scope as AuthEnvironmentScope),
            );
            const issued = yield* Effect.flatMap(auth, (service) =>
              service.issueSession({
                subject: t3oBoardUserSubject(boardId, input.boardSessionId),
                scopes,
                label: input.label,
                ttl: USER_SESSION_TTL,
              }),
            ).pipe(Effect.mapError(requestError("Couldn't issue a session for this thread view.")));
            return {
              bearerToken: issued.token,
              expiresAt: DateTime.formatIso(issued.expiresAt),
              scopes: issued.scopes,
            };
          }),
        ),
      [BOARD_WORKER_WS_METHODS.revokeUserSessions]: (input: BoardWorkerRevokeUserSessionsInput) =>
        authorized(
          BOARD_WORKER_WS_METHODS.revokeUserSessions,
          Effect.gen(function* () {
            const boardId = boardIdOfBoardSubject(currentSession.subject) ?? "";
            const service = yield* auth;
            const wanted = new Set(
              input.boardSessionIds.map((sessionId) => t3oBoardUserSubject(boardId, sessionId)),
            );
            const sessions = yield* service
              .listSessions()
              .pipe(Effect.mapError(requestError("Couldn't list sessions.")));
            let revoked = 0;
            for (const session of sessions) {
              if (!wanted.has(session.subject)) continue;
              yield* service.revokeSession(session.sessionId).pipe(Effect.ignore);
              revoked += 1;
            }
            return { revoked };
          }),
        ),
      // The successor copies subject, scopes and label, so a session can extend
      // but never widen itself. Only a plain bearer session may renew: a cookie or
      // DPoP-bound one would trade itself for an unbound token readable from script.
      // The label is advisory; any bearer client can renew, but only with what it holds.
      [BOARD_WORKER_WS_METHODS.renew]: (_input: Record<string, never>) =>
        authorized(
          BOARD_WORKER_WS_METHODS.renew,
          Effect.gen(function* () {
            const service = yield* auth;
            const sessions = yield* service
              .listSessions()
              .pipe(Effect.mapError(requestError("Couldn't renew the board's session.")));
            const label = sessions.find((session) => session.sessionId === currentSession.sessionId)
              ?.client.label;
            if (
              currentSession.method !== "bearer-access-token" ||
              currentSession.proofKeyThumbprint !== undefined ||
              label === undefined ||
              boardIdOfBoardSubject(currentSession.subject) === null
            ) {
              return yield* new BoardWorkerRequestError({
                message: "Only a board's own session can be renewed.",
              });
            }
            const issued = yield* service
              .issueSession({
                subject: currentSession.subject,
                scopes: currentSession.scopes,
                label,
              })
              .pipe(Effect.mapError(requestError("Couldn't renew the board's session.")));
            return { accessToken: issued.token };
          }),
        ),
    };
  });
