/**
 * T3o (T3O-63, D3): the worker's half of the MCP relay.
 *
 * A board tool called by a thread a central server placed here is not run
 * against this server's own board. It is handed to that central server over
 * the relay stream it holds open (`boardWorker.subscribeMcpRelay`) and the
 * agent waits for the answer (`boardWorker.mcpRelayRespond`). The worker never
 * dials out.
 *
 * A call survives a dropped stream: it is sent again, under the same call id,
 * to the next stream the central server opens, and the central server answers
 * a repeated call id once. With no central server connected, or no answer in
 * `BOARD_MCP_RELAY_TIMEOUT_MS`, the agent gets a retryable "board unreachable";
 * its retry of the same call, from the same session, rejoins the timed-out
 * call rather than running it a second time.
 *
 * A board's environment id is only what its session claims, so the first
 * session to claim one (by spawning a thread for it, or opening its relay
 * stream) holds it until that session is revoked or expires: no other session
 * can then read that board's calls, answer them, or point threads at it. A
 * call is answered only by a session it was delivered to.
 */
import {
  BOARD_MCP_RELAY_TIMEOUT_MS,
  type AuthSessionId,
  type BoardMcpRelayOutcome,
  type BoardMcpRelayRequest,
  type BoardMcpRelayResponse,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { SessionStore } from "../../auth/SessionStore.ts";

/** The central server could not be asked, or did not answer in time. */
export class McpRelayUnreachable extends Data.TaggedError("McpRelayUnreachable")<{
  readonly reason: "not-connected" | "timed-out";
}> {}

/** A session claimed a board another session holds, or answered a call it
    was never sent. */
export class McpRelayRefused extends Data.TaggedError("McpRelayRefused")<{
  readonly detail: string;
}> {}

export type McpRelayCall = Omit<BoardMcpRelayRequest, "callId">;

export interface McpRelayHostShape {
  /** Hand a call to its central server and wait for the answer. */
  readonly forward: (
    centralEnvironmentId: EnvironmentId,
    call: McpRelayCall,
  ) => Effect.Effect<BoardMcpRelayOutcome, McpRelayUnreachable>;
  /** Bind a board to the calling session, or refuse when another live
      session holds it. */
  readonly claim: (
    centralEnvironmentId: EnvironmentId,
    session: AuthSessionId,
  ) => Effect.Effect<void, McpRelayRefused>;
  /** The relay stream a central server holds open: every call still waiting
      for it, then each new one. Claims the board for `session` first. */
  readonly subscribe: (
    centralEnvironmentId: EnvironmentId,
    session: AuthSessionId,
  ) => Stream.Stream<BoardMcpRelayRequest, McpRelayRefused>;
  /** The central server's answer to a call, from a session it was sent to.
      An answer to a call nobody waits on any more (timed out, or answered
      already) is ignored. */
  readonly respond: (
    response: BoardMcpRelayResponse,
    session: AuthSessionId,
  ) => Effect.Effect<void, McpRelayRefused>;
  /** The boards holding a relay stream open now, then on each change. */
  readonly connected: Stream.Stream<ReadonlySet<EnvironmentId>>;
}

export class McpRelayHost extends Context.Service<McpRelayHost, McpRelayHostShape>()(
  "t3/board/workers/McpRelayHost",
) {}

/** How many timeouts a timed-out call waits for the agent's retry before it
    is dropped. */
export const RETRY_GRACE_TIMEOUTS = 10;

interface Pending {
  readonly central: EnvironmentId;
  readonly request: BoardMcpRelayRequest;
  readonly answer: Deferred.Deferred<BoardMcpRelayOutcome>;
  /** The sessions the call went out to: the only ones that may answer it. */
  readonly sentTo: Set<AuthSessionId>;
}

interface Subscriber {
  readonly session: AuthSessionId;
  readonly queue: Queue.Queue<BoardMcpRelayRequest, Cause.Done>;
}

/** A timed-out call's wait for the agent's retry. Its own object, so a
    cleanup can tell its own wait from a later one on the same call. */
interface TimedOut {
  readonly threadId: string;
  readonly fingerprint: string;
}

export const makeMcpRelayHost = (
  timeout: Duration.Input = Duration.millis(BOARD_MCP_RELAY_TIMEOUT_MS),
  /** Whether a session still authenticates. One that does not loses the
      boards it holds. Without it, a board stays with its first session. */
  sessionActive: (session: AuthSessionId) => Effect.Effect<boolean> = () => Effect.succeed(true),
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const scope = yield* Effect.scope;
    const pending = new Map<string, Pending>();
    const subscribers = new Map<EnvironmentId, Set<Subscriber>>();
    const holders = new Map<EnvironmentId, AuthSessionId>();
    const connected = yield* SubscriptionRef.make<ReadonlySet<EnvironmentId>>(new Set());
    const publishConnected = Effect.suspend(() =>
      SubscriptionRef.set(connected, new Set(subscribers.keys())),
    );

    const claim: McpRelayHostShape["claim"] = (central, session) =>
      Effect.gen(function* () {
        const holder = holders.get(central);
        if (holder !== undefined && holder !== session && (yield* sessionActive(holder))) {
          return yield* new McpRelayRefused({
            detail: "Another session already speaks for that board.",
          });
        }
        holders.set(central, session);
      });

    // By call id, each timed-out call. It stays pending, so it is still
    // redelivered and its answer still lands; an agent retrying the very same
    // call joins it instead of running it again under a new id. An agent that
    // never retries leaves it for `RETRY_GRACE_TIMEOUTS` timeouts: well past
    // the "retry in a minute" the agent is told, so a retry that follows that
    // advice, however slowly, still joins it.
    const timedOut = new Map<string, TimedOut>();
    const fingerprintOf = (central: EnvironmentId, call: McpRelayCall) =>
      JSON.stringify([central, call.providerSessionId, call.toolName, call.params]);

    /** The timed-out call a retry joins, or a new one sent to every stream. */
    const pendingFor = (central: EnvironmentId, call: McpRelayCall, fingerprint: string) =>
      Effect.gen(function* () {
        for (const [callId, waiting] of timedOut) {
          if (waiting.threadId !== call.threadId || waiting.fingerprint !== fingerprint) continue;
          timedOut.delete(callId);
          const entry = pending.get(callId);
          if (entry !== undefined) return entry;
        }
        const listening = subscribers.get(central);
        if (listening === undefined || listening.size === 0) {
          return yield* new McpRelayUnreachable({ reason: "not-connected" });
        }
        const callId = `relay:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`;
        const entry: Pending = {
          central,
          request: { callId, ...call },
          answer: yield* Deferred.make<BoardMcpRelayOutcome>(),
          sentTo: new Set(),
        };
        pending.set(callId, entry);
        for (const subscriber of listening) yield* send(subscriber, entry);
        return entry;
      });

    const send = (subscriber: Subscriber, entry: Pending) =>
      Effect.suspend(() => {
        entry.sentTo.add(subscriber.session);
        return Queue.offer(subscriber.queue, entry.request);
      });

    const forward: McpRelayHostShape["forward"] = (central, call) =>
      Effect.gen(function* () {
        const fingerprint = fingerprintOf(central, call);
        const entry = yield* pendingFor(central, call, fingerprint);
        const { callId } = entry.request;
        const outcome = yield* Deferred.await(entry.answer).pipe(
          Effect.timeoutOption(timeout),
          // The agent's request was cancelled: nobody will retry this call.
          Effect.onInterrupt(() => Effect.sync(() => pending.delete(callId))),
        );
        if (Option.isSome(outcome)) {
          pending.delete(callId);
          return outcome.value;
        }
        // Each wait has its own deadline: a retry that joins this call and
        // times out again starts a new one, which this cleanup leaves alone.
        const waiting: TimedOut = { threadId: call.threadId, fingerprint };
        timedOut.set(callId, waiting);
        yield* Effect.sleep(
          Duration.times(Duration.fromInputUnsafe(timeout), RETRY_GRACE_TIMEOUTS),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (timedOut.get(callId) !== waiting) return;
              timedOut.delete(callId);
              pending.delete(callId);
            }),
          ),
          Effect.forkIn(scope),
        );
        return yield* new McpRelayUnreachable({ reason: "timed-out" });
      });

    const subscribe: McpRelayHostShape["subscribe"] = (central, session) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* claim(central, session);
          // A session that took the board over: the streams of the one it
          // replaced end, rather than go on being sent its calls.
          for (const previous of subscribers.get(central) ?? []) {
            if (previous.session !== session) yield* Queue.end(previous.queue);
          }
          const subscriber: Subscriber = {
            session,
            queue: yield* Queue.unbounded<BoardMcpRelayRequest, Cause.Done>(),
          };
          const set = subscribers.get(central) ?? new Set();
          set.add(subscriber);
          subscribers.set(central, set);
          yield* publishConnected;
          yield* Effect.addFinalizer(() =>
            Effect.suspend(() => {
              set.delete(subscriber);
              if (set.size === 0) subscribers.delete(central);
              return publishConnected;
            }),
          );
          // Calls a dropped stream left unanswered go out again first.
          for (const entry of pending.values()) {
            if (entry.central === central) yield* send(subscriber, entry);
          }
          return Stream.fromQueue(subscriber.queue);
        }),
      );

    const respond: McpRelayHostShape["respond"] = (response, session) =>
      Effect.gen(function* () {
        const entry = pending.get(response.callId);
        if (entry === undefined) return;
        if (!entry.sentTo.has(session)) {
          return yield* new McpRelayRefused({ detail: "That call was not sent to this session." });
        }
        yield* Deferred.succeed(entry.answer, response.outcome);
      });

    return {
      forward,
      claim,
      subscribe,
      respond,
      connected: SubscriptionRef.changes(connected),
    } satisfies McpRelayHostShape;
  });

export const McpRelayHostLive = Layer.effect(
  McpRelayHost,
  Effect.gen(function* () {
    const sessions = yield* SessionStore;
    // A board held by a revoked or expired session is free for the session
    // that replaces it (a re-pair). An unreadable store keeps the holder.
    const sessionActive = (session: AuthSessionId) =>
      sessions.listActive().pipe(
        Effect.map((active) => active.some((candidate) => candidate.sessionId === session)),
        Effect.orElseSucceed(() => true),
      );
    return yield* makeMcpRelayHost(Duration.millis(BOARD_MCP_RELAY_TIMEOUT_MS), sessionActive);
  }),
);
