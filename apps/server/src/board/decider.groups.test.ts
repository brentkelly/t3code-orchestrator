/**
 * General grouping in the decider (T3O-27, D12): nesting to any depth, the
 * derived group stage, Deferred, revert-on-empty, headings, regrouping, cross-
 * group dependencies and the target lock.
 */
import {
  BOARD_DEFERRED_STAGE_ID,
  BoardCardId,
  BoardStageId,
  CommandId,
  defaultBoardCardGroup,
  EMPTY_BOARD_STATE,
  ProjectId,
  type BoardCard,
  type BoardCardGroup,
  type BoardState,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { boardDecidedEvents, type BoardCommand, type PlannedBoardEvent } from "./decider.ts";
import {
  decideBoardCommandOnModel,
  type BoardOrchestrationReadModel,
} from "./decisionContext.testkit.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");

function card(
  id: string,
  stage: string,
  overrides: Omit<Partial<BoardCard>, "id" | "stage"> = {},
): BoardCard {
  return {
    id: BoardCardId.make(id),
    key: `T3-${id.replace(/\D/g, "") || "1"}`,
    cardNumber: 1,
    projectId,
    labels: [],
    stage: BoardStageId.make(stage),
    orderKey: "m",
    title: `Card ${id}`,
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

const group = (stage: string, overrides: Partial<BoardCardGroup> = {}): BoardCardGroup =>
  defaultBoardCardGroup(EMPTY_BOARD_STATE, { stage: BoardStageId.make(stage) }, overrides);

const child = (
  id: string,
  stage: string,
  parent: string,
  overrides: Omit<Partial<BoardCard>, "id" | "stage"> = {},
) => card(id, stage, { parentCardId: BoardCardId.make(parent), ...overrides });

function model(cards: ReadonlyArray<BoardCard>): BoardOrchestrationReadModel {
  const board: BoardState = { cards, nextCardNumberByProject: { [projectId]: 100 } };
  return {
    projects: [{ id: projectId, title: "Project", workspaceRoot: "/tmp/p", deletedAt: null }],
    threads: [],
    board,
  };
}

const decideEvents = (command: BoardCommand, readModel: BoardOrchestrationReadModel) =>
  decideBoardCommandOnModel({ command, readModel }).pipe(Effect.map(boardDecidedEvents));

const decideFail = (command: BoardCommand, readModel: BoardOrchestrationReadModel) =>
  Effect.flip(decideEvents(command, readModel));

const move = (id: string, toStage: string, override = true): BoardCommand => ({
  type: "board.card.move",
  commandId: CommandId.make(`cmd-move-${id}-${toStage}`),
  cardId: BoardCardId.make(id),
  toStage: BoardStageId.make(toStage),
  override,
  createdAt: NOW,
});

const moveCards = (
  ids: ReadonlyArray<string>,
  parent: string | null,
  position: { readonly after?: string; readonly before?: string } = {},
): BoardCommand => ({
  type: "board.card.move-cards",
  commandId: CommandId.make(`cmd-move-cards-${ids.join("-")}`),
  cardId: BoardCardId.make(ids[0]!),
  cardIds: ids.map((id) => BoardCardId.make(id)),
  parentCardId: parent === null ? null : BoardCardId.make(parent),
  ...(position.after === undefined ? {} : { afterCardId: BoardCardId.make(position.after) }),
  ...(position.before === undefined ? {} : { beforeCardId: BoardCardId.make(position.before) }),
  createdAt: NOW,
});

const settings = (
  id: string,
  fields: Omit<
    Extract<BoardCommand, { type: "board.card.set-group-settings" }>,
    "type" | "commandId" | "cardId" | "createdAt"
  >,
): BoardCommand => ({
  type: "board.card.set-group-settings",
  commandId: CommandId.make(`cmd-settings-${id}`),
  cardId: BoardCardId.make(id),
  ...fields,
  createdAt: NOW,
});

/** Where each card ends up after the decision's events. */
function stagesAfter(
  events: ReadonlyArray<PlannedBoardEvent>,
): ReadonlyMap<string, { readonly stage: string; readonly card: BoardCard }> {
  const out = new Map<string, { readonly stage: string; readonly card: BoardCard }>();
  for (const event of events) {
    if (event.type === "board.card-moved" || event.type === "board.card-updated") {
      out.set(String(event.payload.cardId), {
        stage: event.payload.card.stage,
        card: event.payload.card,
      });
    }
  }
  return out;
}

it.layer(NodeServices.layer)("grouping (T3O-27)", (it) => {
  // ── Nesting ──────────────────────────────────────────────────────────

  it.effect("nests three deep and derives Building all the way up", () =>
    Effect.gen(function* () {
      const cards = [
        card("g1", "sprint", { group: group("sprint") }),
        child("g2", "sprint", "g1", { group: group("sprint") }),
        child("g3", "sprint", "g2", { group: group("sprint") }),
        child("leaf", "ready", "g3"),
      ];
      const events = yield* decideEvents(move("leaf", "building"), model(cards));
      const after = stagesAfter(events);
      expect(after.get("leaf")?.stage).toBe("building");
      expect(after.get("g3")?.stage).toBe("building");
      expect(after.get("g2")?.stage).toBe("building");
      expect(after.get("g1")?.stage).toBe("building");
      // Every derived change is a move, so the supervisor sees each group's
      // arrival the way it sees a drag.
      for (const id of ["g1", "g2", "g3"]) {
        const event = events.find(
          (candidate) =>
            candidate.type === "board.card-moved" && String(candidate.payload.cardId) === id,
        );
        assert.ok(event !== undefined, `${id} moved`);
      }
    }),
  );

  it.effect("creates a card three levels down", () =>
    Effect.gen(function* () {
      const cards = [
        card("g1", "sprint", { group: group("sprint") }),
        child("g2", "sprint", "g1", { group: group("sprint") }),
        child("leaf", "backlog", "g2"),
      ];
      const events = yield* decideEvents(
        {
          type: "board.card.create",
          commandId: CommandId.make("cmd-create-deep"),
          cardId: BoardCardId.make("card-deep"),
          projectId,
          title: "Deep",
          stage: BoardStageId.make("backlog"),
          parentCardId: BoardCardId.make("leaf"),
          createdAt: NOW,
        },
        model(cards),
      );
      assert.ok(events[0]?.type === "board.card-created");
      // The leaf it landed under became a group.
      expect(stagesAfter(events).get("leaf")?.card.group?.placed).toBe("backlog");
    }),
  );

  // ── The derived stage ────────────────────────────────────────────────

  it.effect("an inherit group is Done when every active child is", () =>
    Effect.gen(function* () {
      const cards = [
        card("g", "building", { group: group("sprint", { started: true }) }),
        child("a", "done", "g"),
        child("b", "merge", "g"),
      ];
      const events = yield* decideEvents(move("b", "done", false), model(cards));
      expect(stagesAfter(events).get("g")?.stage).toBe("done");
    }),
  );

  it.effect("an own group sits in its integration review until integrated", () =>
    Effect.gen(function* () {
      const cards = [
        card("g", "building", { group: group("ready", { target: "own", started: true }) }),
        child("a", "done", "g"),
        child("b", "merge", "g"),
      ];
      const events = yield* decideEvents(move("b", "done", false), model(cards));
      expect(stagesAfter(events).get("g")?.stage).toBe("review");
    }),
  );

  it.effect("an own group that reached Done is integrated, and stays Done", () =>
    Effect.gen(function* () {
      const cards = [
        card("g", "merge", { group: group("ready", { target: "own", started: true }) }),
        child("a", "done", "g"),
      ];
      const events = yield* decideEvents(move("g", "done", false), model(cards));
      const after = stagesAfter(events).get("g");
      expect(after?.stage).toBe("done");
      expect(after?.card.group?.integrated).toBe(true);
    }),
  );

  it.effect(
    "a group returns to Building when a child leaves Done, and is no longer integrated",
    () =>
      Effect.gen(function* () {
        const cards = [
          card("g", "done", {
            group: group("ready", { target: "own", started: true, integrated: true }),
          }),
          child("a", "done", "g"),
          child("b", "done", "g"),
        ];
        const events = yield* decideEvents(move("b", "review"), model(cards));
        const after = stagesAfter(events).get("g");
        expect(after?.stage).toBe("building");
        expect(after?.card.group?.integrated).toBe(false);
      }),
  );

  it.effect("a group sits in `placed` while no child has started", () =>
    Effect.gen(function* () {
      const cards = [
        card("g", "building", { group: group("sprint") }),
        child("a", "building", "g"),
        child("b", "ready", "g"),
      ];
      const events = yield* decideEvents(move("a", "ready"), model(cards));
      expect(stagesAfter(events).get("g")?.stage).toBe("sprint");
    }),
  );

  it.effect("Deferred children do not count toward done", () =>
    Effect.gen(function* () {
      const cards = [
        card("g", "building", { group: group("sprint", { started: true }) }),
        child("a", "done", "g"),
        child("b", "ready", "g"),
      ];
      const events = yield* decideEvents(move("b", BOARD_DEFERRED_STAGE_ID), model(cards));
      const after = stagesAfter(events);
      expect(after.get("b")?.stage).toBe(BOARD_DEFERRED_STAGE_ID);
      expect(after.get("g")?.stage).toBe("done");
    }),
  );

  // ── Deferred ─────────────────────────────────────────────────────────

  it.effect("refuses Deferred at the root", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        move("a", BOARD_DEFERRED_STAGE_ID),
        model([card("a", "backlog")]),
      );
      assert.include(String(failure), "only a group's cards can be deferred");
    }),
  );

  it.effect("refuses deferring a started card", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        move("a", BOARD_DEFERRED_STAGE_ID),
        model([card("g", "building", { group: group("sprint") }), child("a", "building", "g")]),
      );
      assert.include(String(failure), "Work has started on 'T3-1'");
    }),
  );

  it.effect("a deferred card moved to the root lands in Backlog", () =>
    Effect.gen(function* () {
      const cards = [
        card("g", "sprint", { group: group("sprint") }),
        child("a", BOARD_DEFERRED_STAGE_ID, "g"),
        child("b", "ready", "g"),
      ];
      const events = yield* decideEvents(moveCards(["a"], null), model(cards));
      const after = stagesAfter(events).get("a");
      expect(after?.stage).toBe("backlog");
      expect(after?.card.parentCardId).toBeNull();
    }),
  );

  it.effect("leaving Deferred walks back in before build, but needs override to skip ahead", () =>
    Effect.gen(function* () {
      const cards = [
        card("g", "sprint", { group: group("sprint") }),
        child("a", BOARD_DEFERRED_STAGE_ID, "g"),
        child("b", "ready", "g"),
      ];
      const skip = yield* decideFail(move("a", "done", false), model(cards));
      assert.include(String(skip), "is not adjacent");
      const review = yield* decideFail(move("a", "review", false), model(cards));
      assert.include(String(review), "is not adjacent");
      const back = yield* decideEvents(move("a", "ready", false), model(cards));
      expect(stagesAfter(back).get("a")?.stage).toBe("ready");
    }),
  );

  // ── Empty groups ─────────────────────────────────────────────────────

  it.effect("a group losing its last child reverts at its previous stage, capped at Sprint", () =>
    Effect.gen(function* () {
      const cards = [
        card("g", "planning", {
          group: { ...group("planning"), prevStage: BoardStageId.make("planning") },
        }),
        child("a", "ready", "g"),
      ];
      const events = yield* decideEvents(moveCards(["a"], null), model(cards));
      const after = stagesAfter(events).get("g");
      expect(after?.card.group).toBeNull();
      expect(after?.stage).toBe("sprint");
    }),
  );

  it.effect("a heading stays a group with no children", () =>
    Effect.gen(function* () {
      const cards = [
        card("g", "backlog", { group: group("backlog", { heading: true }) }),
        child("a", "backlog", "g"),
      ];
      const events = yield* decideEvents(moveCards(["a"], null), model(cards));
      expect(stagesAfter(events).has("g")).toBe(false);
    }),
  );

  it.effect("creates an empty heading", () =>
    Effect.gen(function* () {
      const events = yield* decideEvents(
        {
          type: "board.card.create",
          commandId: CommandId.make("cmd-heading"),
          cardId: BoardCardId.make("card-heading"),
          projectId,
          title: "Epic",
          heading: true,
          createdAt: NOW,
        },
        model([]),
      );
      const created = events[0]!;
      assert.ok(created.type === "board.card-created");
      expect(created.payload.group?.heading).toBe(true);
    }),
  );

  // ── Regrouping ───────────────────────────────────────────────────────

  it.effect("refuses moving a card inside itself", () =>
    Effect.gen(function* () {
      const cards = [card("g", "sprint", { group: group("sprint") }), child("a", "ready", "g")];
      const failure = yield* decideFail(moveCards(["g"], "a"), model(cards));
      assert.include(String(failure), "can't move inside itself");
    }),
  );

  it.effect("refuses making a started leaf a parent", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        moveCards(["b"], "a"),
        model([card("a", "building"), card("b", "backlog")]),
      );
      assert.include(String(failure), "cannot become a group");
    }),
  );

  it.effect("moves ancestors first: a descendant travels with its group", () =>
    Effect.gen(function* () {
      const cards = [
        card("g", "sprint", { group: group("sprint") }),
        child("a", "ready", "g"),
        card("h", "sprint", { group: group("sprint", { heading: true }) }),
      ];
      const events = yield* decideEvents(moveCards(["g", "a"], "h"), model(cards));
      const after = stagesAfter(events);
      expect(after.get("g")?.card.parentCardId).toBe(BoardCardId.make("h"));
      // The child was not re-parented out from under its group.
      expect(after.get("a")).toBeUndefined();
    }),
  );

  it.effect("places moved cards next to the named sibling", () =>
    Effect.gen(function* () {
      const cards = [
        card("g", "sprint", { group: group("sprint") }),
        child("a", "backlog", "g", { orderKey: "c" }),
        child("b", "backlog", "g", { orderKey: "e" }),
        card("x", "backlog", { orderKey: "m" }),
      ];
      const events = yield* decideEvents(moveCards(["x"], "g", { after: "a" }), model(cards));
      const key = stagesAfter(events).get("x")?.card.orderKey ?? "";
      expect(key > "c" && key < "e").toBe(true);
    }),
  );

  it.effect("marks only a change of parent as a regrouping, not a reorder", () =>
    Effect.gen(function* () {
      const cards = [
        card("g", "sprint", { group: group("sprint") }),
        child("a", "backlog", "g", { orderKey: "c" }),
        child("b", "backlog", "g", { orderKey: "e" }),
        card("x", "backlog", { orderKey: "m" }),
      ];
      const regroupedOf = (events: ReadonlyArray<PlannedBoardEvent>, id: string) => {
        const event = events.find(
          (candidate) =>
            candidate.type === "board.card-updated" && String(candidate.payload.cardId) === id,
        );
        assert.ok(event?.type === "board.card-updated");
        return event.payload.regrouped;
      };
      const reorder = yield* decideEvents(moveCards(["b"], "g", { before: "a" }), model(cards));
      expect(regroupedOf(reorder, "b")).toBeUndefined();
      const indent = yield* decideEvents(moveCards(["x"], "g"), model(cards));
      expect(regroupedOf(indent, "x")).toBe(true);
    }),
  );

  it.effect("refuses indenting a pre-floor card into an own group", () =>
    Effect.gen(function* () {
      const cards = [
        card("g", "sprint", { group: group("sprint", { target: "own" }) }),
        child("a", "ready", "g"),
        card("x", "backlog"),
      ];
      const failure = yield* decideFail(moveCards(["x"], "g"), model(cards));
      assert.include(String(failure), "live from the materialisation floor onward");
      const ready = cards.map((c) =>
        c.id === "x" ? { ...c, stage: BoardStageId.make("ready") } : c,
      );
      const events = yield* decideEvents(moveCards(["x"], "g"), model(ready));
      expect(stagesAfter(events).get("x")?.card.parentCardId).toBe(BoardCardId.make("g"));
    }),
  );

  it.effect("refuses moving a started card onto a different integration branch", () =>
    Effect.gen(function* () {
      const cards = [
        card("own", "building", { group: group("ready", { target: "own", started: true }) }),
        child("a", "building", "own"),
      ];
      const failure = yield* decideFail(moveCards(["a"], null), model(cards));
      assert.include(String(failure), "Rebase onto trunk first");
    }),
  );

  it.effect("abandons a converted leaf's planning: the conversion is flagged", () =>
    Effect.gen(function* () {
      const events = yield* decideEvents(
        moveCards(["b"], "a"),
        model([card("a", "planning"), card("b", "backlog")]),
      );
      const conversion = events.find(
        (event) => event.type === "board.card-updated" && String(event.payload.cardId) === "a",
      );
      assert.ok(conversion?.type === "board.card-updated");
      expect(conversion.payload.becameGroup).toBe(true);
      expect(conversion.payload.card.group?.prevStage).toBe("planning");
    }),
  );

  // ── Dependencies ─────────────────────────────────────────────────────

  const update = (id: string, addDependsOn: ReadonlyArray<string>): BoardCommand => ({
    type: "board.card.update",
    commandId: CommandId.make(`cmd-update-${id}`),
    cardId: BoardCardId.make(id),
    addDependsOn: addDependsOn.map((dep) => BoardCardId.make(dep)),
    createdAt: NOW,
  });

  it.effect("accepts a dependency across groups", () =>
    Effect.gen(function* () {
      const cards = [
        card("g1", "sprint", { group: group("sprint") }),
        child("a", "ready", "g1"),
        card("g2", "sprint", { group: group("sprint") }),
        child("b", "ready", "g2"),
      ];
      const events = yield* decideEvents(update("a", ["b"]), model(cards));
      assert.ok(events[0]?.type === "board.card-updated");
    }),
  );

  it.effect("refuses a cycle that runs through a group", () =>
    Effect.gen(function* () {
      // a waits on group g; g waits on its child b; b waiting on a closes it.
      const cards = [
        card("a", "ready", { dependsOn: [BoardCardId.make("g")] }),
        card("g", "sprint", { group: group("sprint") }),
        child("b", "ready", "g"),
      ];
      const failure = yield* decideFail(update("b", ["a"]), model(cards));
      assert.include(String(failure), "cycle");
    }),
  );

  it.effect("a cycle that predates a regrouping or an update does not block it", () =>
    Effect.gen(function* () {
      // A legacy child -> own-parent edge, from before the scope rule.
      const cards = [
        card("g", "building", { group: group("ready", { target: "own" }) }),
        child("c", "ready", "g", { dependsOn: [BoardCardId.make("g")] }),
        card("h", "sprint", { group: group("sprint", { heading: true }) }),
        card("x", "ready"),
        card("y", "ready"),
      ];
      const moved = yield* decideEvents(moveCards(["x"], "h"), model(cards));
      expect(stagesAfter(moved).get("x")?.card.parentCardId).toBe(BoardCardId.make("h"));
      const updated = yield* decideEvents(update("c", ["y"]), model(cards));
      assert.ok(updated[0]?.type === "board.card-updated");
    }),
  );

  it.effect("a cycle that predates a regrouping does not hide a new one it closes", () =>
    Effect.gen(function* () {
      // m <-> p is a legacy cycle; moving m into k closes k -> m -> q -> k.
      const cards = [
        card("m", "ready", { dependsOn: [BoardCardId.make("p"), BoardCardId.make("q")] }),
        card("p", "ready", { dependsOn: [BoardCardId.make("m")] }),
        card("q", "ready", { dependsOn: [BoardCardId.make("k")] }),
        card("k", "sprint", { group: group("sprint", { heading: true }) }),
      ];
      const failure = yield* decideFail(moveCards(["m"], "k"), model(cards));
      assert.include(String(failure), "dependency cycle");
    }),
  );

  it.effect("refuses a regrouping that closes a cycle through a group", () =>
    Effect.gen(function* () {
      const cards = [
        card("a", "ready", { dependsOn: [BoardCardId.make("g")] }),
        card("g", "sprint", { group: group("sprint", { heading: true }) }),
        card("b", "ready", { dependsOn: [BoardCardId.make("a")] }),
      ];
      const failure = yield* decideFail(moveCards(["b"], "g"), model(cards));
      assert.include(String(failure), "dependency cycle");
    }),
  );

  it.effect("refuses a cycle a group's own dependency closes through a card inside it", () =>
    Effect.gen(function* () {
      // c inside g waits on g's dependency x, so x waiting on c deadlocks both.
      const cards = [
        card("g", "sprint", { group: group("sprint"), dependsOn: [BoardCardId.make("x")] }),
        child("c", "ready", "g"),
        card("x", "ready"),
      ];
      const failure = yield* decideFail(update("x", ["c"]), model(cards));
      assert.include(String(failure), "x -> c -> x");
      // The same deadlock reached by giving the group the dependency.
      const reverse = [
        card("g", "sprint", { group: group("sprint") }),
        child("c", "ready", "g"),
        card("x", "ready", { dependsOn: [BoardCardId.make("c")] }),
      ];
      const viaGroup = yield* decideFail(update("g", ["x"]), model(reverse));
      assert.include(String(viaGroup), "cycle");
    }),
  );

  it.effect("refuses a regrouping into a group whose dependency waits on the card", () =>
    Effect.gen(function* () {
      const cards = [
        card("g", "sprint", {
          group: group("sprint", { heading: true }),
          dependsOn: [BoardCardId.make("x")],
        }),
        card("c", "ready"),
        card("x", "ready", { dependsOn: [BoardCardId.make("c")] }),
      ];
      const failure = yield* decideFail(moveCards(["c"], "g"), model(cards));
      assert.include(String(failure), "dependency cycle");
    }),
  );

  it.effect("refuses depending on your own ancestor, and a group on its own child", () =>
    Effect.gen(function* () {
      const cards = [
        card("g1", "sprint", { group: group("sprint") }),
        child("g2", "sprint", "g1", { group: group("sprint") }),
        child("leaf", "ready", "g2"),
      ];
      const ancestor = yield* decideFail(update("leaf", ["g1"]), model(cards));
      assert.include(String(ancestor), "cannot also wait for it");
      const descendant = yield* decideFail(update("g1", ["leaf"]), model(cards));
      assert.include(String(descendant), "already waits for everything inside it");
    }),
  );

  it.effect("a dependency on a group is met when the group reaches Done", () =>
    Effect.gen(function* () {
      const cards = [
        card("g", "building", { group: group("sprint", { started: true }) }),
        child("a", "merge", "g"),
        card("waiting", "building", { dependsOn: [BoardCardId.make("g")], blocked: true }),
      ];
      const events = yield* decideEvents(move("a", "done", false), model(cards));
      const after = stagesAfter(events);
      expect(after.get("g")?.stage).toBe("done");
      expect(after.get("waiting")?.card.blocked).toBe(false);
    }),
  );

  // ── Settings ─────────────────────────────────────────────────────────

  it.effect("sets a group's settings", () =>
    Effect.gen(function* () {
      const cards = [card("g", "sprint", { group: group("sprint") }), child("a", "ready", "g")];
      const events = yield* decideEvents(
        settings("g", { autoBuild: true, autoPlan: true }),
        model(cards),
      );
      const after = stagesAfter(events).get("g");
      expect(after?.card.group?.autoBuild).toBe(true);
      expect(after?.card.group?.autoPlan).toBe(true);
    }),
  );

  it.effect("locks the target while a descendant leaf has started", () =>
    Effect.gen(function* () {
      const cards = [
        card("g", "building", { group: group("sprint", { started: true }) }),
        child("inner", "building", "g", { group: group("sprint", { started: true }) }),
        child("a", "building", "inner"),
      ];
      const failure = yield* decideFail(settings("g", { target: "own" }), model(cards));
      assert.include(String(failure), "merge target is locked");
      // Auto-build is not locked: turning it off never interrupts a child.
      const events = yield* decideEvents(settings("g", { autoBuild: true }), model(cards));
      assert.ok(events[0]?.type === "board.card-updated");
    }),
  );

  it.effect("refuses giving a group its own branch while a child is before the floor", () =>
    Effect.gen(function* () {
      const cards = [
        card("g", "sprint", { group: group("sprint") }),
        child("a", "ready", "g"),
        child("b", "backlog", "g"),
        child("d", BOARD_DEFERRED_STAGE_ID, "g"),
      ];
      const failure = yield* decideFail(settings("g", { target: "own" }), model(cards));
      assert.include(String(failure), "is in 'backlog'");
      // Deferred children wait outside the pipeline, so they do not block it.
      const ready = cards.map((c) =>
        c.id === "b" ? { ...c, stage: BoardStageId.make("ready") } : c,
      );
      const events = yield* decideEvents(settings("g", { target: "own" }), model(ready));
      expect(stagesAfter(events).get("g")?.card.group?.target).toBe("own");
    }),
  );

  it.effect("refuses an own branch for an inherit group whose children have all merged", () =>
    Effect.gen(function* () {
      const cards = [
        card("g", "done", { group: group("sprint", { started: true }) }),
        child("a", "done", "g"),
        child("b", "done", "g"),
      ];
      const failure = yield* decideFail(settings("g", { target: "own" }), model(cards));
      assert.include(String(failure), "has already merged");
    }),
  );

  it.effect("walking an integrated own group back into its lane clears integrated", () =>
    Effect.gen(function* () {
      const cards = [
        card("g", "done", {
          group: group("ready", { target: "own", started: true, integrated: true }),
        }),
        child("a", "done", "g"),
      ];
      const events = yield* decideEvents(move("g", "review"), model(cards));
      const after = stagesAfter(events).get("g");
      expect(after?.stage).toBe("review");
      expect(after?.card.group?.integrated).toBe(false);
    }),
  );

  it.effect("refuses settings on a leaf", () =>
    Effect.gen(function* () {
      const failure = yield* decideFail(
        settings("a", { autoBuild: true }),
        model([card("a", "ready")]),
      );
      assert.include(String(failure), "is not a group");
    }),
  );

  // ── Healing ──────────────────────────────────────────────────────────

  it.effect("sync-groups re-derives a group left out of step", () =>
    Effect.gen(function* () {
      const cards = [
        card("g", "sprint", { group: group("sprint", { started: true }) }),
        child("a", "done", "g"),
      ];
      const events = yield* decideEvents(
        {
          type: "board.card.sync-groups",
          commandId: CommandId.make("cmd-sync"),
          cardId: BoardCardId.make("a"),
          createdAt: NOW,
        },
        model(cards),
      );
      expect(stagesAfter(events).get("g")?.stage).toBe("done");
    }),
  );
});

it.layer(NodeServices.layer)("integration branches across projects and targets (T3O-28)", (it) => {
  const otherProject = ProjectId.make("project-2");
  const twoProjects = (cards: ReadonlyArray<BoardCard>): BoardOrchestrationReadModel => {
    const base = model(cards);
    return {
      ...base,
      projects: [
        ...base.projects,
        { id: otherProject, title: "Other", workspaceRoot: "/tmp/q", deletedAt: null },
      ],
    };
  };

  it.effect("refuses an own branch for a group whose subtree spans projects", () =>
    Effect.gen(function* () {
      const cards = [
        card("g", "sprint", { group: group("sprint") }),
        child("a", "ready", "g"),
        child("b", "ready", "g", { projectId: otherProject }),
      ];
      const failure = yield* decideFail(settings("g", { target: "own" }), twoProjects(cards));
      assert.include(String(failure), "is in another project");
      // An inherit group may span projects: its children land on trunk.
      const same = cards.filter((c) => c.id !== "b");
      const events = yield* decideEvents(settings("g", { target: "own" }), twoProjects(same));
      expect(stagesAfter(events).get("g")?.card.group?.target).toBe("own");
    }),
  );

  it.effect("refuses moving a card from another project onto an integration branch", () =>
    Effect.gen(function* () {
      const cards = [
        card("own", "sprint", { group: group("sprint", { target: "own" }) }),
        child("a", "ready", "own"),
        // An inherit group under the own group: its children still land on own's branch.
        child("h", "ready", "own", { group: group("ready") }),
        child("h1", "ready", "h"),
        card("epic", "sprint", { group: group("sprint") }),
        card("x", "ready", { projectId: otherProject }),
      ];
      const intoOwn = yield* decideFail(moveCards(["x"], "own"), twoProjects(cards));
      assert.include(String(intoOwn), "in another project");
      const intoNested = yield* decideFail(moveCards(["x"], "h"), twoProjects(cards));
      assert.include(String(intoNested), "in another project");
      // A top-level inherit group lands on trunk, so projects may mix there.
      const events = yield* decideEvents(moveCards(["x"], "epic"), twoProjects(cards));
      expect(stagesAfter(events).get("x")?.card.parentCardId).toBe(BoardCardId.make("epic"));
    }),
  );

  it.effect("refuses creating a card from another project on an integration branch", () =>
    Effect.gen(function* () {
      const cards = [card("own", "sprint", { group: group("sprint", { target: "own" }) })];
      const failure = yield* decideFail(
        {
          type: "board.card.create",
          commandId: CommandId.make("cmd-create-foreign"),
          cardId: BoardCardId.make("new"),
          projectId: otherProject,
          title: "Foreign",
          parentCardId: BoardCardId.make("own"),
          stage: BoardStageId.make("ready"),
          createdAt: NOW,
        },
        twoProjects(cards),
      );
      assert.include(String(failure), "in another project");
    }),
  );

  it.effect("moves a subtree whose started leaf sits under its own-branch group", () =>
    Effect.gen(function* () {
      // outer (own) > mid (inherit) > inner (own) > leaf (building). Moving mid
      // to the top level leaves leaf on inner's branch: it isn't checked.
      const cards = [
        card("outer", "building", { group: group("ready", { target: "own", started: true }) }),
        child("mid", "building", "outer", { group: group("ready") }),
        child("inner", "building", "mid", {
          group: group("ready", { target: "own", started: true }),
        }),
        child("leaf", "building", "inner"),
      ];
      const events = yield* decideEvents(moveCards(["mid"], null), model(cards));
      expect(stagesAfter(events).get("mid")?.card.parentCardId).toBeNull();
      // A started leaf directly under mid is checked, and refused.
      const direct = [...cards, child("lone", "building", "mid")];
      const failure = yield* decideFail(moveCards(["mid"], null), model(direct));
      assert.include(String(failure), "Rebase onto trunk first");
    }),
  );
});

it.layer(NodeServices.layer)("destructive group flows (T3O-28)", (it) => {
  const archive = (id: string, confirmCardKey?: string): BoardCommand => ({
    type: "board.card.archive",
    commandId: CommandId.make(`cmd-archive-${id}`),
    cardId: BoardCardId.make(id),
    ...(confirmCardKey === undefined ? {} : { confirmCardKey }),
    createdAt: NOW,
  });
  const archivedIds = (events: ReadonlyArray<PlannedBoardEvent>) =>
    events.flatMap((event) =>
      event.type === "board.card-archived"
        ? [{ id: String(event.payload.cardId), discard: event.payload.discard === true }]
        : [],
    );

  const tree = () => [
    card("g1", "building", { group: group("ready", { target: "own", started: true }) }),
    child("a2", "building", "g1"),
    child("d3", BOARD_DEFERRED_STAGE_ID, "g1"),
    child("g4", "building", "g1", { group: group("ready", { target: "own", started: true }) }),
    child("b5", "review", "g4"),
    card("x6", "ready", { dependsOn: [BoardCardId.make("a2")], blocked: true }),
  ];

  it.effect("archives a group's whole subtree for good, only with its key", () =>
    Effect.gen(function* () {
      const plain = yield* decideFail(archive("g1"), model(tree()));
      assert.include(String(plain), "have an agent call board_archive_card with its key confirmed");
      const wrong = yield* decideFail(archive("g1", "T3-4"), model(tree()));
      assert.include(String(wrong), "does not match");
      const leaf = yield* decideFail(archive("x6", "T3-6"), model(tree()));
      assert.include(String(leaf), "is not a group");

      const events = yield* decideEvents(archive("g1", "T3-1"), model(tree()));
      expect(archivedIds(events)).toEqual([
        { id: "g1", discard: true },
        { id: "a2", discard: true },
        { id: "d3", discard: true },
        { id: "g4", discard: true },
        { id: "b5", discard: true },
      ]);
      // A dependent outside the subtree stops waiting on an archived card.
      expect(stagesAfter(events).get("x6")?.card.blocked).toBe(false);
    }),
  );

  it.effect("a group archive leaves each branch's discard pending until it is settled", () =>
    Effect.gen(function* () {
      const worktree: NonNullable<BoardCard["worktree"]> = {
        branch: "board/t3-2",
        baseRefName: "board/t3-1",
        path: null,
        status: "reclaimed",
        attempts: 1,
        lastError: null,
        reclaimBlockedReason: null,
      };
      const cards = tree().map((c) => (c.id === "a2" ? { ...c, worktree } : c));
      const events = yield* decideEvents(archive("g1", "T3-1"), model(cards));
      const archived = events.flatMap((event) =>
        event.type === "board.card-archived" && event.payload.cardId === "a2"
          ? [event.payload.card]
          : [],
      );
      expect(archived[0]?.worktree?.discardPending).toBe(true);

      const settled = yield* decideEvents(
        {
          type: "board.card.reclaim-worktree",
          commandId: CommandId.make("cmd-settle-a2"),
          cardId: BoardCardId.make("a2"),
          outcome: "removed",
          forced: true,
          discardSettled: true,
          createdAt: NOW,
        },
        model(cards.map((c) => (c.id === "a2" ? archived[0]! : c))),
      );
      expect(stagesAfter(settled).get("a2")?.card.worktree?.discardPending).toBeUndefined();
    }),
  );

  it.effect("unarchiving the group calls off a discard that had not settled", () =>
    Effect.gen(function* () {
      const at = "2026-01-02T00:00:00.000Z";
      const pending: NonNullable<BoardCard["worktree"]> = {
        branch: "board/t3-2",
        baseRefName: "board/t3-1",
        path: "/tmp/wt/t3-2",
        status: "ready",
        attempts: 1,
        lastError: null,
        reclaimBlockedReason: null,
        discardPending: true,
      };
      const cards = [
        card("g1", "building", {
          group: group("ready", { target: "own", started: true }),
          archivedAt: at,
        }),
        child("a2", "building", "g1", { archivedAt: at, worktree: pending }),
      ];
      const events = yield* decideEvents(
        {
          type: "board.card.unarchive",
          commandId: CommandId.make("cmd-unarchive-g1-pending"),
          cardId: BoardCardId.make("g1"),
          createdAt: NOW,
        },
        model(cards),
      );
      const a2 = events.flatMap((event) =>
        event.type === "board.card-unarchived" && event.payload.cardId === "a2"
          ? [event.payload.card]
          : [],
      )[0];
      expect(a2?.archivedAt).toBeNull();
      expect(a2?.worktree?.branch).toBe("board/t3-2");
      expect(a2?.worktree?.discardPending).toBeUndefined();
    }),
  );

  it.effect("unarchiving the group restores the subtree archived with it, nothing else", () =>
    Effect.gen(function* () {
      const at = "2026-01-02T00:00:00.000Z";
      const earlier = "2025-12-31T00:00:00.000Z";
      const cards = [
        card("g1", "building", {
          group: group("ready", { target: "own", started: true }),
          archivedAt: at,
        }),
        child("a2", "building", "g1", { archivedAt: at }),
        child("g4", "building", "g1", {
          group: group("ready", { target: "own" }),
          archivedAt: at,
        }),
        child("b5", "review", "g4", { archivedAt: at }),
        child("c7", "ready", "g1", { archivedAt: earlier }),
      ];
      const events = yield* decideEvents(
        {
          type: "board.card.unarchive",
          commandId: CommandId.make("cmd-unarchive-g1"),
          cardId: BoardCardId.make("g1"),
          createdAt: NOW,
        },
        model(cards),
      );
      const restored = events.flatMap((event) =>
        event.type === "board.card-unarchived" ? [String(event.payload.cardId)] : [],
      );
      expect(restored).toEqual(["g1", "a2", "g4", "b5"]);
    }),
  );

  it.effect("cancels a started leaf's work and makes it an empty group at Sprint", () =>
    Effect.gen(function* () {
      const pullRequest: NonNullable<BoardCard["pullRequest"]> = {
        number: 41,
        title: "Work",
        url: "https://example.test/pr/41",
        baseRef: "main",
        headBranch: "board/t3-1",
        state: "open",
        checkedAt: NOW,
      };
      const started = card("x1", "review", {
        worktree: {
          branch: "board/t3-1",
          baseRefName: "main",
          path: "/tmp/wt",
          status: "ready",
          attempts: 1,
          lastError: null,
          reclaimBlockedReason: null,
        },
        pullRequest,
      });
      const cancel = (key: string): BoardCommand => ({
        type: "board.card.cancel-work",
        commandId: CommandId.make(`cmd-cancel-${key}`),
        cardId: BoardCardId.make("x1"),
        confirmCardKey: key,
        createdAt: NOW,
      });
      const wrong = yield* decideFail(cancel("T3-2"), model([started]));
      assert.include(String(wrong), "does not match");
      const notStarted = yield* decideFail(cancel("T3-1"), model([card("x1", "sprint")]));
      assert.include(String(notStarted), "nothing to cancel");
      // A merged card's dependents rely on it; cancelling would revert it silently.
      const done = yield* decideFail(
        cancel("T3-1"),
        model([{ ...card("x1", "done"), worktree: started.worktree, pullRequest }]),
      );
      assert.include(String(done), "is Done");

      const events = yield* decideEvents(cancel("T3-1"), model([started]));
      const updated = events.find((event) => event.type === "board.card-updated");
      assert(updated !== undefined && updated.type === "board.card-updated");
      expect(updated.payload.workCancelled).toBe(true);
      expect(events.some((event) => event.type === "board.card-moved")).toBe(false);
      const after = updated.payload.card;
      expect(after.stage).toBe("sprint");
      expect(after.group?.heading).toBe(true);
      expect(after.group?.prevStage).toBe("sprint");
      expect(after.pullRequest).toBeNull();
      expect(after.pullRequestHistory.map((entry) => entry.number)).toEqual([41]);
      // The branch stays until the worktree is reclaimed.
      expect(after.worktree?.status).toBe("ready");

      // Now a group, so it takes cards; it can't take its own branch until
      // the cancelled work's worktree is gone.
      const next = [after, card("y2", "ready")];
      const into = yield* decideEvents(moveCards(["y2"], "x1"), model(next));
      expect(stagesAfter(into).get("y2")?.card.parentCardId).toBe(BoardCardId.make("x1"));
      const own = yield* decideFail(settings("x1", { target: "own" }), model(next));
      assert.include(String(own), "cancelled work");
    }),
  );

  it.effect("an own group can't drop to inherit while its integration worktree is there", () =>
    Effect.gen(function* () {
      const worktree: NonNullable<BoardCard["worktree"]> = {
        branch: "board/t3-1",
        baseRefName: "main",
        path: "/tmp/wt",
        status: "ready",
        attempts: 1,
        lastError: null,
        reclaimBlockedReason: null,
      };
      // Final review: every child is Done, so the target lock no longer holds.
      const cards = [
        card("g1", "review", { group: group("review", { target: "own" }), worktree }),
        child("c2", "done", "g1"),
      ];
      const refused = yield* decideFail(settings("g1", { target: "inherit" }), model(cards));
      assert.include(String(refused), "integration worktree");
      // Once the worktree is reclaimed the switch is allowed.
      const reclaimed = [
        { ...cards[0]!, worktree: { ...worktree, status: "reclaimed" as const } },
        cards[1]!,
      ];
      const events = yield* decideEvents(settings("g1", { target: "inherit" }), model(reclaimed));
      expect(stagesAfter(events).get("g1")?.card.group?.target).toBe("inherit");
    }),
  );

  it.effect("archiving a Done group's last child leaves the group Done", () =>
    Effect.gen(function* () {
      const cards = [
        card("g", "done", {
          group: group("ready", { target: "own", started: true, integrated: true }),
        }),
        child("a", "done", "g"),
      ];
      const events = yield* decideEvents(
        {
          type: "board.card.archive",
          commandId: CommandId.make("cmd-archive-a"),
          cardId: BoardCardId.make("a"),
          createdAt: NOW,
        },
        model(cards),
      );
      expect(stagesAfter(events).has("g")).toBe(false);
    }),
  );

  it.effect("a sync-groups heal after the last child is archived leaves the group Done", () =>
    Effect.gen(function* () {
      const settled = group("ready", { target: "own", started: true, integrated: true });
      const cards = [
        card("g", "done", { group: settled }),
        child("a", "done", "g", { archivedAt: NOW }),
      ];
      const events = yield* decideEvents(
        {
          type: "board.card.sync-groups",
          commandId: CommandId.make("cmd-sync-g"),
          cardId: BoardCardId.make("g"),
          createdAt: NOW,
        },
        model(cards),
      );
      expect(stagesAfter(events).has("g")).toBe(false);
    }),
  );

  it.effect("a group derived out of Done retires its merged pull request", () =>
    Effect.gen(function* () {
      const pullRequest: NonNullable<BoardCard["pullRequest"]> = {
        number: 7,
        title: "Integration",
        url: "https://example.test/pr/7",
        baseRef: "main",
        headBranch: "board/t3-1",
        state: "merged",
        checkedAt: NOW,
      };
      const cards = [
        card("g", "done", {
          group: group("ready", { target: "own", started: true, integrated: true }),
          pullRequest,
        }),
        child("a", "done", "g"),
        child("b", "done", "g"),
      ];
      const events = yield* decideEvents(move("b", "review"), model(cards));
      const after = stagesAfter(events).get("g")?.card;
      expect(after?.stage).toBe("building");
      expect(after?.pullRequest).toBeNull();
      expect(after?.pullRequestHistory.map((entry) => entry.number)).toEqual([7]);
      expect(after?.pullRequestFloor).toBe(7);
    }),
  );

  it.effect("an emptied own group's unused integration branch is no one-way door", () =>
    Effect.gen(function* () {
      const slice: NonNullable<BoardCard["worktree"]> = {
        branch: "board/t3-1",
        baseRefName: "main",
        path: null,
        status: "branch-only",
        attempts: 1,
        lastError: null,
        reclaimBlockedReason: null,
      };
      const reverted = card("g1", "sprint", { worktree: slice });
      const into = yield* decideEvents(
        moveCards(["b2"], "g1"),
        model([reverted, card("b2", "backlog")]),
      );
      expect(stagesAfter(into).get("b2")?.card.parentCardId).toBe(BoardCardId.make("g1"));
      const deferred = yield* decideEvents(
        move("g1", BOARD_DEFERRED_STAGE_ID),
        model([
          card("h0", "sprint", { group: group("sprint") }),
          { ...reverted, parentCardId: BoardCardId.make("h0") },
        ]),
      );
      expect(stagesAfter(deferred).get("g1")?.stage).toBe(BOARD_DEFERRED_STAGE_ID);
    }),
  );

  it.effect("unarchive returns a card whose parent can no longer hold it to the top level", () =>
    Effect.gen(function* () {
      const at = "2026-01-02T00:00:00.000Z";
      const unarchive: BoardCommand = {
        type: "board.card.unarchive",
        commandId: CommandId.make("cmd-unarchive-a"),
        cardId: BoardCardId.make("a"),
        createdAt: NOW,
      };
      const restoredCard = (events: ReadonlyArray<PlannedBoardEvent>) => {
        const event = events.find((candidate) => candidate.type === "board.card-unarchived");
        assert.ok(event?.type === "board.card-unarchived");
        return event.payload.card;
      };
      // The old parent is now a leaf being built.
      const started = yield* decideEvents(
        unarchive,
        model([
          card("p", "building"),
          child("a", BOARD_DEFERRED_STAGE_ID, "p", { archivedAt: at }),
        ]),
      );
      expect(restoredCard(started).parentCardId).toBeNull();
      expect(restoredCard(started).stage).toBe("backlog");
      expect(stagesAfter(started).has("p")).toBe(false);
      // An unbuilt leaf takes it back and becomes a group again.
      const unbuilt = yield* decideEvents(
        unarchive,
        model([card("p", "sprint"), child("a", "backlog", "p", { archivedAt: at })]),
      );
      expect(restoredCard(unbuilt).parentCardId).toBe(BoardCardId.make("p"));
      expect(stagesAfter(unbuilt).get("p")?.card.group).not.toBeNull();
    }),
  );

  it.effect("unarchive detaches a card its group's dependency waits on, rather than deadlock", () =>
    Effect.gen(function* () {
      const at = "2026-01-02T00:00:00.000Z";
      const unarchive = (id: string): BoardCommand => ({
        type: "board.card.unarchive",
        commandId: CommandId.make(`cmd-unarchive-${id}`),
        cardId: BoardCardId.make(id),
        createdAt: NOW,
      });
      // g waits on x, and x took a dependency on c while c sat in the archive.
      const events = yield* decideEvents(
        unarchive("c"),
        model([
          card("x", "backlog", { dependsOn: [BoardCardId.make("c")] }),
          card("g", "backlog", { group: group("backlog"), dependsOn: [BoardCardId.make("x")] }),
          child("k", "backlog", "g"),
          child("c", "backlog", "g", { archivedAt: at }),
        ]),
      );
      const restored = events.find((candidate) => candidate.type === "board.card-unarchived");
      assert.ok(restored?.type === "board.card-unarchived");
      expect(restored.payload.card.parentCardId).toBeNull();
      expect(restored.payload.card.archivedAt).toBeNull();

      // A cycle the detach cannot break (x waits on a card inside c, which
      // waits on x) is refused outright.
      const failure = yield* decideFail(
        unarchive("c"),
        model([
          card("x", "backlog", { dependsOn: [BoardCardId.make("d")] }),
          card("c", "backlog", {
            group: group("backlog"),
            dependsOn: [BoardCardId.make("x")],
            archivedAt: at,
          }),
          child("d", "backlog", "c", { archivedAt: at }),
        ]),
      );
      assert.include(String(failure), "dependency cycle");
    }),
  );

  it.effect("a group's own dependencies hold back the cards inside it", () =>
    Effect.gen(function* () {
      const cards = [
        card("dep", "building"),
        card("g", "ready", { group: group("ready"), dependsOn: [BoardCardId.make("dep")] }),
        child("a", "ready", "g"),
      ];
      const refused = yield* decideFail(move("a", "building", false), model(cards));
      assert.include(String(refused), "T3-");
      assert.include(String(refused), "cannot enter");
      const met = cards.map((c) =>
        c.id === "dep" ? { ...c, stage: BoardStageId.make("done") } : c,
      );
      const events = yield* decideEvents(move("a", "building", false), model(met));
      expect(stagesAfter(events).get("a")?.stage).toBe("building");
    }),
  );

  it.effect("a group's dependencies feed every build gate, not only the move", () =>
    Effect.gen(function* () {
      const dep = BoardCardId.make("dep");
      const update = (
        id: string,
        fields: { dependsOn?: ReadonlyArray<BoardCardId>; autoStart?: boolean },
      ): BoardCommand => ({
        type: "board.card.update",
        commandId: CommandId.make(`cmd-update-${id}`),
        cardId: BoardCardId.make(id),
        ...fields,
        createdAt: NOW,
      });
      // Leaving Done re-blocks the cards building inside the group that waits on it.
      const building = [
        card("dep", "done"),
        card("g", "building", { group: group("ready", { started: true }), dependsOn: [dep] }),
        child("a", "building", "g"),
      ];
      const reopened = yield* decideEvents(move("dep", "review"), model(building));
      expect(stagesAfter(reopened).get("a")?.card.blocked).toBe(true);
      // Giving the group a dependency flags the cards already inside it.
      const unflagged = [
        card("dep", "review"),
        card("g", "building", { group: group("ready", { started: true }) }),
        child("a", "building", "g"),
      ];
      const edited = yield* decideEvents(update("g", { dependsOn: [dep] }), model(unflagged));
      expect(stagesAfter(edited).get("a")?.card.blocked).toBe(true);
      const waiting = [
        card("dep", "review"),
        card("g", "ready", { group: group("ready"), dependsOn: [dep] }),
        child("a", "ready", "g"),
      ];
      // Nor can a card be created straight into Building behind a waiting group.
      const created = yield* decideFail(
        {
          type: "board.card.create",
          commandId: CommandId.make("cmd-create-behind"),
          cardId: BoardCardId.make("n9"),
          projectId,
          title: "Behind the group",
          stage: BoardStageId.make("building"),
          parentCardId: BoardCardId.make("g"),
          createdAt: NOW,
        },
        model(waiting),
      );
      assert.include(String(created), "unmet dependencies");
    }),
  );

  it.effect("a heading created under an own-branch group lands on its floor", () =>
    Effect.gen(function* () {
      const cards = [
        card("g", "building", { group: group("ready", { target: "own", started: true }) }),
        child("s1", "building", "g", {
          worktree: {
            branch: "board/t3-1",
            baseRefName: "board/t3-0",
            path: "/tmp/wt",
            status: "ready",
            attempts: 1,
            lastError: null,
            reclaimBlockedReason: null,
          },
        }),
        child("b2", "ready", "g"),
      ];
      // The shared-parent flow: a heading beside the started card, adopting both.
      const events = yield* decideEvents(
        {
          type: "board.card.create",
          commandId: CommandId.make("cmd-share"),
          cardId: BoardCardId.make("h9"),
          projectId,
          title: "Shared",
          heading: true,
          parentCardId: BoardCardId.make("g"),
          adoptCardIds: [BoardCardId.make("s1"), BoardCardId.make("b2")],
          createdAt: NOW,
        },
        model(cards),
      );
      const created = events.find((event) => event.type === "board.card-created");
      assert.ok(created?.type === "board.card-created");
      expect(created.payload.stage).toBe("ready");
      const after = stagesAfter(events);
      expect(after.get("s1")?.card.parentCardId).toBe(BoardCardId.make("h9"));
      expect(after.get("b2")?.card.parentCardId).toBe(BoardCardId.make("h9"));
    }),
  );

  it.effect("a compound group flow lands whole or not at all", () =>
    Effect.gen(function* () {
      const cards = [card("g", "sprint", { group: group("sprint") }), child("a", "ready", "g")];
      // Adopting the heading's own would-be ancestor is refused, so nothing is created.
      const refused = yield* decideFail(
        {
          type: "board.card.create",
          commandId: CommandId.make("cmd-group-bad"),
          cardId: BoardCardId.make("h9"),
          projectId,
          title: "Bad",
          heading: true,
          parentCardId: BoardCardId.make("a"),
          adoptCardIds: [BoardCardId.make("g")],
          createdAt: NOW,
        },
        model(cards),
      );
      assert.include(String(refused), "inside itself");
      // New phase: create, adopt the deferred card, and land it in Backlog.
      const phase = yield* decideEvents(
        {
          type: "board.card.create",
          commandId: CommandId.make("cmd-phase"),
          cardId: BoardCardId.make("h8"),
          projectId,
          title: "Phase 2",
          heading: true,
          adoptCardIds: [BoardCardId.make("d1")],
          adoptStage: BoardStageId.make("backlog"),
          createdAt: NOW,
        },
        model([
          card("p", "sprint", { group: group("sprint") }),
          child("d1", BOARD_DEFERRED_STAGE_ID, "p"),
        ]),
      );
      const landed = stagesAfter(phase).get("d1")?.card;
      expect(landed?.parentCardId).toBe(BoardCardId.make("h8"));
      expect(landed?.stage).toBe("backlog");
    }),
  );

  it.effect("cancel-work with cards to adopt cancels nothing when the move is refused", () =>
    Effect.gen(function* () {
      const started = card("x1", "review", {
        worktree: {
          branch: "board/t3-1",
          baseRefName: "main",
          path: "/tmp/wt",
          status: "ready",
          attempts: 1,
          lastError: null,
          reclaimBlockedReason: null,
        },
      });
      const cancel = (adopt: string): BoardCommand => ({
        type: "board.card.cancel-work",
        commandId: CommandId.make(`cmd-cancel-${adopt}`),
        cardId: BoardCardId.make("x1"),
        confirmCardKey: "T3-1",
        adoptCardIds: [BoardCardId.make(adopt)],
        createdAt: NOW,
      });
      const refused = yield* decideFail(cancel("x1"), model([started, card("y2", "ready")]));
      assert.include(String(refused), "inside itself");
      const events = yield* decideEvents(cancel("y2"), model([started, card("y2", "ready")]));
      expect(stagesAfter(events).get("y2")?.card.parentCardId).toBe(BoardCardId.make("x1"));
    }),
  );
});
