/**
 * Draft pull requests (T3O-12): with the Code review stage's
 * `draftPullRequests` on, the review agent opens the pull request as a draft
 * and the board marks it ready when the card arrives at Ready for merge — the
 * one moment the repository's full CI should start.
 *
 * Driven through the live reactor (`withGovernor`), because the behaviour is
 * the arrival handler, the merge path and the forge seam together. The
 * gateway's own live-read idempotency is covered in
 * `BoardPullRequestGateway.test.ts`; here the stub answers `readied` once and
 * `not-draft` after, which is exactly what that read produces.
 */
import {
  BOARD_DRAFT_PULL_REQUEST_BUILD,
  BOARD_SEED_STAGE_IDS,
  type BoardCard,
  type OrchestrationCommand,
  type VcsStatusChangeRequest,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { BoardMergeState } from "./boardMergeState.ts";
import {
  cardMoved,
  codexStep,
  makeBoardCard,
  readyWorktree,
  settingsWith,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const BUILDING = String(BOARD_SEED_STAGE_IDS.building);
const REVIEW = String(BOARD_SEED_STAGE_IDS.review);
const MERGE = String(BOARD_SEED_STAGE_IDS.merge);

const draftPr: VcsStatusChangeRequest = {
  number: 412,
  title: "Open pull requests as drafts",
  url: "https://example.test/pull/412",
  baseRef: "main",
  headRef: "board/card-one",
  state: "open",
  isDraft: true,
};

/** The card as it arrives at the merge stage, its draft link already recorded. */
const cardAt = (stage: string): BoardCard =>
  makeBoardCard({
    id: "card-one",
    stage,
    orderKey: "m",
    worktree: readyWorktree("card-one"),
    pullRequest: {
      number: draftPr.number,
      url: draftPr.url,
      state: "open",
      headBranch: draftPr.headRef,
      baseRef: draftPr.baseRef,
      isDraft: true,
      checkedAt: "2026-01-01T00:00:00.000Z",
    },
  });

const setup = (input: {
  readonly drafts: boolean;
  readonly markReadyOutcomes?: ReadonlyArray<
    "readied" | "not-draft" | { readonly failWith: string }
  >;
  readonly mergeFailure?: string;
  readonly mergeState?: BoardMergeState;
}) => ({
  board: { cards: [cardAt(MERGE)], nextCardNumberByProject: {} },
  settings: settingsWith({
    building: [codexStep],
    globalMaxConcurrent: 3,
    review: { draftPullRequests: input.drafts },
  }),
  pullRequest: draftPr,
  ...(input.markReadyOutcomes === undefined ? {} : { markReadyOutcomes: input.markReadyOutcomes }),
  ...(input.mergeFailure === undefined ? {} : { mergeFailure: input.mergeFailure }),
  ...(input.mergeState === undefined ? {} : { mergeState: input.mergeState }),
});

const notesOf = (commands: ReadonlyArray<OrchestrationCommand>, kind: string) =>
  commands.flatMap((command) =>
    command.type === "board.card.record-note" && command.kind === kind
      ? [command.detail ?? ""]
      : [],
  );

it.effect("marks the draft ready once on arrival at Ready for merge, and says so", () =>
  withGovernor(setup({ drafts: true, markReadyOutcomes: ["readied", "not-draft"] }), (h) =>
    Effect.gen(function* () {
      yield* h.pumpDomain(cardMoved(cardAt(MERGE), REVIEW, MERGE, 1));
      assert.deepStrictEqual(yield* h.markReadyCalls, [{ number: 412 }]);
      assert.deepStrictEqual(notesOf(yield* h.commands, "card-pull-request-ready"), [
        "PR #412 marked ready; CI started.",
      ]);
    }),
  ),
);

it.effect("is retry-safe: a re-run arrival readies nothing twice and writes one note", () =>
  withGovernor(setup({ drafts: true, markReadyOutcomes: ["readied", "not-draft"] }), (h) =>
    Effect.gen(function* () {
      yield* h.pumpDomain(cardMoved(cardAt(MERGE), REVIEW, MERGE, 1));
      // The same arrival delivered again (a replay, a re-run step): the live
      // read finds the pull request already ready, so nothing is written.
      yield* h.pumpDomain(cardMoved(cardAt(MERGE), REVIEW, MERGE, 2));
      // …and a Merge click afterwards does not ready it again either.
      yield* h.reactor.mergePullRequest(cardAt(MERGE).id);
      assert.strictEqual(notesOf(yield* h.commands, "card-pull-request-ready").length, 1);
    }),
  ),
);

it.effect("leaves the pull request alone on arrival when the setting is off", () =>
  withGovernor(setup({ drafts: false, markReadyOutcomes: ["readied"] }), (h) =>
    Effect.gen(function* () {
      yield* h.pumpDomain(cardMoved(cardAt(MERGE), REVIEW, MERGE, 1));
      assert.deepStrictEqual(yield* h.markReadyCalls, []);
      assert.deepStrictEqual(notesOf(yield* h.commands, "card-pull-request-ready"), []);
    }),
  ),
);

it.effect("a merge still readies a recorded draft after the setting is turned off", () =>
  withGovernor(setup({ drafts: false, markReadyOutcomes: ["readied"] }), (h) =>
    Effect.gen(function* () {
      // The board opened this draft while the setting was on; it has since
      // been turned off. The forge will not merge a draft, so the merge must
      // ready it first rather than strand the card.
      yield* h.reactor.mergePullRequest(cardAt(MERGE).id);
      assert.deepStrictEqual(yield* h.markReadyCalls, [{ number: 412 }]);
      assert.deepStrictEqual(notesOf(yield* h.commands, "card-pull-request-ready"), [
        "PR #412 marked ready; CI started.",
      ]);
      assert.strictEqual((yield* h.mergeAttempts).length, 1);
    }),
  ),
);

it.effect("leaves a pull request that is not a draft alone (a human readied it)", () =>
  withGovernor(setup({ drafts: true, markReadyOutcomes: ["not-draft"] }), (h) =>
    Effect.gen(function* () {
      yield* h.pumpDomain(cardMoved(cardAt(MERGE), REVIEW, MERGE, 1));
      assert.deepStrictEqual(notesOf(yield* h.commands, "card-pull-request-ready"), []);
      assert.deepStrictEqual(notesOf(yield* h.commands, "card-merge-refused"), []);
    }),
  ),
);

it.effect("never readies the draft while the card is still in the review loop", () =>
  withGovernor(setup({ drafts: true, markReadyOutcomes: ["readied"] }), (h) =>
    Effect.gen(function* () {
      // Into Code review: the loop's rounds and fix commits must keep it a draft.
      yield* h.pumpDomain(cardMoved(cardAt(REVIEW), BUILDING, REVIEW, 1));
      assert.deepStrictEqual(yield* h.markReadyCalls, []);
    }),
  ),
);

it.effect("a failed ready is noted, and the next merge attempt tries it again first", () =>
  withGovernor(
    setup({
      drafts: true,
      markReadyOutcomes: [{ failWith: "gh: rate limited" }, "readied"],
    }),
    (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(cardMoved(cardAt(MERGE), REVIEW, MERGE, 1));
        // No merge was attempted on arrival, so the failure is not a merge
        // refusal: it is a neutral row naming the forge's reason.
        assert.deepStrictEqual(notesOf(yield* h.commands, "card-merge-refused"), []);
        const deferred = notesOf(yield* h.commands, "card-pull-request-ready");
        assert.strictEqual(deferred.length, 1);
        assert.include(deferred[0], "gh: rate limited");

        // The link still says draft, so the Merge click readies it before
        // merging — a transient failure costs one attempt, not the card.
        yield* h.reactor.mergePullRequest(cardAt(MERGE).id);
        assert.strictEqual((yield* h.markReadyCalls).length, 2);
        assert.deepStrictEqual(notesOf(yield* h.commands, "card-pull-request-ready").slice(1), [
          "PR #412 marked ready; CI started.",
        ]);
        assert.strictEqual((yield* h.mergeAttempts).length, 1);
      }),
  ),
);

it.effect("a failed ready on the merge path is recorded as a merge refusal", () =>
  withGovernor(
    setup({ drafts: true, markReadyOutcomes: [{ failWith: "gh: rate limited" }] }),
    (h) =>
      Effect.gen(function* () {
        yield* h.reactor.mergePullRequest(cardAt(MERGE).id);
        const refused = notesOf(yield* h.commands, "card-merge-refused");
        assert.isTrue(refused.some((detail) => detail.includes("gh: rate limited")));
      }),
  ),
);

const spawnedPrompts = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.flatMap((command) =>
    command.type === "thread.turn.start" ? [command.message.text] : [],
  );

it.effect("tells the build step to open any pull request as a draft, only when on", () =>
  Effect.gen(function* () {
    for (const drafts of [true, false]) {
      yield* withGovernor(
        { ...setup({ drafts }), board: { cards: [cardAt(BUILDING)], nextCardNumberByProject: {} } },
        (h) =>
          Effect.gen(function* () {
            yield* h.pumpDomain(cardMoved(cardAt(BUILDING), REVIEW, BUILDING, 1));
            const prompts = spawnedPrompts(yield* h.commands);
            assert.strictEqual(prompts.length, 1);
            assert.strictEqual(prompts[0]!.includes(BOARD_DRAFT_PULL_REQUEST_BUILD), drafts);
          }),
      );
    }
  }),
);
