/**
 * Planning runs on the board server (T3O-87): it needs a checkout of the project there and the
 * step's provider signed in there, reported apart. The readiness script gates builds only.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  boardCardStepState,
  type BoardWorkerCapacitySnapshot,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeFakeCapacity } from "../capacity/capacityClient.testkit.ts";
import {
  cardMoved,
  codexStep,
  makeBoardCard,
  settingsWith,
  withGovernor,
} from "../supervisorHarness.testkit.ts";

const settings = settingsWith({
  building: [codexStep],
  planning: codexStep,
  globalMaxConcurrent: 3,
});
const sprint = makeBoardCard({ id: "card-1", stage: "sprint", orderKey: "m" });
const toPlanning = cardMoved(
  { ...sprint, stage: BOARD_SEED_STAGE_IDS.planning },
  "sprint",
  "planning",
  1,
);

const localSnapshot = (
  overrides: Partial<BoardWorkerCapacitySnapshot>,
): BoardWorkerCapacitySnapshot => ({
  at: "1970-01-01T00:00:00.000Z",
  declared: { cpuCores: 0, ramGiB: 0, diskGB: 50 },
  headroom: { cpuCores: 0, ramGiB: 0, diskGB: 50 },
  over: { cpuRam: false, disk: false },
  agents: { running: 0, max: null },
  providers: [],
  readiness: [],
  heavyCards: [],
  ...overrides,
});

const codexAccount = (status: "signed-in" | "signed-out") => ({
  instanceId: "codex",
  driver: "codex",
  account: { status },
  quota: { exhausted: false, checkedAt: null, resetsAt: null, windows: [] },
  agents: { running: 0, max: null },
});

describe("planning on the board server (T3O-87)", () => {
  it.effect("holds amber when the board server's folder isn't a checkout", () =>
    withGovernor(
      { board: { cards: [sprint], nextCardNumberByProject: {} }, settings, notAGitRepo: true },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(toPlanning);
          const state = boardCardStepState(yield* h.board, BoardCardId.make("card-1"));
          assert.strictEqual(state?.status, "queued");
          assert.strictEqual(state?.queuedBy, "server-checkout");
          assert.strictEqual(state?.queuedDetail?.serverCheckout, "missing");
          assert.isFalse((yield* h.commands).some((command) => command.type === "thread.spawn"));
        }),
    ),
  );

  it.effect("holds violet when the step's provider isn't signed in there", () =>
    Effect.gen(function* () {
      const capacity = yield* makeFakeCapacity(new Map());
      capacity.frozen.set(
        BOARD_LOCAL_WORKER_ID,
        localSnapshot({ providers: [codexAccount("signed-out")] }),
      );
      yield* withGovernor(
        { board: { cards: [sprint], nextCardNumberByProject: {} }, settings, capacity },
        (h) =>
          Effect.gen(function* () {
            yield* h.pumpDomain(toPlanning);
            const state = boardCardStepState(yield* h.board, BoardCardId.make("card-1"));
            assert.strictEqual(state?.queuedBy, "server-sign-in");
            assert.strictEqual(state?.queuedDetail?.providerInstanceId, "codex");
          }),
      );
    }),
  );

  it.effect("plans when the board server fails the readiness script or has no build room", () =>
    Effect.gen(function* () {
      const capacity = yield* makeFakeCapacity(new Map());
      capacity.frozen.set(
        BOARD_LOCAL_WORKER_ID,
        localSnapshot({
          providers: [codexAccount("signed-in")],
          readiness: [
            {
              repositoryKey: null,
              path: ".t3/ready.sh",
              state: "not-ready",
              version: null,
              checkedAt: null,
            },
          ],
        }),
      );
      yield* withGovernor(
        { board: { cards: [sprint], nextCardNumberByProject: {} }, settings, capacity },
        (h) =>
          Effect.gen(function* () {
            yield* h.pumpDomain(toPlanning);
            const state = boardCardStepState(yield* h.board, BoardCardId.make("card-1"));
            assert.strictEqual(state?.status, "running");
          }),
      );
    }),
  );
});
