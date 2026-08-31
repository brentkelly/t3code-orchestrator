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
has no children yet, carries **≥2 proposed plans**, and still sits at or before
the build-role stage. A single plan is never a split — it is the build brief,
and most cards never split. Plan metadata lives in the read model (D8), so this
is a pure decider predicate (`boardCardPendingSplit`) with a zero-payload
client-side shell counterpart (`boardCardShellPendingSplit`, derived from
`planCount` / `planTotal` / `parentCardId`, exactly like the D6 pips).

### D2 — Block ALL forward advancement while pending

Unlike dependency blocking (which only guards the build boundary), a pending
split holds the card wherever it sits: the decider refuses **every** forward
`board.card.move` — planning→ready, →building, all of it — until the split is
approved or the human re-proposes a single plan. `override` (a drag) does not
bypass it; the gate is a truth about the card, not a convenience. Backward
moves and reorders stay free — that is how you get back to fix the plans.

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
