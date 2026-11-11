import { BoardGatewaySignal, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { fromWireSignal, toWireSignal } from "./gatewayWire.ts";

// The `turn-ended` arm as the previous protocol-1 build declared it: `errorMessage` required.
const PreviousTurnEnded = Schema.Struct({
  type: Schema.Literal("turn-ended"),
  threadId: ThreadId,
  turnRef: Schema.optionalKey(Schema.String),
  outcome: Schema.optionalKey(Schema.Literals(["completed", "failed", "interrupted", "cancelled"])),
  errorMessage: Schema.NullOr(Schema.String),
});

const encodeSignal = Schema.encodeEffect(BoardGatewaySignal);
const decodeSignal = Schema.decodeUnknownEffect(BoardGatewaySignal);
const decodePreviousTurnEnded = Schema.decodeUnknownEffect(PreviousTurnEnded);

const threadId = ThreadId.make("thread-wire");

it.effect("a turn end from this worker still decodes on the previous central build", () =>
  Effect.gen(function* () {
    const encoded = yield* encodeSignal(
      toWireSignal({ type: "turn-ended", threadId, turnRef: "turn-1" }),
    );
    const decoded = yield* decodePreviousTurnEnded(encoded);
    assert.strictEqual(decoded.turnRef, "turn-1");
    assert.strictEqual(decoded.errorMessage, null);
  }),
);

it.effect("a turn end from a previous worker still decodes on this central", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeSignal({
      type: "turn-ended",
      threadId,
      outcome: "failed",
      errorMessage: "You've hit your usage limit",
    });
    assert.deepStrictEqual(fromWireSignal(decoded), {
      type: "turn-ended",
      threadId,
      turnRef: undefined,
    });
  }),
);

it.effect("a finished turn's usage crosses the wire with the counts the board prices", () =>
  Effect.gen(function* () {
    const usage = {
      usageScope: "main_agent",
      usageStatus: "complete",
      inputTokens: 1200,
      cachedInputTokens: 800,
      outputTokens: 90,
      reasoningTokens: 30,
      hasSubagents: true,
      models: ["gpt-5-codex"],
      otherUsage: { inputTokens: 10, outputTokens: 2 },
    } as const;
    const encoded = yield* encodeSignal(
      toWireSignal({
        type: "usage-recorded",
        threadId,
        providerTurnId: "turn-1",
        driver: "codex",
        model: "gpt-5-codex",
        delegatedFromThreadId: null,
        usage,
      }),
    );
    const decoded = fromWireSignal(yield* decodeSignal(encoded));
    assert.deepStrictEqual(decoded, {
      type: "usage-recorded",
      threadId,
      providerTurnId: "turn-1",
      driver: "codex",
      model: "gpt-5-codex",
      delegatedFromThreadId: null,
      usage: {
        usageStatus: "complete",
        inputTokens: 1200,
        cachedInputTokens: 800,
        outputTokens: 90,
        reasoningTokens: 30,
        otherUsage: { inputTokens: 10, outputTokens: 2 },
      },
    });
  }),
);
