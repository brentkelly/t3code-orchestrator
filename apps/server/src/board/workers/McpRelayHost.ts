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
 * `BOARD_MCP_RELAY_TIMEOUT_MS`, the agent gets a retryable "board unreachable".
 */
import {
  BOARD_MCP_RELAY_TIMEOUT_MS,
  type BoardMcpRelayOutcome,
  type BoardMcpRelayRequest,
  type BoardMcpRelayResponse,
  type EnvironmentId,
} from "@t3tools/contracts";
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

/** The central server could not be asked, or did not answer in time. */
export class McpRelayUnreachable extends Data.TaggedError("McpRelayUnreachable")<{
  readonly reason: "not-connected" | "timed-out";
}> {}

export type McpRelayCall = Omit<BoardMcpRelayRequest, "callId">;

export interface McpRelayHostShape {
  /** Hand a call to its central server and wait for the answer. */
  readonly forward: (
    centralEnvironmentId: EnvironmentId,
    call: McpRelayCall,
  ) => Effect.Effect<BoardMcpRelayOutcome, McpRelayUnreachable>;
  /** The relay stream a central server holds open: every call still waiting
      for it, then each new one. */
  readonly subscribe: (centralEnvironmentId: EnvironmentId) => Stream.Stream<BoardMcpRelayRequest>;
  /** The central server's answer to a call. An answer to a call nobody waits
      on any more (timed out, or answered already) is ignored. */
  readonly respond: (response: BoardMcpRelayResponse) => Effect.Effect<void>;
  /** The boards holding a relay stream open now, then on each change. */
  readonly connected: Stream.Stream<ReadonlySet<EnvironmentId>>;
}

export class McpRelayHost extends Context.Service<McpRelayHost, McpRelayHostShape>()(
  "t3/board/workers/McpRelayHost",
) {}

interface Pending {
  readonly central: EnvironmentId;
  readonly request: BoardMcpRelayRequest;
  readonly answer: Deferred.Deferred<BoardMcpRelayOutcome>;
}

export const makeMcpRelayHost = (
  timeout: Duration.Input = Duration.millis(BOARD_MCP_RELAY_TIMEOUT_MS),
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const pending = new Map<string, Pending>();
    const subscribers = new Map<EnvironmentId, Set<Queue.Queue<BoardMcpRelayRequest>>>();
    const connected = yield* SubscriptionRef.make<ReadonlySet<EnvironmentId>>(new Set());
    const publishConnected = Effect.suspend(() =>
      SubscriptionRef.set(connected, new Set(subscribers.keys())),
    );

    const forward: McpRelayHostShape["forward"] = (central, call) =>
      Effect.gen(function* () {
        const listening = subscribers.get(central);
        if (listening === undefined || listening.size === 0) {
          return yield* new McpRelayUnreachable({ reason: "not-connected" });
        }
        const callId = `relay:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`;
        const request: BoardMcpRelayRequest = { callId, ...call };
        const answer = yield* Deferred.make<BoardMcpRelayOutcome>();
        pending.set(callId, { central, request, answer });
        for (const queue of listening) yield* Queue.offer(queue, request);
        const outcome = yield* Deferred.await(answer).pipe(
          Effect.timeoutOption(timeout),
          Effect.ensuring(Effect.sync(() => pending.delete(callId))),
        );
        return Option.isSome(outcome)
          ? outcome.value
          : yield* new McpRelayUnreachable({ reason: "timed-out" });
      });

    const subscribe: McpRelayHostShape["subscribe"] = (central) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<BoardMcpRelayRequest>();
          const set = subscribers.get(central) ?? new Set();
          set.add(queue);
          subscribers.set(central, set);
          yield* publishConnected;
          yield* Effect.addFinalizer(() =>
            Effect.suspend(() => {
              set.delete(queue);
              if (set.size === 0) subscribers.delete(central);
              return publishConnected;
            }),
          );
          // Calls a dropped stream left unanswered go out again first.
          for (const entry of pending.values()) {
            if (entry.central === central) yield* Queue.offer(queue, entry.request);
          }
          return Stream.fromQueue(queue);
        }),
      );

    const respond: McpRelayHostShape["respond"] = (response) =>
      Effect.suspend(() => {
        const entry = pending.get(response.callId);
        return entry === undefined
          ? Effect.void
          : Deferred.succeed(entry.answer, response.outcome).pipe(Effect.asVoid);
      });

    return {
      forward,
      subscribe,
      respond,
      connected: SubscriptionRef.changes(connected),
    } satisfies McpRelayHostShape;
  });

export const McpRelayHostLive = Layer.effect(McpRelayHost, makeMcpRelayHost());
