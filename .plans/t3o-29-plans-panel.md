---
id: t3o-29
title: The Plans panel — a split's shape, not its prose
phase: 3
prerequisites: [t3o-23, t3o-25, t3o-28]
---

# The Plans panel

t3o-28 scope item 4 says "the parent's modal opens on the **Plans** pane". It
was implemented as the pane we already had — `BoardCardPlanPane`, the planning
stage's markdown output — and the acceptance criterion passed against it. The
prototype means something else entirely. `t3o.dc.html` carries two distinct
panes: `planDocPane`, the implementation-plan document, and `plansPane`, a
dependency-ordered list of the children with their status, their blockers, a
dependency chart and the final-review footer. Only the first exists.

The consequence is that a split parent — the one card whose whole job is to
supervise four others — opens onto four copies of prose the human already read
at approval, and says nothing about what any of the children are doing. The
information is all on the client already; there is simply no surface rendering
it.

> The plan body **becomes the child's brief** at materialisation
> (`decider.ts`, `briefFromPlanId`). Every word the parent's markdown pane
> shows post-approval is a second copy of four Brief panes one click away.
> That is the fact this spec turns on.

## Goal

A split parent's modal shows the split: one row per plan, in dependency order,
each carrying its child's live stage, its blockers and its PR — and a
dependency chart, on both the modal and the sub-board, that draws the shape the
rows can only list.

## Scope

**In**

1. A `BoardPlansPanel` that replaces the markdown pane on a parent **with live
   children**: dependency-ordered rows, live per-child status, a "Board"
   drill-in, an informational final-review footer.
2. A `BoardPlanGraph` — the prototype's wave layout and SVG edges — behind a
   "Dependency chart" toggle, mounted in the panel **and** on the sub-board.
3. The final-review footer on the sub-board too, above its columns.
4. The plan tab's label becomes the count (`4 plans`) once children exist.

**Out**

- Any contract, projection, RPC or migration change. D1 is the reason.
- The pre-approval pane. A parent with plans and no children keeps today's
  `BoardCardPlanPane` — markdown plus the Approve split gate — untouched, and
  so do child cards and cards that never split.
- Editing from the panel. Rows navigate; they do not move, retitle or restage
  a child. The sub-board is where a child is manipulated.
- Any new way to start the final review. D5.
- Dependency edges the plan graph does not describe. D3.

## Locked decisions

### D1 — The panel is derived, not plumbed

Every field the panel needs is already on the client:

| Needed | Source |
| --- | --- |
| order, titles, `#N`, edges | `detail.plans` (ordinal order, `dependsOn` by plan id) |
| plan ↔ child pairing | `detail.children[].sourcePlanId` |
| live stage, `blocked`, `prNumber` | the child's `BoardCardShell` |
| working / input-needed / queued / stalled | shell `stepRunning`, `threadState`, `awaitingInput`, `queued`, `stalled` |
| integration branch | `detail.card.worktree.branch` |

The shells are the decisive part. `BoardCardDetail.tsx` already reads
`snapshot.cards`, which is the **unscoped** shell list — children carry
`parentCardId` and are filtered out of the root board's *columns* by
`filterBoardColumnsByScope`, not out of the snapshot. That is how
`deriveBoardCardPlanProgress` computes a parent's plan pips on the root board
today. So the panel is a pure function over data in hand, and this spec adds
**no bytes to the wire and no code to the server**.

`BoardCardChildRef` is therefore left alone. It looked like the natural place
to hang a PR number and a thread state; both would have duplicated a shell
field one layer over, and the second would have violated D7's byte budget for
a value the client can already see.

### D2 — Replace the markdown, once and only once children exist

A parent with live children shows ONE plan tab, labelled `4 plans`, holding the
panel. The markdown does not appear beside it, because it is not gone: it is
each child's brief, and the row's drill-in is the way to it.

The switch is `detail.children.filter(live).length > 0` — the same predicate
`isBoardCardThreadLocked` already uses, so the pane lock and the pane contents
turn on one fact rather than two that can disagree. Before approval, nothing
changes at all: the markdown pane is exactly where the human decides whether
the split is right, and taking it away there would be taking it away at the one
moment it is load-bearing.

The tab is present at **every** stage a parent with children can occupy, review
and Done included. What t3o-28 D4 governs is which pane opens by default, and
that rule is untouched: Plans before review, Review from review on.

### D3 — Plans are the edge source, on both surfaces

Row order, `#N` and the chart's edges all come from `detail.plans` — ordinals
and `dependsOn` plan ids — mapped through `sourcePlanId` to the children.
Never from the shells: `BoardCardShell` carries `dependencyCount`, a number,
and D7 is explicit that "the ids themselves never ride the shell".

The sub-board uses the same source. `BoardSubBoardHeader` already opens
`board.subscribeCard` on the parent, so the drill-in has `detail.plans` for
free and needs no second subscription.

The cost is honest and bounded: a dependency added to a child by hand after
materialisation is not in any plan, so it does not draw an edge. The rows still
show it — `blocked` is a shell field and the child's own card face and the D11
gate both tell that truth — the chart just does not draw a line for it. Fixing
that means putting child ids on the shell, which D7 forbids for good reason.

### D4 — A row survives its child

Three states, all reachable:

- **Live child** — the full row: status dot, `#N`, title, `after #1 · PR #303`,
  the blocker note, the live indicator, the stage pill, a chevron that drills in.
- **Archived child** — struck through, its last known stage, no live
  indicators, no drill-in. This is the existing plan pane's treatment of an
  archived child chip, kept: archived cards leave the shell snapshot (D15), so
  there is no live state to show, and `detail.children` retains them precisely
  so the pairing survives.
- **No child** — the plan's child was deleted. The row renders greyed from the
  plan alone and says so. A plan that produced a card and lost it is not the
  same as a plan that was never approved, and the panel should not quietly
  drop a row and change the numbering under the human.

Only live children count toward the **footer**: it describes the integration
branch, and an archived or deleted plan card will never land on it. The
`N plans` **label** counts ROWS, because a pill names its pane's contents —
approving four plans and archiving one must not silently read as three.

### D5 — The footer states; it does not act

The prototype's footer ends in a `Start final review` / `Waiting on plans`
button. The reactor already does that job: `advanceParentIfChildrenDone` moves
the parent out of build the moment the last child reaches Done, and
`regressParentIfChildLeftDone` puts it back if one leaves. A button would be a
second path into the same transition, reachable only in a race the reactor
normally wins — a control that exists to be disabled.

So the footer is prose: the integration branch, the done-of-total count, and
what happens next. No `→ main`: the default branch is resolved server-side at
integration-branch creation and is not on the wire, and inventing it would be
the panel's only lie.

### D6 — The chart is one component, mounted twice

`boardPlanGraphLayout` is a pure function — plans and children in, wave
columns, node boxes and cubic edge paths out — lifted from the prototype's
`graphVm`/`planWaves` and unit-tested on its own. `BoardPlanGraph` renders it.
The panel mounts it under its header; the sub-board mounts it between the
header row and the columns, with the footer beneath, exactly as the prototype
orders them.

Toggle state is local `useState`, not the persisted `boardUiStore`. The modal
remounts per card and the sub-board per navigation, so an ephemeral toggle has
no state to strand; a persisted one would need a key scheme and a migration to
buy a preference nobody has asked to keep.

A cyclic plan graph cannot reach this code — the decider refuses to approve
one — but the layout still terminates on a cycle rather than looping, because
a pure function that can hang the render on bad data is a worse bug than the
one it is guarding.

## Acceptance criteria

1. A parent with live children opens on a panel headed **Plans / in dependency
   order**, one row per plan in ordinal order, each row `#N`, title,
   `after #1 · PR #303`, a stage pill, a chevron.
2. A row whose child has an unfinished plan dependency shows the amber
   `Waiting on #3 · code review` note naming each unfinished blocker and its
   stage; a row whose child is being worked shows the spinner
   (`stepRunning || threadState === "working"`); one awaiting a human shows
   **Input needed**; queued and stalled children read as such.
3. Clicking a row drills into the parent's sub-board with that child's sheet
   open. The header's **Board** button drills in with no sheet.
4. **Dependency chart** toggles a wave-laid graph — one column per dependency
   wave, cubic edges, done edges tinted — in the panel and, from its own
   toggle, on the sub-board. Nodes open the same place rows do.
5. The footer reads `Final review · <integration branch>` with the
   done-of-total count and no action button, in the panel and above the
   sub-board's columns.
6. The plan tab reads `4 plans` for a parent with children and `Plan` for
   every other card.
7. A parent with plans and **no** children still shows today's markdown pane
   and its Approve split gate, unchanged. Child cards and never-split cards
   are unchanged.
8. An archived child's row is struck through with no live state; a deleted
   child's plan still holds its row and its number.
9. No file under `packages/contracts`, `apps/server` or `packages/client-runtime`
   changes.
10. `pnpm test` passes.

## Files

| File | Change |
| --- | --- |
| `apps/web/src/board/boardPlanRows.ts` | **new** — `deriveBoardPlanRows` (plans + children + shells + stages → rows, blockers, live state) and `boardPlanGraphLayout` (waves, nodes, edge paths). Pure, no React |
| `apps/web/src/board/boardPlanRows.test.ts` | **new** — ordering, blocker resolution, archived/deleted rows, wave layout, cycle termination |
| `apps/web/src/board/BoardPlanGraph.tsx` | **new** — the SVG chart over `boardPlanGraphLayout` |
| `apps/web/src/board/BoardPlansPanel.tsx` | **new** — header (chart toggle, Board), chart, rows, final-review footer |
| `apps/web/src/board/BoardPlansPanel.test.tsx` | **new** — the rows, the footer copy, the three child states |
| `apps/web/src/board/BoardCardDetailView.tsx` | the `plan` pane renders `BoardPlansPanel` when live children exist, `BoardCardPlanPane` otherwise; tab label becomes the count |
| `apps/web/src/board/BoardCardDetail.tsx` | pass the children's shells and the integration branch through to the view |
| `apps/web/src/board/BoardCardDetailView.test.tsx` | which pane a parent gets, and the tab label |
| `apps/web/src/board/BoardSubBoardHeader.tsx` | the **Dependency chart** toggle |
| `apps/web/src/board/BoardPage.tsx` | sub-board: chart and final-review footer between the header row and the columns |
