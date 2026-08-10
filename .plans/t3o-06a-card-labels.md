---
id: t3o-06a
title: Card labels — user-managed vocabulary replacing the closed type union
phase: 1
prerequisites: [t3o-05]
---

# Card labels

The prototype's label picker replaces the closed `feature | bug | chore` card type with a
**user-managed vocabulary**: a catalogue of named, coloured labels that users create, recolour and
rename, and a card carries **as many as it needs**.

This runs **before `t3o-06`**, not after. `t3o-06` builds the stage-specific card summaries and the
detail pane; if labels land afterwards it builds a single type badge and then has it torn out. The
domain, the shell payload and the picker component land here so `t3o-06` renders chips from the
start.

## What changes

`BoardCardType` today is `Schema.Literals(["feature", "bug", "chore"])` — closed, three values, one
per card. It becomes:

- a **label registry**: `{ labelId, name, colour }`, user-editable, seeded with today's three values
- a **card field**: `labels: BoardLabelId[]`, mirroring the existing `dependsOn: BoardCardId[]`

The prototype's seed labels are exactly `feature` / `bug` / `chore` in their current colours, so the
migration is a rename in disguise: seed three labels, convert each card's `type` to a single-element
`labels` array. No card loses information.

## Scope decision — labels are an aggregate, not settings

Labels look like configuration, and `t3o-07` is about to introduce `BoardSettings` for the
per-project key prefix and accent colour. Putting labels there would avoid a new aggregate.

**Don't.** Settings patch as whole-map replacement (the `providerInstances` precedent, and `t3o-07`
follows it deliberately). Creating a label inline while tagging a card — which the prototype does,
and which an MCP agent will want in `t3o-08` — would then be a settings write racing every other
settings write. Labels are also referenced by cards, so their history matters in a way an accent
colour's does not.

Labels get commands and events like everything else the board writes (D8: tools and UI dispatch
commands; nothing writes projected tables directly).

**The cost, stated plainly:** this adds a second board aggregate kind. `"label"` joins `"card"` in
`OrchestrationAggregateKind`, and `BoardLabelId` joins the aggregate-id unions in
`OrchestrationEventStore` (×2), `OrchestrationCommandReceipts` and `orchestration.ts`. Those are the
same once-only D9-class widenings `t3o-02a` blessed for `BoardCardId` — frozen, never growing per
feature — but it is four or five more lines of core diff and the seam inventory must record them.
Every *other* part of this spec adds zero core lines.

## Commands and events

Board-owned, registered in the existing `BOARD_CLIENT_COMMANDS` / `BOARD_EVENT_TYPES` /
`makeBoardOrchestrationEvents` registries. Zero new seams.

- `board.label.create` — name, colour. Rejects a name that collides case-insensitively with a live
  label; the prototype's picker already treats the catalogue as case-insensitively unique.
- `board.label.update` — rename and/or recolour.
- `board.label.delete` — see referential integrity below.
- `board.card.update` gains `labels` alongside the fields it already patches.
- `board.card.create` gains `labels` (see `t3o-06`, which is adding `stage`, `brief` and `dependsOn`
  to the same command).

Colour is a hex string validated against a bounded pattern. The prototype offers a 24-entry swatch
(`LABEL_SWATCHES`) plus free choice; keep the swatch as the default path and allow an arbitrary
valid hex.

New-label colour assignment follows the prototype: walk the swatch by a stride from the current
catalogue size and skip colours already in use, so two labels created back to back do not collide.

## Referential integrity

A card holding a deleted label is the obvious failure. Three options; take the third:

1. *Cascade-remove the label from every card* — a bulk write from a single command, and the card
   silently loses information the user did not ask to lose.
2. *Refuse to delete a label in use* — safe, but leaves no way to retire a label without hand-editing
   every card that carries it.
3. **Tombstone the label** — `deletedAt` set, the label leaves the picker, cards keep the reference
   and render it muted. This is the same choice `t3o-03` made for thread links, for the same reason:
   *"a Code Review card whose round-2 triage thread vanished must say so, not silently renumber."*

Deleting is therefore reversible, and a card's history stays honest. Add an undelete path — a
one-way door is a bug (`AGENTS.md`, reverse states).

Unknown label ids on a card render as a muted placeholder rather than disappearing.

## Shell payload — the part most likely to go wrong

`t3o-04` narrowed the shell snapshot from the full aggregate to a bounded `BoardCardShell`, with a
measured byte budget and a test asserting it. Labels can undo that in one line.

**Do not denormalise `{name, colour}` onto each card.** A board with 500 cards averaging three
labels would carry 1,500 name+colour pairs, nearly all duplicates.

Instead:

- `BoardCardShell.labelIds` — ids only. Short, bounded, cheap.
- The **label catalogue rides the shell snapshot once**, as a top-level array beside `cards` — N
  labels for the whole board, not N per card. It is small, it changes rarely, and every client needs
  all of it to render any card.
- Catalogue changes stream as their own shell delta, following the `card-upserted` / `card-removed`
  pattern. Note that `t3o-02a`'s prefix rule says board shell deltas use a `card-` prefix and
  flags exactly this case — *"revisit if non-card board deltas ever appear"*. They have. Widen the
  `isBoardShellStreamEvent` predicate deliberately and update the rule in `docs/t3o/seams.md`;
  do not quietly add a `card-`-prefixed kind that is not about a card.

Extend `t3o-04`'s byte-budget tests to cover a card at the label cap, and assert the snapshot still
grows linearly with card count once labels exist.

**Cap labels per card** (5 is a reasonable start) and enforce it in the decider. Uncapped, the shell
is unbounded again and the card design has no worst case to lay out for.

## Persistence

Following the `t3o-03` precedent, migrations numbered from `904_`:

- `904_BoardLabels` — the catalogue, indexed by name for the uniqueness check.
- `905_BoardCardLabels` — the card↔label join, indexed both ways so "which cards use this label" is
  a lookup, not a scan.
- A data migration seeding `feature` / `bug` / `chore` at the prototype's colours and converting each
  existing card's `type` to a one-element label set.

Do not edit an already-applied migration — additive only, for the reason `t3o-03` documented.

## UI

Board-owned, in `apps/web/src/board/`.

**Label picker** (the component `t3o-06` will mount in the detail pane): searchable, multi-select,
create-inline when the query matches nothing, and per-label colour editing from the swatch. This is
the prototype's `labelPickerVm` behaviour, minus its single-select `apply` — selecting toggles
membership rather than replacing.

**Card chips**: a card renders 0..n chips. `t3o-06`'s stage-summary table assumes a single type
badge in every row; that row becomes a chip list. Design for the cap: show the first two and a
`+3` overflow, so a heavily-labelled card cannot push the rest of the summary out of the card.

Chip contrast is computed, not chosen — the prototype derives foreground from relative luminance so
a user-picked colour stays readable. Port that calculation; do not hand-pick a foreground per swatch.

Colour editing is a `board.label.update`, so a recolour repaints every card carrying that label
through the normal delta path. No local-only colour state.

## Creation stages — a separate correction, landing here

Cards may be created **only into Backlog, Sprint or Planning**. Later stages describe work the board
has already started shepherding; a card cannot appear mid-pipeline.

This corrects three things:

- **`t3o-06`'s create dialog** — the target-stage picker offers those three stages, not all eight.
  `t3o-06`'s prompt currently says "allow any stage the move rules allow"; it does not.
- **The decider** — `board.card.create` rejects any other stage, with a test. This is the same class
  of assertion as `t3o-03`'s "no create path may land a card in Building", generalised.
- **`t3o-05`'s columns** — the inline add button appears only on those three columns. It is currently
  on all eight, and for non-Backlog columns it composes create + move, which `t3o-06` is replacing
  with a `stage` on the create command anyway.

A card still *reaches* later stages the only way it ever could: by being moved, under D18's
human gate.

## Out of scope

- Filtering or grouping the board by label. Obvious next step, not needed to set one.
- Per-project label catalogues. The prototype's catalogue is global across projects and cards
  already span projects; global is the simpler model and nothing here precludes scoping later.
- MCP label tools (`t3o-08` territory).

## Verification

- Creating a label with a case-insensitively colliding name is rejected.
- Two labels created back to back get different swatch colours.
- Recolouring a label repaints every card carrying it, via delta, with no snapshot refetch.
- Deleting a label removes it from the picker; cards carrying it still render it, muted; undelete
  restores it.
- A card cannot exceed the label cap.
- Byte-budget tests still pass at 10 and 1,000 cards, with cards at the label cap.
- The migration converts every existing card's type to exactly one label, and a from-empty replay
  reproduces an identical read model.
- Create is rejected for every stage except Backlog, Sprint and Planning; the add button is absent
  from the other five columns.
- Core-only diff audit shows exactly the new aggregate-kind widenings and nothing else.
