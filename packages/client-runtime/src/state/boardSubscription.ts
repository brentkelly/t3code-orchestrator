/**
 * T3o board subscription state (t3o-26 D4, T3O-57).
 *
 * The board has its own log and sequence, so it rides its own stream,
 * `board.subscribeBoard`, rather than the orchestration shell. One subscription
 * per environment, held for as long as the environment's board atoms are
 * mounted; `applyBoardShellStreamItem` (boardReducer.ts) is its reducer.
 *
 * Every (re)subscription sends the cursor of the snapshot already held, so a
 * reconnect replays only the board events it missed — or, past the server's
 * gap bound or after the server's board was replaced, receives a fresh
 * snapshot. Nothing is persisted: the board waits for its first snapshot on a
 * cold start rather than painting a cached board it cannot vouch for.
 */
import {
  BOARD_WS_METHODS,
  type BoardShellSnapshot,
  type BoardShellStreamItem,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { subscribeDynamic } from "../rpc/client.ts";
import { applyBoardShellStreamItem } from "./boardReducer.ts";
import { followStreamInEnvironment } from "./runtime.ts";

/** Fold a received batch of board items, oldest first. */
export function applyBoardShellStreamItems(
  snapshot: BoardShellSnapshot | null,
  items: ReadonlyArray<BoardShellStreamItem>,
): BoardShellSnapshot | null {
  let next = snapshot;
  for (const item of items) next = applyBoardShellStreamItem(next, item);
  return next;
}

/** The subscription input for a client holding `snapshot`. */
export function boardSubscribeInput(snapshot: BoardShellSnapshot | null) {
  return snapshot === null ? {} : { afterSequence: snapshot.snapshotSequence };
}

export const makeEnvironmentBoardState = Effect.fn("EnvironmentBoardState.make")(function* () {
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const state = yield* SubscriptionRef.make<BoardShellSnapshot | null>(null);

  const applyItems = (items: ReadonlyArray<BoardShellStreamItem>) =>
    SubscriptionRef.update(state, (current) => applyBoardShellStreamItems(current, items));

  yield* Effect.forkScoped(
    subscribeDynamic(
      BOARD_WS_METHODS.subscribeBoard,
      () => SubscriptionRef.get(state).pipe(Effect.map(boardSubscribeInput)),
      {
        onExpectedFailure: (cause) =>
          Effect.logWarning("Could not synchronize the board.").pipe(
            Effect.annotateLogs({ ...safeErrorLogAttributes(Cause.squash(cause)) }),
          ),
        retryExpectedFailureAfter: "250 millis",
        resubscribe: Option.match(wakeups, {
          onNone: () => Stream.never,
          onSome: (service) =>
            service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
        }),
      },
    ).pipe(Stream.runForEachArray(applyItems)),
  );

  return state;
});

/**
 * The board subscription per environment, following the shell's
 * per-environment pattern so every connected environment — local or remote —
 * keeps its own board. `snapshotValueAtom` is null until the first snapshot.
 */
export function createEnvironmentBoardStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const stateAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(makeEnvironmentBoardState().pipe(Effect.map(SubscriptionRef.changes))),
      ),
      { initialValue: null as BoardShellSnapshot | null },
    ),
  );

  const snapshotValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => Option.getOrNull(AsyncResult.value(get(stateAtom(environmentId))))).pipe(
      Atom.withLabel(`environment-board-state-value:${environmentId}`),
    ),
  );

  return { stateAtom, snapshotValueAtom };
}
