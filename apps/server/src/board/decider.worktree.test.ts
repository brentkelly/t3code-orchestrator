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
    pullRequest: null,
    pullRequestHistory: [],
    pullRequestFloor: null,
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

  // ── D6: provisioning is mode-gated by the REACTOR, not stage-gated here ──
  // Which stages need a worktree is a settings question (any stage may resolve
  // to `mode: "build"`; the review stage always does), and the pure decider
  // cannot read settings. The command is server-internal, so the resolved-mode
  // gate lives with its only dispatcher — a stage-literal invariant here would
  // orphan real git worktrees for build-mode stages not named 'building'.

  it.effect("provisions a worktree for a card in any stage (e.g. the review stage)", () =>
    Effect.gen(function* () {
      const card = makeCard({ id: "card-1", stage: "review" });
      const event = yield* decide(provision("card-1"), makeReadModel(boardWith([card])));
      assert.strictEqual(event.type, "board.card-worktree-provisioning");
      if (event.type === "board.card-worktree-provisioning") {
        assert.strictEqual(event.payload.card.stage, "review");
        assert.strictEqual(event.payload.card.worktree?.status, "provisioning");
      }
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

  it.effect("a pre-provision failure is reported on a card that has no worktree yet", () =>
    Effect.gen(function* () {
      // The reactor resolves the project cwd and the base branch BEFORE it
      // dispatches `provision-worktree`; when that resolution fails there is no
      // worktree record to mark. Rejecting the report used to swallow the only
      // signal the human had (the card just sat in Building with nothing
      // running), so the event is decided as a pure report: the reason reaches
      // the activity rail, and `worktree` stays null — the state a retry starts
      // from, since a null worktree is provisionable.
      const card = makeCard({ id: "card-1", worktree: null });
      const event = yield* decide(
        fail("card-1", "/tmp/proj is not a git repository, or has no commits yet"),
        makeReadModel(boardWith([card])),
      );
      assert.strictEqual(event.type, "board.card-worktree-failed");
      if (event.type === "board.card-worktree-failed") {
        assert.strictEqual(event.payload.card.worktree, null);
        assert.strictEqual(
          event.payload.error,
          "/tmp/proj is not a git repository, or has no commits yet",
        );
      }
    }),
  );

  it.effect("a retry that fails the same way again records the fresh reason", () =>
    Effect.gen(function* () {
      const card = makeCard({
        id: "card-1",
        worktree: {
          branch: "board/card-1",
          baseRefName: "main",
          path: null,
          status: "failed",
          attempts: 2,
          lastError: "boom",
          reclaimBlockedReason: null,
        },
      });
      const event = yield* decide(fail("card-1", "boom again"), makeReadModel(boardWith([card])));
      assert.strictEqual(event.type, "board.card-worktree-failed");
      if (event.type === "board.card-worktree-failed") {
        assert.strictEqual(event.payload.card.worktree?.status, "failed");
        assert.strictEqual(event.payload.card.worktree?.lastError, "boom again");
      }
    }),
  );

  it.effect("a ready worktree is never failed behind a live checkout's back", () =>
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
      const failure = yield* decideFail(fail("card-1"), makeReadModel(boardWith([card])));
      assert.match(String(failure), /only a provisioning or failed worktree can be failed/);
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
      assert.match(String(failure), /only a failed or reclaimed worktree can be re-provisioned/);
    }),
  );

  // ── reclaim (reverse state) ──────────────────────────────────────────

  // ── a second round of work on a reclaimed card ───────────────────────

  const mergedPr = (number: number) =>
    ({
      number,
      url: `https://github.com/acme/repo/pull/${number}`,
      state: "merged",
      headBranch: "board/card-1",
      baseRef: "main",
      checkedAt: NOW,
    }) as const;

  const reclaimedCard = (overrides?: Partial<BoardCard>) =>
    makeCard({
      id: "card-1",
      worktree: {
        branch: "board/card-1",
        baseRefName: "main",
        path: null,
        status: "reclaimed",
        attempts: 3,
        lastError: null,
        reclaimBlockedReason: null,
      },
      ...overrides,
    });

  it.effect("a reclaimed worktree is re-provisioned as a NEW round, not a retry", () =>
    Effect.gen(function* () {
      // The card finished, its worktree was reclaimed at Done, and a human has
      // dragged it back out to do more work. Before this was allowed the
      // command was rejected outright and the card wedged with nothing running
      // and no explanation.
      const card = reclaimedCard({ pullRequest: mergedPr(284) });
      const event = yield* decide(provision("card-1"), makeReadModel(boardWith([card])));
      assert.strictEqual(event.type, "board.card-worktree-provisioning");
      if (event.type !== "board.card-worktree-provisioning") return;
      const next = event.payload.card;
      assert.strictEqual(next.worktree?.status, "provisioning");
      // A new round, so the count restarts: `attempts` means "retries of THIS
      // provision", not a lifetime tally across every round the card has had.
      assert.strictEqual(next.worktree?.attempts, 1);
      // The finished round's pull request retires into the history and stops
      // being the current one...
      assert.strictEqual(next.pullRequest, null);
      assert.deepStrictEqual(
        next.pullRequestHistory.map((entry) => entry.number),
        [284],
      );
      // ...and the floor rises to shut it out of the new round.
      assert.strictEqual(next.pullRequestFloor, 284);
    }),
  );

  it.effect("a retry of a FAILED worktree leaves the round's pull request alone", () =>
    Effect.gen(function* () {
      // The distinction that makes the above safe: a failed provision is the
      // SAME round trying again. Retiring its pull request here would strand it
      // behind a floor it could never clear.
      const card = makeCard({
        id: "card-1",
        pullRequest: { ...mergedPr(284), state: "open" },
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
      if (event.type !== "board.card-worktree-provisioning") return;
      const next = event.payload.card;
      assert.strictEqual(next.worktree?.attempts, 2);
      assert.strictEqual(next.pullRequest?.number, 284);
      assert.deepStrictEqual(next.pullRequestHistory, []);
      assert.strictEqual(next.pullRequestFloor, null);
    }),
  );

  it.effect("a still-OPEN pull request is not retired and does not raise the floor", () =>
    Effect.gen(function* () {
      // Archive reclaims a worktree unconditionally, whatever the card's pull
      // request says — so a card archived mid-review and then unarchived
      // arrives here with a LIVE pull request. It is open on the very branch
      // about to be re-cut, so the next push lands on it. Retiring it would
      // floor a live pull request out of existence: the card would show none
      // while one sat open on its branch, and no later lookup could adopt it.
      const card = reclaimedCard({ pullRequest: { ...mergedPr(284), state: "open" } });
      const event = yield* decide(provision("card-1"), makeReadModel(boardWith([card])));
      assert.strictEqual(event.type, "board.card-worktree-provisioning");
      if (event.type !== "board.card-worktree-provisioning") return;
      const next = event.payload.card;
      assert.strictEqual(next.pullRequest?.number, 284);
      assert.deepStrictEqual(next.pullRequestHistory, []);
      assert.strictEqual(next.pullRequestFloor, null);
      // Still a new round for the purposes of the attempt count.
      assert.strictEqual(next.worktree?.attempts, 1);
    }),
  );

  it.effect("a round that ended without a pull request cannot LOWER the floor", () =>
    Effect.gen(function* () {
      // Round one merged #284 and set the floor. Round two was abandoned
      // without ever opening a pull request. Round three must still be floored
      // at #284 — recomputing from "the entry being retired" alone would reset
      // it to nothing and let #284 be adopted all over again.
      const card = reclaimedCard({
        pullRequest: null,
        pullRequestHistory: [mergedPr(284)],
        pullRequestFloor: 284 as BoardCard["pullRequestFloor"],
      });
      const event = yield* decide(provision("card-1"), makeReadModel(boardWith([card])));
      assert.strictEqual(event.type, "board.card-worktree-provisioning");
      if (event.type !== "board.card-worktree-provisioning") return;
      assert.strictEqual(event.payload.card.pullRequestFloor, 284);
      assert.deepStrictEqual(
        event.payload.card.pullRequestHistory.map((entry) => entry.number),
        [284],
      );
    }),
  );

  it.effect("a pull request at or below the floor is refused", () =>
    Effect.gen(function* () {
      // The forge lookup keeps answering #284 for the re-cut branch until the
      // new round opens one of its own, because it falls back to the newest
      // pull request overall when none is open. Adopting it would put a
      // "merged" link on live, unmerged work — and branch cleanup deletes the
      // remote branch of a card whose link says merged.
      const card = reclaimedCard({
        pullRequest: null,
        pullRequestHistory: [mergedPr(284)],
        pullRequestFloor: 284 as BoardCard["pullRequestFloor"],
      });
      const failure = yield* decideFail(
        {
          type: "board.card.record-pull-request",
          commandId: CommandId.make("cmd-record-pr-card-1"),
          cardId: BoardCardId.make("card-1"),
          pullRequest: mergedPr(284),
          createdAt: NOW,
        },
        makeReadModel(boardWith([card])),
      );
      assert.match(String(failure), /belongs to a completed round of work/);
    }),
  );

  it.effect("the new round's own pull request clears the floor and is adopted", () =>
    Effect.gen(function* () {
      const card = reclaimedCard({
        pullRequest: null,
        pullRequestHistory: [mergedPr(284)],
        pullRequestFloor: 284 as BoardCard["pullRequestFloor"],
      });
      const event = yield* decide(
        {
          type: "board.card.record-pull-request",
          commandId: CommandId.make("cmd-record-pr-card-1"),
          cardId: BoardCardId.make("card-1"),
          pullRequest: { ...mergedPr(301), state: "open" },
          createdAt: NOW,
        },
        makeReadModel(boardWith([card])),
      );
      assert.strictEqual(event.type, "board.card-pull-request-recorded");
      if (event.type !== "board.card-pull-request-recorded") return;
      assert.strictEqual(event.payload.card.pullRequest?.number, 301);
      // History is untouched: recording a pull request is not a round boundary.
      assert.deepStrictEqual(
        event.payload.card.pullRequestHistory.map((entry) => entry.number),
        [284],
      );
    }),
  );

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
