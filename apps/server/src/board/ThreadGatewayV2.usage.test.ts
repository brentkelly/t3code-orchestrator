/**
 * Which finished provider turns the gateway reports as usage (T3O-77), and when the signal
 * log adds them.
 */
import {
  CommandId,
  EventId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { finishedProviderTurnOf, readSignalLog, usageSignalOf } from "./ThreadGatewayV2.ts";

const threadId = ThreadId.make("thread-1");
const t0 = DateTime.makeUnsafe("2026-10-20T00:00:00.000Z");

let sequence = 0;
const stored = (type: string, payload: object): OrchestrationV2StoredEvent =>
  ({
    sequence: (sequence += 1),
    commandId: null as CommandId | null,
    event: { type, id: EventId.make(`evt-${sequence}`), threadId, occurredAt: t0, payload },
  }) as unknown as OrchestrationV2StoredEvent;

describe("usage signals", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread-1");
  const attemptId = RunAttemptId.make("attempt-1");
  const turn = (overrides: Record<string, unknown> = {}) =>
    ({
      id: ProviderTurnId.make("provider-turn-1"),
      providerThreadId,
      runAttemptId: attemptId,
      status: "completed",
      model: "claude-sonnet-reported",
      turnTokenUsage: {
        usageScope: "main_agent",
        usageStatus: "complete",
        inputTokens: 1000,
        outputTokens: 50,
        hasSubagents: false,
        models: ["claude-opus-first", "claude-haiku-second"],
      },
      ...overrides,
    }) as never;
  const records = (thread: Record<string, unknown> = {}) =>
    ({
      thread: {
        id: threadId,
        modelSelection: { instanceId: ProviderInstanceId.make("claude-work"), model: "selected" },
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        ...thread,
      },
      providerThreads: [{ id: providerThreadId, driver: "claudeAgent" }],
      attempts: [{ id: attemptId, providerThreadId }],
    }) as never;

  it("credits a turn to its provider's driver and the first model it reported", () => {
    assert.deepStrictEqual(usageSignalOf(records(), turn()), {
      type: "usage-recorded",
      threadId,
      providerTurnId: "provider-turn-1",
      driver: "claudeAgent",
      model: "claude-opus-first",
      delegatedFromThreadId: null,
      usage: (turn() as { readonly turnTokenUsage: unknown }).turnTokenUsage as never,
    });
  });

  it("falls back to the turn's model, then the thread's, when usage names none", () => {
    assert.strictEqual(
      usageSignalOf(records(), turn({ turnTokenUsage: undefined }))?.model,
      "claude-sonnet-reported",
    );
    assert.strictEqual(
      usageSignalOf(records(), turn({ turnTokenUsage: undefined, model: undefined }))?.model,
      "selected",
    );
    assert.isNull(usageSignalOf(records(), turn({ turnTokenUsage: undefined }))?.usage);
  });

  it("skips a native subagent's turn and a local command, whose spend the root turn carries", () => {
    assert.isNull(usageSignalOf(records(), turn({ runAttemptId: null })));
    assert.isNull(
      usageSignalOf(records(), turn({ providerThreadId: ProviderThreadId.make("child-thread") })),
    );
    assert.isNull(
      usageSignalOf(
        records(),
        turn({
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 1,
            outputTokens: 1,
            hasSubagents: false,
            localCommand: true,
          },
        }),
      ),
    );
  });

  it("names the thread a delegated child came from, by either record", () => {
    const parent = ThreadId.make("thread-parent");
    assert.strictEqual(
      usageSignalOf(
        records({ delegatedFrom: { environmentId: "env", threadId: parent, title: "Parent" } }),
        turn(),
      )?.delegatedFromThreadId,
      parent,
    );
    assert.strictEqual(
      usageSignalOf(
        records({
          lineage: {
            parentThreadId: parent,
            relationshipToParent: "subagent",
            rootThreadId: parent,
          },
        }),
        turn(),
      )?.delegatedFromThreadId,
      parent,
    );
  });

  it("counts a provider turn only once it has finished", () => {
    assert.isNull(
      finishedProviderTurnOf(stored("provider-turn.updated", turn({ status: "running" }))),
    );
    for (const status of ["completed", "interrupted", "failed", "cancelled"]) {
      assert.isNotNull(finishedProviderTurnOf(stored("provider-turn.updated", turn({ status }))));
    }
    assert.isNull(
      finishedProviderTurnOf(
        stored("run.updated", { id: RunId.make("run-1"), status: "completed" }),
      ),
    );
  });

  it.effect("adds usage to a batch only when asked, and never during the warm-up", () => {
    const before = stored("provider-turn.updated", turn({ id: ProviderTurnId.make("earlier") }));
    const finished = stored("provider-turn.updated", turn());
    const log = [before, finished];
    const sink = {
      latestSequence: () => Effect.succeed(finished.sequence),
      stream: (input?: { readonly afterSequence?: number }) =>
        Stream.fromIterable(log.filter((event) => event.sequence > (input?.afterSequence ?? 0))),
    };
    const looked: Array<number> = [];
    const usage = (event: OrchestrationV2StoredEvent) =>
      Effect.sync(() => {
        looked.push(event.sequence);
        const found = finishedProviderTurnOf(event);
        return found === null ? null : usageSignalOf(records(), found.turn);
      });
    return Effect.gen(function* () {
      const plain = yield* readSignalLog(sink, before.sequence, Schedule.recurs(0)).pipe(
        Stream.runCollect,
      );
      assert.deepStrictEqual(Array.from(plain), []);
      const withUsage = yield* readSignalLog(sink, before.sequence, Schedule.recurs(0), usage).pipe(
        Stream.runCollect,
      );
      assert.deepStrictEqual(
        Array.from(withUsage).map((batch) => [batch.sequence, batch.signals.map((x) => x.type)]),
        [[finished.sequence, ["usage-recorded"]]],
      );
      assert.deepStrictEqual(looked, [finished.sequence]);
    });
  });
});
