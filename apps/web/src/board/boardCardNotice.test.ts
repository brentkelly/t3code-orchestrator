/**
 * T3o card header notice slot (T3O-45). The bug: a card whose auto-merge had
 * given up wore `Needs a human` on the left AND `Merge needs you` on the right —
 * the same claim twice, in the same amber, ~23px wider than the 268px column, so
 * the second chip hung off the card. The rule is one notice, ranked.
 */
import { describe, expect, it } from "vite-plus/test";

import type { BoardAutoMergePill } from "./boardAutoMergeHold";
import type { BoardConflictFixInfo } from "./boardConflictFix";
import { boardCardNotice, type BoardCardNoticeAttention } from "./boardCardNotice";

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
