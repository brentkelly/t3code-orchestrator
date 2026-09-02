/**
 * Sub-board decider invariants (t3o-23): the approve gate's validation matrix
 * and materialisation shape, the plan freeze, the parent's move/delete/archive
 * lockdown, the materialisation-floor stage restriction, and the
 * integration-branch record.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  BoardStageId,
  boardPlanId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  type BoardCard,
  type BoardPlan,
  type BoardState,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { boardDecidedEvents, decideBoardCommand, type BoardCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const parentId = BoardCardId.make("card-parent");

function makeCard(
  overrides: Omit<Partial<BoardCard>, "id" | "stage"> & {
    readonly id: string;
    readonly stage?: string;
  },
): BoardCard {
  const { id, stage, ...rest } = overrides;
  return {
    key: `T3-${id.replace(/\D/g, "") || "1"}`,
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
    attachments: [],
    externalRef: null,
    humanInLoop: null,
    reviewOverrides: null,
    modelOverrides: null,
    worktree: null,
    pullRequest: null,
    pullRequestHistory: [],
    pullRequestFloor: null,
    blocked: false,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...rest,
    stage: BoardStageId.make(stage ?? "planning"),
    id: BoardCardId.make(id),
  };
}

function makePlan(input: {
  readonly cardId: BoardCardId;
  readonly key: string;
  readonly ordinal: number;
  readonly dependsOnKeys?: ReadonlyArray<string>;
}): BoardPlan {
  return {
    planId: boardPlanId(input.cardId, input.key),
    cardId: input.cardId,
    title: `Plan ${input.key}`,
    summary: `Part ${input.key}`,
    dependsOn: (input.dependsOnKeys ?? []).map((key) => boardPlanId(input.cardId, key)),
    ordinal: input.ordinal,
    locked: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** A splittable parent (two plans, second depending on the first) plus any
    extra cards, on the seed stage list. */
function makeBoard(input?: {
  readonly parent?: Partial<Parameters<typeof makeCard>[0]>;
  readonly extraCards?: ReadonlyArray<BoardCard>;
  readonly plans?: ReadonlyArray<BoardPlan>;
  readonly stages?: BoardState["stages"];
}): BoardState {
  const parent = makeCard({
    id: "card-parent",
    key: "T3-190",
    cardNumber: 190,
    ...input?.parent,
  });
  return {
    cards: [parent, ...(input?.extraCards ?? [])],
    plans:
      input?.plans ??
      ([
        makePlan({ cardId: parentId, key: "p1", ordinal: 0 }),
        makePlan({ cardId: parentId, key: "p2", ordinal: 1, dependsOnKeys: ["p1"] }),
      ] as const),
    nextCardNumberByProject: { [projectId]: 191 },
    ...(input?.stages === undefined ? {} : { stages: input.stages }),
  };
}

function makeReadModel(board: BoardState): OrchestrationReadModel {
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

const decideEvents = (command: BoardCommand, readModel: OrchestrationReadModel) =>
  decideBoardCommand({ command, readModel }).pipe(Effect.map(boardDecidedEvents));

const decideFail = (command: BoardCommand, readModel: OrchestrationReadModel) =>
  Effect.flip(decideEvents(command, readModel));

const approve = (cardId = "card-parent"): BoardCommand => ({
  type: "board.plans.approve",
  commandId: CommandId.make(`cmd-approve-${cardId}`),
  cardId: BoardCardId.make(cardId),
  createdAt: NOW,
});

const moveCommand = (input: {
  readonly cardId: string;
  readonly toStage: string;
  readonly override?: boolean;
}): BoardCommand => ({
  type: "board.card.move",
  commandId: CommandId.make(`cmd-move-${input.cardId}`),
  cardId: BoardCardId.make(input.cardId),
  toStage: BoardStageId.make(input.toStage),
  ...(input.override === undefined ? {} : { override: input.override }),
  createdAt: NOW,
});

/** A materialised child in `stage`, belonging to the default parent. */
const makeChild = (
  id: string,
  stage: string,
  overrides?: Partial<Parameters<typeof makeCard>[0]>,
) =>
  makeCard({
    id,
    stage,
    parentCardId: parentId,
    sourcePlanId: boardPlanId(parentId, "p1"),
    ...overrides,
  });

it.layer(NodeServices.layer)("sub-board decider (t3o-23)", (it) => {
  // ── The approve gate: materialisation shape ──────────────────────────

  it.effect("materialises a two-plan split: children and the approval record, no move", () =>
    Effect.gen(function* () {
      const events = yield* decideEvents(approve(), makeReadModel(makeBoard()));
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["board.card-created", "board.card-created", "board.plans-approved"],
      );

      const [first, second, approved] = events;
      assert.ok(first!.type === "board.card-created" && second!.type === "board.card-created");
      // Children land in the materialisation floor (the stage before the
      // build role — Ready on a seeded board), in ordinal order, with keys
      // allocated from the project counter and the plan graph mapped onto
      // card ids.
      expect(first.payload.stage).toBe(BOARD_SEED_STAGE_IDS.ready);
      expect(second.payload.stage).toBe(BOARD_SEED_STAGE_IDS.ready);
      expect(first.payload.key).toBe("T3-191");
      expect(second.payload.key).toBe("T3-192");
      expect(first.payload.title).toBe("Plan p1");
      expect(first.payload.parentCardId).toBe(parentId);
      expect(first.payload.sourcePlanId).toBe(boardPlanId(parentId, "p1"));
      // The plan BODY arrives by pointer (D8: the decider cannot read bodies).
      expect(first.payload.briefFromPlanId).toBe(boardPlanId(parentId, "p1"));
      expect(first.payload.dependsOn).toEqual([]);
      expect(second.payload.dependsOn).toEqual([first.payload.cardId]);
      // Sibling order keys sort in plan order.
      assert.ok(String(first.payload.orderKey) < String(second.payload.orderKey));

      // The parent does not move (t3o-28, D1): approving answers "is this the
      // right split", and it stays in planning for the human to walk forward.
      assert.ok(approved!.type === "board.plans-approved");
      expect(approved.payload.childCardIds).toEqual([first.payload.cardId, second.payload.cardId]);
      expect(approved.payload.card.stage).toBe(BOARD_SEED_STAGE_IDS.planning);
    }),
  );

  it.effect("leaves a parent already sitting in the build-role stage where it is", () =>
    Effect.gen(function* () {
      // Approving from build is still legal (a card built conversationally can
      // be split before its build starts in earnest) and, since t3o-28, the
      // event shape no longer depends on where the parent stands.
      const events = yield* decideEvents(
        approve(),
        makeReadModel(makeBoard({ parent: { stage: "building" } })),
      );
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["board.card-created", "board.card-created", "board.plans-approved"],
      );
      const approved = events[2];
      assert.ok(approved!.type === "board.plans-approved");
      expect(approved.payload.card.stage).toBe(BOARD_SEED_STAGE_IDS.building);
    }),
  );

  it.effect("does not clear the parent's blocked flag — it crosses no build boundary", () =>
    Effect.gen(function* () {
      // Pre-t3o-28 the approval cleared `blocked` because it WAS the crossing
      // into build and re-ran the dependency gate on the way. It no longer
      // crosses anything, so the flag is left exactly as it stands and the
      // D11 gate has its say when the parent actually enters build.
      const events = yield* decideEvents(
        approve(),
        makeReadModel(makeBoard({ parent: { blocked: true } })),
      );
      const approved = events[2];
      assert.ok(approved!.type === "board.plans-approved");
      expect(approved.payload.card.blocked).toBe(true);
    }),
  );

  // ── The pending-split forward-move gate (t3o-27) ─────────────────────

  it.effect("pins an unapproved split in place — every forward move refused, drag included", () =>
    Effect.gen(function* () {
      // makeBoard()'s parent sits in planning with two plans and no children:
      // a pending split. It cannot advance to any later stage.
      const board = makeReadModel(makeBoard());
      const ready = yield* decideFail(
        moveCommand({ cardId: "card-parent", toStage: "ready" }),
        board,
      );
      assert.include(String(ready), "unapproved plans");
      // A drag (override) into building does not bypass the gate.
      const building = yield* decideFail(
        moveCommand({ cardId: "card-parent", toStage: "building", override: true }),
        board,
      );
      assert.include(String(building), "unapproved plans");
    }),
  );

  it.effect("lets an unapproved split move backward — that is how you fix the plans", () =>
    Effect.gen(function* () {
      const events = yield* decideEvents(
        moveCommand({ cardId: "card-parent", toStage: "sprint" }),
        makeReadModel(makeBoard()),
      );
      assert.strictEqual(events[0]!.type, "board.card-moved");
    }),
  );

  it.effect("lets a retreated unapproved split return to planning — but no further", () =>
    Effect.gen(function* () {
      // The card was moved back to Sprint; coming home to Planning is a
      // forward move but stays within the gate's ceiling (the plan-role
      // stage). Skipping over planning to Ready is not.
      const board = makeReadModel(makeBoard({ parent: { stage: "sprint" } }));
      const back = yield* decideEvents(
        moveCommand({ cardId: "card-parent", toStage: "planning" }),
        board,
      );
      assert.strictEqual(back[0]!.type, "board.card-moved");
      const past = yield* decideFail(
        moveCommand({ cardId: "card-parent", toStage: "ready", override: true }),
        board,
      );
      assert.include(String(past), "unapproved plans");
    }),
  );

  it.effect("backward moves are always free for a pending split, even from Building", () =>
    Effect.gen(function* () {
      // A pending-split card sitting AT the build stage (approve allows that
      // position) retreats to Ready — a backward move above the plan stage,
      // which AC2 promises stays open.
      const events = yield* decideEvents(
        moveCommand({ cardId: "card-parent", toStage: "ready" }),
        makeReadModel(makeBoard({ parent: { stage: "building" } })),
      );
      assert.strictEqual(events[0]!.type, "board.card-moved");
    }),
  );

  it.effect("a plan stage reordered after Building never opens the build stage", () =>
    Effect.gen(function* () {
      // Stage reordering only pins build<review and done-last, so the plan
      // stage can legally sit after Building. The gate's ceiling clamps below
      // the build role, so the pending card still cannot enter it.
      const stages = [
        {
          stageId: BoardStageId.make("backlog"),
          label: "Backlog",
          role: null,
          orderKey: "b",
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          stageId: BoardStageId.make("building"),
          label: "Building",
          role: "build" as const,
          orderKey: "d",
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          stageId: BoardStageId.make("planning"),
          label: "Planning",
          role: "plan" as const,
          orderKey: "f",
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          stageId: BoardStageId.make("review"),
          label: "Review",
          role: "review" as const,
          orderKey: "h",
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          stageId: BoardStageId.make("done"),
          label: "Done",
          role: "done" as const,
          orderKey: "j",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ];
      const failure = yield* decideFail(
        moveCommand({ cardId: "card-parent", toStage: "building" }),
        makeReadModel(makeBoard({ parent: { stage: "backlog" }, stages })),
      );
      assert.include(String(failure), "unapproved plans");
    }),
  );

  it.effect("a single-plan card is not a pending split and advances freely", () =>
    Effect.gen(function* () {
      const events = yield* decideEvents(
        moveCommand({ cardId: "card-parent", toStage: "ready" }),
        makeReadModel(
          makeBoard({ plans: [makePlan({ cardId: parentId, key: "p1", ordinal: 0 })] }),
        ),
      );
      assert.strictEqual(events[0]!.type, "board.card-moved");
    }),
  );

  // ── The approve gate: validation matrix ──────────────────────────────

  it.effect("refuses a split of fewer than two plans", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        approve(),
        makeReadModel(
          makeBoard({ plans: [makePlan({ cardId: parentId, key: "p1", ordinal: 0 })] }),
        ),
      );
      assert.include(String(failure), "a split needs at least two");
    }),
  );

  it.effect("refuses re-approval once children exist", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        approve(),
        makeReadModel(makeBoard({ extraCards: [makeChild("card-child", "ready")] })),
      );
      assert.include(String(failure), "approved once");
    }),
  );

  it.effect(
    "allows a second-round re-approval once the first round's children are all archived",
    () =>
      Effect.gen(function* () {
        // A merged parent dragged back and re-approved (t3o-23, D5): the first
        // round's children are archived (finished-and-gone), so they neither
        // freeze the plans nor block re-approval — the reclaimed-slice branch
        // machinery would otherwise be unreachable.
        const events = yield* decideEvents(
          approve(),
          makeReadModel(
            makeBoard({
              parent: {
                stage: "building",
                worktree: {
                  branch: "board/t3-190",
                  baseRefName: "main",
                  path: null,
                  status: "reclaimed",
                  attempts: 1,
                  lastError: null,
                  reclaimBlockedReason: null,
                },
              },
              extraCards: [makeChild("card-old", "done", { archivedAt: NOW })],
            }),
          ),
        );
        assert.deepStrictEqual(
          events.map((event) => event.type),
          ["board.card-created", "board.card-created", "board.plans-approved"],
        );
      }),
  );

  it.effect("still refuses re-approval while a Done-but-unarchived child is on the board", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        approve(),
        makeReadModel(
          makeBoard({
            parent: { stage: "building" },
            extraCards: [makeChild("card-done", "done")],
          }),
        ),
      );
      assert.include(String(failure), "on the board; a split is approved once");
    }),
  );

  it.effect("refuses a split on a card that is itself a plan card (depth 1)", () =>
    Effect.gen(function* () {
      const board = makeBoard({
        extraCards: [makeChild("card-child", "ready")],
      });
      // Give the child its own two plans, then try to split it.
      const withPlans: BoardState = {
        ...board,
        plans: [
          makePlan({ cardId: BoardCardId.make("card-child"), key: "q1", ordinal: 0 }),
          makePlan({ cardId: BoardCardId.make("card-child"), key: "q2", ordinal: 1 }),
        ],
      };
      const failure = yield* decideFail(approve("card-child"), makeReadModel(withPlans));
      assert.include(String(failure), "do not nest");
    }),
  );

  it.effect("approves a split whose parent still has unmet dependencies (t3o-28, D1)", () =>
    Effect.gen(function* () {
      // Pre-t3o-28 this was refused, because approval WAS the crossing into
      // build and ran the D11 gate on the way. Approval crosses nothing now:
      // planning a split while a dependency is outstanding is ordinary work,
      // and the gate has its say when the parent tries to enter build.
      const blocker = makeCard({ id: "card-blocker", key: "T3-100", stage: "backlog" });
      const readModel = makeReadModel(
        makeBoard({
          parent: { dependsOn: [blocker.id] },
          extraCards: [blocker],
        }),
      );
      const events = yield* decideEvents(approve(), readModel);
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["board.card-created", "board.card-created", "board.plans-approved"],
      );

      // …and the dependency gate still stops the build, one stage later. The
      // board here is the post-approval one (children materialised), which is
      // what the parent's own move into build actually meets.
      const failure = yield* decideFail(
        moveCommand({ cardId: "card-parent", toStage: "building", override: true }),
        makeReadModel(
          makeBoard({
            parent: { stage: "ready", dependsOn: [blocker.id] },
            extraCards: [blocker, makeChild("card-child", "ready")],
          }),
        ),
      );
      assert.include(String(failure), "T3-100");
    }),
  );

  it.effect("refuses approval when no stage precedes the build role", () =>
    Effect.gen(function* () {
      // A degenerate board whose build-role stage comes first: there is no
      // floor for the children to land in, so the split is refused with the
      // fix named rather than materialising work into an auto-starting stage.
      const stages = [
        {
          stageId: BoardStageId.make("building"),
          label: "Building",
          role: "build" as const,
          orderKey: "b",
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          stageId: BoardStageId.make("review"),
          label: "Review",
          role: "review" as const,
          orderKey: "d",
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          stageId: BoardStageId.make("done"),
          label: "Done",
          role: "done" as const,
          orderKey: "f",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ];
      const failure = yield* decideFail(
        approve(),
        makeReadModel(makeBoard({ parent: { stage: "building" }, stages })),
      );
      assert.include(String(failure), "no stage before");
    }),
  );

  it.effect("refuses approval while the parent has a live step", () =>
    Effect.gen(function* () {
      const board = makeBoard({ parent: { stage: "building" } });
      const failure = yield* decideFail(
        approve(),
        makeReadModel({
          ...board,
          stepStates: [
            {
              cardId: parentId,
              stepId: "building",
              stepLabel: "Build",
              stageLabel: "Building",
              attempt: 1,
              stallCount: 0,
              lastNudgeAt: null,
              baseTipAtRoundStart: null,
              lastError: null,
              prompt: "build it",
              providerInstanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.4",
              mode: "build",
              runtimeMode: "auto",
              humanInLoop: false,
              maxAttempts: 3,
              timeoutMs: 1000,
              threadId: null,
              status: "running",
              slotHeld: true,
              startedAt: NOW,
              updatedAt: NOW,
            },
          ],
        }),
      );
      assert.include(String(failure), "live step");
    }),
  );

  it.effect("refuses approval on a card already past the build stage", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        approve(),
        makeReadModel(makeBoard({ parent: { stage: "review" } })),
      );
      assert.include(String(failure), "already past");
    }),
  );

  // ── The plan freeze and the parent lockdown ──────────────────────────

  it.effect("freezes plans while children exist: propose and write are refused", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel(
        makeBoard({ extraCards: [makeChild("card-child", "ready")] }),
      );
      const proposeFailure = yield* decideFail(
        {
          type: "board.plans.propose",
          commandId: CommandId.make("cmd-propose"),
          cardId: parentId,
          plans: [{ key: "p9", title: "New", summary: "New", dependsOn: [], body: "b" }],
          createdAt: NOW,
        },
        readModel,
      );
      assert.include(String(proposeFailure), "plans are frozen");
      const writeFailure = yield* decideFail(
        {
          type: "board.plan.write",
          commandId: CommandId.make("cmd-write"),
          cardId: parentId,
          planId: boardPlanId(parentId, "p1"),
          body: "rewritten",
          createdAt: NOW,
        },
        readModel,
      );
      assert.include(String(writeFailure), "plans are frozen");
    }),
  );

  it.effect("holds the parent at the build ceiling while any child is unfinished", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel(
        makeBoard({
          parent: { stage: "building" },
          extraCards: [makeChild("card-child", "ready")],
        }),
      );
      const failure = yield* decideFail(
        moveCommand({ cardId: "card-parent", toStage: "review", override: true }),
        readModel,
      );
      assert.include(String(failure), "advances through its 1 plan card");
      // The refusal names the children, so the sub-board to open is obvious.
      assert.include(String(failure), "T3-1");
      assert.include(String(failure), "cannot pass 'Building'");
    }),
  );

  it.effect("lets the parent walk UP TO the build stage while children wait (t3o-28, D2)", () =>
    Effect.gen(function* () {
      // The move that begins the whole sub-board. Pre-t3o-28 the pin refused
      // it, which was survivable only because approval had already parked the
      // parent in build; now it is the human's Begin build.
      const events = yield* decideEvents(
        moveCommand({ cardId: "card-parent", toStage: "building" }),
        makeReadModel(
          makeBoard({
            parent: { stage: "ready" },
            extraCards: [makeChild("card-child", "ready")],
          }),
        ),
      );
      assert.strictEqual(events[0]?.type, "board.card-moved");
    }),
  );

  it.effect("lets a parent with live children move backward and reorder freely", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel(
        makeBoard({
          parent: { stage: "building" },
          extraCards: [makeChild("card-child", "building")],
        }),
      );
      // Backing the supervising card off is allowed by the DECIDER — it does not
      // stop the children. (The reactor's cascade no longer pauses here: once a
      // child is underway the split runs to completion wherever the parent is
      // parked — see subBoardSupervisor.test.ts "parked below build".)
      const back = yield* decideEvents(
        moveCommand({ cardId: "card-parent", toStage: "ready" }),
        readModel,
      );
      assert.strictEqual(back[0]?.type, "board.card-moved");
    }),
  );

  it.effect("t3o-24 D4: the regression back to the build-role stage still lands", () =>
    Effect.gen(function* () {
      // A child dragged back out of Done leaves the parent ahead of reality:
      // sitting in review with an unfinished child. The reactor's correction —
      // back to the build-role stage — must land. Under t3o-28's ceiling this
      // needs no carve-out: the target IS the ceiling, not past it.
      const readModel = makeReadModel(
        makeBoard({
          parent: { stage: "review" },
          extraCards: [makeChild("card-child", "building")],
        }),
      );
      const regressed = yield* decideEvents(
        moveCommand({ cardId: "card-parent", toStage: "building", override: true }),
        readModel,
      );
      assert.strictEqual(regressed[0]?.type, "board.card-moved");

      // Anything past the ceiling is still refused, drag included.
      const forward = yield* decideFail(
        moveCommand({ cardId: "card-parent", toStage: "merge", override: true }),
        readModel,
      );
      assert.include(String(forward), "advances through its 1 plan card");
    }),
  );

  it.effect("unfreezes the parent when every child is done or archived", () =>
    Effect.gen(function* () {
      const events = yield* decideEvents(
        moveCommand({ cardId: "card-parent", toStage: "review" }),
        makeReadModel(
          makeBoard({
            parent: { stage: "building" },
            extraCards: [
              makeChild("card-done", "done"),
              makeChild("card-archived", "building", { archivedAt: NOW }),
            ],
          }),
        ),
      );
      assert.strictEqual(events[0]!.type, "board.card-moved");
    }),
  );

  it.effect(
    "refuses deleting or archiving a parent with children; archive frees when finished",
    () =>
      Effect.gen(function* () {
        const live = makeReadModel(
          makeBoard({
            parent: { stage: "building" },
            extraCards: [makeChild("card-child", "building")],
          }),
        );
        const deleteFailure = yield* decideFail(
          {
            type: "board.card.delete",
            commandId: CommandId.make("cmd-delete"),
            cardId: parentId,
            createdAt: NOW,
          },
          live,
        );
        assert.include(String(deleteFailure), "delete those first");
        const archiveFailure = yield* decideFail(
          {
            type: "board.card.archive",
            commandId: CommandId.make("cmd-archive"),
            cardId: parentId,
            createdAt: NOW,
          },
          live,
        );
        assert.include(String(archiveFailure), "unfinished plan card");

        // All children done: archive proceeds (delete still refuses — the
        // children exist and would be orphaned).
        const finished = makeReadModel(
          makeBoard({
            parent: { stage: "done" },
            extraCards: [makeChild("card-child", "done")],
          }),
        );
        const archived = yield* decideEvents(
          {
            type: "board.card.archive",
            commandId: CommandId.make("cmd-archive-2"),
            cardId: parentId,
            createdAt: NOW,
          },
          finished,
        );
        assert.strictEqual(archived[0]!.type, "board.card-archived");
      }),
  );

  // ── The floor restriction on children ────────────────────────────────

  it.effect("lets a child drop back to the floor stage but never below it", () =>
    Effect.gen(function* () {
      const board = makeBoard({
        parent: { stage: "building" },
        extraCards: [makeChild("card-child", "building")],
      });
      const allowed = yield* decideEvents(
        moveCommand({ cardId: "card-child", toStage: "ready" }),
        makeReadModel(board),
      );
      assert.strictEqual(allowed[0]!.type, "board.card-moved");
      const failure = yield* decideFail(
        moveCommand({ cardId: "card-child", toStage: "planning", override: true }),
        makeReadModel(board),
      );
      assert.include(String(failure), "sub-board plan card");
    }),
  );

  // ── The integration-branch record ────────────────────────────────────

  it.effect("records a branch-only worktree slice, and refuses over a real one", () =>
    Effect.gen(function* () {
      const record: BoardCommand = {
        type: "board.card.record-integration-branch",
        commandId: CommandId.make("cmd-record-branch"),
        cardId: parentId,
        branch: "board/t3-190",
        baseRefName: "main",
        createdAt: NOW,
      };
      const events = yield* decideEvents(
        record,
        makeReadModel(makeBoard({ parent: { stage: "building" } })),
      );
      const event = events[0]!;
      assert.ok(event.type === "board.card-integration-branch-recorded");
      expect(event.payload.card.worktree).toEqual({
        branch: "board/t3-190",
        baseRefName: "main",
        path: null,
        status: "branch-only",
        attempts: 1,
        lastError: null,
        reclaimBlockedReason: null,
      });

      const failure = yield* decideFail(
        record,
        makeReadModel(
          makeBoard({
            parent: {
              stage: "building",
              worktree: {
                branch: "board/t3-190",
                baseRefName: "main",
                path: "/tmp/wt",
                status: "ready",
                attempts: 1,
                lastError: null,
                reclaimBlockedReason: null,
              },
            },
          }),
        ),
      );
      assert.include(String(failure), "only while no live branch exists");

      // A second-round split (t3o-23, D5): the old branch was deleted at
      // Done, the slice reads `reclaimed`, and a fresh record is admitted.
      const secondRound = yield* decideEvents(
        record,
        makeReadModel(
          makeBoard({
            parent: {
              stage: "building",
              worktree: {
                branch: "board/t3-190",
                baseRefName: "main",
                path: null,
                status: "reclaimed",
                attempts: 1,
                lastError: null,
                reclaimBlockedReason: null,
              },
            },
          }),
        ),
      );
      const secondEvent = secondRound[0]!;
      assert.ok(secondEvent.type === "board.card-integration-branch-recorded");
      expect(secondEvent.payload.card.worktree?.status).toBe("branch-only");
    }),
  );

  it.effect("re-provisions from branch-only with attempts restarting at 1", () =>
    Effect.gen(function* () {
      const events = yield* decideEvents(
        {
          type: "board.card.provision-worktree",
          commandId: CommandId.make("cmd-provision"),
          cardId: parentId,
          branch: "board/t3-190",
          baseRefName: "main",
          createdAt: NOW,
        },
        makeReadModel(
          makeBoard({
            parent: {
              stage: "review",
              worktree: {
                branch: "board/t3-190",
                baseRefName: "main",
                path: null,
                status: "branch-only",
                attempts: 1,
                lastError: null,
                reclaimBlockedReason: null,
              },
            },
          }),
        ),
      );
      const event = events[0]!;
      assert.ok(event.type === "board.card-worktree-provisioning");
      expect(event.payload.card.worktree?.status).toBe("provisioning");
      expect(event.payload.card.worktree?.attempts).toBe(1);
    }),
  );
});

// ── Child create (t3o-25): the drill-in's create preset ─────────────────

it.layer(NodeServices.layer)("sub-board child create (t3o-25)", (it) => {
  const createCommand = (input?: {
    readonly stage?: string;
    readonly parentCardId?: string;
    readonly dependsOn?: ReadonlyArray<string>;
    readonly projectId?: string;
  }): BoardCommand => ({
    type: "board.card.create",
    commandId: CommandId.make("cmd-create-child"),
    cardId: BoardCardId.make("card-new-child"),
    projectId: ProjectId.make(input?.projectId ?? String(projectId)),
    title: "Hand-made child",
    stage: BoardStageId.make(input?.stage ?? "ready"),
    orderKey: "m",
    ...(input?.parentCardId === undefined
      ? {}
      : { parentCardId: BoardCardId.make(input.parentCardId) }),
    ...(input?.dependsOn === undefined
      ? {}
      : { dependsOn: input.dependsOn.map((id) => BoardCardId.make(id)) }),
    createdAt: NOW,
  });

  it.effect("creates a child carrying its parent, exactly as a materialised one does", () =>
    Effect.gen(function* () {
      const events = yield* decideEvents(
        createCommand({ parentCardId: "card-parent" }),
        makeReadModel(makeBoard()),
      );
      const event = events[0]!;
      assert.ok(event.type === "board.card-created");
      expect(event.payload.parentCardId).toBe(parentId);
      expect(event.payload.sourcePlanId).toBeUndefined();
      expect(event.payload.stage).toBe(BOARD_SEED_STAGE_IDS.ready);
    }),
  );

  it.effect("accepts a sibling dependency", () =>
    Effect.gen(function* () {
      const events = yield* decideEvents(
        createCommand({ parentCardId: "card-parent", dependsOn: ["card-sibling"] }),
        makeReadModel(makeBoard({ extraCards: [makeChild("card-sibling", "ready")] })),
      );
      const event = events[0]!;
      assert.ok(event.type === "board.card-created");
      expect(event.payload.dependsOn).toEqual([BoardCardId.make("card-sibling")]);
    }),
  );

  it.effect("refuses a child created before the materialisation floor", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        createCommand({ parentCardId: "card-parent", stage: "planning" }),
        makeReadModel(makeBoard()),
      );
      assert.include(String(failure), "materialisation floor");
    }),
  );

  it.effect("refuses a dependency on a non-sibling — a child depends on siblings only", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        createCommand({ parentCardId: "card-parent", dependsOn: ["card-top"] }),
        makeReadModel(
          makeBoard({ extraCards: [makeCard({ id: "card-top", key: "T3-1", stage: "ready" })] }),
        ),
      );
      assert.include(String(failure), "not a sibling");
    }),
  );

  it.effect("refuses a missing or archived parent", () =>
    Effect.gen(function* () {
      const missing = yield* decideFail(
        createCommand({ parentCardId: "card-ghost" }),
        makeReadModel(makeBoard()),
      );
      assert.include(String(missing), "does not exist or is archived");

      const archived = yield* decideFail(
        createCommand({ parentCardId: "card-parent" }),
        makeReadModel(makeBoard({ parent: { archivedAt: NOW } })),
      );
      assert.include(String(archived), "does not exist or is archived");
    }),
  );

  it.effect("refuses a parent belonging to a different project", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        createCommand({ parentCardId: "card-parent" }),
        makeReadModel(makeBoard({ parent: { projectId: ProjectId.make("project-2") } })),
      );
      assert.include(String(failure), "different project");
    }),
  );

  it.effect("refuses nesting — a child of a child", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        createCommand({ parentCardId: "card-child" }),
        makeReadModel(makeBoard({ extraCards: [makeChild("card-child", "ready")] })),
      );
      assert.include(String(failure), "do not nest");
    }),
  );

  it.effect("still creates a plain top-level card when no parent is preset", () =>
    Effect.gen(function* () {
      const events = yield* decideEvents(createCommand(), makeReadModel(makeBoard()));
      const event = events[0]!;
      assert.ok(event.type === "board.card-created");
      expect(event.payload.parentCardId).toBeUndefined();
    }),
  );
});
