/**
 * T3o column-card meta row (t3o-06): the two footer indicators whose data is
 * NOT on the card aggregate — whether the brief carries a picture, and how many
 * plans the card holds.
 *
 * Both are derived from slices a card-carrying delta cannot see (the brief body
 * lives only in `board_card_bodies` (D8); plans live in `board_plans`), so each
 * has two producers that must agree: a SQL expression on the shell-snapshot
 * query, and a JS derivation on the delta path. The whole point of these
 * assertions is that they agree — a card that shows an image icon after a
 * reconnect but not after an edit is exactly the "stale label" this codebase
 * refuses to ship.
 *
 * Run through the real seams (decider → event store → projection → snapshot
 * query), because that is where the two producers actually meet.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  boardBriefHasImage,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  type BoardCardShell,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
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
import { ServerConfig } from "../config.ts";

/** One database per scenario: commands are deduped by `commandId` and every
    scenario shares a seed, so a shared database would let one scenario's writes
    satisfy the next one's dispatch. */
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
const projectId = ProjectId.make("project-board");
const cardId = BoardCardId.make("card-meta");

const createProject = {
  type: "project.create",
  commandId: CommandId.make("cmd-project"),
  projectId,
  title: "Board Project",
  workspaceRoot: "/tmp/project-board",
  defaultModelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5-codex",
  },
  createdAt,
} as const;

const seedCard = (brief?: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch(createProject);
    yield* engine.dispatch({
      type: "board.card.create",
      commandId: CommandId.make("cmd-create"),
      cardId,
      projectId,
      title: "A card with a footer",
      orderKey: "m",
      ...(brief === undefined ? {} : { brief }),
      createdAt,
    });
    return engine;
  });

const cardsOf = (snapshot: OrchestrationShellSnapshot): ReadonlyArray<BoardCardShell> =>
  snapshot.cards ?? [];

const shellCard = Effect.gen(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const snapshot = yield* snapshotQuery.getShellSnapshot();
  return cardsOf(snapshot).find((card) => card.cardId === cardId);
});

/** Both spellings of the image rule over the same inputs. `boardBriefHasImage`
    is the JS one; the SQL one is the `LIKE` pair on `listBoardCardShellRows`,
    exercised here by writing each fixture as a real brief and reading the shell
    back. A disagreement here is the bug this pairing exists to catch. */
const IMAGE_FIXTURES: ReadonlyArray<readonly [string, boolean]> = [
  ["A brief with a ![screenshot](./shot.png) in it", true],
  ['Pasted markup: <img src="shot.png" alt="shot">', true],
  ["Multi\nline: ![an alt that\nwraps](shot.png)", true],
  ["Alt and target split apart: ![alt]\n(shot.png)", false],
  ['Shouty markup: <IMG SRC="shot.png">', true],
  ["Just words about images and pictures", false],
  ["A link, not an image: [the design](https://example.com)", false],
  ["An empty alt: ![](./shot.png)", true],
  ["Bracket noise [a] and parens (b) but no image", false],
];

describe("boardBriefHasImage", () => {
  it("matches a markdown image or an img tag, and nothing else", () => {
    for (const [brief, expected] of IMAGE_FIXTURES) {
      assert.strictEqual(boardBriefHasImage(brief), expected, brief);
    }
  });
});

it.layer(makeTestLayer("t3o-card-meta-1-"))("brief image, snapshot vs delta", (it) => {
  it.effect("derives the same flag in SQL as the contracts helper does in JS", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch(createProject);
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      for (const [index, [brief, expected]] of IMAGE_FIXTURES.entries()) {
        const fixtureId = BoardCardId.make(`card-fixture-${index}`);
        yield* engine.dispatch({
          type: "board.card.create",
          commandId: CommandId.make(`cmd-fixture-${index}`),
          cardId: fixtureId,
          projectId,
          title: `Fixture ${index}`,
          orderKey: `m${index}`,
          brief,
          createdAt,
        });
        const snapshot = yield* snapshotQuery.getShellSnapshot();
        const card = cardsOf(snapshot).find((entry) => entry.cardId === fixtureId);
        assert.strictEqual(
          card?.briefHasImage,
          expected,
          `SQL disagreed with boardBriefHasImage on: ${brief}`,
        );
      }
    }),
  );
});

it.layer(makeTestLayer("t3o-card-meta-2-"))("brief image over the card's life", (it) => {
  it.effect("raises the flag with the brief and clears it when the image goes", () =>
    Effect.gen(function* () {
      const engine = yield* seedCard();
      assert.strictEqual(
        (yield* shellCard)?.briefHasImage,
        false,
        "a card created without a brief has no image",
      );

      yield* engine.dispatch({
        type: "board.card.update",
        commandId: CommandId.make("cmd-add-image"),
        cardId,
        brief: "Here is the mockup: ![mockup](./mockup.png)",
        createdAt,
      });
      assert.strictEqual((yield* shellCard)?.briefHasImage, true);

      // Editing the image back out has to clear the icon — which is why the
      // resting value is the ABSENT key rather than `false`.
      yield* engine.dispatch({
        type: "board.card.update",
        commandId: CommandId.make("cmd-drop-image"),
        cardId,
        brief: "Here is the mockup, described in words instead.",
        createdAt,
      });
      assert.strictEqual((yield* shellCard)?.briefHasImage, false);

      // A card edit that does not touch the brief must not disturb the flag.
      yield* engine.dispatch({
        type: "board.card.update",
        commandId: CommandId.make("cmd-add-image-again"),
        cardId,
        brief: 'Back again: <img src="mockup.png">',
        createdAt,
      });
      yield* engine.dispatch({
        type: "board.card.update",
        commandId: CommandId.make("cmd-retitle"),
        cardId,
        title: "Renamed, brief untouched",
        createdAt,
      });
      assert.strictEqual((yield* shellCard)?.briefHasImage, true);
    }),
  );
});

it.layer(makeTestLayer("t3o-card-meta-3-"))("plan count", (it) => {
  it.effect("counts the card's plans on the shell and follows a re-proposal", () =>
    Effect.gen(function* () {
      const engine = yield* seedCard();
      assert.strictEqual((yield* shellCard)?.planCount, 0, "a planless card counts none");

      yield* engine.dispatch({
        type: "board.plans.propose",
        commandId: CommandId.make("cmd-propose"),
        cardId,
        plans: [
          { key: "one", title: "First", summary: "s", dependsOn: [], body: "# One" },
          { key: "two", title: "Second", summary: "s", dependsOn: ["one"], body: "# Two" },
        ],
        createdAt,
      });
      assert.strictEqual((yield* shellCard)?.planCount, 2);

      // A proposal REPLACES the set wholesale, so the count must come down too.
      yield* engine.dispatch({
        type: "board.plans.propose",
        commandId: CommandId.make("cmd-repropose"),
        cardId,
        plans: [{ key: "one", title: "First", summary: "s", dependsOn: [], body: "# One" }],
        createdAt,
      });
      assert.strictEqual((yield* shellCard)?.planCount, 1);
    }),
  );
});

it.layer(makeTestLayer("t3o-card-meta-3-"))("pull request, snapshot vs delta", (it) => {
  it.effect("carries the card's PR number on the SNAPSHOT, not only on deltas", () =>
    Effect.gen(function* () {
      // The failure this exists to catch: `prNumber` derived only on the delta
      // path lights the badge while the client stays connected and drops it on
      // every reload, because the snapshot is a separate SQL producer. The two
      // must agree — that is the whole point of this file.
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      yield* engine.dispatch(createProject);
      yield* engine.dispatch({
        type: "board.card.create",
        commandId: CommandId.make("cmd-pr-card"),
        cardId,
        projectId,
        title: "Card with a pull request",
        orderKey: "m",
        createdAt,
      });

      const shellCard = Effect.map(snapshotQuery.getShellSnapshot(), (snapshot) =>
        cardsOf(snapshot).find((entry) => entry.cardId === cardId),
      );

      // Before any lookup: absent key, and `hasPr` false — a PR-less board
      // pays zero wire bytes for the field.
      const before = yield* shellCard;
      assert.strictEqual(before?.hasPr, false);
      assert.strictEqual("prNumber" in (before ?? {}), false);

      yield* engine.dispatch({
        type: "board.card.record-pull-request",
        commandId: CommandId.make("cmd-record-pr"),
        cardId,
        pullRequest: {
          number: 284,
          url: "https://github.com/acme/repo/pull/284",
          state: "open",
          headBranch: "board/card-1",
          baseRef: "main",
          checkedAt: createdAt,
        },
        createdAt,
      });

      const linked = yield* shellCard;
      assert.strictEqual(linked?.prNumber, 284);
      assert.strictEqual(linked?.hasPr, true);

      // A merged PR is still a PR: the badge keeps the number after the work
      // lands, which is what makes a Done card traceable to its change.
      yield* engine.dispatch({
        type: "board.card.record-pull-request",
        commandId: CommandId.make("cmd-record-pr-merged"),
        cardId,
        pullRequest: {
          number: 284,
          url: "https://github.com/acme/repo/pull/284",
          state: "merged",
          headBranch: "board/card-1",
          baseRef: "main",
          checkedAt: createdAt,
        },
        createdAt,
      });
      const merged = yield* shellCard;
      assert.strictEqual(merged?.prNumber, 284);
      assert.strictEqual(merged?.hasPr, true);

      // Clearing is a real value, not "no data": the badge must be able to go.
      yield* engine.dispatch({
        type: "board.card.record-pull-request",
        commandId: CommandId.make("cmd-record-pr-cleared"),
        cardId,
        pullRequest: null,
        createdAt,
      });
      const cleared = yield* shellCard;
      assert.strictEqual(cleared?.hasPr, false);
      assert.strictEqual("prNumber" in (cleared ?? {}), false);
    }),
  );

  it.effect("keeps the badge on a RETIRED pull request across a round boundary", () =>
    Effect.gen(function* () {
      // A card dragged back out of Done starts a second round on a re-cut
      // branch, which nulls `pullRequest` until that round opens one of its
      // own. Both producers fall back to the newest retired round so the badge
      // does not blink out in between — and, more to the point, so the merged
      // pull request stays reachable from the card while the new work runs.
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      // Its own card id: the tests in this layer share one database, so
      // reusing `cardId` would collide with the card an earlier scenario made.
      const roundCardId = BoardCardId.make("card-second-round");
      yield* engine.dispatch(createProject);
      yield* engine.dispatch({
        type: "board.card.create",
        commandId: CommandId.make("cmd-round-card"),
        cardId: roundCardId,
        projectId,
        title: "Card on its second round",
        orderKey: "m",
        createdAt,
      });
      const shellCard = Effect.map(snapshotQuery.getShellSnapshot(), (snapshot) =>
        cardsOf(snapshot).find((entry) => entry.cardId === roundCardId),
      );

      // Round one: a worktree, a merged pull request, then the reclaim that
      // settling the card at Done performs.
      yield* engine.dispatch({
        type: "board.card.provision-worktree",
        commandId: CommandId.make("cmd-round-1-provision"),
        cardId: roundCardId,
        branch: "board/card-second-round",
        baseRefName: "main",
        createdAt,
      });
      yield* engine.dispatch({
        type: "board.card.record-worktree",
        commandId: CommandId.make("cmd-round-1-record"),
        cardId: roundCardId,
        path: "/tmp/wt/card-second-round",
        createdAt,
      });
      yield* engine.dispatch({
        type: "board.card.record-pull-request",
        commandId: CommandId.make("cmd-round-1-pr"),
        cardId: roundCardId,
        pullRequest: {
          number: 284,
          url: "https://github.com/acme/repo/pull/284",
          state: "merged",
          headBranch: "board/card-second-round",
          baseRef: "main",
          checkedAt: createdAt,
        },
        createdAt,
      });
      yield* engine.dispatch({
        type: "board.card.move",
        commandId: CommandId.make("cmd-round-1-done"),
        cardId: roundCardId,
        toStage: BOARD_SEED_STAGE_IDS.done,
        override: true,
        createdAt,
      });
      yield* engine.dispatch({
        type: "board.card.reclaim-worktree",
        commandId: CommandId.make("cmd-round-1-reclaim"),
        cardId: roundCardId,
        outcome: "removed",
        createdAt,
      });
      assert.strictEqual((yield* shellCard)?.prNumber, 284);

      // Round two begins when the card LEAVES Done — that move retires #284 and
      // clears the card's current pull request, whatever became of its
      // worktree.
      yield* engine.dispatch({
        type: "board.card.move",
        commandId: CommandId.make("cmd-round-2-reopen"),
        cardId: roundCardId,
        toStage: BOARD_SEED_STAGE_IDS.building,
        override: true,
        createdAt,
      });
      const secondRound = yield* shellCard;
      // The SQL producer read it out of `pull_request_history`, since
      // `pull_request` is now NULL — the fallback the JS producer makes on the
      // delta path, and the pair must agree.
      assert.strictEqual(secondRound?.prNumber, 284);
      assert.strictEqual(secondRound?.hasPr, true);
    }),
  );

  it.effect("carries the PR number onto the ARCHIVED shell too", () =>
    Effect.gen(function* () {
      // A THIRD producer: the archive page reuses the same bounded shell
      // through its own SQL query and its own mapper, so it can drop a field
      // the live pair agree on. Archived work is exactly when the PR number
      // matters most — it is how you find out what happened to a card someone
      // abandoned.
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const archivedId = BoardCardId.make("card-archived-pr");
      yield* engine.dispatch(createProject);
      yield* engine.dispatch({
        type: "board.card.create",
        commandId: CommandId.make("cmd-archived-pr-card"),
        cardId: archivedId,
        projectId,
        title: "Abandoned but linked",
        orderKey: "z",
        createdAt,
      });
      yield* engine.dispatch({
        type: "board.card.record-pull-request",
        commandId: CommandId.make("cmd-archived-pr-record"),
        cardId: archivedId,
        pullRequest: {
          number: 512,
          url: "https://github.com/acme/repo/pull/512",
          state: "closed",
          headBranch: "board/card-archived-pr",
          baseRef: "main",
          checkedAt: createdAt,
        },
        createdAt,
      });
      yield* engine.dispatch({
        type: "board.card.archive",
        commandId: CommandId.make("cmd-archive-pr-card"),
        cardId: archivedId,
        createdAt,
      });

      const archived = yield* snapshotQuery.getArchivedShellSnapshot();
      const card = cardsOf(archived).find((entry) => entry.cardId === archivedId);
      assert.strictEqual(card?.prNumber, 512);
      assert.strictEqual(card?.hasPr, true);
    }),
  );
});

it.layer(makeTestLayer("t3o-card-meta-4-"))("sub-board parent, snapshot vs delta", (it) => {
  it.effect("carries a child's parentCardId on the SNAPSHOT, not only on deltas", () =>
    Effect.gen(function* () {
      // The same failure the PR-number pair exists to catch, one field over and
      // with worse consequences: `parentCardId` derived only on the delta path
      // holds the sub-board together while the client stays connected, then
      // every reload flattens it — the children reappear on the ROOT board
      // (`isBoardCardInScope` reads a top-level card), the parent loses its
      // plan pips and its drill-in door (`deriveBoardCardPlanProgress` skips a
      // parentless card), and, because the shell's pending-split derivation
      // keys on those same pips, an already-approved parent goes back to
      // wearing "Needs approval" with no approval left to give.
      const engine = yield* seedCard();
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      yield* engine.dispatch({
        type: "board.plans.propose",
        commandId: CommandId.make("cmd-split-propose"),
        cardId,
        plans: [
          { key: "one", title: "First", summary: "s", dependsOn: [], body: "# One" },
          { key: "two", title: "Second", summary: "s", dependsOn: ["one"], body: "# Two" },
        ],
        createdAt,
      });
      yield* engine.dispatch({
        type: "board.plans.approve",
        commandId: CommandId.make("cmd-split-approve"),
        cardId,
        createdAt,
      });

      const cards = cardsOf(yield* snapshotQuery.getShellSnapshot());
      const children = cards.filter((entry) => entry.parentCardId === cardId);
      assert.strictEqual(children.length, 2, "both materialised children name their parent");
      // Omitted for a top-level card, which is what keeps a split-less board's
      // shell payload byte-identical to its pre-sub-board self.
      const parent = cards.find((entry) => entry.cardId === cardId);
      assert.strictEqual("parentCardId" in (parent ?? {}), false);
    }),
  );

  it.effect("carries the parent onto the ARCHIVED shell too", () =>
    Effect.gen(function* () {
      // The archive's own query and mapper, the third producer: restoring a
      // child has to put it back in its sub-board, not on the root board.
      const engine = yield* seedCard();
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const childId = BoardCardId.make("card-archived-child");
      yield* engine.dispatch({
        type: "board.card.create",
        commandId: CommandId.make("cmd-archived-child-create"),
        cardId: childId,
        projectId,
        title: "A child, archived",
        orderKey: "z",
        parentCardId: cardId,
        stage: BOARD_SEED_STAGE_IDS.ready,
        createdAt,
      });
      yield* engine.dispatch({
        type: "board.card.archive",
        commandId: CommandId.make("cmd-archive-child"),
        cardId: childId,
        createdAt,
      });

      const archived = cardsOf(yield* snapshotQuery.getArchivedShellSnapshot());
      assert.strictEqual(archived.find((entry) => entry.cardId === childId)?.parentCardId, cardId);
    }),
  );
});
