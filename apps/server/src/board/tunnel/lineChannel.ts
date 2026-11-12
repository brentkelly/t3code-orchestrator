// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off extendsNativeError:off - plain Node sockets and files: a byte pipe below Effect, also used by the CLI.
/**
 * The tunnel's control channel: newline-delimited JSON over a raw upgraded socket.
 * Not a WebSocket, so a front that passes the stream legs' upgrade passes this too,
 * and no WebSocket library sits in the path. Each side pings every 15 s and counts
 * the other gone after 30 s of silence.
 */
import type * as Net from "node:net";
import { StringDecoder } from "node:string_decoder";

export const CONTROL_PING_INTERVAL_MS = 15_000;
export const CONTROL_DEAD_AFTER_MS = 30_000;
/** A control message never comes near this; a line that does is a broken peer. */
const MAX_LINE_BYTES = 256 * 1024;

export interface LineChannel {
  readonly send: (message: unknown) => void;
  readonly close: () => void;
  readonly closed: Promise<void>;
  readonly isClosed: () => boolean;
}

export interface LineChannelOptions {
  readonly onMessage: (message: unknown) => void;
  readonly onClose?: () => void;
  /** Timers, injectable so tests drive them. */
  readonly pingIntervalMs?: number;
  readonly deadAfterMs?: number;
}

export function openLineChannel(
  socket: Net.Socket,
  head: Buffer,
  options: LineChannelOptions,
): LineChannel {
  let buffered = "";
  let closed = false;
  let lastHeard = Date.now();
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30_000);
  // Not `setEncoding`: Node refuses it on a socket an HTTP server handed over.
  const decoder = new StringDecoder("utf8");

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(pinger);
    socket.destroy();
    options.onClose?.();
    resolveClosed();
  };

  const send = (message: unknown) => {
    if (closed || socket.destroyed) return;
    socket.write(`${JSON.stringify(message)}\n`);
  };

  const consume = (chunk: string) => {
    lastHeard = Date.now();
    buffered += chunk;
    if (buffered.length > MAX_LINE_BYTES && !buffered.includes("\n")) {
      close();
      return;
    }
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line.length > 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          close();
          return;
        }
        if (isPing(parsed)) send({ type: "pong" });
        else if (!isPong(parsed)) options.onMessage(parsed);
        if (closed) return;
      }
      newline = buffered.indexOf("\n");
    }
  };

  const deadAfter = options.deadAfterMs ?? CONTROL_DEAD_AFTER_MS;
  const pinger = setInterval(() => {
    if (Date.now() - lastHeard > deadAfter) {
      close();
      return;
    }
    send({ type: "ping" });
  }, options.pingIntervalMs ?? CONTROL_PING_INTERVAL_MS);
  pinger.unref?.();

  socket.on("data", (chunk: Buffer) => consume(decoder.write(chunk)));
  socket.on("close", close);
  socket.on("error", close);
  if (head.length > 0) consume(decoder.write(head));

  return { send, close, closed: closedPromise, isClosed: () => closed };
}

const isPing = (value: unknown): boolean =>
  typeof value === "object" && value !== null && (value as { type?: unknown }).type === "ping";

const isPong = (value: unknown): boolean =>
  typeof value === "object" && value !== null && (value as { type?: unknown }).type === "pong";

/** A refusal on a raw upgrade socket: a plain HTTP response, then close. */
export function refuseUpgrade(
  socket: Net.Socket,
  status: number,
  reason: string,
  body?: unknown,
): void {
  if (socket.destroyed) return;
  const text = body === undefined ? "" : JSON.stringify(body);
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`,
  );
  socket.destroySoon?.();
}

export function acceptUpgrade(socket: Net.Socket, protocol: string): void {
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${protocol}\r\nConnection: Upgrade\r\n\r\n`,
  );
}

/** Join two sockets both ways. `pipe()` carries backpressure: a slow reader pauses
    the far writer instead of growing a buffer. Either side ending ends both. */
export function joinSockets(left: Net.Socket, right: Net.Socket, onClose?: () => void): void {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    left.destroy();
    right.destroy();
    onClose?.();
  };
  for (const socket of [left, right]) {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    socket.on("error", finish);
    socket.on("close", finish);
  }
  left.pipe(right);
  right.pipe(left);
}

export function bearerOf(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value);
  return match?.[1] ?? null;
}
