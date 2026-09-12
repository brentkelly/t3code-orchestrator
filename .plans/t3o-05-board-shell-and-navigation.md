---
id: t3o-05
title: Board shell — mode tabs, routing, columns, drag ordering
phase: 1
prerequisites: [t3o-04]
---

# Board shell and navigation

The Threads/Board mode switch and the board surface itself: columns, cards, drag. This is where the
four `apps/web` hook points from D1 are spent, so spend them carefully.

## Locked decisions

- **D1** — board code lives in the T3o package; `apps/web` gets a route, a tab, a lazy import, and a
  settings entry. Nothing more.
- **D11** — the Building column is the queue; position is priority; queued cards sit in Building
  flagged as queued, never in Ready.

## Scope

### Mode tabs

Threads / Board segmented control, rendered **before** the breadcrumb in the workspace top bar,
matching the reference screenshot. Styling comes from existing primitives (`Button` `size="xs"`,
`sidebarMenuButtonVariants`) — no new design tokens.

Mode is persisted per client. Switching modes preserves the other mode's last location so toggling
back does not dump you at a root.

### Routing

New route file(s) under `apps/web/src/routes/` — new files, zero conflict. The route renders a lazy
import of the board package, so the board bundle is not paid for by users who never open it.

Deep links must work: a card URL opens the board with that card's detail open, which is what D13's
notification deep-links depend on.

### Project scope selector

`All projects` plus per-project, matching the screenshot's scope control and colour legend. Cards
are keyed to T3's own `ProjectId`; **"All projects" is a view over `projects.list`, not a stored
entity.** Per-project accent colours are a T3o setting keyed by `ProjectId`.

### Columns

All eight stages, horizontally scrollable, each with a count and an inline add button. Column
collapse is persisted (the prototype uses `localStorage`; use the app's existing client-persistence
helper instead so it participates in settings restore).

The `Backlog` column is collapsed to a rail by default — it is the one column that grows without
bound and it is not where attention belongs.

### Drag and drop

`@dnd-kit` is already a dependency of `apps/web`; use it rather than the prototype's hand-rolled
HTML5 drag. Two distinct gestures:

- **Across columns** — a stage transition, dispatching `board.card.move`.
- **Within a column** — a reorder, dispatching `board.card.reorder` with a fractional key.

Within Building, reorder **is** queue prioritisation (D11), so the drop must communicate that: the
card's queue position and whether it will start next.

Optimistic local reordering with server reconciliation. Never block the drag on a round trip; never
let the optimistic state survive a rejected command.

### Rejected moves

Moving a blocked card past Ready is rejected by the decider. The UI must show *why* — naming the
unmet dependency — not just snap the card back. A silent snap-back reads as a bug.

## Performance notes

Long columns must virtualise. `@legendapp/list` is already a dependency and is what the thread
sidebar uses. Do not introduce continuously repainting animations for queue or working indicators —
that is called out explicitly in the upstream `AGENTS.md` as a GPU regression.

## Out of scope

- Card summary content and the detail pane (`t3o-06`).
- The sub-board drill-in view (post-MVP), though the card's stacked-card affordance is designed for
  it.

## Verification

- Mode switch preserves per-mode location.
- Drag across and within columns dispatches distinct commands; reload reproduces the order.
- A rejected move surfaces a named reason.
- A board of 500 cards scrolls without dropped frames.
