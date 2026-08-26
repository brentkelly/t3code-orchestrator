/**
 * The card ↔ pull request link, the Merge button, and branch cleanup at Done.
 *
 * Integration tests against the LIVE supervisor reactor wired to the stateful
 * engine double (`withGovernor`), because the behaviour under test spans the
 * reactor, the real decider and the real projector: "the card records its PR"
 * is only true if the command is accepted, decided into an event, and
 * projected back onto the card the reactor next reads.
 *
 * The forge itself is stubbed through `BoardPullRequestGateway` — the two-method
 * seam the board sees — so a test can say "the lookup fails" or "the merge is
 * refused for conflicts" without a real repository or a real `gh`.
 */
import { assert, it, describe } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  BOARD_SEED_STAGE_IDS,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardCardId,
  type BoardCardStepState,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type VcsStatusChangeRequest,
} from "@t3tools/contracts";

import {
  cardMoved,
  codexStep,
  makeBoardCard,
  readyWorktree,
  settingsWith,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const openPr: VcsStatusChangeRequest = {
  number: 284,
  title: "Pre-commit format and lint gate",
  url: "https://github.com/acme/repo/pull/284",
  baseRef: "main",
  headRef: "board/card-1",
  state: "open",
};

const settings = (merge?: Parameters<typeof settingsWith>[0]["merge"]) =>
  settingsWith({
    building: [codexStep],
    globalMaxConcurrent: 4,
    ...(merge === undefined ? {} : { merge }),
  });

const cardInMerge = (): BoardCard =>
  makeBoardCard({
    id: "card-1",
    stage: String(BOARD_SEED_STAGE_IDS.merge),
    orderKey: "m",
    worktree: readyWorktree("card-1"),
  });

/** A running step in the merge stage — what a human gets by restarting the
    stage thread by hand. The step id IS the stage id (t3o-15, D1). */
const runningMergeStep = (cardId: BoardCardId): BoardCardStepState => ({
  cardId,
  stepId: String(BOARD_SEED_STAGE_IDS.merge),
  stepLabel: "Ready for merge",
  stageLabel: "Ready for merge",
  attempt: 1,
  stallCount: 0,
  lastNudgeAt: null,
  prompt: "resolve the conflicts",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
  mode: "build",
  runtimeMode: "auto",
  humanInLoop: false,
  maxAttempts: 3,
  timeoutMs: 1_000,
  threadId: ThreadId.make("thread-1"),
  status: "running",
  slotHeld: true,
  startedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

/** The on-demand kickoff signal a Merge-click conflict dispatches. */
const stageThreadRequested = (card: BoardCard, sequence: number): OrchestrationEvent =>
  ({
    type: "board.card-stage-thread-requested",
    sequence,
    payload: { cardId: card.id, stage: card.stage },
  }) as unknown as OrchestrationEvent;

const mergeStepCompleted = (cardId: BoardCardId, sequence: number): OrchestrationEvent =>
  ({
    type: "board.card-step-completed",
    sequence,
    payload: {
      cardId,
      completion: {
        cardId,
        stepId: String(BOARD_SEED_STAGE_IDS.merge),
        outcome: "succeeded",
        summary: "resolved the conflicts",
        payload: null,
        threadId: ThreadId.make("thread-1"),
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  }) as unknown as OrchestrationEvent;

const recordedPullRequests = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter((command) => command.type === "board.card.record-pull-request");

const movesTo = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.flatMap((command) =>
    command.type === "board.card.move" ? [String(command.toStage)] : [],
  );

describe("card ↔ pull request link", () => {
  it.effect("records the pull request a branch lookup finds", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [cardInMerge()] },
        settings: settings(),
        pullRequest: openPr,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.refreshPullRequest(cardInMerge().id);
          const board = yield* h.board;
          const card = board.cards[0]!;
          assert.equal(card.pullRequest?.number, 284);
          assert.equal(card.pullRequest?.state, "open");
          assert.equal(card.pullRequest?.url, openPr.url);
        }),
    ),
  );

  it.effect("records nothing when a second lookup finds the same pull request", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [cardInMerge()] },
        settings: settings(),
        pullRequest: openPr,
      },
      (h) =>
        Effect.gen(function* () {
          // The refresh triggers fire on every step boundary, stage move and
          // card open; the overwhelming majority find exactly what the card
          // already holds. Landing an event for each would bloat the log and
          // republish a shell delta per card open for no change at all.
          yield* h.reactor.refreshPullRequest(cardInMerge().id);
          yield* h.reactor.refreshPullRequest(cardInMerge().id);
          yield* h.reactor.refreshPullRequest(cardInMerge().id);
          assert.equal(recordedPullRequests(yield* h.commands).length, 1);
        }),
    ),
  );

  it.effect("keeps the last known link when the lookup FAILS", () =>
    Effect.gen(function* () {
      // First establish a link, then re-run with a failing gateway. A rate
      // limit or a network blip must leave the badge alone: "we looked and
      // there is none" and "we could not look" are different answers, and
      // recording the first over an existing link would blank a card's PR.
      const linked = {
        ...cardInMerge(),
        pullRequest: {
          number: 284,
          url: openPr.url,
          state: "open" as const,
          headBranch: "board/card-1",
          baseRef: "main",
          checkedAt: "2026-01-01T00:00:00.000Z",
        },
      };
      yield* withGovernor(
        {
          board: { nextCardNumberByProject: {}, cards: [linked] },
          settings: settings(),
          pullRequest: { failWith: "API rate limit exceeded" },
        },
        (h) =>
          Effect.gen(function* () {
            yield* h.reactor.refreshPullRequest(linked.id);
            assert.equal(recordedPullRequests(yield* h.commands).length, 0);
            const board = yield* h.board;
            assert.equal(board.cards[0]!.pullRequest?.number, 284);
          }),
      );
    }),
  );

  it.effect("still refreshes a card whose worktree was reclaimed", () =>
    Effect.gen(function* () {
      // Reclaim nulls `path`, not `branch`, and such a card can still be
      // merged — so freezing its PR link at whatever it last said would leave
      // a Merge button acting on stale state.
      const reclaimed = {
        ...cardInMerge(),
        worktree: {
          branch: "board/card-1",
          baseRefName: "main",
          path: null,
          status: "reclaimed" as const,
          attempts: 1,
          lastError: null,
          reclaimBlockedReason: null,
        },
      };
      yield* withGovernor(
        {
          board: { nextCardNumberByProject: {}, cards: [reclaimed] },
          settings: settings(),
          pullRequest: openPr,
        },
        (h) =>
          Effect.gen(function* () {
            yield* h.reactor.refreshPullRequest(reclaimed.id);
            assert.equal((yield* h.board).cards[0]!.pullRequest?.number, 284);
          }),
      );
    }),
  );

  it.effect("never looks up a card with no worktree", () =>
    Effect.gen(function* () {
      const branchless = makeBoardCard({
        id: "card-1",
        stage: String(BOARD_SEED_STAGE_IDS.ready),
        orderKey: "m",
      });
      yield* withGovernor(
        {
          board: { nextCardNumberByProject: {}, cards: [branchless] },
          settings: settings(),
          pullRequest: openPr,
        },
        (h) =>
          Effect.gen(function* () {
            // No branch pushed means nothing to look up — the first of the
            // cheap refusals that keep the lookup set bounded by cards
            // actually in flight.
            yield* h.reactor.refreshPullRequest(branchless.id);
            assert.equal(recordedPullRequests(yield* h.commands).length, 0);
          }),
      );
    }),
  );

  it.effect("stops looking up a card whose pull request is merged", () =>
    Effect.gen(function* () {
      const merged = {
        ...cardInMerge(),
        pullRequest: {
          number: 284,
          url: openPr.url,
          state: "merged" as const,
          headBranch: "board/card-1",
          baseRef: "main",
          checkedAt: "2026-01-01T00:00:00.000Z",
        },
      };
      yield* withGovernor(
        {
          board: { nextCardNumberByProject: {}, cards: [merged] },
          settings: settings(),
          // A gateway that would answer with something DIFFERENT if asked, so
          // an absent record proves the lookup was skipped rather than that it
          // ran and found no change.
          pullRequest: { ...openPr, number: 999 },
        },
        (h) =>
          Effect.gen(function* () {
            yield* h.reactor.refreshPullRequest(merged.id);
            assert.equal(recordedPullRequests(yield* h.commands).length, 0);
            assert.equal((yield* h.board).cards[0]!.pullRequest?.number, 284);
          }),
      );
    }),
  );
});

describe("merging a card's pull request", () => {
  it.effect("merges and advances the card to the next stage", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [cardInMerge()] },
        settings: settings(),
        pullRequest: openPr,
      },
      (h) =>
        Effect.gen(function* () {
          const result = yield* h.reactor.mergePullRequest(cardInMerge().id);
          assert.equal(result.outcome, "merged");
          assert.deepStrictEqual(movesTo(yield* h.commands), [String(BOARD_SEED_STAGE_IDS.done)]);
          assert.equal((yield* h.mergeAttempts).length, 1);
        }),
    ),
  );

  it.effect("reports a refusal, leaves the card put, and does NOT retry", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [cardInMerge()] },
        settings: settings(),
        pullRequest: openPr,
        mergeFailure: "Pull request is not mergeable: required status check 'ci' is failing",
      },
      (h) =>
        Effect.gen(function* () {
          const result = yield* h.reactor.mergePullRequest(cardInMerge().id);
          assert.equal(result.outcome, "refused");
          // The forge's own wording reaches the user rather than a paraphrase.
          assert.include(
            result.outcome === "refused" ? result.detail : "",
            "required status check",
          );
          // A block only a human can clear: the card stays where it is, and
          // nothing tries again on its own.
          assert.deepStrictEqual(movesTo(yield* h.commands), []);
          assert.equal((yield* h.mergeAttempts).length, 1);
        }),
    ),
  );

  it.effect("starts the conflict-resolution step when the merge conflicts", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [cardInMerge()] },
        settings: settings(),
        pullRequest: openPr,
        mergeFailure: "Pull request is not mergeable: merge conflict between base and head",
      },
      (h) =>
        Effect.gen(function* () {
          const result = yield* h.reactor.mergePullRequest(cardInMerge().id);
          assert.equal(result.outcome, "conflict");
          // The stage's own thread: the merge stage resolves to the
          // conflict-resolution prompt in build mode, so this starts that step
          // and nothing else — the stage auto-executes nothing.
          const started = (yield* h.commands).filter(
            (command) => command.type === "board.card.start-stage-thread",
          );
          assert.equal(started.length, 1);
          // Not merged, so the card does not move.
          assert.deepStrictEqual(movesTo(yield* h.commands), []);
        }),
    ),
  );

  it.effect("does not claim a conflict fix that never started", () =>
    Effect.gen(function* () {
      // An archived card is the reachable version of "the kickoff was
      // dropped": the decider refuses `start-stage-thread` for one, which is
      // exactly what happens if someone archives a card mid-merge.
      // The link is seeded and already matches what the lookup returns, so the
      // pre-merge refresh is a no-op — an archived card cannot record one.
      const archived = {
        ...cardInMerge(),
        archivedAt: "2026-01-01T00:00:00.000Z",
        pullRequest: {
          number: openPr.number,
          url: openPr.url,
          state: "open" as const,
          headBranch: openPr.headRef,
          baseRef: openPr.baseRef,
          checkedAt: "2026-01-01T00:00:00.000Z",
        },
      };
      yield* withGovernor(
        {
          board: { nextCardNumberByProject: {}, cards: [archived] },
          settings: settings(),
          pullRequest: openPr,
          mergeFailure: "Pull request is not mergeable: merge conflict between base and head",
        },
        (h) =>
          Effect.gen(function* () {
            // Reporting `conflict` disables the Merge button. If the fix never
            // started, that leaves the card claiming work that does not exist
            // with its only retry greyed out — so the outcome must be
            // `refused`, which keeps the button live.
            const result = yield* h.reactor.mergePullRequest(archived.id);
            assert.equal(result.outcome, "refused");
          }),
      );
    }),
  );

  it.effect("treats GitHub's own conflict wording as a conflict", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [cardInMerge()] },
        settings: settings(),
        pullRequest: openPr,
        // What `gh` prints when the merge commit cannot be constructed. The
        // word "conflict" does not appear, so this is the case a matcher keyed
        // only on that word would misread as a policy block.
        mergeFailure: "Pull request is not mergeable: the merge commit cannot be cleanly created",
      },
      (h) =>
        Effect.gen(function* () {
          const result = yield* h.reactor.mergePullRequest(cardInMerge().id);
          assert.equal(result.outcome, "conflict");
        }),
    ),
  );

  it.effect("does NOT read a missing approval as a conflict", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [cardInMerge()] },
        settings: settings(),
        pullRequest: openPr,
        // "not mergeable" is GitHub's wrapper for EVERY refusal. Reading it as
        // a conflict would start an agent to merge base into a branch that has
        // nothing wrong with it, and push the result.
        mergeFailure: "Pull request is not mergeable: At least 1 approving review is required",
      },
      (h) =>
        Effect.gen(function* () {
          const result = yield* h.reactor.mergePullRequest(cardInMerge().id);
          assert.equal(result.outcome, "refused");
          const started = (yield* h.commands).filter(
            (command) => command.type === "board.card.start-stage-thread",
          );
          assert.deepStrictEqual(started, []);
        }),
    ),
  );

  it.effect("does NOT merge when a merge-stage step succeeds without a merge request", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [cardInMerge()],
          stepStates: [runningMergeStep(cardInMerge().id)],
        },
        settings: settings(),
        pullRequest: openPr,
        initialShells: new Map([["thread-1", { id: "thread-1" } as never]]),
      },
      (h) =>
        Effect.gen(function* () {
          // A human can start a thread in the merge stage by hand (the card's
          // stage-restart menu). Its success must NOT merge the pull request —
          // that would be a merge nobody asked for, which is the one thing the
          // design refuses to do. Only a Merge click that hit a conflict arms
          // the completion path.
          yield* h.pumpDomain(mergeStepCompleted(cardInMerge().id, 1));
          assert.equal((yield* h.mergeAttempts).length, 0);
          assert.deepStrictEqual(movesTo(yield* h.commands), []);
        }),
    ),
  );

  it.effect("runs the conflict prompt on a SECOND conflict fix, not a blank thread", () =>
    Effect.gen(function* () {
      // The gap this closes: the reactor's re-entry rule blanks the prompt and
      // forces a human-in-the-loop thread when a card already has a completion
      // for the stage's step. Every other conflict test uses a card with no
      // prior merge-stage completion, which is the only branch that behaves as
      // designed — so a card on its SECOND Merge click got an empty
      // conversation instead of the conflict-resolution prompt.
      // The card carries the PRIOR fix's live thread link as well as its
      // completion. The link's role is the stage id, which is what
      // `hasLiveStageThread` refuses to trample — so a fixture with only the
      // completion misses the guard that actually fires first in production.
      const card = {
        ...cardInMerge(),
        threadLinks: [
          {
            threadId: ThreadId.make("thread-prior-fix"),
            role: String(BOARD_SEED_STAGE_IDS.merge),
            linkedAt: "2026-01-01T00:00:00.000Z",
            tombstonedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      };
      const priorCompletion = {
        cardId: card.id,
        stepId: String(BOARD_SEED_STAGE_IDS.merge),
        outcome: "succeeded" as const,
        summary: "resolved the conflicts",
        payload: null,
        threadId: null,
        completedAt: "2026-01-01T00:00:00.000Z",
      };
      yield* withGovernor(
        {
          board: {
            nextCardNumberByProject: {},
            cards: [card],
            stepCompletions: [priorCompletion],
          },
          settings: settings(),
          pullRequest: openPr,
          mergeFailure: "Pull request is not mergeable: merge conflict between base and head",
        },
        (h) =>
          Effect.gen(function* () {
            // Arm the card the only way a human can — a Merge click that
            // conflicts — then deliver the kickoff it requested.
            yield* h.reactor.mergePullRequest(card.id);
            yield* h.pumpDomain(stageThreadRequested(card, 1));
            const selected = (yield* h.commands).filter(
              (command) => command.type === "board.card.select-step",
            );
            assert.equal(selected.length, 1, "a step should have been selected");
            const step = selected[0] as { readonly prompt: string; readonly humanInLoop: boolean };
            assert.isAbove(
              step.prompt.trim().length,
              0,
              "the conflict step must carry its prompt, not an empty re-entry one",
            );
            assert.strictEqual(
              step.humanInLoop,
              false,
              "the conflict fix runs unattended so its success can complete the merge",
            );
          }),
      );
    }),
  );

  it.effect("gives a HUMAN restarting the merge stage a conversation, not an agent", () =>
    Effect.gen(function* () {
      // The other side of the same exemption. A person restarting this stage's
      // thread by hand wants to talk about the merge — not an unattended agent
      // that merges base into their branch and pushes it. The card is NOT
      // armed here (no Merge click), which is what tells the two apart.
      const card = cardInMerge();
      yield* withGovernor(
        {
          board: { nextCardNumberByProject: {}, cards: [card] },
          settings: settings(),
          pullRequest: openPr,
        },
        (h) =>
          Effect.gen(function* () {
            yield* h.pumpDomain(stageThreadRequested(card, 1));
            const selected = (yield* h.commands).filter(
              (command) => command.type === "board.card.select-step",
            );
            assert.equal(selected.length, 1, "a step should have been selected");
            const step = selected[0] as { readonly prompt: string; readonly humanInLoop: boolean };
            assert.strictEqual(
              step.humanInLoop,
              true,
              "a hand-started merge-stage thread must stay human-in-the-loop",
            );
          }),
      );
    }),
  );

  it.effect("releases the conflict fix's thread so a second Merge click can run", () =>
    Effect.gen(function* () {
      // The trap: the fix's thread link has role === the stage id, which is
      // exactly what `hasLiveStageThread` refuses to trample. Left live, the
      // next Merge click on a branch that conflicts again opens nothing while
      // the card still says it is resolving conflicts.
      const card = cardInMerge();
      yield* withGovernor(
        {
          board: {
            nextCardNumberByProject: {},
            cards: [
              {
                ...card,
                threadLinks: [
                  {
                    threadId: ThreadId.make("thread-1"),
                    role: String(BOARD_SEED_STAGE_IDS.merge),
                    linkedAt: "2026-01-01T00:00:00.000Z",
                    tombstonedAt: null,
                  },
                ],
              },
            ],
            stepStates: [runningMergeStep(card.id)],
          },
          settings: settings(),
          pullRequest: openPr,
          mergeFailure: "Pull request is not mergeable: merge conflict between base and head",
          initialShells: new Map([["thread-1", { id: "thread-1" } as never]]),
        },
        (h) =>
          Effect.gen(function* () {
            // Arm the card the only way a human can: a Merge click that
            // conflicts.
            yield* h.reactor.mergePullRequest(card.id);
            // The fix reports success; the merge is retried and conflicts
            // again, so the card stays put — and the thread must be released.
            yield* h.pumpDomain(mergeStepCompleted(card.id, 1));

            const unlinked = (yield* h.commands).filter(
              (command) =>
                command.type === "board.card.unlink-thread" &&
                String(command.threadId) === "thread-1",
            );
            assert.equal(unlinked.length, 1, "the conflict fix's thread must be unlinked");
          }),
      );
    }),
  );

  it.effect("refuses to merge a pull request that is already merged", () =>
    Effect.gen(function* () {
      const merged = {
        ...cardInMerge(),
        pullRequest: {
          number: 284,
          url: openPr.url,
          state: "merged" as const,
          headBranch: "board/card-1",
          baseRef: "main",
          checkedAt: "2026-01-01T00:00:00.000Z",
        },
      };
      yield* withGovernor(
        {
          board: { nextCardNumberByProject: {}, cards: [merged] },
          settings: settings(),
          pullRequest: openPr,
        },
        (h) =>
          Effect.gen(function* () {
            const result = yield* h.reactor.mergePullRequest(merged.id);
            assert.equal(result.outcome, "not-open");
            // Never reached the forge: a merged PR is terminal, so there is
            // nothing to ask and nothing to do.
            assert.equal((yield* h.mergeAttempts).length, 0);
          }),
      );
    }),
  );

  it.effect("reports no-pull-request rather than merging blind", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [cardInMerge()] },
        settings: settings(),
        pullRequest: null,
      },
      (h) =>
        Effect.gen(function* () {
          const result = yield* h.reactor.mergePullRequest(cardInMerge().id);
          assert.equal(result.outcome, "no-pull-request");
          assert.equal((yield* h.mergeAttempts).length, 0);
        }),
    ),
  );
});

describe("branch cleanup at Done", () => {
  const doneMove = (card: BoardCard, sequence: number) =>
    cardMoved(
      card,
      String(BOARD_SEED_STAGE_IDS.merge),
      String(BOARD_SEED_STAGE_IDS.done),
      sequence,
    );

  it.effect("refreshes the pull request as the card enters Done", () =>
    Effect.gen(function* () {
      const card = cardInMerge();
      yield* withGovernor(
        {
          board: { nextCardNumberByProject: {}, cards: [card] },
          settings: settings(),
          pullRequest: { ...openPr, state: "merged" },
        },
        (h) =>
          Effect.gen(function* () {
            // The decision to delete a branch is made against what the forge
            // says NOW, not a cached `open` from before someone merged the PR
            // on GitHub while the card sat in the merge stage.
            const done = { ...card, stage: BOARD_SEED_STAGE_IDS.done };
            yield* h.pumpDomain(doneMove(done, 1));
            const recorded = recordedPullRequests(yield* h.commands);
            assert.equal(recorded.length, 1);
            assert.equal((yield* h.board).cards[0]!.pullRequest?.state, "merged");
          }),
      );
    }),
  );

  it.effect("leaves an UNMERGED pull request's branch alone at Done", () =>
    Effect.gen(function* () {
      const card = cardInMerge();
      yield* withGovernor(
        {
          board: { nextCardNumberByProject: {}, cards: [card] },
          settings: settings(),
          pullRequest: openPr,
        },
        (h) =>
          Effect.gen(function* () {
            const done = { ...card, stage: BOARD_SEED_STAGE_IDS.done };
            yield* h.pumpDomain(doneMove(done, 1));
            // Still open: the commits do not live in the base branch, so the
            // branch is the only place the work exists. Nothing is deleted.
            assert.equal((yield* h.board).cards[0]!.pullRequest?.state, "open");
          }),
      );
    }),
  );
});
