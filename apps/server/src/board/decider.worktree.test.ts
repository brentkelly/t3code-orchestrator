/**
 * T3o worktree/branch lifecycle decider invariants (t3o-09, D6/D18).
 *
 * The pure half of the lifecycle: the server-internal worktree commands record
 * branch/worktree state on the card, gated so that provisioning can only
 * happen once the card is in Building (D6 — the worktree is created ON entry
 * to Building, which is itself the human "Begin build" gate; nothing here
 * advances a stage, D18), a failed step is visibly failed and retryable, and a
 * reclaim that would lose work is refused with a reason.
 */
import {
  BoardCardId,
  BoardStageId,
  CommandId,
  ProjectId,
  type BoardCard,
  type BoardState,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert } from "@effect/vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { boardDecidedEvents, decideBoardCommand, type BoardCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");

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
    threadLinks: [],
    externalRef: null,
    humanInLoop: null,
    worktree: null,
    blocked: false,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...rest,
    stage: BoardStageId.make(stage ?? "building"),
    id: BoardCardId.make(id),
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

const boardWith = (cards: ReadonlyArray<BoardCard>): BoardState => ({
  cards,
  nextCardNumberByProject: {},
});

const provision = (cardId: string, branch = "board/card-1", baseRefName = "main") =>
  ({
    type: "board.card.provision-worktree",
    commandId: CommandId.make(`cmd-provision-${cardId}`),
    cardId: BoardCardId.make(cardId),
    branch,
    baseRefName,
    createdAt: NOW,
  }) as const satisfies BoardCommand;

const record = (cardId: string, path = "/tmp/worktrees/card-1") =>
  ({
    type: "board.card.record-worktree",
    commandId: CommandId.make(`cmd-record-${cardId}`),
    cardId: BoardCardId.make(cardId),
    path,
    createdAt: NOW,
  }) as const satisfies BoardCommand;

const fail = (cardId: string, error = "git worktree add failed") =>
  ({
    type: "board.card.fail-worktree",
    commandId: CommandId.make(`cmd-fail-${cardId}`),
    cardId: BoardCardId.make(cardId),
    error,
    createdAt: NOW,
  }) as const satisfies BoardCommand;

const reclaim = (cardId: string, outcome: "removed" | "blocked", reason?: string) =>
  ({
    type: "board.card.reclaim-worktree",
    commandId: CommandId.make(`cmd-reclaim-${cardId}`),
    cardId: BoardCardId.make(cardId),
    outcome,
    ...(reason === undefined ? {} : { reason }),
    createdAt: NOW,
  }) as const satisfies BoardCommand;

/** Every event a command decides. Archive and unarchive decide several —
    the card's own, plus a `blocked` re-flag per affected dependent (t3o-13,
    D5) — while every other command decides exactly one. */
const decideEvents = (command: BoardCommand, readModel: OrchestrationReadModel) =>
  decideBoardCommand({ command, readModel }).pipe(Effect.map(boardDecidedEvents));

/** The first (and, for every command but archive/unarchive, only) decided
    event. */
const decide = (command: BoardCommand, readModel: OrchestrationReadModel) =>
  decideEvents(command, readModel).pipe(Effect.map((events) => events[0]!));

const decideFail = (command: BoardCommand, readModel: OrchestrationReadModel) =>
  Effect.flip(decide(command, readModel));

it.layer(NodeServices.layer)("board worktree lifecycle decider", (it) => {
  // ── D6: laziness — moving into Building creates no worktree ───────────

  it.effect("the human move into Building does not itself create a worktree", () =>
    Effect.gen(function* () {
      // A card sitting in Ready with no worktree — the planning-and-Ready
      // life it has led so far is worktree-free (D6).
      const card = makeCard({ id: "card-1", stage: "ready", worktree: null });
      const move = {
        type: "board.card.move",
        commandId: CommandId.make("cmd-move-card-1"),
        cardId: BoardCardId.make("card-1"),
        toStage: BoardStageId.make("building"),
        createdAt: NOW,
      } as const satisfies BoardCommand;
      const event = yield* decide(move, makeReadModel(boardWith([card])));
      assert.strictEqual(event.type, "board.card-moved");
      if (event.type === "board.card-moved") {
        // Entry to Building is the human "Begin build"; the worktree is a
        // separate, gated provisioning step — never a side effect of the move.
        assert.strictEqual(event.payload.card.worktree, null);
        assert.strictEqual(event.payload.card.stage, "building");
      }
    }),
  );

  // ── D6 / D18: provisioning is gated on Building ──────────────────────

  it.effect("refuses to provision a worktree before the card is in Building", () =>
    Effect.gen(function* () {
      const card = makeCard({ id: "card-1", stage: "ready" });
      const failure = yield* decideFail(provision("card-1"), makeReadModel(boardWith([card])));
      assert.match(String(failure), /must be in 'building'/);
    }),
  );

  it.effect(
    "provisioning records the branch and marks the step in flight, without moving stage",
    () =>
      Effect.gen(function* () {
        const card = makeCard({ id: "card-1", stage: "building" });
        const event = yield* decide(provision("card-1"), makeReadModel(boardWith([card])));
        assert.strictEqual(event.type, "board.card-worktree-provisioning");
        if (event.type === "board.card-worktree-provisioning") {
          assert.strictEqual(event.payload.card.stage, "building");
          assert.strictEqual(event.payload.branch, "board/card-1");
          const wt = event.payload.card.worktree;
          assert.ok(wt !== null);
          assert.strictEqual(wt?.status, "provisioning");
          assert.strictEqual(wt?.path, null);
          assert.strictEqual(wt?.attempts, 1);
          assert.strictEqual(wt?.baseRefName, "main");
        }
      }),
  );

  // ── record / fail ────────────────────────────────────────────────────

  it.effect("recording a ready worktree sets the path and status", () =>
    Effect.gen(function* () {
      const card = makeCard({
        id: "card-1",
        worktree: {
          branch: "board/card-1",
          baseRefName: "main",
          path: null,
          status: "provisioning",
          attempts: 1,
          lastError: null,
          reclaimBlockedReason: null,
        },
      });
      const event = yield* decide(record("card-1"), makeReadModel(boardWith([card])));
      assert.strictEqual(event.type, "board.card-worktree-ready");
      if (event.type === "board.card-worktree-ready") {
        const wt = event.payload.card.worktree;
        assert.strictEqual(wt?.status, "ready");
        assert.strictEqual(wt?.path, "/tmp/worktrees/card-1");
      }
    }),
  );

  it.effect("recording without a provisioning worktree is rejected", () =>
    Effect.gen(function* () {
      const card = makeCard({ id: "card-1", worktree: null });
      const failure = yield* decideFail(record("card-1"), makeReadModel(boardWith([card])));
      assert.match(String(failure), /no worktree in 'provisioning'/);
    }),
  );

  it.effect("a failed step is visibly failed with its reason, not a wedge", () =>
    Effect.gen(function* () {
      const card = makeCard({
        id: "card-1",
        worktree: {
          branch: "board/card-1",
          baseRefName: "main",
          path: null,
          status: "provisioning",
          attempts: 1,
          lastError: null,
          reclaimBlockedReason: null,
        },
      });
      const event = yield* decide(
        fail("card-1", "deps install exploded"),
        makeReadModel(boardWith([card])),
      );
      assert.strictEqual(event.type, "board.card-worktree-failed");
      if (event.type === "board.card-worktree-failed") {
        const wt = event.payload.card.worktree;
        assert.strictEqual(wt?.status, "failed");
        assert.strictEqual(wt?.lastError, "deps install exploded");
      }
    }),
  );

  it.effect("a failed worktree can be re-provisioned, incrementing attempts", () =>
    Effect.gen(function* () {
      const card = makeCard({
        id: "card-1",
        worktree: {
          branch: "board/card-1",
          baseRefName: "main",
          path: null,
          status: "failed",
          attempts: 1,
          lastError: "boom",
          reclaimBlockedReason: null,
        },
      });
      const event = yield* decide(provision("card-1"), makeReadModel(boardWith([card])));
      assert.strictEqual(event.type, "board.card-worktree-provisioning");
      if (event.type === "board.card-worktree-provisioning") {
        const wt = event.payload.card.worktree;
        assert.strictEqual(wt?.status, "provisioning");
        assert.strictEqual(wt?.attempts, 2);
        assert.strictEqual(wt?.lastError, null);
      }
    }),
  );

  it.effect("a ready worktree is never re-provisioned behind its own back", () =>
    Effect.gen(function* () {
      const card = makeCard({
        id: "card-1",
        worktree: {
          branch: "board/card-1",
          baseRefName: "main",
          path: "/tmp/worktrees/card-1",
          status: "ready",
          attempts: 1,
          lastError: null,
          reclaimBlockedReason: null,
        },
      });
      const failure = yield* decideFail(provision("card-1"), makeReadModel(boardWith([card])));
      assert.match(String(failure), /only a failed worktree can be re-provisioned/);
    }),
  );

  // ── reclaim (reverse state) ──────────────────────────────────────────

  it.effect("reclaiming a removed worktree clears the path and marks it reclaimed", () =>
    Effect.gen(function* () {
      const card = makeCard({
        id: "card-1",
        stage: "done",
        archivedAt: NOW,
        worktree: {
          branch: "board/card-1",
          baseRefName: "main",
          path: "/tmp/worktrees/card-1",
          status: "ready",
          attempts: 1,
          lastError: null,
          reclaimBlockedReason: null,
        },
      });
      const event = yield* decide(reclaim("card-1", "removed"), makeReadModel(boardWith([card])));
      assert.strictEqual(event.type, "board.card-worktree-reclaimed");
      if (event.type === "board.card-worktree-reclaimed") {
        const wt = event.payload.card.worktree;
        assert.strictEqual(wt?.status, "reclaimed");
        assert.strictEqual(wt?.path, null);
        assert.strictEqual(event.payload.outcome, "removed");
      }
    }),
  );

  it.effect("a blocked reclaim keeps the worktree and records why (dirty tree)", () =>
    Effect.gen(function* () {
      const card = makeCard({
        id: "card-1",
        archivedAt: NOW,
        worktree: {
          branch: "board/card-1",
          baseRefName: "main",
          path: "/tmp/worktrees/card-1",
          status: "ready",
          attempts: 1,
          lastError: null,
          reclaimBlockedReason: null,
        },
      });
      const event = yield* decide(
        reclaim("card-1", "blocked", "Worktree has uncommitted changes."),
        makeReadModel(boardWith([card])),
      );
      assert.strictEqual(event.type, "board.card-worktree-reclaimed");
      if (event.type === "board.card-worktree-reclaimed") {
        const wt = event.payload.card.worktree;
        assert.strictEqual(wt?.status, "ready");
        assert.strictEqual(wt?.path, "/tmp/worktrees/card-1");
        assert.strictEqual(wt?.reclaimBlockedReason, "Worktree has uncommitted changes.");
        assert.strictEqual(event.payload.reason, "Worktree has uncommitted changes.");
      }
    }),
  );

  it.effect("reclaiming a card with no worktree is rejected", () =>
    Effect.gen(function* () {
      const card = makeCard({ id: "card-1", worktree: null });
      const failure = yield* decideFail(
        reclaim("card-1", "removed"),
        makeReadModel(boardWith([card])),
      );
      assert.match(String(failure), /no worktree to reclaim/);
    }),
  );
});
