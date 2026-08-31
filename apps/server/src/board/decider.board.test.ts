/**
 * T3o board decider invariants (t3o-03): stage adjacency and override,
 * dependency cycle rejection, blocked derivation at the Ready boundary, key
 * allocation, one-thread-one-card, tombstoning, archive/unarchive — and the
 * D18 assertion that no decider path emits a move into `building` except an
 * explicit user-originated `board.card.move`.
 */
import {
  BOARD_SEED_LABEL_IDS,
  BOARD_SEED_LABELS,
  BoardCardId,
  BoardStageId,
  BoardLabelId,
  boardPlanId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  BOARD_REVIEW_MAX_ROUNDS,
  BOARD_SEED_STAGE_IDS,
  type BoardCard,
  type BoardCardStepState,
  type BoardLabel,
  type BoardPlan,
  type BoardState,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { boardDecidedEvents, decideBoardCommand, type BoardCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
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
    threadLinks: [],
    externalRef: null,
    humanInLoop: null,
    reviewOverrides: null,
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
    lastNudgeAt: null,
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
}): OrchestrationReadModel {
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
    re-flag for archive/unarchive per t3o-13 D5, an edge rewrite for delete) —
    while every other command decides exactly one. */
const decideEvents = (command: BoardCommand, readModel: OrchestrationReadModel) =>
  decideBoardCommand({ command, readModel }).pipe(Effect.map(boardDecidedEvents));

/** The first (and, for every command but archive/unarchive/delete, only)
    decided event. */
const decide = (command: BoardCommand, readModel: OrchestrationReadModel) =>
  decideEvents(command, readModel).pipe(Effect.map((events) => events[0]!));

const decideFail = (command: BoardCommand, readModel: OrchestrationReadModel) =>
  Effect.flip(decide(command, readModel));

const createCommand = (input: {
  readonly cardId: string;
  readonly projectId?: typeof projectId;
  readonly keyPrefix?: string;
  readonly stage?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly brief?: string;
  readonly dependsOn?: ReadonlyArray<string>;
}) =>
  ({
    type: "board.card.create",
    commandId: CommandId.make(`cmd-create-${input.cardId}`),
    cardId: BoardCardId.make(input.cardId),
    projectId: input.projectId ?? projectId,
    title: `Card ${input.cardId}`,
    orderKey: "m",
    ...(input.keyPrefix === undefined ? {} : { keyPrefix: input.keyPrefix }),
    ...(input.stage === undefined ? {} : { stage: BoardStageId.make(input.stage) }),
    ...(input.labels === undefined
      ? {}
      : { labels: input.labels.map((id) => BoardLabelId.make(id)) }),
    ...(input.brief === undefined ? {} : { brief: input.brief }),
    ...(input.dependsOn === undefined
      ? {}
      : { dependsOn: input.dependsOn.map((id) => BoardCardId.make(id)) }),
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
}) =>
  ({
    type: "board.card.move",
    commandId: CommandId.make(`cmd-move-${input.cardId}`),
    cardId: BoardCardId.make(input.cardId),
    toStage: BoardStageId.make(input.toStage),
    ...(input.override === undefined ? {} : { override: input.override }),
    createdAt: NOW,
  }) as const;

it.layer(NodeServices.layer)("board decider", (it) => {
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
      assert.strictEqual(failure._tag, "OrchestrationCommandInvariantError");
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

  it.effect("keeps sub-board plan cards out of the early stages, override or not", () =>
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
      const failure = yield* decideFail(
        moveCommand({ cardId: "card-child", toStage: "sprint", override: true }),
        makeReadModel({ board }),
      );
      assert.include(String(failure), "sub-board plan card");

      // Ready-onward stays open to it.
      const allowed = yield* decide(
        moveCommand({ cardId: "card-child", toStage: "building" }),
        makeReadModel({ board }),
      );
      assert.strictEqual(allowed.type, "board.card-moved");
    }),
  );

  // ── Blocked derivation is build-role-keyed, not Ready-keyed (D11) ─────

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
      // block. Ready is now an ordinary pre-build stage (D3/D11), so the block
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
      // outright (D11) — covered by the "rejects moving a card ... past Ready"
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
      assert.strictEqual(failure._tag, "OrchestrationCommandInvariantError");
      assert.include(String(failure), 'CARD-7 "Ship the decider"');

      // A drag's override forces adjacency, never the dependency gate.
      const overridden = yield* decideFail(
        moveCommand({ cardId: "card-1", toStage: "review", override: true }),
        makeReadModel({ board }),
      );
      assert.strictEqual(overridden._tag, "OrchestrationCommandInvariantError");

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

  // ── Dependency cycles ────────────────────────────────────────────────

  // ── Per-card review-loop overrides (t3o-22, D3/D5) ───────────────────
  //
  // The floor is the whole point: the pane's `−` is disabled below it, but the
  // client is not the guard. A stale pane must not be able to drop the budget
  // under a round that is already running and strand it beyond the cap.

  const reviewCardBoard = (input: {
    readonly overrides?: BoardCard["reviewOverrides"];
    readonly completedRounds?: number;
    readonly liveStepId?: string;
  }): OrchestrationReadModel =>
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
                  lastNudgeAt: null,
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
      reviewOverrides: { rounds, stopAfterRound: null, roundModels: {} },
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
      assert.strictEqual(failure._tag, "OrchestrationCommandInvariantError");
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

  it.effect("t3o-22 D3: rejects a budget above the ceiling", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        setRounds(BOARD_REVIEW_MAX_ROUNDS + 1),
        reviewCardBoard({}),
      );
      assert.include(String(failure), "exceeds the ceiling");
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
          reviewOverrides: { rounds: 3, stopAfterRound: 2, roundModels: {} },
          createdAt: NOW,
        },
        reviewCardBoard({ overrides: { rounds: 2, stopAfterRound: 2, roundModels: {} } }),
      );
      assert.strictEqual(event.type, "board.card-updated");
      if (event.type !== "board.card-updated") return;
      assert.strictEqual(event.payload.card.reviewOverrides?.stopAfterRound, null);
      assert.strictEqual(event.payload.card.reviewOverrides?.rounds, 3);
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
          reviewOverrides: { rounds: 3, stopAfterRound: 2, roundModels: {} },
          createdAt: NOW,
        },
        reviewCardBoard({
          overrides: { rounds: 8, stopAfterRound: 2, roundModels: {} },
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
          reviewOverrides: { rounds: null, stopAfterRound: 2, roundModels: {} },
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
            overrides: { rounds: 5, stopAfterRound: null, roundModels: {} },
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
      assert.strictEqual(failure._tag, "OrchestrationCommandInvariantError");
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
        },
      ]);

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
      // `card-dep` is in building — at or after the build role, so its unmet
      // dependency really is blocking it. Deleting `card-a` is the ONE case
      // where the edge cannot survive: an unresolvable id counts as unmet
      // forever, so leaving it would block the dependent with no card left to
      // unblock it.
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
      // inverse (D1).
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

  // ── D18: no board-initiated Ready -> Building ────────────────────────

  it.effect("no command except an explicit board.card.move emits a move into building", () =>
    Effect.gen(function* () {
      // Every fixture is set up so its command SUCCEEDS — a rejected command
      // trivially emits nothing, which would prove nothing. The Record over
      // BoardCommand["type"] makes this catalog compile-time exhaustive: a
      // future board command cannot ship without declaring what it emits
      // here.
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
      // A two-plan card in Planning for board.plans.approve — the one OTHER
      // command allowed to emit a move into building (t3o-23, D4): approving
      // a split is as user-originated as the drag, and the parent's crossing
      // is part of that same human act.
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
      // Worktree lifecycle fixtures (t3o-09): each succeeds and none emits a
      // move — worktree provisioning is gated on Building but never advances a
      // stage (D18).
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
      // Step-lifecycle fixtures (t3o-10): each of the reactor's internal
      // step commands aggregates on the card and records step state — none
      // emits a move. Every card is in Building; each carries the step state
      // its command's precondition needs, with the frozen execution config the
      // run row holds since D12 (D1 retired the card-level recipe snapshot).
      const frozenConfig = {
        prompt: "do it",
        providerInstanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        mode: "build" as const,
        runtimeMode: "auto" as const,
        humanInLoop: false,
        maxAttempts: 3,
        timeoutMs: 1000,
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
        lastNudgeAt: null,
        ...frozenConfig,
        threadId:
          status === "running" || status === "awaiting-input" ? ThreadId.make("thread-1") : null,
        status,
        slotHeld: status === "running" || status === "awaiting-input",
        startedAt: status === "running" || status === "awaiting-input" ? NOW : null,
        updatedAt: NOW,
      });
      const selectCard = makeCard({ id: "card-select", stage: "building" });
      const admitCard = makeCard({ id: "card-admit", stage: "building" });
      const awaitCard = makeCard({ id: "card-await", stage: "building" });
      const recoverCard = makeCard({ id: "card-recover", stage: "building" });
      const settleCard = makeCard({ id: "card-settle", stage: "building" });
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
            awaitCard,
            recoverCard,
            settleCard,
            splitCard,
          ],
          labels: [...BOARD_SEED_LABELS, tombstonedLabel],
          plans: [readyPlan, ...splitPlans],
          stepStates: [
            makeStepState("card-admit", "pending"),
            makeStepState("card-await", "running"),
            makeStepState("card-recover", "running"),
            makeStepState("card-settle", "running"),
            // complete-step validates against the card's LIVE step, so the
            // catalog's completion needs one to succeed against.
            makeStepState("card-ready", "running", "build"),
          ],
          nextCardNumberByProject: {},
        },
      });

      const catalog: { readonly [K in BoardCommand["type"]]: BoardCommand } = {
        "board.card.create": createCommand({ cardId: "card-new" }),
        // The one legitimate path into building — explicit, user-originated.
        "board.card.move": moveCommand({ cardId: "card-ready", toStage: "building" }),
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
        "board.card.archive": {
          type: "board.card.archive",
          commandId: CommandId.make("cmd-archive"),
          cardId: BoardCardId.make("card-ready"),
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
        // Agent write-path commands (t3o-08) all aggregate on the card and
        // never emit a move. `board.card.report-progress` and
        // `board.card.request-input` were deleted by t3o-18 (D13).
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
        "board.plans.propose": {
          type: "board.plans.propose",
          commandId: CommandId.make("cmd-propose"),
          cardId: BoardCardId.make("card-ready"),
          plans: [{ key: "p1", title: "Plan 1", summary: "First", dependsOn: [], body: "body" }],
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
        // The split approval (t3o-23): user-originated, and the second
        // legitimate emitter of a move into building — asserted below.
        "board.plans.approve": {
          type: "board.plans.approve",
          commandId: CommandId.make("cmd-approve"),
          cardId: BoardCardId.make("card-split"),
          createdAt: NOW,
        },
        // Records the integration branch the reactor created (t3o-23, D5) —
        // a worktree-slice write, never a move.
        "board.card.record-integration-branch": {
          type: "board.card.record-integration-branch",
          commandId: CommandId.make("cmd-record-integration"),
          cardId: BoardCardId.make("card-ready"),
          branch: "board/card-ready",
          baseRefName: "main",
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
        // Reporting only: it writes an activity row and touches no card field,
        // so it cannot possibly emit a move.
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
            headBranch: "t3o/card-ready",
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
        // Step-lifecycle commands (t3o-10) record step state on the card and
        // never move a stage — the board-driven Building → Review advance
        // rides board.card.move, gated like every other transition (D18).
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
        "board.card.await-step-input": {
          type: "board.card.await-step-input",
          commandId: CommandId.make("cmd-await"),
          cardId: BoardCardId.make("card-await"),
          stepId: "s1",
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
        "board.card.settle-step": {
          type: "board.card.settle-step",
          commandId: CommandId.make("cmd-settle"),
          cardId: BoardCardId.make("card-settle"),
          stepId: "s1",
          outcome: "succeeded",
          createdAt: NOW,
        },
        // Mid-run human-in-the-loop retune (D5/D6): retunes a live step's
        // stance, emits board.card-step-retuned — never a move.
        "board.card.retune-step": {
          type: "board.card.retune-step",
          commandId: CommandId.make("cmd-retune"),
          cardId: BoardCardId.make("card-settle"),
          stepId: "s1",
          humanInLoop: true,
          createdAt: NOW,
        },
        // On-demand kickoff (D7): emits board.card-stage-thread-requested for
        // the card's CURRENT stage — never a move.
        "board.card.start-stage-thread": {
          type: "board.card.start-stage-thread",
          commandId: CommandId.make("cmd-start-stage-thread"),
          cardId: BoardCardId.make("card-ready"),
          createdAt: NOW,
        },
        // Stage-aggregate commands (D2/D9): they mutate the stage list, never a
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
      };

      // The full decision is checked, not just the first event — approve
      // emits its move mid-list. Exactly two commands may emit a
      // board.card-moved, and both are explicit human acts (D18): the move
      // itself, and the split approval whose parent-crossing is part of the
      // same click (t3o-23, D4).
      const mayMoveIntoBuilding = new Set(["board.card.move", "board.plans.approve"]);
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

  // ── Stage reorder across the Build boundary (t3o-15, D9) ─────────────

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
        // Seed stages resolve from BOARD_SEED_STAGES: sprint (d) sits before
        // building (j). Moving building to "c" puts it before sprint, flipping
        // sprint from before-build to after-build. A card in sprint would then
        // carry a stale `blocked` flag, so the reorder is refused — the guard
        // must cover the build stage moving, not just ordinary stages crossing.
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

  // ── Creation stages (t3o-15, D10) ────────────────────────────────────

  it.effect("accepts a create into any stage — BOARD_CREATABLE_STAGES is deleted (D10)", () =>
    Effect.gen(function* () {
      // A card (with no unmet dependencies) may be created directly into any
      // stage, Building and Done included — Mode, not a creation allow-list,
      // governs what entry does. The auto-execute warning is a create-dialog
      // concern (AC16), not a decider refusal.
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

  // ── Labels (t3o-06a) ─────────────────────────────────────────────────

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

  // ── Brief and dependencies at creation (t3o-06) ──────────────────────

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

  // ── Agent write path (t3o-08) ────────────────────────────────────────

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
  }): BoardCommand =>
    ({
      type: "board.card.complete-step",
      commandId: CommandId.make(`cmd-step-${input.stepId}-${input.outcome}`),
      cardId: BoardCardId.make("card-1"),
      stepId: input.stepId,
      outcome: input.outcome,
      summary: input.summary,
      payload: null,
      threadId: null,
      createdAt: NOW,
    }) as const;

  const proposePlans = (
    plans: ReadonlyArray<{
      readonly key: string;
      readonly title?: string;
      readonly summary?: string;
      readonly dependsOn?: ReadonlyArray<string>;
      readonly body?: string;
    }>,
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
      createdAt: NOW,
    }) as const;

  // t3o-18 (D13) deleted `board.card.report-progress` and `board.card.request-input`,
  // so the test that recorded them as card activity is gone with them.

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
      lastNudgeAt: null,
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
      assert.strictEqual(failure._tag, "OrchestrationCommandInvariantError");
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
});
