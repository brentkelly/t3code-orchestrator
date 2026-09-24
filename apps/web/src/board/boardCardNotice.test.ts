/**
 * T3o card header notice slot (T3O-45). The bug: a card whose auto-merge had
 * given up wore `Needs a human` on the left AND `Merge needs you` on the right —
 * the same claim twice, in the same amber, ~23px wider than the 268px column, so
 * the second chip hung off the card. The rule is one notice, ranked.
 */
import { describe, expect, it } from "vite-plus/test";

import type { BoardAutoMergePill } from "./boardAutoMergeHold";
import type { BoardConflictFixInfo } from "./boardConflictFix";
import {
  boardCardNoPullRequest,
  boardCardNotice,
  type BoardCardNoticeAttention,
} from "./boardCardNotice";

const attention = (
  overrides: Partial<BoardCardNoticeAttention> = {},
): BoardCardNoticeAttention => ({
  reason: "held",
  tone: "warning",
  label: "Needs a human",
  tooltip: "This stage stopped without moving the card on",
  ...overrides,
});

const question = attention({
  reason: "input",
  tone: "attention",
  label: "Input needed",
  tooltip: "A thread on this card is waiting on your answer",
});

const mergeGaveUp: BoardAutoMergePill = {
  label: "Merge needs you",
  tooltip: "Auto-merge stopped. Open the card to see what the forge said.",
  icon: "alert",
};

const mergeRetrying: BoardAutoMergePill = {
  label: "Merge held · 12m",
  tooltip: "The forge refused the merge. The board is retrying — nothing is needed from you.",
  icon: "clock",
};

const conflicts: BoardConflictFixInfo = {
  label: "Conflicts",
  tooltip: "The merge hit conflicts. A thread is resolving them — nothing is needed from you.",
  headline: "Resolving conflicts against t3o",
  detail: "The merge holds until the thread finishes.",
};

const notice = (input: Partial<Parameters<typeof boardCardNotice>[0]>) =>
  boardCardNotice({
    attention: null,
    conflictFix: null,
    autoMergeHold: null,
    publishFailed: false,
    noPullRequestAtMerge: false,
    blocked: false,
    dependencyCount: 0,
    ...input,
  });

describe("boardCardNotice", () => {
  it("says nothing when the card has nothing to say", () => {
    expect(notice({})).toBeNull();
  });

  it("names the merge rather than repeating the generic chip beside it", () => {
    // The screenshot on the card: both of these rendered, and `Needs a human`
    // is exactly what `Merge needs you` says with less information.
    expect(notice({ attention: attention(), autoMergeHold: mergeGaveUp })).toEqual({
      kind: "auto-merge",
      pill: mergeGaveUp,
    });
  });

  it("still lets a merge that is only waiting outrank the generic chip", () => {
    // `Merge held · 12m` also says "nothing is needed from you", which the
    // generic chip actively contradicts — so the specific one wins here too.
    expect(notice({ attention: attention(), autoMergeHold: mergeRetrying })).toEqual({
      kind: "auto-merge",
      pill: mergeRetrying,
    });
  });

  it("gives a pending question the slot over every merge state", () => {
    // One click from being answered. Burying it behind a merge pill strands
    // the answer — the same carve-out `boardCardAttention` gives it.
    expect(
      notice({ attention: question, autoMergeHold: mergeGaveUp, conflictFix: conflicts }),
    ).toEqual({ kind: "attention", attention: question });
  });

  it("gives a running conflict fix the slot over a hold", () => {
    // The server never records both; a running agent is the more specific
    // claim if they somehow collide.
    expect(notice({ conflictFix: conflicts, autoMergeHold: mergeGaveUp })).toEqual({
      kind: "conflicts",
      fix: conflicts,
    });
  });

  it("keeps the attention chip when no merge state is competing for the slot", () => {
    const stalled = attention({ reason: "stalled", label: "Stalled" });
    expect(notice({ attention: stalled })).toEqual({ kind: "attention", attention: stalled });
  });

  it("names a failed publish on a Done card", () => {
    expect(notice({ publishFailed: true })).toEqual({ kind: "publish-failed" });
  });

  it("ranks the dependency gate last, because the meta row still carries it", () => {
    expect(
      notice({
        attention: attention({ reason: "paused", tone: "neutral", label: "Paused" }),
        blocked: true,
        dependencyCount: 2,
      })?.kind,
    ).toBe("attention");
    expect(notice({ blocked: true, dependencyCount: 2 })).toEqual({
      kind: "blocked",
      dependencyCount: 2,
    });
  });

  it("shows the gate once nothing else is competing, at any dependency count", () => {
    expect(notice({ blocked: true, dependencyCount: 1 })).toEqual({
      kind: "blocked",
      dependencyCount: 1,
    });
    // Not blocked is not a notice, however many dependencies the card carries.
    expect(notice({ blocked: false, dependencyCount: 5 })).toBeNull();
  });
});

// T3o (T3O-48): a card parked at Ready for merge with no pull request goes
// nowhere on its own, and nothing on the card face said so — the bug was a
// human staring at "Ready for merge" with no PR link and no Merge button.
describe("the no-pull-request notice", () => {
  it("names the missing pull request rather than the generic chip beside it", () => {
    // `Needs a human` is exactly what `No PR` says with less information —
    // the same relationship the merge pills have to it.
    expect(notice({ attention: attention(), noPullRequestAtMerge: true })).toEqual({
      kind: "no-pull-request",
    });
  });

  it("yields to a conflict fix and to the auto-merge hold, which are more specific", () => {
    // Both of those describe a card that HAS a pull request, so if either is
    // standing, "no pull request" is not the thing to say.
    expect(notice({ conflictFix: conflicts, noPullRequestAtMerge: true })).toEqual({
      kind: "conflicts",
      fix: conflicts,
    });
    expect(notice({ autoMergeHold: mergeRetrying, noPullRequestAtMerge: true })).toEqual({
      kind: "auto-merge",
      pill: mergeRetrying,
    });
  });

  it("yields to a thread's pending question, which is one click from an answer", () => {
    expect(notice({ attention: question, noPullRequestAtMerge: true })).toEqual({
      kind: "attention",
      attention: question,
    });
  });

  it("outranks the dependency gate, whose fact survives on the meta row", () => {
    expect(notice({ noPullRequestAtMerge: true, blocked: true, dependencyCount: 2 })).toEqual({
      kind: "no-pull-request",
    });
  });
});

describe("boardCardNoPullRequest", () => {
  const settled = { atMergeStage: true, hasPr: false };

  it("flags a card parked at the merge stage with nothing to merge", () => {
    expect(boardCardNoPullRequest(settled)).toBe(true);
  });

  it("says nothing at any other stage", () => {
    // A card in Code review with no pull request is also wrong, but it has a
    // running step and its own notices, and the window before the build opens
    // one is legitimate.
    expect(boardCardNoPullRequest({ ...settled, atMergeStage: false })).toBe(false);
  });

  it("says nothing once the card has a pull request, whatever its state", () => {
    // `hasPr` is true for a merged PR too, which is the point: a card that
    // merged and is waiting to be moved on has nothing missing.
    expect(boardCardNoPullRequest({ ...settled, hasPr: true })).toBe(false);
  });

  it("waits out the settle grace a card that has only just stopped", () => {
    // Arriving at Ready for merge leaves the card briefly PR-less while the
    // stage-move lookup is still in flight. A chip that appears for a second
    // and vanishes is worse than no chip.
    const stoppedAt = "2026-09-21T12:00:00.000Z";
    expect(
      boardCardNoPullRequest({
        ...settled,
        threadIdleSince: stoppedAt,
        now: Date.parse(stoppedAt) + 1_000,
      }),
    ).toBe(false);
    expect(
      boardCardNoPullRequest({
        ...settled,
        threadIdleSince: stoppedAt,
        now: Date.parse(stoppedAt) + 6_000,
      }),
    ).toBe(true);
  });

  it("fails open when there is no evidence the stop was fresh", () => {
    // Same rule the attention chips follow: a card whose thread has never
    // finished a turn, or a caller with no clock, has nothing to wait out.
    expect(boardCardNoPullRequest({ ...settled, now: Date.now() })).toBe(true);
    expect(boardCardNoPullRequest({ ...settled, threadIdleSince: "2026-09-21T12:00:00Z" })).toBe(
      true,
    );
  });
});
