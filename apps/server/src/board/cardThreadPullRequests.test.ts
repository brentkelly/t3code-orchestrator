import { assert, describe, it } from "@effect/vitest";
import {
  BOARD_SEED_STAGE_IDS,
  CommandId,
  EMPTY_BOARD_STATE,
  EventId,
  ThreadId,
  type BoardCard,
  type BoardCardPullRequest,
  type BoardCardThreadLink,
  type BoardEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  cardThreadPullRequestActions,
  cardThreadPullRequestLinkCommandId,
  syncCardThreadPullRequests,
} from "./cardThreadPullRequests.ts";
import { ThreadCommandRefusedError } from "./ThreadGateway.ts";
import { makeFakeThreadGateway } from "./threadGateway.testkit.ts";
import { makeBoardCard } from "./supervisorHarness.testkit.ts";

const pr = (number: number, url = `https://github.com/acme/repo/pull/${number}`) =>
  ({
    number,
    url,
    state: "open",
    title: `PR ${number}`,
    headBranch: "board/card-1",
    baseRef: "main",
    checkedAt: "2026-01-01T00:00:00.000Z",
  }) satisfies BoardCardPullRequest;

const link = (
  threadId: string,
  role: string,
  extra: Partial<BoardCardThreadLink> = {},
): BoardCardThreadLink => ({
  threadId: ThreadId.make(threadId),
  role,
  linkedAt: "2026-01-01T00:00:00.000Z",
  tombstonedAt: null,
  ...extra,
});

/** A card in Code review with one thread from every kind of step. */
const cardWith = (
  threadLinks: ReadonlyArray<BoardCardThreadLink>,
  overrides: Partial<BoardCard> = {},
): BoardCard => ({
  ...makeBoardCard({ id: "card-1", stage: String(BOARD_SEED_STAGE_IDS.review), orderKey: "m" }),
  threadLinks,
  ...overrides,
});

const everyKindOfThread = [
  link("t-planning", "planning"),
  link("t-build", "building"),
  link("t-review", "review@1"),
  link("t-triage", "triage@1", { retiredAt: "2026-01-01T00:01:00.000Z" }),
  link("t-sync", "sync@1"),
  link("t-ci-fix", "ci-fix@1.1"),
  link("t-ci-agent", "ci@run-1#0"),
  link("t-merge", "merge"),
  link("t-adopted", "linked"),
  link("t-deleted", "review@1", { tombstonedAt: "2026-01-01T00:02:00.000Z" }),
];

const recorded = (
  card: BoardCard,
  transition: "linked" | "unlinked" | "state-changed" | "updated",
  previous?: BoardCardPullRequest,
  eventId = "event-1",
) =>
  ({
    eventId,
    type: "board.card-pull-request-recorded",
    payload: {
      cardId: card.id,
      pullRequest: card.pullRequest,
      transition,
      ...(previous === undefined ? {} : { previous }),
      card,
    },
  }) as unknown as Extract<BoardEvent, { type: "board.card-pull-request-recorded" }>;

const threadLinked = (card: BoardCard, threadId: string) =>
  ({
    eventId: `event-linked-${threadId}`,
    type: "board.card-thread-linked",
    payload: { cardId: card.id, threadId: ThreadId.make(threadId), role: "x", card },
  }) as unknown as Extract<BoardEvent, { type: "board.card-thread-linked" }>;

const summarise = (actions: ReturnType<typeof cardThreadPullRequestActions>["actions"]) =>
  actions.map((action) => `${action.kind} ${action.threadId} #${action.pullRequest.number}`);

describe("cardThreadPullRequestActions", () => {
  it("links a found PR on threads from Code review onwards, never planning, build, adopted or deleted ones", () => {
    const card = cardWith(everyKindOfThread, { pullRequest: pr(7) });
    const { actions } = cardThreadPullRequestActions(EMPTY_BOARD_STATE, recorded(card, "linked"));
    assert.deepEqual(summarise(actions), [
      "link t-review #7",
      "link t-triage #7",
      "link t-sync #7",
      "link t-ci-fix #7",
      "link t-ci-agent #7",
      "link t-merge #7",
    ]);
    assert.deepEqual(actions[0]!.pullRequest, {
      host: "github.com",
      repository: "acme/repo",
      number: 7,
      url: "https://github.com/acme/repo/pull/7",
    });
  });

  it("unlinks a replaced PR before linking the new one", () => {
    const card = cardWith([link("t-review", "review@1")], { pullRequest: pr(8) });
    const { actions } = cardThreadPullRequestActions(
      EMPTY_BOARD_STATE,
      recorded(card, "linked", pr(7)),
    );
    assert.deepEqual(summarise(actions), ["unlink t-review #7", "link t-review #8"]);
  });

  it("unlinks the PR the card lost", () => {
    const card = cardWith([link("t-review", "review@1")], { pullRequest: null });
    const { actions } = cardThreadPullRequestActions(
      EMPTY_BOARD_STATE,
      recorded(card, "unlinked", pr(7)),
    );
    assert.deepEqual(summarise(actions), ["unlink t-review #7"]);
  });

  it("does nothing when only the PR's state or details moved", () => {
    const card = cardWith([link("t-review", "review@1")], { pullRequest: pr(7) });
    for (const transition of ["state-changed", "updated"] as const) {
      const { actions } = cardThreadPullRequestActions(
        EMPTY_BOARD_STATE,
        recorded(card, transition),
      );
      assert.deepEqual(actions, []);
    }
  });

  it("leaves earlier rounds' threads alone; an unstamped link is round 0", () => {
    const roundOne = cardWith(
      [
        link("t-unstamped", "review@1"),
        link("t-round-0", "review@1", { round: 0 }),
        link("t-round-1", "review@1", { round: 1 }),
      ],
      { pullRequest: pr(9), pullRequestHistory: [{ ...pr(7), state: "merged" }] },
    );
    assert.deepEqual(
      summarise(
        cardThreadPullRequestActions(EMPTY_BOARD_STATE, recorded(roundOne, "linked")).actions,
      ),
      ["link t-round-1 #9"],
    );
    const roundZero = cardWith([link("t-unstamped", "review@1")], { pullRequest: pr(7) });
    assert.deepEqual(
      summarise(
        cardThreadPullRequestActions(EMPTY_BOARD_STATE, recorded(roundZero, "linked")).actions,
      ),
      ["link t-unstamped #7"],
    );
  });

  it("links the card's PR on a thread spawned from Code review onwards after it exists", () => {
    const card = cardWith([link("t-build", "building"), link("t-review", "review@2")], {
      pullRequest: pr(7),
    });
    assert.deepEqual(
      summarise(
        cardThreadPullRequestActions(EMPTY_BOARD_STATE, threadLinked(card, "t-review")).actions,
      ),
      ["link t-review #7"],
    );
    assert.deepEqual(
      cardThreadPullRequestActions(EMPTY_BOARD_STATE, threadLinked(card, "t-build")).actions,
      [],
    );
    const noPr = cardWith(card.threadLinks, { pullRequest: null });
    assert.deepEqual(
      cardThreadPullRequestActions(EMPTY_BOARD_STATE, threadLinked(noPr, "t-review")).actions,
      [],
    );
  });

  it("skips a PR whose URL is not a recognised pull request, and says which", () => {
    const card = cardWith([link("t-review", "review@1")], {
      pullRequest: pr(7, "https://example.invalid/not-a-pr"),
    });
    const result = cardThreadPullRequestActions(EMPTY_BOARD_STATE, recorded(card, "linked"));
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.unparsed, ["https://example.invalid/not-a-pr"]);
  });
});

describe("syncCardThreadPullRequests", () => {
  const unlinkCommandId = Effect.succeed(CommandId.make("server:board-pr-unlink:test"));

  it.effect("a redelivered event does not put back a PR a human unlinked", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeThreadGateway();
      const card = cardWith([link("t-review", "review@1")], { pullRequest: pr(7) });
      const sync = syncCardThreadPullRequests({
        board: EMPTY_BOARD_STATE,
        event: recorded(card, "linked"),
        threads: fake.gateway,
        unlinkCommandId,
      });
      yield* sync;
      assert.deepEqual((yield* fake.pullRequestLinks).get("t-review"), ["github.com/acme/repo#7"]);
      yield* fake.humanUnlinkPullRequest(ThreadId.make("t-review"), "github.com/acme/repo#7");
      yield* sync;
      assert.deepEqual((yield* fake.pullRequestLinks).get("t-review"), []);
      const linkIds = (yield* fake.calls).map((call) => call.commandId);
      const id = cardThreadPullRequestLinkCommandId(
        ThreadId.make("t-review"),
        EventId.make("event-1"),
      );
      assert.deepEqual(linkIds, [id, id]);
    }),
  );

  it.effect(
    "the card's PR goes back on its threads when it returns after the board unlinked it",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeThreadGateway();
        const withPr = cardWith([link("t-review", "review@1")], { pullRequest: pr(7) });
        const withoutPr = cardWith(withPr.threadLinks, { pullRequest: null });
        const run = (event: Parameters<typeof syncCardThreadPullRequests>[0]["event"]) =>
          syncCardThreadPullRequests({
            board: EMPTY_BOARD_STATE,
            event,
            threads: fake.gateway,
            unlinkCommandId: Effect.succeed(
              CommandId.make(`server:board-pr-unlink:${event.eventId}`),
            ),
          });
        yield* run(recorded(withPr, "linked", undefined, "event-1"));
        yield* run(recorded(withoutPr, "unlinked", pr(7), "event-2"));
        assert.deepEqual((yield* fake.pullRequestLinks).get("t-review"), []);
        yield* run(recorded(withPr, "linked", undefined, "event-3"));
        assert.deepEqual((yield* fake.pullRequestLinks).get("t-review"), [
          "github.com/acme/repo#7",
        ]);
      }),
  );

  it.effect("a refused link is logged and the other threads still get theirs", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeThreadGateway();
      const card = cardWith([link("t-old-worker", "review@1"), link("t-review", "triage@1")], {
        pullRequest: pr(7),
      });
      yield* syncCardThreadPullRequests({
        board: EMPTY_BOARD_STATE,
        event: recorded(card, "linked"),
        threads: {
          ...fake.gateway,
          linkPullRequest: (input) =>
            input.threadId === "t-old-worker"
              ? Effect.fail(
                  new ThreadCommandRefusedError({
                    command: "linkPullRequest",
                    threadId: input.threadId,
                    detail: "The worker doesn't support this board call.",
                  }),
                )
              : fake.gateway.linkPullRequest(input),
        },
        unlinkCommandId,
      });
      assert.deepEqual((yield* fake.pullRequestLinks).get("t-review"), ["github.com/acme/repo#7"]);
    }),
  );
});
