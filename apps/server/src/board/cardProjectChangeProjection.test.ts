/**
 * T3O-33 — `board.card.set-project` through the real seams: decider, event
 * store, SQL projection and the rehydrated read model.
 *
 * The assertion that matters here is the CARD-NUMBER FLOOR. The read model's
 * `nextCardNumberByProject` is not stored — it is rebuilt from the tables as
 * `MAX(card_number)` over `board_cards` UNION `board_card_number_floor`,
 * grouped by project. A card leaving a project takes its `card_number` row with
 * it, so if it held that project's highest number the counter REGRESSES and the
 * next card created there is handed a key that already exists elsewhere on the
 * board. Raising the old project's floor is what prevents it, and the bug is
 * invisible until the read model is rebuilt — which is exactly what
 * `getCommandReadModel` does on every call.
 */
import {
  BoardCardId,
  BoardStageId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  type BoardCardActivityEntry,
  type BoardCardShell,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { boardDecidedEvents, decideBoardCommand } from "./decider.ts";
import { boardSnapshotQueryMethodsOf } from "./projection.ts";
import { ServerConfig } from "../config.ts";

/** One database — and therefore one `it.layer` block — per scenario. Commands
    are deduped by `commandId` and every scenario shares a seed and a move
    command, so two scenarios in one layer would have the second one's dispatches
    silently satisfied by the first one's. */
const makeTestLayer = (prefix: string) =>
  Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(NodeServices.layer),
  );

const createdAt = "2026-01-01T00:00:00.000Z";
const alpha = ProjectId.make("project-alpha");
const beta = ProjectId.make("project-beta");
const lowCardId = BoardCardId.make("card-alpha-1");
const highCardId = BoardCardId.make("card-alpha-2");

const createProject = (projectId: ProjectId, title: string, commandId: string) =>
  ({
    type: "project.create",
    commandId: CommandId.make(commandId),
    projectId,
    title,
    workspaceRoot: `/tmp/${projectId}`,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt,
  }) as const;

/** Two cards in Alpha (AL-1, AL-2) and an empty Beta. The card being moved is
    the one holding Alpha's HIGHEST number, which is the only shape that can
    regress the counter. */
const seedBoard = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch(createProject(alpha, "Alpha", "cmd-project-alpha"));
  yield* engine.dispatch(createProject(beta, "Beta", "cmd-project-beta"));
  yield* engine.dispatch({
    type: "board.card.create",
    commandId: CommandId.make("cmd-create-low"),
    cardId: lowCardId,
    projectId: alpha,
    title: "Stays put",
    keyPrefix: "AL",
    createdAt,
  });
  yield* engine.dispatch({
    type: "board.card.create",
    commandId: CommandId.make("cmd-create-high"),
    cardId: highCardId,
    projectId: alpha,
    title: "Moves away",
    keyPrefix: "AL",
    createdAt,
  });
  return engine;
});

const moveHighCardToBeta = {
  type: "board.card.set-project",
  commandId: CommandId.make("cmd-set-project"),
  cardId: highCardId,
  projectId: beta,
  keyPrefix: "BE",
  createdAt,
} as const;

const cardsOf = (snapshot: OrchestrationShellSnapshot): ReadonlyArray<BoardCardShell> =>
  snapshot.cards ?? [];

it.layer(makeTestLayer("t3o-board-project-1-"))("moving a card to another project", (it) => {
  it.effect("reissues the key and repoints the card, keeping its id and stage", () =>
    Effect.gen(function* () {
      const engine = yield* seedBoard;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const before = yield* snapshotQuery.getShellSnapshot();
      assert.strictEqual(cardsOf(before).find((card) => card.cardId === highCardId)?.key, "AL-2");

      yield* engine.dispatch(moveHighCardToBeta);

      const after = yield* snapshotQuery.getShellSnapshot();
      const moved = cardsOf(after).find((card) => card.cardId === highCardId);
      expect(moved).toMatchObject({ key: "BE-1", projectId: beta, stage: "backlog" });
      // The card that stayed is untouched — the move is not a renumbering of
      // the project it left.
      assert.strictEqual(cardsOf(after).find((card) => card.cardId === lowCardId)?.key, "AL-1");
    }),
  );
});

it.layer(makeTestLayer("t3o-board-project-1b-"))("a card carrying a base-branch pin", (it) => {
  it.effect("clears the pin", () =>
    Effect.gen(function* () {
      const engine = yield* seedBoard;
      yield* engine.dispatch({
        type: "board.card.update",
        commandId: CommandId.make("cmd-pin-base"),
        cardId: highCardId,
        baseBranch: "release/2.0",
        createdAt,
      });
      yield* engine.dispatch(moveHighCardToBeta);

      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const readModel = yield* snapshotQuery.getCommandReadModel();
      const card = readModel.board?.cards.find((candidate) => candidate.id === highCardId);
      // `release/2.0` almost certainly does not exist in Beta's repository and
      // would fail at `ensureLocalBaseBranch` hours later at provisioning (D5).
      assert.strictEqual(card?.baseBranch, null);
    }),
  );
});

it.layer(makeTestLayer("t3o-board-project-2-"))("the old project's card-number floor", (it) => {
  // The regression. `getCommandReadModel` REBUILDS the board state from the
  // tables, so this is the rehydration path — without the floor raise, Alpha's
  // counter falls back to 2 the moment AL-2's row moves to Beta.
  it.effect("survives the highest-numbered card leaving the project", () =>
    Effect.gen(function* () {
      const engine = yield* seedBoard;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const before = yield* snapshotQuery.getCommandReadModel();
      assert.strictEqual(before.board?.nextCardNumberByProject[alpha], 3);

      yield* engine.dispatch(moveHighCardToBeta);

      const after = yield* snapshotQuery.getCommandReadModel();
      assert.strictEqual(
        after.board?.nextCardNumberByProject[alpha],
        3,
        "the number AL-2 held is spent forever, even though its row left the project",
      );
      // Beta's counter advanced to the number the arrival took.
      assert.strictEqual(after.board?.nextCardNumberByProject[beta], 2);
    }),
  );
});

it.layer(makeTestLayer("t3o-board-project-2b-"))(
  "the next card created in the old project",
  (it) => {
    // The failure the floor exists to prevent, spelled out. The counter is only
    // ever wrong AFTER A RESTART — while the server is up the in-memory read
    // model carries the number forward — so this decides the next create against
    // the REHYDRATED read model, which is precisely what a restarted server
    // decides against.
    it.effect("never re-issues the moved card's key", () =>
      Effect.gen(function* () {
        const engine = yield* seedBoard;
        yield* engine.dispatch(moveHighCardToBeta);

        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const rehydrated = yield* snapshotQuery.getCommandReadModel();
        const decision = yield* decideBoardCommand({
          command: {
            type: "board.card.create",
            commandId: CommandId.make("cmd-create-next"),
            cardId: BoardCardId.make("card-alpha-3"),
            projectId: alpha,
            title: "The next card in Alpha",
            keyPrefix: "AL",
            createdAt,
          },
          readModel: rehydrated,
        });
        const created = boardDecidedEvents(decision)[0]!;
        assert.strictEqual(created.type, "board.card-created");
        if (created.type !== "board.card-created") return;
        // AL-2 is printed on a card that now lives in Beta as BE-1. Handing it out
        // again would put two cards' histories under one key.
        assert.strictEqual(created.payload.key, "AL-3");

        const shell = yield* snapshotQuery.getShellSnapshot();
        assert.notInclude(
          cardsOf(shell).map((card) => card.key),
          "AL-2",
        );
      }),
    );
  },
);

it.layer(makeTestLayer("t3o-board-project-3-"))("the activity rail", (it) => {
  it.effect("records the retired key alongside both projects", () =>
    Effect.gen(function* () {
      const engine = yield* seedBoard;
      yield* engine.dispatch(moveHighCardToBeta);

      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const board = boardSnapshotQueryMethodsOf(snapshotQuery);
      assert.isNotNull(board);
      const activity: ReadonlyArray<BoardCardActivityEntry> =
        yield* board!.boardCardActivity(highCardId);
      const row = activity.find((entry) => entry.kind === "card-project-changed");
      expect(row?.payload).toMatchObject({
        fromProjectId: alpha,
        toProjectId: beta,
        fromKey: "AL-2",
        toKey: "BE-1",
      });
    }),
  );
});

it.layer(makeTestLayer("t3o-board-project-4-"))("refusing a built card end to end", (it) => {
  it.effect("rejects the command once the card has reached Building", () =>
    Effect.gen(function* () {
      const engine = yield* seedBoard;
      yield* engine.dispatch({
        type: "board.card.move",
        commandId: CommandId.make("cmd-move-building"),
        cardId: highCardId,
        toStage: BoardStageId.make("building"),
        override: true,
        createdAt,
      });

      const failure = yield* Effect.flip(engine.dispatch(moveHighCardToBeta));
      assert.include(String(failure), "already been built");

      // And the refusal really is a refusal: nothing was reissued.
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const shell = yield* snapshotQuery.getShellSnapshot();
      assert.strictEqual(cardsOf(shell).find((card) => card.cardId === highCardId)?.key, "AL-2");
    }),
  );
});
