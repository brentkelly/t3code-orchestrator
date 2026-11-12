/**
 * T3o (T3O-84): the wire between an outbound-only worker and each board it serves.
 * The worker joins with a one-time code, then holds a control WebSocket to the board;
 * every TCP connection the board opens into the worker gets its own dial-back leg.
 * The tunnel is a dumb byte pipe and never parses T3 traffic.
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BoardWorkerJoinRefusal } from "./boardWorkers.ts";

/** Small and frozen: a mismatch refuses the tunnel (Needs update). The gateway
    protocol (`BOARD_WORKER_PROTOCOL_VERSION`) versions everything above it. */
export const T3O_TUNNEL_PROTOCOL_VERSION = 1;

export const BOARD_WORKER_JOIN_PATH = "/api/t3o/worker-join";
export const BOARD_WORKER_TUNNEL_PATH = "/api/t3o/worker-tunnel";
export const BOARD_WORKER_TUNNEL_STREAM_PATH = "/api/t3o/worker-tunnel/stream";
/** Browsers reach a worker's environment under `<prefix><workerId>/`. */
export const BOARD_WORKER_PROXY_PREFIX = "/api/t3o/workers/";
/** The `Upgrade` token of a stream leg. Not a WebSocket: raw bytes after the 101. */
export const BOARD_WORKER_STREAM_UPGRADE = "t3o-stream";

/** The board's proxied base path for a worker. */
export const boardWorkerProxyPath = (workerId: string): string =>
  `${BOARD_WORKER_PROXY_PREFIX}${encodeURIComponent(workerId)}/`;

/** Subjects of sessions a worker issues for a board (`t3o-board:<id>`) and for one
    board user (`t3o-board-user:<id>:<boardSessionId>`). The worker trusts board RPCs
    only from the first. */
const T3O_BOARD_SUBJECT_PREFIX = "t3o-board:";
export const T3O_BOARD_USER_SUBJECT_PREFIX = "t3o-board-user:";

export const t3oBoardSubject = (boardEnvironmentId: string): string =>
  `${T3O_BOARD_SUBJECT_PREFIX}${boardEnvironmentId}`;

export const t3oBoardUserSubject = (boardEnvironmentId: string, boardSessionId: string): string =>
  `${T3O_BOARD_USER_SUBJECT_PREFIX}${boardEnvironmentId}:${boardSessionId}`;

/** The board a `t3o-board:` subject names, or null for any other subject. */
export function boardIdOfBoardSubject(subject: string): string | null {
  if (!subject.startsWith(T3O_BOARD_SUBJECT_PREFIX)) return null;
  const id = subject.slice(T3O_BOARD_SUBJECT_PREFIX.length);
  return id.length > 0 ? id : null;
}

/** Whether a session belongs to a board at all, as its own or one of its users'. */
export const isT3oBoardSubject = (subject: string): boolean =>
  subject.startsWith(T3O_BOARD_SUBJECT_PREFIX) || subject.startsWith(T3O_BOARD_USER_SUBJECT_PREFIX);

// ── Joining ────────────────────────────────────────────────────────────

/** An environment id a peer hands us. It names secret files and URL paths, so it must
    be a plain token: no separators, no leading dot. */
export const TunnelEnvironmentId = EnvironmentId.check(
  Schema.isPattern(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/),
);

export const BoardWorkerJoinRequest = Schema.Struct({
  code: TrimmedNonEmptyString,
  environmentId: TunnelEnvironmentId,
  label: TrimmedNonEmptyString,
  t3oRelease: TrimmedNonEmptyString,
  tunnelProtocol: NonNegativeInt,
});
export type BoardWorkerJoinRequest = typeof BoardWorkerJoinRequest.Type;

export const BoardWorkerJoinAccepted = Schema.Struct({
  tunnelCredential: TrimmedNonEmptyString,
  boardEnvironmentId: TunnelEnvironmentId,
  boardLabel: TrimmedNonEmptyString,
  /** The board's own idea of its address, when its Board address is set. */
  boardAddress: Schema.optionalKey(TrimmedNonEmptyString),
});
export type BoardWorkerJoinAccepted = typeof BoardWorkerJoinAccepted.Type;

export const BoardWorkerJoinRefused = Schema.Struct({
  refused: Schema.Union([BoardWorkerJoinRefusal, Schema.Literals(["board-server", "busy"])]),
  message: TrimmedNonEmptyString,
  /** For needs-update: the tunnel protocol the board speaks. */
  tunnelProtocol: Schema.optionalKey(NonNegativeInt),
});
export type BoardWorkerJoinRefused = typeof BoardWorkerJoinRefused.Type;

// ── The control channel ────────────────────────────────────────────────

export const WorkerTunnelHello = Schema.Struct({
  type: Schema.Literal("hello"),
  tunnelProtocol: NonNegativeInt,
  environmentId: TunnelEnvironmentId,
  label: TrimmedNonEmptyString,
  t3oRelease: TrimmedNonEmptyString,
  gatewayProtocol: NonNegativeInt,
  /** The board's own session on the worker, sent when the board asked for one. */
  boardSession: Schema.optionalKey(TrimmedNonEmptyString),
});
export type WorkerTunnelHello = typeof WorkerTunnelHello.Type;

/** Worker → board. */
export const WorkerTunnelClientMessage = Schema.Union([
  WorkerTunnelHello,
  Schema.Struct({ type: Schema.Literal("goodbye") }),
  Schema.Struct({ type: Schema.Literal("ping") }),
  Schema.Struct({ type: Schema.Literal("pong") }),
]);
export type WorkerTunnelClientMessage = typeof WorkerTunnelClientMessage.Type;

export const WorkerTunnelHelloAck = Schema.Struct({
  type: Schema.Literal("helloAck"),
  /** `needs-update` is a tunnel-protocol mismatch only. */
  status: Schema.Literals(["ok", "needs-session", "needs-update", "revoked"]),
  boardAddress: Schema.optionalKey(TrimmedNonEmptyString),
  /** Board sessions still alive: the worker revokes user sessions minted for any other. */
  liveBoardSessionIds: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  tunnelProtocol: Schema.optionalKey(NonNegativeInt),
  message: Schema.optionalKey(Schema.String),
});
export type WorkerTunnelHelloAck = typeof WorkerTunnelHelloAck.Type;

/** Board → worker. */
export const WorkerTunnelServerMessage = Schema.Union([
  WorkerTunnelHelloAck,
  Schema.Struct({
    type: Schema.Literal("dial"),
    streamId: TrimmedNonEmptyString,
    nonce: TrimmedNonEmptyString,
  }),
  Schema.Struct({ type: Schema.Literal("ping") }),
  Schema.Struct({ type: Schema.Literal("pong") }),
]);
export type WorkerTunnelServerMessage = typeof WorkerTunnelServerMessage.Type;
