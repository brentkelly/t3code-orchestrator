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
  BoardActivityId,
  BoardCardId,
  BoardLabelId,
  boardPlanId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardLabel,
  type BoardPlan,
  type BoardState,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideBoardCommand, type BoardCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");

function makeCard(overrides: Omit<Partial<BoardCard>, "id"> & { readonly id: string }): BoardCard {
  return {
    key: "CARD-1",
    cardNumber: 1,
    projectId,
    labels: [],
    stage: "backlog",
    orderKey: "m",
    title: "Card",
    briefRef: null,
    dependsOn: [],
    parentCardId: null,
    threadLinks: [],
    externalRef: null,
    recipeSnapshot: null,
    worktree: null,
    blocked: false,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
    id: BoardCardId.make(overrides.id),
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

const decide = (command: BoardCommand, readModel: OrchestrationReadModel) =>
  decideBoardCommand({ command, readModel });

const decideFail = (command: BoardCommand, readModel: OrchestrationReadModel) =>
  Effect.flip(decide(command, readModel));

const createCommand = (input: {
  readonly cardId: string;
  readonly projectId?: typeof projectId;
  readonly keyPrefix?: string;
  readonly stage?: BoardCard["stage"];
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
    ...(input.stage === undefined ? {} : { stage: input.stage }),
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
  readonly toStage: BoardCard["stage"];
  readonly override?: boolean;
}) =>
  ({
    type: "board.card.move",
    commandId: CommandId.make(`cmd-move-${input.cardId}`),
    cardId: BoardCardId.make(input.cardId),
    toStage: input.toStage,
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

  // ── Blocked derivation at the Ready boundary ─────────────────────────

  it.effect("derives blocked from unmet dependencies exactly at Ready, not before", () =>
    Effect.gen(function* () {
      const dependency = makeCard({ id: "card-dep", stage: "building" });
      const card = makeCard({
        id: "card-1",
        stage: "sprint",
        dependsOn: [BoardCardId.make("card-dep")],
      });
      const board: BoardState = { cards: [dependency, card], nextCardNumberByProject: {} };

      // sprint -> planning: before Ready, unmet dependencies do not block.
      const early = yield* decide(
        moveCommand({ cardId: "card-1", toStage: "planning" }),
        makeReadModel({ board }),
      );
      if (early.type === "board.card-moved") {
        assert.strictEqual(early.payload.card.blocked, false);
      }

      // planning -> ready crosses the boundary: blocked appears.
      const planningBoard: BoardState = {
        cards: [dependency, { ...card, stage: "planning" }],
        nextCardNumberByProject: {},
      };
      const atReady = yield* decide(
        moveCommand({ cardId: "card-1", toStage: "ready" }),
        makeReadModel({ board: planningBoard }),
      );
      if (atReady.type === "board.card-moved") {
        assert.strictEqual(atReady.payload.card.blocked, true);
      }

      // Same move with the dependency done: not blocked.
      const doneBoard: BoardState = {
        cards: [
          { ...dependency, stage: "done" },
          { ...card, stage: "planning" },
        ],
        nextCardNumberByProject: {},
      };
      const unblocked = yield* decide(
        moveCommand({ cardId: "card-1", toStage: "ready" }),
        makeReadModel({ board: doneBoard }),
      );
      if (unblocked.type === "board.card-moved") {
        assert.strictEqual(unblocked.payload.card.blocked, false);
      }
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
        cards: [{ ...dependency, stage: "done" }, card],
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
        cards: [dependency, { ...card, stage: "review" }],
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

  it.effect("re-derives blocked when a dependency edit lands on a Ready-or-beyond card", () =>
    Effect.gen(function* () {
      const board: BoardState = {
        cards: [
          makeCard({ id: "card-dep", stage: "sprint" }),
          makeCard({ id: "card-a", stage: "ready" }),
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
          ],
          labels: [...BOARD_SEED_LABELS, tombstonedLabel],
          plans: [readyPlan],
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
        // never emit a move.
        "board.card.report-progress": {
          type: "board.card.report-progress",
          commandId: CommandId.make("cmd-progress"),
          cardId: BoardCardId.make("card-ready"),
          activityId: BoardActivityId.make("act-progress"),
          note: "Working on it",
          threadId: null,
          createdAt: NOW,
        },
        "board.card.request-input": {
          type: "board.card.request-input",
          commandId: CommandId.make("cmd-input"),
          cardId: BoardCardId.make("card-ready"),
          activityId: BoardActivityId.make("act-input"),
          question: "Which database?",
          threadId: null,
          createdAt: NOW,
        },
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
      };

      for (const [commandType, command] of Object.entries(catalog)) {
        const event = yield* decide(command, readModel);
        const movesIntoBuilding =
          event.type === "board.card-moved" && event.payload.toStage === "building";
        if (commandType === "board.card.move") {
          expect(movesIntoBuilding).toBe(true);
        } else {
          // Not merely "no move into building": nothing but board.card.move
          // may emit a board.card-moved at all.
          expect(event.type).not.toBe("board.card-moved");
          expect(movesIntoBuilding).toBe(false);
        }
      }
    }),
  );

  // ── Creation stages (t3o-06a) ────────────────────────────────────────

  it.effect("rejects a create into any stage but Backlog, Sprint or Planning", () =>
    Effect.gen(function* () {
      for (const stage of ["ready", "building", "review", "merge", "done"] as const) {
        const failure = yield* decideFail(
          createCommand({ cardId: `card-${stage}`, stage }),
          makeReadModel({ board: seededBoard() }),
        );
        assert.include(String(failure), "is not a creation stage");
      }
    }),
  );

  it.effect("accepts a create into each of Backlog, Sprint and Planning", () =>
    Effect.gen(function* () {
      for (const stage of ["backlog", "sprint", "planning"] as const) {
        const event = yield* decide(
          createCommand({ cardId: `card-${stage}`, stage }),
          makeReadModel({ board: seededBoard() }),
        );
        assert.strictEqual(event.type, "board.card-created");
        if (event.type === "board.card-created") assert.strictEqual(event.payload.stage, stage);
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

  it.effect("records a progress note and a human-input request as card activity", () =>
    Effect.gen(function* () {
      const progress = yield* decide(
        {
          type: "board.card.report-progress",
          commandId: CommandId.make("cmd-progress"),
          cardId: BoardCardId.make("card-1"),
          activityId: BoardActivityId.make("act-1"),
          note: "Halfway there",
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
        },
        cardReadModel(),
      );
      assert.strictEqual(progress.type, "board.card-progress-reported");
      if (progress.type === "board.card-progress-reported") {
        assert.strictEqual(progress.payload.entry.kind, "progress");
        assert.strictEqual(progress.payload.entry.body, "Halfway there");
      }
      const input = yield* decide(
        {
          type: "board.card.request-input",
          commandId: CommandId.make("cmd-input"),
          cardId: BoardCardId.make("card-1"),
          activityId: BoardActivityId.make("act-2"),
          question: "Postgres or SQLite?",
          threadId: null,
          createdAt: NOW,
        },
        cardReadModel(),
      );
      assert.strictEqual(input.type, "board.card-input-requested");
      if (input.type === "board.card-input-requested") {
        assert.strictEqual(input.payload.entry.kind, "input-requested");
      }
    }),
  );

  it.effect("board_complete_step is idempotent — a second call re-emits the first outcome", () =>
    Effect.gen(function* () {
      const first = yield* decide(
        completeStep({ stepId: "build", outcome: "succeeded", summary: "Built it" }),
        cardReadModel(),
      );
      assert.strictEqual(first.type, "board.card-step-completed");
      if (first.type !== "board.card-step-completed") return;
      // The first completion is now in the read model.
      const second = yield* decide(
        completeStep({ stepId: "build", outcome: "failed", summary: "A different story" }),
        cardReadModel({ stepCompletions: [first.payload.completion] }),
      );
      assert.strictEqual(second.type, "board.card-step-completed");
      if (second.type !== "board.card-step-completed") return;
      // The retry re-emits the FIRST outcome verbatim — never a second, and
      // never a contradictory transition.
      assert.strictEqual(second.payload.completion.outcome, "succeeded");
      assert.strictEqual(second.payload.completion.summary, "Built it");
      assert.deepStrictEqual(second.payload.completion, first.payload.completion);
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
