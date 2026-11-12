// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off extendsNativeError:off - plain Node sockets and files: a byte pipe below Effect, also used by the CLI.
/**
 * The board's end of each worker's tunnel: a stable `127.0.0.1` listener per worker whose
 * connections become `dial`s, joined with the worker's dial-back leg by `pipe()`. Streams
 * open before `ok`, because the probe needs them: credential → live → session → probe → ok.
 */
import * as NodeCrypto from "node:crypto";
import type * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as Schema from "effect/Schema";

import {
  BOARD_WORKER_STREAM_UPGRADE,
  T3O_TUNNEL_PROTOCOL_VERSION,
  WorkerTunnelClientMessage,
  type WorkerTunnelHello,
  type WorkerTunnelHelloAck,
} from "@t3tools/contracts";

import {
  acceptUpgrade,
  bearerOf,
  joinSockets,
  openLineChannel,
  refuseUpgrade,
  type LineChannel,
} from "./lineChannel.ts";

/** How long a dial waits for the worker's stream leg. */
const STREAM_NONCE_TTL_MS = 10_000;
const HELLO_TIMEOUT_MS = 10_000;
export const NONCE_HEADER = "x-t3o-stream-nonce";

/** What the board decides once a worker's hello is in. */
export type TunnelSessionDecision =
  | {
      readonly status: "ok";
      readonly liveBoardSessionIds: ReadonlyArray<string>;
      readonly boardAddress?: string | undefined;
    }
  | { readonly status: "needs-session" }
  /** The probe failed for another reason: drop the tunnel, the worker redials. */
  | { readonly status: "retry" }
  | { readonly status: "refused"; readonly message: string };

export interface TunnelBoardDeps {
  /** The worker a tunnel credential belongs to, or null when unknown or revoked. */
  readonly verifyCredential: (credential: string) => Promise<string | null>;
  /**
   * Called with the listener already live, so this may probe through it. `boardSession`
   * is set when the worker just handed one over.
   */
  readonly onHello: (workerId: string, hello: WorkerTunnelHello) => Promise<TunnelSessionDecision>;
  /** A tunnel reached `ok` (after `onHello` said so), on this credential. */
  readonly onReady?: (workerId: string, hello: WorkerTunnelHello, credential: string) => void;
  /** The worker said it is leaving the board (`t3o-worker leave`). */
  readonly onGoodbye?: (workerId: string) => void;
  /** Any change in which workers are live or ready. */
  readonly onChange?: () => void;
}

export type TunnelPhase = "down" | "live" | "ready";

interface Pending {
  readonly workerId: string;
  readonly nonce: string;
  readonly socket: NodeNet.Socket;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface WorkerSlot {
  readonly server: NodeNet.Server;
  readonly port: number;
  channel: LineChannel | null;
  phase: TunnelPhase;
  hello: WorkerTunnelHello | null;
  /** Every socket carried for this worker: accepted loopback sockets and stream legs. */
  readonly sockets: Set<NodeNet.Socket>;
}

export class TunnelBoard {
  private readonly slots = new Map<string, WorkerSlot>();
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  private readonly deps: TunnelBoardDeps;

  constructor(deps: TunnelBoardDeps) {
    this.deps = deps;
  }

  /** Open (once) the worker's stable loopback listener. */
  async ensureListener(workerId: string): Promise<number> {
    const existing = this.slots.get(workerId);
    if (existing !== undefined) return existing.port;
    const server = NodeNet.createServer((socket) => this.accept(workerId, socket));
    server.on("error", () => undefined);
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("The worker listener has no port."));
          return;
        }
        resolve(address.port);
      });
    });
    // A concurrent call may have won the race; keep the first, close ours.
    const raced = this.slots.get(workerId);
    if (raced !== undefined) {
      server.close();
      return raced.port;
    }
    this.slots.set(workerId, {
      server,
      port,
      channel: null,
      phase: "down",
      hello: null,
      sockets: new Set(),
    });
    return port;
  }

  /** Close the worker's listener and tunnel (Remove). */
  closeListener(workerId: string): void {
    const slot = this.slots.get(workerId);
    if (slot === undefined) return;
    this.slots.delete(workerId);
    slot.channel?.close();
    this.dropSockets(workerId, slot);
    slot.server.close();
    this.deps.onChange?.();
  }

  /** Ask a live worker's tunnel to close (it redials unless its credential went). */
  disconnect(workerId: string): void {
    this.slots.get(workerId)?.channel?.close();
  }

  workerIds(): ReadonlyArray<string> {
    return [...this.slots.keys()];
  }

  endpoint(workerId: string): { readonly port: number; readonly phase: TunnelPhase } | null {
    const slot = this.slots.get(workerId);
    return slot === undefined ? null : { port: slot.port, phase: slot.phase };
  }

  phase(workerId: string): TunnelPhase {
    return this.slots.get(workerId)?.phase ?? "down";
  }

  hello(workerId: string): WorkerTunnelHello | null {
    return this.slots.get(workerId)?.hello ?? null;
  }

  close(): void {
    this.closed = true;
    for (const workerId of Array.from(this.slots.keys())) this.closeListener(workerId);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.socket.destroy();
    }
    this.pending.clear();
  }

  // ── Loopback side ────────────────────────────────────────────────

  private accept(workerId: string, socket: NodeNet.Socket): void {
    const slot = this.slots.get(workerId);
    if (slot === undefined || slot.channel === null || slot.phase === "down" || this.closed) {
      // Reset at once, so a dial into an offline worker fails fast rather than hanging.
      if (typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
      else socket.destroy();
      return;
    }
    socket.pause();
    socket.on("error", () => undefined);
    slot.sockets.add(socket);
    socket.once("close", () => slot.sockets.delete(socket));
    const streamId = NodeCrypto.randomBytes(12).toString("base64url");
    const nonce = NodeCrypto.randomBytes(24).toString("base64url");
    const timer = setTimeout(() => {
      if (this.pending.delete(streamId)) socket.destroy();
    }, STREAM_NONCE_TTL_MS);
    timer.unref?.();
    this.pending.set(streamId, { workerId, nonce, socket, timer });
    slot.channel.send({ type: "dial", streamId, nonce });
  }

  // ── Upgrade side ─────────────────────────────────────────────────

  /** `Upgrade: t3o-stream` to the control path. */
  handleControl(request: NodeHttp.IncomingMessage, socket: NodeNet.Socket, head: Buffer): void {
    void this.control(request, socket, head).catch(() => socket.destroy());
  }

  private async control(
    request: NodeHttp.IncomingMessage,
    socket: NodeNet.Socket,
    head: Buffer,
  ): Promise<void> {
    socket.on("error", () => undefined);
    if (!isStreamUpgrade(request)) {
      refuseUpgrade(socket, 426, "Upgrade Required");
      return;
    }
    const credential = bearerOf(request.headers.authorization);
    const workerId = credential === null ? null : await this.deps.verifyCredential(credential);
    if (workerId === null || credential === null) {
      refuseUpgrade(socket, 401, "Unauthorized", { error: "revoked" });
      return;
    }
    const slot = this.slots.get(workerId);
    if (slot === undefined) {
      refuseUpgrade(socket, 401, "Unauthorized", { error: "revoked" });
      return;
    }
    acceptUpgrade(socket, BOARD_WORKER_STREAM_UPGRADE);

    let gotFirstHello = false;
    // Hellos are handled one at a time, in order.
    let queue: Promise<void> = Promise.resolve();
    const helloTimer = setTimeout(() => {
      if (!gotFirstHello) channel.close();
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref?.();

    const ack = (message: Omit<WorkerTunnelHelloAck, "type">) =>
      channel.send({ type: "helloAck", ...message });

    const onHello = async (hello: WorkerTunnelHello) => {
      if (hello.environmentId !== workerId) {
        ack({ status: "revoked", message: "This credential belongs to another worker." });
        channel.close();
        return;
      }
      if (hello.tunnelProtocol !== T3O_TUNNEL_PROTOCOL_VERSION) {
        ack({ status: "needs-update", tunnelProtocol: T3O_TUNNEL_PROTOCOL_VERSION });
        channel.close();
        return;
      }
      if (!gotFirstHello) {
        gotFirstHello = true;
        this.goLive(workerId, slot, channel, hello);
      }
      slot.hello = hello;
      const decision = await this.deps.onHello(workerId, hello);
      if (slot.channel !== channel) return;
      switch (decision.status) {
        case "needs-session":
          ack({ status: "needs-session" });
          return;
        case "retry":
          channel.close();
          return;
        case "refused":
          ack({ status: "revoked", message: decision.message });
          channel.close();
          return;
        case "ok":
          slot.phase = "ready";
          ack({
            status: "ok",
            liveBoardSessionIds: [...decision.liveBoardSessionIds],
            ...(decision.boardAddress === undefined ? {} : { boardAddress: decision.boardAddress }),
          });
          this.deps.onReady?.(workerId, hello, credential);
          this.deps.onChange?.();
      }
    };

    const channel: LineChannel = openLineChannel(socket, head, {
      onMessage: (raw) => {
        const message = decodeClientMessage(raw);
        if (message === null) return;
        if (message.type === "goodbye") {
          this.deps.onGoodbye?.(workerId);
          channel.close();
          return;
        }
        if (message.type !== "hello") return;
        queue = queue.then(() => onHello(message)).catch(() => channel.close());
      },
      onClose: () => {
        clearTimeout(helloTimer);
        if (slot.channel !== channel) return;
        slot.channel = null;
        slot.phase = "down";
        this.dropSockets(workerId, slot);
        this.deps.onChange?.();
      },
    });
  }

  private goLive(
    workerId: string,
    slot: WorkerSlot,
    channel: LineChannel,
    hello: WorkerTunnelHello,
  ) {
    const previous = slot.channel;
    slot.channel = channel;
    slot.phase = "live";
    slot.hello = hello;
    if (previous !== null) {
      // A newer tunnel replaces an older one; everything the old one carried goes with it.
      previous.close();
      this.dropSockets(workerId, slot);
    }
    this.deps.onChange?.();
  }

  private dropSockets(workerId: string, slot: WorkerSlot): void {
    for (const socket of slot.sockets) socket.destroy();
    slot.sockets.clear();
    for (const [streamId, entry] of this.pending) {
      if (entry.workerId !== workerId) continue;
      clearTimeout(entry.timer);
      entry.socket.destroy();
      this.pending.delete(streamId);
    }
  }

  /** `Upgrade: t3o-stream` to the stream path: one dial-back leg. */
  handleStream(request: NodeHttp.IncomingMessage, socket: NodeNet.Socket, head: Buffer): void {
    void this.stream(request, socket, head).catch(() => socket.destroy());
  }

  private async stream(
    request: NodeHttp.IncomingMessage,
    socket: NodeNet.Socket,
    head: Buffer,
  ): Promise<void> {
    socket.on("error", () => undefined);
    if (!isStreamUpgrade(request)) {
      refuseUpgrade(socket, 426, "Upgrade Required");
      return;
    }
    const streamId = new URL(request.url ?? "/", "http://board").searchParams.get("id");
    const nonceHeader = request.headers[NONCE_HEADER];
    const nonce = Array.isArray(nonceHeader) ? nonceHeader[0] : nonceHeader;
    const credential = bearerOf(request.headers.authorization);
    if (streamId === null || nonce === undefined || credential === null) {
      refuseUpgrade(socket, 400, "Bad Request");
      return;
    }
    const workerId = await this.deps.verifyCredential(credential);
    if (workerId === null) {
      refuseUpgrade(socket, 401, "Unauthorized", { error: "revoked" });
      return;
    }
    const entry = this.pending.get(streamId);
    if (entry === undefined) {
      // Expired, used, or another board process behind the same hostname.
      refuseUpgrade(socket, 404, "Not Found", {
        error: "unknown-stream",
        message: "No such stream on this board process. Run one board process per hostname.",
      });
      return;
    }
    if (entry.workerId !== workerId || !timingSafeEqualText(entry.nonce, nonce)) {
      refuseUpgrade(socket, 403, "Forbidden");
      return;
    }
    this.pending.delete(streamId);
    clearTimeout(entry.timer);
    const slot = this.slots.get(workerId);
    if (slot === undefined || slot.phase === "down" || entry.socket.destroyed) {
      entry.socket.destroy();
      refuseUpgrade(socket, 410, "Gone");
      return;
    }
    acceptUpgrade(socket, BOARD_WORKER_STREAM_UPGRADE);
    slot.sockets.add(socket);
    socket.once("close", () => slot.sockets.delete(socket));
    if (head.length > 0) entry.socket.write(head);
    joinSockets(entry.socket, socket);
    entry.socket.resume();
  }
}

const decodeClientMessageExit = Schema.decodeUnknownExit(WorkerTunnelClientMessage);
const decodeClientMessage = (raw: unknown): WorkerTunnelClientMessage | null => {
  const exit = decodeClientMessageExit(raw);
  return exit._tag === "Success" ? exit.value : null;
};

function isStreamUpgrade(request: NodeHttp.IncomingMessage): boolean {
  return (request.headers.upgrade ?? "").toLowerCase() === BOARD_WORKER_STREAM_UPGRADE;
}

function timingSafeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
}
