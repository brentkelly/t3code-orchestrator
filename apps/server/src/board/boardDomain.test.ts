/**
 * T3o board domain integration (t3o-03): a full card lifecycle — create,
 * move, update with dependencies and a brief, link/unlink against real
 * threads, thread-deletion tombstoning, archive/unarchive — dispatched
 * through the real engine, with the projection tables, shell snapshot, and
 * a from-empty replay all agreeing at the end.
 *
 * Plus the destructive counterpart: a card DELETE, which is the only board
 * write whose correctness rests on things being gone rather than present.
 */
import {
  BoardCardId,
  BoardStageId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

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
import { createEmptyReadModel, projectEvent } from "../orchestration/projector.ts";
import { ServerConfig } from "../config.ts";

const makeBoardDomainTestLayer = (prefix: string) =>
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

const t0 = "2026-01-01T00:00:00.000Z";
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const cardOne = BoardCardId.make("card-one");
const cardTwo = BoardCardId.make("card-two");
const cardOther = BoardCardId.make("card-other");
const threadId = ThreadId.make("thread-1");

const createProject = (projectId: ProjectId, name: string) =>
  ({
    type: "project.create",
    commandId: CommandId.make(`cmd-project-${name}`),
    projectId,
    title: `Project ${name}`,
    workspaceRoot: `/tmp/${name}`,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: t0,
  }) as const;

const createCard = (input: {
  readonly cardId: BoardCardId;
  readonly projectId: ProjectId;
  readonly orderKey: string;
  readonly n: string;
}) =>
  ({
    type: "board.card.create",
    commandId: CommandId.make(`cmd-card-create-${input.n}`),
    cardId: input.cardId,
    projectId: input.projectId,
    title: `Card ${input.n}`,
    orderKey: input.orderKey,
    createdAt: t0,
  }) as const;

it.layer(makeBoardDomainTestLayer("t3o-board-domain-test-"))("board domain lifecycle", (it) => {
  it.effect("runs a full card lifecycle and replays it identically from an empty read model", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* engine.dispatch(createProject(projectA, "a"));
      yield* engine.dispatch(createProject(projectB, "b"));

      // Interleaved creates across two projects: counters stay per-project.
      yield* engine.dispatch(
        createCard({ cardId: cardOne, projectId: projectA, orderKey: "m", n: "one" }),
      );
      yield* engine.dispatch(
        createCard({ cardId: cardOther, projectId: projectB, orderKey: "m", n: "other" }),
      );
      yield* engine.dispatch(
        createCard({ cardId: cardTwo, projectId: projectA, orderKey: "t", n: "two" }),
      );

      const afterCreates = yield* snapshotQuery.getCommandReadModel();
      assert.deepStrictEqual(
        afterCreates.board?.cards.map((card) => card.key),
        ["CARD-1", "CARD-1", "CARD-2"],
      );
      assert.deepStrictEqual(afterCreates.board?.nextCardNumberByProject, {
        [projectA]: 3,
        [projectB]: 2,
      });

      // Walk card-one to Ready via adjacent moves, blocked on card-two.
      yield* engine.dispatch({
        type: "board.card.update",
        commandId: CommandId.make("cmd-card-deps"),
        cardId: cardOne,
        dependsOn: [cardTwo],
        brief: "Build the thing after card-two.",
        createdAt: t0,
      });
      for (const [index, toStage] of (["sprint", "planning", "ready"] as const).entries()) {
        yield* engine.dispatch({
          type: "board.card.move",
          commandId: CommandId.make(`cmd-card-move-${index}`),
          cardId: cardOne,
          toStage: BoardStageId.make(toStage),
          createdAt: t0,
        });
      }

      const atReady = yield* snapshotQuery.getCommandReadModel();
      const cardOneAtReady = atReady.board?.cards.find((card) => card.id === cardOne);
      assert.strictEqual(cardOneAtReady?.stage, "ready");
      // Ready is an ordinary pre-build stage now (D11): dependency blocking is
      // derived only from the build role onward, so an unmet dependency does
      // not block a card sitting at Ready.
      assert.strictEqual(cardOneAtReady?.blocked, false);
      // The brief body never enters the read model, only its ref (D8).
      assert.strictEqual(cardOneAtReady?.briefRef, "brief");

      // Link a real thread, delete the thread, unlink: tombstone, not
      // removal.
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId,
        projectId: projectA,
        title: "Planning thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: t0,
      });
      yield* engine.dispatch({
        type: "board.card.link-thread",
        commandId: CommandId.make("cmd-card-link"),
        cardId: cardOne,
        threadId,
        role: "planning",
        createdAt: t0,
      });
      // The shell joins the live link against the snapshot's own thread
      // shells (t3o-04): activeThreadId set, thread-derived state real.
      const shellLinked = yield* snapshotQuery.getShellSnapshot();
      const cardOneShell = shellLinked.cards?.find((card) => card.cardId === cardOne);
      assert.strictEqual(cardOneShell?.activeThreadId, threadId);
      // The thread exists but has no session and nothing pending.
      assert.strictEqual(cardOneShell?.threadState, "stopped");
      assert.strictEqual(cardOneShell?.awaitingInput, false);
      assert.strictEqual(cardOneShell?.dependencyCount, 1);
      assert.strictEqual(cardOneShell?.hasBrief, true);

      yield* engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("cmd-thread-delete"),
        threadId,
      });
      yield* engine.dispatch({
        type: "board.card.unlink-thread",
        commandId: CommandId.make("cmd-card-unlink"),
        cardId: cardOne,
        threadId,
        createdAt: t0,
      });

      const afterUnlink = yield* snapshotQuery.getCommandReadModel();
      const linksAfterUnlink = afterUnlink.board?.cards.find(
        (card) => card.id === cardOne,
      )?.threadLinks;
      assert.strictEqual(linksAfterUnlink?.length, 1);
      assert.strictEqual(linksAfterUnlink?.[0]?.threadId, threadId);
      assert.isNotNull(linksAfterUnlink?.[0]?.tombstonedAt);

      // A tombstoned link is not an active thread: the shell falls back to
      // its resting thread state.
      const shellUnlinked = yield* snapshotQuery.getShellSnapshot();
      const cardOneUnlinked = shellUnlinked.cards?.find((card) => card.cardId === cardOne);
      assert.strictEqual(cardOneUnlinked?.activeThreadId, null);
      assert.strictEqual(cardOneUnlinked?.threadState, "none");

      // Archive round-trip: the card leaves and re-enters the shell
      // snapshot; the read model keeps it (archivedAt set) throughout.
      const shellBefore = yield* snapshotQuery.getShellSnapshot();
      assert.include(shellBefore.cards?.map((card) => card.cardId) ?? [], cardOne);

      yield* engine.dispatch({
        type: "board.card.archive",
        commandId: CommandId.make("cmd-card-archive"),
        cardId: cardOne,
        createdAt: t0,
      });
      const shellArchived = yield* snapshotQuery.getShellSnapshot();
      assert.notInclude(shellArchived.cards?.map((card) => card.cardId) ?? [], cardOne);
      const modelArchived = yield* snapshotQuery.getCommandReadModel();
      assert.strictEqual(
        modelArchived.board?.cards.find((card) => card.id === cardOne)?.archivedAt,
        t0,
      );

      yield* engine.dispatch({
        type: "board.card.unarchive",
        commandId: CommandId.make("cmd-card-unarchive"),
        cardId: cardOne,
        createdAt: t0,
      });
      const shellRestored = yield* snapshotQuery.getShellSnapshot();
      assert.include(shellRestored.cards?.map((card) => card.cardId) ?? [], cardOne);

      // Reorder card-two for coverage of the last event type.
      yield* engine.dispatch({
        type: "board.card.reorder",
        commandId: CommandId.make("cmd-card-reorder"),
        cardId: cardTwo,
        orderKey: "c",
        createdAt: t0,
      });

      // Replay every persisted event from a truly empty read model: the
      // board slice must equal the table-rehydrated one exactly.
      const rehydrated = yield* snapshotQuery.getCommandReadModel();
      const events: OrchestrationEvent[] = Array.from(
        yield* Stream.runCollect(engine.readEvents(0)),
      );
      const boardEventTypes = events
        .filter((event) => event.type.startsWith("board."))
        .map((event) => event.type);
      assert.deepStrictEqual(boardEventTypes, [
        "board.card-created",
        "board.card-created",
        "board.card-created",
        "board.card-updated",
        "board.card-moved",
        "board.card-moved",
        "board.card-moved",
        "board.card-thread-linked",
        "board.card-thread-unlinked",
        "board.card-archived",
        "board.card-unarchived",
        "board.card-reordered",
      ]);

      let replayed = createEmptyReadModel(t0);
      for (const event of events) {
        replayed = yield* projectEvent(replayed, event);
      }
      assert.deepStrictEqual(replayed.board, rehydrated.board);
    }),
  );
});

it.layer(makeBoardDomainTestLayer("t3o-board-delete-test-"))("board card delete", (it) => {
  it.effect("purges the card, rewrites the edges into it, and never re-issues its key", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* engine.dispatch(createProject(projectA, "a"));
      yield* engine.dispatch(
        createCard({ cardId: cardOne, projectId: projectA, orderKey: "m", n: "one" }),
      );
      yield* engine.dispatch(
        createCard({ cardId: cardTwo, projectId: projectA, orderKey: "t", n: "two" }),
      );
      // card-two depends on card-one, and carries a brief so the body table
      // has a row of its own to prove untouched.
      yield* engine.dispatch({
        type: "board.card.update",
        commandId: CommandId.make("cmd-two-deps"),
        cardId: cardTwo,
        dependsOn: [cardOne],
        brief: "Depends on card one.",
        createdAt: t0,
      });
      // A brief and a linked thread on the card being deleted, so the purge
      // has satellite rows to remove.
      yield* engine.dispatch({
        type: "board.card.update",
        commandId: CommandId.make("cmd-one-brief"),
        cardId: cardOne,
        brief: "The card that goes.",
        createdAt: t0,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId,
        projectId: projectA,
        title: "Planning thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: t0,
      });
      yield* engine.dispatch({
        type: "board.card.link-thread",
        commandId: CommandId.make("cmd-card-link"),
        cardId: cardOne,
        threadId,
        role: "planning",
        createdAt: t0,
      });

      yield* engine.dispatch({
        type: "board.card.delete",
        commandId: CommandId.make("cmd-card-delete"),
        cardId: cardOne,
        createdAt: t0,
      });

      // Gone from the read model — the difference from archive, which keeps
      // the card with `archivedAt` set.
      const afterDelete = yield* snapshotQuery.getCommandReadModel();
      assert.deepStrictEqual(
        afterDelete.board?.cards.map((card) => card.id),
        [cardTwo],
      );
      // Gone from the live board too.
      const shell = yield* snapshotQuery.getShellSnapshot();
      assert.notInclude(shell.cards?.map((card) => card.cardId) ?? [], cardOne);

      // The edge into it was REWRITTEN, not left dangling: an unresolvable
      // dependency id counts as unmet forever, so leaving it would block
      // card-two with nothing left that could ever unblock it.
      assert.deepStrictEqual(afterDelete.board?.cards[0]?.dependsOn, []);

      // The key stays spent. Without the number floor the next create in this
      // project would re-issue CARD-1 and two cards would answer to it.
      assert.deepStrictEqual(afterDelete.board?.nextCardNumberByProject, { [projectA]: 3 });
      yield* engine.dispatch(
        createCard({ cardId: cardOther, projectId: projectA, orderKey: "z", n: "other" }),
      );
      const afterRecreate = yield* snapshotQuery.getCommandReadModel();
      assert.deepStrictEqual(
        (afterRecreate.board?.cards ?? []).map((card) => card.key).toSorted(),
        ["CARD-2", "CARD-3"],
      );

      // Replay from empty must reach the same place as the tables: the whole
      // point of `board.card-deleted` carrying a removal the projector applies
      // rather than the projection quietly dropping rows.
      const rehydrated = yield* snapshotQuery.getCommandReadModel();
      const events: OrchestrationEvent[] = Array.from(
        yield* Stream.runCollect(engine.readEvents(0)),
      );
      assert.include(
        events.map((event) => event.type),
        "board.card-deleted",
      );
      let replayed = createEmptyReadModel(t0);
      for (const event of events) {
        replayed = yield* projectEvent(replayed, event);
      }
      assert.deepStrictEqual(replayed.board, rehydrated.board);
    }),
  );
});
