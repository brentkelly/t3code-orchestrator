/**
 * T3o card placement and moving, the decider half (T3O-65, D20).
 *
 * A card has a pin (a chosen worker, or null to follow the default) and a
 * placement (where its threads spawned). A worktree binds the card to where it
 * was placed: from then on only a move changes it, and a move is refused while
 * a step runs. These pin the rules the supervisor and the Move dialog lean on.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  BoardCardId,
  BoardStageId,
  boardCardEffectiveWorkerId,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type BoardCard,
  type BoardCardStepState,
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

function makeStep(status: BoardCardStepState["status"]): BoardCardStepState {
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
    threadId: null,
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

const pin = (workerId: BoardWorkerId | null): BoardCommand => ({
  type: "board.card.pin-worker",
  commandId: CommandId.make("cmd-pin"),
  cardId: BoardCardId.make("card-1"),
  workerId,
  createdAt: NOW,
});

const place = (workerId: BoardWorkerId): BoardCommand => ({
  type: "board.card.place",
  commandId: CommandId.make("cmd-place"),
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

it.layer(NodeServices.layer)("card placement decider (T3O-65)", (it) => {
  // ── Placement resolution ─────────────────────────────────────────────

  it("resolves pin, then default; a worktree binds the card where it was placed", () => {
    expect(boardCardEffectiveWorkerId(makeCard(), undefined)).toBe(BOARD_LOCAL_WORKER_ID);
    expect(boardCardEffectiveWorkerId(makeCard(), workerA)).toBe(workerA);
    expect(boardCardEffectiveWorkerId(makeCard({ pinnedWorkerId: workerB }), workerA)).toBe(
      workerB,
    );
    // Placed on A without a checkout: nothing binds it, so it follows its pin
    // or the default on its next spawn.
    expect(boardCardEffectiveWorkerId(makeCard({ placedWorkerId: workerA }), workerB)).toBe(
      workerB,
    );
    // With a worktree on A, a default change does not move it.
    expect(
      boardCardEffectiveWorkerId(
        makeCard({ placedWorkerId: workerA, worktree: readyWorktree }),
        workerB,
      ),
    ).toBe(workerA);
    // A worktree from before workers existed is this server's.
    expect(boardCardEffectiveWorkerId(makeCard({ worktree: readyWorktree }), workerB)).toBe(
      BOARD_LOCAL_WORKER_ID,
    );
  });

  it.effect("provisioning a worktree records the placement it is cut on", () =>
    Effect.gen(function* () {
      const provision: BoardCommand = {
        type: "board.card.provision-worktree",
        commandId: CommandId.make("cmd-provision"),
        cardId: BoardCardId.make("card-1"),
        branch: "board/t3-1",
        baseRefName: "main",
        createdAt: NOW,
      };
      const byDefault = yield* cardAfter(
        provision,
        makeReadModel({ cards: [makeCard()], defaultWorkerId: workerA }),
      );
      expect(byDefault.placedWorkerId).toBe(workerA);
      const byPin = yield* cardAfter(
        provision,
        makeReadModel({
          cards: [makeCard({ pinnedWorkerId: workerB, placedWorkerId: workerA })],
          defaultWorkerId: workerA,
        }),
      );
      expect(byPin.placedWorkerId).toBe(workerB);
    }),
  );

  // ── Create ───────────────────────────────────────────────────────────

  it.effect("creates a card pinned to a worker, and refuses an unknown one", () =>
    Effect.gen(function* () {
      const create = (pinnedWorkerId: BoardWorkerId): BoardCommand => ({
        type: "board.card.create",
        commandId: CommandId.make("cmd-create"),
        cardId: BoardCardId.make("card-new"),
        projectId,
        title: "New card",
        pinnedWorkerId,
        createdAt: NOW,
      });
      const [created] = yield* decideEvents(create(workerA), makeReadModel({ cards: [] }));
      assert.ok(created!.type === "board.card-created");
      expect(created.payload.pinnedWorkerId).toBe(workerA);

      const failure = yield* decideFail(
        create(EnvironmentId.make("env-unknown")),
        makeReadModel({ cards: [] }),
      );
      expect(String(failure)).toContain("not registered");
    }),
  );

  it.effect("a hand-created sub-board child copies its parent's pin", () =>
    Effect.gen(function* () {
      const parent = makeCard({ stage: BoardStageId.make("planning"), pinnedWorkerId: workerA });
      const [created] = yield* decideEvents(
        {
          type: "board.card.create",
          commandId: CommandId.make("cmd-create-child"),
          cardId: BoardCardId.make("card-child"),
          projectId,
          title: "Child",
          stage: BoardStageId.make("ready"),
          parentCardId: parent.id,
          createdAt: NOW,
        },
        makeReadModel({ cards: [parent] }),
      );
      assert.ok(created!.type === "board.card-created");
      expect(created.payload.pinnedWorkerId).toBe(workerA);
    }),
  );

  it.effect("a hand-created child of a parent pinned to a removed worker follows the default", () =>
    Effect.gen(function* () {
      const gone = EnvironmentId.make("env-removed");
      const parent = makeCard({ stage: BoardStageId.make("planning"), pinnedWorkerId: gone });
      const [created] = yield* decideEvents(
        {
          type: "board.card.create",
          commandId: CommandId.make("cmd-create-child"),
          cardId: BoardCardId.make("card-child"),
          projectId,
          title: "Child",
          stage: BoardStageId.make("ready"),
          parentCardId: parent.id,
          createdAt: NOW,
        },
        makeReadModel({ cards: [parent] }),
      );
      assert.ok(created!.type === "board.card-created");
      expect(created.payload.pinnedWorkerId ?? null).toBeNull();
    }),
  );

  // ── Pin ──────────────────────────────────────────────────────────────

  it.effect("re-pins a card with no worktree at once, clearing where it last ran", () =>
    Effect.gen(function* () {
      const card = yield* cardAfter(
        pin(workerB),
        makeReadModel({ cards: [makeCard({ placedWorkerId: workerA })] }),
      );
      expect(card.pinnedWorkerId).toBe(workerB);
      expect(card.placedWorkerId).toBeNull();

      const unpinned = yield* cardAfter(
        pin(null),
        makeReadModel({ cards: [makeCard({ pinnedWorkerId: workerB })] }),
      );
      expect(unpinned.pinnedWorkerId).toBeNull();
    }),
  );

  it.effect("re-pins a card whose worktree was reclaimed", () =>
    Effect.gen(function* () {
      const card = yield* cardAfter(
        pin(workerB),
        makeReadModel({
          cards: [
            makeCard({
              placedWorkerId: workerA,
              worktree: { ...readyWorktree, path: null, status: "reclaimed" },
            }),
          ],
        }),
      );
      expect(card.pinnedWorkerId).toBe(workerB);
    }),
  );

  it.effect("refuses a pin that would take a card off the worker holding its worktree", () =>
    Effect.gen(function* () {
      const model = makeReadModel({
        cards: [makeCard({ placedWorkerId: workerA, worktree: readyWorktree })],
      });
      const failure = yield* decideFail(pin(workerB), model);
      expect(String(failure)).toContain("move it");
      // Pinning it where it already is changes nothing about where it runs.
      const card = yield* cardAfter(pin(workerA), model);
      expect(card.pinnedWorkerId).toBe(workerA);
      expect(card.placedWorkerId).toBe(workerA);
    }),
  );

  it.effect("a pin that changes nothing decides no event; an unknown worker is refused", () =>
    Effect.gen(function* () {
      const events = yield* decideEvents(
        pin(workerA),
        makeReadModel({ cards: [makeCard({ pinnedWorkerId: workerA })] }),
      );
      expect(events).toEqual([]);
      const failure = yield* decideFail(
        pin(EnvironmentId.make("env-unknown")),
        makeReadModel({ cards: [makeCard()] }),
      );
      expect(String(failure)).toContain("not registered");
    }),
  );

  it.effect("refuses a pin while a move is in flight or has failed", () =>
    Effect.gen(function* () {
      const move = {
        fromWorkerId: workerA,
        toWorkerId: workerB,
        status: "failed" as const,
        sha: null,
        error: "git worktree add failed",
        startedAt: NOW,
      };
      const failure = yield* decideFail(
        pin(workerA),
        makeReadModel({ cards: [makeCard({ workerMove: move })] }),
      );
      expect(String(failure)).toContain("move failed");
    }),
  );

  // ── Place ────────────────────────────────────────────────────────────

  it.effect("places a card where its thread spawned, and only a move moves a worktree", () =>
    Effect.gen(function* () {
      const placed = yield* cardAfter(place(workerA), makeReadModel({ cards: [makeCard()] }));
      expect(placed.placedWorkerId).toBe(workerA);

      const bound = makeReadModel({
        cards: [makeCard({ placedWorkerId: workerA, worktree: readyWorktree })],
      });
      const failure = yield* decideFail(place(workerB), bound);
      expect(String(failure)).toContain("only a move");
      expect(yield* decideEvents(place(workerA), bound)).toEqual([]);
    }),
  );

  // ── Move ─────────────────────────────────────────────────────────────

  it.effect("a move runs start → retired → done and lands the card on the new worker", () =>
    Effect.gen(function* () {
      let model = makeReadModel({
        cards: [makeCard({ placedWorkerId: workerA, worktree: readyWorktree })],
        stepStates: [makeStep("succeeded")],
      });
      const steps = [
        moveStep({ phase: "start", toWorkerId: workerB, sha: "4e1a9c2" }),
        moveStep({ phase: "retired" }),
        moveStep({ phase: "done", worktreePath: "/worker-b/worktrees/card-1" }),
      ];
      const seen: Array<BoardCard> = [];
      for (const step of steps) {
        const events = yield* decideEvents(step, model);
        for (const event of events) {
          assert.ok(event.type === "board.card-worker-move-recorded");
          expect(event.payload.move.fromWorkerId).toBe(workerA);
          expect(event.payload.move.toWorkerId).toBe(workerB);
          model = yield* projectBoardEvent(model, { ...event, sequence: 1 } as never);
        }
        seen.push(model.board!.cards[0]!);
      }
      const [started, retired, done] = seen;
      expect(started!.workerMove?.status).toBe("moving");
      expect(started!.workerMove?.sha).toBe("4e1a9c2");
      // Retired: the checkout is gone and the card is unassigned.
      expect(retired!.worktree?.status).toBe("reclaimed");
      expect(retired!.worktree?.path).toBeNull();
      expect(retired!.placedWorkerId).toBeNull();
      // Done: the new worktree, pinned and placed on B, the move cleared.
      expect(done!.worktree?.status).toBe("ready");
      expect(done!.worktree?.path).toBe("/worker-b/worktrees/card-1");
      expect(done!.worktree?.branch).toBe("board/card-1");
      expect(done!.pinnedWorkerId).toBe(workerB);
      expect(done!.placedWorkerId).toBe(workerB);
      expect(done!.workerMove).toBeNull();
    }),
  );

  it.effect("refuses a move while a step is running", () =>
    Effect.gen(function* () {
      for (const status of ["running", "completing"] as const) {
        const failure = yield* decideFail(
          moveStep({ phase: "start", toWorkerId: workerB, sha: null }),
          makeReadModel({
            cards: [makeCard({ placedWorkerId: workerA, worktree: readyWorktree })],
            stepStates: [makeStep(status)],
          }),
        );
        expect(String(failure)).toContain("step running");
      }
      // A parked step is not running: the card may move, and its next turn
      // runs on the new worker.
      const events = yield* decideEvents(
        moveStep({ phase: "start", toWorkerId: workerB, sha: null }),
        makeReadModel({
          cards: [makeCard({ placedWorkerId: workerA, worktree: readyWorktree })],
          stepStates: [makeStep("paused")],
        }),
      );
      expect(events).toHaveLength(1);
    }),
  );

  it.effect("refuses a move with nothing to carry, to where it already is, or twice", () =>
    Effect.gen(function* () {
      const noWorktree = yield* decideFail(
        moveStep({ phase: "start", toWorkerId: workerB, sha: null }),
        makeReadModel({ cards: [makeCard()] }),
      );
      expect(String(noWorktree)).toContain("pin it");

      const sameWorker = yield* decideFail(
        moveStep({ phase: "start", toWorkerId: workerA, sha: null }),
        makeReadModel({ cards: [makeCard({ placedWorkerId: workerA, worktree: readyWorktree })] }),
      );
      expect(String(sameWorker)).toContain("already on worker");

      const moving = makeCard({
        placedWorkerId: workerA,
        worktree: readyWorktree,
        workerMove: {
          fromWorkerId: workerA,
          toWorkerId: workerB,
          status: "moving",
          sha: null,
          error: null,
          startedAt: NOW,
        },
      });
      const twice = yield* decideFail(
        moveStep({ phase: "start", toWorkerId: workerB, sha: null }),
        makeReadModel({ cards: [moving] }),
      );
      expect(String(twice)).toContain("already moving");

      const notMoving = yield* decideFail(
        moveStep({ phase: "retired" }),
        makeReadModel({ cards: [makeCard({ placedWorkerId: workerA, worktree: readyWorktree })] }),
      );
      expect(String(notMoving)).toContain("not moving");
    }),
  );

  it.effect("a failed move keeps the card unassigned, and a retry starts from there", () =>
    Effect.gen(function* () {
      let model = makeReadModel({
        cards: [makeCard({ placedWorkerId: workerA, worktree: readyWorktree })],
      });
      for (const step of [
        moveStep({ phase: "start", toWorkerId: workerB, sha: null }),
        moveStep({ phase: "retired" }),
        moveStep({ phase: "failed", error: "fatal: couldn't find remote ref board/card-1" }),
      ]) {
        for (const event of yield* decideEvents(step, model)) {
          model = yield* projectBoardEvent(model, { ...event, sequence: 1 } as never);
        }
      }
      const failed = model.board!.cards[0]!;
      expect(failed.workerMove?.status).toBe("failed");
      expect(failed.workerMove?.error).toContain("couldn't find remote ref");
      // The retired worktree is not restored.
      expect(failed.worktree?.status).toBe("reclaimed");
      expect(failed.placedWorkerId).toBeNull();

      // Retry (or another worker): no worktree to carry, but the failed move
      // is what lets it start again — and it remembers where the card was.
      const [retry] = yield* decideEvents(
        moveStep({ phase: "start", toWorkerId: BOARD_LOCAL_WORKER_ID, sha: null }),
        model,
      );
      assert.ok(retry!.type === "board.card-worker-move-recorded");
      expect(retry.payload.move.status).toBe("moving");
      expect(retry.payload.move.fromWorkerId).toBe(workerA);
      expect(retry.payload.move.toWorkerId).toBe(BOARD_LOCAL_WORKER_ID);
    }),
  );
});
