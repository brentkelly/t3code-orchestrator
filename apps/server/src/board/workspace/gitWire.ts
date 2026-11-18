/**
 * Both ends of `boardWorker.git.call`. Each end codes the payload and answer with
 * the operation's own schemas from `BOARD_WORKER_GIT_RPCS`, so the worker still
 * decodes (and checks branch names) before git sees an argument.
 */
import {
  BOARD_WORKER_GIT_RPCS,
  type BoardWorkerGitCall,
  type BoardWorkerGitMethod,
  type BoardWorkerGitPayload,
  type BoardWorkerGitSuccess,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

interface Codec {
  readonly encode: (value: unknown) => Effect.Effect<unknown, Schema.SchemaError>;
  readonly decode: (encoded: unknown) => Effect.Effect<unknown, Schema.SchemaError>;
  /** A void answer: `undefined`, which the socket's JSON can't carry, so it goes as `null`. */
  readonly answersNothing: boolean;
}

/** Every operation schema is context-free; the union of their types is not
    something the checker can index, so each is read as the codec it is. */
const codecOf = (schema: Schema.Top): Codec => {
  const codec = schema as unknown as Schema.Codec<unknown>;
  return {
    encode: Schema.encodeUnknownEffect(codec),
    decode: Schema.decodeUnknownEffect(codec),
    answersNothing: Schema.is(codec)(undefined),
  };
};

const CODECS = new Map(
  BOARD_WORKER_GIT_RPCS.map((rpc) => [
    rpc._tag as BoardWorkerGitMethod,
    { payload: codecOf(rpc.payloadSchema), success: codecOf(rpc.successSchema) },
  ]),
);

const codecsOf = (method: BoardWorkerGitMethod) => CODECS.get(method)!;

/** An operation's payload, encoded for the wire. */
export const encodeGitPayload = <Method extends BoardWorkerGitMethod>(
  method: Method,
  payload: BoardWorkerGitPayload<Method>,
) =>
  codecsOf(method).payload.encode(payload) as Effect.Effect<
    BoardWorkerGitCall["payload"],
    Schema.SchemaError
  >;

/** An operation's payload, decoded off the wire — where a worker refuses one
    its rules reject. */
export const decodeGitPayload = <Method extends BoardWorkerGitMethod>(
  method: Method,
  encoded: unknown,
) =>
  codecsOf(method).payload.decode(encoded) as Effect.Effect<
    BoardWorkerGitPayload<Method>,
    Schema.SchemaError
  >;

/** An operation's answer, encoded for the wire. */
export const encodeGitSuccess = (method: BoardWorkerGitMethod, value: unknown) =>
  codecsOf(method)
    .success.encode(value)
    .pipe(Effect.map((encoded) => encoded ?? null));

/** An operation's answer, decoded off the wire. */
export const decodeGitSuccess = <Method extends BoardWorkerGitMethod>(
  method: Method,
  encoded: unknown,
) =>
  codecsOf(method).success.decode(
    encoded === null && codecsOf(method).success.answersNothing ? undefined : encoded,
  ) as Effect.Effect<BoardWorkerGitSuccess<Method>, Schema.SchemaError>;
