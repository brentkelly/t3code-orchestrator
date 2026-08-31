---
id: t3o-23
title: Sub-boards — split approval and child-card materialisation
phase: 3
prerequisites: [t3o-08, t3o-13, t3o-15, t3o-16]
---

# Sub-boards — split approval and child-card materialisation

D12 promised that a planning agent could *propose* a split, a human could approve it, and the
approval would materialise real plan cards stacked on an integration branch. Everything around that
promise shipped; the promise itself never did. What exists today:

- `BoardCard.parentCardId` — schema only, hardcoded `null` at creation (`projector.ts:175`).
- `resolveBoardCardBaseRef` (`worktree.ts:78`) — already returns the parent's integration branch
  for a parented card, handles a merged parent via its PR's `baseRef`, and turns a missing parent
  branch into a visible `fail-worktree`.
- The decider's plan-card stage restriction (`decider.ts:663`) and the "keeps sub-board plan cards
  out of the early stages" test.
- `BoardPlan` with `dependsOn` (cycle-validated on ingest), `ordinal`, bodies in `board_plans`,
  written by `board_propose_plans` / `board_write_plan` (t3o-08).
- `planTotal` / `planDone` on the card shell and the `PlanPips` row
  (`BoardCardSummaryRow.tsx`) — key-optional, consumed defensively, **no producer anywhere**.

This spec ships the behaviour: the approve gate, the child cards, the integration branch, the
derived parent stage, and the pip producer. It deliberately reuses the existing machinery at every
turn — children are ordinary cards, their builds/reviews/merges are the ordinary pipeline, and the
parent's final review is the ordinary review loop.

## Goal

A card whose planning session produced two or more plans gains an **Approve split** action. One
click materialises each plan as a real child card, creates and pushes the parent's integration
branch, and parks the parent in the build-role stage showing `n/m plans` pips. Children build,
review and merge into the integration branch through the unmodified pipeline; when the last child
reaches Done the parent advances on its own, and its review stage runs the final
integration-branch → default-branch review.

## Scope

**In**

1. `board.plans.approve` — client command, decider validation, materialisation events.
2. Child cards as ordinary `board.card-created` events: generated keys, plan body as brief,
   plan-graph `dependsOn` mapped to card ids, `parentCardId` + `sourcePlanId` set.
3. The integration branch: created and pushed at approval, recorded as a `branch-only` worktree
   state; kept current by the existing post-merge fast-forward.
4. Derived parent stage: parent moves to the build-role stage at approval, cannot be dragged while
   children are unfinished, auto-advances when the last child reaches Done.
5. `planTotal` / `planDone` production — SQL, shell deltas, and the detail payload.
6. Guards: plans freeze while children exist; parent delete/archive refused while children exist;
   re-approval refused; depth 1 enforced.
7. Plan pane: the Approve split action with a confirm step, and per-plan child links afterwards.
8. A `parentCardId`-driven "part of `<key>`" chip on child cards.

**Out**

- The `sync-base` step and the stale-sibling final review round — **t3o-24**. Until then the only
  base-sync is the existing best-effort local fast-forward after each merge; siblings running in
  parallel can still go stale against the integration branch and surface as merge conflicts, which
  the existing conflict-fix step already handles one at a time.
- The sub-board drill-in view and hiding children from the main board — **t3o-25**. In this spec
  children are visible as ordinary cards in the main columns.
- Plan materialisation to `.plans/` files and `BoardPlan.locked` — still t3o-12's deferred item,
  untouched here. `locked` keeps its "materialised to a file" meaning; this spec freezes plans
  through a live-children guard instead.
- Nesting beyond depth 1 (D12: refused, not designed around).
- Forge-side base-branch protection, PR chaining UI, or any GitHub configuration.

## Locked decisions

### D1 — The approve gate is a command on the plan pane, not a stage transition

t3o-00 D12 said "the existing Approve plan gate", which in the fixed-stage world meant
Planning → Ready. t3o-15 dissolved that anchor: stages are user-defined, Planning is an ordinary
deletable stage, and the only stage-crossing button is the generic `Move to <stage>` /
`Begin build`. There is nothing to hang an approval on.

**Decision:** approval is an explicit client command, `board.plans.approve`, dispatched from an
**Approve split** button on the card's Plan pane. The button renders only when the card has two or
more plans, no children yet, no `parentCardId` of its own, and sits at or before the build-role
stage. A confirm dialog lists the plans and their dependency edges before dispatching.

Single-plan cards keep today's flow unchanged — the human simply moves the card onward; a split of
one is an indirection with no benefit ("single-plan is the default; most cards never split"). The
decider refuses approval with fewer than two plans.

### D2 — Children are ordinary cards, created by ordinary events

The decider handles `board.plans.approve` by emitting, in order:

1. One `board.card-created` per plan, in `ordinal` order — a full, ordinary creation payload:
   generated key (`nextCardNumberByProject`, exactly as `board.card.create` allocates), title from
   the plan title, **brief from the plan body** (children arrive with their work order attached),
   the parent's `type` and `projectId`, `dependsOn` mapped plan-id → sibling-card-id,
   `parentCardId` set to the parent, and `sourcePlanId` recording which plan it came from.
2. One `board.card-moved` for the parent into the build-role stage (D4).
3. One `board.plans-approved` carrying `{ cardId, childCardIds, approvedAt }` — the activity-rail
   row ("approved the split into N plan cards") and the reactor's trigger for D5.

*Why ordinary events:* every existing consumer — SQL projector, in-memory projector, shell deltas,
activity rail, auto-kickoff filter — handles the children with **zero new cases**. Children created
into a non-auto-executing stage spawn nothing (t3o-15 D7's trigger only fires on auto-executing
stages), so materialisation starts no threads.

Validation, all in the decider: card exists and is active; `parentCardId === null` (depth 1);
no existing children; two or more plans; the plan graph re-checked acyclic
(`findProposedPlanCycle` — agent-authored graphs are validated at the gate, D12); the parent's own
`dependsOn` all met (it is about to enter the build zone, D11 applies to it as to any card); a
materialisation floor exists (D3).

`BoardCard.sourcePlanId: NullOr(BoardPlanId)` with a decoding default of `null` joins the aggregate
(migration adds the nullable column), so the plan pane can point each plan at its card without a
join through titles.

### D3 — Children materialise into the stage immediately before the build role

Plan cards are materialised work, not backlog — but their builds are still individual human
commitments. D18's line ("**Ready → Building is never automatic** … nothing crosses that line
without you") is the most load-bearing rule on the board, and approving a split is one act, not N
acts: it must not start N builds.

**Decision:** children are created into the **materialisation floor** — the stage immediately
preceding the build-role stage (`Ready` on a seeded board). Each child then crosses into Building
by the same drag / `Begin build` the human uses for any card, with the dependency gate enforcing
the agent-authored order (a child whose sibling dependency is unmet is refused entry, by the
existing crossing check). The floor stage is where the queue of approved-but-unstarted parts lives,
exactly what Ready exists for.

The plan-card stage restriction relaxes to match: `decider.ts:663` changes from "at or after the
build role" to "at or after the materialisation floor", so a child can be dragged back out of
Building to the floor (reverse states) but never into ideation stages. A new helper
`boardSubBoardFloorStage(board)` owns the resolution.

A board whose build-role stage is its **first** stage has no floor; approval is refused with
"add a stage before '<build stage>' to hold the materialised plan cards". Refusing a degenerate
configuration beats inventing a special case that violates D18.

### D4 — The parent's stage is derived: build while children run, advanced by their completion

"The parent's stage is derived while children are live and cannot be dragged independently" (D12).
Full derivation — recomputing a stage from children continuously — would fight the event-sourced
move model. The observation that collapses it: the derivation only ever takes two values.

**Decision:** the parent's derived stage is expressed as two transitions plus a freeze:

- **At approval** the parent moves into the **build-role stage** (the `board.card-moved` in D2's
  sequence — user-originated, so t3o-03's "no non-human path into Building" test stays satisfiable
  in letter and spirit: the human clicked Approve). The parent building *through its children* sits
  in the Building column wearing its pips.
- **While any child is unfinished** — not deleted, not archived, not in the done-role stage — the
  parent refuses `board.card.move` in any direction, override included: "Card 'X' advances through
  its N plan cards; move those instead." The same predicate suppresses stage auto-kickoff for the
  parent (a new guard in `beginStageRun`): the build stage's auto-execute must not spawn a build
  thread for a card whose build is its children.
- **When the last child reaches Done** (moved into the done-role stage, archived, or deleted — the
  reactor watches all three child transitions), the reactor advances the parent to the **next stage
  in order** through the ordinary `board.card.move` path, mirroring `advanceStage`. On a seeded
  board that is Building → Code review: the review stage auto-executes the unmodified review loop,
  whose agent pushes the integration branch and opens the final PR against the card's recorded
  base — the default branch, because the parent's own `parentCardId` is null. Merge and Done then
  ride the existing merge-role machinery, and `settleCardAtDone` reclaims the integration branch
  exactly as it reclaims any card branch.

A parent whose children are all finished is an ordinary card again — draggable, kickoff-able,
deletable. If every child is deleted outright the parent unfreezes where it stands and the human
decides what it means.

The advance is deliberately *next in order*, not "the review-role stage": a user stage inserted
between Build and Review must not be skipped (the same reasoning as t3o-15 D8).

### D5 — The integration branch exists from approval, as a branch without a worktree

Children cut their branches from `parent.worktree.branch` (`resolveBoardCardBaseRef`), and their
PRs target it on the forge — so the branch must exist locally *and* remotely before the first
child builds. But the parent runs no agent until its final review, and a worktree costs a setup
script and gigabytes (D6). Worse, a branch checked out in a parent worktree cannot be
fast-forwarded by the existing post-merge sync (`pullMergedBaseBranch` fetches `base:base`, which
git refuses for any checked-out branch) — the local integration branch would go stale and a
later-starting child would silently cut from history missing its merged siblings.

**Decision:** `BoardCardWorktreeStatus` gains **`branch-only`**: the branch exists, `path` is
null, no worktree has ever been provisioned. On `board.plans-approved` the reactor:

1. resolves the default base exactly as `ensureWorktree` does (origin/HEAD, current-branch
   fallback, detached HEAD is a failure);
2. creates `board/<parent-key>` from it in the project root (existing branch: reuse, not error —
   the retry path);
3. **pushes it to the primary remote** so child PRs have a target;
4. dispatches a new internal command `board.card.record-integration-branch { cardId, branch,
   baseRefName }` → event → worktree slice `{ branch, baseRefName, path: null, status:
   "branch-only", attempts: 1 }`.

Failures in 1–2 report through the existing `fail-worktree` path so the card says why and retry is
possible; a failed **push** records an activity note but does not fail the slice — a local-only
project still builds and reviews locally, and the missing remote branch surfaces at the child's
review step with the forge CLI's own words (the t3o-20 stance).

Because nothing has the branch checked out, each child merge fast-forwards the local integration
branch via the existing `pullMergedBaseBranch` (called with the merged PR's `baseRef`, which for a
child *is* the integration branch — verify the call site passes the PR's base, not the project
default). Later children therefore cut from a base containing every merged sibling.

The provisioning state machine extends by one arc: `branch-only` joins `failed` / `reclaimed` as a
state `provision-worktree` may leave, so the parent's review-stage entry provisions a worktree by
**attaching to the existing branch** (`provisionBoardCardWorktree` already handles exactly that).
Reclaim of a `branch-only` slice is a no-op on the worktree half; branch deletion at Done/delete
is unchanged.

### D6 — `planTotal` / `planDone` get their producer; archived children count as done

`planTotal` = the card's non-deleted children. `planDone` = those in the done-role stage **or
archived**. An archived child counts as done for the same reason an archived dependency stops
gating (t3o-13 D1): archive is how finished work leaves the board, and D15 auto-archives Done
cards after seven days — a parent must not watch its pips run backwards because a child aged out.
A deleted child leaves both counts. The same predicate ("unfinished child") drives D4's freeze and
advance, stated once in contracts (`boardCardUnfinishedChildren(board, cardId)`).

Production, following the `planCount` precedent:

- `listBoardCardShellRows` computes both by subquery against `board_cards` + the done-role stage.
- The shell **delta** rides the existing `card-plans` shell event, widened with key-optional
  `planTotal` / `planDone`: any child transition that changes the counts (created, moved across
  the done boundary, archived, unarchived, deleted) has the projector emit a `card-plans` delta
  **for the parent** alongside the child's own delta. The client-side reducer already merges
  `card-plans` fields by presence.
- `BoardCardDetail` gains `children: [{ cardId, key, title, stage, sourcePlanId }]` so the plan
  pane can chip each plan with its child.

`PlanPips` and `boardCardSummary`'s plans row need no change — that is the point of producing the
fields they already consume. `BoardCardShell` additionally gains key-optional `parentCardId` so a
child's face can wear a "part of `<parent key>`" chip (the parent is in the same snapshot).

### D7 — Plans freeze and the parent locks down while children exist

While a card has any non-deleted child:

- `board.plans.propose` and `board.plan.write` are refused: "Card 'X' has materialised child
  cards; the plans are frozen. Work happens on the child cards now." (`BoardPlan.locked` stays
  untouched — it means "materialised to a file", t3o-12's deferred concern.)
- `board.card.delete` on the parent is refused with the child count and keys — cascade deletion
  of N cards, N branches and N worktrees from one click is exactly the destructive surprise the
  delete confirm exists to prevent. Delete the children first (each child delete already rewrites
  sibling `dependsOn` edges and force-reclaims, and the last one unfreezes the parent).
- `board.card.archive` on the parent is refused while any child is **live** (unarchived, not
  done): archiving the supervisor of running work strands it. A parent whose children are all
  done/archived archives normally.
- Re-approval (`board.plans.approve` with existing children) is refused.

Children themselves stay ordinary: deletable, archivable, draggable within their permitted range —
every existing reverse state holds, and each transition re-runs D4/D6's checks.

## The flow, end to end

1. Planning thread on card `T3-190` records three plans via `board_propose_plans` (unchanged).
2. Human opens the Plan pane, reads the plans, clicks **Approve split**, confirms.
3. Decider validates (D2), emits three creations into Ready, the parent's move into Building, and
   `board.plans-approved`. Plans freeze. Pips read `0/3 plans`.
4. Reactor creates and pushes `board/t3-190`, records the `branch-only` slice.
5. Human drags `T3-191` (no dependencies) into Building. Worktree provisions off
   `board/t3-190`; build → review (PR targets `board/t3-190` on the forge) → human merges →
   `pullMergedBaseBranch` fast-forwards local `board/t3-190` → Done; branch reclaimed. Pips
   `1/3`. `T3-192`'s dependency on `T3-191` is now met, so it may enter Building.
6. Last child reaches Done: reactor advances `T3-190` to Code review. The review loop provisions
   the parent's worktree by attaching to `board/t3-190`, and the review agent opens the final PR
   against the default branch.
7. Merge, Done, reclaim — all stock.

## Seam inventory

Zero upstream files. Everything lands in board-owned registries and files: one client command +
one internal command appended to `BOARD_CLIENT_COMMANDS` / `BOARD_INTERNAL_COMMANDS`, two events
appended to `BOARD_EVENT_TYPES` (`board.plans-approved`, `board.card-integration-branch-recorded`),
one board migration (027: `board_cards.source_plan_id`), and board-owned server/client/web files
per the table below.

## Acceptance criteria

1. Approve split on a three-plan card creates three child cards in the floor stage, in ordinal
   order, with generated keys, plan bodies as briefs, mapped dependency edges, `parentCardId` and
   `sourcePlanId` set — and starts **no** thread and **no** worktree for any child.
2. The parent lands in the build-role stage with `0/N` pips and a frozen position: drag is
   refused (override included) with a message naming the children, and the build stage's
   auto-execute spawns nothing for it.
3. Approval is refused with fewer than two plans; on a card with children; on a child (depth 1);
   with a cyclic plan graph (naming the edge); with unmet parent dependencies; and on a board
   whose build-role stage is first (naming the fix).
4. After approval, `board_propose_plans` and `board_write_plan` against the parent are refused
   with the frozen-plans message; both work again if every child is deleted.
5. The integration branch `board/<parent-key>` exists locally and on the remote after approval;
   the card's worktree slice reads `branch-only` with a null path. With no remote, the branch
   still exists locally and the card carries an activity note about the skipped push.
6. A child entering Building cuts its branch from the integration branch (worktree
   `baseRefName === "board/<parent-key>"`); a child approved-then-built before the branch record
   lands shows the existing "parent has no branch yet" failure and succeeds on retry.
7. A child's review-stage PR targets the integration branch on the forge; merging it
   fast-forwards the local integration branch; a sibling entering Building afterwards includes
   the merged work in its base.
8. A child with an unmet sibling dependency is refused entry to Building by the existing crossing
   message; it enters cleanly once the sibling is Done.
9. Children can be dragged back to the floor stage but not before it; the old "cannot enter
   '<early stage>'" refusal still fires below the floor.
10. When the last unfinished child reaches Done (or is archived, or deleted), the parent advances
    to the next stage in order exactly once; on a seeded board its review loop runs and its final
    PR targets the **default** branch.
11. Pips: `planDone` counts done-role and archived children; deleting a child shrinks
    `planTotal`; every transition updates the parent's shell without a reconnect.
12. Parent delete is refused with child keys while any child exists; parent archive is refused
    while any child is live; both succeed once children are done/archived.
13. The plan pane shows Approve split only in the D1 conditions, and afterwards chips each plan
    with its child's key and stage, linking to the child; child card faces wear a
    "part of `<parent key>`" chip.
14. Parent Done reclaims the parent worktree and deletes the integration branch through the
    existing settle; a `branch-only` parent that is deleted mid-flight (after children are
    removed) deletes the branch without a worktree error.
15. A from-empty replay reproduces the read model — children, counts, freeze state, branch slice —
    identically to rehydration; `pnpm test` passes.

## Watched-run items

- The review loop's prompt tells the agent to push and open a PR "against its base ref" — confirm
  the composed protocol renders the integration branch for a child and the default branch for the
  parent, from the recorded `baseRefName`.
- `pullMergedBaseBranch` skips (divergence, no remote) are reported, not raised — watch that a
  skipped fast-forward surfaces visibly enough before t3o-24 lands.
- A parent dragged onward manually after its children finish (rather than waiting for the
  reactor's advance) must not double-advance when the reactor's check fires on the same event.

## Files

| File | Change |
| --- | --- |
| `packages/contracts/src/board.ts` | `board.plans.approve` + `board.card.record-integration-branch` commands; `board.plans-approved` + `board.card-integration-branch-recorded` events; `branch-only` status; `BoardCard.sourcePlanId`; shell `parentCardId` + widened `card-plans` delta; `boardSubBoardFloorStage`, `boardCardChildren`, `boardCardUnfinishedChildren`; detail `children` |
| `apps/server/src/board/decider.ts` | approve validation + materialisation events; floor-based plan-card restriction; parent freeze/delete/archive/propose/write guards; integration-branch record |
| `apps/server/src/board/projector.ts` | new event cases; parent `card-plans` deltas on child transitions |
| `apps/server/src/board/projection.ts` | `source_plan_id` column; `planTotal`/`planDone` subqueries; detail `children` |
| `apps/server/src/board/migrations/027_BoardCardsSourcePlan.ts` | nullable `source_plan_id` |
| `apps/server/src/board/supervisorReactor.ts` | `plans-approved` handler (branch create/push/record); `beginStageRun` live-children guard; child-transition watcher advancing the parent |
| `apps/server/src/board/worktree.ts` | branch-only aware provisioning/reclaim edges (attach path already exists) |
| `packages/client-runtime/src/operations/boardCommands.ts`, `state/board.ts` | `approvePlans` command + atom; `card-plans` delta fields |
| `apps/web/src/board/BoardCardPlanPane.tsx` | Approve split + confirm; per-plan child chips |
| `apps/web/src/board/BoardCardSummaryRow.tsx`, `BoardCardItem.tsx` | parent-chip on children (pips already exist) |
| Tests | decider approve/guards/floor; projector counts + replay; reactor branch + advance (harness); summary/pips; walking skeleton extension |

## Verification

Focused tests in the existing styles: `decider.board.test.ts` (approve validation matrix, freeze
guards, floor restriction, advance gating), `projector.board.test.ts` (materialisation replay,
count deltas), `supervisorGovernor`/harness tests (branch-only provisioning, kickoff suppression,
last-child advance, no double-advance), `boardCardSummary.test.ts` (pips from produced fields),
plus a walking-skeleton pass covering the flow narrative above.
