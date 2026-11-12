/**
 * T3o (T3O-84): a worker's threads open through the board's proxy, as an ordinary bearer
 * environment. Each is tagged in web storage with its board and worker, so a refused
 * session can be re-minted and a removed worker's environment pruned.
 */
import {
  connectionRouteId,
  connectionRoutes,
  routeHttpBaseUrl,
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  EnvironmentRegistry,
} from "@t3tools/client-runtime/connection";
import { request } from "@t3tools/client-runtime/rpc";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import { BOARD_WORKERS_WS_METHODS, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connectionAtomRuntime } from "../../connection/runtime";
import { readPreparedConnection } from "../../state/session";
import { boardConnectionIsDirect, workerProxyAddress, workerProxyRouteIds } from "./threadWorker";

const STORAGE_KEY = "t3o:board-worker-environments:v1";

interface WorkerEnvironmentTag {
  readonly boardEnvironmentId: EnvironmentId;
  readonly workerId: EnvironmentId;
}

const TagsSchema = Schema.Record(
  Schema.String,
  Schema.Struct({ boardEnvironmentId: EnvironmentId, workerId: EnvironmentId }),
);
const decodeTags = Schema.decodeUnknownOption(Schema.fromJsonString(TagsSchema));

function readWorkerEnvironmentTags(): Readonly<Record<string, WorkerEnvironmentTag>> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const decoded = decodeTags(raw);
    return decoded._tag === "Some" ? decoded.value : {};
  } catch {
    return {};
  }
}

function writeWorkerEnvironmentTags(tags: Readonly<Record<string, WorkerEnvironmentTag>>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tags));
  } catch {
    // Storage blocked: the environment still works, it just can't be re-minted or pruned later.
  }
}

class WorkerThreadAccessError extends Schema.TaggedError<WorkerThreadAccessError>()(
  "WorkerThreadAccessError",
  { message: Schema.String },
) {}

/**
 * Ask the board for this client's session on a worker and register (or
 * refresh) the worker's proxied environment with it. Re-running replaces the
 * bearer of an environment already registered.
 */
export const openWorkerThreadEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:board:open-worker-thread-environment",
  concurrency: {
    mode: "singleFlight",
    key: (input: { readonly workerId: EnvironmentId }) => input.workerId,
  },
  execute: Effect.fn("BoardWorkerThreads.open")(function* (input: {
    readonly boardEnvironmentId: EnvironmentId;
    readonly workerId: EnvironmentId;
    readonly label: string;
  }) {
    const prepared = readPreparedConnection(input.boardEnvironmentId);
    if (prepared === null || !boardConnectionIsDirect(prepared)) {
      return yield* new WorkerThreadAccessError({
        message: "Open this thread from a direct connection to the board.",
      });
    }
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const access = yield* registry
      .run(
        input.boardEnvironmentId,
        request(BOARD_WORKERS_WS_METHODS.threadAccess, { workerId: input.workerId }),
      )
      .pipe(
        // Only a worker the board no longer has, or won't open for this user, is forgotten;
        // a passing refusal (the worker offline) keeps the environment.
        Effect.tapError((error) =>
          error._tag === "BoardWorkerActionError" &&
          (error.code === "not-found" || error.code === "forbidden")
            ? forgetEnvironment(input.workerId)
            : Effect.void,
        ),
      );
    const address = workerProxyAddress(prepared.httpBaseUrl, access.path);
    const connectionId = `bearer:${access.workerId}:${address.httpBaseUrl.replace(/\/+$/, "")}`;
    yield* registry.register(
      new BearerConnectionRegistration({
        target: new BearerConnectionTarget({
          environmentId: access.workerId,
          label: input.label,
          connectionId,
        }),
        profile: new BearerConnectionProfile({
          connectionId,
          environmentId: access.workerId,
          label: input.label,
          httpBaseUrl: address.httpBaseUrl,
          wsBaseUrl: address.wsBaseUrl,
        }),
        credential: new BearerConnectionCredential({ token: access.bearerToken }),
      }),
    );
    writeWorkerEnvironmentTags({
      ...readWorkerEnvironmentTags(),
      [access.workerId]: {
        boardEnvironmentId: input.boardEnvironmentId,
        workerId: input.workerId,
      },
    });
    yield* registry.setEnabled(access.workerId, true);
    yield* registry.retryNow(access.workerId);
    return access.workerId;
  }),
});

/** Remove a tagged environment's board proxy routes from this client and forget its tag. The
    user's own routes to that machine stay; untagged environments are left alone. */
const forgetEnvironment = Effect.fn("BoardWorkerThreads.forget")(function* (
  environmentId: EnvironmentId,
) {
  const tags = readWorkerEnvironmentTags();
  const tag = tags[environmentId];
  if (tag === undefined) return;
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const entry = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
  const routes =
    entry === undefined
      ? []
      : connectionRoutes(entry).map((route) => ({
          id: connectionRouteId(route.target),
          httpBaseUrl: routeHttpBaseUrl(route),
        }));
  yield* Effect.forEach(workerProxyRouteIds(routes, tag.workerId), (routeId) =>
    registry.removeRoute(environmentId, routeId),
  ).pipe(
    Effect.catch((error) =>
      error._tag === "EnvironmentNotRegisteredError"
        ? Effect.void
        : Effect.logWarning("Could not remove a board worker's environment.", { error }),
    ),
  );
  const { [environmentId]: _removed, ...rest } = readWorkerEnvironmentTags();
  writeWorkerEnvironmentTags(rest);
});

/** Remove the environments a board tagged for workers it no longer has. */
export const pruneWorkerThreadEnvironments = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:board:prune-worker-thread-environments",
  execute: Effect.fn("BoardWorkerThreads.prune")(function* (input: {
    readonly boardEnvironmentId: EnvironmentId;
    readonly workerIds: ReadonlyArray<string>;
  }) {
    const keep = new Set(input.workerIds);
    const stale = Object.entries(readWorkerEnvironmentTags()).flatMap(([environmentId, tag]) =>
      tag.boardEnvironmentId === input.boardEnvironmentId && !keep.has(tag.workerId)
        ? [EnvironmentId.make(environmentId)]
        : [],
    );
    for (const environmentId of stale) yield* forgetEnvironment(environmentId);
  }),
});
