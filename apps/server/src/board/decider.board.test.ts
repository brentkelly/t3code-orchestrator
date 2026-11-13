/**
 * Board decider invariants, including that no decider path emits a move into
 * `building` except an explicit `board.card.move` or the pipeline's own move.
 */
import {
  BOARD_SEED_LABEL_IDS,
  BOARD_SEED_LABELS,
  BoardCardAttachmentId,
  BoardCardId,
  BoardStageId,
  type BoardCardSetReviewCarryCommand,
  BoardLabelId,
  boardPlanId,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  EMPTY_BOARD_CARD_REVIEW_OVERRIDES,
  ThreadId,
  BOARD_SEED_STAGE_IDS,
  defaultBoardCardGroup,
  BoardClientCommand,
  EMPTY_BOARD_STATE,
  BOARD_SYSTEM_ACTOR,
  resolveBoardCardForThread,
  type BoardCard,
  type BoardCardStepState,
  type BoardStepCompletion,
  type BoardLabel,
  type BoardPlan,
  type BoardState,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { boardDecidedEvents, type BoardCommand } from "./decider.ts";
import { decideBoardCommandOnModel } from "./decisionContext.testkit.ts";
import type {
  BoardOrchestrationReadModel,
  BoardTestThread as OrchestrationThread,
} from "./decisionContext.testkit.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const decodeClientCommandExit = Schema.decodeUnknownExit(BoardClientCommand);
const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");

function makeCard(
  overrides: Omit<Partial<BoardCard>, "id" | "stage"> & {
    readonly id: string;
    readonly stage?: string;
  },
): BoardCard {
  const { id, stage, ...rest } = overrides;
  return {
    key: "CARD-1",
    cardNumber: 1,
    projectId,
    labels: [],
    orderKey: "m",
    title: "Card",
    briefRef: null,
    dependsOn: [],
    parentCardId: null,
    sourcePlanId: null,
    group: null,
    threadLinks: [],
    attachments: [],
    externalRef: null,
    humanInLoop: null,
    reviewOverrides: null,
    modelOverrides: null,
    splitRationale: null,
    baseBranch: null,
    scheduledStartAt: null,
    autoPlanSetting: null,
    autoBuildSetting: null,
    autoMergeSetting: null,
    autoMergeHold: null,
    mergeStrategy: null,
    priority: "normal",
    pinnedWorkerId: null,
    placedWorkerId: null,
    workerMove: null,
    placementOrphaned: null,
    ci: null,
    ciLastOutcome: null,
    ciRoundTrips: 0,
    worktree: null,
    pullRequest: null,
    pullRequestHistory: [],
    pullRequestFloor: null,
    blocked: false,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...rest,
    stage: BoardStageId.make(stage ?? "backlog"),
    id: BoardCardId.make(id),
  };
}

/** A running step state for a card — the shape the delete payload freezes so
    the reactor can release the concurrency slot after the card is gone. */
function makeStepStateFor(cardId: string): BoardCardStepState {
  return {
    cardId: BoardCardId.make(cardId),
    stepId: "s1",
    stepLabel: "Build",
    stageLabel: "Building",
    attempt: 1,
    stallCount: 0,
    stageEntryRecoveries: 0,
    humanTurnAt: null,
    lastNudgeAt: null,
    baseTipAtRoundStart: null,
    lastError: null,
    awaitingReason: "question" as const,
    stalledReason: "gave-up" as const,
    retryAt: null,
    prompt: "do it",
    providerInstanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
    mode: "build",
    runtimeMode: "auto",
    humanInLoop: false,
    maxAttempts: 3,
    timeoutMs: 1000,
    threadId: ThreadId.make("thread-live"),
    status: "running",
    slotHeld: true,
    forceStart: false,
    queuedBy: null,
    startedAt: NOW,
    updatedAt: NOW,
  };
}

function makeThread(input: {
  readonly id: string;
  readonly deletedAt?: string | null;
}): OrchestrationThread {
  return {
    id: ThreadId.make(input.id),
    projectId,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    deletedAt: input.deletedAt ?? null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

function makeReadModel(input: {
  readonly board?: BoardState;
  readonly threads?: ReadonlyArray<OrchestrationThread>;
}): BoardOrchestrationReadModel {
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
      {
        id: otherProjectId,
        title: "Project 2",
        workspaceRoot: "/tmp/project-2",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads: input.threads ?? [],
    ...(input.board === undefined ? {} : { board: input.board }),
    updatedAt: NOW,
  };
}

/** Every event a command decides. Archive, unarchive and delete decide
    several — the card's own, plus one per affected dependent (a `blocked`
    re-flag for archive/unarchive, an edge rewrite for delete) —
    while every other command decides exactly one. */
const decideEvents = (command: BoardCommand, readModel: BoardOrchestrationReadModel) =>
  decideBoardCommandOnModel({ command, readModel }).pipe(Effect.map(boardDecidedEvents));

/** The first (and, for every command but archive/unarchive/delete, only)
    decided event. */
const decide = (command: BoardCommand, readModel: BoardOrchestrationReadModel) =>
  decideEvents(command, readModel).pipe(Effect.map((events) => events[0]!));

const decideFail = (command: BoardCommand, readModel: BoardOrchestrationReadModel) =>
  Effect.flip(decide(command, readModel));

const createCommand = (input: {
  readonly cardId: string;
  readonly projectId?: typeof projectId;
  readonly keyPrefix?: string;
  readonly stage?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly brief?: string;
  readonly dependsOn?: ReadonlyArray<string>;
  /** An explicit position, as a caller that means one sends. Absent — the
      shape every real caller now sends — leaves the placement to the decider,
      so the default test path is the production path. */
  readonly orderKey?: string;
  readonly parentCardId?: string;
  readonly scheduledStartAt?: string;
}) =>
  ({
    type: "board.card.create",
    commandId: CommandId.make(`cmd-create-${input.cardId}`),
    cardId: BoardCardId.make(input.cardId),
    projectId: input.projectId ?? projectId,
    title: `Card ${input.cardId}`,
    ...(input.orderKey === undefined ? {} : { orderKey: input.orderKey }),
    ...(input.parentCardId === undefined
      ? {}
      : { parentCardId: BoardCardId.make(input.parentCardId) }),
    ...(input.keyPrefix === undefined ? {} : { keyPrefix: input.keyPrefix }),
    ...(input.stage === undefined ? {} : { stage: BoardStageId.make(input.stage) }),
    ...(input.labels === undefined
      ? {}
      : { labels: input.labels.map((id) => BoardLabelId.make(id)) }),
    ...(input.brief === undefined ? {} : { brief: input.brief }),
    ...(input.dependsOn === undefined
      ? {}
      : { dependsOn: input.dependsOn.map((id) => BoardCardId.make(id)) }),
    ...(input.scheduledStartAt === undefined ? {} : { scheduledStartAt: input.scheduledStartAt }),
    createdAt: NOW,
  }) as const;

const labelCreateCommand = (input: {
  readonly labelId: string;
  readonly name: string;
  readonly colour?: string;
}) =>
  ({
    type: "board.label.create",
    commandId: CommandId.make(`cmd-label-create-${input.labelId}`),
    labelId: BoardLabelId.make(input.labelId),
    name: input.name,
    ...(input.colour === undefined ? {} : { colour: input.colour }),
    createdAt: NOW,
  }) as const;

/** A read model whose catalogue is exactly the compiled seeds (labels absent
    on the board slice resolves to them), so label collisions and colour
    assignment are tested against a known catalogue. */
const seededBoard = (cards: ReadonlyArray<BoardCard> = []): BoardState => ({
  cards,
  nextCardNumberByProject: {},
});

const moveCommand = (input: {
  readonly cardId: string;
  readonly toStage: string;
  readonly override?: boolean;
  readonly orderKey?: string;
}) =>
  ({
    type: "board.card.move",
    commandId: CommandId.make(`cmd-move-${input.cardId}`),
    cardId: BoardCardId.make(input.cardId),
    toStage: BoardStageId.make(input.toStage),
    ...(input.override === undefined ? {} : { override: input.override }),
    ...(input.orderKey === undefined ? {} : { orderKey: input.orderKey }),
    createdAt: NOW,
  }) as const;

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("board decider", (it) => {
  // ── Key allocation ───────────────────────────────────────────────────

  it.effect("allocates keys from the per-project counter with the default prefix", () =>
    Effect.gen(function* () {
      const event = yield* decide(
        createCommand({ cardId: "card-1" }),
        makeReadModel({
          board: { cards: [], nextCardNumberByProject: { [projectId]: 7 } },
        }),
      );
      assert.strictEqual(event.type, "board.card-created");
      if (event.type === "board.card-created") {
        assert.strictEqual(event.payload.key, "CARD-7");
        assert.strictEqual(event.payload.cardNumber, 7);
        assert.strictEqual(event.payload.stage, "backlog");
      }
    }),
  );

  it.effect("keeps per-project counters independent under interleaved creates", () =>
    Effect.gen(function* () {
      // Interleave p1, p2, p1: each project counts its own cards, so the
      // second p1 card gets number 2 while p2 is still at 1.
      let board: BoardState = { cards: [], nextCardNumberByProject: {} };
      const keys: string[] = [];
      const steps = [
        { cardId: "card-a", project: projectId },
        { cardId: "card-b", project: otherProjectId },
        { cardId: "card-c", project: projectId },
      ] as const;
      for (const step of steps) {
        const event = yield* decide(
          createCommand({ cardId: step.cardId, projectId: step.project }),
          makeReadModel({ board }),
        );
        assert.strictEqual(event.type, "board.card-created");
        if (event.type !== "board.card-created") return;
        keys.push(event.payload.key);
        // Mirror the projector's counter bump so the next decision sees it.
        board = {
          cards: [
            ...board.cards,
            makeCard({
              id: step.cardId,
              projectId: step.project,
              key: event.payload.key,
              cardNumber: event.payload.cardNumber,
            }),
          ],
          nextCardNumberByProject: {
            ...board.nextCardNumberByProject,
            [step.project]: event.payload.cardNumber + 1,
          },
        };
      }
      assert.deepStrictEqual(keys, ["CARD-1", "CARD-1", "CARD-2"]);
    }),
  );

  it.effect("uses the command's keyPrefix when present", () =>
    Effect.gen(function* () {
      const event = yield* decide(
        createCommand({ cardId: "card-1", keyPrefix: "T3" }),
        makeReadModel({}),
      );
      if (event.type === "board.card-created") {
        assert.strictEqual(event.payload.key, "T3-1");
      }
    }),
  );

  it.effect("T3O-78: create stores an external reference no other live card holds", () =>
    Effect.gen(function* () {
      const ref = { system: "github-issue", id: "org/repo#7", url: "https://x/7" };
      const holder = makeCard({ id: "card-holder", key: "CARD-3", externalRef: ref });
      const event = yield* decide(
        { ...createCommand({ cardId: "card-new" }), externalRef: ref },
        makeReadModel({}),
      );
      assert.deepStrictEqual(
        event.type === "board.card-created" ? event.payload.externalRef : null,
        ref,
      );
      // Board-wide: a holder in another project still takes the reference.
      const elsewhere = { ...holder, projectId: otherProjectId };
      const refused = yield* decideFail(
        { ...createCommand({ cardId: "card-new" }), externalRef: ref },
        makeReadModel({ board: seededBoard([elsewhere]) }),
      );
      assert.include(String(refused.message), "CARD-3");
      // An archived holder does not.
      yield* decide(
        { ...createCommand({ cardId: "card-new" }), externalRef: ref },
        makeReadModel({ board: seededBoard([{ ...holder, archivedAt: NOW }]) }),
      );
      // Update: setting a taken reference is refused; the holder may re-set its own.
      const other = makeCard({ id: "card-other", key: "CARD-4" });
      const update = (cardId: string) =>
        ({
          type: "board.card.update",
          commandId: CommandId.make(`cmd-ref-${cardId}`),
          cardId: BoardCardId.make(cardId),
          externalRef: ref,
          createdAt: NOW,
        }) as const;
      const board = makeReadModel({ board: seededBoard([holder, other]) });
      const taken = yield* decideFail(update("card-other"), board);
      assert.include(String(taken.message), "CARD-3");
      yield* decide(update("card-holder"), board);
      // An unchanged re-send is no new claim, even beside an older live duplicate.
      const twin = makeCard({ id: "card-twin", key: "CARD-5", externalRef: ref });
      yield* decide(update("card-holder"), makeReadModel({ board: seededBoard([holder, twin]) }));
    }),
  );

  // ── Stage moves ──────────────────────────────────────────────────────

  it.effect("allows adjacent moves in both directions without override", () =>
    Effect.gen(function* () {
      const board: BoardState = {
        cards: [makeCard({ id: "card-1", stage: "sprint" })],
        nextCardNumberByProject: { [projectId]: 2 },
      };
      const forward = yield* decide(
        moveCommand({ cardId: "card-1", toStage: "planning" }),
        makeReadModel({ board }),
      );
      assert.strictEqual(forward.type, "board.card-moved");
      const backward = yield* decide(
        moveCommand({ cardId: "card-1", toStage: "backlog" }),
        makeReadModel({ board }),
      );
      assert.strictEqual(backward.type, "board.card-moved");
    }),
  );

  it.effect("rejects a non-adjacent move without override and allows it with one", () =>
    Effect.gen(function* () {
      const board: BoardState = {
        cards: [makeCard({ id: "card-1", stage: "backlog" })],
        nextCardNumberByProject: { [projectId]: 2 },
      };
      const failure = yield* decideFail(
        moveCommand({ cardId: "card-1", toStage: "planning" }),
        makeReadModel({ board }),
      );
      assert.strictEqual(failure._tag, "BoardCommandInvariantError");
      assert.include(String(failure), "not adjacent");

      const dragged = yield* decide(
        moveCommand({ cardId: "card-1", toStage: "review", override: true }),
        makeReadModel({ board }),
      );
      assert.strictEqual(dragged.type, "board.card-moved");
      if (dragged.type === "board.card-moved") {
        assert.strictEqual(dragged.payload.toStage, "review");
      }
    }),
  );

  it.effect("rejects a move into the card's current stage", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        moveCommand({ cardId: "card-1", toStage: "backlog" }),
        makeReadModel({
          board: { cards: [makeCard({ id: "card-1" })], nextCardNumberByProject: {} },
        }),
      );
      assert.include(String(failure), "already in stage");
    }),
  );

  it.effect("lets a sub-board plan card move back into the early stages (T3O-53)", () =>
    Effect.gen(function* () {
      const board: BoardState = {
        cards: [
          makeCard({ id: "card-parent", stage: "building" }),
          makeCard({
            id: "card-child",
            stage: "ready",
            parentCardId: BoardCardId.make("card-parent"),
          }),
        ],
        nextCardNumberByProject: {},
      };
      const back = yield* decide(
        moveCommand({ cardId: "card-child", toStage: "sprint", override: true }),
        makeReadModel({ board }),
      );
      assert.strictEqual(back.type, "board.card-moved");

      const allowed = yield* decide(
        moveCommand({ cardId: "card-child", toStage: "building" }),
        makeReadModel({ board }),
      );
      assert.strictEqual(allowed.type, "board.card-moved");
    }),
  );

  // ── Blocked derivation is build-role-keyed, not Ready-keyed ─────

  it.effect("does not block on unmet dependencies before the build role (D11)", () =>
    Effect.gen(function* () {
      const dependency = makeCard({ id: "card-dep", stage: "building" });
      const card = makeCard({
        id: "card-1",
        stage: "sprint",
        dependsOn: [BoardCardId.make("card-dep")],
      });
      const board: BoardState = { cards: [dependency, card], nextCardNumberByProject: {} };

      // sprint -> planning: before the build role, unmet dependencies do not
      // block. Ready is now an ordinary pre-build stage, so the block
      // boundary is the `build`-role stage, not the "Ready" anchor.
      const early = yield* decide(
        moveCommand({ cardId: "card-1", toStage: "planning" }),
        makeReadModel({ board }),
      );
      if (early.type === "board.card-moved") {
        assert.strictEqual(early.payload.card.blocked, false);
      }

      // planning -> ready: still before the build role, so still not blocked.
      const planningBoard: BoardState = {
        cards: [dependency, { ...card, stage: BoardStageId.make("planning") }],
        nextCardNumberByProject: {},
      };
      const atReady = yield* decide(
        moveCommand({ cardId: "card-1", toStage: "ready" }),
        makeReadModel({ board: planningBoard }),
      );
      if (atReady.type === "board.card-moved") {
        assert.strictEqual(atReady.payload.card.blocked, false);
      }
      // Entry into the build role itself with an unmet dependency is refused
      // outright — covered by the "rejects moving a card ... past Ready"
      // test below.
    }),
  );

  it.effect("rejects moving a card with unmet dependencies past Ready, naming them (t3o-05)", () =>
    Effect.gen(function* () {
      const dependency = makeCard({
        id: "card-dep",
        key: "CARD-7",
        title: "Ship the decider",
        stage: "building",
      });
      const card = makeCard({
        id: "card-1",
        key: "CARD-9",
        stage: "ready",
        blocked: true,
        dependsOn: [BoardCardId.make("card-dep")],
      });
      const board: BoardState = { cards: [dependency, card], nextCardNumberByProject: {} };

      const failure = yield* decideFail(
        moveCommand({ cardId: "card-1", toStage: "building" }),
        makeReadModel({ board }),
      );
      assert.strictEqual(failure._tag, "BoardCommandInvariantError");
      assert.include(String(failure), 'CARD-7 "Ship the decider"');

      // A drag's override forces adjacency, never the dependency gate.
      const overridden = yield* decideFail(
        moveCommand({ cardId: "card-1", toStage: "review", override: true }),
        makeReadModel({ board }),
      );
      assert.strictEqual(overridden._tag, "BoardCommandInvariantError");

      // An unknown dependency id counts as unmet and is still named.
      const orphanBoard: BoardState = {
        cards: [{ ...card, dependsOn: [BoardCardId.make("card-gone")] }],
        nextCardNumberByProject: {},
      };
      const orphan = yield* decideFail(
        moveCommand({ cardId: "card-1", toStage: "building" }),
        makeReadModel({ board: orphanBoard }),
      );
      assert.include(String(orphan), "card-gone");

      // With the dependency done, the same move lands.
      const doneBoard: BoardState = {
        cards: [{ ...dependency, stage: BoardStageId.make("done") }, card],
        nextCardNumberByProject: {},
      };
      const allowed = yield* decide(
        moveCommand({ cardId: "card-1", toStage: "building" }),
        makeReadModel({ board: doneBoard }),
      );
      assert.strictEqual(allowed.type, "board.card-moved");

      // Moving backwards out of the gated zone stays open regardless.
      const backward = yield* decide(
        moveCommand({ cardId: "card-1", toStage: "planning" }),
        makeReadModel({ board }),
      );
      assert.strictEqual(backward.type, "board.card-moved");

      // The gate guards the Ready crossing only: a card already past Ready
      // whose dependencies became unmet mid-flight (edited, or a dependency
      // reopened) still moves freely WITHIN the past-Ready zone — e.g.
      // dragged backwards from review to building.
      const inFlightBoard: BoardState = {
        cards: [dependency, { ...card, stage: BoardStageId.make("review") }],
        nextCardNumberByProject: {},
      };
      const withinZone = yield* decide(
        moveCommand({ cardId: "card-1", toStage: "building" }),
        makeReadModel({ board: inFlightBoard }),
      );
      assert.strictEqual(withinZone.type, "board.card-moved");
      if (withinZone.type === "board.card-moved") {
        // Still blocked — the flag keeps reporting the unmet dependency.
        assert.strictEqual(withinZone.payload.card.blocked, true);
      }
    }),
  );

  it.effect("rejects an on-demand thread for a blocked card from the build role on (D11)", () =>
    Effect.gen(function* () {
      const dependency = makeCard({
        id: "card-dep",
        key: "CARD-7",
        title: "Ship the decider",
        stage: "building",
      });
      const blockedIn = (stage: string): BoardState => ({
        cards: [
          dependency,
          makeCard({
            id: "card-1",
            key: "CARD-9",
            stage,
            blocked: true,
            dependsOn: [BoardCardId.make("card-dep")],
          }),
        ],
        nextCardNumberByProject: {},
      });
      const startStageThread: BoardCommand = {
        type: "board.card.start-stage-thread",
        commandId: CommandId.make("cmd-start-stage-thread"),
        cardId: BoardCardId.make("card-1"),
        createdAt: NOW,
      };

      const failure = yield* decideFail(
        startStageThread,
        makeReadModel({ board: blockedIn("building") }),
      );
      assert.strictEqual(failure._tag, "BoardCommandInvariantError");
      assert.include(String(failure), 'CARD-7 "Ship the decider"');

      // Before the build role unmet dependencies block nothing, so a planning
      // restart still lands; and the merge role is exempt, because the
      // supervisor's conflict fix for a merge a human initiated rides this
      // command.
      for (const stage of ["planning", "merge"]) {
        const allowed = yield* decide(startStageThread, makeReadModel({ board: blockedIn(stage) }));
        assert.strictEqual(allowed.type, "board.card-stage-thread-requested");
      }
    }),
  );

  // ── Dependency cycles ────────────────────────────────────────────────

  // ── Per-card review-loop overrides ───────────────────
  //
  // The floor is the whole point: the pane's `−` is disabled below it, but the
  // client is not the guard. A stale pane must not be able to drop the budget
  // under a round that is already running and strand it beyond the cap.

  const reviewCardBoard = (input: {
    readonly overrides?: BoardCard["reviewOverrides"];
    readonly completedRounds?: number;
    readonly liveStepId?: string;
  }): BoardOrchestrationReadModel =>
    makeReadModel({
      board: {
        cards: [
          {
            ...makeCard({ id: "card-a" }),
            stage: BOARD_SEED_STAGE_IDS.review,
            reviewOverrides: input.overrides ?? null,
          },
        ],
        nextCardNumberByProject: {},
        stepCompletions: Array.from({ length: input.completedRounds ?? 0 }, (_, index) => ({
          cardId: BoardCardId.make("card-a"),
          stepId: `review@${index + 1}`,
          outcome: "succeeded" as const,
          summary: "reviewed",
          payload: null,
          threadId: null,
          completedAt: NOW,
        })),
        ...(input.liveStepId === undefined
          ? {}
          : {
              stepStates: [
                {
                  cardId: BoardCardId.make("card-a"),
                  stepId: input.liveStepId,
                  stepLabel: "Review",
                  stageLabel: "Code review",
                  attempt: 1,
                  stallCount: 0,
                  stageEntryRecoveries: 0,
                  humanTurnAt: null,
                  lastNudgeAt: null,
                  baseTipAtRoundStart: null,
                  lastError: null,
                  awaitingReason: "question" as const,
                  stalledReason: "gave-up" as const,
                  retryAt: null,
                  prompt: "review it",
                  providerInstanceId: ProviderInstanceId.make("codex"),
                  model: "gpt-5.4",
                  mode: "build" as const,
                  runtimeMode: "auto" as const,
                  humanInLoop: false,
                  maxAttempts: 3,
                  timeoutMs: 1000,
                  threadId: ThreadId.make("thread-1"),
                  status: "running" as const,
                  slotHeld: true,
                  forceStart: false,
                  queuedBy: null,
                  startedAt: NOW,
                  updatedAt: NOW,
                },
              ],
            }),
      } as BoardState,
    });

  const setRounds = (rounds: number | null) =>
    ({
      type: "board.card.update",
      commandId: CommandId.make("cmd-rounds"),
      cardId: BoardCardId.make("card-a"),
      reviewOverrides: {
        rounds,
        stopAfterRound: null,
        roundModels: {},
        runThroughRound: null,
        carriedFindings: {},
        stuckWaivedThrough: null,
        roundModes: {},
      },
      createdAt: NOW,
    }) satisfies BoardCommand;

  it.effect("t3o-22 D3: accepts a budget at or above the rounds already run", () =>
    Effect.gen(function* () {
      const event = yield* decide(setRounds(4), reviewCardBoard({ completedRounds: 2 }));
      assert.strictEqual(event.type, "board.card-updated");
      if (event.type !== "board.card-updated") return;
      assert.strictEqual(event.payload.card.reviewOverrides?.rounds, 4);
    }),
  );

  it.effect("t3o-22 D3: rejects a budget below a round already RUN", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(setRounds(1), reviewCardBoard({ completedRounds: 3 }));
      assert.strictEqual(failure._tag, "BoardCommandInvariantError");
      assert.include(String(failure), "round 3 has already started");
    }),
  );

  it.effect("t3o-22 D3: rejects a budget below a round still IN FLIGHT", () =>
    Effect.gen(function* () {
      // Round 3's review is running and has recorded NOTHING. Flooring on
      // completions alone would accept this and orphan the live agent.
      const failure = yield* decideFail(
        setRounds(2),
        reviewCardBoard({ completedRounds: 2, liveStepId: "review@3" }),
      );
      assert.include(String(failure), "round 3 has already started");
    }),
  );

  it.effect("T3O-39 D4: accepts a budget past the old ten-round ceiling", () =>
    Effect.gen(function* () {
      // The ceiling is gone. A budget is a number a human typed into the
      // stepper and can see; refusing it bought nothing.
      const event = yield* decide(setRounds(42), reviewCardBoard({}));
      assert.strictEqual(event.type, "board.card-updated");
      if (event.type !== "board.card-updated") return;
      assert.strictEqual(event.payload.card.reviewOverrides?.rounds, 42);
    }),
  );

  // ── The server-only carry fields and the Advance waiver ──────

  const stuckStep = (stepId: string, payload: unknown) => ({
    cardId: BoardCardId.make("card-a"),
    stepId,
    outcome: "succeeded" as const,
    summary: stepId,
    payload: JSON.stringify(payload),
    threadId: null,
    completedAt: NOW,
  });
  const stuckLedger = [
    stuckStep("review@1", {
      reviewedSha: "s",
      findings: [{ id: "f1", severity: "critical", title: "Broken" }],
    }),
    stuckStep("triage@1", {
      fixedSha: "s",
      dispositions: [{ findingId: "f1", action: "rejected", note: "no" }],
    }),
    stuckStep("adjudicate@1", {
      verdicts: [{ findingId: "f1", verdict: "rejection-unjustified", note: "yes" }],
      anotherRound: true,
    }),
    stuckStep("retriage@1", {
      fixedSha: "s",
      dispositions: [{ findingId: "f1", action: "escalated", note: "human please" }],
    }),
  ];
  const stuckCardBoard = (
    input: {
      readonly overrides?: BoardCard["reviewOverrides"];
      readonly stage?: string;
    } = {},
  ): BoardOrchestrationReadModel =>
    makeReadModel({
      board: {
        cards: [
          {
            ...makeCard({ id: "card-a" }),
            stage: BoardStageId.make(input.stage ?? BOARD_SEED_STAGE_IDS.review),
            reviewOverrides: input.overrides ?? null,
          },
        ],
        nextCardNumberByProject: {},
        stepCompletions: stuckLedger,
      } as BoardState,
    });
  const carryEntry = {
    ruling: "fix" as const,
    note: null,
    findings: [
      {
        findingId: "carried:r1:f1",
        origRound: 1,
        severity: "critical" as const,
        title: "Broken",
        file: null,
        line: null,
        detail: "",
        rulingNote: "yes",
      },
    ],
  };
  const setCarry = (patch: Partial<BoardCardSetReviewCarryCommand>) =>
    ({
      type: "board.card.set-review-carry",
      commandId: CommandId.make("cmd-carry"),
      cardId: BoardCardId.make("card-a"),
      createdAt: NOW,
      ...patch,
    }) satisfies BoardCommand;

  it.effect(
    "T3O-51: set-review-carry waives, carries and opens the round in one card-updated",
    () =>
      Effect.gen(function* () {
        const event = yield* decide(
          setCarry({
            runThroughRound: 2,
            clearStopAfterRound: true,
            stuckWaivedThrough: 1,
            carry: { round: 2, entry: carryEntry },
          }),
          stuckCardBoard({
            overrides: {
              rounds: null,
              stopAfterRound: 1,
              roundModels: {},
              runThroughRound: null,
              carriedFindings: {},
              stuckWaivedThrough: null,
              roundModes: {},
            },
          }),
        );
        assert.strictEqual(event.type, "board.card-updated");
        if (event.type !== "board.card-updated") return;
        const overrides = event.payload.card.reviewOverrides;
        assert.strictEqual(overrides?.stuckWaivedThrough, 1);
        assert.strictEqual(overrides?.runThroughRound, 2);
        assert.strictEqual(overrides?.stopAfterRound, null);
        assert.deepStrictEqual(overrides?.carriedFindings["2"], carryEntry);
        // The summary rides the event so the card face leaves Stuck at once.
        assert.strictEqual(event.payload.reviewSummary?.outcome, "running");
      }),
  );

  it.effect("T3O-51: set-review-carry leaves a stop alone unless told to clear it", () =>
    Effect.gen(function* () {
      const event = yield* decide(
        setCarry({ stuckWaivedThrough: 1 }),
        stuckCardBoard({
          overrides: {
            rounds: null,
            stopAfterRound: 1,
            roundModels: {},
            runThroughRound: null,
            carriedFindings: {},
            stuckWaivedThrough: null,
            roundModes: {},
          },
        }),
      );
      if (event.type !== "board.card-updated") throw new Error("expected card-updated");
      assert.strictEqual(event.payload.card.reviewOverrides?.stopAfterRound, 1);
    }),
  );

  it.effect(
    "T3O-51: set-review-carry clamps, keeps the carry write-once and the waiver monotone",
    () =>
      Effect.gen(function* () {
        assert.include(
          String(yield* decideFail(setCarry({ runThroughRound: 3 }), stuckCardBoard())),
          "only round 2 can be requested next",
        );
        assert.include(
          String(yield* decideFail(setCarry({ stuckWaivedThrough: 2 }), stuckCardBoard())),
          "only 1 round(s) have started",
        );
        assert.include(
          String(
            yield* decideFail(
              setCarry({ carry: { round: 1, entry: carryEntry } }),
              stuckCardBoard(),
            ),
          ),
          "it has already started",
        );
        const carried = {
          rounds: null,
          stopAfterRound: null,
          roundModels: {},
          runThroughRound: 2,
          carriedFindings: { "2": carryEntry },
          stuckWaivedThrough: 1,
          roundModes: {},
        };
        assert.include(
          String(
            yield* decideFail(
              setCarry({ carry: { round: 2, entry: { ...carryEntry, ruling: "dismiss" } } }),
              stuckCardBoard({ overrides: carried }),
            ),
          ),
          "already carries a ruling",
        );
        // A lower waiver never lowers the stored one.
        const event = yield* decide(
          setCarry({ stuckWaivedThrough: 1 }),
          stuckCardBoard({ overrides: { ...carried, stuckWaivedThrough: 1 } }),
        );
        if (event.type !== "board.card-updated") throw new Error("expected card-updated");
        assert.strictEqual(event.payload.card.reviewOverrides?.stuckWaivedThrough, 1);
      }),
  );

  it.effect("T3O-51: a client update never changes the carry fields, even clearing overrides", () =>
    Effect.gen(function* () {
      const stored = {
        rounds: 4,
        stopAfterRound: null,
        roundModels: {},
        runThroughRound: 2,
        carriedFindings: { "2": carryEntry },
        stuckWaivedThrough: 1,
        roundModes: { "2": { kind: "settling" as const, sinceSha: "s" } },
      };
      for (const reviewOverrides of [
        null,
        { ...stored, rounds: 5, carriedFindings: {}, stuckWaivedThrough: null },
      ]) {
        const event = yield* decide(
          {
            type: "board.card.update",
            commandId: CommandId.make("cmd-client"),
            cardId: BoardCardId.make("card-a"),
            reviewOverrides,
            createdAt: NOW,
          },
          stuckCardBoard({ overrides: stored }),
        );
        if (event.type !== "board.card-updated") throw new Error("expected card-updated");
        assert.deepStrictEqual(event.payload.card.reviewOverrides?.carriedFindings, {
          "2": carryEntry,
        });
        assert.strictEqual(event.payload.card.reviewOverrides?.stuckWaivedThrough, 1);
        assert.deepStrictEqual(event.payload.card.reviewOverrides?.roundModes, {
          "2": { kind: "settling", sinceSha: "s" },
        });
      }
    }),
  );

  const moveTo = (toStage: string, cause?: "human" | "auto-build") =>
    ({
      type: "board.card.move",
      commandId: CommandId.make("cmd-move"),
      cardId: BoardCardId.make("card-a"),
      toStage: BoardStageId.make(toStage),
      override: true,
      ...(cause === undefined ? {} : { cause }),
      createdAt: NOW,
    }) satisfies BoardCommand;

  // ── Settling round modes (T3O-64) ──────

  const settling = (sinceSha: string) => ({ kind: "settling" as const, sinceSha });
  const modesBoard = (
    roundModes: Record<string, { kind: "settling"; sinceSha: string } | { kind: "full" }>,
    stepCompletions: ReadonlyArray<BoardStepCompletion>,
  ): BoardOrchestrationReadModel =>
    makeReadModel({
      board: {
        cards: [
          {
            ...makeCard({ id: "card-a" }),
            stage: BoardStageId.make(BOARD_SEED_STAGE_IDS.review),
            reviewOverrides: {
              ...EMPTY_BOARD_CARD_REVIEW_OVERRIDES,
              roundModes,
            },
          },
        ],
        nextCardNumberByProject: {},
        stepCompletions,
      } as BoardState,
    });
  const cleanReview = (round: number) =>
    stuckStep(`review@${round}`, { reviewedSha: `sha-${round}`, findings: [] });
  const selectReview = (round: number, mode?: { kind: "settling"; sinceSha: string }) =>
    ({
      type: "board.card.select-step",
      commandId: CommandId.make(`cmd-select-${round}`),
      cardId: BoardCardId.make("card-a"),
      stepId: `review@${round}`,
      stepLabel: `Review · round ${round}`,
      stageLabel: "Code review",
      prompt: "review it",
      providerInstanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
      runtimeMode: "auto",
      mode: "build",
      humanInLoop: false,
      maxAttempts: 3,
      timeoutMs: 600_000,
      baseTipAtRoundStart: null,
      ...(mode === undefined ? {} : { reviewRoundMode: { round, mode } }),
      createdAt: NOW,
    }) satisfies BoardCommand;

  it.effect("T3O-64: select-step records a settling round in the same decision", () =>
    Effect.gen(function* () {
      const events = yield* decideEvents(
        selectReview(2, settling("sha-1")),
        modesBoard({}, [cleanReview(1)]),
      );
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["board.card-step-selected", "board.card-updated"],
      );
      const updated = events[1]!;
      if (updated.type !== "board.card-updated") throw new Error("expected card-updated");
      assert.deepStrictEqual(updated.payload.card.reviewOverrides?.roundModes, {
        "2": settling("sha-1"),
      });
      // The summary is recomputed from the new overrides, as set-review-carry does.
      assert.isDefined(updated.payload.reviewSummary);
    }),
  );

  it.effect("T3O-64: select-step never overwrites a recorded mode, and full records nothing", () =>
    Effect.gen(function* () {
      // A full-round request landed after the settling plan was composed: its prompt is stale.
      const stale = yield* decideFail(
        selectReview(2, settling("sha-new")),
        modesBoard({ "2": { kind: "full" } }, [cleanReview(1)]),
      );
      assert.strictEqual(stale._tag, "BoardCommandInvariantError");
      assert.include(String(stale), "already recorded as a full round");
      const recorded = yield* decideEvents(
        selectReview(2, settling("sha-1")),
        modesBoard({ "2": settling("sha-1") }, [cleanReview(1)]),
      );
      assert.deepStrictEqual(
        recorded.map((event) => event.type),
        ["board.card-step-selected"],
      );
      const full = yield* decideEvents(selectReview(2), modesBoard({}, [cleanReview(1)]));
      assert.deepStrictEqual(
        full.map((event) => event.type),
        ["board.card-step-selected"],
      );
    }),
  );

  it.effect(
    "T3O-64: forceFullRound writes full from the first unreviewed round through the request",
    () =>
      Effect.gen(function* () {
        // Round 2's review failed under a settling record, round 1 settled earlier.
        const event = yield* decide(
          setCarry({ runThroughRound: 2, clearStopAfterRound: true, forceFullRound: true }),
          modesBoard({ "1": settling("sha-0"), "2": settling("sha-1") }, [
            cleanReview(1),
            { ...stuckStep("review@2", { reviewedSha: "x", findings: [] }), outcome: "failed" },
          ]),
        );
        if (event.type !== "board.card-updated") throw new Error("expected card-updated");
        assert.deepStrictEqual(event.payload.card.reviewOverrides?.roundModes, {
          "1": settling("sha-0"),
          "2": { kind: "full" },
        });
        // Alone it is a change, not a no-op the guard refuses.
        const alone = yield* decide(
          setCarry({ forceFullRound: true }),
          modesBoard({}, [cleanReview(1)]),
        );
        if (alone.type !== "board.card-updated") throw new Error("expected card-updated");
        // No round was requested, so nothing is forced.
        assert.deepStrictEqual(alone.payload.card.reviewOverrides?.roundModes ?? {}, {});
      }),
  );

  it.effect("T3O-64: a carry or a plain round request without the flag writes no mode", () =>
    Effect.gen(function* () {
      const event = yield* decide(
        setCarry({ runThroughRound: 2, clearStopAfterRound: true }),
        modesBoard({ "1": settling("sha-0") }, [cleanReview(1)]),
      );
      if (event.type !== "board.card-updated") throw new Error("expected card-updated");
      assert.deepStrictEqual(event.payload.card.reviewOverrides?.roundModes, {
        "1": settling("sha-0"),
      });
    }),
  );

  it.effect("T3O-51: a human Advance writes the waiver in the move itself", () =>
    Effect.gen(function* () {
      const event = yield* decide(moveTo(BOARD_SEED_STAGE_IDS.merge, "human"), stuckCardBoard());
      assert.strictEqual(event.type, "board.card-moved");
      if (event.type !== "board.card-moved") return;
      assert.strictEqual(event.payload.card.reviewOverrides?.stuckWaivedThrough, 1);
      assert.strictEqual(event.payload.reviewSummary?.outcome, "advanced");
      assert.strictEqual(event.payload.reviewSummary?.advancedRound, 1);
    }),
  );

  it.effect("T3O-51: any other forward mover of a stuck card is refused; backward is free", () =>
    Effect.gen(function* () {
      assert.include(
        String(yield* decideFail(moveTo(BOARD_SEED_STAGE_IDS.merge), stuckCardBoard())),
        "Review is stuck",
      );
      const back = yield* decide(moveTo(BOARD_SEED_STAGE_IDS.building), stuckCardBoard());
      if (back.type !== "board.card-moved") throw new Error("expected card-moved");
      assert.strictEqual(back.payload.card.reviewOverrides, null);
      assert.strictEqual(back.payload.reviewSummary, undefined);
    }),
  );

  const requestRound = (runThroughRound: number | null) =>
    ({
      type: "board.card.update",
      commandId: CommandId.make("cmd-request-round"),
      cardId: BoardCardId.make("card-a"),
      reviewOverrides: {
        rounds: null,
        stopAfterRound: null,
        roundModels: {},
        runThroughRound,
        carriedFindings: {},
        stuckWaivedThrough: null,
        roundModes: {},
      },
      createdAt: NOW,
    }) satisfies BoardCommand;

  it.effect("T3O-39 D5: accepts a request for the round after the last one started", () =>
    Effect.gen(function* () {
      const event = yield* decide(requestRound(3), reviewCardBoard({ completedRounds: 2 }));
      assert.strictEqual(event.type, "board.card-updated");
      if (event.type !== "board.card-updated") return;
      assert.strictEqual(event.payload.card.reviewOverrides?.runThroughRound, 3);
    }),
  );

  it.effect("T3O-39 D5: rejects a request booked more than one round ahead", () =>
    Effect.gen(function* () {
      // This clamp is what makes having no ceiling safe: without it one click
      // would book rounds nobody asked for.
      const failure = yield* decideFail(requestRound(9), reviewCardBoard({ completedRounds: 2 }));
      assert.strictEqual(failure._tag, "BoardCommandInvariantError");
      assert.include(String(failure), "only round 3 can be requested next");
    }),
  );

  it.effect("T3O-39 D5: counts a round still IN FLIGHT when clamping", () =>
    Effect.gen(function* () {
      const event = yield* decide(
        requestRound(4),
        reviewCardBoard({ completedRounds: 2, liveStepId: "review@3" }),
      );
      assert.strictEqual(event.type, "board.card-updated");
      if (event.type !== "board.card-updated") return;
      assert.strictEqual(event.payload.card.reviewOverrides?.runThroughRound, 4);
    }),
  );

  it.effect("T3O-39 D5: asking for another round clears a pending stop", () =>
    Effect.gen(function* () {
      // The stop and the request are the same person's decisions; the request
      // is the later one, so the executor must not terminate on the stop again.
      const event = yield* decide(
        {
          type: "board.card.update",
          commandId: CommandId.make("cmd-request-over-stop"),
          cardId: BoardCardId.make("card-a"),
          reviewOverrides: {
            rounds: null,
            stopAfterRound: 2,
            roundModels: {},
            runThroughRound: 3,
            carriedFindings: {},
            stuckWaivedThrough: null,
            roundModes: {},
          },
          createdAt: NOW,
        },
        reviewCardBoard({
          completedRounds: 2,
          overrides: {
            rounds: null,
            stopAfterRound: 2,
            roundModels: {},
            runThroughRound: null,
            carriedFindings: {},
            stuckWaivedThrough: null,
            roundModes: {},
          },
        }),
      );
      assert.strictEqual(event.type, "board.card-updated");
      if (event.type !== "board.card-updated") return;
      assert.strictEqual(event.payload.card.reviewOverrides?.stopAfterRound, null);
      assert.strictEqual(event.payload.card.reviewOverrides?.runThroughRound, 3);
    }),
  );

  it.effect("t3o-22 D5: raising the budget clears a pending stop", () =>
    Effect.gen(function* () {
      // "Run round 3" while a stop is pending at round 2 — the later intent
      // wins, or the executor would keep terminating at 2 and the bought
      // rounds could never run.
      const event = yield* decide(
        {
          type: "board.card.update",
          commandId: CommandId.make("cmd-extend"),
          cardId: BoardCardId.make("card-a"),
          reviewOverrides: {
            rounds: 3,
            stopAfterRound: 2,
            roundModels: {},
            runThroughRound: null,
            carriedFindings: {},
            stuckWaivedThrough: null,
            roundModes: {},
          },
          createdAt: NOW,
        },
        reviewCardBoard({
          overrides: {
            rounds: 2,
            stopAfterRound: 2,
            roundModels: {},
            runThroughRound: null,
            carriedFindings: {},
            stuckWaivedThrough: null,
            roundModes: {},
          },
        }),
      );
      assert.strictEqual(event.type, "board.card-updated");
      if (event.type !== "board.card-updated") return;
      assert.strictEqual(event.payload.card.reviewOverrides?.stopAfterRound, null);
      assert.strictEqual(event.payload.card.reviewOverrides?.rounds, 3);
    }),
  );

  // ── Per-card model overrides ────────────────────────────

  const setModelOverrides = (modelOverrides: BoardCard["modelOverrides"]) =>
    ({
      type: "board.card.update",
      commandId: CommandId.make("cmd-models"),
      cardId: BoardCardId.make("card-a"),
      modelOverrides,
      createdAt: NOW,
    }) satisfies BoardCommand;

  const opusOverride = {
    instanceId: ProviderInstanceId.make("anthropic"),
    model: "claude-opus-5",
  };

  it.effect("t3o-29: accepts an override keyed by a stage the board has", () =>
    Effect.gen(function* () {
      const event = yield* decide(
        setModelOverrides({ [BOARD_SEED_STAGE_IDS.building]: opusOverride }),
        reviewCardBoard({}),
      );
      assert.strictEqual(event.type, "board.card-updated");
      if (event.type !== "board.card-updated") return;
      assert.deepStrictEqual(event.payload.card.modelOverrides, {
        [BOARD_SEED_STAGE_IDS.building]: opusOverride,
      });
      // The marker that lets Change model restart a provider stall.
      assert.strictEqual(event.payload.modelOverridesEdited, true);
    }),
  );

  it.effect("t3o-29 AC7: rejects an override naming a stage the board does not have", () =>
    Effect.gen(function* () {
      // A stale popover, held open while the pipeline was edited elsewhere,
      // would otherwise write an entry no resolver could ever read — the user
      // sets a model and watches the card run on a different one, with nothing
      // saying why.
      const failure = yield* decideFail(
        setModelOverrides({ [BoardStageId.make("stage-that-was-deleted")]: opusOverride }),
        reviewCardBoard({}),
      );
      assert.strictEqual(failure._tag, "BoardCommandInvariantError");
      assert.include(String(failure), "does not exist on this board");
    }),
  );

  it.effect("t3o-29: normalises an emptied map to null, matching a never-set card", () =>
    Effect.gen(function* () {
      // "Cleared" and "never set" must be indistinguishable in the read model,
      // or a replayed card stops matching a rehydrated one (the column is NULL).
      const event = yield* decide(setModelOverrides({}), reviewCardBoard({ overrides: null }));
      assert.strictEqual(event.type, "board.card-updated");
      if (event.type !== "board.card-updated") return;
      assert.strictEqual(event.payload.card.modelOverrides, null);
    }),
  );

  it.effect("t3o-22 D5: resuming past a stop clears it even when the budget shrinks", () =>
    Effect.gen(function* () {
      // The pane's resume names an ABSOLUTE round, so a card whose budget was
      // raised to 8 and then stopped at 2 sends `rounds: 3` — smaller than 8.
      // Measuring "a raise" against the previous override left the stop in
      // place, the executor terminated on it again, and the button was inert.
      const event = yield* decide(
        {
          type: "board.card.update",
          commandId: CommandId.make("cmd-resume"),
          cardId: BoardCardId.make("card-a"),
          reviewOverrides: {
            rounds: 3,
            stopAfterRound: 2,
            roundModels: {},
            runThroughRound: null,
            carriedFindings: {},
            stuckWaivedThrough: null,
            roundModes: {},
          },
          createdAt: NOW,
        },
        reviewCardBoard({
          overrides: {
            rounds: 8,
            stopAfterRound: 2,
            roundModels: {},
            runThroughRound: null,
            carriedFindings: {},
            stuckWaivedThrough: null,
            roundModes: {},
          },
          completedRounds: 2,
        }),
      );
      assert.strictEqual(event.type, "board.card-updated");
      if (event.type !== "board.card-updated") return;
      // Asking to reach round 3 is asking to run past a stop at round 2.
      assert.strictEqual(event.payload.card.reviewOverrides?.stopAfterRound, null);
    }),
  );

  it.effect("t3o-22 D5: setting a stop without raising the budget keeps it", () =>
    Effect.gen(function* () {
      const event = yield* decide(
        {
          type: "board.card.update",
          commandId: CommandId.make("cmd-stop"),
          cardId: BoardCardId.make("card-a"),
          reviewOverrides: {
            rounds: null,
            stopAfterRound: 2,
            roundModels: {},
            runThroughRound: null,
            carriedFindings: {},
            stuckWaivedThrough: null,
            roundModes: {},
          },
          createdAt: NOW,
        },
        reviewCardBoard({ completedRounds: 2 }),
      );
      assert.strictEqual(event.type, "board.card-updated");
      if (event.type !== "board.card-updated") return;
      assert.strictEqual(event.payload.card.reviewOverrides?.stopAfterRound, 2);
    }),
  );

  it.effect(
    "t3o-22 D7: a review-override edit folds the summary onto the event for a live card face",
    () =>
      Effect.gen(function* () {
        // The one summary-changing path that used to emit no live delta: a pure
        // override edit refreshed the SQL cache but the `card-upserted` shell
        // delta could not see the ledger, so the card face waited for the next
        // step completion. The decider now folds the summary onto the event.
        const event = yield* decide(
          setRounds(3),
          reviewCardBoard({
            completedRounds: 2,
            overrides: {
              rounds: 5,
              stopAfterRound: null,
              roundModels: {},
              runThroughRound: null,
              carriedFindings: {},
              stuckWaivedThrough: null,
              roundModes: {},
            },
          }),
        );
        assert.strictEqual(event.type, "board.card-updated");
        if (event.type !== "board.card-updated") return;
        // There is review history to summarise, and the new budget rides the
        // event so the card face can render the real total live.
        assert.strictEqual(event.payload.reviewSummary?.roundMax, 3);
      }),
  );

  it.effect("t3o-22 D7: an override edit on a card with no review history carries no summary", () =>
    Effect.gen(function* () {
      // Nothing to summarise — the fold yields null and the key is omitted, so
      // the delta stays exactly the size it was.
      const event = yield* decide(setRounds(3), reviewCardBoard({}));
      assert.strictEqual(event.type, "board.card-updated");
      if (event.type !== "board.card-updated") return;
      assert.strictEqual(event.payload.reviewSummary, undefined);
    }),
  );

  it.effect("t3o-22 D2: an all-empty override set stores as null", () =>
    Effect.gen(function* () {
      const event = yield* decide(setRounds(null), reviewCardBoard({}));
      assert.strictEqual(event.type, "board.card-updated");
      if (event.type !== "board.card-updated") return;
      assert.strictEqual(event.payload.card.reviewOverrides, null);
    }),
  );

  it.effect("rejects a self-edge naming the offending edge", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        {
          type: "board.card.update",
          commandId: CommandId.make("cmd-update"),
          cardId: BoardCardId.make("card-a"),
          dependsOn: [BoardCardId.make("card-a")],
          createdAt: NOW,
        },
        makeReadModel({
          board: { cards: [makeCard({ id: "card-a" })], nextCardNumberByProject: {} },
        }),
      );
      assert.strictEqual(failure._tag, "BoardCommandInvariantError");
      assert.include(String(failure), "card-a -> card-a");
      assert.include(String(failure), "cycle");
    }),
  );

  it.effect("rejects a three-node cycle naming the closing edge", () =>
    Effect.gen(function* () {
      // a -> b -> c exists; adding c -> a closes the loop.
      const board: BoardState = {
        cards: [
          makeCard({ id: "card-a", dependsOn: [BoardCardId.make("card-b")] }),
          makeCard({ id: "card-b", dependsOn: [BoardCardId.make("card-c")] }),
          makeCard({ id: "card-c" }),
        ],
        nextCardNumberByProject: {},
      };
      const failure = yield* decideFail(
        {
          type: "board.card.update",
          commandId: CommandId.make("cmd-update"),
          cardId: BoardCardId.make("card-c"),
          dependsOn: [BoardCardId.make("card-a")],
          createdAt: NOW,
        },
        makeReadModel({ board }),
      );
      assert.include(String(failure), "card-c -> card-a");
      assert.include(String(failure), "card-c -> card-a -> card-b -> card-c");
    }),
  );

  it.effect("rejects a dependency on a card that does not exist", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        {
          type: "board.card.update",
          commandId: CommandId.make("cmd-update"),
          cardId: BoardCardId.make("card-a"),
          dependsOn: [BoardCardId.make("card-ghost")],
          createdAt: NOW,
        },
        makeReadModel({
          board: { cards: [makeCard({ id: "card-a" })], nextCardNumberByProject: {} },
        }),
      );
      assert.include(String(failure), "card-ghost");
    }),
  );

  it.effect("re-derives blocked when a dependency edit lands on a build-or-beyond card (D11)", () =>
    Effect.gen(function* () {
      const board: BoardState = {
        cards: [
          makeCard({ id: "card-dep", stage: "sprint" }),
          makeCard({ id: "card-a", stage: "building" }),
        ],
        nextCardNumberByProject: {},
      };
      const event = yield* decide(
        {
          type: "board.card.update",
          commandId: CommandId.make("cmd-update"),
          cardId: BoardCardId.make("card-a"),
          dependsOn: [BoardCardId.make("card-dep")],
          createdAt: NOW,
        },
        makeReadModel({ board }),
      );
      assert.strictEqual(event.type, "board.card-updated");
      if (event.type === "board.card-updated") {
        assert.strictEqual(event.payload.card.blocked, true);
      }
    }),
  );

  it.effect("rejects an update that carries no changes", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        {
          type: "board.card.update",
          commandId: CommandId.make("cmd-update"),
          cardId: BoardCardId.make("card-a"),
          createdAt: NOW,
        },
        makeReadModel({
          board: { cards: [makeCard({ id: "card-a" })], nextCardNumberByProject: {} },
        }),
      );
      assert.include(String(failure), "no changes");
    }),
  );

  // ── Thread links ─────────────────────────────────────────────────────

  it.effect("attaches a brief file, refuses a duplicate name, and detaches by id (t3o-32)", () =>
    Effect.gen(function* () {
      const attachment = {
        id: BoardCardAttachmentId.make("att-1"),
        name: "bug.png",
        type: "image" as const,
        mimeType: "image/png",
        sizeBytes: 12,
        addedAt: NOW,
      };
      const attached = yield* decide(
        {
          type: "board.card.attach",
          commandId: CommandId.make("cmd-attach"),
          cardId: BoardCardId.make("card-a"),
          attachment,
          createdAt: NOW,
        },
        makeReadModel({
          board: { cards: [makeCard({ id: "card-a" })], nextCardNumberByProject: {} },
        }),
      );
      assert.strictEqual(attached.type, "board.card-attached");
      if (attached.type !== "board.card-attached") return;
      assert.deepStrictEqual(attached.payload.card.attachments, [attachment]);

      // The same name again is refused — the RPC de-duplicates before it
      // gets here, so a collision means two writers raced.
      const duplicate = yield* decideFail(
        {
          type: "board.card.attach",
          commandId: CommandId.make("cmd-attach-2"),
          cardId: BoardCardId.make("card-a"),
          attachment: { ...attachment, id: BoardCardAttachmentId.make("att-2") },
          createdAt: NOW,
        },
        makeReadModel({
          board: { cards: [attached.payload.card], nextCardNumberByProject: {} },
        }),
      );
      assert.include(duplicate.message, "already has an attachment named");

      // One id, one card: the same id on a second card is refused.
      const elsewhere = yield* decideFail(
        {
          type: "board.card.attach",
          commandId: CommandId.make("cmd-attach-3"),
          cardId: BoardCardId.make("card-b"),
          attachment: { ...attachment, name: "other.png" },
          createdAt: NOW,
        },
        makeReadModel({
          board: {
            cards: [attached.payload.card, makeCard({ id: "card-b" })],
            nextCardNumberByProject: {},
          },
        }),
      );
      assert.include(elsewhere.message, "is already on card 'CARD-1'");

      const unknown = yield* decideFail(
        {
          type: "board.card.detach",
          commandId: CommandId.make("cmd-detach-x"),
          cardId: BoardCardId.make("card-a"),
          attachmentId: BoardCardAttachmentId.make("att-nope"),
          createdAt: NOW,
        },
        makeReadModel({
          board: { cards: [attached.payload.card], nextCardNumberByProject: {} },
        }),
      );
      assert.include(unknown.message, "is not on card");

      const detached = yield* decide(
        {
          type: "board.card.detach",
          commandId: CommandId.make("cmd-detach"),
          cardId: BoardCardId.make("card-a"),
          attachmentId: attachment.id,
          createdAt: NOW,
        },
        makeReadModel({
          board: { cards: [attached.payload.card], nextCardNumberByProject: {} },
        }),
      );
      assert.strictEqual(detached.type, "board.card-detached");
      if (detached.type !== "board.card-detached") return;
      assert.deepStrictEqual(detached.payload.attachment, attachment);
      assert.deepStrictEqual(detached.payload.card.attachments, []);
    }),
  );

  it.effect("links a live thread and rejects linking it to a second card", () =>
    Effect.gen(function* () {
      const threads = [makeThread({ id: "thread-1" })];
      const linked = yield* decide(
        {
          type: "board.card.link-thread",
          commandId: CommandId.make("cmd-link"),
          cardId: BoardCardId.make("card-a"),
          threadId: ThreadId.make("thread-1"),
          role: "planning",
          createdAt: NOW,
        },
        makeReadModel({
          threads,
          board: {
            cards: [makeCard({ id: "card-a" }), makeCard({ id: "card-b" })],
            nextCardNumberByProject: {},
          },
        }),
      );
      assert.strictEqual(linked.type, "board.card-thread-linked");
      if (linked.type !== "board.card-thread-linked") return;
      assert.deepStrictEqual(linked.payload.card.threadLinks, [
        {
          threadId: ThreadId.make("thread-1"),
          role: "planning",
          linkedAt: NOW,
          tombstonedAt: null,
          round: 0,
        },
      ]);

      // The link is stamped with the card's round: how many PRs it has retired.
      const secondRound = yield* decide(
        {
          type: "board.card.link-thread",
          commandId: CommandId.make("cmd-link-round"),
          cardId: BoardCardId.make("card-b"),
          threadId: ThreadId.make("thread-1"),
          role: "review@1",
          createdAt: NOW,
        },
        makeReadModel({
          threads,
          board: {
            cards: [
              makeCard({
                id: "card-b",
                pullRequestHistory: [
                  {
                    number: 7,
                    url: "https://github.com/acme/repo/pull/7",
                    state: "merged",
                    title: null,
                    headBranch: "board/card-b",
                    baseRef: "main",
                    checkedAt: NOW,
                  },
                ],
              }),
            ],
            nextCardNumberByProject: {},
          },
        }),
      );
      assert.strictEqual(
        secondRound.type === "board.card-thread-linked"
          ? secondRound.payload.card.threadLinks[0]?.round
          : undefined,
        1,
      );

      // One thread, one card: the same thread on another card is rejected.
      const failure = yield* decideFail(
        {
          type: "board.card.link-thread",
          commandId: CommandId.make("cmd-link-2"),
          cardId: BoardCardId.make("card-b"),
          threadId: ThreadId.make("thread-1"),
          role: "build",
          createdAt: NOW,
        },
        makeReadModel({
          threads,
          board: {
            cards: [linked.payload.card, makeCard({ id: "card-b" })],
            nextCardNumberByProject: {},
          },
        }),
      );
      assert.include(String(failure), "already linked to card 'card-a'");
    }),
  );

  it.effect("rejects linking a deleted thread", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        {
          type: "board.card.link-thread",
          commandId: CommandId.make("cmd-link"),
          cardId: BoardCardId.make("card-a"),
          threadId: ThreadId.make("thread-1"),
          role: "planning",
          createdAt: NOW,
        },
        makeReadModel({
          threads: [makeThread({ id: "thread-1", deletedAt: NOW })],
          board: { cards: [makeCard({ id: "card-a" })], nextCardNumberByProject: {} },
        }),
      );
      assert.include(String(failure), "deleted");
    }),
  );

  it.effect("unlinking a live thread removes the link", () =>
    Effect.gen(function* () {
      const card = makeCard({
        id: "card-a",
        threadLinks: [
          {
            threadId: ThreadId.make("thread-1"),
            role: "planning",
            linkedAt: NOW,
            tombstonedAt: null,
          },
        ],
      });
      const event = yield* decide(
        {
          type: "board.card.unlink-thread",
          commandId: CommandId.make("cmd-unlink"),
          cardId: BoardCardId.make("card-a"),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
        },
        makeReadModel({
          threads: [makeThread({ id: "thread-1" })],
          board: { cards: [card], nextCardNumberByProject: {} },
        }),
      );
      assert.strictEqual(event.type, "board.card-thread-unlinked");
      if (event.type === "board.card-thread-unlinked") {
        assert.strictEqual(event.payload.tombstonedAt, null);
        assert.deepStrictEqual(event.payload.card.threadLinks, []);
      }
    }),
  );

  it.effect("unlinking a deleted thread tombstones the link instead of removing it", () =>
    Effect.gen(function* () {
      const card = makeCard({
        id: "card-a",
        threadLinks: [
          {
            threadId: ThreadId.make("thread-1"),
            role: "review:r1:triage",
            linkedAt: NOW,
            tombstonedAt: null,
          },
        ],
      });
      const later = "2026-01-02T00:00:00.000Z";
      const event = yield* decide(
        {
          type: "board.card.unlink-thread",
          commandId: CommandId.make("cmd-unlink"),
          cardId: BoardCardId.make("card-a"),
          threadId: ThreadId.make("thread-1"),
          createdAt: later,
        },
        makeReadModel({
          threads: [makeThread({ id: "thread-1", deletedAt: later })],
          board: { cards: [card], nextCardNumberByProject: {} },
        }),
      );
      assert.strictEqual(event.type, "board.card-thread-unlinked");
      if (event.type === "board.card-thread-unlinked") {
        assert.strictEqual(event.payload.tombstonedAt, later);
        assert.deepStrictEqual(event.payload.card.threadLinks, [
          {
            threadId: ThreadId.make("thread-1"),
            role: "review:r1:triage",
            linkedAt: NOW,
            tombstonedAt: later,
          },
        ]);
      }
    }),
  );

  // ── Retired links ───────────────────────────────────────────

  const retiredLink = {
    threadId: ThreadId.make("thread-1"),
    role: "merge",
    linkedAt: NOW,
    tombstonedAt: null,
    retiredAt: "2026-01-02T00:00:00.000Z",
  };

  it.effect("retiring a live thread keeps its link, retired", () =>
    Effect.gen(function* () {
      const card = makeCard({
        id: "card-a",
        threadLinks: [{ ...retiredLink, retiredAt: undefined }].map(
          ({ retiredAt: _, ...link }) => link,
        ),
      });
      const later = "2026-01-02T00:00:00.000Z";
      const event = yield* decide(
        {
          type: "board.card.retire-thread",
          commandId: CommandId.make("cmd-retire"),
          cardId: BoardCardId.make("card-a"),
          threadId: ThreadId.make("thread-1"),
          createdAt: later,
        },
        makeReadModel({
          threads: [makeThread({ id: "thread-1" })],
          board: { cards: [card], nextCardNumberByProject: {} },
        }),
      );
      assert.strictEqual(event.type, "board.card-thread-unlinked");
      if (event.type !== "board.card-thread-unlinked") return;
      assert.strictEqual(event.payload.tombstonedAt, null);
      assert.strictEqual(event.payload.retiredAt, later);
      assert.deepStrictEqual(event.payload.card.threadLinks, [retiredLink]);
      // A retired agent can no longer act for the card.
      const board = { ...EMPTY_BOARD_STATE, cards: [event.payload.card] };
      assert.isNull(resolveBoardCardForThread(board, ThreadId.make("thread-1")));
    }),
  );

  it.effect("retiring a deleted thread tombstones it instead", () =>
    Effect.gen(function* () {
      const card = makeCard({
        id: "card-a",
        threadLinks: [
          { threadId: ThreadId.make("thread-1"), role: "merge", linkedAt: NOW, tombstonedAt: null },
        ],
      });
      const event = yield* decide(
        {
          type: "board.card.retire-thread",
          commandId: CommandId.make("cmd-retire"),
          cardId: BoardCardId.make("card-a"),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
        },
        makeReadModel({
          threads: [makeThread({ id: "thread-1", deletedAt: NOW })],
          board: { cards: [card], nextCardNumberByProject: {} },
        }),
      );
      if (event.type !== "board.card-thread-unlinked") return assert.fail(event.type);
      assert.isFalse("retiredAt" in event.payload);
      assert.deepStrictEqual(event.payload.card.threadLinks, [
        { threadId: ThreadId.make("thread-1"), role: "merge", linkedAt: NOW, tombstonedAt: NOW },
      ]);
    }),
  );

  it.effect("a human unlink removes a retired link outright", () =>
    Effect.gen(function* () {
      const event = yield* decide(
        {
          type: "board.card.unlink-thread",
          commandId: CommandId.make("cmd-unlink"),
          cardId: BoardCardId.make("card-a"),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
        },
        makeReadModel({
          threads: [makeThread({ id: "thread-1" })],
          board: {
            cards: [makeCard({ id: "card-a", threadLinks: [retiredLink] })],
            nextCardNumberByProject: {},
          },
        }),
      );
      if (event.type !== "board.card-thread-unlinked") return assert.fail(event.type);
      assert.deepStrictEqual(event.payload.card.threadLinks, []);
    }),
  );

  it.effect("relinking a retired thread on its card un-retires it in place", () =>
    Effect.gen(function* () {
      const later = "2026-01-03T00:00:00.000Z";
      const event = yield* decide(
        {
          type: "board.card.link-thread",
          commandId: CommandId.make("cmd-link"),
          cardId: BoardCardId.make("card-a"),
          threadId: ThreadId.make("thread-1"),
          role: "linked",
          createdAt: later,
        },
        makeReadModel({
          threads: [makeThread({ id: "thread-1" })],
          board: {
            cards: [makeCard({ id: "card-a", threadLinks: [retiredLink] })],
            nextCardNumberByProject: {},
          },
        }),
      );
      if (event.type !== "board.card-thread-linked") return assert.fail(event.type);
      assert.deepStrictEqual(event.payload.card.threadLinks, [
        {
          threadId: ThreadId.make("thread-1"),
          role: "linked",
          linkedAt: later,
          tombstonedAt: null,
          round: 0,
        },
      ]);
    }),
  );

  it.effect("a retired thread still belongs to its card: adopting it elsewhere is refused", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        {
          type: "board.card.link-thread",
          commandId: CommandId.make("cmd-link"),
          cardId: BoardCardId.make("card-b"),
          threadId: ThreadId.make("thread-1"),
          role: "linked",
          createdAt: NOW,
        },
        makeReadModel({
          threads: [makeThread({ id: "thread-1" })],
          board: {
            cards: [
              makeCard({ id: "card-a", threadLinks: [retiredLink] }),
              makeCard({ id: "card-b" }),
            ],
            nextCardNumberByProject: {},
          },
        }),
      );
      assert.include(String(failure), "already linked to card 'card-a'");
    }),
  );

  it.effect("keeps retire-thread out of the commands a client may send", () =>
    Effect.sync(() => {
      const decoded = decodeClientCommandExit({
        type: "board.card.retire-thread",
        commandId: "cmd-retire",
        cardId: "card-a",
        threadId: "thread-1",
        createdAt: NOW,
      });
      assert.isTrue(Exit.isFailure(decoded));
    }),
  );

  // ── Delete ───────────────────────────────────────────────────────────

  it.effect("deletes a card, freezing what the follow-through needs into the payload", () =>
    Effect.gen(function* () {
      const card = makeCard({
        id: "card-a",
        stage: "building",
        threadLinks: [
          {
            threadId: ThreadId.make("thread-live"),
            role: "build",
            linkedAt: NOW,
            tombstonedAt: null,
          },
          // A tombstoned link is still listed: the thread is already gone, so
          // deleting it again is a no-op, and excluding it would mean the
          // reactor's rule had an exception in it.
          {
            threadId: ThreadId.make("thread-dead"),
            role: "plan",
            linkedAt: NOW,
            tombstonedAt: NOW,
          },
        ],
      });
      const stepState: BoardCardStepState = makeStepStateFor("card-a");
      const events = yield* decideEvents(
        {
          type: "board.card.delete",
          commandId: CommandId.make("cmd-delete"),
          cardId: BoardCardId.make("card-a"),
          createdAt: NOW,
        },
        makeReadModel({
          board: { cards: [card], stepStates: [stepState], nextCardNumberByProject: {} },
        }),
      );
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["board.card-deleted"],
      );
      const event = events[0]!;
      if (event.type !== "board.card-deleted") return;
      assert.strictEqual(event.payload.deletedAt, NOW);
      assert.deepStrictEqual(event.payload.card, card);
      assert.deepStrictEqual(event.payload.threadIds, [
        ThreadId.make("thread-live"),
        ThreadId.make("thread-dead"),
      ]);
      // The slot the step holds is in-memory on the server; nothing else could
      // recover it once the step-state row goes with the card.
      assert.deepStrictEqual(event.payload.stepState, stepState);
    }),
  );

  it.effect("deletes an ARCHIVED card — the archive is where 'never coming back' is decided", () =>
    Effect.gen(function* () {
      const archived = makeCard({ id: "card-a", archivedAt: NOW });
      const event = yield* decide(
        {
          type: "board.card.delete",
          commandId: CommandId.make("cmd-delete"),
          cardId: BoardCardId.make("card-a"),
          createdAt: NOW,
        },
        makeReadModel({ board: { cards: [archived], nextCardNumberByProject: {} } }),
      );
      assert.strictEqual(event.type, "board.card-deleted");
    }),
  );

  it.effect("strips the deleted card from every dependent's dependsOn and re-derives blocked", () =>
    Effect.gen(function* () {
      // Deleting `card-a` must drop the edge: an unresolvable id counts as unmet
      // forever, blocking `card-dep` with no card left to unblock it.
      const target = makeCard({ id: "card-a" });
      const dependent = makeCard({
        id: "card-dep",
        stage: "building",
        dependsOn: [BoardCardId.make("card-a"), BoardCardId.make("card-other")],
        blocked: true,
      });
      const other = makeCard({ id: "card-other", stage: BOARD_SEED_STAGE_IDS.done });
      const events = yield* decideEvents(
        {
          type: "board.card.delete",
          commandId: CommandId.make("cmd-delete"),
          cardId: BoardCardId.make("card-a"),
          createdAt: NOW,
        },
        makeReadModel({
          board: { cards: [target, dependent, other], nextCardNumberByProject: {} },
        }),
      );
      // The dependent's rewrite lands BEFORE the removal, so a projector
      // applying the list in order never upserts a card computed against a
      // board it has not caught up with.
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["board.card-updated", "board.card-deleted"],
      );
      const updated = events[0]!;
      if (updated.type !== "board.card-updated") return;
      assert.deepStrictEqual(updated.payload.card.dependsOn, [BoardCardId.make("card-other")]);
      // Its only remaining dependency is done, so it unblocks in the same commit.
      assert.strictEqual(updated.payload.card.blocked, false);
    }),
  );

  it.effect("refuses deleting a card that does not exist", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        {
          type: "board.card.delete",
          commandId: CommandId.make("cmd-delete"),
          cardId: BoardCardId.make("card-missing"),
          createdAt: NOW,
        },
        makeReadModel({ board: { cards: [], nextCardNumberByProject: {} } }),
      );
      assert.include(String(failure), "does not exist");
    }),
  );

  // ── Archive / unarchive ──────────────────────────────────────────────

  it.effect("archives and unarchives, rejecting the redundant direction each time", () =>
    Effect.gen(function* () {
      const live = makeCard({ id: "card-a" });
      const archived = yield* decide(
        {
          type: "board.card.archive",
          commandId: CommandId.make("cmd-archive"),
          cardId: BoardCardId.make("card-a"),
          createdAt: NOW,
        },
        makeReadModel({ board: { cards: [live], nextCardNumberByProject: {} } }),
      );
      assert.strictEqual(archived.type, "board.card-archived");
      if (archived.type !== "board.card-archived") return;
      assert.strictEqual(archived.payload.card.archivedAt, NOW);

      const again = yield* decideFail(
        {
          type: "board.card.archive",
          commandId: CommandId.make("cmd-archive-2"),
          cardId: BoardCardId.make("card-a"),
          createdAt: NOW,
        },
        makeReadModel({ board: { cards: [archived.payload.card], nextCardNumberByProject: {} } }),
      );
      assert.include(String(again), "already archived");

      const restored = yield* decide(
        {
          type: "board.card.unarchive",
          commandId: CommandId.make("cmd-unarchive"),
          cardId: BoardCardId.make("card-a"),
          createdAt: NOW,
        },
        makeReadModel({ board: { cards: [archived.payload.card], nextCardNumberByProject: {} } }),
      );
      assert.strictEqual(restored.type, "board.card-unarchived");
      if (restored.type !== "board.card-unarchived") return;
      assert.strictEqual(restored.payload.card.archivedAt, null);

      const notArchived = yield* decideFail(
        {
          type: "board.card.unarchive",
          commandId: CommandId.make("cmd-unarchive-2"),
          cardId: BoardCardId.make("card-a"),
          createdAt: NOW,
        },
        makeReadModel({ board: { cards: [live], nextCardNumberByProject: {} } }),
      );
      assert.include(String(notArchived), "not archived");
    }),
  );

  it.effect("unblocks the cards depending on a card as it is archived (t3o-13, D5)", () =>
    Effect.gen(function* () {
      // The dependency is unfinished, so `waiting` is legitimately blocked in
      // Ready — until the thing it waits for is archived, at which point it is
      // waiting for work that is not happening.
      const dependency = makeCard({ id: "card-dep", stage: "building" });
      const waiting = makeCard({
        id: "card-waiting",
        stage: "ready",
        blocked: true,
        dependsOn: [BoardCardId.make("card-dep")],
      });
      // Depends on the same card but sits before Ready, so it was never
      // blocked and must not be re-flagged for nothing.
      const early = makeCard({
        id: "card-early",
        stage: "backlog",
        dependsOn: [BoardCardId.make("card-dep")],
      });

      const events = yield* decideEvents(
        {
          type: "board.card.archive",
          commandId: CommandId.make("cmd-archive-dep"),
          cardId: BoardCardId.make("card-dep"),
          createdAt: NOW,
        },
        makeReadModel({
          board: { cards: [dependency, waiting, early], nextCardNumberByProject: {} },
        }),
      );

      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["board.card-archived", "board.card-updated"],
      );
      const reflag = events[1]!;
      assert.strictEqual(reflag.aggregateId, BoardCardId.make("card-waiting"));
      if (reflag.type !== "board.card-updated") return;
      assert.strictEqual(reflag.payload.card.blocked, false);
      // The edge survives the archive — that is what makes unarchive a true
      // inverse.
      assert.deepStrictEqual(reflag.payload.card.dependsOn, [BoardCardId.make("card-dep")]);
    }),
  );

  it.effect("re-blocks the cards depending on a card as it is restored (t3o-13, D5)", () =>
    Effect.gen(function* () {
      const dependency = makeCard({ id: "card-dep", stage: "building", archivedAt: NOW });
      const waiting = makeCard({
        id: "card-waiting",
        stage: "building",
        blocked: false,
        dependsOn: [BoardCardId.make("card-dep")],
      });

      const events = yield* decideEvents(
        {
          type: "board.card.unarchive",
          commandId: CommandId.make("cmd-unarchive-dep"),
          cardId: BoardCardId.make("card-dep"),
          createdAt: NOW,
        },
        makeReadModel({ board: { cards: [dependency, waiting], nextCardNumberByProject: {} } }),
      );

      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["board.card-unarchived", "board.card-updated"],
      );
      const reflag = events[1]!;
      if (reflag.type !== "board.card-updated") return;
      assert.strictEqual(reflag.payload.card.blocked, true);
    }),
  );

  it.effect("re-flags nothing when no dependent's blocked state actually changes", () =>
    Effect.gen(function* () {
      // Archiving a FINISHED card changes nothing for its dependents: done
      // satisfied the gate before, and archived satisfies it after.
      const dependency = makeCard({ id: "card-dep", stage: "done" });
      const waiting = makeCard({
        id: "card-waiting",
        stage: "ready",
        blocked: false,
        dependsOn: [BoardCardId.make("card-dep")],
      });
      // An archived dependent is invisible and unaffected, so it never emits.
      const archivedDependent = makeCard({
        id: "card-archived-dependent",
        stage: "ready",
        blocked: true,
        archivedAt: NOW,
        dependsOn: [BoardCardId.make("card-dep")],
      });

      const events = yield* decideEvents(
        {
          type: "board.card.archive",
          commandId: CommandId.make("cmd-archive-done"),
          cardId: BoardCardId.make("card-dep"),
          createdAt: NOW,
        },
        makeReadModel({
          board: {
            cards: [dependency, waiting, archivedDependent],
            nextCardNumberByProject: {},
          },
        }),
      );

      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["board.card-archived"],
      );
    }),
  );

  it.effect("lets a card past Ready when its only unmet dependency is archived", () =>
    Effect.gen(function* () {
      const dependency = makeCard({ id: "card-dep", stage: "building", archivedAt: NOW });
      const waiting = makeCard({
        id: "card-waiting",
        stage: "ready",
        dependsOn: [BoardCardId.make("card-dep")],
      });

      const event = yield* decide(
        {
          type: "board.card.move",
          commandId: CommandId.make("cmd-move-past-archived"),
          cardId: BoardCardId.make("card-waiting"),
          toStage: BoardStageId.make("building"),
          createdAt: NOW,
        },
        makeReadModel({ board: { cards: [dependency, waiting], nextCardNumberByProject: {} } }),
      );

      assert.strictEqual(event.type, "board.card-moved");
      if (event.type !== "board.card-moved") return;
      assert.strictEqual(event.payload.card.blocked, false);
    }),
  );

  it.effect("rejects mutating commands on an archived card", () =>
    Effect.gen(function* () {
      const board: BoardState = {
        cards: [makeCard({ id: "card-a", archivedAt: NOW })],
        nextCardNumberByProject: {},
      };
      const failure = yield* decideFail(
        moveCommand({ cardId: "card-a", toStage: "sprint" }),
        makeReadModel({ board }),
      );
      assert.include(String(failure), "is archived");
    }),
  );

  // ── No board-initiated Ready -> Building ────────────────────────

  it.effect("no command except an explicit board.card.move emits a move into building", () =>
    Effect.gen(function* () {
      // Every fixture's command succeeds (a rejection trivially emits nothing).
      // The Record over BoardCommand["type"] keeps this catalog exhaustive.
      const readyCard = makeCard({ id: "card-ready", stage: "ready" });
      const archivedCard = makeCard({ id: "card-archived", stage: "ready", archivedAt: NOW });
      const linkedCard = makeCard({
        id: "card-linked",
        stage: "ready",
        threadLinks: [
          {
            threadId: ThreadId.make("thread-1"),
            role: "planning",
            linkedAt: NOW,
            tombstonedAt: null,
          },
        ],
      });
      // A tombstoned label so board.label.undelete has something to restore;
      // the seeds remain live for create/update/delete.
      const tombstonedLabel: BoardLabel = {
        labelId: BoardLabelId.make("label-archived"),
        name: "archived",
        colour: "#111111",
        deletedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      };
      // A plan on card-ready so board.plan.write has something to write.
      const readyPlan: BoardPlan = {
        planId: boardPlanId(BoardCardId.make("card-ready"), "p1"),
        cardId: BoardCardId.make("card-ready"),
        title: "Plan 1",
        summary: "First",
        dependsOn: [],
        ordinal: 0,
        locked: false,
        createdAt: NOW,
        updatedAt: NOW,
      };
      // A two-plan card in Planning for board.plans.approve. Approval
      // materialises the children and moves NOTHING, so this fixture
      // now proves the negative like every other entry.
      const splitCard = makeCard({ id: "card-split", stage: "planning" });
      const splitPlans: ReadonlyArray<BoardPlan> = ["s1", "s2"].map((key, index) => ({
        planId: boardPlanId(BoardCardId.make("card-split"), key),
        cardId: BoardCardId.make("card-split"),
        title: `Split ${key}`,
        summary: `Part ${key}`,
        dependsOn: [],
        ordinal: index,
        locked: false,
        createdAt: NOW,
        updatedAt: NOW,
      }));
      // Worktree lifecycle fixtures: each succeeds and none emits a
      // move — worktree provisioning is gated on Building but never advances a
      // stage.
      const buildingCard = makeCard({ id: "card-building", stage: "building" });
      const provisioningCard = makeCard({
        id: "card-provisioning",
        stage: "building",
        worktree: {
          branch: "board/card-provisioning",
          baseRefName: "main",
          path: null,
          status: "provisioning",
          attempts: 1,
          lastError: null,
          reclaimBlockedReason: null,
        },
      });
      const worktreeCard = makeCard({
        id: "card-worktree",
        stage: "building",
        worktree: {
          branch: "board/card-worktree",
          baseRefName: "main",
          path: "/tmp/worktrees/card-worktree",
          status: "ready",
          attempts: 1,
          lastError: null,
          reclaimBlockedReason: null,
        },
      });
      // Step-lifecycle fixtures: every card is in Building with the step state
      // (and frozen execution config) its command's precondition needs.
      const frozenConfig = {
        prompt: "do it",
        providerInstanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        mode: "build" as const,
        runtimeMode: "auto" as const,
        humanInLoop: false,
        maxAttempts: 3,
        timeoutMs: 1000,
        baseTipAtRoundStart: null,
        lastError: null,
      };
      const makeStepState = (
        cardId: string,
        status: BoardCardStepState["status"],
        stepId = "s1",
      ): BoardCardStepState => ({
        cardId: BoardCardId.make(cardId),
        stepId,
        stepLabel: "Build",
        stageLabel: "Building",
        attempt: 1,
        stallCount: 0,
        stageEntryRecoveries: 0,
        humanTurnAt: null,
        awaitingReason: "question",
        stalledReason: "gave-up",
        retryAt: null,
        lastNudgeAt: null,
        ...frozenConfig,
        threadId:
          status === "running" || status === "awaiting-input" ? ThreadId.make("thread-1") : null,
        status,
        slotHeld: status === "running" || status === "awaiting-input",
        forceStart: false,
        queuedBy: null,
        startedAt: status === "running" || status === "awaiting-input" ? NOW : null,
        updatedAt: NOW,
      });
      const selectCard = makeCard({ id: "card-select", stage: "building" });
      const admitCard = makeCard({ id: "card-admit", stage: "building" });
      const forceStartCard = makeCard({ id: "card-force-start", stage: "building" });
      const awaitCard = makeCard({ id: "card-await", stage: "building" });
      const pauseCard = makeCard({ id: "card-pause", stage: "building" });
      const requeueCard = makeCard({ id: "card-requeue", stage: "building" });
      const recoverCard = makeCard({ id: "card-recover", stage: "building" });
      const resumeCard = makeCard({ id: "card-resume", stage: "building" });
      const settleCard = makeCard({ id: "card-settle", stage: "building" });
      // reopen-step only accepts a settled step whose recorded payload cannot
      // be read, so the catalog's card carries exactly that record.
      const reopenCard = makeCard({ id: "card-reopen", stage: BOARD_SEED_STAGE_IDS.review });
      // set-project only accepts a card that has never been built.
      const projectCard = makeCard({ id: "card-project", stage: "ready" });
      // mark-auto-plan only accepts a leaf in planning.
      const autoPlanCard = makeCard({ id: "card-auto-plan", stage: "planning" });
      const autoPlanningCard = {
        ...makeCard({ id: "card-auto-planning", stage: "planning" }),
        autoPlan: { mode: "build" as const, requestedAt: NOW, endedAt: null },
      };
      const briefAttachment = {
        id: BoardCardAttachmentId.make("att-1"),
        name: "bug.png",
        type: "image" as const,
        mimeType: "image/png",
        sizeBytes: 1024,
        addedAt: NOW,
      };
      // An empty heading, for the group-settings command.
      const groupCard = {
        ...makeCard({ id: "card-group", stage: "sprint" }),
        group: defaultBoardCardGroup(
          EMPTY_BOARD_STATE,
          { stage: BOARD_SEED_STAGE_IDS.sprint },
          {
            heading: true,
          },
        ),
      };
      // Not in Backlog: the catalog's stage delete expects that column empty.
      const attachedCard = makeCard({
        id: "card-attached",
        stage: "ready",
        attachments: [briefAttachment],
      });
      const readModel = makeReadModel({
        threads: [makeThread({ id: "thread-1" }), makeThread({ id: "thread-2" })],
        board: {
          cards: [
            readyCard,
            archivedCard,
            linkedCard,
            buildingCard,
            provisioningCard,
            worktreeCard,
            selectCard,
            admitCard,
            forceStartCard,
            awaitCard,
            pauseCard,
            requeueCard,
            recoverCard,
            resumeCard,
            settleCard,
            splitCard,
            attachedCard,
            groupCard,
            reopenCard,
            projectCard,
            autoPlanCard,
            autoPlanningCard,
          ],
          labels: [...BOARD_SEED_LABELS, tombstonedLabel],
          plans: [readyPlan, ...splitPlans],
          stepStates: [
            makeStepState("card-admit", "pending"),
            // force-start-step only accepts a step actually queued for a slot.
            makeStepState("card-force-start", "queued"),
            makeStepState("card-await", "running"),
            // pause-step only accepts a step with a turn to stop.
            makeStepState("card-pause", "running"),
            // requeue-step only accepts a PARKED step.
            makeStepState("card-requeue", "paused"),
            makeStepState("card-recover", "running"),
            // resume-step only accepts a stalled step.
            makeStepState("card-resume", "stalled"),
            makeStepState("card-settle", "running"),
            // complete-step validates against the card's LIVE step, so the
            // catalog's completion needs one to succeed against.
            makeStepState("card-ready", "running", "build"),
          ],
          // A registered worker for the registry commands to act on.
          workers: [
            {
              id: EnvironmentId.make("env-worker-a"),
              label: "worker-a",
              url: "http://worker-a:3773",
              addedAt: NOW,
            },
          ],
          stepCompletions: [
            {
              cardId: BoardCardId.make("card-reopen"),
              stepId: "review@1",
              outcome: "succeeded" as const,
              summary: "Reviewed",
              payload: null,
              threadId: null,
              completedAt: NOW,
            },
          ],
          nextCardNumberByProject: {},
        },
      });

      const catalog: { readonly [K in BoardCommand["type"]]: BoardCommand } = {
        "board.card.create": createCommand({ cardId: "card-new" }),
        // The one legitimate path into building — explicit, user-originated.
        "board.card.move": moveCommand({ cardId: "card-ready", toStage: "building" }),
        "board.card.move-cards": {
          type: "board.card.move-cards",
          commandId: CommandId.make("cmd-move-cards"),
          cardId: BoardCardId.make("card-project"),
          cardIds: [BoardCardId.make("card-project")],
          parentCardId: BoardCardId.make("card-group"),
          createdAt: NOW,
        },
        "board.card.set-group-settings": {
          type: "board.card.set-group-settings",
          commandId: CommandId.make("cmd-group-settings"),
          cardId: BoardCardId.make("card-group"),
          autoBuild: true,
          createdAt: NOW,
        },
        "board.card.set-automation": {
          type: "board.card.set-automation",
          commandId: CommandId.make("cmd-set-automation"),
          cardId: BoardCardId.make("card-ready"),
          autoBuild: true,
          createdAt: NOW,
        },
        "board.card.sync-groups": {
          type: "board.card.sync-groups",
          commandId: CommandId.make("cmd-sync-groups"),
          cardId: BoardCardId.make("card-group"),
          createdAt: NOW,
        },
        "board.card.reorder": {
          type: "board.card.reorder",
          commandId: CommandId.make("cmd-reorder"),
          cardId: BoardCardId.make("card-ready"),
          orderKey: "t",
          createdAt: NOW,
        },
        "board.card.update": {
          type: "board.card.update",
          commandId: CommandId.make("cmd-update"),
          cardId: BoardCardId.make("card-ready"),
          title: "Renamed",
          createdAt: NOW,
        },
        "board.card.set-project": {
          type: "board.card.set-project",
          commandId: CommandId.make("cmd-set-project"),
          cardId: BoardCardId.make("card-project"),
          projectId: otherProjectId,
          createdAt: NOW,
        },
        "board.card.attach": {
          type: "board.card.attach",
          commandId: CommandId.make("cmd-attach"),
          cardId: BoardCardId.make("card-ready"),
          attachment: { ...briefAttachment, id: BoardCardAttachmentId.make("att-2") },
          createdAt: NOW,
        },
        "board.card.detach": {
          type: "board.card.detach",
          commandId: CommandId.make("cmd-detach"),
          cardId: BoardCardId.make("card-attached"),
          attachmentId: briefAttachment.id,
          createdAt: NOW,
        },
        "board.card.link-thread": {
          type: "board.card.link-thread",
          commandId: CommandId.make("cmd-link"),
          cardId: BoardCardId.make("card-ready"),
          threadId: ThreadId.make("thread-2"),
          role: "planning",
          createdAt: NOW,
        },
        "board.card.unlink-thread": {
          type: "board.card.unlink-thread",
          commandId: CommandId.make("cmd-unlink"),
          cardId: BoardCardId.make("card-linked"),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
        },
        "board.card.retire-thread": {
          type: "board.card.retire-thread",
          commandId: CommandId.make("cmd-retire"),
          cardId: BoardCardId.make("card-linked"),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
        },
        "board.card.archive": {
          type: "board.card.archive",
          commandId: CommandId.make("cmd-archive"),
          cardId: BoardCardId.make("card-ready"),
          createdAt: NOW,
        },
        "board.card.cancel-work": {
          type: "board.card.cancel-work",
          commandId: CommandId.make("cmd-cancel-work"),
          cardId: BoardCardId.make("card-building"),
          confirmCardKey: "CARD-1",
          createdAt: NOW,
        },
        "board.card.unarchive": {
          type: "board.card.unarchive",
          commandId: CommandId.make("cmd-unarchive"),
          cardId: BoardCardId.make("card-archived"),
          createdAt: NOW,
        },
        // Delete removes the card and rewrites the edges pointing at it —
        // `board.card-updated` on the dependents, never a move.
        "board.card.delete": {
          type: "board.card.delete",
          commandId: CommandId.make("cmd-delete"),
          cardId: BoardCardId.make("card-ready"),
          createdAt: NOW,
        },
        // Label commands aggregate on the label and never move a card.
        "board.label.create": {
          type: "board.label.create",
          commandId: CommandId.make("cmd-label-create"),
          labelId: BoardLabelId.make("label-urgent"),
          name: "urgent",
          createdAt: NOW,
        },
        "board.label.update": {
          type: "board.label.update",
          commandId: CommandId.make("cmd-label-update"),
          labelId: BOARD_SEED_LABEL_IDS.feature,
          colour: "#123456",
          createdAt: NOW,
        },
        "board.label.delete": {
          type: "board.label.delete",
          commandId: CommandId.make("cmd-label-delete"),
          labelId: BOARD_SEED_LABEL_IDS.chore,
          createdAt: NOW,
        },
        "board.label.undelete": {
          type: "board.label.undelete",
          commandId: CommandId.make("cmd-label-undelete"),
          labelId: BoardLabelId.make("label-archived"),
          createdAt: NOW,
        },
        // Agent write-path commands all aggregate on the card and
        // never emit a move.
        "board.card.complete-step": {
          type: "board.card.complete-step",
          commandId: CommandId.make("cmd-step"),
          cardId: BoardCardId.make("card-ready"),
          stepId: "build",
          outcome: "succeeded",
          summary: "Built",
          payload: null,
          threadId: null,
          createdAt: NOW,
        },
        "board.card.reopen-step": {
          type: "board.card.reopen-step",
          commandId: CommandId.make("cmd-reopen"),
          cardId: BoardCardId.make("card-reopen"),
          stepId: "review@1",
          createdAt: NOW,
        },
        "board.plans.propose": {
          type: "board.plans.propose",
          commandId: CommandId.make("cmd-propose"),
          cardId: BoardCardId.make("card-ready"),
          plans: [{ key: "p1", title: "Plan 1", summary: "First", dependsOn: [], body: "body" }],
          splitRationale: null,
          createdAt: NOW,
        },
        "board.plan.write": {
          type: "board.plan.write",
          commandId: CommandId.make("cmd-write"),
          cardId: BoardCardId.make("card-ready"),
          planId: boardPlanId(BoardCardId.make("card-ready"), "p1"),
          body: "new body",
          createdAt: NOW,
        },
        // The split approval: materialises the children
        // and leaves the parent's stage alone.
        "board.plans.approve": {
          type: "board.plans.approve",
          commandId: CommandId.make("cmd-approve"),
          cardId: BoardCardId.make("card-split"),
          createdAt: NOW,
        },
        // Records the integration branch the reactor created —
        // a worktree-slice write, never a move.
        "board.card.record-integration-branch": {
          type: "board.card.record-integration-branch",
          commandId: CommandId.make("cmd-record-integration"),
          cardId: BoardCardId.make("card-ready"),
          branch: "board/card-ready",
          baseRefName: "main",
          createdAt: NOW,
        },
        // Moves the RECORDED base after a retarget rebase — a
        // worktree-slice write on a live branch, never a move.
        "board.card.record-base-ref": {
          type: "board.card.record-base-ref",
          commandId: CommandId.make("cmd-record-base-ref"),
          cardId: BoardCardId.make("card-worktree"),
          baseRefName: "develop",
          createdAt: NOW,
        },
        "board.card.provision-worktree": {
          type: "board.card.provision-worktree",
          commandId: CommandId.make("cmd-provision"),
          cardId: BoardCardId.make("card-building"),
          branch: "board/card-building",
          baseRefName: "main",
          createdAt: NOW,
        },
        "board.card.record-worktree": {
          type: "board.card.record-worktree",
          commandId: CommandId.make("cmd-record"),
          cardId: BoardCardId.make("card-provisioning"),
          path: "/tmp/worktrees/card-provisioning",
          createdAt: NOW,
        },
        // The card starts with no hold, so recording one is a real change and
        // clears the decider's no-op guard. It writes one card field and can
        // emit no move.
        // The review loop's server-only carry fields.
        "board.card.set-review-carry": {
          type: "board.card.set-review-carry",
          commandId: CommandId.make("cmd-set-review-carry"),
          cardId: BoardCardId.make("card-reopen"),
          runThroughRound: 2,
          createdAt: NOW,
        },
        "board.card.record-auto-merge-hold": {
          type: "board.card.record-auto-merge-hold",
          commandId: CommandId.make("cmd-record-auto-merge-hold"),
          cardId: BoardCardId.make("card-ready"),
          hold: {
            reason: "Required checks have not passed.",
            classification: "soft",
            detail: null,
            attempt: 1,
            heldSince: NOW,
            retryAt: NOW,
            headSha: null,
          },
          createdAt: NOW,
        },
        // Reporting only: it writes an activity row and touches no card field,
        // so it cannot possibly emit a move.
        "board.card.record-decisions": {
          type: "board.card.record-decisions",
          commandId: CommandId.make("cmd-record-decisions"),
          cardId: BoardCardId.make("card-ready"),
          decisions: [
            {
              question: "Ship behind a flag?",
              decision: "No flag",
              reason: "Small and reversible.",
              flag: "unclear",
              decidedBy: "agent",
            },
          ],
          stepId: null,
          threadId: null,
          createdAt: NOW,
        },
        "board.card.mark-auto-plan": {
          type: "board.card.mark-auto-plan",
          commandId: CommandId.make("cmd-mark-auto-plan"),
          cardId: BoardCardId.make("card-auto-plan"),
          createdAt: NOW,
        },
        "board.card.end-auto-plan": {
          type: "board.card.end-auto-plan",
          commandId: CommandId.make("cmd-end-auto-plan"),
          cardId: BoardCardId.make("card-auto-planning"),
          createdAt: NOW,
        },
        "board.card.record-note": {
          type: "board.card.record-note",
          commandId: CommandId.make("cmd-record-note"),
          cardId: BoardCardId.make("card-ready"),
          kind: "card-branch-deleted",
          detail: "Deleted branch board/card-ready",
          createdAt: NOW,
        },
        // The card starts with no PR, so recording one is a real change and
        // clears the decider's no-op guard.
        "board.card.record-pull-request": {
          type: "board.card.record-pull-request",
          commandId: CommandId.make("cmd-record-pr"),
          cardId: BoardCardId.make("card-ready"),
          pullRequest: {
            number: 284,
            url: "https://github.com/acme/repo/pull/284",
            state: "open",
            title: null,
            headBranch: "t3o/card-ready",
            baseRef: "main",
            checkedAt: NOW,
          },
          createdAt: NOW,
        },
        // An explicit link: one card field, never a move.
        "board.card.set-linked-pull-request": {
          type: "board.card.set-linked-pull-request",
          commandId: CommandId.make("cmd-link-pr"),
          cardId: BoardCardId.make("card-ready"),
          pullRequest: {
            number: 75,
            url: "https://github.com/acme/repo/pull/75",
            state: "open",
            title: null,
            headBranch: "stack/layer-2",
            baseRef: "main",
            checkedAt: NOW,
          },
          createdAt: NOW,
        },
        "board.card.fail-worktree": {
          type: "board.card.fail-worktree",
          commandId: CommandId.make("cmd-fail"),
          cardId: BoardCardId.make("card-provisioning"),
          error: "boom",
          createdAt: NOW,
        },
        "board.card.reclaim-worktree": {
          type: "board.card.reclaim-worktree",
          commandId: CommandId.make("cmd-reclaim"),
          cardId: BoardCardId.make("card-worktree"),
          outcome: "removed",
          createdAt: NOW,
        },
        // Step-lifecycle commands record step state on the card and
        // never move a stage — the board-driven Building → Review advance
        // rides board.card.move, gated like every other transition.
        "board.card.select-step": {
          type: "board.card.select-step",
          commandId: CommandId.make("cmd-select"),
          cardId: BoardCardId.make("card-select"),
          stepId: "s1",
          stepLabel: "Build",
          stageLabel: "Building",
          ...frozenConfig,
          createdAt: NOW,
        },
        "board.card.admit-step": {
          type: "board.card.admit-step",
          commandId: CommandId.make("cmd-admit"),
          cardId: BoardCardId.make("card-admit"),
          stepId: "s1",
          admitted: true,
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
        },
        "board.card.force-start-step": {
          type: "board.card.force-start-step",
          commandId: CommandId.make("cmd-force-start"),
          cardId: BoardCardId.make("card-force-start"),
          createdAt: NOW,
        },
        "board.card.await-step-input": {
          type: "board.card.await-step-input",
          commandId: CommandId.make("cmd-await"),
          cardId: BoardCardId.make("card-await"),
          stepId: "s1",
          reason: "question",
          createdAt: NOW,
        },
        "board.card.pause-step": {
          type: "board.card.pause-step",
          commandId: CommandId.make("cmd-pause"),
          cardId: BoardCardId.make("card-pause"),
          stepId: "s1",
          createdAt: NOW,
        },
        "board.card.requeue-step": {
          type: "board.card.requeue-step",
          commandId: CommandId.make("cmd-requeue"),
          cardId: BoardCardId.make("card-requeue"),
          createdAt: NOW,
        },
        "board.card.recover-step": {
          type: "board.card.recover-step",
          commandId: CommandId.make("cmd-recover"),
          cardId: BoardCardId.make("card-recover"),
          stepId: "s1",
          threadId: ThreadId.make("thread-1"),
          escalateToHuman: false,
          progressed: false,
          createdAt: NOW,
        },
        "board.card.resume-step": {
          type: "board.card.resume-step",
          commandId: CommandId.make("cmd-resume"),
          cardId: BoardCardId.make("card-resume"),
          stepId: "s1",
          createdAt: NOW,
        },
        "board.card.settle-step": {
          type: "board.card.settle-step",
          commandId: CommandId.make("cmd-settle"),
          cardId: BoardCardId.make("card-settle"),
          stepId: "s1",
          outcome: "succeeded",
          createdAt: NOW,
        },
        // Mid-run human-in-the-loop retune: retunes a live step's
        // stance, emits board.card-step-retuned — never a move.
        "board.card.retune-step": {
          type: "board.card.retune-step",
          commandId: CommandId.make("cmd-retune"),
          cardId: BoardCardId.make("card-settle"),
          stepId: "s1",
          humanInLoop: true,
          createdAt: NOW,
        },
        // A human's own turn on a live step: records the free
        // turn-ending it buys, emits board.card-step-steered — never a move.
        "board.card.note-human-turn": {
          type: "board.card.note-human-turn",
          commandId: CommandId.make("cmd-note-human-turn"),
          cardId: BoardCardId.make("card-settle"),
          stepId: "s1",
          at: NOW,
          createdAt: NOW,
        },
        // A background-wait check-in: bookkeeping on the live step,
        // emits board.card-step-checked-in — never a move.
        "board.card.check-in-step": {
          type: "board.card.check-in-step",
          commandId: CommandId.make("cmd-check-in-step"),
          cardId: BoardCardId.make("card-settle"),
          stepId: "s1",
          charged: false,
          progressed: false,
          createdAt: NOW,
        },
        // On-demand kickoff: emits board.card-stage-thread-requested for
        // the card's CURRENT stage — never a move.
        "board.card.start-stage-thread": {
          type: "board.card.start-stage-thread",
          commandId: CommandId.make("cmd-start-stage-thread"),
          cardId: BoardCardId.make("card-ready"),
          createdAt: NOW,
        },
        // Stage-aggregate commands: they mutate the stage list, never a
        // card, so they cannot emit a card move. Every fixture targets an empty,
        // non-role seed stage so its invariant is satisfied.
        "board.stage.create": {
          type: "board.stage.create",
          commandId: CommandId.make("cmd-stage-create"),
          stageId: BoardStageId.make("triage"),
          label: "Triage",
          orderKey: "c",
          role: null,
          createdAt: NOW,
        },
        "board.stage.rename": {
          type: "board.stage.rename",
          commandId: CommandId.make("cmd-stage-rename"),
          stageId: BoardStageId.make("sprint"),
          label: "Sprint 2",
          createdAt: NOW,
        },
        "board.stage.reorder": {
          type: "board.stage.reorder",
          commandId: CommandId.make("cmd-stage-reorder"),
          stageId: BoardStageId.make("sprint"),
          orderKey: "a",
          createdAt: NOW,
        },
        // Backlog, not "merge": "Ready for merge" now holds the `merge` role
        // and role holders are undeletable, like every other role stage.
        "board.stage.delete": {
          type: "board.stage.delete",
          commandId: CommandId.make("cmd-stage-delete"),
          stageId: BoardStageId.make("backlog"),
          createdAt: NOW,
        },
        "board.worker.register": {
          type: "board.worker.register",
          commandId: CommandId.make("cmd-worker-register"),
          mode: "add",
          worker: {
            id: EnvironmentId.make("env-worker-b"),
            label: "worker-b",
            url: "http://worker-b:3773",
            addedAt: NOW,
          },
          createdAt: NOW,
        },
        "board.worker.remove": {
          type: "board.worker.remove",
          commandId: CommandId.make("cmd-worker-remove"),
          workerId: EnvironmentId.make("env-worker-a"),
          createdAt: NOW,
        },
        "board.worker.set-default": {
          type: "board.worker.set-default",
          commandId: CommandId.make("cmd-worker-default"),
          workerId: EnvironmentId.make("env-worker-a"),
          createdAt: NOW,
        },
        "board.card.pin-worker": {
          type: "board.card.pin-worker",
          commandId: CommandId.make("cmd-pin-worker"),
          cardId: BoardCardId.make("card-ready"),
          workerId: EnvironmentId.make("env-worker-a"),
          createdAt: NOW,
        },
        "board.card.place": {
          type: "board.card.place",
          commandId: CommandId.make("cmd-place"),
          cardId: BoardCardId.make("card-ready"),
          workerId: EnvironmentId.make("env-worker-a"),
          createdAt: NOW,
        },
        "board.card.move-worker": {
          type: "board.card.move-worker",
          commandId: CommandId.make("cmd-move-worker"),
          cardId: BoardCardId.make("card-worktree"),
          step: { phase: "start", toWorkerId: EnvironmentId.make("env-worker-a"), sha: null },
          createdAt: NOW,
        },
        "board.card.pipeline-move": {
          type: "board.card.pipeline-move",
          commandId: CommandId.make("cmd-pipeline-move"),
          cardId: BoardCardId.make("card-ready"),
          toStage: BoardStageId.make("building"),
          createdAt: NOW,
        },
        "board.card.record-ci": {
          type: "board.card.record-ci",
          commandId: CommandId.make("cmd-record-ci"),
          cardId: BoardCardId.make("card-ready"),
          action: { kind: "finish-pass", runId: "run-1", result: "cancelled" },
          createdAt: NOW,
        },
        "board.stage.set-default-for-projects": {
          type: "board.stage.set-default-for-projects",
          commandId: CommandId.make("cmd-stage-default"),
          stageId: BoardStageId.make("sprint"),
          on: false,
          actor: BOARD_SYSTEM_ACTOR,
          createdAt: NOW,
        },
        "board.project.set-stage-switch": {
          type: "board.project.set-stage-switch",
          commandId: CommandId.make("cmd-project-switch"),
          projectId: ProjectId.make("project-1"),
          stageId: BoardStageId.make("sprint"),
          on: false,
          actor: BOARD_SYSTEM_ACTOR,
          createdAt: NOW,
        },
        "board.project.set-stage-override": {
          type: "board.project.set-stage-override",
          commandId: CommandId.make("cmd-project-override"),
          projectId: ProjectId.make("project-1"),
          stageId: BoardStageId.make("building"),
          patch: { prompt: "Build it" },
          actor: BOARD_SYSTEM_ACTOR,
          createdAt: NOW,
        },
        "board.project.set-ci-steps": {
          type: "board.project.set-ci-steps",
          commandId: CommandId.make("cmd-project-ci-steps"),
          projectId: ProjectId.make("project-1"),
          steps: [],
          actor: BOARD_SYSTEM_ACTOR,
          createdAt: NOW,
        },
        "board.project.set-ci-enabled": {
          type: "board.project.set-ci-enabled",
          commandId: CommandId.make("cmd-project-ci-enabled"),
          projectId: ProjectId.make("project-1"),
          on: true,
          actor: BOARD_SYSTEM_ACTOR,
          createdAt: NOW,
        },
        "board.project.set-ci-stop-on-failure": {
          type: "board.project.set-ci-stop-on-failure",
          commandId: CommandId.make("cmd-project-ci-stop-on-failure"),
          projectId: ProjectId.make("project-1"),
          stopOnFailure: false,
          actor: BOARD_SYSTEM_ACTOR,
          createdAt: NOW,
        },
        "board.project.reset": {
          type: "board.project.reset",
          commandId: CommandId.make("cmd-project-reset"),
          projectId: ProjectId.make("project-1"),
          actor: BOARD_SYSTEM_ACTOR,
          createdAt: NOW,
        },
        "board.project.import-file": {
          type: "board.project.import-file",
          commandId: CommandId.make("cmd-project-import"),
          projectId: ProjectId.make("project-1"),
          blobSha: "abc",
          delta: { stageSwitches: {}, overrides: {}, ci: { steps: [] }, warnings: [] },
          createStages: [],
          actor: BOARD_SYSTEM_ACTOR,
          createdAt: NOW,
        },
        "board.project.dismiss-import": {
          type: "board.project.dismiss-import",
          commandId: CommandId.make("cmd-project-dismiss"),
          projectId: ProjectId.make("project-1"),
          blobSha: "abc",
          actor: BOARD_SYSTEM_ACTOR,
          createdAt: NOW,
        },
      };

      // The full decision is checked: only a human's move and the pipeline's own
      // move may emit a board.card-moved into building.
      const mayMoveIntoBuilding = new Set(["board.card.move", "board.card.pipeline-move"]);
      for (const [commandType, command] of Object.entries(catalog)) {
        const events = yield* decideEvents(command, readModel);
        const movesIntoBuilding = events.some(
          (event) => event.type === "board.card-moved" && event.payload.toStage === "building",
        );
        if (mayMoveIntoBuilding.has(commandType)) {
          expect(movesIntoBuilding).toBe(true);
        } else {
          // Not merely "no move into building": nothing else may emit a
          // board.card-moved at all.
          for (const event of events) {
            expect(event.type).not.toBe("board.card-moved");
          }
        }
      }
    }),
  );

  // ── Stage reorder across the Build boundary ─────────────

  const reorderStage = (stageId: string, orderKey: string) =>
    ({
      type: "board.stage.reorder",
      commandId: CommandId.make(`cmd-reorder-${stageId}`),
      stageId: BoardStageId.make(stageId),
      orderKey,
      createdAt: NOW,
    }) as const;

  it.effect(
    "refuses moving the build-role stage itself when it would strand a card's blocked flag (D9)",
    () =>
      Effect.gen(function* () {
        // Moving building (j) to "c" puts it before sprint (d), which would leave
        // a sprint card with a stale `blocked` flag, so the reorder is refused.
        const held = makeReadModel({
          board: {
            cards: [makeCard({ id: "card-1", stage: "sprint" })],
            nextCardNumberByProject: {},
          },
        });
        const failure = yield* decideFail(reorderStage("building", "c"), held);
        assert.include(String(failure), "Build boundary");

        // With sprint empty, the same reorder lands.
        const empty = makeReadModel({ board: { cards: [], nextCardNumberByProject: {} } });
        const event = yield* decide(reorderStage("building", "c"), empty);
        assert.strictEqual(event.type, "board.stage-reordered");
      }),
  );

  it.effect(
    "refuses moving an ordinary stage across the build boundary while it holds cards (D9)",
    () =>
      Effect.gen(function* () {
        // Move sprint (before build) to "k", between building (j) and review (l),
        // i.e. across the boundary. A card sits in sprint → refused.
        const held = makeReadModel({
          board: {
            cards: [makeCard({ id: "card-1", stage: "sprint" })],
            nextCardNumberByProject: {},
          },
        });
        const failure = yield* decideFail(reorderStage("sprint", "k"), held);
        assert.include(String(failure), "Build boundary");

        // Empty sprint crosses freely.
        const empty = makeReadModel({ board: { cards: [], nextCardNumberByProject: {} } });
        const event = yield* decide(reorderStage("sprint", "k"), empty);
        assert.strictEqual(event.type, "board.stage-reordered");
      }),
  );

  // ── Creation stages ────────────────────────────────────

  it.effect("accepts a create into any stage — BOARD_CREATABLE_STAGES is deleted (D10)", () =>
    Effect.gen(function* () {
      // A card (with no unmet dependencies) may be created directly into any
      // stage, Building and Done included — Mode, not a creation allow-list,
      // governs what entry does. The auto-execute warning is a create-dialog
      // concern, not a decider refusal.
      for (const stage of [
        "backlog",
        "sprint",
        "planning",
        "ready",
        "building",
        "review",
        "merge",
        "done",
      ] as const) {
        const event = yield* decide(
          createCommand({ cardId: `card-${stage}`, stage }),
          makeReadModel({ board: seededBoard() }),
        );
        assert.strictEqual(event.type, "board.card-created");
        if (event.type === "board.card-created")
          assert.strictEqual(event.payload.stage, BoardStageId.make(stage));
      }
    }),
  );

  // ── Labels ─────────────────────────────────────────────────

  it.effect("creates a card with valid labels and rejects an unknown label", () =>
    Effect.gen(function* () {
      const ok = yield* decide(
        createCommand({ cardId: "card-labelled", labels: [BOARD_SEED_LABEL_IDS.feature] }),
        makeReadModel({ board: seededBoard() }),
      );
      assert.strictEqual(ok.type, "board.card-created");
      if (ok.type === "board.card-created") {
        assert.deepStrictEqual(ok.payload.labels, [BOARD_SEED_LABEL_IDS.feature]);
      }
      const failure = yield* decideFail(
        createCommand({ cardId: "card-bad", labels: ["label-nope"] }),
        makeReadModel({ board: seededBoard() }),
      );
      assert.include(String(failure), "does not exist");
    }),
  );

  it.effect("rejects a card carrying more than the label cap", () =>
    Effect.gen(function* () {
      const labels = ["label-1", "label-2", "label-3", "label-4", "label-5", "label-6"];
      const catalogue: BoardLabel[] = labels.map((id) => ({
        labelId: BoardLabelId.make(id),
        name: id,
        colour: "#3b82f6",
        deletedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      }));
      const failure = yield* decideFail(
        createCommand({ cardId: "card-many", labels }),
        makeReadModel({ board: { cards: [], labels: catalogue, nextCardNumberByProject: {} } }),
      );
      assert.include(String(failure), "at most");
    }),
  );

  // ── Incremental labels ──────────────────────────────────────

  const labelUpdate = (fields: {
    readonly labels?: ReadonlyArray<string>;
    readonly addLabels?: ReadonlyArray<string>;
    readonly removeLabels?: ReadonlyArray<string>;
  }) =>
    ({
      type: "board.card.update",
      commandId: CommandId.make("cmd-label-edit"),
      cardId: BoardCardId.make("card-tagged"),
      ...(fields.labels === undefined
        ? {}
        : { labels: fields.labels.map((id) => BoardLabelId.make(id)) }),
      ...(fields.addLabels === undefined
        ? {}
        : { addLabels: fields.addLabels.map((id) => BoardLabelId.make(id)) }),
      ...(fields.removeLabels === undefined
        ? {}
        : { removeLabels: fields.removeLabels.map((id) => BoardLabelId.make(id)) }),
      createdAt: NOW,
    }) as const;

  const retiredLabel: BoardLabel = {
    labelId: BoardLabelId.make("label-retired"),
    name: "retired",
    colour: "#3b82f6",
    deletedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };

  /** A card tagged with `labels`, against the seeds plus one tombstone. */
  const taggedModel = (labels: ReadonlyArray<string>) =>
    makeReadModel({
      board: {
        cards: [makeCard({ id: "card-tagged", labels: labels.map((id) => BoardLabelId.make(id)) })],
        labels: [...BOARD_SEED_LABELS, retiredLabel],
        nextCardNumberByProject: {},
      },
    });

  const updatedLabels = (event: Effect.Success<ReturnType<typeof decide>>) => {
    assert.strictEqual(event.type, "board.card-updated");
    return event.type === "board.card-updated" ? event.payload.card.labels : [];
  };

  it.effect("addLabels/removeLabels apply to the card as the update lands", () =>
    Effect.gen(function* () {
      // The agent read [feature]; someone tagged bug before its update landed.
      // An incremental edit keeps bug, where a whole-set replace would drop it.
      const event = yield* decide(
        labelUpdate({
          addLabels: [BOARD_SEED_LABEL_IDS.chore],
          removeLabels: [BOARD_SEED_LABEL_IDS.feature],
        }),
        taggedModel([BOARD_SEED_LABEL_IDS.feature, BOARD_SEED_LABEL_IDS.bug]),
      );
      assert.deepStrictEqual(updatedLabels(event), [
        BOARD_SEED_LABEL_IDS.bug,
        BOARD_SEED_LABEL_IDS.chore,
      ]);
    }),
  );

  it.effect("adding a carried label or removing an absent one changes nothing", () =>
    Effect.gen(function* () {
      const event = yield* decide(
        labelUpdate({
          addLabels: [BOARD_SEED_LABEL_IDS.feature],
          removeLabels: [BOARD_SEED_LABEL_IDS.chore],
        }),
        taggedModel([BOARD_SEED_LABEL_IDS.feature]),
      );
      assert.deepStrictEqual(updatedLabels(event), [BOARD_SEED_LABEL_IDS.feature]);
    }),
  );

  it.effect("a carried tombstoned label survives an add and can be removed", () =>
    Effect.gen(function* () {
      const kept = yield* decide(
        labelUpdate({ addLabels: [BOARD_SEED_LABEL_IDS.bug] }),
        taggedModel(["label-retired"]),
      );
      assert.deepStrictEqual(updatedLabels(kept), [
        BoardLabelId.make("label-retired"),
        BOARD_SEED_LABEL_IDS.bug,
      ]);
      const removed = yield* decide(
        labelUpdate({ removeLabels: ["label-retired"] }),
        taggedModel(["label-retired"]),
      );
      assert.deepStrictEqual(updatedLabels(removed), []);
    }),
  );

  it.effect("addLabels rejects a tombstoned or unknown label", () =>
    Effect.gen(function* () {
      const tombstoned = yield* decideFail(
        labelUpdate({ addLabels: ["label-retired"] }),
        taggedModel([]),
      );
      assert.include(String(tombstoned), "is deleted");
      const unknown = yield* decideFail(
        labelUpdate({ addLabels: ["label-nope"] }),
        taggedModel([]),
      );
      assert.include(String(unknown), "does not exist");
    }),
  );

  it.effect("rejects labels with addLabels, a label both added and removed, and the cap", () =>
    Effect.gen(function* () {
      const mixed = yield* decideFail(
        labelUpdate({
          labels: [BOARD_SEED_LABEL_IDS.bug],
          addLabels: [BOARD_SEED_LABEL_IDS.chore],
        }),
        taggedModel([]),
      );
      assert.include(String(mixed), "not both");
      const both = yield* decideFail(
        labelUpdate({
          addLabels: [BOARD_SEED_LABEL_IDS.bug],
          removeLabels: [BOARD_SEED_LABEL_IDS.bug],
        }),
        taggedModel([]),
      );
      assert.include(String(both), "both added and removed");
      // Named by the label's name, not its id.
      assert.include(String(both), "Label 'bug'");
      const capped = yield* decideFail(
        labelUpdate({ addLabels: [BOARD_SEED_LABEL_IDS.chore] }),
        taggedModel([
          BOARD_SEED_LABEL_IDS.feature,
          BOARD_SEED_LABEL_IDS.bug,
          "label-retired",
          "label-x",
          "label-y",
        ]),
      );
      assert.include(String(capped), "at most");
    }),
  );

  // ── Brief and dependencies at creation ──────────────────────

  it.effect("carries a brief through the created payload; body is not in the read model", () =>
    Effect.gen(function* () {
      const event = yield* decide(
        createCommand({ cardId: "card-brief", brief: "Ship the thing" }),
        makeReadModel({ board: seededBoard() }),
      );
      assert.strictEqual(event.type, "board.card-created");
      if (event.type === "board.card-created") {
        // The body text rides the event (the projector writes it to
        // board_card_bodies); the read-model card only ever holds briefRef.
        assert.strictEqual(event.payload.brief, "Ship the thing");
      }
    }),
  );

  it.effect("carries initial dependencies and rejects one that does not exist", () =>
    Effect.gen(function* () {
      const dependency = makeCard({ id: "card-dep", stage: "backlog" });
      const ok = yield* decide(
        createCommand({ cardId: "card-with-deps", dependsOn: ["card-dep"] }),
        makeReadModel({ board: seededBoard([dependency]) }),
      );
      assert.strictEqual(ok.type, "board.card-created");
      if (ok.type === "board.card-created") {
        assert.deepStrictEqual(ok.payload.dependsOn, [BoardCardId.make("card-dep")]);
      }
      const failure = yield* decideFail(
        createCommand({ cardId: "card-ghost-dep", dependsOn: ["card-gone"] }),
        makeReadModel({ board: seededBoard() }),
      );
      assert.include(String(failure), "does not exist");
    }),
  );

  it.effect("a deps-free create omits the brief key and carries an empty dependsOn", () =>
    Effect.gen(function* () {
      const event = yield* decide(
        createCommand({ cardId: "card-plain" }),
        makeReadModel({ board: seededBoard() }),
      );
      assert.strictEqual(event.type, "board.card-created");
      if (event.type === "board.card-created") {
        assert.isUndefined(event.payload.brief);
        assert.deepStrictEqual(event.payload.dependsOn, []);
      }
    }),
  );

  it.effect("rejects a label name colliding case-insensitively with a live label", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        labelCreateCommand({ labelId: "label-new", name: "FeAtUrE" }),
        makeReadModel({ board: seededBoard() }),
      );
      assert.include(String(failure), "already exists");
    }),
  );

  it.effect("assigns different swatch colours to two labels created back to back", () =>
    Effect.gen(function* () {
      const first = yield* decide(
        labelCreateCommand({ labelId: "label-a", name: "alpha" }),
        makeReadModel({ board: seededBoard() }),
      );
      assert.strictEqual(first.type, "board.label-created");
      if (first.type !== "board.label-created") return;
      const firstColour = first.payload.label.colour;
      // Second create sees the first label already in the catalogue (the
      // engine's total ordering), so the decider's swatch walk skips its
      // colour.
      const withFirst: BoardLabel = first.payload.label;
      const second = yield* decide(
        labelCreateCommand({ labelId: "label-b", name: "beta" }),
        makeReadModel({
          board: {
            cards: [],
            labels: [...BOARD_SEED_LABELS, withFirst],
            nextCardNumberByProject: {},
          },
        }),
      );
      assert.strictEqual(second.type, "board.label-created");
      if (second.type !== "board.label-created") return;
      assert.notStrictEqual(second.payload.label.colour, firstColour);
    }),
  );

  it.effect("tombstones a label on delete and restores it on undelete", () =>
    Effect.gen(function* () {
      const deleted = yield* decide(
        {
          type: "board.label.delete",
          commandId: CommandId.make("cmd-del"),
          labelId: BOARD_SEED_LABEL_IDS.bug,
          createdAt: NOW,
        },
        makeReadModel({ board: seededBoard() }),
      );
      assert.strictEqual(deleted.type, "board.label-deleted");
      if (deleted.type !== "board.label-deleted") return;
      assert.strictEqual(deleted.payload.label.deletedAt, NOW);

      const restored = yield* decide(
        {
          type: "board.label.undelete",
          commandId: CommandId.make("cmd-undel"),
          labelId: BOARD_SEED_LABEL_IDS.bug,
          createdAt: NOW,
        },
        makeReadModel({
          board: {
            cards: [],
            labels: BOARD_SEED_LABELS.map((label) =>
              label.labelId === BOARD_SEED_LABEL_IDS.bug ? { ...label, deletedAt: NOW } : label,
            ),
            nextCardNumberByProject: {},
          },
        }),
      );
      assert.strictEqual(restored.type, "board.label-undeleted");
      if (restored.type === "board.label-undeleted") {
        assert.strictEqual(restored.payload.label.deletedAt, null);
      }
    }),
  );

  // A seeded catalogue with the bug label tombstoned, for the deleted-label
  // rejection branches.
  const boardWithDeletedBug = (): BoardState => ({
    cards: [],
    labels: BOARD_SEED_LABELS.map((label) =>
      label.labelId === BOARD_SEED_LABEL_IDS.bug ? { ...label, deletedAt: NOW } : label,
    ),
    nextCardNumberByProject: {},
  });

  it.effect("rejects the label decider's invalid branches", () =>
    Effect.gen(function* () {
      // create: duplicate id.
      const dupId = yield* decideFail(
        labelCreateCommand({ labelId: BOARD_SEED_LABEL_IDS.feature, name: "fresh" }),
        makeReadModel({ board: seededBoard() }),
      );
      assert.include(String(dupId), "already exists");

      // update: unknown label.
      const updUnknown = yield* decideFail(
        {
          type: "board.label.update",
          commandId: CommandId.make("cmd-u1"),
          labelId: BoardLabelId.make("label-nope"),
          name: "x",
          createdAt: NOW,
        },
        makeReadModel({ board: seededBoard() }),
      );
      assert.include(String(updUnknown), "does not exist");

      // update: no changes.
      const updNoop = yield* decideFail(
        {
          type: "board.label.update",
          commandId: CommandId.make("cmd-u2"),
          labelId: BOARD_SEED_LABEL_IDS.feature,
          createdAt: NOW,
        },
        makeReadModel({ board: seededBoard() }),
      );
      assert.include(String(updNoop), "carries no changes");

      // update: rename collides with another live label.
      const updCollide = yield* decideFail(
        {
          type: "board.label.update",
          commandId: CommandId.make("cmd-u3"),
          labelId: BOARD_SEED_LABEL_IDS.feature,
          name: "BUG",
          createdAt: NOW,
        },
        makeReadModel({ board: seededBoard() }),
      );
      assert.include(String(updCollide), "already exists");

      // update: a tombstoned label is inert until restored.
      const updDeleted = yield* decideFail(
        {
          type: "board.label.update",
          commandId: CommandId.make("cmd-u4"),
          labelId: BOARD_SEED_LABEL_IDS.bug,
          colour: "#123456",
          createdAt: NOW,
        },
        makeReadModel({ board: boardWithDeletedBug() }),
      );
      assert.include(String(updDeleted), "restore it before editing");

      // delete: already deleted.
      const delTwice = yield* decideFail(
        {
          type: "board.label.delete",
          commandId: CommandId.make("cmd-d1"),
          labelId: BOARD_SEED_LABEL_IDS.bug,
          createdAt: NOW,
        },
        makeReadModel({ board: boardWithDeletedBug() }),
      );
      assert.include(String(delTwice), "already deleted");

      // undelete: not deleted.
      const undelLive = yield* decideFail(
        {
          type: "board.label.undelete",
          commandId: CommandId.make("cmd-x1"),
          labelId: BOARD_SEED_LABEL_IDS.feature,
          createdAt: NOW,
        },
        makeReadModel({ board: seededBoard() }),
      );
      assert.include(String(undelLive), "is not deleted");

      // undelete: name now collides with a live label.
      const undelCollide = yield* decideFail(
        {
          type: "board.label.undelete",
          commandId: CommandId.make("cmd-x2"),
          labelId: BoardLabelId.make("label-dupe"),
          createdAt: NOW,
        },
        makeReadModel({
          board: {
            cards: [],
            labels: [
              ...BOARD_SEED_LABELS,
              {
                labelId: BoardLabelId.make("label-dupe"),
                name: "feature",
                colour: "#000000",
                deletedAt: NOW,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
            nextCardNumberByProject: {},
          },
        }),
      );
      assert.include(String(undelCollide), "already exists");
    }),
  );

  // ── Agent write path ────────────────────────────────────────

  const cardReadModel = (overrides?: Partial<BoardState>) =>
    makeReadModel({
      board: {
        cards: [makeCard({ id: "card-1", stage: "building" })],
        nextCardNumberByProject: {},
        ...overrides,
      },
    });

  const completeStep = (input: {
    readonly stepId: string;
    readonly outcome: "succeeded" | "blocked" | "failed";
    readonly summary: string;
    readonly payload?: unknown;
  }): BoardCommand =>
    ({
      type: "board.card.complete-step",
      commandId: CommandId.make(`cmd-step-${input.stepId}-${input.outcome}`),
      cardId: BoardCardId.make("card-1"),
      stepId: input.stepId,
      outcome: input.outcome,
      summary: input.summary,
      payload: input.payload === undefined ? null : JSON.stringify(input.payload),
      threadId: null,
      createdAt: NOW,
    }) as const;

  const reopenStep = (stepId: string): BoardCommand =>
    ({
      type: "board.card.reopen-step",
      commandId: CommandId.make(`cmd-reopen-${stepId}`),
      cardId: BoardCardId.make("card-1"),
      stepId,
      createdAt: NOW,
    }) as const;

  /** A review completion already in the ledger, as the read model holds it. */
  const recordedReview = (input: {
    readonly stepId: string;
    readonly outcome?: "succeeded" | "failed";
    readonly payload?: unknown;
    readonly summary?: string;
  }) => ({
    cardId: BoardCardId.make("card-1"),
    stepId: input.stepId,
    outcome: input.outcome ?? ("succeeded" as const),
    summary: input.summary ?? "Reviewed",
    payload: input.payload === undefined ? null : JSON.stringify(input.payload),
    threadId: ThreadId.make("thread-1"),
    completedAt: NOW,
  });

  const validReviewPayload = { reviewedSha: "abc123", findings: [] };

  // ── Idempotency is conditional on VALIDITY ───────────────────

  it.effect("board_complete_step repairs a succeeded review step nothing can read", () =>
    Effect.gen(function* () {
      // The CAA-5 record: `succeeded`, payload null, the step long settled — so
      // there is no live step, and the failed-retry supersede rule cannot help.
      // Pinning this is what made one malformed call a permanent deadlock.
      const repaired = yield* decide(
        completeStep({
          stepId: "review@10",
          outcome: "succeeded",
          summary: "Re-recording round 10",
          payload: validReviewPayload,
        }),
        cardReadModel({
          stepStates: [liveStep("review@10", "succeeded")],
          stepCompletions: [recordedReview({ stepId: "review@10" })],
        }),
      );
      assert.strictEqual(repaired.type, "board.card-step-completed");
      if (repaired.type !== "board.card-step-completed") return;
      assert.strictEqual(repaired.payload.completion.summary, "Re-recording round 10");
      assert.strictEqual(repaired.payload.completion.payload, JSON.stringify(validReviewPayload));
      // The reactor ignores a completion whose step already settled, so the
      // repair has to say it was one or the loop never restarts.
      assert.strictEqual(repaired.payload.repaired, true);
    }),
  );

  it.effect("board_complete_step will not replace a broken record with another one", () =>
    Effect.gen(function* () {
      // Repair means repair. A second payload-less success is not a fix, and
      // letting it through would rewrite the ledger for nothing.
      const retried = yield* decide(
        completeStep({ stepId: "review@10", outcome: "succeeded", summary: "Still nothing" }),
        cardReadModel({
          stepStates: [liveStep("review@10", "succeeded")],
          stepCompletions: [recordedReview({ stepId: "review@10" })],
        }),
      );
      assert.strictEqual(retried.type, "board.card-step-completed");
      if (retried.type !== "board.card-step-completed") return;
      assert.strictEqual(retried.payload.completion.summary, "Reviewed");
      assert.strictEqual(retried.payload.repaired, undefined);
    }),
  );

  it.effect("board_complete_step still pins a review step that recorded a readable payload", () =>
    Effect.gen(function* () {
      const retried = yield* decide(
        completeStep({
          stepId: "review@1",
          outcome: "succeeded",
          summary: "Second thoughts",
          payload: { reviewedSha: "def456", findings: [] },
        }),
        cardReadModel({
          stepStates: [liveStep("review@1", "succeeded")],
          stepCompletions: [recordedReview({ stepId: "review@1", payload: validReviewPayload })],
        }),
      );
      assert.strictEqual(retried.type, "board.card-step-completed");
      if (retried.type !== "board.card-step-completed") return;
      assert.strictEqual(retried.payload.completion.summary, "Reviewed");
      assert.strictEqual(retried.payload.completion.payload, JSON.stringify(validReviewPayload));
      assert.strictEqual(retried.payload.repaired, undefined);
    }),
  );

  // ── The explicit reopen affordance ───────────────────────────

  it.effect("board_reopen_step sends a broken round back as failed so it runs again", () =>
    Effect.gen(function* () {
      const reopened = yield* decide(
        reopenStep("review@10"),
        cardReadModel({
          cards: [makeCard({ id: "card-1", stage: BOARD_SEED_STAGE_IDS.review })],
          stepStates: [liveStep("review@10", "succeeded")],
          stepCompletions: [recordedReview({ stepId: "review@10" })],
        }),
      );
      assert.strictEqual(reopened.type, "board.card-step-completed");
      if (reopened.type !== "board.card-step-completed") return;
      // `failed` is what the ledger should have held all along, and it is what
      // puts the round back in front of the executor: the walk counts only
      // SUCCEEDED completions, so `review@10` is due again.
      assert.strictEqual(reopened.payload.completion.outcome, "failed");
      assert.strictEqual(reopened.payload.completion.payload, null);
      assert.include(reopened.payload.completion.summary, "Reopened");
      // Whose run it was survives — the step is re-planned, not re-assigned.
      assert.strictEqual(reopened.payload.completion.threadId, ThreadId.make("thread-1"));
      assert.strictEqual(reopened.payload.repaired, true);
    }),
  );

  it.effect("board_reopen_step refuses a round that recorded a readable payload", () =>
    Effect.gen(function* () {
      // Reopening is a repair, never a way to discard a round that landed: one
      // click must not be able to erase review the loop is entitled to count.
      const failure = yield* decideFail(
        reopenStep("review@1"),
        cardReadModel({
          cards: [makeCard({ id: "card-1", stage: BOARD_SEED_STAGE_IDS.review })],
          stepStates: [liveStep("review@1", "succeeded")],
          stepCompletions: [recordedReview({ stepId: "review@1", payload: validReviewPayload })],
        }),
      );
      assert.strictEqual(failure._tag, "BoardCommandInvariantError");
      assert.include(String(failure), "nothing to repair");
    }),
  );

  it.effect("board_reopen_step refuses a record that did not succeed", () =>
    Effect.gen(function* () {
      // A failure is not a broken success: the recovery ladder re-runs it, and
      // reopening would overwrite its summary. A phase with no payload shape
      // can never report a defect to repair.
      const failure = yield* decideFail(
        reopenStep("review@2"),
        cardReadModel({
          cards: [makeCard({ id: "card-1", stage: BOARD_SEED_STAGE_IDS.review })],
          stepStates: [liveStep("review@2", "failed")],
          stepCompletions: [
            recordedReview({ stepId: "review@2", outcome: "failed", summary: "Could not read it" }),
          ],
        }),
      );
      assert.strictEqual(failure._tag, "BoardCommandInvariantError");
      assert.include(String(failure), "not a success");
    }),
  );

  it.effect("board_reopen_step refuses a step with no recorded completion", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        reopenStep("review@3"),
        cardReadModel({
          cards: [makeCard({ id: "card-1", stage: BOARD_SEED_STAGE_IDS.review })],
          stepStates: [liveStep("review@1", "succeeded")],
          stepCompletions: [recordedReview({ stepId: "review@1" })],
        }),
      );
      assert.strictEqual(failure._tag, "BoardCommandInvariantError");
      assert.include(String(failure), "no recorded completion");
    }),
  );

  /** A rationale that clears the decider's 40-character floor — the default for
      every multi-plan proposal that is not itself testing the split gate. */
  const SPLIT_WHY =
    "These two halves ship and review independently, so a shared branch would stall both.";

  const proposePlans = (
    plans: ReadonlyArray<{
      readonly key: string;
      readonly title?: string;
      readonly summary?: string;
      readonly dependsOn?: ReadonlyArray<string>;
      readonly body?: string;
    }>,
    // Undefined means "whatever a well-behaved caller would send": a rationale
    // on a split, none on a single plan. A test aiming AT the gate passes an
    // explicit value (including null) instead.
    splitRationale?: string | null,
  ): BoardCommand =>
    ({
      type: "board.plans.propose",
      commandId: CommandId.make("cmd-propose"),
      cardId: BoardCardId.make("card-1"),
      plans: plans.map((plan) => ({
        key: plan.key,
        title: plan.title ?? plan.key,
        summary: plan.summary ?? "summary",
        dependsOn: plan.dependsOn ?? [],
        body: plan.body ?? "body",
      })),
      splitRationale:
        splitRationale === undefined ? (plans.length >= 2 ? SPLIT_WHY : null) : splitRationale,
      createdAt: NOW,
    }) as const;

  // A live step for card-1, matching the step id the completion names —
  // complete-step validates the agent's stepId against it.
  const liveStep = (stepId: string, status: BoardCardStepState["status"] = "running") =>
    ({
      cardId: BoardCardId.make("card-1"),
      stepId,
      stepLabel: "Build",
      stageLabel: "Building",
      attempt: 1,
      stallCount: 0,
      stageEntryRecoveries: 0,
      humanTurnAt: null,
      lastNudgeAt: null,
      baseTipAtRoundStart: null,
      lastError: null,
      awaitingReason: "question" as const,
      stalledReason: "gave-up" as const,
      retryAt: null,
      prompt: "do it",
      providerInstanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      mode: "build",
      runtimeMode: "auto",
      humanInLoop: false,
      maxAttempts: 3,
      timeoutMs: 1000,
      threadId: null,
      status,
      slotHeld: status === "running",
      forceStart: false,
      queuedBy: null,
      startedAt: status === "running" ? NOW : null,
      updatedAt: NOW,
    }) as const satisfies BoardCardStepState;

  it.effect("board_complete_step pins a succeeded outcome — a retry re-emits it", () =>
    Effect.gen(function* () {
      const first = yield* decide(
        completeStep({ stepId: "build", outcome: "succeeded", summary: "Built it" }),
        cardReadModel({ stepStates: [liveStep("build")] }),
      );
      assert.strictEqual(first.type, "board.card-step-completed");
      if (first.type !== "board.card-step-completed") return;
      // The first completion is now in the read model.
      const second = yield* decide(
        completeStep({ stepId: "build", outcome: "failed", summary: "A different story" }),
        cardReadModel({
          stepStates: [liveStep("build")],
          stepCompletions: [first.payload.completion],
        }),
      );
      assert.strictEqual(second.type, "board.card-step-completed");
      if (second.type !== "board.card-step-completed") return;
      // The retry re-emits the SUCCEEDED outcome verbatim — never a second,
      // and never a contradictory transition.
      assert.strictEqual(second.payload.completion.outcome, "succeeded");
      assert.strictEqual(second.payload.completion.summary, "Built it");
      assert.deepStrictEqual(second.payload.completion, first.payload.completion);
    }),
  );

  it.effect("board_complete_step lets a live step's retry supersede a prior failed outcome", () =>
    Effect.gen(function* () {
      const failed = yield* decide(
        completeStep({ stepId: "build", outcome: "failed", summary: "Broke" }),
        cardReadModel({ stepStates: [liveStep("build")] }),
      );
      assert.strictEqual(failed.type, "board.card-step-completed");
      if (failed.type !== "board.card-step-completed") return;
      // The recovery ladder nudged a retry and the step is STILL LIVE: the
      // successful retry supersedes the pinned failure (retry-after-failure
      // must be possible), and the projector upserts on (cardId, stepId).
      const retried = yield* decide(
        completeStep({ stepId: "build", outcome: "succeeded", summary: "Fixed on retry" }),
        cardReadModel({
          stepStates: [liveStep("build")],
          stepCompletions: [failed.payload.completion],
        }),
      );
      assert.strictEqual(retried.type, "board.card-step-completed");
      if (retried.type !== "board.card-step-completed") return;
      assert.strictEqual(retried.payload.completion.outcome, "succeeded");
      assert.strictEqual(retried.payload.completion.summary, "Fixed on retry");
      // With the step settled (no live step), the recorded outcome re-emits
      // verbatim instead of superseding.
      const afterSettle = yield* decide(
        completeStep({ stepId: "build", outcome: "failed", summary: "Too late" }),
        cardReadModel({
          stepStates: [liveStep("build", "succeeded")],
          stepCompletions: [retried.payload.completion],
        }),
      );
      assert.strictEqual(afterSettle.type, "board.card-step-completed");
      if (afterSettle.type !== "board.card-step-completed") return;
      assert.strictEqual(afterSettle.payload.completion.summary, "Fixed on retry");
    }),
  );

  it.effect("board_complete_step rejects a stepId that is not the card's live step", () =>
    Effect.gen(function* () {
      // Step ids are predictable, so a forged completion for a FUTURE step
      // must be rejected — pinning it would make continueStage / reconcile
      // skip the step as already-ran.
      const failure = yield* decideFail(
        completeStep({ stepId: "review@2", outcome: "succeeded", summary: "Forged" }),
        cardReadModel({ stepStates: [liveStep("review@1")] }),
      );
      assert.include(String(failure), "not card");
      assert.include(String(failure), "live step");
    }),
  );

  it.effect("board_propose_plans rejects a cycle, naming the offending edge", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        proposePlans([
          { key: "a", dependsOn: ["b"] },
          { key: "b", dependsOn: ["a"] },
        ]),
        cardReadModel(),
      );
      assert.strictEqual(failure._tag, "BoardCommandInvariantError");
      assert.include(String(failure), "cycle");
      // The edge that closes the cycle is named.
      assert.include(String(failure), "->");
    }),
  );

  it.effect("board_propose_plans rejects an unknown dependency and a duplicate key", () =>
    Effect.gen(function* () {
      const unknown = yield* decideFail(
        proposePlans([{ key: "a", dependsOn: ["ghost"] }]),
        cardReadModel(),
      );
      assert.include(String(unknown), "unknown plan 'ghost'");
      const duplicate = yield* decideFail(
        proposePlans([{ key: "a" }, { key: "a" }]),
        cardReadModel(),
      );
      assert.include(String(duplicate), "Duplicate plan key 'a'");
    }),
  );

  it.effect("board_propose_plans accepts a valid DAG and resolves plan ids and order", () =>
    Effect.gen(function* () {
      const event = yield* decide(
        proposePlans([{ key: "base" }, { key: "leaf", dependsOn: ["base"] }]),
        cardReadModel(),
      );
      assert.strictEqual(event.type, "board.plans-proposed");
      if (event.type !== "board.plans-proposed") return;
      assert.deepStrictEqual(
        event.payload.plans.map((plan) => plan.planId),
        [
          boardPlanId(BoardCardId.make("card-1"), "base"),
          boardPlanId(BoardCardId.make("card-1"), "leaf"),
        ],
      );
      assert.deepStrictEqual(
        event.payload.plans.map((plan) => plan.ordinal),
        [0, 1],
      );
      assert.deepStrictEqual(event.payload.plans[1]?.dependsOn, [
        boardPlanId(BoardCardId.make("card-1"), "base"),
      ]);
      assert.strictEqual(event.payload.plans[0]?.locked, false);
    }),
  );

  // t3o card 11 — the split gate. A multi-plan proposal is the card-splitting
  // mechanism, so the decider makes it a deliberate, on-the-record act rather
  // than the shape the tool happens to advertise.
  it.effect("board_propose_plans rejects a split with no rationale, teaching the rule", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        proposePlans([{ key: "a" }, { key: "b" }], null),
        cardReadModel(),
      );
      const message = String(failure);
      // The consequence, not just the missing field.
      assert.include(message, "2 child cards");
      assert.include(message, "human approval gate");
      // Both ways forward: pass a rationale, or propose one plan.
      assert.include(message, "splitRationale");
      assert.include(message, "single plan");
    }),
  );

  it.effect("board_propose_plans rejects a rationale that is too short or too long", () =>
    Effect.gen(function* () {
      const short = yield* decideFail(
        proposePlans([{ key: "a" }, { key: "b" }], "because"),
        cardReadModel(),
      );
      assert.include(String(short), "at least 40 characters");
      const long = yield* decideFail(
        proposePlans([{ key: "a" }, { key: "b" }], "x".repeat(2001)),
        cardReadModel(),
      );
      assert.include(String(long), "at most 2000 characters");
    }),
  );

  it.effect("board_propose_plans lands a substantive rationale on the event", () =>
    Effect.gen(function* () {
      const why = "The migration and the UI ship on separate branches and review separately.";
      const event = yield* decide(proposePlans([{ key: "a" }, { key: "b" }], why), cardReadModel());
      assert.strictEqual(event.type, "board.plans-proposed");
      if (event.type !== "board.plans-proposed") return;
      assert.strictEqual(event.payload.splitRationale, why);
    }),
  );

  it.effect("board_propose_plans stores no rationale below two plans, even if one is passed", () =>
    Effect.gen(function* () {
      // Non-null below two plans is what would make "has a rationale" stop
      // meaning "was split" — so a single plan forces null rather than
      // rejecting, and a re-proposal down to one plan CLEARS a stored one in
      // the same stroke that clears the pending split.
      const event = yield* decide(
        proposePlans(
          [{ key: "a" }],
          "A rationale long enough to clear the floor, on a single-plan proposal.",
        ),
        cardReadModel(),
      );
      assert.strictEqual(event.type, "board.plans-proposed");
      if (event.type !== "board.plans-proposed") return;
      assert.strictEqual(event.payload.splitRationale, null);

      const empty = yield* decide(
        proposePlans([], "Long enough to clear the floor, but no plans."),
        cardReadModel(),
      );
      assert.strictEqual(empty.type, "board.plans-proposed");
      if (empty.type !== "board.plans-proposed") return;
      assert.strictEqual(empty.payload.splitRationale, null);
    }),
  );

  it.effect("the split gate runs after the graph checks, so a bad graph is still named first", () =>
    Effect.gen(function* () {
      // A cycle in a rationale-less split reports the cycle: the structural
      // rejection is the more specific one and must not be masked.
      const cycle = yield* decideFail(
        proposePlans(
          [
            { key: "a", dependsOn: ["b"] },
            { key: "b", dependsOn: ["a"] },
          ],
          null,
        ),
        cardReadModel(),
      );
      assert.include(String(cycle), "cycle");
      assert.notInclude(String(cycle), "splitRationale");
    }),
  );

  it.effect(
    "board_write_plan rejects a missing plan and a locked plan, and writes an unlocked one",
    () =>
      Effect.gen(function* () {
        const planId = boardPlanId(BoardCardId.make("card-1"), "p1");
        const basePlan: BoardPlan = {
          planId,
          cardId: BoardCardId.make("card-1"),
          title: "P1",
          summary: "s",
          dependsOn: [],
          ordinal: 0,
          locked: false,
          createdAt: NOW,
          updatedAt: NOW,
        };
        const write = (): BoardCommand =>
          ({
            type: "board.plan.write",
            commandId: CommandId.make("cmd-write"),
            cardId: BoardCardId.make("card-1"),
            planId,
            body: "new body",
            createdAt: NOW,
          }) as const;

        const missing = yield* decideFail(write(), cardReadModel());
        assert.include(String(missing), "does not exist");

        const locked = yield* decideFail(
          write(),
          cardReadModel({ plans: [{ ...basePlan, locked: true }] }),
        );
        assert.include(String(locked), "locked");

        const ok = yield* decide(write(), cardReadModel({ plans: [basePlan] }));
        assert.strictEqual(ok.type, "board.plan-written");
        if (ok.type === "board.plan-written") {
          assert.strictEqual(ok.payload.body, "new body");
        }
      }),
  );

  // ── Per-card base branch ───────────────────────────

  const updateBase = (cardId: string, baseBranch: string | null): BoardCommand => ({
    type: "board.card.update",
    commandId: CommandId.make(`cmd-base-${cardId}`),
    cardId: BoardCardId.make(cardId),
    baseBranch,
    createdAt: NOW,
  });

  it.effect("AC16: a create without a base branch carries no key at all", () =>
    Effect.gen(function* () {
      // Absent and "pinned to whatever main is called today" must stay
      // different states, or a project that later moves its default would
      // strand every card ever created on a branch that no longer exists.
      const event = yield* decide(
        createCommand({ cardId: "card-new" }),
        makeReadModel({ board: seededBoard() }),
      );
      assert.strictEqual(event.type, "board.card-created");
      if (event.type === "board.card-created") {
        assert.isFalse("baseBranch" in event.payload);
      }
    }),
  );

  it.effect("a create with a base branch carries it onto the card", () =>
    Effect.gen(function* () {
      const event = yield* decide(
        { ...createCommand({ cardId: "card-new" }), baseBranch: "develop" },
        makeReadModel({ board: seededBoard() }),
      );
      assert.strictEqual(event.type, "board.card-created");
      if (event.type === "board.card-created") {
        assert.strictEqual(event.payload.baseBranch, "develop");
      }
    }),
  );

  it.effect("AC4: rejects the ref shapes that would break silently downstream", () =>
    Effect.gen(function* () {
      const card = makeCard({ id: "card-1", stage: "ready" });
      const board = seededBoard([card]);
      for (const bad of ["origin/develop", "refs/heads/develop"]) {
        assert.match(
          String(yield* decideFail(updateBase("card-1", bad), makeReadModel({ board }))),
          /not a local branch name/,
        );
        assert.match(
          String(
            yield* decideFail(
              { ...createCommand({ cardId: "card-new" }), baseBranch: bad },
              makeReadModel({ board }),
            ),
          ),
          /not a local branch name/,
        );
      }
    }),
  );

  it.effect("AC3: refuses a base branch on a sub-board child, naming its parent", () =>
    // A child resolves its parent's integration branch whatever its own field
    // says, so a stored base would be dead data the resolver ignores — and a
    // read model that says a card branches from somewhere it does not is worse
    // than a refused edit.
    Effect.gen(function* () {
      const parent = makeCard({ id: "card-parent", stage: "building" });
      const child = makeCard({
        id: "card-child",
        stage: "building",
        parentCardId: BoardCardId.make("card-parent"),
      });
      const failure = yield* decideFail(
        updateBase("card-child", "develop"),
        makeReadModel({ board: seededBoard([parent, child]) }),
      );
      assert.match(String(failure), /sub-board child of 'card-parent'/);
    }),
  );

  it.effect("clears the pin back to the project default on null", () =>
    Effect.gen(function* () {
      const card = makeCard({ id: "card-1", stage: "ready", baseBranch: "develop" });
      const event = yield* decide(
        updateBase("card-1", null),
        makeReadModel({ board: seededBoard([card]) }),
      );
      assert.strictEqual(event.type, "board.card-updated");
      if (event.type === "board.card-updated") {
        assert.strictEqual(event.payload.card.baseBranch, null);
      }
    }),
  );

  it.effect("an update that ONLY moves the base branch is a real change, not a no-op", () =>
    // The no-changes guard rejects an update carrying nothing. A base-only edit
    // has to get past it, or the picker on an otherwise untouched card would
    // silently do nothing.
    Effect.gen(function* () {
      const card = makeCard({ id: "card-1", stage: "ready" });
      const event = yield* decide(
        updateBase("card-1", "develop"),
        makeReadModel({ board: seededBoard([card]) }),
      );
      assert.strictEqual(event.type, "board.card-updated");
      if (event.type === "board.card-updated") {
        assert.strictEqual(event.payload.card.baseBranch, "develop");
      }
    }),
  );
  // ── Arriving in Done ────────────────────────────────────────
  // Done is read newest-first, so a card that finishes lands on top of it.
  // Every other column keeps taking the card's own key — inside Building that
  // key is queue priority, and an advance must not reshuffle the queue.

  const movedOrderKey = (event: { readonly type: string; readonly payload: unknown }) => {
    assert.strictEqual(event.type, "board.card-moved");
    return (event.payload as { readonly card: { readonly orderKey: string } }).card.orderKey;
  };

  /** Keys in the order the column renders them (plain string comparison). */
  const inColumnOrder = (keys: ReadonlyArray<string>) => [...keys].sort();

  it.effect("lands a card advancing into Done above every card already there", () =>
    Effect.gen(function* () {
      const done = ["m", "mm", "g"].map((orderKey, index) =>
        makeCard({ id: `card-done-${String(index)}`, stage: "done", orderKey }),
      );
      const event = yield* decide(
        moveCommand({ cardId: "card-1", toStage: "done" }),
        makeReadModel({
          board: seededBoard([makeCard({ id: "card-1", stage: "merge", orderKey: "zz" }), ...done]),
        }),
      );
      const orderKey = movedOrderKey(event);
      assert.strictEqual(
        inColumnOrder([orderKey, ...done.map((card) => card.orderKey)])[0],
        orderKey,
      );
    }),
  );

  it.effect("keeps the card's own key when it advances into any other column", () =>
    Effect.gen(function* () {
      // Building position is queue priority: an advance names no position, so
      // the card arrives with the one it already had.
      const event = yield* decide(
        moveCommand({ cardId: "card-1", toStage: "building" }),
        makeReadModel({
          board: seededBoard([
            makeCard({ id: "card-1", stage: "ready", orderKey: "zz" }),
            makeCard({ id: "card-other", stage: "building", orderKey: "m" }),
          ]),
        }),
      );
      assert.strictEqual(movedOrderKey(event), "zz");
    }),
  );

  it.effect("takes the position a drag into Done named, rather than the top", () =>
    Effect.gen(function* () {
      // A drag names a slot and means it; the optimistic placement already
      // drew the card there, and the server must not snap it somewhere else.
      const event = yield* decide(
        moveCommand({ cardId: "card-1", toStage: "done", orderKey: "t" }),
        makeReadModel({
          board: seededBoard([
            makeCard({ id: "card-1", stage: "merge" }),
            makeCard({ id: "card-done", stage: "done", orderKey: "m" }),
          ]),
        }),
      );
      assert.strictEqual(movedOrderKey(event), "t");
    }),
  );

  it.effect("measures the top of Done against the column the card is really in", () =>
    Effect.gen(function* () {
      // The root board merges every project into one Done column, so the top of
      // Done is the top across projects. A sub-board is its own column.
      const event = yield* decide(
        moveCommand({ cardId: "card-1", toStage: "done" }),
        makeReadModel({
          board: seededBoard([
            makeCard({ id: "card-1", stage: "merge", orderKey: "zz" }),
            makeCard({ id: "card-mine", stage: "done", orderKey: "m" }),
            makeCard({
              id: "card-other-project",
              stage: "done",
              orderKey: "b",
              projectId: otherProjectId,
            }),
            makeCard({
              id: "card-sub-board",
              stage: "done",
              orderKey: "a",
              parentCardId: BoardCardId.make("card-parent"),
            }),
          ]),
        }),
      );
      const orderKey = movedOrderKey(event);
      // Above the other project's card, not merely above its own project's…
      assert.deepStrictEqual(inColumnOrder([orderKey, "b", "m"]), [orderKey, "b", "m"]);
      // …and unbothered by the sub-board child that sorts below everything.
      assert.deepStrictEqual(inColumnOrder([orderKey, "a"]), ["a", orderKey]);
    }),
  );

  it.effect("lands a sub-board child above its siblings in Done, not above the board", () =>
    Effect.gen(function* () {
      const parentCardId = BoardCardId.make("card-parent");
      const event = yield* decide(
        moveCommand({ cardId: "card-child", toStage: "done" }),
        makeReadModel({
          board: seededBoard([
            makeCard({ id: "card-parent", stage: "building" }),
            makeCard({ id: "card-child", stage: "merge", orderKey: "zz", parentCardId }),
            makeCard({ id: "card-sibling", stage: "done", orderKey: "m", parentCardId }),
            makeCard({ id: "card-top-level", stage: "done", orderKey: "b" }),
          ]),
        }),
      );
      const orderKey = movedOrderKey(event);
      assert.deepStrictEqual(inColumnOrder([orderKey, "b", "m"]), ["b", orderKey, "m"]);
    }),
  );

  it.effect("ignores archived cards when it measures the top of Done", () =>
    Effect.gen(function* () {
      // An archived card is not in the column the user sees, so it must not
      // push the arriving card's key any lower than the visible top.
      const event = yield* decide(
        moveCommand({ cardId: "card-1", toStage: "done" }),
        makeReadModel({
          board: seededBoard([
            makeCard({ id: "card-1", stage: "merge", orderKey: "zz" }),
            makeCard({ id: "card-live", stage: "done", orderKey: "m" }),
            makeCard({ id: "card-archived", stage: "done", orderKey: "b", archivedAt: NOW }),
          ]),
        }),
      );
      const orderKey = movedOrderKey(event);
      assert.deepStrictEqual(inColumnOrder([orderKey, "b", "m"]), ["b", orderKey, "m"]);
    }),
  );

  it.effect("stacks successive arrivals newest-first", () =>
    Effect.gen(function* () {
      // The behaviour as a user meets it: finish three cards in a row and read
      // Done top to bottom to see the order they finished in, reversed.
      let cards = [
        makeCard({ id: "card-1", stage: "merge" }),
        makeCard({ id: "card-2", stage: "merge" }),
        makeCard({ id: "card-3", stage: "merge" }),
      ];
      const arrived: Array<string> = [];
      for (const id of ["card-1", "card-2", "card-3"]) {
        const event = yield* decide(
          moveCommand({ cardId: id, toStage: "done" }),
          makeReadModel({ board: seededBoard(cards) }),
        );
        const orderKey = movedOrderKey(event);
        arrived.push(id);
        cards = cards.map((card) =>
          card.id === id ? { ...card, stage: BoardStageId.make("done"), orderKey } : card,
        );
      }
      const column = cards
        .filter((card) => card.stage === "done")
        .sort((left, right) => (left.orderKey < right.orderKey ? -1 : 1))
        .map((card) => card.id as string);
      assert.deepStrictEqual(column, arrived.toReversed());
    }),
  );

  // The decider places a new card against the whole board, not the caller's
  // scoped view, so it never lands on top of older work.
  const createdOrderKey = (event: { readonly type: string; readonly payload: unknown }) => {
    assert.strictEqual(event.type, "board.card-created");
    return (event.payload as { readonly orderKey: string }).orderKey;
  };

  it.effect("lands a new card below every card already in the stage", () =>
    Effect.gen(function* () {
      const event = yield* decide(
        createCommand({ cardId: "card-new", stage: "backlog" }),
        makeReadModel({
          board: seededBoard([
            makeCard({ id: "card-1", stage: "backlog", orderKey: "m" }),
            makeCard({ id: "card-2", stage: "backlog", orderKey: "u" }),
          ]),
        }),
      );
      const orderKey = createdOrderKey(event);
      assert.deepStrictEqual(inColumnOrder([orderKey, "m", "u"]), ["m", "u", orderKey]);
    }),
  );

  it.effect("lands below another project's cards too, because the board merges them", () =>
    Effect.gen(function* () {
      // The reported defect, exactly: a card created into ITS project's empty
      // Building column sat above a 48-minute-older card of another project,
      // because the two projects had separate key spaces and the board's
      // default scope renders them as one column.
      const event = yield* decide(
        createCommand({ cardId: "card-new", stage: "backlog" }),
        makeReadModel({
          board: seededBoard([
            makeCard({
              id: "card-older",
              stage: "backlog",
              orderKey: "n",
              projectId: otherProjectId,
            }),
          ]),
        }),
      );
      assert.deepStrictEqual(inColumnOrder([createdOrderKey(event), "n"]), [
        "n",
        createdOrderKey(event),
      ]);
    }),
  );

  it.effect("ignores cards in other stages when placing", () =>
    Effect.gen(function* () {
      const event = yield* decide(
        createCommand({ cardId: "card-new", stage: "backlog" }),
        makeReadModel({
          board: seededBoard([makeCard({ id: "card-1", stage: "sprint", orderKey: "zzzz" })]),
        }),
      );
      assert.strictEqual(createdOrderKey(event), "m");
    }),
  );

  it.effect("ignores archived cards, which have left the board", () =>
    Effect.gen(function* () {
      const event = yield* decide(
        createCommand({ cardId: "card-new", stage: "backlog" }),
        makeReadModel({
          board: seededBoard([
            makeCard({
              id: "card-archived",
              stage: "backlog",
              orderKey: "zzzz",
              archivedAt: NOW,
            }),
          ]),
        }),
      );
      assert.strictEqual(createdOrderKey(event), "m");
    }),
  );

  it.effect("places a sub-board child in its parent's column, not the root board's", () =>
    Effect.gen(function* () {
      const event = yield* decide(
        createCommand({ cardId: "card-new", stage: "building", parentCardId: "card-parent" }),
        makeReadModel({
          board: seededBoard([
            makeCard({ id: "card-parent", stage: "building", orderKey: "m" }),
            makeCard({ id: "card-root", stage: "building", orderKey: "zzzz" }),
            makeCard({
              id: "card-sibling",
              stage: "building",
              orderKey: "u",
              parentCardId: BoardCardId.make("card-parent"),
            }),
          ]),
        }),
      );
      const orderKey = createdOrderKey(event);
      // Below its one sibling, and unconstrained by the root board's column.
      assert.deepStrictEqual(inColumnOrder([orderKey, "u"]), ["u", orderKey]);
      assert.deepStrictEqual(inColumnOrder([orderKey, "zzzz"]), [orderKey, "zzzz"]);
    }),
  );

  it.effect("lands a card created straight into Done at the TOP, like one moved there", () =>
    Effect.gen(function* () {
      const board = seededBoard([makeCard({ id: "card-1", stage: "done", orderKey: "d" })]);
      const created = createdOrderKey(
        yield* decide(
          createCommand({ cardId: "card-new", stage: "done" }),
          makeReadModel({ board }),
        ),
      );
      assert.deepStrictEqual(inColumnOrder([created, "d"]), [created, "d"]);
      // Same rule as the move, so two cards reaching Done by different routes
      // cannot be ordered by different rules.
      const moved = movedOrderKey(
        yield* decide(
          moveCommand({ cardId: "card-2", toStage: "done" }),
          makeReadModel({
            board: seededBoard([
              makeCard({ id: "card-1", stage: "done", orderKey: "d" }),
              makeCard({ id: "card-2", stage: "merge", orderKey: "zz" }),
            ]),
          }),
        ),
      );
      assert.strictEqual(created, moved);
    }),
  );

  it.effect("still honours a position the caller named", () =>
    Effect.gen(function* () {
      const event = yield* decide(
        createCommand({ cardId: "card-new", stage: "backlog", orderKey: "b" }),
        makeReadModel({
          board: seededBoard([makeCard({ id: "card-1", stage: "backlog", orderKey: "m" })]),
        }),
      );
      assert.strictEqual(createdOrderKey(event), "b");
    }),
  );

  it.effect("keeps successive creations in creation order", () =>
    Effect.gen(function* () {
      // The behaviour as a user meets it: make three cards in a row and read
      // the column top to bottom to see the order they were made in.
      const cards: Array<BoardCard> = [];
      const made: Array<string> = [];
      for (const id of ["card-1", "card-2", "card-3"]) {
        const event = yield* decide(
          createCommand({ cardId: id, stage: "backlog" }),
          makeReadModel({ board: seededBoard(cards) }),
        );
        made.push(id);
        cards.push(makeCard({ id, stage: "backlog", orderKey: createdOrderKey(event) }));
      }
      const keys = cards.map((card) => card.orderKey);
      assert.strictEqual(new Set(keys).size, keys.length);
      assert.deepStrictEqual(inColumnOrder(keys), keys);
      const column = [...cards]
        .sort((left, right) => (left.orderKey < right.orderKey ? -1 : 1))
        .map((card) => card.id as string);
      assert.deepStrictEqual(column, made);
    }),
  );
  // ── Scheduled starts ─────────────────────────────────────────────

  describe("scheduled starts (T3O-19, D1)", () => {
    const AT = "2026-03-04T09:00:00.000Z";
    const LATER = "2026-03-05T21:00:00.000Z";
    const PAST = "2020-01-01T00:00:00.000Z";

    const updateSchedule = (scheduledStartAt: string | null) =>
      ({
        type: "board.card.update",
        commandId: CommandId.make("cmd-schedule"),
        cardId: BoardCardId.make("card-1"),
        scheduledStartAt,
        createdAt: NOW,
      }) satisfies BoardCommand;

    const boardWithCard = (scheduledStartAt: string | null) =>
      makeReadModel({
        board: seededBoard([makeCard({ id: "card-1", scheduledStartAt })]),
      });

    it.effect("a create carries the schedule onto the card, and omits the key without one", () =>
      Effect.gen(function* () {
        const scheduled = yield* decide(
          createCommand({ cardId: "card-new", scheduledStartAt: AT }),
          makeReadModel({ board: seededBoard() }),
        );
        assert.strictEqual(scheduled.type, "board.card-created");
        if (scheduled.type !== "board.card-created") return;
        assert.strictEqual(scheduled.payload.scheduledStartAt, AT);

        const plain = yield* decide(
          createCommand({ cardId: "card-plain" }),
          makeReadModel({ board: seededBoard() }),
        );
        assert.strictEqual(plain.type, "board.card-created");
        if (plain.type !== "board.card-created") return;
        // Key-optional, so a card created without a time replays identically to
        // every event written before this spec existed.
        assert.isFalse("scheduledStartAt" in plain.payload);
      }),
    );

    it.effect("an update sets, changes and clears the time, and says it touched it", () =>
      Effect.gen(function* () {
        const set = yield* decide(updateSchedule(AT), boardWithCard(null));
        assert.strictEqual(set.type, "board.card-updated");
        if (set.type !== "board.card-updated") return;
        assert.strictEqual(set.payload.card.scheduledStartAt, AT);
        // The marker the supervisor reads to tell a schedule edit from any other
        // edit; without it, clearing and a title change look the same.
        assert.strictEqual(set.payload.scheduledStartAt, AT);

        const changed = yield* decide(updateSchedule(LATER), boardWithCard(AT));
        assert.strictEqual(changed.type, "board.card-updated");
        if (changed.type !== "board.card-updated") return;
        assert.strictEqual(changed.payload.card.scheduledStartAt, LATER);

        const cleared = yield* decide(updateSchedule(null), boardWithCard(AT));
        assert.strictEqual(cleared.type, "board.card-updated");
        if (cleared.type !== "board.card-updated") return;
        assert.isNull(cleared.payload.card.scheduledStartAt);
        assert.isNull(cleared.payload.scheduledStartAt);
      }),
    );

    it.effect("an unrelated edit leaves the time alone and does not claim to touch it", () =>
      Effect.gen(function* () {
        const event = yield* decide(
          {
            type: "board.card.update",
            commandId: CommandId.make("cmd-title"),
            cardId: BoardCardId.make("card-1"),
            title: "Renamed",
            createdAt: NOW,
          },
          boardWithCard(AT),
        );
        assert.strictEqual(event.type, "board.card-updated");
        if (event.type !== "board.card-updated") return;
        assert.strictEqual(event.payload.card.scheduledStartAt, AT);
        assert.isFalse("scheduledStartAt" in event.payload);
      }),
    );

    it.effect("a past time is accepted — it means now, and the picker refuses none", () =>
      Effect.gen(function* () {
        const event = yield* decide(updateSchedule(PAST), boardWithCard(null));
        assert.strictEqual(event.type, "board.card-updated");
        if (event.type !== "board.card-updated") return;
        assert.strictEqual(event.payload.card.scheduledStartAt, PAST);
      }),
    );

    it.effect("a schedule on its own is a real change, not an empty update", () =>
      Effect.gen(function* () {
        // The no-changes guard lists every field; a schedule missing from it would
        // reject the one command this whole feature is driven by.
        const event = yield* decide(updateSchedule(AT), boardWithCard(null));
        assert.strictEqual(event.type, "board.card-updated");
      }),
    );
  });

  describe("auto-merge (T3O-38, D3/D4/D10)", () => {
    const HOLD = {
      reason: "Required status check 'test' has not passed.",
      classification: "soft",
      detail: "3 of 5 checks green",
      attempt: 2,
      heldSince: NOW,
      retryAt: NOW,
      headSha: "sha-one",
    } as const;

    const at = (stage: string, overrides: Partial<BoardCard> = {}) =>
      makeCard({ id: "card-1", stage, ...overrides });

    const boardWith = (card: BoardCard) => makeReadModel({ board: seededBoard([card]) });

    const recordHold = (hold: BoardCard["autoMergeHold"]) =>
      ({
        type: "board.card.record-auto-merge-hold",
        commandId: CommandId.make("cmd-hold"),
        cardId: BoardCardId.make("card-1"),
        hold,
        createdAt: NOW,
      }) satisfies BoardCommand;

    it.effect("records a hold and clears it back to null", () =>
      Effect.gen(function* () {
        const recorded = yield* decide(recordHold(HOLD), boardWith(at("merge")));
        assert.strictEqual(recorded.type, "board.card-auto-merge-hold-recorded");
        if (recorded.type !== "board.card-auto-merge-hold-recorded") return;
        assert.deepStrictEqual(recorded.payload.card.autoMergeHold, HOLD);

        const cleared = yield* decide(
          recordHold(null),
          boardWith(at("merge", { autoMergeHold: HOLD })),
        );
        assert.strictEqual(cleared.type, "board.card-auto-merge-hold-recorded");
        if (cleared.type !== "board.card-auto-merge-hold-recorded") return;
        assert.strictEqual(cleared.payload.card.autoMergeHold, null);
      }),
    );

    it.effect("refuses a hold that changes nothing, so a re-probe lands no event", () =>
      Effect.gen(function* () {
        // The sweep re-probes a held card every rung and the overwhelming
        // majority of those answers are the hold the card already carries.
        const error = yield* decideFail(
          recordHold(HOLD),
          boardWith(at("merge", { autoMergeHold: HOLD })),
        );
        assert.include(String(error), "already records this auto-merge hold");
        // …and clearing a card that has no hold is equally a no-op.
        const second = yield* decideFail(recordHold(null), boardWith(at("merge")));
        assert.include(String(second), "already records this auto-merge hold");
      }),
    );

    it.effect("records the NEXT rung as a real change", () =>
      Effect.gen(function* () {
        // `retryAt` moving IS the change worth recording: nothing here is
        // excluded from the comparison the way `checkedAt` is on a PR link.
        const event = yield* decide(
          recordHold({ ...HOLD, attempt: 3, retryAt: "2026-01-01T00:10:00.000Z" }),
          boardWith(at("merge", { autoMergeHold: HOLD })),
        );
        assert.strictEqual(event.type, "board.card-auto-merge-hold-recorded");
        if (event.type !== "board.card-auto-merge-hold-recorded") return;
        assert.strictEqual(event.payload.card.autoMergeHold?.attempt, 3);
      }),
    );
  });

  describe("explicitly linked pull requests (T3O-18)", () => {
    const pr = (
      number: number,
      overrides: Partial<NonNullable<BoardCard["pullRequest"]>> = {},
    ): NonNullable<BoardCard["pullRequest"]> => ({
      number,
      url: `https://github.com/acme/repo/pull/${number}`,
      state: "open",
      title: `PR ${number}`,
      headBranch: `stack/layer-${number}`,
      baseRef: "main",
      checkedAt: NOW,
      ...overrides,
    });

    const boardWith = (card: BoardCard) => makeReadModel({ board: seededBoard([card]) });
    const card = (overrides: Partial<BoardCard> = {}) =>
      makeCard({ id: "card-1", stage: "review", ...overrides });

    const setLinked = (pullRequest: BoardCard["pullRequest"]) =>
      ({
        type: "board.card.set-linked-pull-request",
        commandId: CommandId.make("cmd-link"),
        cardId: BoardCardId.make("card-1"),
        pullRequest,
        createdAt: NOW,
      }) satisfies BoardCommand;

    const record = (pullRequest: BoardCard["pullRequest"]) =>
      ({
        type: "board.card.record-pull-request",
        commandId: CommandId.make("cmd-record"),
        cardId: BoardCardId.make("card-1"),
        pullRequest,
        createdAt: NOW,
      }) satisfies BoardCommand;

    it.effect("stamps the link as explicit and records it on the card", () =>
      Effect.gen(function* () {
        const event = yield* decide(setLinked(pr(75)), boardWith(card()));
        assert.strictEqual(event.type, "board.card-pull-request-recorded");
        if (event.type !== "board.card-pull-request-recorded") return;
        assert.strictEqual(event.payload.transition, "linked");
        assert.strictEqual(event.payload.card.pullRequest?.number, 75);
        assert.strictEqual(event.payload.card.pullRequest?.linked, true);
        assert.notProperty(event.payload, "previous");
      }),
    );

    it.effect("replaces a branch-found pull request, and an open one below the floor", () =>
      Effect.gen(function* () {
        const event = yield* decide(
          setLinked(pr(75)),
          boardWith(card({ pullRequest: pr(90), pullRequestFloor: 80 })),
        );
        assert.strictEqual(event.type, "board.card-pull-request-recorded");
        if (event.type !== "board.card-pull-request-recorded") return;
        assert.strictEqual(event.payload.card.pullRequest?.number, 75);
        // The replaced PR rides the event, so the card's threads can drop it.
        assert.strictEqual(event.payload.previous?.number, 90);
      }),
    );

    it.effect("refuses a finished pull request at or below the round floor", () =>
      Effect.gen(function* () {
        // Round one's merged #75 linked again after round two began would
        // settle the card and delete the branch holding round two's work.
        for (const state of ["merged", "closed"] as const) {
          const error = yield* decideFail(
            setLinked(pr(75, { state })),
            boardWith(card({ pullRequest: null, pullRequestFloor: 80 })),
          );
          assert.include(String(error), "at or below its floor of #80");
        }
        // Above the floor it is a different round's pull request and links.
        const event = yield* decide(
          setLinked(pr(85, { state: "merged" })),
          boardWith(card({ pullRequest: null, pullRequestFloor: 80 })),
        );
        assert.strictEqual(event.type, "board.card-pull-request-recorded");
      }),
    );

    it.effect("refuses to replace or clear a merged pull request the card records", () =>
      Effect.gen(function* () {
        // Dropping merged #90 would keep it out of the history the floor is
        // computed from, so a later branch lookup could adopt it again.
        for (const previous of [
          pr(90, { state: "merged" }),
          pr(90, { state: "merged", linked: true }),
        ]) {
          const error = yield* decideFail(
            setLinked(pr(75)),
            boardWith(card({ pullRequest: previous })),
          );
          assert.include(String(error), "already records merged pull request #90");
        }
        const error = yield* decideFail(
          setLinked(null),
          boardWith(card({ pullRequest: pr(90, { state: "merged", linked: true }) })),
        );
        assert.include(String(error), "already records merged pull request #90");
        // Linking that same merged pull request explicitly still lands.
        const event = yield* decide(
          setLinked(pr(90, { state: "merged" })),
          boardWith(card({ pullRequest: pr(90, { state: "merged" }) })),
        );
        assert.strictEqual(event.type, "board.card-pull-request-recorded");
      }),
    );

    it.effect("refuses linking the pull request the card already has linked — no duplicate", () =>
      Effect.gen(function* () {
        const error = yield* decideFail(
          setLinked(pr(75)),
          boardWith(card({ pullRequest: pr(75, { linked: true }) })),
        );
        assert.include(String(error), "already has pull request #75 linked");
      }),
    );

    it.effect("clears an explicit link, and refuses to clear one that is not there", () =>
      Effect.gen(function* () {
        const event = yield* decide(
          setLinked(null),
          boardWith(card({ pullRequest: pr(75, { linked: true }) })),
        );
        assert.strictEqual(event.type, "board.card-pull-request-recorded");
        if (event.type !== "board.card-pull-request-recorded") return;
        assert.strictEqual(event.payload.transition, "unlinked");
        assert.isNull(event.payload.card.pullRequest);
        assert.strictEqual(event.payload.previous?.number, 75);

        const error = yield* decideFail(setLinked(null), boardWith(card({ pullRequest: pr(90) })));
        assert.include(String(error), "no explicitly linked pull request");
      }),
    );

    it.effect("a branch lookup can neither replace nor clear a linked pull request", () =>
      Effect.gen(function* () {
        const linked = boardWith(card({ pullRequest: pr(75, { linked: true }) }));
        assert.include(String(yield* decideFail(record(pr(90)), linked)), "linked explicitly");
        assert.include(String(yield* decideFail(record(null), linked)), "linked explicitly");
        // The same number without the marker is a branch lookup too.
        assert.include(
          String(yield* decideFail(record(pr(75, { state: "merged" })), linked)),
          "linked explicitly",
        );
      }),
    );

    it.effect("a by-number refresh of the linked pull request records its new state", () =>
      Effect.gen(function* () {
        const event = yield* decide(
          record(pr(75, { state: "merged", linked: true })),
          boardWith(card({ pullRequest: pr(75, { linked: true }) })),
        );
        assert.strictEqual(event.type, "board.card-pull-request-recorded");
        if (event.type !== "board.card-pull-request-recorded") return;
        assert.strictEqual(event.payload.transition, "state-changed");
        assert.strictEqual(event.payload.card.pullRequest?.state, "merged");
        assert.notProperty(event.payload, "previous");
        assert.strictEqual(event.payload.card.pullRequest?.linked, true);
      }),
    );
  });

  describe("per-card merge strategy (T3O-80)", () => {
    const HOLD = {
      reason: "Merge commits are not allowed on this repository.",
      classification: "other",
      detail: null,
      attempt: 1,
      heldSince: NOW,
      retryAt: null,
      headSha: "sha-one",
    } as const;

    const setStrategy = (mergeStrategy: BoardCard["mergeStrategy"]) =>
      ({
        type: "board.card.update",
        commandId: CommandId.make("cmd-merge-strategy"),
        cardId: BoardCardId.make("card-1"),
        mergeStrategy,
        createdAt: NOW,
      }) satisfies BoardCommand;

    const boardWith = (...cards: ReadonlyArray<BoardCard>) =>
      makeReadModel({ board: seededBoard([...cards]) });

    const updatedCard = (event: { readonly type: string; readonly payload: unknown }) => {
      assert.strictEqual(event.type, "board.card-updated");
      return (event.payload as { readonly card: BoardCard }).card;
    };

    it.effect("sets the strategy, and a strategy-only edit is a real change", () =>
      Effect.gen(function* () {
        const event = yield* decide(
          setStrategy("merge"),
          boardWith(makeCard({ id: "card-1", stage: "ready" })),
        );
        assert.strictEqual(updatedCard(event).mergeStrategy, "merge");
      }),
    );

    it.effect("null clears it back to the default, in any stage", () =>
      Effect.gen(function* () {
        for (const stage of ["backlog", "building", "merge", "done"]) {
          const event = yield* decide(
            setStrategy(null),
            boardWith(makeCard({ id: "card-1", stage, mergeStrategy: "rebase" })),
          );
          assert.strictEqual(updatedCard(event).mergeStrategy, null, stage);
        }
      }),
    );

    it.effect("a change clears the auto-merge hold", () =>
      Effect.gen(function* () {
        const event = yield* decide(
          setStrategy("squash"),
          boardWith(
            makeCard({
              id: "card-1",
              stage: "merge",
              autoMergeSetting: true,
              autoMergeHold: HOLD,
              mergeStrategy: "merge",
            }),
          ),
        );
        const card = updatedCard(event);
        assert.strictEqual(card.mergeStrategy, "squash");
        assert.strictEqual(card.autoMergeHold, null);
        assert.isTrue(card.autoMergeSetting);
        // The cleared hold was the retry, so the event tells the supervisor.
        assert.strictEqual(event.type, "board.card-updated");
        if (event.type === "board.card-updated") {
          assert.strictEqual(event.payload.autoMergeHoldReleased, true);
        }
      }),
    );

    it.effect("a change on a card with no hold does not ask for a merge", () =>
      Effect.gen(function* () {
        const event = yield* decide(
          setStrategy("squash"),
          boardWith(
            makeCard({
              id: "card-1",
              stage: "merge",
              autoMergeSetting: true,
              mergeStrategy: "merge",
            }),
          ),
        );
        assert.strictEqual(event.type, "board.card-updated");
        if (event.type === "board.card-updated") {
          assert.isFalse("autoMergeHoldReleased" in event.payload);
          // Still a change, which an inheriting child's hold has to hear about.
          assert.strictEqual(event.payload.mergeStrategyEdited, true);
        }
      }),
    );

    it.effect("re-writing the same strategy leaves the hold alone", () =>
      Effect.gen(function* () {
        const event = yield* decide(
          setStrategy("merge"),
          boardWith(
            makeCard({ id: "card-1", stage: "merge", autoMergeHold: HOLD, mergeStrategy: "merge" }),
          ),
        );
        assert.deepStrictEqual(updatedCard(event).autoMergeHold, HOLD);
        if (event.type === "board.card-updated") {
          assert.isFalse("mergeStrategyEdited" in event.payload);
        }
      }),
    );

    it.effect("an edit that does not name the strategy keeps it", () =>
      Effect.gen(function* () {
        const event = yield* decide(
          {
            type: "board.card.update",
            commandId: CommandId.make("cmd-title"),
            cardId: BoardCardId.make("card-1"),
            title: "Renamed",
            createdAt: NOW,
          },
          boardWith(makeCard({ id: "card-1", stage: "ready", mergeStrategy: "rebase" })),
        );
        assert.strictEqual(updatedCard(event).mergeStrategy, "rebase");
      }),
    );

    it.effect("a sub-board child may set its own", () =>
      Effect.gen(function* () {
        const parent = makeCard({ id: "card-parent", stage: "building" });
        const child = makeCard({
          id: "card-1",
          stage: "building",
          parentCardId: BoardCardId.make("card-parent"),
        });
        const event = yield* decide(setStrategy("merge"), boardWith(parent, child));
        assert.strictEqual(updatedCard(event).mergeStrategy, "merge");
      }),
    );

    it.effect("a create carries the strategy, and omits the key without one", () =>
      Effect.gen(function* () {
        const withStrategy = yield* decide(
          { ...createCommand({ cardId: "card-new" }), mergeStrategy: "merge" },
          boardWith(),
        );
        assert.strictEqual(withStrategy.type, "board.card-created");
        if (withStrategy.type === "board.card-created") {
          assert.strictEqual(withStrategy.payload.mergeStrategy, "merge");
        }
        const without = yield* decide(createCommand({ cardId: "card-new" }), boardWith());
        if (without.type === "board.card-created") {
          assert.isFalse("mergeStrategy" in without.payload);
        }
      }),
    );
  });
});
