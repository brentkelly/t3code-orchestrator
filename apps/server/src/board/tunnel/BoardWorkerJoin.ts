// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off tryCatchInEffectGen:off globalDateInEffect:off - owns the plain-Node tunnel and a file watch; Effect is the service wrapper.
/**
 * Joining a worker with a one-time code (T3O-84). The worker presents it at the
 * unauthenticated join endpoint and gets a tunnel credential; it is registered then, so its
 * listener exists before its tunnel arrives. A re-join's old credential goes once proved.
 */
import * as NodeCrypto from "node:crypto";
import type * as NodeHttp from "node:http";

import {
  BOARD_LOCAL_WORKER_ABBREVIATION,
  BOARD_WORKER_JOIN_CODE_TTL_MINUTES,
  BoardWorkerActionError,
  BoardWorkerJoinRequest,
  CommandId,
  formatBoardWorkerJoinCode,
  normalizeBoardWorkerJoinCode,
  suggestBoardWorkerAbbreviation,
  T3O_TUNNEL_PROTOCOL_VERSION,
  type BoardWorker,
  type BoardWorkerJoinAccepted,
  type BoardWorkerJoinCodeCreated,
  type BoardWorkerJoinCodeView,
  type BoardWorkerJoinRefused,
  type BoardWorkerJoinRefusal,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { BoardEngine } from "../BoardEngine.ts";
import { BoardRelayStore } from "../workers/BoardRelayStore.ts";
import { WorkerConnections, workerSecretName } from "../workers/WorkerConnections.ts";
import { BoardTunnelHost, JOIN_PROGRESS_TTL_MS } from "./BoardTunnelHost.ts";
import { BoardWorkerJoinStore, hashSecret, type JoinCodeRecord } from "./BoardWorkerJoinStore.ts";
import { setBoardTunnelSeamHandler } from "./upgradeSeam.ts";

export type JoinOutcome =
  | { readonly _tag: "accepted"; readonly body: BoardWorkerJoinAccepted }
  | { readonly _tag: "refused"; readonly status: number; readonly body: BoardWorkerJoinRefused };

export interface BoardWorkerJoinShape {
  readonly createCode: Effect.Effect<BoardWorkerJoinCodeCreated>;
  readonly cancelCode: (codeId: string) => Effect.Effect<void, BoardWorkerActionError>;
  /** The worker's join request, from `address` (null when unknown). */
  readonly join: (body: unknown, address: string | null) => Effect.Effect<JoinOutcome>;
  /** Codes Add worker may still be following. */
  readonly views: Effect.Effect<ReadonlyArray<BoardWorkerJoinCodeView>>;
  /** Ticks on every code or progress change. Each access subscribes. */
  readonly changes: Stream.Stream<void>;
  /** The seam's HTTP handler for the join endpoint. */
  readonly handleHttp: (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ) => void;
}

export class BoardWorkerJoin extends Context.Service<BoardWorkerJoin, BoardWorkerJoinShape>()(
  "t3/board/tunnel/BoardWorkerJoin",
) {}

const decodeJoinRequest = Schema.decodeUnknownExit(BoardWorkerJoinRequest);

const MAX_BODY_BYTES = 8 * 1024;

const refused = (
  status: number,
  reason: BoardWorkerJoinRefused["refused"],
  message: string,
  extra: Partial<BoardWorkerJoinRefused> = {},
): JoinOutcome => ({ _tag: "refused", status, body: { refused: reason, message, ...extra } });

const isLoopbackAddress = (address: string | undefined) =>
  address !== undefined &&
  (address === "::1" || address.startsWith("127.") || address === "::ffff:127.0.0.1");

/**
 * The caller's address. `X-Forwarded-For`'s last hop is believed only when the direct
 * peer is loopback, i.e. a reverse proxy on the board's own machine; otherwise anyone
 * could claim any address.
 */
export function joinCallerAddress(request: {
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly socket: { readonly remoteAddress?: string | undefined };
}): string | null {
  const peer = request.socket.remoteAddress?.replace(/^::ffff:/, "");
  if (isLoopbackAddress(request.socket.remoteAddress)) {
    const header = request.headers["x-forwarded-for"];
    const value = Array.isArray(header) ? header.at(-1) : header;
    const last = value
      ?.split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .at(-1);
    if (last !== undefined) return last;
  }
  return peer ?? null;
}

/** A soft delay before answering an address that keeps failing: guessing codes gets
    slow, and a proxy in front never locks out everyone else. */
function joinFailureDelayMs(failures: number): number {
  return failures <= 0 ? 0 : Math.min(5_000, 100 * 2 ** Math.min(failures, 6));
}

const STRIKE_TTL_MS = BOARD_WORKER_JOIN_CODE_TTL_MINUTES * 60_000;
const MAX_STRIKE_ADDRESSES = 1_024;

export const makeBoardWorkerJoin = Effect.gen(function* () {
  const store = yield* BoardWorkerJoinStore;
  const host = yield* BoardTunnelHost;
  const engine = yield* BoardEngine;
  const environment = yield* ServerEnvironment;
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const relayStore = yield* Effect.serviceOption(BoardRelayStore);
  const connections = yield* WorkerConnections;
  const secrets = yield* ServerSecretStore;
  const context = yield* Effect.context<never>();

  const ticks = yield* SubscriptionRef.make(0);
  const tick = SubscriptionRef.update(ticks, (count) => count + 1);
  /** Refusals by code, for the dialog: needs-update keeps the code open. */
  const refusals = new Map<
    string,
    { reason: BoardWorkerJoinRefusal; at: string; release: string | null }
  >();
  /** Recent refused attempts by address, oldest first; forgotten after a code's lifetime. */
  const strikes = new Map<string, { readonly count: number; readonly at: number }>();

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const newCommandId = Effect.sync(() => CommandId.make(NodeCrypto.randomUUID()));

  const createCode: BoardWorkerJoinShape["createCode"] = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const code = formatBoardWorkerJoinCode(NodeCrypto.randomBytes(5));
    const codeId = NodeCrypto.randomUUID();
    const expiresAt = DateTime.formatIso(
      DateTime.add(now, { minutes: BOARD_WORKER_JOIN_CODE_TTL_MINUTES }),
    );
    yield* store.createCode({
      codeId,
      codeHash: hashSecret(normalizeBoardWorkerJoinCode(code) ?? code),
      createdAt: DateTime.formatIso(now),
      expiresAt,
    });
    yield* tick;
    return { codeId, code, expiresAt };
  }).pipe(Effect.withSpan("BoardWorkerJoin.createCode"));

  const cancelCode: BoardWorkerJoinShape["cancelCode"] = Effect.fn("BoardWorkerJoin.cancelCode")(
    function* (codeId) {
      const cancelled = yield* store.cancelCode(codeId, yield* nowIso);
      if (!cancelled) {
        return yield* new BoardWorkerActionError({
          code: "not-found",
          message: "That code was already used, cancelled or never existed.",
        });
      }
      yield* tick;
    },
  );

  const registry = engine.getReadModel.pipe(
    Effect.map((model) => model.board?.workers ?? ([] as ReadonlyArray<BoardWorker>)),
  );

  const recordRefusal = (
    record: JoinCodeRecord | null,
    reason: BoardWorkerJoinRefusal,
    release: string | null,
  ) =>
    record === null
      ? Effect.void
      : nowIso.pipe(
          Effect.tap((at) =>
            Effect.sync(() => refusals.set(record.codeId, { reason, at, release })),
          ),
          Effect.andThen(tick),
        );

  const join: BoardWorkerJoinShape["join"] = Effect.fn("BoardWorkerJoin.join")(
    function* (body, address) {
      let failures = 0;
      if (address !== null) {
        const now = (yield* DateTime.now).epochMilliseconds;
        const prior = strikes.get(address);
        failures = prior !== undefined && now - prior.at < STRIKE_TTL_MS ? prior.count : 0;
        // Counted before the wait, so parallel attempts from one address each wait longer.
        strikes.delete(address);
        strikes.set(address, { count: failures + 1, at: now });
        while (strikes.size > MAX_STRIKE_ADDRESSES) {
          const oldest = strikes.keys().next().value;
          if (oldest === undefined) break;
          strikes.delete(oldest);
        }
      }
      const delay = joinFailureDelayMs(failures);
      if (delay > 0) yield* Effect.sleep(delay);
      const outcome = yield* attemptJoin(body, address);
      if (
        address !== null &&
        !(outcome._tag === "refused" && outcome.body.refused !== "needs-update")
      ) {
        strikes.delete(address);
      }
      return outcome;
    },
  );

  const attemptJoin = Effect.fn("BoardWorkerJoin.attempt")(function* (
    body: unknown,
    address: string | null,
  ) {
    const decoded = decodeJoinRequest(body);
    if (decoded._tag !== "Success") {
      return refused(400, "unknown", "That isn't a worker join request.");
    }
    const request = decoded.value;
    const normalized = normalizeBoardWorkerJoinCode(request.code);
    const record = normalized === null ? null : yield* store.findCodeByHash(hashSecret(normalized));
    if (record === null) {
      return refused(
        404,
        "unknown",
        "That join code isn't one this board made. Check it, or create a new one.",
      );
    }
    if (record.cancelledAt !== null) {
      yield* recordRefusal(record, "cancelled", request.t3oRelease);
      return refused(
        410,
        "cancelled",
        "That join code was cancelled on the board. Create a new one.",
      );
    }
    if (record.usedAt !== null) {
      yield* recordRefusal(record, "used", request.t3oRelease);
      return refused(
        409,
        "used",
        "That join code was already used. Each code works once; create a new one.",
      );
    }
    const now = yield* DateTime.now;
    if (DateTime.toEpochMillis(now) >= Date.parse(record.expiresAt)) {
      yield* recordRefusal(record, "expired", request.t3oRelease);
      return refused(
        410,
        "expired",
        "That join code has expired. Codes work for 10 minutes; create a new one.",
      );
    }
    if (request.tunnelProtocol !== T3O_TUNNEL_PROTOCOL_VERSION) {
      // The code stays valid: update whichever side is older and run the same command.
      yield* recordRefusal(record, "needs-update", request.t3oRelease);
      return refused(
        426,
        "needs-update",
        `This worker speaks tunnel protocol ${request.tunnelProtocol}, the board ${T3O_TUNNEL_PROTOCOL_VERSION}. Update T3o on the older side, then run the same command; the code still works.`,
        { tunnelProtocol: T3O_TUNNEL_PROTOCOL_VERSION },
      );
    }
    const boardId = yield* environment.getEnvironmentId;
    if (request.environmentId === boardId) {
      return refused(
        409,
        "board-server",
        "That's the board server itself; it's already a worker as This server.",
      );
    }
    const usedAt = DateTime.formatIso(now);
    const workers = yield* registry;
    const existing = workers.find((worker) => worker.id === request.environmentId);
    const claimed = yield* store.useCode({
      codeId: record.codeId,
      usedAt,
      workerId: request.environmentId,
      label: request.label,
      address,
      release: request.t3oRelease,
      rejoin: existing !== undefined,
    });
    if (!claimed) {
      return refused(
        409,
        "used",
        "That join code was already used. Each code works once; create a new one.",
      );
    }
    refusals.delete(record.codeId);

    const label = request.label.slice(0, 64);
    const abbreviation =
      existing?.abbreviation ??
      suggestBoardWorkerAbbreviation(
        label,
        workers.flatMap((worker) =>
          worker.abbreviation === undefined ? [] : [worker.abbreviation],
        ),
      ) ??
      undefined;
    const worker: BoardWorker = {
      id: request.environmentId as EnvironmentId,
      label: existing?.label ?? label,
      addedAt: existing?.addedAt ?? usedAt,
      t3oRelease: request.t3oRelease,
      joinedAt: usedAt,
      ...(abbreviation === undefined || abbreviation === BOARD_LOCAL_WORKER_ABBREVIATION
        ? {}
        : { abbreviation }),
    };
    // A server added back starts reading its signals at its log's head, as a new one does:
    // what it logged while it wasn't a worker isn't the board's.
    if (existing === undefined && relayStore._tag === "Some") {
      yield* relayStore.value
        .forgetSignalCursor(request.environmentId as EnvironmentId)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("board worker cursor not forgotten", { cause }),
          ),
        );
    }
    const register = Effect.fn("BoardWorkerJoin.register")(function* (candidate: BoardWorker) {
      return yield* engine
        .dispatch({
          type: "board.worker.register",
          commandId: yield* newCommandId,
          mode: existing === undefined ? "add" : "repair",
          worker: candidate,
          createdAt: usedAt,
        })
        .pipe(Effect.result);
    });
    let registered = yield* register(worker);
    // A suggested abbreviation can lose a race to a concurrent join; join without one.
    if (
      registered._tag === "Failure" &&
      existing === undefined &&
      worker.abbreviation !== undefined
    ) {
      const { abbreviation: _dropped, ...unabbreviated } = worker;
      registered = yield* register(unabbreviated);
    }
    if (registered._tag === "Failure") {
      // The worker never made it onto the board, so the code isn't spent.
      yield* store.releaseCode(record.codeId);
      return refused(
        500,
        "busy",
        "The board couldn't record the worker. Run the same command again; the code still works.",
      );
    }

    const credential = NodeCrypto.randomBytes(32).toString("base64url");
    yield* store.issueCredential({
      workerId: request.environmentId,
      credentialHash: hashSecret(credential),
      issuedAt: usedAt,
    });
    // The worker mints a fresh session on its first hello. One held from before (a
    // direct-dial session from an older release) would be probed and refused forever.
    yield* secrets
      .remove(workerSecretName(request.environmentId as EnvironmentId))
      .pipe(Effect.ignore);
    yield* host.ensure(request.environmentId as EnvironmentId);
    yield* host.beginJoin(request.environmentId as EnvironmentId);
    // Starts following a worker that is new to the registry; a re-joined one is already followed.
    yield* engine.getReadModel.pipe(
      Effect.flatMap((model) => connections.sync(model.board?.workers ?? [])),
    );
    yield* tick;
    const descriptor = yield* environment.getDescriptor;
    const boardAddress = yield* boardAddressSetting;
    return {
      _tag: "accepted",
      body: {
        tunnelCredential: credential,
        boardEnvironmentId: boardId,
        boardLabel: descriptor.label,
        ...(boardAddress === null ? {} : { boardAddress }),
      },
    } satisfies JoinOutcome;
  });

  const boardAddressSetting =
    settings._tag === "None"
      ? Effect.succeed<string | null>(null)
      : settings.value.getSettings.pipe(
          Effect.map((value) => value.board?.workers.boardAddress ?? null),
          Effect.orElseSucceed(() => null),
        );

  const views: BoardWorkerJoinShape["views"] = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const nowMillis = DateTime.toEpochMillis(now);
    const since = new Date(nowMillis - JOIN_PROGRESS_TTL_MS).toISOString();
    const records = yield* store.recentCodes(since);
    const progress = yield* SubscriptionRef.get(host.milestones);
    return records.map((record): BoardWorkerJoinCodeView => {
      const refusal = refusals.get(record.codeId);
      return {
        codeId: record.codeId,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        state:
          record.cancelledAt !== null
            ? "cancelled"
            : record.usedAt !== null
              ? "used"
              : Date.parse(record.expiresAt) <= nowMillis
                ? "expired"
                : "open",
        usedBy:
          record.usedAt === null || record.usedByWorkerId === null
            ? null
            : {
                workerId: record.usedByWorkerId as EnvironmentId,
                label: record.usedByLabel ?? record.usedByWorkerId,
                address: record.usedFrom,
                t3oRelease: record.usedRelease,
                usedAt: record.usedAt,
                rejoin: record.rejoin,
              },
        milestones:
          record.usedByWorkerId === null ? [] : [...(progress.get(record.usedByWorkerId) ?? [])],
        lastRefusal:
          refusal === undefined
            ? null
            : { reason: refusal.reason, at: refusal.at, t3oRelease: refusal.release },
      };
    });
  }).pipe(Effect.withSpan("BoardWorkerJoin.views"));

  const changes: BoardWorkerJoinShape["changes"] = Stream.merge(
    SubscriptionRef.changes(ticks).pipe(Stream.drop(1)),
    SubscriptionRef.changes(host.milestones).pipe(Stream.drop(1)),
  ).pipe(Stream.as(undefined));

  const respond = (response: NodeHttp.ServerResponse, status: number, body: unknown) => {
    if (response.headersSent) return;
    const text = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
      "cache-control": "no-store",
    });
    response.end(text);
  };

  const handleHttp: BoardWorkerJoinShape["handleHttp"] = (request, response) => {
    if (request.method !== "POST") {
      respond(response, 405, { refused: "unknown", message: "POST a join request." });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        respond(response, 413, { refused: "unknown", message: "Request too large." });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > MAX_BODY_BYTES) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        respond(response, 400, { refused: "unknown", message: "The join request isn't JSON." });
        return;
      }
      void Effect.runPromiseWith(context)(join(body, joinCallerAddress(request))).then(
        (outcome) =>
          outcome._tag === "accepted"
            ? respond(response, 200, outcome.body)
            : respond(response, outcome.status, outcome.body),
        () => respond(response, 500, { refused: "busy", message: "The board failed the join." }),
      );
    });
  };

  return {
    createCode,
    cancelCode,
    join,
    views,
    changes,
    handleHttp,
  } satisfies BoardWorkerJoinShape;
});

export const BoardWorkerJoinLive = Layer.effect(BoardWorkerJoin, makeBoardWorkerJoin);

/** Point the HTTP seam at the board's tunnel host and join endpoint, for the layer's
    lifetime. Until this is built, T3o's paths answer 503. */
export const BoardTunnelSeamLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const host = yield* BoardTunnelHost;
    const join = yield* BoardWorkerJoin;
    const withdraw = setBoardTunnelSeamHandler({ ...host.seam, join: join.handleHttp });
    yield* Effect.addFinalizer(() => Effect.sync(withdraw));
  }),
);
