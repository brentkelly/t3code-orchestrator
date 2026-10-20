/**
 * T3o board subscription (T3O-57): the client's own board stream, its reducer
 * guard, and resume on reconnect.
 */
import {
  BOARD_WS_METHODS,
  BoardCardId,
  BoardLabelId,
  EnvironmentId,
  ThreadId,
  type BoardLabel,
  type BoardShellSnapshot,
  type BoardShellStreamItem,
  type BoardSubscribeBoardInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import * as RpcSession from "../rpc/session.ts";
import { applyBoardShellStreamItem } from "./boardReducer.ts";
import { applyBoardShellStreamItems, makeEnvironmentBoardState } from "./boardSubscription.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const label = (id: string, name: string): BoardLabel => ({
  labelId: BoardLabelId.make(id),
  name,
  colour: "blue",
  deletedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const SNAPSHOT: BoardShellSnapshot = {
  snapshotSequence: 10,
  cards: [],
  labels: [label("label-1", "Bug")],
  stages: [],
  cardThreads: [],
  providerLimits: [],
};

const labelUpserted = (sequence: number, name: string): BoardShellStreamItem => ({
  kind: "label-upserted",
  sequence,
  label: label("label-1", name),
});

describe("applyBoardShellStreamItem", () => {
  it("ignores a delta until a snapshot arrives", () => {
    expect(applyBoardShellStreamItem(null, labelUpserted(11, "Defect"))).toBeNull();
  });

  it("applies a delta past the cursor and advances it", () => {
    const next = applyBoardShellStreamItem(SNAPSHOT, labelUpserted(11, "Defect"));
    expect(next?.labels.map((entry) => entry.name)).toEqual(["Defect"]);
    expect(next?.snapshotSequence).toBe(11);
  });

  it("drops a delta at or below the cursor", () => {
    expect(applyBoardShellStreamItem(SNAPSHOT, labelUpserted(10, "Defect"))).toBe(SNAPSHOT);
    expect(applyBoardShellStreamItem(SNAPSHOT, labelUpserted(4, "Defect"))).toBe(SNAPSHOT);
  });

  it("always applies card-threads, a fresh read, without moving the cursor", () => {
    const next = applyBoardShellStreamItem(SNAPSHOT, {
      kind: "card-threads",
      sequence: 3,
      cardId: BoardCardId.make("card-1"),
      threads: [{ cardId: BoardCardId.make("card-1"), threadId: ThreadId.make("thread-1") }],
    });
    expect(next?.cardThreads.map((entry) => entry.threadId)).toEqual(["thread-1"]);
    expect(next?.snapshotSequence).toBe(10);
  });

  it("replaces whatever it held with a new snapshot", () => {
    const held = applyBoardShellStreamItems(SNAPSHOT, [labelUpserted(11, "Defect")]);
    const fresh = { ...SNAPSHOT, snapshotSequence: 40, labels: [] };
    expect(applyBoardShellStreamItem(held, { kind: "snapshot", snapshot: fresh })).toBe(fresh);
  });
});

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

/** A session whose board stream records its input and serves `items`. */
const boardSession = (
  inputs: Array<BoardSubscribeBoardInput>,
  items: Queue.Queue<BoardShellStreamItem>,
): RpcSession.RpcSession => {
  const client = {
    [BOARD_WS_METHODS.subscribeBoard]: (input: BoardSubscribeBoardInput) => {
      inputs.push(input);
      return Stream.fromQueue(items);
    },
  } as unknown as WsRpcProtocolClient;
  return {
    client,
    initialConfig: Effect.succeed({} as never),
    subscribeServerConfig: () => Stream.empty as never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
};

describe("environment board subscription", () => {
  it.effect("opens without a cursor, then resumes from its cursor on a new session", () =>
    Effect.gen(function* () {
      const inputs: Array<BoardSubscribeBoardInput> = [];
      const first = yield* Queue.unbounded<BoardShellStreamItem>();
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(boardSession(inputs, first)),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const board = yield* makeEnvironmentBoardState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );

      yield* Queue.offer(first, { kind: "snapshot", snapshot: SNAPSHOT });
      yield* Queue.offer(first, labelUpserted(12, "Defect"));
      const live = yield* SubscriptionRef.changes(board).pipe(
        Stream.filter((snapshot) => snapshot?.snapshotSequence === 12),
        Stream.runHead,
      );
      expect(Option.getOrThrow(live)?.labels.map((entry) => entry.name)).toEqual(["Defect"]);
      expect(inputs).toEqual([{}]);

      // The socket drops and a new session connects: the board resumes from
      // the cursor it holds, and the replayed delta lands on the held board.
      const second = yield* Queue.unbounded<BoardShellStreamItem>();
      yield* SubscriptionRef.set(activeSession, Option.some(boardSession(inputs, second)));
      yield* Queue.offer(second, labelUpserted(13, "Regression"));
      const resumed = yield* SubscriptionRef.changes(board).pipe(
        Stream.filter((snapshot) => snapshot?.snapshotSequence === 13),
        Stream.runHead,
      );
      expect(Option.getOrThrow(resumed)?.labels.map((entry) => entry.name)).toEqual(["Regression"]);
      expect(inputs).toEqual([{}, { afterSequence: 12 }]);
    }).pipe(Effect.scoped),
  );
});
