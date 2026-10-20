/**
 * `boardThreadLastSignalAt` (T3O-12, D1): when a thread last produced OUTPUT.
 *
 * The timeout sweep's missing life sign, driven against the real engine and
 * projection so the SQL — a UNION over two upstream projection tables read
 * through the attached board connection — is exercised rather than stubbed.
 *
 * The activity arm is the one that matters most in production: a review phase
 * writes no commits, need not churn a todo list, and can go twenty minutes
 * deep in tool calls without writing a word of prose. Every one of those tool
 * calls appends an activity row, so that arm alone is what makes a working
 * agent observably alive.
 */
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { BoardQueries } from "./BoardQueries.ts";
import { boardStackEngine, makeBoardStackTestLayer } from "./boardStack.testkit.ts";

const makeLayer = makeBoardStackTestLayer;

const t0 = "2026-01-01T00:00:00.000Z";
const at = (minute: number) => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

const projectId = ProjectId.make("project-a");
const instance = ProviderInstanceId.make("codex");

let commandSeq = 0;
const nextCommandId = () => CommandId.make(`cmd-signal-${(commandSeq += 1)}`);

/** One `it.layer` block shares a database, so each test derives its own thread
    id from its tag and the project create is idempotent by its fixed id. */
const seed = Effect.fn("seed")(function* (tag: string) {
  const threadId = ThreadId.make(`thread-${tag}`);
  const engine = yield* boardStackEngine;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-project"),
    projectId,
    title: "Project A",
    workspaceRoot: "/tmp/project-a",
    defaultModelSelection: { instanceId: instance, model: "gpt-5-codex" },
    createdAt: t0,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`cmd-thread-${tag}`),
    threadId,
    projectId,
    title: `Thread ${tag}`,
    modelSelection: { instanceId: instance, model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: t0,
  });
  return threadId;
});

/** A tool call, as far as the projection is concerned: the row a review phase
    reading files writes over and over while writing no prose at all. */
const toolActivity = (id: string, createdAt: string): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  tone: "info",
  kind: "tool.call.completed",
  summary: "Read a file",
  payload: {},
  turnId: null,
  createdAt,
});

const appendActivity = (threadId: ThreadId, id: string, createdAt: string) =>
  Effect.gen(function* () {
    const engine = yield* boardStackEngine;
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: nextCommandId(),
      threadId,
      activity: toolActivity(id, createdAt),
      createdAt,
    });
  });

const appendAssistantMessage = (threadId: ThreadId, id: string, createdAt: string) =>
  Effect.gen(function* () {
    const engine = yield* boardStackEngine;
    yield* engine.dispatch({
      type: "thread.message.assistant.delta",
      commandId: nextCommandId(),
      threadId,
      messageId: MessageId.make(id),
      delta: "still working",
      createdAt,
    });
  });

const lastSignalAt = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const methods = yield* BoardQueries;
    assert.isNotNull(methods);
    return yield* methods!.boardThreadLastSignalAt(threadId);
  });

it.layer(makeLayer("t3o-board-signal-"))("boardThreadLastSignalAt (T3O-12)", (it) => {
  it.effect("a thread that has produced nothing has no life sign", () =>
    Effect.gen(function* () {
      const threadId = yield* seed("silent");
      // Null and not a zero date: "no life sign" is the conservative reading,
      // and it is what every thread read before this signal existed.
      assert.isNull(yield* lastSignalAt(threadId));
    }),
  );

  it.effect("a tool call alone makes a thread alive, with no prose written", () =>
    Effect.gen(function* () {
      const threadId = yield* seed("tools");
      yield* appendActivity(threadId, "sig-tools-1", at(5));
      assert.strictEqual(yield* lastSignalAt(threadId), at(5));
      // The signal ADVANCES with each further call: this is what a review phase
      // twenty minutes into reading the diff looks like.
      yield* appendActivity(threadId, "sig-tools-2", at(20));
      assert.strictEqual(yield* lastSignalAt(threadId), at(20));
    }),
  );

  it.effect("an assistant message alone makes a thread alive", () =>
    Effect.gen(function* () {
      const threadId = yield* seed("prose");
      yield* appendAssistantMessage(threadId, "msg-prose-1", at(7));
      assert.strictEqual(yield* lastSignalAt(threadId), at(7));
    }),
  );

  it.effect("the signal is the NEWEST of the two arms, whichever wrote last", () =>
    Effect.gen(function* () {
      const threadId = yield* seed("both");
      yield* appendAssistantMessage(threadId, "msg-both-1", at(10));
      yield* appendActivity(threadId, "sig-both-1", at(30));
      assert.strictEqual(yield* lastSignalAt(threadId), at(30));

      // And in the other order: a message after the last tool call wins.
      yield* appendAssistantMessage(threadId, "msg-both-2", at(45));
      assert.strictEqual(yield* lastSignalAt(threadId), at(45));
    }),
  );

  it.effect("one thread's output is not another's life sign", () =>
    Effect.gen(function* () {
      const busy = yield* seed("busy");
      const quiet = yield* seed("quiet");
      yield* appendActivity(busy, "sig-busy-1", at(15));
      assert.strictEqual(yield* lastSignalAt(busy), at(15));
      // The scoping that matters: a card whose agent really has died must not
      // be shielded by a sibling card's healthy thread.
      assert.isNull(yield* lastSignalAt(quiet));
    }),
  );
});
