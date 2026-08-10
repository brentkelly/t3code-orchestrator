/**
 * T3o board decider invariants (t3o-03): stage adjacency and override,
 * dependency cycle rejection, blocked derivation at the Ready boundary, key
 * allocation, one-thread-one-card, tombstoning, archive/unarchive — and the
 * D18 assertion that no decider path emits a move into `building` except an
 * explicit user-originated `board.card.move`.
 */
import {
  BoardCardId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
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
    type: "feature",
    stage: "backlog",
    orderKey: "m",
    title: "Card",
    briefRef: null,
    dependsOn: [],
    parentCardId: null,
    threadLinks: [],
    externalRef: null,
    recipeSnapshot: null,
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
}) =>
  ({
    type: "board.card.create",
    commandId: CommandId.make(`cmd-create-${input.cardId}`),
    cardId: BoardCardId.make(input.cardId),
    projectId: input.projectId ?? projectId,
    title: `Card ${input.cardId}`,
    cardType: "feature",
    orderKey: "m",
    ...(input.keyPrefix === undefined ? {} : { keyPrefix: input.keyPrefix }),
    createdAt: NOW,
  }) as const;

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
      const readModel = makeReadModel({
        threads: [makeThread({ id: "thread-1" }), makeThread({ id: "thread-2" })],
        board: {
          cards: [readyCard, archivedCard, linkedCard],
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
});
