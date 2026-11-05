import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { TerminalManager } from "../../terminal/Manager.ts";
import { BoardTerminals } from "./BoardTerminals.ts";

export const BoardTerminalsLive = Layer.effect(
  BoardTerminals,
  Effect.gen(function* () {
    const terminals = yield* TerminalManager;
    return BoardTerminals.of({ close: terminals.close });
  }),
);
