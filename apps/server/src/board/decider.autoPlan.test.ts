/**
 * Auto-planning and the decision log in the decider (T3O-32): which cards can
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
import * as NodeServices from "@effect/platform-node/NodeServices";
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

const mark = (mode: "build" | "ready" = "build"): BoardCommand => ({
  type: "board.card.mark-auto-plan",
  commandId: CommandId.make("cmd-mark"),
  cardId,
  mode,
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

const pending = { mode: "build" as const, requestedAt: NOW, endedAt: null };

it.layer(NodeServices.layer)("auto-plan and the decision log (T3O-32)", (it) => {
  it.effect("marks a leaf in planning, recording the mode and leaving it pending", () =>
    Effect.gen(function* () {
      const event = updatedCard(
        yield* decideEvents(mark("ready"), readModel([makeCard({ id: "card-auto" })])),
      );
      expect(event.payload.autoPlanMarked).toBe(true);
      expect(event.payload.card.autoPlan).toEqual({
        mode: "ready",
        requestedAt: NOW,
        endedAt: null,
      });
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
});
