/**
 * T3o worker removal, re-add and force-move, the decider half (T3O-66, D22).
 *
 * Removing a worker decides what happens to every card placed there in the
 * same command: a card with nothing there follows the default worker, and one
 * with a worktree or a running step holds ("placementOrphaned") until a human
 * moves it. Adding the worker back reattaches it. A force-move leaves a worker
 * the board can't reach, abandoning its worktree there or, with nothing on the
 * remote, restarting the card's branch from base.
 */
import {
  BoardCardId,
  BoardStageId,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardCardStepState,
  type BoardCardThreadLink,
  type BoardCardWorktree,
  type BoardState,
  type BoardWorkerId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { boardDecidedEvents, type BoardCommand } from "./decider.ts";
import {
  decideBoardCommandOnModel,
  type BoardOrchestrationReadModel,
} from "./decisionContext.testkit.ts";
import { projectBoardEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const workerA = EnvironmentId.make("env-worker-a");
const workerB = EnvironmentId.make("env-worker-b");

const readyWorktree: BoardCardWorktree = {
  branch: "board/card-1",
  baseRefName: "main",
  path: "/tmp/worktrees/card-1",
  status: "ready",
  attempts: 1,
  lastError: null,
  reclaimBlockedReason: null,
};

function makeCard(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id: BoardCardId.make("card-1"),
    key: "T3-1",
    cardNumber: 1,
    projectId,
    labels: [],
    stage: BoardStageId.make("building"),
    orderKey: "m",
    title: "Card",
    briefRef: null,
    dependsOn: [],
    parentCardId: null,
    sourcePlanId: null,
    threadLinks: [],
    attachments: [],
    externalRef: null,
    humanInLoop: null,
    reviewOverrides: null,
    modelOverrides: null,
    splitRationale: null,
    baseBranch: null,
    scheduledStartAt: null,
    autoStart: false,
    autoMerge: false,
    autoMergeHold: null,
    pinnedWorkerId: null,
    placedWorkerId: null,
    workerMove: null,
    placementOrphaned: null,
    worktree: null,
    pullRequest: null,
    pullRequestHistory: [],
    pullRequestFloor: null,
    blocked: false,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeStep(
  status: BoardCardStepState["status"],
  threadId: BoardCardStepState["threadId"] = null,
): BoardCardStepState {
  return {
    cardId: BoardCardId.make("card-1"),
    stepId: "building",
    stepLabel: null,
    stageLabel: "Building",
    attempt: 1,
    stallCount: 0,
    stageEntryRecoveries: 0,
    humanTurnAt: null,
    lastNudgeAt: null,
    baseTipAtRoundStart: null,
    lastError: null,
    awaitingReason: "question",
    stalledReason: "gave-up",
    retryAt: null,
    prompt: "build it",
    providerInstanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5-codex",
    mode: "build",
    runtimeMode: "full-access",
    humanInLoop: false,
    maxAttempts: 3,
    timeoutMs: 60_000,
    threadId,
    status,
    slotHeld: false,
    forceStart: false,
    queuedBy: null,
    startedAt: null,
    updatedAt: NOW,
  };
}

function makeReadModel(input: {
  readonly cards: ReadonlyArray<BoardCard>;
  readonly stepStates?: ReadonlyArray<BoardCardStepState>;
  readonly defaultWorkerId?: BoardWorkerId;
}): BoardOrchestrationReadModel {
  const board: BoardState = {
    cards: input.cards,
    nextCardNumberByProject: {},
    workers: [
      { id: workerA, label: "worker-a", url: "http://worker-a:3773", addedAt: NOW },
      { id: workerB, label: "worker-b", url: "http://worker-b:3773", addedAt: NOW },
    ],
    ...(input.stepStates === undefined ? {} : { stepStates: input.stepStates }),
    ...(input.defaultWorkerId === undefined ? {} : { defaultWorkerId: input.defaultWorkerId }),
  };
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: projectId,
        title: "Project 1",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads: [],
    board,
    updatedAt: NOW,
  };
}

const decideEvents = (command: BoardCommand, readModel: BoardOrchestrationReadModel) =>
  decideBoardCommandOnModel({ command, readModel }).pipe(Effect.map(boardDecidedEvents));

const decideFail = (command: BoardCommand, readModel: BoardOrchestrationReadModel) =>
  Effect.flip(decideEvents(command, readModel));

/** The card after a command, folded through the projector as the engine does. */
const cardAfter = (command: BoardCommand, readModel: BoardOrchestrationReadModel) =>
  Effect.gen(function* () {
    let model = readModel;
    for (const event of yield* decideEvents(command, readModel)) {
      model = yield* projectBoardEvent(model, { ...event, sequence: 1 } as never);
    }
    return model.board!.cards.find((card) => card.id === "card-1")!;
  });

const removeWorker = (workerId: EnvironmentId): BoardCommand => ({
  type: "board.worker.remove",
  commandId: CommandId.make("cmd-remove"),
  workerId,
  createdAt: NOW,
});

const addWorker = (workerId: EnvironmentId): BoardCommand => ({
  type: "board.worker.register",
  commandId: CommandId.make("cmd-add"),
  mode: "add",
  worker: { id: workerId, label: "worker-a", url: "http://worker-a:3773", addedAt: NOW },
  createdAt: NOW,
});

const linkOn = (threadId: string, workerId: EnvironmentId): BoardCardThreadLink => ({
  threadId: ThreadId.make(threadId),
  role: "building",
  linkedAt: NOW,
  tombstonedAt: null,
  workerId,
});

/** Fold every event a command decides into the model. */
const apply = (command: BoardCommand, readModel: BoardOrchestrationReadModel) =>
  Effect.gen(function* () {
    let model = readModel;
    for (const event of yield* decideEvents(command, readModel)) {
      model = yield* projectBoardEvent(model, { ...event, sequence: 1 } as never);
    }
    return model;
  });

const pin = (workerId: BoardWorkerId | null): BoardCommand => ({
  type: "board.card.pin-worker",
  commandId: CommandId.make("cmd-pin"),
  cardId: BoardCardId.make("card-1"),
  workerId,
  createdAt: NOW,
});

const moveStep = (
  step: Extract<BoardCommand, { type: "board.card.move-worker" }>["step"],
): BoardCommand => ({
  type: "board.card.move-worker",
  commandId: CommandId.make(`cmd-move-${step.phase}`),
  cardId: BoardCardId.make("card-1"),
  step,
  createdAt: NOW,
});

it.layer(NodeServices.layer)("worker removal and force-move decider (T3O-66)", (it) => {
  it.effect("removal falls a card with nothing there back to the default, with a row", () =>
    Effect.gen(function* () {
      const events = yield* decideEvents(
        removeWorker(workerA),
        makeReadModel({ cards: [makeCard({ pinnedWorkerId: workerA })] }),
      );
      expect(events.map((event) => event.type)).toEqual([
        "board.worker-removed",
        "board.card-worker-removal",
      ]);
      const fallback = events[1]!;
      assert.ok(fallback.type === "board.card-worker-removal");
      expect(fallback.payload.outcome).toBe("fallback");
      expect(fallback.payload.workerLabel).toBe("worker-a");
      expect(fallback.payload.card.pinnedWorkerId).toBeNull();
      expect(fallback.payload.card.placedWorkerId).toBeNull();
      expect(fallback.payload.card.placementOrphaned).toBeNull();
    }),
  );

  it.effect("removal leaves a card with a worktree there holding, placed where it was", () =>
    Effect.gen(function* () {
      const model = yield* apply(
        removeWorker(workerA),
        makeReadModel({
          cards: [makeCard({ placedWorkerId: workerA, worktree: readyWorktree })],
        }),
      );
      const card = model.board!.cards[0]!;
      expect(card.placementOrphaned).toEqual({
        workerId: workerA,
        workerLabel: "worker-a",
        orphanedAt: NOW,
      });
      expect(card.placedWorkerId).toBe(workerA);
      expect(card.worktree?.path).toBe(readyWorktree.path);
      expect(model.board!.workers?.map((worker) => worker.id)).toEqual([workerB]);
    }),
  );

  it.effect("removal leaves a card with a step running there holding, worktree or not", () =>
    Effect.gen(function* () {
      const model = yield* apply(
        removeWorker(workerA),
        makeReadModel({
          cards: [
            makeCard({
              stage: BoardStageId.make("planning"),
              placedWorkerId: workerA,
              threadLinks: [linkOn("thread-plan", workerA)],
            }),
          ],
          stepStates: [makeStep("running", ThreadId.make("thread-plan"))],
        }),
      );
      expect(model.board!.cards[0]!.placementOrphaned?.workerId).toBe(workerA);
    }),
  );

  it.effect("removal leaves cards on other workers, and the default, alone", () =>
    Effect.gen(function* () {
      const events = yield* decideEvents(
        removeWorker(workerA),
        makeReadModel({
          cards: [makeCard({ placedWorkerId: workerB, worktree: readyWorktree })],
        }),
      );
      expect(events.map((event) => event.type)).toEqual(["board.worker-removed"]);
    }),
  );

  it.effect("adding the worker back reattaches the cards its removal left holding", () =>
    Effect.gen(function* () {
      const removed = yield* apply(
        removeWorker(workerA),
        makeReadModel({
          cards: [makeCard({ placedWorkerId: workerA, worktree: readyWorktree })],
        }),
      );
      const events = yield* decideEvents(addWorker(workerA), removed);
      expect(events.map((event) => event.type)).toEqual([
        "board.worker-registered",
        "board.card-worker-removal",
      ]);
      const readded = yield* apply(addWorker(workerA), removed);
      const card = readded.board!.cards[0]!;
      expect(card.placementOrphaned).toBeNull();
      expect(card.placedWorkerId).toBe(workerA);
      expect(card.worktree?.status).toBe("ready");
    }),
  );

  it.effect("removing the worker a card is moving to fails the move, so it can go elsewhere", () =>
    Effect.gen(function* () {
      const moving = {
        fromWorkerId: workerA,
        toWorkerId: workerB,
        status: "moving",
        sha: null,
        error: null,
        startedAt: NOW,
      } as const;
      // Retired already: Move failed, and a human picks another worker.
      const retired = makeReadModel({
        cards: [
          makeCard({
            worktree: { ...readyWorktree, path: null, status: "reclaimed" },
            workerMove: moving,
          }),
        ],
      });
      const events = yield* decideEvents(removeWorker(workerB), retired);
      expect(events.map((event) => event.type)).toEqual([
        "board.worker-removed",
        "board.card-worker-move-recorded",
      ]);
      const model = yield* apply(removeWorker(workerB), retired);
      const failed = model.board!.cards[0]!;
      expect(failed.workerMove?.status).toBe("failed");
      expect(failed.workerMove?.error).toContain("worker-b was removed");
      // The mover's last step finds nothing moving.
      const late = yield* Effect.flip(
        decideEvents(moveStep({ phase: "done", worktreePath: "/worker-b/card-1" }), model),
      );
      expect(String(late)).toContain("not moving");
      const retry = yield* decideEvents(
        moveStep({ phase: "start", toWorkerId: workerA, sha: null }),
        model,
      );
      expect(retry).toHaveLength(1);

      // Not retired yet: the card still holds its worktree, so it stays put.
      const holding = yield* apply(
        removeWorker(workerB),
        makeReadModel({
          cards: [
            makeCard({ placedWorkerId: workerA, worktree: readyWorktree, workerMove: moving }),
          ],
        }),
      );
      expect(holding.board!.cards[0]!.workerMove).toBeNull();
      expect(holding.board!.cards[0]!.placedWorkerId).toBe(workerA);
    }),
  );

  it.effect("a move never lands on a worker the board no longer has", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        decideEvents(
          moveStep({ phase: "done", worktreePath: "/gone/card-1" }),
          makeReadModel({
            cards: [
              makeCard({
                worktree: { ...readyWorktree, path: null, status: "reclaimed" },
                workerMove: {
                  fromWorkerId: workerA,
                  toWorkerId: EnvironmentId.make("env-gone"),
                  status: "moving",
                  sha: null,
                  error: null,
                  startedAt: NOW,
                },
              }),
            ],
          }),
        ),
      );
      expect(String(failure)).toContain("no longer registered");
    }),
  );

  it.effect("a pin moves a held card with no worktree, ending the hold", () =>
    Effect.gen(function* () {
      const held = makeReadModel({
        cards: [
          makeCard({
            placedWorkerId: workerA,
            placementOrphaned: { workerId: workerA, workerLabel: "worker-a", orphanedAt: NOW },
          }),
        ],
      });
      const card = yield* cardAfter(pin(workerB), held);
      expect(card.placementOrphaned).toBeNull();
      expect(card.pinnedWorkerId).toBe(workerB);
      // Pinning a held card to where it already points still ends the hold.
      const same = yield* cardAfter(pin(null), held);
      expect(same.placementOrphaned).toBeNull();
    }),
  );

  it.effect("a force-move starts over a step still running on the old worker", () =>
    Effect.gen(function* () {
      const running = makeReadModel({
        cards: [makeCard({ placedWorkerId: workerA, worktree: readyWorktree })],
        stepStates: [makeStep("running")],
      });
      const refused = yield* decideFail(
        moveStep({ phase: "start", toWorkerId: workerB, sha: null }),
        running,
      );
      expect(String(refused)).toContain("step running");
      const events = yield* decideEvents(
        moveStep({ phase: "start", toWorkerId: workerB, sha: "4e1a9c2", force: true }),
        running,
      );
      expect(events).toHaveLength(1);
    }),
  );

  it.effect("a force-move abandons the old worktree, then lands from the remote branch", () =>
    Effect.gen(function* () {
      let model = makeReadModel({
        cards: [
          makeCard({
            placedWorkerId: workerA,
            worktree: readyWorktree,
            placementOrphaned: { workerId: workerA, workerLabel: "worker-a", orphanedAt: NOW },
          }),
        ],
      });
      const abandoned = moveStep({ phase: "abandoned", worktreePath: readyWorktree.path });
      for (const step of [
        moveStep({ phase: "start", toWorkerId: workerB, sha: "4e1a9c2", force: true }),
        abandoned,
      ]) {
        model = yield* apply(step, model);
      }
      const left = model.board!.cards[0]!;
      expect(left.worktree?.status).toBe("reclaimed");
      expect(left.worktree?.path).toBeNull();
      expect(left.placedWorkerId).toBeNull();
      expect(left.placementOrphaned).toBeNull();
      expect(left.workerMove?.status).toBe("moving");
      model = yield* apply(
        moveStep({ phase: "done", worktreePath: "/worker-b/worktrees/card-1" }),
        model,
      );
      const landed = model.board!.cards[0]!;
      expect(landed.placedWorkerId).toBe(workerB);
      expect(landed.worktree?.branch).toBe(readyWorktree.branch);
      expect(landed.workerMove).toBeNull();
    }),
  );

  it.effect("a force-move with nothing on the remote forgets the branch and ends there", () =>
    Effect.gen(function* () {
      let model = makeReadModel({
        cards: [makeCard({ placedWorkerId: workerA, worktree: readyWorktree })],
      });
      model = yield* apply(
        moveStep({ phase: "start", toWorkerId: workerB, sha: null, force: true }),
        model,
      );
      model = yield* apply(moveStep({ phase: "restarted" }), model);
      const card = model.board!.cards[0]!;
      expect(card.worktree).toBeNull();
      expect(card.pinnedWorkerId).toBe(workerB);
      expect(card.placedWorkerId).toBeNull();
      expect(card.workerMove).toBeNull();
      // The restart is the end of the move: nothing more can be recorded on it.
      const after = yield* decideFail(
        moveStep({ phase: "done", worktreePath: "/worker-b/worktrees/card-1" }),
        model,
      );
      expect(String(after)).toContain("not moving");
    }),
  );
});
