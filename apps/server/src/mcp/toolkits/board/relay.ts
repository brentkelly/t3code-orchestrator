/**
 * T3o board MCP toolkit — the relay (T3O-63, D3).
 *
 * An agent on a worker keeps calling the `/mcp` of the server its thread runs
 * on. When that thread was placed there by a central board, its board tools
 * must act on THAT board, not the worker's own:
 *
 * - **Worker side** (`relayable`): a call from a thread in the relayed-thread
 *   registry is handed to the central server over the relay stream it holds
 *   open, and the agent gets the central server's answer. With no central
 *   server connected, or no answer in time, the tool fails with a retryable
 *   `board-unreachable` — never a silent success.
 * - **Central side** (`runRelayedBoardTool`): the same handlers run under a
 *   synthesized invocation scope, after two checks of its own: the thread is
 *   linked to a card on the very worker the call arrived from, and the thread
 *   is a live caller as the ROUTED gateway sees it (the thread is on the
 *   worker, which this server's own thread service has never heard of).
 *
 * Parameters and results cross the wire encoded with the tool's own schemas.
 */
import {
  OrchestratorMcpFailure,
  type BoardMcpRelayOutcome,
  type BoardMcpRelayRequest,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { BoardQueries } from "../../../board/BoardQueries.ts";
import {
  ThreadGateway,
  UNKNOWN_THREAD_STATE,
  type ThreadSpawnInput,
} from "../../../board/ThreadGateway.ts";
import { BoardRelayStore } from "../../../board/workers/BoardRelayStore.ts";
import { McpRelayHost } from "../../../board/workers/McpRelayHost.ts";
import type { stageCardFilesOnWorker } from "../../../board/workers/RemoteThreadGateway.ts";
import type { WorkerUnavailable } from "../../../board/workers/WorkerConnections.ts";
import * as ServerConfig from "../../../config.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import { BOARD_TOOL_ERROR_CODES, BoardToolError, BoardToolkit } from "./tools.ts";

export type BoardToolName = keyof typeof BoardToolkit.tools;

/** Tools that change nothing: their caller need only exist, not be mid-run. */
const READ_TOOLS: ReadonlySet<string> = new Set<BoardToolName>([
  "board_get_card_context",
  "board_get_card",
  "board_list_projects",
  "board_list_cards",
  "board_get_plan",
]);

/**
 * Central side: the call being answered came from a worker. Board tools read
 * the worker's state directory from it, so the paths they hand out (the
 * brief's staged files) are paths on the machine the agent runs on, and stage
 * the card's current files there first, so a file added after the spawn
 * exists where its path points.
 */
export class BoardRelayInvocation extends Context.Service<
  BoardRelayInvocation,
  {
    readonly workerId: EnvironmentId;
    readonly stateDir: string;
    readonly stageCardFiles: (
      staging: NonNullable<ThreadSpawnInput["stageAttachments"]>,
    ) => Effect.Effect<
      void,
      Effect.Error<ReturnType<typeof stageCardFilesOnWorker>> | WorkerUnavailable
    >;
  }
>()("t3/mcp/toolkits/board/relay/BoardRelayInvocation") {}

interface ToolCodecs {
  readonly encodeParameters: (value: unknown) => Effect.Effect<unknown, Schema.SchemaError>;
  readonly decodeParameters: (encoded: unknown) => Effect.Effect<unknown, Schema.SchemaError>;
  readonly encodeSuccess: (value: unknown) => Effect.Effect<unknown, Schema.SchemaError>;
  readonly decodeSuccess: (encoded: unknown) => Effect.Effect<unknown, Schema.SchemaError>;
}

/** A tool's schemas, read as the context-free codecs they are. */
const codecsOf = (tool: (typeof BoardToolkit.tools)[BoardToolName]): ToolCodecs => {
  const parameters = tool.parametersSchema as unknown as Schema.Codec<unknown>;
  const success = tool.successSchema as unknown as Schema.Codec<unknown>;
  return {
    encodeParameters: Schema.encodeUnknownEffect(parameters),
    decodeParameters: Schema.decodeUnknownEffect(parameters),
    encodeSuccess: Schema.encodeUnknownEffect(success),
    decodeSuccess: Schema.decodeUnknownEffect(success),
  };
};

const TOOL_CODECS = Object.fromEntries(
  Object.entries(BoardToolkit.tools).map(([name, tool]) => [name, codecsOf(tool)]),
) as Record<BoardToolName, ToolCodecs>;

const internal = (message: string) => new BoardToolError({ code: "internal", message });

const unreachable = new BoardToolError({
  code: "board-unreachable",
  message:
    "The board server this thread belongs to is not connected right now. This is temporary: retry the same call in a minute.",
});

const isToolErrorCode = (code: string): code is BoardToolError["code"] =>
  (BOARD_TOOL_ERROR_CODES as ReadonlyArray<string>).includes(code);

// ── Worker side ────────────────────────────────────────────────────────

/**
 * A board tool handler that relays a placed thread's call to its board. Any
 * other caller — this server's own threads, or a server that relays nothing —
 * runs the handler here exactly as before.
 */
export const relayable =
  <P, A, E, R>(name: BoardToolName, handle: (params: P) => Effect.Effect<A, E, R>) =>
  (params: P): Effect.Effect<A, E | BoardToolError, R | ServerConfig.ServerConfig> =>
    Effect.gen(function* () {
      const relay = yield* Effect.serviceOption(McpRelayHost);
      const store = yield* Effect.serviceOption(BoardRelayStore);
      const scope = yield* Effect.serviceOption(McpInvocationContext);
      const thread = Option.isSome(scope) ? scope.value.thread : undefined;
      if (Option.isNone(relay) || Option.isNone(store) || thread === undefined) {
        return yield* handle(params);
      }
      const central = yield* store.value
        .relayedThreadCentral(thread.threadId)
        .pipe(Effect.mapError(() => internal("Couldn't read whether this thread is relayed.")));
      if (central === null) return yield* handle(params);

      const codecs = TOOL_CODECS[name];
      // A tool without parameters is called with none.
      const encoded = yield* codecs
        .encodeParameters(params ?? {})
        .pipe(Effect.mapError(() => internal("Couldn't encode the call for the board.")));
      const config = yield* ServerConfig.ServerConfig;
      const outcome = yield* relay.value
        .forward(central, {
          toolName: name,
          params: encoded,
          threadId: thread.threadId,
          providerSessionId: thread.providerSessionId,
          providerInstanceId: thread.providerInstanceId,
          stateDir: config.stateDir,
        })
        .pipe(Effect.mapError(() => unreachable));
      if (outcome._tag === "failure") {
        return yield* new BoardToolError({
          code: isToolErrorCode(outcome.code) ? outcome.code : "internal",
          message: outcome.message,
        });
      }
      return (yield* codecs
        .decodeSuccess(outcome.value)
        .pipe(Effect.mapError(() => internal("The board's answer did not decode.")))) as A;
    });

// ── Central side ───────────────────────────────────────────────────────

const failure = (code: BoardToolError["code"], message: string): BoardMcpRelayOutcome => ({
  _tag: "failure",
  code,
  message,
});

type AnyBoardHandler = (
  params: unknown,
) => Effect.Effect<unknown, BoardToolError | OrchestratorMcpFailure, never>;

/**
 * Answer one relayed call. Never fails: every refusal and fault is an outcome
 * the worker hands its agent.
 *
 * `handlers` are the board tool handlers, passed in so this module needs no
 * import of them; their services must already be provided.
 */
export const runRelayedBoardTool = (input: {
  readonly workerId: EnvironmentId;
  readonly centralEnvironmentId: EnvironmentId;
  readonly request: BoardMcpRelayRequest;
  readonly handlers: Readonly<Record<string, AnyBoardHandler>>;
  readonly stageCardFiles: BoardRelayInvocation["Service"]["stageCardFiles"];
}): Effect.Effect<BoardMcpRelayOutcome, never, BoardQueries | ThreadGateway> =>
  Effect.gen(function* () {
    const { request, workerId } = input;
    const handler = input.handlers[request.toolName];
    if (handler === undefined || !(request.toolName in BoardToolkit.tools)) {
      return failure("invalid-input", `'${request.toolName}' is not a board tool.`);
    }
    const name = request.toolName as BoardToolName;

    // Authorised twice (D3): linked to a card, and placed on THIS worker, so
    // one worker can never act on another worker's cards.
    const queries = yield* BoardQueries;
    const linkedTo = yield* queries.boardThreadWorker(request.threadId);
    if (linkedTo === null) {
      return failure(
        "thread-not-linked",
        "This thread is not linked to a board card, so card-scoped tools cannot resolve your card.",
      );
    }
    if (linkedTo !== workerId) {
      return failure(
        "rejected",
        "This thread's card does not run on the worker that sent the call.",
      );
    }

    // The live-caller check, through the routed gateway: the thread lives on
    // the worker, not here.
    const threads = yield* ThreadGateway;
    const state = yield* threads.threadState(request.threadId);
    if (state === null || state === UNKNOWN_THREAD_STATE || state.deleted) {
      return failure("rejected", "The calling thread was not found.");
    }
    const ownsRun =
      !state.archived &&
      state.activeTurnRef !== null &&
      (state.modelSelection === null ||
        state.modelSelection.instanceId === request.providerInstanceId);
    if (!READ_TOOLS.has(name) && !ownsRun) {
      return failure("rejected", "The calling provider no longer owns an active thread run.");
    }

    const codecs = TOOL_CODECS[name];
    const params = yield* codecs.decodeParameters(request.params).pipe(Effect.option);
    if (Option.isNone(params))
      return failure("invalid-input", "The call's parameters did not decode.");

    const scope: McpInvocationScope = {
      environmentId: input.centralEnvironmentId,
      capabilities: new Set(["board"]),
      issuedAt: yield* Clock.currentTimeMillis,
      requestNamespace: `board-relay:${workerId}`,
      thread: {
        threadId: request.threadId,
        providerSessionId: request.providerSessionId,
        providerInstanceId: request.providerInstanceId,
      },
      client: undefined,
    };
    const result = yield* handler(params.value).pipe(
      Effect.provideService(McpInvocationContext, scope),
      Effect.provideService(BoardRelayInvocation, {
        workerId,
        stateDir: request.stateDir,
        stageCardFiles: input.stageCardFiles,
      }),
      Effect.result,
    );
    if (result._tag === "Failure") {
      const error = result.failure;
      return error._tag === "BoardToolError"
        ? failure(error.code, error.message)
        : failure("rejected", error.message);
    }
    const encoded = yield* codecs.encodeSuccess(result.success).pipe(Effect.option);
    return Option.isSome(encoded)
      ? ({ _tag: "success", value: encoded.value } satisfies BoardMcpRelayOutcome)
      : failure("internal", "The board's answer did not encode.");
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("board relay: a relayed call failed", { cause }).pipe(
        Effect.as(failure("internal", "The board failed to answer this call.")),
      ),
    ),
  );
