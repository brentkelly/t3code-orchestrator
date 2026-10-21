/**
 * T3o (T3O-62): the worker RPC handlers, spread into the board's RPC handler
 * record (`board/rpc.ts`).
 *
 * - `board.workers.*` run on the CENTRAL server for its clients, and each is a
 *   thin call into the `BoardWorkers` service.
 * - `boardWorker.*` run on a WORKER for the central server that dialed it: the
 *   handshake, its checkouts, its providers, and giving the board's session
 *   back, or renewing it. Every T3o server answers them; whether it is anyone's worker is up
 *   to the boards that paired with it.
 */
import {
  BOARD_WORKER_PROTOCOL_VERSION,
  BOARD_WORKER_RPC_SCOPES,
  BOARD_WORKER_WS_METHODS,
  BOARD_WORKERS_WS_METHODS,
  BoardWorkerRequestError,
  EnvironmentAuthorizationError,
  type BoardWorkerIdInput,
  type BoardWorkersAddInput,
  type BoardWorkersDismissSetupInput,
  type BoardWorkersRepairInput,
  type BoardWorkersSetDefaultInput,
  type BoardWorkersSetupProjectInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import packageJson from "../../../package.json" with { type: "json" };
import { EnvironmentAuth, type AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { BoardWorkers } from "./BoardWorkers.ts";
import { isBoardSessionLabel } from "./workerCredential.ts";

/** How long the worker lets its answer to `release` reach the board before
    revoking the session that carries it. */
const RELEASE_GRACE = "250 millis";

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
      [BOARD_WORKERS_WS_METHODS.add]: (input: BoardWorkersAddInput) =>
        authorized(
          BOARD_WORKERS_WS_METHODS.add,
          Effect.flatMap(workers, (service) => service.add(input)),
        ),
      [BOARD_WORKERS_WS_METHODS.repair]: (input: BoardWorkersRepairInput) =>
        authorized(
          BOARD_WORKERS_WS_METHODS.repair,
          Effect.flatMap(workers, (service) => service.repair(input)),
        ),
      [BOARD_WORKERS_WS_METHODS.remove]: (input: BoardWorkerIdInput) =>
        authorized(
          BOARD_WORKERS_WS_METHODS.remove,
          Effect.flatMap(workers, (service) => service.remove(input.workerId)),
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
      // Upstream refuses a session revoking itself over HTTP, so a central
      // server giving its access back asks the worker to do it. Forked, a
      // moment after answering: the revocation closes the very socket the
      // answer travels on.
      [BOARD_WORKER_WS_METHODS.release]: (_input: Record<string, never>) =>
        authorized(
          BOARD_WORKER_WS_METHODS.release,
          Effect.flatMap(auth, (service) => service.revokeSession(currentSession.sessionId)).pipe(
            Effect.delay(RELEASE_GRACE),
            Effect.ignore,
            Effect.forkDetach,
            Effect.asVoid,
          ),
        ),
      // The successor copies the caller's subject, scopes and label, so a
      // session can only extend itself, never widen itself. The old one stays
      // valid until the caller gives it back. Only a board's own plain bearer
      // session may renew: a browser cookie or a DPoP-bound session would
      // otherwise trade itself for an unbound token readable from script.
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
              !isBoardSessionLabel(label)
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
