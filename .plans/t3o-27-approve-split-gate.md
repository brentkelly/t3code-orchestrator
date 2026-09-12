---
id: t3o-27
title: Sub-boards — surface & gate the split approval
phase: 3
prerequisites: [t3o-23]
---

# Surface & gate the split approval

t3o-23 shipped split approval as a button on the **Plan pane**, which is not
shown by default — so the one gate that unblocks the whole build is easy to
miss, and nothing stopped a card with an unapproved multi-part split from being
dragged onward (even into build), silently skipping the split. This spec
surfaces the approval where the human already is and makes the gate real.

## Locked decisions

### D1 — "Pending split" is the read-model truth

A card is **pending a split** when it is top-level (`parentCardId === null`),
has no **live** (non-archived) children, carries **≥2 proposed plans**, still
sits at or before the build-role stage, and the board has a materialisation
floor (a floor-less board cannot split, so nothing on it is ever pinned toward
an approval the decider would refuse). Live-children semantics match the
re-approval guard: a first round whose children all archived is gone from the
board, so the card pends its second-round split again. A single plan is never
a split — it is the build brief, and most cards never split. Plan metadata
lives in the read model (D8), so this is a pure decider predicate
(`boardCardPendingSplit`) with a zero-payload client-side shell counterpart
(`boardCardShellPendingSplit`, derived from `planCount` / `planTotal` /
`parentCardId`, exactly like the D6 pips — and agreeing with it by
construction, since `planTotal` is itself live-children-only).

### D2 — Block forward advancement past planning while pending

Unlike dependency blocking (which only guards the build boundary), a pending
split cannot advance past the plan-role stage: the decider refuses every
**forward** `board.card.move` whose target lies beyond it — planning→ready,
→building, all of it — until the split is approved or the human re-proposes a
single plan. `override` (a drag) does not bypass it; the gate is a truth about
the card, not a convenience. The span up to and including the plan stage stays
reachable (a card retreated to Sprint can come home to Planning), and
**backward moves and reorders are always free** — that is how you get back to
fix the plans. The ceiling is clamped below the build role, so a plan stage
reordered after Building (legal — only build<review and done-last are spine
invariants) never opens the build stage; a board with no plan-role stage pins
the card where it sits.

### D3 — The modal replaces its forward button with "Approve split"

On the card detail, when a split is pending, the primary forward action
("Move to Ready" / "Begin build") is replaced by an **Approve split** button
(amber) that dispatches `board.plans.approve`. You cannot advance from the
modal without resolving the split, which mirrors the decider gate. The Plan
pane's own Approve split button stays.

### D4 — Amber "Needs approval", distinct from blue "Input needed"

A pending-split card wears an **amber** face tint + border and a
**"Needs approval"** chip. Blue is already the "Input needed" state (a thread
question); overloading it would conflate "answer the agent" with "approve this
split". Amber reads as a distinct, human-actionable gate.

## Acceptance criteria

1. A top-level planning card with ≥2 plans and no children cannot move to any
   later stage (drag or button), and the refusal names the plan count.
2. The same card moves backward and reorders freely; a single-plan card
   advances freely.
3. The card modal shows **Approve split** in place of the forward stage button
   while pending; approving materialises the children (t3o-23) and clears it.
4. The column card and modal show the amber "Needs approval" state; a child
   card (or a parent that already has children) never does.
5. `pnpm test` passes.

## Files

| File | Change |
| --- | --- |
| `packages/contracts/src/board.ts` | `boardCardPendingSplit`, `boardCardShellPendingSplit` |
| `apps/server/src/board/decider.ts` | forward-move gate on `board.card.move` |
| `apps/web/src/board/BoardCardDetailView.tsx` | Approve-split button replaces the forward action |
| `apps/web/src/board/BoardCardItem.tsx` | amber "Needs approval" tint + chip |
| `apps/web/src/board/BoardColumn.tsx`, `BoardPage.tsx` | thread `pendingSplitFor` from the derivation |
| Tests | decider gate matrix; contracts predicate + shell derivation |
