---
id: t3o-28
title: Sub-boards — the split lifecycle
phase: 3
prerequisites: [t3o-23, t3o-24, t3o-27]
---

# The split lifecycle

t3o-23 fused two human decisions into one click. Approving a split materialises
the children **and** shoves the parent into Building, where D4's derived-stage
freeze then pins it — so "yes, this is the right split" and "start building it"
are the same gesture, and there is no way to say the first without the second.
The card jumps a stage the human never asked for, its Approve split button is
replaced by nothing (the freeze refuses every move), and the sub-board sits
there with four children on the floor waiting to be dragged one at a time.

The split should read the way every other stage reads: approve the plan, then
begin the build, and the build starts the work.

> The related shell-snapshot bug — `listBoardCardShellRows` never selected
> `parent_card_id`, so the first reconnect flattened every sub-board back onto
> the root board and re-lit the parent's amber "Needs approval" — is fixed
> separately and is a prerequisite for testing any of this by hand.

## Goal

Approval is stage-neutral. The parent walks Planning → Ready → Building on the
ordinary forward button, and its arrival in Building is what starts the
sub-board — first the children nothing blocks, then each one their finishing
unblocks, until the last lands and the parent goes to review.

## Scope

**In**

1. `board.plans.approve` stops moving the parent.
2. The derived-stage freeze becomes a ceiling: a parent with unfinished children
   moves freely up to and including the build-role stage, never past it.
3. A reactor cascade: the parent entering build starts every unblocked child,
   and each child finishing starts whatever it unblocked.
4. The parent's modal opens on the Plans pane, with its own thread locked until
   the review stage.

**Out**

- The approve gate itself (t3o-27): what makes a split pending, the amber
  "Needs approval" state, and the refusal to advance past planning while a
  split is unapproved are all unchanged.
- Child → child merge, sync-base and the review→merge crossing gate (t3o-24).
  The cascade only ever moves a child from the floor into build; everything
  after that is the machinery already shipped.
- Cross-project or nested splits. Depth stays 1 (D12).

## Locked decisions

### D1 — Approval materialises; it does not advance

`board.plans.approve` emits the children's `board.card-created` events and the
`board.plans-approved` record, and **no `board.card-moved`**. The parent stays
exactly where the human left it, which is normally the plan-role stage. This
supersedes t3o-23 D4's "the parent's crossing into Building is part of the same
human act": it is two acts, and the second one is a button the human presses.

The dependency check the approve path runs today goes with the move that
justified it — approving a split is not a build boundary crossing, and the
ordinary D11 gate already refuses the parent's later entry into build with unmet
dependencies, at the moment that becomes true. `blocked` is therefore left
alone rather than cleared. Everything else the gate refuses stays: a live step,
an existing live split, fewer than two plans, a parent already past build, a
plan-graph cycle, a childless nested card.

> **Amended in flight:** "a live step" turned out to wedge the gate shut. The
> planning interview is itself a live step that only the forward move settles,
> and D2 of t3o-27 refuses that move until the split is approved — so every
> split proposed by a planning agent was unapprovable. The refusal now carves
> out the plan-role stage: a plan step writes plans, not the branch, and since
> D1 above approval no longer starts anything. A live step at any other stage
> is refused exactly as before.

The visible consequence needs no new code: `boardCardPendingSplit` goes false
the moment the children exist, so the amber state clears and the modal's
"Approve split" button gives way to the ordinary forward action — "Move to
Ready", then "Begin build".

### D2 — The freeze is a ceiling, not a pin

Today a parent with unfinished children cannot move **at all** (override
included), with one carve-out for the t3o-24 regression back to build. That
pin only made sense while approval parked the parent in Building itself.

The new rule: while any child is unfinished, the parent moves freely — forward,
backward, reorder — **up to and including the build-role stage**, and cannot
advance past it. The half of D4 worth keeping is the review boundary: a
parent's review describes an integration branch, and that description is a lie
while a child is still working. The half that pinned the parent to one stage
goes. The t3o-24 D4 regression carve-out dissolves into the general rule
instead of being special-cased against it.

Moving a parent backward out of build with children mid-flight does not stop
them; it says the supervising card is not ready, and the running children are
visible in its sub-board. The cascade will not start anything new from there
(D3), which is the useful half of "backing off".

### D3 — Entering build starts the sub-board, and keeps starting it

The parent's arrival at the build-role stage is the Begin build for the whole
split. The reactor then moves every live child that is sitting on the
materialisation floor and whose sibling dependencies are all done into the
build stage. Each one rides an ordinary `board.card.move`, so `handleCardMoved`
does the rest: step selection, worktree provisioning off the integration
branch, thread spawn, slots, queueing. A cascaded child is indistinguishable
from a dragged one.

The cascade re-runs on three triggers, all of which already reach the reactor:

- the parent arriving at the build stage (`handleCardMoved`, including the
  t3o-24 regression back to build, so a corrected parent restarts what is
  unblocked);
- a child reaching the done-role stage or being archived — finishing #1 starts
  #2 and #3 with no human in between;
- a child being deleted, which can unblock a sibling the same way.

It never acts on: a parent before the build stage or archived, a child already
past the floor (a human parked it there deliberately), a child with an
unfinished sibling dependency — which the D11 gate would refuse anyway, so the
cascade skips it rather than teaching the rule by refusal.

D18's "approving a split is one human act and cannot fan out into N running
agents" stands unchanged and is the reason `handleCardCreated` still refuses to
kick off a materialised child. The fan-out has simply moved to the gesture that
means it: Begin build on the parent.

The concurrency governor needs nothing. Five children cascading into Building
queue five steps against the same slots as five drags would, and the queue
drains in the same order.

### D4 — A split parent's own thread is locked until review

Straight from the prototype (`t3o.dc.html`: `threadLocked = isParent &&
stageIndex(status) < review`, `pane = threadLocked ? "plans" : "thread"`). A
card with live children, sitting before the review-role stage, opens on the
**Plans** pane and its Thread pill is disabled. A split parent has no build
conversation of its own — its build is the sub-board — so the thread pane can
only show a dormant planning thread, and the pane that matters is the plan list
with its child chips and drill-in.

At the review-role stage the parent's own thread wakes up: the final review
runs on the integration branch, in the parent's thread, and the default returns
to the ordinary `initialBoardCardPane` rule. A childless card is untouched at
every stage.

## Acceptance criteria

1. Approving a split leaves the parent's stage exactly as it was; the activity
   feed shows `plans-approved` with no `card-moved` beside it.
2. Immediately after approval the parent's amber "Needs approval" state is gone
   and its modal shows the ordinary forward button, which advances it a stage
   at a time.
3. A parent with unfinished children moves forward, backward and reorders
   across every stage up to and including build; a move past build is refused
   and names the unfinished children. A drag (`override`) does not bypass it.
4. Moving the parent into build moves every dependency-free child from the
   floor into build and starts each one; a child with an unmet sibling
   dependency stays on the floor.
5. A child reaching Done (or being archived, or deleted) moves whatever it
   unblocked into build and starts it; when the last child finishes, the parent
   advances past build exactly as it does today.
6. A parent with live children opens its modal on the Plans pane with the
   Thread pill disabled, at every stage before review; from the review stage on,
   the thread is available and opens by default.
7. A card that never split, and a child card, behave exactly as they do today.
8. `pnpm test` passes.

## Files

| File | Change |
| --- | --- |
| `apps/server/src/board/decider.ts` | `board.plans.approve` drops the parent move and its dependency gate; the freeze in `board.card.move` becomes a past-build ceiling |
| `apps/server/src/board/supervisorReactor.ts` | `cascadeUnblockedChildren`, wired into `handleCardMoved` (parent into build, child into done) and the archive/delete arms; `advanceParentIfChildrenDone` and `regressParentIfChildLeftDone` re-read against the new ceiling |
| `apps/web/src/board/BoardCardDetailView.tsx` | `isBoardCardThreadLocked`; `initialBoardCardPane` takes the live-child count; Plans default and disabled Thread pill for a split parent before review (the panel already holds `detail.children`, so no plumbing) |
| `apps/server/src/board/decider.subboard.test.ts` | approval is stage-neutral; the ceiling matrix replaces the pin matrix |
| `apps/server/src/board/decider.board.test.ts` | `board.card.move` becomes the ONLY command that may emit a `board.card-moved` |
| `apps/web/src/board/BoardCardDetailView.test.tsx` | the pane lock and its release at review |
| `apps/server/src/board/subBoardSupervisor.test.ts` | the cascade: parent into build, sibling unblocking, the parked-child and blocked-child refusals |
| `apps/server/src/board/syncBaseSupervisor.test.ts` | parents no longer arrive in build by approval |
