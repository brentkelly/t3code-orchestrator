---
id: t3o-06
title: Card UI — stage-specific summaries, detail pane, thread adoption
phase: 1
prerequisites: [t3o-05]
---

# Card UI and detail

The part of T3o that is actually different from every other Kanban board: **what a card shows
changes with the stage it is in**, because what matters about a piece of work changes as it moves.

## Locked decisions

- **D7** — summaries render from `BoardCardShell` only. The detail pane subscribes separately.
- **D9** — thread adoption is initiated **from the card**, never from the thread action menu.
- **D13** — "Input needed" derives from the linked thread's existing pending-input state, and the
  card's gate buttons resolve the same gate a thread answer resolves.

## Stage-specific summaries

Every variant renders only from `BoardCardShell` fields.

| Stage | Card shows |
| --- | --- |
| Backlog / Sprint | key pill (project colour), type badge, title |
| Planning | + planning-thread activity indicator |
| Ready | + blocked flag with dependency count, attachment count |
| Building | + plan progress pips and `2/6 plans` when a parent; queued flag and queue position; thread state |
| Code review | + `#PR`, `Round 3 of 5` with round pips, current step label (`TRIAGING`), `1 / 2 / 1` severity triple, and `7 fixed · 4 rejected · 1 open · 1 disputed` |
| Ready for merge | + PR state and check summary |
| Done | collapsed presentation; muted |

States that apply anywhere:

- **Input needed** — blue-tinted card, ring, and an explicit flag, per the reference screenshot.
  This is the single most important visual state on the board; it is the thing that unblocks work.
- **Blocked** — flag with the blocking card keys on hover.
- **Queued** — visible in Building, never disguised as running.

The severity triple needs a tooltip spelling out `N critical · N improvements · N nitpicks`; three
bare numbers are meaningless to anyone who has not read this spec.

## Detail pane

Opened from a card; subscribes via `board.subscribeCard`.

Sections, ordered by stage relevance:

- **Header** — key, type, stage picker, project, branch, primary stage action.
- **Brief** — inline rich-text editing, autosaved as `board.card.update`.
- **Dependencies** — list with each dependency's stage, a search-and-add picker, cycle rejection
  surfaced inline at the edge that caused it.
- **Threads** — the card's linked threads with role and state, deep-linking into the Threads view.
  Tombstoned links render as struck-through with the role preserved.
- **Adoption** — an add-thread control opening a searchable picker over unlinked threads in the same
  project, assigning a role on link. This is the *only* adoption entry point.
- **Plan** — rendered when a plan body exists.
- **Review** — round accordion with per-round steps, notes and the issue ledger (populated by the
  post-MVP review pipeline; the pane is built to accept it).
- **Activity** — who did what, when.

The detail pane must render fully for an archived card whose worktree is long gone. Nothing in it
may require repo access.

## Card creation

A create dialog with title, brief, type, project, target stage and initial dependencies. Reachable
from the column add buttons and from the top bar. The key is allocated server-side on create; the
UI never invents one.

## Out of scope

- Sub-board drill-in and the plan approval table (post-MVP).
- Anything that spawns a thread (`t3o-10`, `t3o-12`).

## Verification

- Each stage renders its documented summary variant from shell data alone — assert the detail
  subscription is *not* opened by the column view.
- Adoption links a thread and it appears with its role after reload; unlink reverses it.
- Deleting an adopted thread leaves a tombstone, not a gap.
- An archived card's detail renders with no project on disk.
