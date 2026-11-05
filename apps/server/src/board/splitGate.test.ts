/**
 * The split gate's new state (T3O-31) through the real seams: the Planned
 * flag on plans, the stored recommendation on the card, and a Needs-planning
 * child that owns no plan row. The SQL projection (migration 052) and a
 * from-empty replay of the log must agree on all three.
 */
import { BoardCardId, CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { projectBoardEvent, type BoardReadModel } from "./projector.ts";
import {
  boardStackEngine,
  boardStackSnapshotQuery,
  makeBoardStackTestLayer,
} from "./boardStack.testkit.ts";

const createdAt = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-split-gate");
const cardId = BoardCardId.make("card-split-gate");
const WHY = "The schema and the pane ship on separate branches and review separately.";

const plan = (key: string, planned?: boolean) => ({
  key,
  title: key,
  summary: "s",
  dependsOn: [],
  body: `# ${key}`,
  ...(planned === undefined ? {} : { planned }),
});

const rehydrated = Effect.gen(function* () {
  const snapshotQuery = yield* boardStackSnapshotQuery;
  return (yield* snapshotQuery.getCommandReadModel()).board;
});

const replayed = Effect.gen(function* () {
  const engine = yield* boardStackEngine;
  const events = Array.from(yield* Stream.runCollect(engine.readBoardEvents()));
  let model = {} as BoardReadModel;
  for (const event of events) {
    model = yield* projectBoardEvent(model, event);
  }
  return model.board;
});

it.layer(makeBoardStackTestLayer("t3o-split-gate-1-"))("a mixed split", (it) => {
  it.effect("projects and replays the Planned flags, recommendation and children alike", () =>
    Effect.gen(function* () {
      const engine = yield* boardStackEngine;
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project"),
        projectId,
        title: "Split Gate",
        workspaceRoot: "/tmp/project-split-gate",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });
      yield* engine.dispatch({
        type: "board.card.create",
        commandId: CommandId.make("cmd-create"),
        cardId,
        projectId,
        title: "An epic",
        orderKey: "m",
        createdAt,
      });
      yield* engine.dispatch({
        type: "board.plans.propose",
        commandId: CommandId.make("cmd-propose"),
        cardId,
        plans: [plan("ready-now"), plan("later", false)],
        splitRationale: WHY,
        createdAt,
      });

      const proposed = yield* rehydrated;
      const card = proposed?.cards.find((candidate) => candidate.id === cardId);
      assert.deepStrictEqual(card?.splitRecommendation, {
        autoBuild: false,
        mergeTarget: "inherit",
      });
      assert.deepStrictEqual(
        proposed?.plans
          ?.filter((candidate) => candidate.cardId === cardId)
          .toSorted((left, right) => left.ordinal - right.ordinal)
          .map((candidate) => candidate.planned),
        [undefined, false],
      );

      yield* engine.dispatch({
        type: "board.plans.approve",
        commandId: CommandId.make("cmd-approve"),
        cardId,
        createdAt,
      });

      const board = yield* rehydrated;
      const children = (board?.cards ?? []).filter(
        (candidate) => candidate.parentCardId === cardId,
      );
      assert.strictEqual(children.length, 2);
      const ownsPlan = (id: BoardCardId) =>
        (board?.plans ?? []).some((candidate) => candidate.cardId === id);
      const readyChild = children.find((child) => child.title === "ready-now");
      const laterChild = children.find((child) => child.title === "later");
      assert.ok(readyChild !== undefined && laterChild !== undefined);
      assert.strictEqual(readyChild.stage, "ready");
      assert.isTrue(ownsPlan(readyChild.id));
      assert.strictEqual(laterChild.stage, "backlog");
      assert.isFalse(ownsPlan(laterChild.id));
      assert.notStrictEqual(laterChild.briefRef, null);

      const replay = yield* replayed;
      const sortBy = <T>(items: ReadonlyArray<T> | undefined, key: (item: T) => string) =>
        (items ?? []).toSorted((left, right) => key(left).localeCompare(key(right)));
      assert.deepStrictEqual(
        sortBy(replay?.cards, (item) => item.id),
        sortBy(board?.cards, (item) => item.id),
      );
      assert.deepStrictEqual(
        sortBy(replay?.plans, (item) => item.planId),
        sortBy(board?.plans, (item) => item.planId),
      );
    }),
  );
});
