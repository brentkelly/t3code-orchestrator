/**
 * Publish-on-done through the live reactor: a Done + merged arrival runs the
 * project's script (or records why it did not).
 */
import * as Fs from "node:fs";

import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  type BoardCardPullRequest,
  type VcsStatusChangeRequest,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  cardMoved,
  codexStep,
  makeBoardCard,
  NOW,
  projectId,
  readyWorktree,
  settingsWith,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const MERGE = String(BOARD_SEED_STAGE_IDS.merge);
const DONE = String(BOARD_SEED_STAGE_IDS.done);
const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const forgePr: VcsStatusChangeRequest = {
  number: 284,
  title: "Services index page",
  url: "https://example.test/pull/284",
  baseRef: "main",
  headRef: "board/card-one",
  state: "merged",
};

const cardPr = (id: string): BoardCardPullRequest => ({
  number: 284,
  url: "https://example.test/pull/284",
  state: "merged",
  headBranch: `board/${id}`,
  baseRef: "main",
  checkedAt: NOW,
});

const publishScript = {
  id: "publish",
  name: "Publish",
  command: "true",
  icon: "build" as const,
  runOnWorktreeCreate: false,
  runOnCardDone: true,
};

const doneMergedCard = (
  id: string,
  publish?: {
    readonly round: number;
    readonly status: "failed" | "running" | "succeeded" | "skipped";
    readonly sha: string | null;
    readonly detail: string | null;
  },
) =>
  makeBoardCard({
    id,
    stage: DONE,
    orderKey: id,
    worktree: readyWorktree(id),
    pullRequest: cardPr(id),
    ...(publish === undefined ? {} : { publish }),
  });

const setup = (input: {
  readonly publishOnDone: boolean;
  readonly publishProjectIds?: ReadonlyArray<typeof projectId>;
  readonly publish?: {
    readonly round: number;
    readonly status: "failed" | "running" | "succeeded" | "skipped";
    readonly sha: string | null;
    readonly detail: string | null;
  };
  readonly cards?: ReturnType<typeof doneMergedCard>[];
  readonly projectScripts?: readonly (typeof publishScript)[];
  readonly worktreeDirty?: boolean;
  readonly checkoutBranch?: string;
  readonly publishHeadSha?: string;
}) => ({
  board: {
    cards: input.cards ?? [doneMergedCard("card-one", input.publish)],
    nextCardNumberByProject: {},
  },
  settings: {
    ...settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    lifecycle: {
      reclaimWorktreeOnDone: true,
      publishOnDone: input.publishOnDone,
      publishProjectIds: input.publishProjectIds ?? [projectId],
    },
  },
  pullRequest: forgePr,
  ...(input.projectScripts === undefined
    ? {}
    : (() => {
        Fs.mkdirSync("/tmp/project-1", { recursive: true });
        return { projectScripts: input.projectScripts };
      })()),
  ...(input.worktreeDirty === undefined ? {} : { worktreeDirty: input.worktreeDirty }),
  ...(input.checkoutBranch === undefined ? {} : { checkoutBranch: input.checkoutBranch }),
  ...(input.publishHeadSha === undefined ? {} : { publishHeadSha: input.publishHeadSha }),
});

const publishNotes = (
  commands: ReadonlyArray<{
    readonly type: string;
    readonly kind?: string;
    readonly detail?: string;
  }>,
) =>
  commands.filter(
    (command) =>
      command.type === "board.card.record-note" &&
      (command.kind === "card-published" || command.kind === "card-publish-failed"),
  );

it.effect("does not publish when the master switch is off", () =>
  withGovernor(setup({ publishOnDone: false }), (h) =>
    Effect.gen(function* () {
      yield* h.pumpDomain(cardMoved(doneMergedCard("card-one"), MERGE, DONE, 1));
      assert.strictEqual(publishNotes(yield* h.commands).length, 0);
    }),
  ),
);

it.effect("records a failure when the project has no publish script", () =>
  withGovernor(setup({ publishOnDone: true }), (h) =>
    Effect.gen(function* () {
      yield* h.pumpDomain(cardMoved(doneMergedCard("card-one"), MERGE, DONE, 1));
      const failed = (yield* h.commands).filter(
        (command) =>
          command.type === "board.card.record-note" && command.kind === "card-publish-failed",
      );
      assert.ok(failed.length >= 1);
      const note = failed.at(-1);
      assert.ok(note !== undefined && note.type === "board.card.record-note");
      if (note === undefined || note.type !== "board.card.record-note") return;
      assert.match(note.detail, /runOnCardDone/);
    }),
  ),
);

it.effect("records a failure when the checkout has uncommitted changes", () =>
  withGovernor(
    setup({
      publishOnDone: true,
      projectScripts: [publishScript],
      worktreeDirty: true,
    }),
    (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(cardMoved(doneMergedCard("card-one"), MERGE, DONE, 1));
        const failed = (yield* h.commands).filter(
          (command) =>
            command.type === "board.card.record-note" && command.kind === "card-publish-failed",
        );
        const note = failed.at(-1);
        assert.ok(note !== undefined && note.type === "board.card.record-note");
        if (note === undefined || note.type !== "board.card.record-note") return;
        assert.match(note.detail, /uncommitted changes/);
      }),
  ),
);

it.effect("records a failure when the checkout is on another branch", () =>
  withGovernor(
    setup({
      publishOnDone: true,
      projectScripts: [publishScript],
      checkoutBranch: "feature",
    }),
    (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(cardMoved(doneMergedCard("card-one"), MERGE, DONE, 1));
        const failed = (yield* h.commands).filter(
          (command) =>
            command.type === "board.card.record-note" && command.kind === "card-publish-failed",
        );
        const note = failed.at(-1);
        assert.ok(note !== undefined && note.type === "board.card.record-note");
        if (note === undefined || note.type !== "board.card.record-note") return;
        assert.match(note.detail, /feature/);
        assert.match(note.detail, /main/);
      }),
  ),
);

it.effect("skips when this SHA is already live", () =>
  withGovernor(
    setup({
      publishOnDone: true,
      projectScripts: [publishScript],
      publishHeadSha: HEAD_SHA,
      cards: [
        doneMergedCard("card-one"),
        doneMergedCard("card-live", {
          round: 0,
          status: "succeeded",
          sha: HEAD_SHA,
          detail: null,
        }),
      ],
    }),
    (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(cardMoved(doneMergedCard("card-one"), MERGE, DONE, 1));
        const notes = publishNotes(yield* h.commands);
        const last = notes.at(-1);
        assert.ok(last !== undefined && last.type === "board.card.record-note");
        if (last === undefined || last.type !== "board.card.record-note") return;
        assert.strictEqual(last.kind, "card-published");
        assert.match(last.detail, /Already serving/);
      }),
  ),
);

it.effect("two cards of one project publish the SHA once", () =>
  withGovernor(
    setup({
      publishOnDone: true,
      projectScripts: [publishScript],
      publishHeadSha: HEAD_SHA,
      cards: [doneMergedCard("card-one"), doneMergedCard("card-two")],
    }),
    (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(cardMoved(doneMergedCard("card-one"), MERGE, DONE, 1));
        const afterFirst = (yield* h.board).cards.find((card) => String(card.id) === "card-one");
        assert.strictEqual(afterFirst?.publish?.status, "succeeded");
        assert.strictEqual(afterFirst?.publish?.sha, HEAD_SHA);
        yield* h.pumpDomain(cardMoved(doneMergedCard("card-two"), MERGE, DONE, 2));
        const notes = publishNotes(yield* h.commands);
        const details = notes
          .filter((note) => note.type === "board.card.record-note")
          .map((note) => (note.type === "board.card.record-note" ? note.detail : ""));
        assert.ok(
          details.some((detail) => /Published/.test(detail)),
          `expected a Published note, got ${JSON.stringify(details)}`,
        );
        assert.ok(
          details.some((detail) => /Already serving/.test(detail)),
          `expected an Already serving note, got ${JSON.stringify(details)}`,
        );
      }),
  ),
);

it.effect("retry refuses when publish is disabled for the project", () =>
  withGovernor(
    setup({
      publishOnDone: false,
      publish: { round: 0, status: "failed", sha: null, detail: "build failed" },
    }),
    (h) =>
      Effect.gen(function* () {
        const result = yield* h.reactor.retryPublish(BoardCardId.make("card-one"));
        assert.strictEqual(result.outcome, "disabled");
      }),
  ),
);

it.effect("retry re-runs a failed publish", () =>
  withGovernor(
    setup({
      publishOnDone: true,
      projectScripts: [publishScript],
      publish: { round: 0, status: "failed", sha: null, detail: "build failed" },
    }),
    (h) =>
      Effect.gen(function* () {
        const result = yield* h.reactor.retryPublish(BoardCardId.make("card-one"));
        assert.strictEqual(result.outcome, "started");
        yield* h.reactor.drain;
        const notes = publishNotes(yield* h.commands);
        const last = notes.at(-1);
        assert.ok(last !== undefined && last.type === "board.card.record-note");
        if (last === undefined || last.type !== "board.card.record-note") return;
        assert.strictEqual(last.kind, "card-published");
        assert.match(last.detail, /Published/);
      }),
  ),
);
