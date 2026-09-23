---
id: t3o-35
title: Auto-promote unblocked Backlog cards to Sprint
phase: 3
prerequisites: [t3o-10, t3o-24]
---

# Auto-promote unblocked Backlog cards to Sprint

A per-project opt-in that moves every Backlog card with no unmet dependencies
into Sprint. Backlog becomes "cannot start yet"; Sprint becomes "unblocked,
waiting to be planned". The only automatic forward move this adds is
**Backlog → Sprint**.

## Goal

Turn the setting on for a project and every eligible Backlog card in that
project moves itself to Sprint. A card that still waits on unfinished work
stays in Backlog until the last dependency is Done or archived. Dragging one
back to Backlog parks it until a human unparks it or it becomes blocked again.

## Scope

### In

- Two per-project board settings, both default off, edited from Settings → Board:
  - **Auto-move unblocked Backlog cards to Sprint**
  - **Include sub-board children** (inert unless the first is on)
- One boolean on the card, `backlogParked`, set by any move into Backlog from
  another stage (human drag or agent `board.card.move`).
- Reactor pass, same cadence as auto-start: targeted on create / update / Done
  arrival / archive / schedule fire, plus the 30s sweep and boot reconcile.
- Parked chip on the column card (display-only). **Unpark** in the card detail.
- User doc.

### Out

- Any automatic move other than Backlog → Sprint.
- A cap on how many cards enter Sprint.
- Changing T3O-19's clear-then-act schedule machinery. This feature reads
  `isBoardCardScheduleDue` (null or past = due). A schedule that fires while
  the card is still blocked is cleared by T3O-19 as today; the card then
  auto-promotes the moment its last dependency lands, because a null schedule
  is due.
- Mobile board UI (D17).

## Key decisions

**K1 — Eligibility is `unmetBoardCardDependencies` empty.** One shared
definition with the blocked flag and auto-start. A dependency is met in the
done-role stage, or when archived. An unknown id stays unmet. One of two
dependencies Done is not enough.

**K2 — Per-project opt-in, default off.** Stored on `BoardProjectSettings` with
decoding defaults so a pre-this-spec settings file still decodes. Children
require the parent setting; the children flag alone does nothing.

**K3 — Park on any arrival in Backlog from another stage.** Set inside the
move, atomically, so the reactor cannot bounce the card. Cleared by: leaving
Backlog, Unpark (`backlogParked: false` on update), or gaining an unmet
dependency. Cannot be set true via update.

**K4 — Schedule is an AND, not a second countdown.** Move when deps are met
AND `isBoardCardScheduleDue`. Unscheduled cards are due now. A future time
holds the card in Backlog. A time that already passed (or was cleared by
T3O-19 while the card was still blocked) is due, so the card moves as soon
as the last dependency lands.

**K5 — Amends D18 for one transition.** D18 said Backlog → Sprint is
human-gated. With this setting on, that crossing is board-driven for
unparked, due, unblocked cards. Ready → Building is untouched. Sprint is
not auto-executing, so this does not start an agent.

## Predicate

`boardCardAutoPromoteDue` — live, not archived, in the seed Backlog stage,
not parked, project setting on (children setting too if parented), schedule
due, no unmet dependencies. Shared by the reactor, the Unpark button's
follow-through, and tests.
