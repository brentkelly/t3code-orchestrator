// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off extendsNativeError:off - plain Node sockets and files: a byte pipe below Effect, also used by the CLI.
/**
 * A worker's end of one board's tunnel, in plain Node sockets: hold the control
 * channel, answer each `dial` with a dial-back stream leg piped into this server's own
 * loopback port, and redial with backoff. A stream can reach nothing else: `dial`
 * carries no target.
 */
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as Schema from "effect/Schema";

import {
  BOARD_WORKER_STREAM_UPGRADE,
  BOARD_WORKER_TUNNEL_PATH,
  BOARD_WORKER_TUNNEL_STREAM_PATH,
  T3O_TUNNEL_PROTOCOL_VERSION,
  WorkerTunnelServerMessage,
  type EnvironmentId,
  type WorkerTunnelHelloAck,
} from "@t3tools/contracts";

import { joinSockets, openLineChannel, type LineChannel } from "./lineChannel.ts";
import { NONCE_HEADER } from "./tunnelBoard.ts";

export type WorkerTunnelState = "connecting" | "connected" | "offline" | "revoked" | "needs-update";

export interface WorkerTunnelStatus {
  readonly state: WorkerTunnelState;
  readonly lastConnectedAt: string | null;
  readonly lastError: string | null;
  /** The address in use. */
  readonly boardUrl: string;
}

export interface TunnelWorkerOptions {
  readonly boardUrl: string;
  readonly credential: string;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly t3oRelease: string;
  readonly gatewayProtocol: number;
  /** This server's own loopback port and host: the only place a stream goes. */
  readonly local: { readonly host: string; readonly port: number };
  /** Mint the board's session on this worker, when the board asks for one. */
  readonly mintBoardSession: () => Promise<string>;
  /** `helloAck ok`: reconcile board-user sessions against the live ones. */
  readonly onReady?: ((ack: WorkerTunnelHelloAck) => void) | undefined;
  readonly onStatus?: ((status: WorkerTunnelStatus) => void) | undefined;
  /** The board refused the credential: it no longer knows this worker. */
  readonly onRevoked?: (() => void) | undefined;
  /** A new board address worked; persist it. */
  readonly onAddressAdopted?: ((boardUrl: string) => void) | undefined;
  /** Backoff bounds, injectable for tests. */
  readonly backoff?: { readonly initialMs: number; readonly maxMs: number };
}

const decodeServerMessageExit = Schema.decodeUnknownExit(WorkerTunnelServerMessage);

/** Redial delay with full jitter: 1 s doubling to 30 s. */
export function tunnelBackoffMs(
  failures: number,
  bounds: { readonly initialMs: number; readonly maxMs: number },
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(bounds.maxMs, bounds.initialMs * 2 ** Math.min(failures, 16));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

/** A raw `Upgrade: t3o-stream` request to the board. Resolves with the socket on 101,
    rejects with a described error otherwise. */
export function openUpgrade(
  url: URL,
  headers: Record<string, string>,
): Promise<{ readonly socket: NodeNet.Socket; readonly head: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? NodeHttps : NodeHttp).request(url, {
      method: "GET",
      headers: { ...headers, Connection: "Upgrade", Upgrade: BOARD_WORKER_STREAM_UPGRADE },
      agent: false,
      timeout: 15_000,
    });
    let upgraded = false;
    request.on("upgrade", (_response, socket, head) => {
      upgraded = true;
      // The request's timeout is for the handshake only; the upgraded socket lives on.
      socket.setTimeout(0);
      resolve({ socket, head });
    });
    request.on("response", (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        if (body.length < 4096) body += chunk;
      });
      response.on("end", () => reject(new UpgradeRefused(response.statusCode ?? 0, body)));
      response.on("error", () => reject(new UpgradeRefused(response.statusCode ?? 0, body)));
    });
    request.on("timeout", () => {
      if (!upgraded) request.destroy(new Error("The board didn't answer in time."));
    });
    request.on("error", (error) => reject(error));
    request.end();
  });
}

class UpgradeRefused extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(
      status === 401
        ? "The board no longer knows this worker (credential revoked)."
        : `Upgrade refused: the board answered HTTP ${status}. A front that strips Upgrade headers (some CDNs) can't carry a worker tunnel.`,
    );
    this.status = status;
    this.body = body;
  }
}

/** A short reason for `t3o-worker status`. */
function describeTunnelError(error: unknown): string {
  if (error instanceof UpgradeRefused) return error.message;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    return "DNS: the board's host name didn't resolve.";
  if (code === "ECONNREFUSED") return "Connection refused by the board's address.";
  if (typeof code === "string" && (code.startsWith("ERR_TLS") || code.includes("CERT"))) {
    return `TLS: ${(error as Error).message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export class TunnelWorker {
  private stopped = false;
  private channel: LineChannel | null = null;
  private readonly legs = new Set<NodeNet.Socket>();
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private boardUrl: string;
  /** An address the board told us about, tried on the next dial. */
  private candidateUrl: string | null = null;
  private status: WorkerTunnelStatus;

  private readonly options: TunnelWorkerOptions;

  constructor(options: TunnelWorkerOptions) {
    this.options = options;
    this.boardUrl = options.boardUrl.replace(/\/+$/, "");
    this.status = {
      state: "connecting",
      lastConnectedAt: null,
      lastError: null,
      boardUrl: this.boardUrl,
    };
  }

  start(): void {
    void this.connect();
  }

  /** Close the tunnel and every stream; no redial. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.channel?.close();
    this.dropLegs();
  }

  /** Tell the board this worker is leaving it, then stop. */
  async goodbye(): Promise<void> {
    const channel = this.channel;
    if (channel !== null && !channel.isClosed()) {
      channel.send({ type: "goodbye" });
      await Promise.race([channel.closed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    this.stop();
  }

  currentStatus(): WorkerTunnelStatus {
    return this.status;
  }

  private setStatus(patch: Partial<WorkerTunnelStatus>): void {
    this.status = { ...this.status, ...patch, boardUrl: this.boardUrl };
    this.options.onStatus?.(this.status);
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.options.credential}` };
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const trying = this.candidateUrl ?? this.boardUrl;
    const tryingCandidate = this.candidateUrl !== null;
    let opened: { readonly socket: NodeNet.Socket; readonly head: Buffer };
    try {
      opened = await openUpgrade(new URL(`${trying}${BOARD_WORKER_TUNNEL_PATH}`), this.headers());
    } catch (error) {
      if (tryingCandidate) {
        // The new address doesn't work from here: keep the last good one.
        this.candidateUrl = null;
        this.scheduleRedial(0);
        return;
      }
      if (error instanceof UpgradeRefused && error.status === 401) {
        this.setStatus({ state: "revoked", lastError: error.message });
        this.stopped = true;
        this.options.onRevoked?.();
        return;
      }
      this.setStatus({ state: "offline", lastError: describeTunnelError(error) });
      this.scheduleRedial();
      return;
    }
    if (this.stopped) {
      opened.socket.destroy();
      return;
    }
    this.hold(opened.socket, opened.head, trying, tryingCandidate);
  }

  private hold(socket: NodeNet.Socket, head: Buffer, url: string, candidate: boolean): void {
    let ready = false;
    const hello = (boardSession?: string) =>
      channel.send({
        type: "hello",
        tunnelProtocol: T3O_TUNNEL_PROTOCOL_VERSION,
        environmentId: this.options.environmentId,
        label: this.options.label,
        t3oRelease: this.options.t3oRelease,
        gatewayProtocol: this.options.gatewayProtocol,
        ...(boardSession === undefined ? {} : { boardSession }),
      });
    const channel = openLineChannel(socket, head, {
      onMessage: (raw) => {
        const exit = decodeServerMessageExit(raw);
        if (exit._tag !== "Success") return;
        const message = exit.value;
        switch (message.type) {
          case "dial":
            this.openStream(url, message.streamId, message.nonce);
            return;
          case "helloAck":
            switch (message.status) {
              case "needs-session":
                void this.options
                  .mintBoardSession()
                  .then((session) => hello(session))
                  .catch((error: unknown) => {
                    this.setStatus({ lastError: describeTunnelError(error) });
                    channel.close();
                  });
                return;
              case "needs-update":
                this.setStatus({
                  state: "needs-update",
                  lastError: `The board speaks tunnel protocol ${message.tunnelProtocol ?? "?"}, this worker ${T3O_TUNNEL_PROTOCOL_VERSION}. Update T3o on the older side.`,
                });
                this.stopped = true;
                return;
              case "revoked":
                this.setStatus({
                  state: "revoked",
                  lastError: message.message ?? "Refused by the board.",
                });
                this.stopped = true;
                this.options.onRevoked?.();
                return;
              case "ok":
                ready = true;
                this.failures = 0;
                if (candidate) {
                  this.boardUrl = url;
                  this.candidateUrl = null;
                  this.options.onAddressAdopted?.(url);
                }
                if (
                  message.boardAddress !== undefined &&
                  message.boardAddress.replace(/\/+$/, "") !== this.boardUrl
                ) {
                  this.candidateUrl = message.boardAddress.replace(/\/+$/, "");
                }
                this.setStatus({
                  state: "connected",
                  lastConnectedAt: new Date().toISOString(),
                  lastError: null,
                });
                this.options.onReady?.(message);
            }
        }
      },
      onClose: () => {
        if (this.channel === channel) this.channel = null;
        this.dropLegs();
        if (this.stopped) return;
        if (!ready && candidate) this.candidateUrl = null;
        if (this.status.state === "connected") this.setStatus({ state: "offline" });
        // A tunnel that held for a while comes straight back; a flapping one backs off.
        this.scheduleRedial(ready ? 250 : undefined);
      },
    });
    this.channel = channel;
    hello();
  }

  private openStream(url: string, streamId: string, nonce: string): void {
    const target = new URL(`${url}${BOARD_WORKER_TUNNEL_STREAM_PATH}`);
    target.searchParams.set("id", streamId);
    void openUpgrade(target, { ...this.headers(), [NONCE_HEADER]: nonce })
      .then(({ socket, head }) => {
        if (this.stopped || this.channel === null) {
          socket.destroy();
          return;
        }
        const local = NodeNet.connect({
          host: this.options.local.host,
          port: this.options.local.port,
        });
        this.legs.add(socket);
        this.legs.add(local);
        const forget = () => {
          this.legs.delete(socket);
          this.legs.delete(local);
        };
        if (head.length > 0) local.write(head);
        joinSockets(socket, local, forget);
      })
      .catch(() => undefined);
  }

  private dropLegs(): void {
    for (const leg of this.legs) leg.destroy();
    this.legs.clear();
  }

  private scheduleRedial(delayMs?: number): void {
    if (this.stopped) return;
    const bounds = this.options.backoff ?? { initialMs: 1_000, maxMs: 30_000 };
    const delay = delayMs ?? tunnelBackoffMs(this.failures, bounds);
    this.failures += 1;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
    this.timer.unref?.();
  }
}
