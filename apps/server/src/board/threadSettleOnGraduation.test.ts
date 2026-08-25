/**
 * The card auto-settles the orchestration threads it is finished with, so they
 * drop out of the thread inbox (the card↔thread links stay — the card keeps its
 * tabs). Two triggers, both dispatched by the live supervisor reactor:
 *
 *  - Rule 1 (graduation): a FORWARD card move settles every thread still linked
 *    to the card — the just-completed stage's thread plus any earlier one left
 *    active. A backward move (a reopen) settles nothing.
 *  - Rule 2 (review loop): as the loop finishes one phase and moves to the next
 *    step within the stage, that phase's thread is settled — the review loop is
 *    the one stage that runs several steps, so its finished phases would
 *    otherwise pile up in the inbox until the card finally leaves review.
 *
 * These are integration tests against the LIVE reactor wired to the stateful
 * engine double (`withGovernor`): a settle is asserted on `commands` (what the
 * reactor dispatched), since a settled thread is an orchestration-domain fact
 * the board card state does not carry.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  BoardCardId,
  BOARD_SEED_STAGE_IDS,
  DEFAULT_BOARD_REVIEW_STAGE_EXECUTION,
  DEFAULT_TEXT_GENERATION_MODEL,
  ThreadId,
  type BoardReviewFinding,
  type BoardSettings,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";

import {
  cardMoved,
  codexStep,
  makeBoardCard,
  NOW,
  readyWorktree,
  settingsWith,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const settleTargets = (commands: ReadonlyArray<OrchestrationCommand>): ReadonlyArray<string> =>
  commands.flatMap((command) =>
    command.type === "thread.settle" ? [String(command.threadId)] : [],
  );

// Review settings that auto-run the loop: the review stage entry auto-executes
// its phases and auto-advances on convergence, on the same provider the build
// step uses so the phase model resolves without a fallback.
const reviewSettings = (): BoardSettings => {
  const base = settingsWith({ building: [codexStep], globalMaxConcurrent: 3 });
  return {
    ...base,
    pipeline: {
      ...base.pipeline,
      [BOARD_SEED_STAGE_IDS.review]: {
        ...DEFAULT_BOARD_REVIEW_STAGE_EXECUTION,
        autoExecute: true,
        autoAdvance: true,
        model: { instanceId: codexStep.providerInstanceId, model: DEFAULT_TEXT_GENERATION_MODEL },
      },
    },
  };
};

const nitpick: BoardReviewFinding = {
  id: "f1",
  severity: "nitpick",
  file: "src/x.ts",
  line: 1,
  title: "a nit",
  detail: "",
};

// A review-phase completion carrying its structured payload — `stepCompleted`
// hardcodes the Building step id and a null payload, so the review loop needs
// its own builder to record findings the executor reads.
const reviewPhaseCompleted = (
  cardId: BoardCardId,
  stepId: string,
  findings: ReadonlyArray<BoardReviewFinding>,
  sequence: number,
): OrchestrationEvent =>
  ({
    type: "board.card-step-completed",
    sequence,
    payload: {
      cardId,
      completion: {
        cardId,
        stepId,
        outcome: "succeeded",
        summary: `did ${stepId}`,
        payload: JSON.stringify({ reviewedSha: "sha-review", findings }),
        threadId: null,
        completedAt: NOW,
      },
    },
  }) as unknown as OrchestrationEvent;

const buildLink = {
  threadId: ThreadId.make("thread-build-1"),
  role: "build",
  linkedAt: NOW,
  tombstonedAt: null,
};

// ── Rule 1: graduation settles the outgoing stage's thread ───────────────────
// The card graduates Building → Code review carrying its finished build thread;
// the reactor consumes that `card-moved` (the loop-back the engine double models
// via `pumpDomain`) and settles the thread the card is done with. The card keeps
// the link — only the inbox is cleared.
it.effect("a forward stage move settles the thread the card is finished with", () =>
  withGovernor(
    {
      board: {
        cards: [
          {
            ...makeBoardCard({
              id: "card-1",
              stage: "review",
              orderKey: "m",
              worktree: readyWorktree("card-1"),
            }),
            threadLinks: [buildLink],
          },
        ],
        nextCardNumberByProject: {},
      },
      settings: reviewSettings(),
    },
    ({ pumpDomain, board, commands }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("card-1");
        const movedCard = {
          ...makeBoardCard({
            id: "card-1",
            stage: "review",
            orderKey: "m",
            worktree: readyWorktree("card-1"),
          }),
          threadLinks: [buildLink],
        };
        yield* pumpDomain(cardMoved(movedCard, "building", "review", 1));
        assert.ok(
          settleTargets(yield* commands).includes(String(buildLink.threadId)),
          "the build thread was settled on graduation",
        );
        // The link survives the settle — the card keeps its tab.
        assert.ok(
          (yield* board).cards
            .find((card) => card.id === id)
            ?.threadLinks.some(
              (entry) => entry.threadId === buildLink.threadId && entry.tombstonedAt === null,
            ),
          "the settled thread stays linked to the card",
        );
      }),
  ),
);

// ── Rule 1: a backward move is a reopen and settles nothing ──────────────────
it.effect("a backward stage move (a reopen) settles no thread", () =>
  withGovernor(
    {
      board: {
        cards: [
          {
            ...makeBoardCard({ id: "card-1", stage: "review", orderKey: "m" }),
            threadLinks: [
              {
                threadId: ThreadId.make("thread-review-1"),
                role: "review@1",
                linkedAt: NOW,
                tombstonedAt: null,
              },
            ],
          },
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ pumpDomain, commands }) =>
      Effect.gen(function* () {
        // Drag the card back from Code review to the manual Ready column.
        const reopened = {
          ...makeBoardCard({ id: "card-1", stage: "ready", orderKey: "m" }),
          threadLinks: [
            {
              threadId: ThreadId.make("thread-review-1"),
              role: "review@1",
              linkedAt: NOW,
              tombstonedAt: null,
            },
          ],
        };
        yield* pumpDomain(cardMoved(reopened, "review", "ready", 1));
        assert.deepStrictEqual(settleTargets(yield* commands), []);
      }),
  ),
);

// ── Rule 2: the review loop settles each finished phase as it advances ───────
it.effect("the review loop settles a finished phase's thread as it moves to the next phase", () =>
  withGovernor(
    {
      board: {
        cards: [
          makeBoardCard({
            id: "card-1",
            stage: "review",
            orderKey: "m",
            worktree: readyWorktree("card-1"),
          }),
        ],
        nextCardNumberByProject: {},
      },
      settings: reviewSettings(),
    },
    ({ pumpDomain, board, commands }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("card-1");
        // Enter Code review — the loop auto-spawns review@1.
        yield* pumpDomain(
          cardMoved(
            makeBoardCard({
              id: "card-1",
              stage: "review",
              orderKey: "m",
              worktree: readyWorktree("card-1"),
            }),
            "building",
            "review",
            1,
          ),
        );
        const review1 = (yield* board).cards
          .find((card) => card.id === id)
          ?.threadLinks.find((entry) => entry.role === "review@1" && entry.tombstonedAt === null);
        assert.ok(review1, "review@1 spawned a thread");
        const review1Thread = String(review1.threadId);

        // review@1 finishes with a nitpick → the loop runs triage@1, and moving
        // to that next step settles review@1's thread (Rule 2). The card is still
        // in review (mid-loop), so this settle is the intra-stage advance, not
        // the graduation sweep.
        yield* pumpDomain(reviewPhaseCompleted(id, "review@1", [nitpick], 2));
        assert.ok(
          settleTargets(yield* commands).includes(review1Thread),
          "review@1's thread was settled as the loop moved to triage@1",
        );
        // The loop genuinely moved to the next step within the stage.
        assert.ok(
          (yield* board).cards
            .find((card) => card.id === id)
            ?.threadLinks.some((entry) => entry.role === "triage@1" && entry.tombstonedAt === null),
          "triage@1 was spawned as the next phase",
        );
      }),
  ),
);
