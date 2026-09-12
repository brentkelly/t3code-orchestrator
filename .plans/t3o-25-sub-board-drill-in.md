---
id: t3o-25
title: Sub-boards — the drill-in view
phase: 3
prerequisites: [t3o-23]
---

# Sub-boards — drill-in

t3o-23 makes children ordinary cards in the main columns. Correct, and noisy: a three-way split
turns one line of Building into four, the parent and its parts interleave with unrelated work, and
the board stops reading as "what is this team doing" and starts reading as "what is every agent
doing". The card face's stacked-card affordance (designed for this in t3o-05/06) has nothing to
open.

## Goal

Children leave the main board. The parent wears the stack; clicking it drills into a sub-board —
the same column UI scoped to that parent's children — with a breadcrumb back.

## Scope

**In**

1. Main board filters out cards with `parentCardId` (the shell already carries it).
2. The parent card face: stacked-card visual + pips as the drill-in affordance.
3. The drill-in route (`/board/<parentCardId>` alongside the existing board route): columns from
   the materialisation floor onward, cards filtered to the parent's children, parent summary
   header (key, title, integration branch, its PR state when open, pips), breadcrumb back.
4. Card create inside a drill-in creates a child (parentCardId preset, floor-onward stages only,
   `dependsOn` picker scoped to siblings).
5. Deep links: child detail URLs resolve inside their sub-board; the "part of" chip and plan-pane
   child chips navigate into it.
6. The archived-cards sheet and search learn to badge children with their parent key.

**Out**

- Any behavioural change — commands, decider, reactor, projections are untouched except the
  child-create preset. This is a view.
- Cross-sub-board dependency editing (a child may only depend on siblings, as materialised).
- Mobile.

## Locked decisions

### D1 — One board component, scoped twice

No second board implementation. `BoardPage` takes a scope — `{ kind: "root" } | { kind:
"sub-board", parentCardId }` — from the route. Root scope filters `parentCardId === null` and
renders all stages; sub-board scope filters to the parent's children and renders floor-onward
stages. Column render, drag, detail sheet, stage actions are the same code; the scope is data.
Collapse state keys on `(scope, stageId)` so a collapsed Backlog does not collapse inside every
sub-board (where Backlog does not even render).

### D2 — The parent is the door, not a column resident twice

The parent appears exactly once, on the root board, in its (derived) stage. Inside its own
sub-board it is a **header**, not a card — showing key, title, branch, PR chip, pips, and the
frozen-stage explanation while children run. Rendering the parent as a card inside its own
sub-board would invite dragging it, which the decider refuses anyway; the header states the rule
instead of letting the refusal teach it.

### D3 — Empty sub-boards cannot exist; dead links resolve up

Drill-in only exists for cards with children (the affordance renders off `planTotal > 0`). A URL
naming a card with no children — children all deleted, or a stale link — redirects to the root
board with the parent's detail sheet open. Never a 404 inside the shell; reverse states include
navigation.

## Acceptance criteria

1. A split parent shows the stack + pips on the root board; its children no longer render there.
2. Clicking the stack opens the sub-board: floor-onward columns, children only, parent header,
   breadcrumb; drag/detail/actions behave exactly as on the root board.
3. Creating a card inside a sub-board yields a child of that parent in the floor stage, with the
   dependency picker limited to siblings.
4. Child deep links (detail URL, "part of" chip, plan-pane chips, activity rail) land inside the
   sub-board with the child's sheet open.
5. A childless-card sub-board URL redirects to the root board with that card's sheet open.
6. Archived children in the sheet and search results carry the parent-key badge.
7. Collapse state is independent per scope; no upstream files change.

## Files

| File | Change |
| --- | --- |
| `apps/web/src/board/BoardPage.tsx` | scope prop; filtering; header slot |
| `apps/web/src/board/BoardCardItem.tsx` | stacked-card affordance opens the scope |
| `apps/web/src/board/boardUiStore.ts` | scoped collapse keys |
| board route files | `/board/<parentCardId>` route + redirect rule |
| `apps/web/src/board/BoardCardCreateDialog.tsx` | child preset + sibling-scoped deps |
| `apps/web/src/board/BoardArchivedCardsSheet.tsx`, search | parent badges |
| Tests | scope filtering, redirect, create preset, collapse keys |
