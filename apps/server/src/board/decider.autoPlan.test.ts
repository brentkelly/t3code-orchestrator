/**
 * Auto-planning and the decision log in the decider: which cards can
 * be marked for auto-planning, how a request is spent, and how recorded
 * decisions get their ids.
 */
import {
  BOARD_DECISIONS_PER_CALL_MAX,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  BoardStageId,
  boardPlanId,
  CommandId,
  ProjectId,
  type BoardCard,
  type BoardCardDecisionInput,
  type BoardPlan,
  type BoardState,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { boardDecidedEvents, type BoardCommand, type PlannedBoardEvent } from "./decider.ts";
import { decideBoardCommandOnModel } from "./decisionContext.testkit.ts";
import type { BoardOrchestrationReadModel } from "./decisionContext.testkit.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const cardId = BoardCardId.make("card-auto");

function makeCard(
  overrides: Omit<Partial<BoardCard>, "id" | "stage"> & {
    readonly id: string;
    readonly stage?: string;
  },
): BoardCard {
  const { id, stage, ...rest } = overrides;
  return {
    key: "T3-1",
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
    stage: BoardStageId.make(stage ?? "planning"),
    id: BoardCardId.make(id),
  };
}

const plan = (key: string, ordinal: number): BoardPlan => ({
  planId: boardPlanId(cardId, key),
  cardId,
  title: `Plan ${key}`,
  summary: key,
  dependsOn: [],
  ordinal,
  locked: false,
  createdAt: NOW,
  updatedAt: NOW,
});

const readModel = (
  cards: ReadonlyArray<BoardCard>,
  plans: ReadonlyArray<BoardPlan> = [],
): BoardOrchestrationReadModel => {
  const board: BoardState = {
    cards,
    plans,
    nextCardNumberByProject: { [projectId]: 10 },
  };
  return {
    projects: [{ id: projectId, title: "Project", workspaceRoot: "/tmp/p", deletedAt: null }],
    threads: [],
    board,
  };
};

const decideEvents = (command: BoardCommand, model: BoardOrchestrationReadModel) =>
  decideBoardCommandOnModel({ command, readModel: model }).pipe(Effect.map(boardDecidedEvents));

const decideFail = (command: BoardCommand, model: BoardOrchestrationReadModel) =>
  Effect.flip(decideEvents(command, model));

const mark = (): BoardCommand => ({
  type: "board.card.mark-auto-plan",
  commandId: CommandId.make("cmd-mark"),
  cardId,
  createdAt: NOW,
});

const decision = (overrides?: Partial<BoardCardDecisionInput>): BoardCardDecisionInput => ({
  question: "Ship behind a flag?",
  decision: "No flag",
  reason: "Small and reversible.",
  flag: "unclear",
  decidedBy: "agent",
  ...overrides,
});

const updatedCard = (events: ReadonlyArray<PlannedBoardEvent>) => {
  const event = events.find((candidate) => candidate.type === "board.card-updated");
  assert.ok(event?.type === "board.card-updated");
  return event;
};

const pending = { requestedAt: NOW, endedAt: null };

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  "auto-plan and the decision log (T3O-32)",
  (it) => {
    it.effect("marks a leaf in planning, leaving its run record pending", () =>
      Effect.gen(function* () {
        const event = updatedCard(
          yield* decideEvents(mark(), readModel([makeCard({ id: "card-auto" })])),
        );
        expect(event.payload.autoPlanMarked).toBe(true);
        expect(event.payload.card.autoPlan).toEqual({ requestedAt: NOW, endedAt: null });
      }),
    );

    it.effect("refuses a card that is not in planning", () =>
      Effect.gen(function* () {
        const error = yield* decideFail(
          mark(),
          readModel([makeCard({ id: "card-auto", stage: "ready" })]),
        );
        expect(error.message).toContain("not in planning");
      }),
    );

    it.effect("refuses a group, which is planned through its children", () =>
      Effect.gen(function* () {
        const group = makeCard({
          id: "card-auto",
          group: {
            target: "inherit",
            autoBuild: false,
            autoMerge: false,
            autoPlan: false,
            started: false,
            placed: BOARD_SEED_STAGE_IDS.planning,
            prevStage: null,
            heading: true,
            integrated: false,
          },
        });
        const error = yield* decideFail(mark(), readModel([group]));
        expect(error.message).toContain("is a group");
      }),
    );

    it.effect("refuses a card whose split is waiting for approval", () =>
      Effect.gen(function* () {
        const card = makeCard({
          id: "card-auto",
          splitRationale: "Two parts that review separately and ship one at a time.",
        });
        const error = yield* decideFail(mark(), readModel([card], [plan("a", 0), plan("b", 1)]));
        expect(error.message).toContain("proposed split");
      }),
    );

    it.effect("ends a pending request when the card leaves planning", () =>
      Effect.gen(function* () {
        const events = yield* decideEvents(
          {
            type: "board.card.move",
            commandId: CommandId.make("cmd-move"),
            cardId,
            toStage: BOARD_SEED_STAGE_IDS.ready,
            createdAt: LATER,
          },
          readModel([makeCard({ id: "card-auto", autoPlan: pending })], [plan("a", 0)]),
        );
        const moved = events.find((event) => event.type === "board.card-moved");
        assert.ok(moved?.type === "board.card-moved");
        expect(moved.payload.card.autoPlan).toEqual({ ...pending, endedAt: LATER });
      }),
    );

    it.effect("keeps an already-ended request as it was on a later move", () =>
      Effect.gen(function* () {
        const ended = { ...pending, endedAt: NOW };
        const events = yield* decideEvents(
          {
            type: "board.card.move",
            commandId: CommandId.make("cmd-move"),
            cardId,
            toStage: BOARD_SEED_STAGE_IDS.building,
            createdAt: LATER,
          },
          readModel([makeCard({ id: "card-auto", stage: "ready", autoPlan: ended })]),
        );
        const moved = events.find((event) => event.type === "board.card-moved");
        assert.ok(moved?.type === "board.card-moved");
        expect(moved.payload.card.autoPlan).toEqual(ended);
      }),
    );

    it.effect("ends a pending request when its split is approved", () =>
      Effect.gen(function* () {
        const card = makeCard({
          id: "card-auto",
          autoPlan: pending,
          splitRationale: "Two parts that review separately and ship one at a time.",
        });
        const events = yield* decideEvents(
          {
            type: "board.plans.approve",
            commandId: CommandId.make("cmd-approve"),
            cardId,
            createdAt: LATER,
          },
          readModel([card], [plan("a", 0), plan("b", 1)]),
        );
        const approved = events.find((event) => event.type === "board.plans-approved");
        assert.ok(approved?.type === "board.plans-approved");
        expect(approved.payload.card.autoPlan).toEqual({ ...pending, endedAt: LATER });
      }),
    );

    it.effect("ends a pending request on its own, leaving the card in planning", () =>
      Effect.gen(function* () {
        const endCommand = {
          type: "board.card.end-auto-plan",
          commandId: CommandId.make("cmd-end"),
          cardId,
          createdAt: LATER,
        } as const;
        const event = updatedCard(
          yield* decideEvents(
            endCommand,
            readModel([makeCard({ id: "card-auto", autoPlan: pending })]),
          ),
        );
        expect(event.payload.card.autoPlan).toEqual({ ...pending, endedAt: LATER });
        expect(event.payload.card.stage).toBe(BOARD_SEED_STAGE_IDS.planning);
        const error = yield* decideFail(
          endCommand,
          readModel([makeCard({ id: "card-auto", autoPlan: { ...pending, endedAt: NOW } })]),
        );
        expect(error.message).toContain("not being auto-planned");
      }),
    );

    it.effect("turns the card's own Auto-plan off only for a human-caused stop (T3O-38)", () =>
      Effect.gen(function* () {
        const model = readModel([
          makeCard({ id: "card-auto", autoPlan: pending, autoPlanSetting: true }),
        ]);
        const end = (turnOff: boolean): BoardCommand => ({
          type: "board.card.end-auto-plan",
          commandId: CommandId.make(`cmd-end-${turnOff}`),
          cardId,
          ...(turnOff ? { turnOff: true } : {}),
          createdAt: LATER,
        });
        expect(
          updatedCard(yield* decideEvents(end(false), model)).payload.card.autoPlanSetting,
        ).toBe(true);
        const human = updatedCard(yield* decideEvents(end(true), model));
        expect(human.payload.card.autoPlanSetting).toBe(false);
        // The supervisor caused it, so no toggle-change marker re-triggers it.
        expect(human.payload.automationChanged).toBeUndefined();
      }),
    );

    it.effect("records decisions with ids derived from the event, in order", () =>
      Effect.gen(function* () {
        const events = yield* decideEvents(
          {
            type: "board.card.record-decisions",
            commandId: CommandId.make("cmd-decide"),
            cardId,
            decisions: [decision(), decision({ flag: "normal", decidedBy: "human" })],
            stepId: "planning",
            threadId: null,
            createdAt: NOW,
          },
          readModel([makeCard({ id: "card-auto" })]),
        );
        const recorded = events.find((event) => event.type === "board.card-decisions-recorded");
        assert.ok(recorded?.type === "board.card-decisions-recorded");
        expect(recorded.payload.decisions.map((entry) => entry.decisionId)).toEqual([
          `${recorded.eventId}:0`,
          `${recorded.eventId}:1`,
        ]);
        expect(recorded.payload.decisions[1]).toMatchObject({
          cardId,
          stepId: "planning",
          flag: "normal",
          decidedBy: "human",
        });
      }),
    );

    it.effect("refuses an empty batch and one over the cap", () =>
      Effect.gen(function* () {
        const model = readModel([makeCard({ id: "card-auto" })]);
        const record = (count: number): BoardCommand => ({
          type: "board.card.record-decisions",
          commandId: CommandId.make(`cmd-decide-${count}`),
          cardId,
          decisions: Array.from({ length: count }, () => decision()),
          stepId: null,
          threadId: null,
          createdAt: NOW,
        });
        expect((yield* decideFail(record(0), model)).message).toContain("at least one");
        expect(
          (yield* decideFail(record(BOARD_DECISIONS_PER_CALL_MAX + 1), model)).message,
        ).toContain(`at most ${BOARD_DECISIONS_PER_CALL_MAX}`);
      }),
    );
  },
);

// ── Automation toggles ─────────────────────────────────────────

const setAutomation = (
  settings: { autoPlan?: boolean | null; autoBuild?: boolean | null; autoMerge?: boolean | null },
  id = "card-auto",
): BoardCommand => ({
  type: "board.card.set-automation",
  commandId: CommandId.make("cmd-automation"),
  cardId: BoardCardId.make(id),
  ...settings,
  createdAt: LATER,
});

const groupOf = (overrides: Partial<NonNullable<BoardCard["group"]>> = {}) => ({
  target: "inherit" as const,
  autoBuild: false,
  autoMerge: false,
  autoPlan: false,
  started: false,
  placed: BOARD_SEED_STAGE_IDS.ready,
  prevStage: null,
  heading: true,
  integrated: false,
  ...overrides,
});

const moveTo = (stage: string, id = "card-auto", cause?: "auto-build"): BoardCommand => ({
  type: "board.card.move",
  commandId: CommandId.make(`cmd-move-${id}-${stage}`),
  cardId: BoardCardId.make(id),
  toStage: BoardStageId.make(stage),
  override: true,
  ...(cause === undefined ? {} : { cause }),
  createdAt: LATER,
});

const movedCard = (events: ReadonlyArray<PlannedBoardEvent>, id = "card-auto") => {
  const moved = events.find(
    (event) => event.type === "board.card-moved" && event.payload.cardId === id,
  );
  assert.ok(moved?.type === "board.card-moved");
  return moved;
};

const cardIn = (events: ReadonlyArray<PlannedBoardEvent>, id: string) => {
  const last = events.findLast(
    (event) => "card" in event.payload && event.payload.cardId === BoardCardId.make(id),
  );
  return last !== undefined && "card" in last.payload ? (last.payload.card as BoardCard) : null;
};

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  "automation toggles (T3O-38)",
  (it) => {
    it.effect("sets, overrides and clears own toggles, saying which moved", () =>
      Effect.gen(function* () {
        const on = updatedCard(
          yield* decideEvents(
            setAutomation({ autoPlan: true, autoMerge: false }),
            readModel([makeCard({ id: "card-auto" })]),
          ),
        );
        expect(on.payload.card.autoPlanSetting).toBe(true);
        expect(on.payload.card.autoMergeSetting).toBe(false);
        expect(on.payload.automationChanged).toEqual({ autoPlan: true, autoMerge: true });
        const cleared = updatedCard(
          yield* decideEvents(
            setAutomation({ autoPlan: null }),
            readModel([makeCard({ id: "card-auto", autoPlanSetting: true })]),
          ),
        );
        expect(cleared.payload.card.autoPlanSetting).toBe(null);
        const unchanged = yield* decideFail(
          setAutomation({ autoPlan: true }),
          readModel([makeCard({ id: "card-auto", autoPlanSetting: true })]),
        );
        expect(unchanged.message).toContain("unchanged");
      }),
    );

    it.effect("refuses turning a locked toggle on, and always accepts off", () =>
      Effect.gen(function* () {
        const building = readModel([makeCard({ id: "card-auto", stage: "building" })]);
        expect((yield* decideFail(setAutomation({ autoBuild: true }), building)).message).toContain(
          "Building now.",
        );
        expect((yield* decideFail(setAutomation({ autoPlan: true }), building)).message).toContain(
          "Planning is finished.",
        );
        const onWhileLocked = readModel([
          makeCard({ id: "card-auto", stage: "review", autoBuildSetting: true }),
        ]);
        const off = updatedCard(
          yield* decideEvents(setAutomation({ autoBuild: false }), onWhileLocked),
        );
        expect(off.payload.card.autoBuildSetting).toBe(false);
        // Auto-merge never locks on the board itself.
        const merge = updatedCard(
          yield* decideEvents(setAutomation({ autoMerge: true }), building),
        );
        expect(merge.payload.card.autoMergeSetting).toBe(true);
      }),
    );

    it.effect("refuses an inherit that would turn a locked toggle on through its group", () =>
      Effect.gen(function* () {
        const group = makeCard({
          id: "card-group",
          stage: "building",
          group: groupOf({ autoBuild: true, autoPlan: true, started: true }),
        });
        const overriding = makeCard({
          id: "card-auto",
          stage: "building",
          parentCardId: BoardCardId.make("card-group"),
          autoBuildSetting: false,
          autoPlanSetting: false,
        });
        const model = readModel([group, overriding]);
        expect((yield* decideFail(setAutomation({ autoBuild: null }), model)).message).toContain(
          "Building now.",
        );
        expect((yield* decideFail(setAutomation({ autoPlan: null }), model)).message).toContain(
          "Planning is finished.",
        );
        // An inherit that leaves the toggle off is still accepted.
        const offGroup = readModel([
          makeCard({ ...group, group: groupOf({ started: true }) }),
          overriding,
        ]);
        const cleared = updatedCard(
          yield* decideEvents(setAutomation({ autoBuild: null }), offGroup),
        );
        expect(cleared.payload.card.autoBuildSetting).toBe(null);
      }),
    );

    it.effect("turning Auto-merge off clears a held merge", () =>
      Effect.gen(function* () {
        const held = makeCard({
          id: "card-auto",
          stage: "merge",
          autoMergeSetting: true,
          autoMergeHold: {
            reason: "Checks pending.",
            classification: "soft",
            detail: null,
            attempt: 1,
            heldSince: NOW,
            retryAt: LATER,
            headSha: "abc",
          },
        });
        const off = updatedCard(
          yield* decideEvents(setAutomation({ autoMerge: null }), readModel([held])),
        );
        expect(off.payload.card.autoMergeHold).toBe(null);
      }),
    );

    it.effect(
      "a drag back out of Building turns Auto-build off; back into Planning, Auto-plan",
      () =>
        Effect.gen(function* () {
          const built = makeCard({
            id: "card-auto",
            stage: "building",
            autoPlanSetting: true,
            autoBuildSetting: true,
          });
          const toReady = movedCard(yield* decideEvents(moveTo("ready"), readModel([built])));
          expect(toReady.payload.card.autoBuildSetting).toBe(false);
          expect(toReady.payload.card.autoPlanSetting).toBe(true);
          expect(toReady.payload.automationChanged).toEqual({ autoBuild: true });
          const toPlanning = movedCard(yield* decideEvents(moveTo("planning"), readModel([built])));
          expect(toPlanning.payload.card).toMatchObject({
            autoBuildSetting: false,
            autoPlanSetting: false,
          });
          // A forward move turns nothing off; an inheriting card that is off stays inheriting.
          const forward = movedCard(
            yield* decideEvents(
              moveTo("building"),
              readModel([makeCard({ id: "card-auto", stage: "ready" })]),
            ),
          );
          expect(forward.payload.automationChanged).toBeUndefined();
          expect(forward.payload.card.autoBuildSetting).toBe(null);
        }),
    );

    it.effect("a child moved into build begins its group, unless its own Auto-build moved it", () =>
      Effect.gen(function* () {
        const group = makeCard({
          id: "card-group",
          stage: "ready",
          group: groupOf({ autoBuild: true }),
        });
        const child = makeCard({
          id: "card-child",
          stage: "ready",
          parentCardId: BoardCardId.make("card-group"),
        });
        const model = readModel([group, child]);
        const human = yield* decideEvents(moveTo("building", "card-child"), model);
        expect(cardIn(human, "card-group")?.group?.started).toBe(true);
        const own = yield* decideEvents(moveTo("building", "card-child", "auto-build"), model);
        expect(cardIn(own, "card-group")?.group?.started ?? false).toBe(false);
      }),
    );

    it.effect("switching a group to its own branch turns its auto-merge on, and back off", () =>
      Effect.gen(function* () {
        const settings = (patch: Record<string, unknown>, group: BoardCard) =>
          Effect.map(
            decideEvents(
              {
                type: "board.card.set-group-settings",
                commandId: CommandId.make("cmd-group"),
                cardId: group.id,
                createdAt: LATER,
                ...patch,
              } as BoardCommand,
              readModel([group]),
            ),
            (events) => cardIn(events, String(group.id))?.group,
          );
        const inherit = makeCard({ id: "card-auto", stage: "ready", group: groupOf() });
        expect((yield* settings({ target: "own" }, inherit))?.autoMerge).toBe(true);
        // The same command naming auto-merge keeps the user's choice.
        expect((yield* settings({ target: "own", autoMerge: false }, inherit))?.autoMerge).toBe(
          false,
        );
        const own = makeCard({
          id: "card-auto",
          stage: "ready",
          group: groupOf({ target: "own", autoMerge: true }),
        });
        expect((yield* settings({ target: "inherit" }, own))?.autoMerge).toBe(false);
        // A save that does not change the target leaves auto-merge alone.
        expect((yield* settings({ target: "own", autoPlan: true }, own))?.autoMerge).toBe(true);
      }),
    );

    it.effect(
      "a split's group takes the toggles approval names; the card keeps its own merge",
      () =>
        Effect.gen(function* () {
          const card = makeCard({
            id: "card-auto",
            autoPlanSetting: true,
            autoBuildSetting: true,
            autoMergeSetting: true,
            splitRationale: "Two parts that review separately and ship one at a time.",
          });
          const events = yield* decideEvents(
            {
              type: "board.plans.approve",
              commandId: CommandId.make("cmd-approve"),
              cardId,
              autoBuild: true,
              autoPlan: true,
              autoMerge: false,
              mergeTarget: "inherit",
              createdAt: LATER,
            },
            readModel([card], [plan("a", 0), plan("b", 1)]),
          );
          const approved = events.find((event) => event.type === "board.plans-approved");
          assert.ok(approved?.type === "board.plans-approved");
          expect(approved.payload.card.group).toMatchObject({
            autoBuild: true,
            autoPlan: true,
            autoMerge: false,
          });
          expect(approved.payload.card).toMatchObject({
            autoPlanSetting: null,
            autoBuildSetting: null,
            autoMergeSetting: true,
          });
        }),
    );
  },
);
