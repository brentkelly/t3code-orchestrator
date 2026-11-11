/**
 * T3o: which card waits raise a notification on this device. Per device, like
 * upstream's notification mode, and only effective inside it.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const BoardNotificationSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Violet: a question, a permission prompt, a plan or split to approve. */
  waiting: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Amber: a stage stopped and only a human moves the card on. */
  needsHuman: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** A pull request waits at the merge stage with auto-merge off. */
  readyForMerge: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Off by default: a dependency gate usually clears by itself. */
  blocked: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Drops upstream's "Thread completed" and usage-limit alerts for card threads. */
  muteRoutineThreadAlerts: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type BoardNotificationSettings = typeof BoardNotificationSettings.Type;
