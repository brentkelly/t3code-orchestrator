/**
 * The usage-limit detection SEAM (T3O-22, D17).
 *
 * Everything about which sentence means what is tested against the pure
 * classifier in `packages/contracts`. What is left here is the seam's own two
 * decisions, and they are the ones with a bug in them if they are wrong:
 *
 * - which CHANNEL the text comes from — a failed turn's `errorMessage` when
 *   there is one, the last assistant message otherwise. Grok's quota refusal
 *   arrives ONLY the first way, with no assistant message anywhere, and the
 *   board dropped it entirely before this;
 * - the freshness bound: a turn that ends having said nothing leaves an older
 *   message newest, and reading that back would park a card on a limit that has
 *   already passed.
 */
import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

import { UsageLimitDetector, UsageLimitDetectorLive } from "./UsageLimitDetector.ts";

const threadId = ThreadId.make("thread-1");
const NOW = Date.parse("2026-07-19T12:00:00.000Z");

/** A snapshot query holding one assistant message, in the shape
    `boardSnapshotQueryMethodsOf` recognises. */
const snapshotWith = (message: { readonly text: string; readonly createdAt: string } | null) =>
  Layer.succeed(ProjectionSnapshotQuery, {
    boardCardDetail: () => Effect.succeed(null),
    boardCardActivity: () => Effect.succeed([]),
    boardPlanBody: () => Effect.succeed(null),
    boardCardThreads: () => Effect.succeed([]),
    boardCardIdForThread: () => Effect.succeed(null),
    boardThreadTodo: () => Effect.succeed(null),
    boardLatestAssistantMessage: () => Effect.succeed(message),
    boardThreadLastSignalAt: () => Effect.succeed(null),
    boardThreadPendingTurnStartAt: () => Effect.succeed(null),
    boardSweepThreadTodos: () => Effect.succeed(0),
  } as unknown as ProjectionSnapshotQuery["Service"]);

const classify = (input: {
  readonly message?: { readonly text: string; readonly createdAt: string } | null;
  readonly turnErrorMessage?: string | null;
  readonly since?: string | null;
}) =>
  Effect.gen(function* () {
    const detector = yield* UsageLimitDetector;
    return yield* detector.classifyTurn({
      threadId,
      turnErrorMessage: input.turnErrorMessage ?? null,
      nowMs: NOW,
      since: input.since ?? null,
    });
  }).pipe(
    Effect.provide(UsageLimitDetectorLive.pipe(Layer.provide(snapshotWith(input.message ?? null)))),
  );

it.effect("reads Grok's refusal off the failed turn's error field, with no message at all", () =>
  Effect.gen(function* () {
    const match = yield* classify({
      message: null,
      turnErrorMessage: "Grok usage limit reached. Try again later.",
    });
    assert.strictEqual(match?.kind, "wait");
    // The channel alone makes it strict: nobody quotes a sentence INTO a failed
    // turn's error field.
    assert.strictEqual(match?.confidence, "strict");
  }),
);

it.effect("prefers the turn's error field over the last assistant message", () =>
  Effect.gen(function* () {
    const match = yield* classify({
      message: {
        text: "I finished the refactor and every test passes.",
        createdAt: "2026-07-19T11:59:00.000Z",
      },
      turnErrorMessage: "Grok usage limit reached. Try again later.",
    });
    assert.strictEqual(match?.kind, "wait");
  }),
);

it.effect("falls back to the last assistant message when the turn reported no error", () =>
  Effect.gen(function* () {
    const match = yield* classify({
      message: {
        text: "You've hit your session limit · resets 2:50am (Pacific/Auckland)",
        createdAt: "2026-07-19T11:59:00.000Z",
      },
    });
    assert.strictEqual(match?.kind, "wait");
    assert.strictEqual(match?.resumeAt, "2026-07-19T14:51:00.000Z");
  }),
);

it.effect("ignores a message the agent wrote BEFORE the work last resumed", () =>
  Effect.gen(function* () {
    // The turn ended having said nothing — interrupted, errored, tool-only — so
    // the newest message is the one from the turn before. Taking it at face
    // value would re-park the card on a limit that has already passed.
    const match = yield* classify({
      message: {
        text: "You've hit your session limit · resets 2:50am (Pacific/Auckland)",
        createdAt: "2026-07-19T10:00:00.000Z",
      },
      since: "2026-07-19T11:00:00.000Z",
    });
    assert.strictEqual(match, null);
  }),
);

it.effect("answers nothing for a thread with no message and no error", () =>
  Effect.gen(function* () {
    // Best-effort by design: no match leaves recovery exactly as it was before
    // this feature existed.
    assert.strictEqual(yield* classify({}), null);
    assert.strictEqual(yield* classify({ turnErrorMessage: "   " }), null);
  }),
);
