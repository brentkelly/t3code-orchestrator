/**
 * The board's narrow view of upstream's `TerminalManager` (T3O-45): importing
 * `terminal/Manager.ts` loads every provider driver. Board code depends on this
 * port; only `BoardTerminals.live.ts` imports upstream.
 */
import type { TerminalCloseInput, TerminalError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export class BoardTerminals extends Context.Service<
  BoardTerminals,
  {
    /** Omit terminalId to close all sessions for the thread. */
    readonly close: (input: TerminalCloseInput) => Effect.Effect<void, TerminalError>;
  }
>()("t3/board/ports/BoardTerminals") {}
