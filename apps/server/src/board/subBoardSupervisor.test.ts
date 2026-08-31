/**
 * Sub-board supervisor behaviour (t3o-23, D4): a split parent in the
 * build-role stage spawns nothing while its children are unfinished, and
 * advances to the next stage in order when the last child finishes — by
 * reaching Done, or by being archived (an archived child counts as done, D6).
 */
import { BoardCardId, type BoardCard, type OrchestrationEvent } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import * as Effect from "effect/Effect";

import {
  cardArchived,
  cardMoved,
  cardStage,
  codexStep,
  makeBoardCard,
  movedToBuilding,
  readyWorktree,
  settingsWith,
  stepStatus,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

/** A `board.card-created` event carrying the given card as its payload —
    enough for the reactor's `handleCardCreated`, which re-reads the card. */
const cardCreated = (card: BoardCard, sequence: number): OrchestrationEvent =>
  ({
    type: "board.card-created",
    sequence,
    payload: {
      cardId: card.id,
      projectId: card.projectId,
      title: card.title,
      key: card.key,
      cardNumber: card.cardNumber,
      labels: card.labels,
      dependsOn: card.dependsOn,
      ...(card.parentCardId === null ? {} : { parentCardId: card.parentCardId }),
      ...(card.sourcePlanId === null ? {} : { sourcePlanId: card.sourcePlanId }),
      stage: card.stage,
      orderKey: card.orderKey,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
    },
  }) as unknown as OrchestrationEvent;

const parentId = BoardCardId.make("card-parent");

const parentCard = (): BoardCard => ({
  ...makeBoardCard({
    id: "card-parent",
    stage: "building",
    orderKey: "a",
    // The split's branch-only integration branch (D5): real branch, no
    // worktree until the parent's own review entry.
    worktree: { ...readyWorktree("card-parent"), path: null, status: "branch-only" },
  }),
});

const childCard = (id: string, stage: string, archivedAt: string | null = null): BoardCard => ({
  ...makeBoardCard({ id, stage, orderKey: "m" }),
  parentCardId: parentId,
  archivedAt,
});

it.effect(
  "spawns nothing for a parent whose children are unfinished, even in an auto-executing build stage",
  () =>
    withGovernor(
      {
        board: {
          cards: [parentCard(), childCard("card-child", "ready")],
          nextCardNumberByProject: {},
        },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      },
      ({ pumpDomain, board, slots }) =>
        Effect.gen(function* () {
          yield* pumpDomain(movedToBuilding(parentCard(), 1));
          const after = yield* board;
          // No step selected, no slot held: the parent builds THROUGH its
          // children (D4), so the build stage's auto-execute must not touch it.
          assert.strictEqual(stepStatus(after, parentId), null);
          assert.strictEqual(yield* slots.heldTotal, 0);
          assert.strictEqual(cardStage(after, parentId), "building");
        }),
    ),
);

it.effect("advances the parent to the next stage when the last child reaches Done", () =>
  withGovernor(
    {
      board: {
        cards: [parentCard(), childCard("card-done", "done"), childCard("card-final", "done")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        // The last child's arrival at Done (the fixture already holds the
        // post-move card; the event is what the reactor keys on).
        yield* pumpDomain(cardMoved(childCard("card-final", "done"), "merge", "done", 1));
        assert.strictEqual(cardStage(yield* board, parentId), "review");
      }),
  ),
);

it.effect("does not advance the parent while another child is still unfinished", () =>
  withGovernor(
    {
      board: {
        cards: [parentCard(), childCard("card-done", "done"), childCard("card-open", "building")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(cardMoved(childCard("card-done", "done"), "merge", "done", 1));
        assert.strictEqual(cardStage(yield* board, parentId), "building");
      }),
  ),
);

it.effect(
  "does not auto-start a freshly materialised child, even into an auto-executing stage",
  () =>
    withGovernor(
      {
        // The child is created straight into the auto-executing build stage — the
        // worst case for D18 (approving a split must not fan out into N running
        // agents). handleCardCreated must skip kickoff for a card with a parent.
        board: {
          cards: [parentCard()],
          nextCardNumberByProject: {},
        },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      },
      ({ pumpDomain, board, slots }) =>
        Effect.gen(function* () {
          const child = childCard("card-child", "building");
          yield* pumpDomain(cardCreated(child, 1));
          const after = yield* board;
          assert.strictEqual(stepStatus(after, BoardCardId.make("card-child")), null);
          assert.strictEqual(yield* slots.heldTotal, 0);
        }),
    ),
);

it.effect("provisions and runs a build step from a branch-only slice (parent review entry)", () =>
  withGovernor(
    {
      // A split parent reaches its own review carrying the `branch-only`
      // integration-branch slice from approval (t3o-23, D5). `schedule` must
      // (re)provision it — a worktree that is neither ready nor mid-flight
      // provisioning — rather than skip it and leave the review step wedged
      // pending forever. Modelled at the build stage (auto-executes a single
      // step), which shares the exact `schedule` gate.
      board: {
        cards: [
          {
            ...makeBoardCard({ id: "card-1", stage: "building", orderKey: "m" }),
            worktree: { ...readyWorktree("card-1"), path: null, status: "branch-only" },
          },
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ pumpDomain, board, slots }) =>
      Effect.gen(function* () {
        yield* pumpDomain(
          cardMoved(
            {
              ...makeBoardCard({ id: "card-1", stage: "building", orderKey: "m" }),
              worktree: { ...readyWorktree("card-1"), path: null, status: "branch-only" },
            },
            "ready",
            "building",
            1,
          ),
        );
        const after = yield* board;
        // The slice was re-provisioned to ready and the step spawned — not
        // left pending behind an un-provisioned branch-only worktree.
        assert.strictEqual(
          after.cards.find((card) => card.id === BoardCardId.make("card-1"))?.worktree?.status,
          "ready",
        );
        assert.strictEqual(stepStatus(after, BoardCardId.make("card-1")), "running");
        assert.strictEqual(yield* slots.heldTotal, 1);
      }),
  ),
);

it.effect("counts an archived child as finished and advances the parent (D6)", () =>
  withGovernor(
    {
      board: {
        cards: [
          parentCard(),
          childCard("card-done", "done"),
          childCard("card-stray", "building", "2026-01-01T00:00:00.000Z"),
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(
          cardArchived(childCard("card-stray", "building", "2026-01-01T00:00:00.000Z"), 1),
        );
        assert.strictEqual(cardStage(yield* board, parentId), "review");
      }),
  ),
);
