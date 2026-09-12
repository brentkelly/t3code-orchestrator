---
id: t3o-24
title: Sub-boards — the sync-base step and the stale-sibling final round
phase: 3
prerequisites: [t3o-23, t3o-20]
---

# Sub-boards — sync-base

t3o-23 ships sub-boards with one known staleness gap. Sibling plan cards run in parallel from the
same integration-branch base, so every child merge makes its running siblings stale. The core
slice guarantees only that a child *starting* later cuts from a base containing merged siblings
(the post-merge local fast-forward); a child already *running* keeps its original base. Two
consequences, both called out in D12:

1. A stale child's PR into the integration branch can conflict, surfacing today as a merge-time
   refusal handled by the one-shot conflict-fix thread — workable, but late, unreviewed pressure
   at the worst moment.
2. Worse and quieter: a child whose review rounds converged on a diff against the *old* base can
   merge cleanly while the combined result was never reviewed. "The reviewed diff is the merged
   diff" fails silently.

D12's answer, verbatim: a **`sync-base` step** enqueued at a stage boundary — never by writing
into a worktree while an agent is live in it — and, if the base moved since the last review round
started, **one final single-reviewer round** on the rebased diff before merge.

## Goal

A child card whose base advanced underneath it is rebased by a dedicated step at its next stage
boundary, and no child merges a diff that was not reviewed against the base it merges into.

## Scope

**In**

1. `baseTipAtRoundStart` recorded on the card when a review round begins.
2. Staleness detection at the review→merge boundary (and on merge click).
3. The `sync-base` step: an agent-driven, build-mode step in the child's worktree that rebases
   onto the current base tip and force-pushes-with-lease its own branch.
4. The final single-reviewer round on the rebased diff, riding the existing review-loop
   machinery as a one-round re-entry.
5. The parent-regression edge: a child leaving Done while the parent has advanced.

**Out**

- Continuous rebasing while a child builds (only stage boundaries — D12's "never write into a
  live worktree" is absolute).
- Merge-queue semantics, auto-serialisation of sibling merges, or optimistic train builds.
- Any change for top-level cards: their base (the default branch) moves too, but that is the
  universal condition of trunk development, reviewed at the human's discretion. Sub-board
  siblings are *created* to collide; top-level cards are not.

## Locked decisions

### D1 — Staleness is measured, not assumed

When the review-loop executor plans the first phase of a round, the reactor records the current
tip of the card's recorded `baseRefName` (one `rev-parse` in the project root) onto the run row as
`baseTipAtRoundStart`. Staleness at any later boundary is `tip(baseRefName) !==
baseTipAtRoundStart` — no forge call, no merge-base walk. A base that moved and moved back is not
stale; content, not history, is what review coverage is about, and the tip equality is the cheap
conservative proxy.

### D2 — sync-base is an agent step at the review→merge boundary

The check runs when the child would cross review → merge (auto-advance or drag) and again on the
merge click (the human may have parked the card). If stale, the crossing is intercepted — the card
stays in review — and a **`sync-base` step** is enqueued: build mode (it holds the worktree and a
slot; it writes), a compiled-in prompt, the stage's model. The agent rebases the card branch onto
the fetched base tip, resolves conflicts as its whole job, runs the project's checks, and
force-pushes with lease. `board_complete_step` as ever; failure enters the standard recovery
ladder and ultimately the human question (D13).

*Why an agent and not server-side `git rebase`:* a conflicted rebase needs judgment; a mechanical
half-rebase left in a worktree is the worst state on the board. The no-conflict case costs one
cheap agent turn. This is the same reasoning that put PR lifecycle in the review agent's hands
(t3o-20).

*Why intercept the crossing rather than enqueue on entry to merge:* the merge-role stage's
meaning is "reviewed and ready"; a card that still needs a rebase and a round is neither.

### D3 — One single-reviewer round on the rebased diff, then merge

After a successful sync-base, if any review round had already run, the executor re-enters the
review loop for **exactly one round with the review phase only** — no triage, no adjudicate
budget: blocking findings send the card through the normal triage machinery of a full round
(the loop already knows how); a clean pass completes and the crossing proceeds. `rounds` budget
and per-card overrides are not consumed by this round — it is a gate, not a negotiation.

The executor owns this in `planNext` (a `sync` phase joining the round state machine), keeping
D15's rule intact: the reactor learns nothing.

### D4 — The parent never advances past live children, including regressions

t3o-23 advances the parent when the last child finishes. The reverse — a child dragged back out
of Done while the parent sits in review or beyond — currently leaves the parent ahead of reality.

**Decision:** the reactor's child-transition watcher gains the mirror check: a child leaving the
done-role stage while the parent is past the build-role stage moves the parent **back to the
build-role stage** (ordinary move, the freeze re-engages) and interrupts any live parent review
step through the existing abandon path. The parent's review, when it re-runs, starts a fresh
round against the changed integration branch — which is exactly D1–D3 applied one level up, and
falls out of the same recorded-tip machinery because the parent's review rounds record
`baseTipAtRoundStart` too (its base is the default branch; the *head* moving is what the
round-re-entry already handles).

## Acceptance criteria

1. A child whose base did not move crosses review → merge with no sync step and no extra round.
2. A child whose sibling merged mid-review is intercepted at the crossing: sync-base runs in its
   worktree, the branch is rebased and lease-pushed, and one review round runs on the rebased
   diff before the crossing completes.
3. The merge click on a parked stale card triggers the same interception instead of merging.
4. A conflicted rebase that the agent cannot complete follows the recovery ladder to a human
   question; the worktree is never left mid-rebase by the machinery.
5. The extra round does not consume the card's `rounds` budget or overrides.
6. A child dragged out of Done regresses its parent to the build-role stage and abandons the
   parent's in-flight review step; the parent re-advances when the child finishes again.
7. `baseTipAtRoundStart` survives replay/rehydration identically.

## Files

| File | Change |
| --- | --- |
| `packages/contracts/src/board.ts` | `baseTipAtRoundStart` on the run row; `sync` phase vocabulary; sync-base prompt |
| `apps/server/src/board/reviewLoopExecutor.ts` | sync phase + single-round re-entry in `planNext` |
| `apps/server/src/board/supervisorReactor.ts` | tip recording; crossing interception; parent regression |
| `apps/server/src/board/decider.ts` | run-row field; intercepted-move bookkeeping |
| Tests | executor round-machine cases; reactor interception + regression; replay |
