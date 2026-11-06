import {
  BOARD_LOCAL_WORKER_ID,
  CommandId,
  EnvironmentId,
  type BoardCommand,
  type BoardEvent,
  type BoardState,
  type BoardWorker,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { boardDecidedEvents } from "../decider.ts";
import {
  decideBoardCommandOnModel,
  type BoardOrchestrationReadModel,
} from "../decisionContext.testkit.ts";
import { projectBoardEvent } from "../projector.ts";

const NOW = "2026-10-21T10:00:00.000Z";

const worker = (id: string, label = id): BoardWorker => ({
  id: EnvironmentId.make(id),
  label,
  url: `http://${id}:3773`,
  addedAt: NOW,
});

const model = (board: Partial<BoardState> = {}): BoardOrchestrationReadModel => ({
  board: { cards: [], nextCardNumberByProject: {}, ...board },
  projects: [],
  threads: [],
});

let commandCounter = 0;
const commandId = () => CommandId.make(`cmd-${++commandCounter}`);

const register = (target: BoardWorker, mode: "add" | "repair" = "add"): BoardCommand => ({
  type: "board.worker.register",
  commandId: commandId(),
  mode,
  worker: target,
  createdAt: NOW,
});
const remove = (workerId: string): BoardCommand => ({
  type: "board.worker.remove",
  commandId: commandId(),
  workerId: EnvironmentId.make(workerId),
  createdAt: NOW,
});
const setDefault = (workerId: string): BoardCommand => ({
  type: "board.worker.set-default",
  commandId: commandId(),
  workerId:
    workerId === BOARD_LOCAL_WORKER_ID ? BOARD_LOCAL_WORKER_ID : EnvironmentId.make(workerId),
  createdAt: NOW,
});

/** Decide a command and fold its events, as the engine does. */
const apply = (readModel: BoardOrchestrationReadModel, command: BoardCommand) =>
  Effect.gen(function* () {
    const events = boardDecidedEvents(yield* decideBoardCommandOnModel({ command, readModel }));
    let next = readModel;
    for (const [index, event] of events.entries()) {
      next = yield* projectBoardEvent(next, { ...event, sequence: index + 1 } as BoardEvent);
    }
    return next;
  });

const refusal = (readModel: BoardOrchestrationReadModel, command: BoardCommand) =>
  Effect.flip(decideBoardCommandOnModel({ command, readModel })).pipe(
    Effect.map((error) => ("detail" in error ? error.detail : error.message)),
  );

it.layer(NodeServices.layer)("board worker registry", (it) => {
  it.effect("registers and removes workers, keeping the registry in label order", () =>
    Effect.gen(function* () {
      let next = yield* apply(model(), register(worker("env-b", "zeta")));
      next = yield* apply(next, register(worker("env-a", "alpha")));
      assert.deepStrictEqual(
        next.board?.workers?.map((entry) => entry.label),
        ["alpha", "zeta"],
      );
      next = yield* apply(next, remove("env-b"));
      assert.deepStrictEqual(
        next.board?.workers?.map((entry) => entry.id),
        ["env-a"],
      );
      // The last one going drops the slice: an emptied registry decodes as one
      // that never had a worker.
      next = yield* apply(next, remove("env-a"));
      assert.isUndefined(next.board?.workers);
    }),
  );

  it.effect("refuses adding a worker twice, and re-pairing one that isn't there", () =>
    Effect.gen(function* () {
      const withWorker = yield* apply(model(), register(worker("env-a", "linux-box")));
      assert.include(
        yield* refusal(withWorker, register(worker("env-a", "other"))),
        "linux-box is already a worker",
      );
      assert.include(
        yield* refusal(model(), register(worker("env-a"), "repair")),
        "is not registered",
      );
    }),
  );

  it.effect("a re-pair keeps the label and when it was added; only the URL changes", () =>
    Effect.gen(function* () {
      const withWorker = yield* apply(model(), register(worker("env-a", "linux-box")));
      const next = yield* apply(
        withWorker,
        register(
          {
            id: EnvironmentId.make("env-a"),
            label: "renamed",
            url: "http://new:3773",
            addedAt: "2027-01-01T00:00:00.000Z",
          },
          "repair",
        ),
      );
      assert.deepStrictEqual(next.board?.workers, [
        { ...worker("env-a", "linux-box"), url: "http://new:3773" },
      ]);
    }),
  );

  it.effect("the local worker always exists: it can't be registered or removed", () =>
    Effect.gen(function* () {
      assert.include(
        yield* refusal(model(), register(worker(BOARD_LOCAL_WORKER_ID))),
        "already a worker",
      );
      assert.include(yield* refusal(model(), remove(BOARD_LOCAL_WORKER_ID)), "can't be removed");
    }),
  );

  it.effect("refuses removing the default worker, and allows it once another is default", () =>
    Effect.gen(function* () {
      let next = yield* apply(model(), register(worker("env-a", "linux-box")));
      next = yield* apply(next, setDefault("env-a"));
      assert.strictEqual(next.board?.defaultWorkerId, "env-a");
      assert.include(
        yield* refusal(next, remove("env-a")),
        "Make another worker the default first",
      );
      next = yield* apply(next, setDefault(BOARD_LOCAL_WORKER_ID));
      // `local` is the absent default.
      assert.isUndefined(next.board?.defaultWorkerId);
      next = yield* apply(next, remove("env-a"));
      assert.isUndefined(next.board?.workers);
    }),
  );

  it.effect("refuses an unknown default, and makes re-choosing the default a no-op", () =>
    Effect.gen(function* () {
      assert.include(yield* refusal(model(), setDefault("env-missing")), "is not registered");
      const decided = yield* decideBoardCommandOnModel({
        command: setDefault(BOARD_LOCAL_WORKER_ID),
        readModel: model(),
      });
      assert.deepStrictEqual(boardDecidedEvents(decided), []);
    }),
  );
});
