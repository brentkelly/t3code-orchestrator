---
id: t3o-29
title: Per-card model overrides — Build and Review, under the card's kebab
phase: 3
prerequisites: [t3o-21, t3o-22, t3o-25]
---

# Per-card model overrides

Every model the board runs on is a **workspace** setting. `BoardStageExecutionSimple.model`,
`BoardStageExecutionReview.phases.*.model` and their `runtimeMode` siblings live in
`settings.json` and govern every card on the board equally. The one exception is the review
loop's per-round escalation (t3o-22, D4): `BoardCardReviewOverrides.roundModels[N]` re-points
round N's reviewer for one card.

That exception exists because the general case was needed and only the acute form got built. A
card that is architecturally load-bearing wants a stronger builder from the start, not after
three rounds have failed to converge. A card touching a hostile dependency wants
`approval-required` for its build, without dragging every other card on the board down with it.
Today both mean editing the workspace pipeline, running the card, and editing it back — which
races every other card in flight.

## Goal

A card can name the model, reasoning and access level its **Build** and **Review** runs use,
overriding the workspace defaults for that card alone. It lives under the card modal's kebab
menu, because it is a deliberate, occasional act and the card header is already full.

## Scope

**In.** A per-card model override for the `build`- and `review`-role stages; its column,
contract, command, decider validation, projector and projection; resolution in the reactor and
the review executor; parent→child resolution for sub-board cards; the kebab entry, the anchored
popover, the header pill and the reset affordance.

**Out.** Overrides for the `plan`, `merge` and custom stages — the row list is fixed at two
(D1), though the storage is not. Changing what `RuntimeMode` means. The board MCP toolkit: the
override is a UI affordance, and nothing in the agent-facing toolkit needs to set it. Any change
to the existing per-round drawer beyond the new fallback level it reads through.

## Design decisions

### D1 — Two rows, resolved by role; stored by stage id

The popover renders exactly two rows, **Build** and **Review**, resolved through
`effectiveBoardStageRole` to the stages holding the `build` and `review` roles. Roles are seeded
and unique (the decider rejects a second holder), so the mapping is exact, and a board whose
role-holder was deleted simply renders one row.

The **storage** is keyed by stage id, not by role:

```ts
BoardCardModelOverrides = Record<BoardStageId, BoardCardStageModelOverride>
```

Two rows is a judgement about what is worth putting in a popover; it is not a claim about the
schema. t3o-15 D13 deliberately deleted the fixed stage-label map because stages are user-defined,
and keying the column by role would reintroduce exactly that assumption at the persistence layer —
where undoing it costs a migration. Keying by stage id costs nothing today and makes a third row
a UI change alone.

### D2 — The value shape mirrors the round override exactly

```ts
BoardCardStageModelOverride = { ...BoardModelSelection.fields, runtimeMode?: RuntimeMode }
```

Identical to `BoardReviewRoundOverride` (t3o-22, D4) — the existing type is generalised and the
old name kept as an alias, so nothing that reads a round override changes.

An override is **a model plus what it changes**: with no model there is no record, and the access
level rides along or inherits. This means a card cannot change its permissions without also
pinning its model. That is the accepted cost of one shape at both levels — one resolver arm, one
mental model, and `ModelRow`'s existing `hideRuntimeMode` prop already expresses it (the round
drawer passes it for precisely this reason, `BoardCardReviewPane.tsx:484`).

Reasoning rides the model in `options`, as it already does everywhere: the option vocabulary is
per-model and means nothing without one.

### D3 — What the Review row re-points

The card's Review override sets the **review phase's default model for every round**, and is
beaten by a round that names its own. Precedence, narrowest first:

```
card-round override  (roundModels[N], t3o-22 D4)
  → card-stage override      (this spec)
    → parent card's stage override  (D4)
      → phase config             (phases.review.model)
        → stage fallback           (config.model)
```

Triage and adjudicate keep their configured per-phase models. This is t3o-22 D4's rule lifted one
level, and it keeps that decision's promise: "Review model" escalates the **reviewer**, and never
quietly re-models the agent that rewrites the code. `resolvePhaseModel` and
`resolvePhaseRuntimeMode` (`reviewLoopExecutor.ts:100`/`:118`) gain one fallback arm each; the
round-override arm is untouched and still wins.

`roundModels` itself is **not** inherited from a parent. A round override names a specific round
of one card's own loop; a parent's round 4 has no relationship to a child's round 4.

### D4 — Sub-board children resolve through the parent at run time

A child card with no override of its own resolves its parent's. Not a copy taken at split time —
a live lookup, so editing the parent moves every child that has not set its own.

"This work needs Opus" is a property of the work, and a split fans one piece of work into eight
cards. Snapshotting at creation would make the parent's later edits silently not apply; resolving
live means the parent stays the place you set it.

The cost is normally a lookup in the planning path, and here it is free: `beginStageRun` already
holds the board aggregate (`const board = yield* readBoard`, `supervisorReactor.ts:1112`), so the
parent is an in-memory `board.cards.find`. Sub-boards are one level deep — `decider.ts:609`
rejects a grandchild — so there is no chain to walk and no cycle to guard.

**Consequence, accepted (D5 makes it visible):** on a child, "no override" means "inherit the
parent", so clearing a child's override re-inherits rather than falling back to the workspace. A
child that must run the workspace default sets that model explicitly.

### D5 — The row names where its default came from

Because there are now three levels a card can be inheriting from, the row's default option says
which one:

| The card is inheriting | Default option reads |
| --- | --- |
| the workspace setting | `Sonnet 4.7 (default)` |
| a parent card's override | `Opus 4.8 (from T3O-41)` |

This is what makes D4's consequence legible rather than mysterious: a child showing
`(from T3O-41)` is visibly on its parent's model, and the fix — set it explicitly — is obvious
from the same control. Without it, D4 is a trap.

### D6 — Edits apply to the next run, never the live one

`BoardCardStepState` freezes `model`, `modelOptions` and `runtimeMode` onto the run row at stage
entry (t3o-21 D4, t3o-15 D12), so a running agent keeps the authority and model it started with.
An override edit is read the next time a step is **planned**: the next review round, a retry, or
a re-entry into Building.

Nothing new is needed to make this safe, and nothing new fires. The generic re-plan tail on
`board.card-updated` (t3o-22, D6) acts only on a `run` plan: `SimpleStageExecutor` plans
`complete` for an already-recorded step, and a settled review loop plans `complete`/`blocked`
because the budget is unchanged. So editing a model override never itself spawns a run — only
changing `rounds` does, exactly as today.

The popover states this inline while a step is live, rather than disabling the controls: setting
the model for the next round mid-round is a legitimate and common intent.

### D7 — Surface: kebab → anchored popover

Per the prototype (`.plans/prototype/t3o.dc.html`), which is the UI reference for layout and copy:

- The kebab gains a **Models** item above `Archive card`, separated by a rule, with the current
  state summarised right-aligned on the item: `Default`, `Build`, `Review`, or `Build · Review`.
- Selecting it **closes the menu** and opens a ~328px popover anchored to the same trigger,
  headed *Models for this card* with the sub-line *Overrides the workspace defaults from Settings
  for this card only*, and a **Reset** button shown only when something is set.
- Each row is a `ModelRow` (`components/settings/BoardModelRow.tsx`) — the same control the
  pipeline settings and the round drawer use, giving model, reasoning/traits and access in one
  row for free — under a label and note: **Build** *Runs the plan in the worktree*, **Review**
  *Adversarial review rounds*.
- The card header shows a small pill **only when an override is set**, summarising it
  (`Build sonnet-4.7`, or `Custom models` when both are), with both stages' resolved values in
  its tooltip. It opens the same popover.

A popover rather than a `MenuSub`: `ModelRow` opens a Popover for the model list and a menu for
traits/access, and nesting those inside an open menu stacks three focus traps where selecting a
model is an outside-pointerdown on the menu containing it. A popover keeps it two deep. A dialog
was rejected as too heavy a gesture for two dropdowns.

The pill is the one addition to an interface we are otherwise keeping clear, and it earns its
place: an override that changes what a card spends and what authority it runs under should not be
invisible from the card. It costs nothing on a card that has not set one.

## Layer-by-layer change list

| Layer | File | Change |
| --- | --- | --- |
| Contracts | `packages/contracts/src/board.ts` | Generalise `BoardReviewRoundOverride` → `BoardCardStageModelOverride` (alias retained); `BoardCardModelOverrides`; `modelOverrides` on `BoardCard` (decoding-default null) and on the update command; a `resolveBoardCardStageModel` helper owning D3/D4's precedence |
| Migration | `apps/server/src/board/migrations/029_BoardCardsModelOverrides.ts` | **new** — guarded additive `model_overrides TEXT` on `board_cards`, NULL-defaulting exactly as 025 |
| Server | `apps/server/src/board/projection.ts` | `model_overrides` on the row schema, the insert, and both shell producers |
| Server | `apps/server/src/board/projector.ts` | Carry `modelOverrides` on the aggregate (null seed at :197) |
| Server | `apps/server/src/board/decider.ts` | Accept `modelOverrides` on `board.card.update`, merging as `reviewOverrides` does (:1006); reject an entry for an unknown stage id |
| Server | `apps/server/src/board/supervisorReactor.ts` | Resolve the card's (or parent's) override ahead of `exec.model`/`exec.runtimeMode` at the three `resolveBoardStageModelSelection` sites (:1196, :1471, :1621) |
| Server | `apps/server/src/board/reviewLoopExecutor.ts` | One fallback arm each in `resolvePhaseModel` / `resolvePhaseRuntimeMode` (D3) |
| Client | `packages/client-runtime/src/operations/boardCommands.ts` | Carry `modelOverrides` through `updateBoardCard` |
| Web | `apps/web/src/board/BoardCardModelsPopover.tsx` | **new** — the two-row popover, reset, and the inheritance-source labelling (D5) |
| Web | `apps/web/src/board/BoardCardDetailView.tsx` | Kebab item + summary, popover state, header pill (:1099) |
| Web | `apps/web/src/components/settings/BoardModelRow.tsx` | Allow the default-option label to name its source (D5) |

## Acceptance criteria

1. A card with a Build override spawns its Building step on that model, reasoning and access
   level; a card without one is unchanged and still runs the workspace setting.
2. A card with a Review override runs **every** round's review phase on it; `triage@N` and
   `adjudicate@N` run on their configured per-phase models.
3. A round override still beats the card override for the round it names, and a round without one
   falls through to the card's — the full D3 precedence, tested at each level.
4. A sub-board child with no override of its own runs its parent's; setting one on the child
   overrides it; editing the parent moves an un-overridden child on its next planned step.
5. The child's row reads `(from <PARENT-KEY>)` when inheriting a parent override and `(default)`
   when inheriting the workspace.
6. Editing an override while a step is live does not change that step's model, authority, or
   spawn a new run; the next planned step uses the new value.
7. `board.card.update` rejects a `modelOverrides` entry keyed by a stage id the board does not
   have.
8. Replay equals rehydration for a log written before this spec: `modelOverrides` decodes to null
   and a pre-existing row rehydrates to null.
9. The kebab summarises the state (`Default` / `Build` / `Build · Review`); the header pill
   appears only when an override is set; **Reset** clears the card back to workspace defaults.
10. `grep` finds no new branch on the `review` role outside the executor registry, the settings
    panel and the popover's own row list (t3o-16 AC10 holds).

### Watched-run items

- A card is pinned to a stronger build model, run, and observed to spawn on it; the workspace
  setting is confirmed unchanged for a sibling card run at the same time.
- A card is split, the parent given a Review override, and a child observed to review on it
  without the child having been touched.
