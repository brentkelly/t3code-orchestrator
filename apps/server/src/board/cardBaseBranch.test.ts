/**
 * The per-card base branch at the REACTOR level (T3O-5, AC6–AC9, AC13).
 *
 * The resolver and its shape gate are unit-tested in contracts, but neither
 * proves what the card's brief actually asks for: that a card pinned to
 * `release/2.4` BRANCHES from `release/2.4`. Between the pure layer and that
 * outcome sits the wiring covered here — the reactor resolving the effective
 * base out of the board aggregate, materialising it locally when it exists only
 * on a remote, refusing to fall back to the default when it exists nowhere, and
 * moving the recorded base once a retarget rebase has actually landed.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  ProviderInstanceId,
  reviewStepId,
  type BoardCard,
  type BoardCardStepState,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type VcsStatusChangeRequest,
} from "@t3tools/contracts";

import {
  cardMoved,
  cardStage,
  codexStep,
  makeBoardCard,
  movedToBuilding,
  NOW,
  readyWorktree,
  settingsWith,
  stepCompleted,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const building = String(BOARD_SEED_STAGE_IDS.building);

const settings = settingsWith({ building: [codexStep], globalMaxConcurrent: 4 });

/** A card at Building with no worktree yet, so the reactor really provisions. */
const unprovisioned = (input: {
  readonly id: string;
  readonly baseBranch?: string | null;
  readonly parentCardId?: string;
}): BoardCard => ({
  ...makeBoardCard({ id: input.id, stage: building, orderKey: "m" }),
  baseBranch: input.baseBranch ?? null,
  ...(input.parentCardId === undefined
    ? {}
    : { parentCardId: BoardCardId.make(input.parentCardId) }),
});

const boardOf = (...cards: ReadonlyArray<BoardCard>) => ({
  cards,
  nextCardNumberByProject: {},
});

const provisionCommands = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter((command) => command.type === "board.card.provision-worktree");

const failureReasons = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands
    .filter((command) => command.type === "board.card.fail-worktree")
    .map((command) => command.error);

describe("provisioning honours the card's base branch (T3O-5, D2/D7)", () => {
  it.effect("AC6: a pinned card cuts its branch from the pin, not the project default", () =>
    withGovernor(
      { board: boardOf(unprovisioned({ id: "card-1", baseBranch: "develop" })), settings },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(
            movedToBuilding(unprovisioned({ id: "card-1", baseBranch: "develop" }), 1),
          );
          const provisions = provisionCommands(yield* h.commands);
          assert.strictEqual(provisions.length, 1);
          assert.strictEqual(provisions[0]!.baseRefName, "develop");
        }),
    ),
  );

  it.effect("AC1: a card with no pin still cuts from the project default", () =>
    withGovernor({ board: boardOf(unprovisioned({ id: "card-1" })), settings }, (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(movedToBuilding(unprovisioned({ id: "card-1" }), 1));
        const provisions = provisionCommands(yield* h.commands);
        assert.strictEqual(provisions.length, 1);
        assert.strictEqual(provisions[0]!.baseRefName, "main");
      }),
    ),
  );

  it.effect("AC8: a base that exists nowhere fails the card by name, never falls back", () =>
    // The whole point of the fail-loud rule: a card pinned to `release/2.4`
    // that silently builds off `main` produces a diff nobody asked for and a
    // pull request against the wrong branch. A card that does not build is
    // strictly better, and this path is card-visible and retryable.
    withGovernor(
      {
        board: boardOf(unprovisioned({ id: "card-1", baseBranch: "release/2.4" })),
        settings,
        missingBranches: ["release/2.4"],
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(
            movedToBuilding(unprovisioned({ id: "card-1", baseBranch: "release/2.4" }), 1),
          );
          assert.strictEqual(provisionCommands(yield* h.commands).length, 0);
          const reasons = failureReasons(yield* h.commands);
          assert.strictEqual(reasons.length, 1);
          assert.match(String(reasons[0]), /release\/2\.4/);
        }),
    ),
  );

  it.effect("AC7: a remote-only base is materialised locally and recorded WITHOUT the remote", () =>
    // `measureBaseTip` resolves `refs/heads/<base>`, `pullMergedBaseBranch`
    // fetches `<base>:<base>`, and the rebase targets it verbatim. Recording
    // `origin/develop` breaks all three silently, so the reactor creates the
    // local branch first and records the local name.
    withGovernor(
      {
        board: boardOf(unprovisioned({ id: "card-1", baseBranch: "develop" })),
        settings,
        missingBranches: ["develop"],
        remoteOnlyBranches: ["develop"],
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(
            movedToBuilding(unprovisioned({ id: "card-1", baseBranch: "develop" }), 1),
          );
          const provisions = provisionCommands(yield* h.commands);
          assert.strictEqual(provisions.length, 1);
          assert.strictEqual(provisions[0]!.baseRefName, "develop");
          // The materialisation itself: `git branch develop origin/develop`.
          assert.isTrue(
            (yield* h.gitInvocations).some(
              (args) =>
                args[0] === "branch" && args[1] === "develop" && args[2] === "origin/develop",
            ),
          );
        }),
    ),
  );
});

describe("the run prompt names the card's base branch (T3O-5, D9)", () => {
  const turnText = (commands: ReadonlyArray<OrchestrationCommand>) => {
    const turn = commands.find((command) => command.type === "thread.turn.start");
    return turn?.type === "thread.turn.start" ? turn.message.text : "";
  };

  it.effect("AC10: a build step is told the branch it is working against", () =>
    // Reinforcement on Build, but the same line is what makes Code review's
    // shipped "open one against its base ref" instruction resolvable at all.
    withGovernor(
      { board: boardOf(unprovisioned({ id: "card-1", baseBranch: "develop" })), settings },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(
            movedToBuilding(unprovisioned({ id: "card-1", baseBranch: "develop" }), 1),
          );
          assert.include(turnText(yield* h.commands), "This card's base branch is `develop`");
        }),
    ),
  );

  it.effect("AC10: an unpinned card is told its project's default branch", () =>
    withGovernor({ board: boardOf(unprovisioned({ id: "card-1" })), settings }, (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(movedToBuilding(unprovisioned({ id: "card-1" }), 1));
        assert.include(turnText(yield* h.commands), "This card's base branch is `main`");
      }),
    ),
  );

  it.effect("AC10: only a plan step carries the project-root caveat", () =>
    // A plan step runs in the workspace ROOT with no branch of its own, so it
    // reads whatever the root has checked out — which may not be the code the
    // card will change.
    Effect.gen(function* () {
      const planning = String(BOARD_SEED_STAGE_IDS.planning);
      const planCard: BoardCard = {
        ...makeBoardCard({ id: "card-1", stage: planning, orderKey: "m" }),
        baseBranch: "develop",
      };
      yield* withGovernor(
        {
          board: boardOf(planCard),
          settings: settingsWith({
            building: [codexStep],
            globalMaxConcurrent: 4,
            planning: codexStep,
          }),
        },
        (h) =>
          Effect.gen(function* () {
            yield* h.pumpDomain(
              cardMoved(planCard, String(BOARD_SEED_STAGE_IDS.sprint), planning, 1),
            );
            const text = turnText(yield* h.commands);
            assert.include(text, "This card's base branch is `develop`");
            assert.include(text, "project workspace root");
          }),
      );
      yield* withGovernor(
        { board: boardOf(unprovisioned({ id: "card-2", baseBranch: "develop" })), settings },
        (h) =>
          Effect.gen(function* () {
            yield* h.pumpDomain(
              movedToBuilding(unprovisioned({ id: "card-2", baseBranch: "develop" }), 1),
            );
            assert.notInclude(turnText(yield* h.commands), "project workspace root");
          }),
      );
    }),
  );
});

describe("a split's integration branch is cut from the parent's base (T3O-5, D8)", () => {
  it.effect("AC9: a parent pinned to release/2.4 gets an integration branch cut from it", () =>
    // A latent bug the per-card base exposes rather than new behaviour: cutting
    // the integration branch from the project default would silently base every
    // child of a `release/2.4` split on `main`.
    withGovernor(
      {
        board: boardOf(unprovisioned({ id: "card-parent", baseBranch: "release/2.4" })),
        settings,
        // The parent's integration branch does not exist yet, which is what
        // makes the reactor actually cut it rather than adopt an existing ref.
        missingBranches: ["board/card-parent"],
      },
      (h) =>
        Effect.gen(function* () {
          const parent = unprovisioned({ id: "card-parent", baseBranch: "release/2.4" });
          const child = unprovisioned({ id: "card-child", parentCardId: "card-parent" });
          yield* h.pumpDomain(plansApproved(parent, [child.id], 1));
          const recorded = (yield* h.commands).filter(
            (command) => command.type === "board.card.record-integration-branch",
          );
          assert.strictEqual(recorded.length, 1);
          assert.strictEqual(recorded[0]!.baseRefName, "release/2.4");
          assert.isTrue(
            (yield* h.gitInvocations).some(
              (args) =>
                args[0] === "branch" &&
                args[1] === "board/card-parent" &&
                args[2] === "release/2.4",
            ),
          );
        }),
    ),
  );

  it.effect("a parent with no pin still cuts its integration branch from the default", () =>
    withGovernor(
      {
        board: boardOf(unprovisioned({ id: "card-parent" })),
        settings,
        missingBranches: ["board/card-parent"],
      },
      (h) =>
        Effect.gen(function* () {
          const parent = unprovisioned({ id: "card-parent" });
          yield* h.pumpDomain(plansApproved(parent, [], 1));
          const recorded = (yield* h.commands).filter(
            (command) => command.type === "board.card.record-integration-branch",
          );
          assert.strictEqual(recorded.length, 1);
          assert.strictEqual(recorded[0]!.baseRefName, "main");
        }),
    ),
  );
});

/** A `board.plans-approved` event carrying the parent — `handlePlansApproved`
    reads only `payload.card`. */
const plansApproved = (
  card: BoardCard,
  childCardIds: ReadonlyArray<BoardCardId>,
  sequence: number,
): OrchestrationEvent =>
  ({
    type: "board.plans-approved",
    sequence,
    payload: { cardId: card.id, card, childCardIds, approvedAt: card.updatedAt },
  }) as unknown as OrchestrationEvent;

describe("retargeting a card whose branch already exists (T3O-5, D10)", () => {
  const review = String(BOARD_SEED_STAGE_IDS.review);
  const merge = String(BOARD_SEED_STAGE_IDS.merge);

  /** A top-level card at some stage, cut from `main`, optionally retargeted. */
  const card = (stage: string, baseBranch: string | null): BoardCard => ({
    ...makeBoardCard({ id: "card-1", stage, orderKey: "m", worktree: readyWorktree("card-1") }),
    baseBranch,
  });

  /** The settled last step of a converged review loop. Recorded at "main" it is
      FRESH under the tip-moved rule, which is exactly what isolates the
      retarget trigger from t3o-24's. */
  const settledReviewStep = (): BoardCardStepState => ({
    cardId: BoardCardId.make("card-1"),
    stepId: reviewStepId("review", 1),
    stepLabel: "Review · round 1",
    stageLabel: "Code review",
    attempt: 1,
    stallCount: 0,
    lastNudgeAt: null,
    baseTipAtRoundStart: "main",
    lastError: null,
    awaitingReason: "question" as const,
    prompt: "review it",
    providerInstanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5-codex",
    mode: "build",
    runtimeMode: "auto",
    humanInLoop: false,
    maxAttempts: 3,
    timeoutMs: 600_000,
    threadId: null,
    status: "succeeded",
    slotHeld: false,
    forceStart: false,
    startedAt: null,
    updatedAt: NOW,
  });

  /** The card AFTER a retarget's sync landed: pinned at `base` and cut from it
      too, so the retarget trigger is satisfied and only the pull request's own
      base is still behind. */
  const rebasedOnto = (base: string): BoardCard => ({
    ...card(merge, base),
    worktree: { ...readyWorktree("card-1"), baseRefName: base },
  });

  const openPr: VcsStatusChangeRequest = {
    number: 284,
    title: "Card 1",
    url: "https://github.com/acme/repo/pull/284",
    baseRef: "main",
    headRef: "board/card-1",
    state: "open",
  };

  const convergedRound = {
    cardId: BoardCardId.make("card-1"),
    stepId: reviewStepId("review", 1),
    outcome: "succeeded",
    summary: "clean",
    payload: JSON.stringify({ reviewedSha: "sha-reviewed", findings: [] }),
    threadId: null,
    completedAt: NOW,
  } as const;

  const boardWith = (stage: string, baseBranch: string | null) => ({
    cards: [card(stage, baseBranch)],
    stepStates: [settledReviewStep()],
    stepCompletions: [convergedRound],
    nextCardNumberByProject: {},
  });

  it.effect("AC11: a RETARGETED top-level card plans a sync step on its next round", () =>
    // The load-bearing behaviour change: a top-level card could never receive a
    // sync step before. Without it, retargeting opens a pull request against a
    // base the branch was never rebased onto, so the diff carries every commit
    // the old base has that the new one does not — a review of a diff nobody
    // wrote.
    withGovernor({ board: boardWith(merge, "develop"), settings }, (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(cardMoved(card(merge, "develop"), review, merge, 1));
        // Held at the crossing and sent back to review, exactly as a stale
        // sub-board child is.
        assert.strictEqual(cardStage(yield* h.board, BoardCardId.make("card-1")), review);
        yield* h.pumpDomain(cardMoved(card(review, "develop"), merge, review, 2));
        const step = ((yield* h.board).stepStates ?? []).find(
          (state) => state.cardId === BoardCardId.make("card-1"),
        );
        assert.strictEqual(step?.stepId, reviewStepId("sync", 1));
      }),
    ),
  );

  it.effect("AC11: a top-level card whose base merely MOVED still plans no sync", () =>
    // t3o-24's scope is deliberately untouched: a top-level card's base moving
    // is the universal condition of trunk development, reviewed at the human's
    // discretion. Widening that would change behaviour for every card.
    withGovernor({ board: boardWith(merge, null), settings }, (h) =>
      Effect.gen(function* () {
        h.setBaseTip("main", "sha-moved-on-under-us");
        yield* h.pumpDomain(cardMoved(card(merge, null), review, merge, 1));
        assert.strictEqual(cardStage(yield* h.board, BoardCardId.make("card-1")), merge);
      }),
    ),
  );

  it.effect("AC14: retargeting and reverting before any round runs plans no sync at all", () =>
    // The condition is derived, not stored, so there is no pending flag left
    // over to fire against a card that is back where it started.
    withGovernor({ board: boardWith(merge, null), settings }, (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(cardMoved(card(merge, null), review, merge, 1));
        assert.strictEqual(cardStage(yield* h.board, BoardCardId.make("card-1")), merge);
      }),
    ),
  );

  it.effect("AC12: the sync step's prompt names both the old base and the new", () =>
    withGovernor({ board: boardWith(merge, "develop"), settings }, (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(cardMoved(card(merge, "develop"), review, merge, 1));
        yield* h.pumpDomain(cardMoved(card(review, "develop"), merge, review, 2));
        const step = ((yield* h.board).stepStates ?? []).find(
          (state) => state.cardId === BoardCardId.make("card-1"),
        );
        assert.include(step?.prompt ?? "", "was cut from `main`");
        assert.include(step?.prompt ?? "", "retargeted at `develop`");
        assert.notInclude(step?.prompt ?? "", "a sibling card merged into it");
      }),
    ),
  );

  it.effect("AC13: the sync step succeeding moves the recorded base to the new one", () =>
    withGovernor({ board: boardWith(review, "develop"), settings }, (h) =>
      Effect.gen(function* () {
        // Re-entering review plans the sync step and starts it.
        yield* h.pumpDomain(cardMoved(card(review, "develop"), merge, review, 1));
        const live = ((yield* h.board).stepStates ?? []).find(
          (state) => state.cardId === BoardCardId.make("card-1"),
        );
        assert.strictEqual(live?.stepId, reviewStepId("sync", 1));
        yield* h.pumpDomain(
          stepCompleted(BoardCardId.make("card-1"), "succeeded", 2, reviewStepId("sync", 1)),
        );
        const recorded = (yield* h.board).cards.find(
          (entry) => entry.id === BoardCardId.make("card-1"),
        );
        assert.strictEqual(recorded?.worktree?.baseRefName, "develop");
      }),
    ),
  );

  it.effect("refuses to merge a pull request still aimed at the base the card left", () =>
    // The retarget's other half. The rebase moved the branch and the recorded
    // base onto `develop`, but the pull request opened before the retarget
    // still merges into `main` — and nothing in the board moves it: the
    // Ready-for-merge → review return does not cross the Done boundary, so the
    // round is not a new one and no fresh pull request is opened. Merging it
    // would land these commits on `main`, which is neither the branch they were
    // rebased onto nor the one the card says it targets.
    withGovernor(
      {
        board: {
          cards: [rebasedOnto("develop")],
          stepStates: [settledReviewStep()],
          stepCompletions: [convergedRound],
          nextCardNumberByProject: {},
        },
        settings,
        pullRequest: { ...openPr, baseRef: "main" },
      },
      (h) =>
        Effect.gen(function* () {
          const result = yield* h.reactor.mergePullRequest(BoardCardId.make("card-1"));
          assert.strictEqual(result.outcome, "refused");
          assert.include(
            result.outcome === "refused" ? result.detail : "",
            "still merges into 'main'",
          );
          // Refused BEFORE the forge is asked, so nothing lands on the wrong
          // branch even momentarily.
          assert.strictEqual((yield* h.mergeAttempts).length, 0);
        }),
    ),
  );

  it.effect("merges once the pull request has been retargeted to match", () =>
    // The same card with the retarget completed on the forge: the gate is
    // about the two disagreeing, not about the card having been retargeted.
    withGovernor(
      {
        board: {
          cards: [rebasedOnto("develop")],
          stepStates: [settledReviewStep()],
          stepCompletions: [convergedRound],
          nextCardNumberByProject: {},
        },
        settings,
        pullRequest: { ...openPr, baseRef: "develop" },
      },
      (h) =>
        Effect.gen(function* () {
          const result = yield* h.reactor.mergePullRequest(BoardCardId.make("card-1"));
          assert.strictEqual(result.outcome, "merged");
          assert.strictEqual((yield* h.mergeAttempts).length, 1);
        }),
    ),
  );

  it.effect("AC13: a sync that FAILED leaves the recorded base exactly where it was", () =>
    // A failed rebase reconciled nothing, so moving the recorded base would
    // make the card claim a diff it does not have — and would clear the
    // divergence signal that is the only thing saying so.
    withGovernor({ board: boardWith(review, "develop"), settings }, (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(cardMoved(card(review, "develop"), merge, review, 1));
        yield* h.pumpDomain(
          stepCompleted(BoardCardId.make("card-1"), "failed", 2, reviewStepId("sync", 1)),
        );
        const recorded = (yield* h.board).cards.find(
          (entry) => entry.id === BoardCardId.make("card-1"),
        );
        assert.strictEqual(recorded?.worktree?.baseRefName, "main");
      }),
    ),
  );
});
