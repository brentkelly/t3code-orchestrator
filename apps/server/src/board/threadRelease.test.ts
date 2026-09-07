/**
 * The release rule (t3o-13): which of a card's threads the board is finished
 * with. Pure — the retrying that turns a release into a settled thread is the
 * reactor's, and is proved in `threadSettle.test.ts`.
 */
import { assert, describe, it } from "@effect/vitest";

import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  BoardStageId,
  ProjectId,
  ThreadId,
  type BoardCard,
  type BoardCardStepState,
  type BoardCardThreadLink,
  type BoardState,
} from "@t3tools/contracts";

import { boardReleasedThreadIds } from "./threadRelease.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const link = (threadId: string, role: string, tombstoned = false): BoardCardThreadLink => ({
  threadId: ThreadId.make(threadId),
  role,
  linkedAt: NOW,
  tombstonedAt: tombstoned ? NOW : null,
});

const card = (input: {
  readonly stage: string;
  readonly links: ReadonlyArray<BoardCardThreadLink>;
  readonly archived?: boolean;
}): BoardCard =>
  ({
    id: BoardCardId.make("card-1"),
    key: "T-1",
    cardNumber: 1,
    projectId: ProjectId.make("project-1"),
    labels: [],
    stage: BoardStageId.make(input.stage),
    orderKey: "m",
    title: "Card",
    briefRef: null,
    dependsOn: [],
    parentCardId: null,
    sourcePlanId: null,
    threadLinks: input.links,
    attachments: [],
    externalRef: null,
    humanInLoop: null,
    reviewOverrides: null,
    modelOverrides: null,
    worktree: null,
    pullRequest: null,
    pullRequestHistory: [],
    pullRequestFloor: null,
    blocked: false,
    archivedAt: input.archived === true ? NOW : null,
    createdAt: NOW,
    updatedAt: NOW,
  }) as unknown as BoardCard;

const stepState = (input: {
  readonly stepId: string;
  readonly threadId: string | null;
  readonly status: BoardCardStepState["status"];
}): BoardCardStepState =>
  ({
    cardId: BoardCardId.make("card-1"),
    stepId: input.stepId,
    stepLabel: null,
    stageLabel: null,
    attempt: 1,
    stallCount: 0,
    lastNudgeAt: null,
    prompt: "",
    providerInstanceId: "codex",
    model: "model",
    mode: "build",
    runtimeMode: "approval-required",
    humanInLoop: false,
    maxAttempts: 3,
    timeoutMs: 1_000,
    baseTipAtRoundStart: null,
    threadId: input.threadId === null ? null : ThreadId.make(input.threadId),
    lastError: null,
    status: input.status,
    awaitingReason: "question",
    slotHeld: false,
    forceStart: false,
    startedAt: null,
    updatedAt: NOW,
  }) as unknown as BoardCardStepState;

const board = (input: {
  readonly card: BoardCard;
  readonly step?: BoardCardStepState;
}): BoardState =>
  ({
    cards: [input.card],
    nextCardNumberByProject: {},
    ...(input.step === undefined ? {} : { stepStates: [input.step] }),
  }) as unknown as BoardState;

const released = (state: BoardState, abandoned?: ReadonlySet<string>): ReadonlyArray<string> =>
  boardReleasedThreadIds(state, abandoned).map(String);

describe("boardReleasedThreadIds", () => {
  it("keeps the running step's own thread and releases every earlier one", () => {
    const state = board({
      card: card({
        stage: String(BOARD_SEED_STAGE_IDS.review),
        links: [
          link("thread-plan", String(BOARD_SEED_STAGE_IDS.planning)),
          link("thread-build", String(BOARD_SEED_STAGE_IDS.building)),
          link("thread-r1", "review@1"),
          link("thread-r2", "review@2"),
        ],
      }),
      step: stepState({ stepId: "review@2", threadId: "thread-r2", status: "running" }),
    });
    assert.deepStrictEqual(released(state), ["thread-plan", "thread-build", "thread-r1"]);
  });

  // The whole point of `awaiting-input` and `stalled` is that a human is being
  // asked for something. Settling one would hide the request.
  it.each(["awaiting-input", "stalled"] as const)(
    "keeps a thread whose step is %s",
    (status: "awaiting-input" | "stalled") => {
      const state = board({
        card: card({
          stage: String(BOARD_SEED_STAGE_IDS.planning),
          links: [link("thread-plan", String(BOARD_SEED_STAGE_IDS.planning))],
        }),
        step: stepState({
          stepId: String(BOARD_SEED_STAGE_IDS.planning),
          threadId: "thread-plan",
          status,
        }),
      });
      assert.deepStrictEqual(released(state), []);
    },
  );

  // A human-in-the-loop stage never auto-advances, so its finished run sits in
  // its own column waiting to be dragged — and its thread is where the human
  // picks the work back up.
  it("keeps a succeeded step's thread while the card is still in that stage", () => {
    const state = board({
      card: card({
        stage: String(BOARD_SEED_STAGE_IDS.building),
        links: [link("thread-build", String(BOARD_SEED_STAGE_IDS.building))],
      }),
      step: stepState({
        stepId: String(BOARD_SEED_STAGE_IDS.building),
        threadId: "thread-build",
        status: "succeeded",
      }),
    });
    assert.deepStrictEqual(released(state), []);
  });

  // The step row outlives the stage: a card that graduates into a column with
  // nothing to auto-execute keeps its old row untouched.
  it("releases a finished step's thread once the card has moved past its stage", () => {
    const state = board({
      card: card({
        stage: String(BOARD_SEED_STAGE_IDS.merge),
        links: [link("thread-build", String(BOARD_SEED_STAGE_IDS.building))],
      }),
      step: stepState({
        stepId: String(BOARD_SEED_STAGE_IDS.building),
        threadId: "thread-build",
        status: "succeeded",
      }),
    });
    assert.deepStrictEqual(released(state), ["thread-build"]);
  });

  // A backward drag is not special: the card is not in that stage any more. If
  // it comes back, the thread comes back with it — a settled thread un-settles
  // as soon as its session is alive again.
  it("releases the threads of the stage a card was dragged backwards out of", () => {
    const state = board({
      card: card({
        stage: String(BOARD_SEED_STAGE_IDS.ready),
        links: [link("thread-r1", "review@1"), link("thread-r2", "review@2")],
      }),
      step: stepState({ stepId: "review@2", threadId: "thread-r2", status: "succeeded" }),
    });
    assert.deepStrictEqual(released(state), ["thread-r1", "thread-r2"]);
  });

  // `spawnStepThread` links the thread BEFORE `board.card.admit-step` records it
  // on the row, so a pass landing in that window sees a link with no thread on
  // the step. Matching the link's ROLE is what stops it settling a thread that
  // is about to run.
  it("keeps a just-linked thread whose step has not recorded it yet", () => {
    const state = board({
      card: card({
        stage: String(BOARD_SEED_STAGE_IDS.building),
        links: [link("thread-build", String(BOARD_SEED_STAGE_IDS.building))],
      }),
      step: stepState({
        stepId: String(BOARD_SEED_STAGE_IDS.building),
        threadId: null,
        status: "pending",
      }),
    });
    assert.deepStrictEqual(released(state), []);
  });

  it("releases every thread on a card with no step at all", () => {
    const state = board({
      card: card({
        stage: String(BOARD_SEED_STAGE_IDS.backlog),
        links: [link("thread-old", String(BOARD_SEED_STAGE_IDS.planning))],
      }),
    });
    assert.deepStrictEqual(released(state), ["thread-old"]);
  });

  it("releases every thread on an archived card, running step and all", () => {
    const state = board({
      card: card({
        stage: String(BOARD_SEED_STAGE_IDS.building),
        archived: true,
        links: [link("thread-build", String(BOARD_SEED_STAGE_IDS.building))],
      }),
      step: stepState({
        stepId: String(BOARD_SEED_STAGE_IDS.building),
        threadId: "thread-build",
        status: "running",
      }),
    });
    assert.deepStrictEqual(released(state), ["thread-build"]);
  });

  // A tombstoned link is a deleted thread's headstone — there is nothing left
  // to settle.
  it("ignores a tombstoned link", () => {
    const state = board({
      card: card({
        stage: String(BOARD_SEED_STAGE_IDS.merge),
        links: [link("thread-dead", String(BOARD_SEED_STAGE_IDS.building), true)],
      }),
    });
    assert.deepStrictEqual(released(state), []);
  });

  // Unlinking a live thread removes the link outright, so the reactor names
  // those itself.
  it("returns an explicitly abandoned thread that no card links any more", () => {
    const state = board({
      card: card({ stage: String(BOARD_SEED_STAGE_IDS.building), links: [] }),
    });
    assert.deepStrictEqual(released(state, new Set(["thread-abandoned"])), ["thread-abandoned"]);
  });

  it("reports a thread once even when it is both derived and abandoned", () => {
    const state = board({
      card: card({
        stage: String(BOARD_SEED_STAGE_IDS.merge),
        links: [link("thread-build", String(BOARD_SEED_STAGE_IDS.building))],
      }),
    });
    assert.deepStrictEqual(released(state, new Set(["thread-build"])), ["thread-build"]);
  });
});
