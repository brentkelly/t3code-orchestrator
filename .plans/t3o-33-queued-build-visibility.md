---
id: t3o-33
title: Queued-for-build is visible and actionable inside the card
phase: 3
prerequisites: [t3o-11, t3o-32]
---

# Queued-for-build visibility

A card holding for a concurrency slot says `Queued #2` on the board and says **nothing** once you
open it. The modal shows the leftover planning conversation — no build thread exists yet, because a
queued step spawns none — so the card reads as dead. This makes the queued state legible everywhere
the card is, and gives it the two actions it has always lacked: start it anyway, or move it up.

## Goal

Opening a queued card tells you it is queued, where it sits, why it is waiting, that it will start
by itself — and lets you override either half of that (start now, or move to the front).

## Scope

**In**

- A correct, board-wide queue position (today's number is a per-project fiction).
- Queued pill in the card modal header; queued banner in the right rail; queued strip above the
  thread pane; tooltip on the existing board-card pill.
- `Start now` — force-admit past the agent cap. New server command, event, projection column,
  migration and governor path.
- `Move to front` — reorder via the existing `board.card.reorder`, offered only when it would
  actually improve the card's position.

**Out**

- Mobile. There is no board in `apps/mobile`.
- The agent cap setting. `board.concurrency.globalMaxConcurrent` already exists and is already
  exposed in `BoardSettingsPanel`.
- Any change to how the governor *chooses* which queued step runs next.

## Key decisions

### D1 — Queue position is derived on the client, globally

`boardBuildingQueueInfo` (`packages/client-runtime/src/state/board.ts`) numbers one project's
Building column. The governor orders by **stage index desc → already-started first → orderKey**
across every project and every build-mode step, including steps on Code review
(`orderBoardQueue`, `apps/server/src/board/supervisor.ts:272`). So the shipped number can be wrong.

Replace it with `boardBuildQueue(cards, stages)` taking **every card shell in the environment**,
filtering on `queued`, sorting stage-desc → orderKey → cardId, returning
`Map<cardId, { position, total, ahead, startsNext }>`.

*Why not the server:* a position is a view over the whole queue, so one card moving renumbers every
other queued card — a per-card `queuePosition` on the shell would force the projection to re-emit N
shells per delta. That breaks the performance rule for a number the client can already compute.

*The one divergence:* the `started` tiebreak needs step completions, which are detail-only. It only
separates two queued steps at the same stage where one is a re-run, and buying it costs a wire
field. The function documents the divergence in a comment rather than hiding it.

### D2 — Running count and cap come from data the client already holds

`running` = cards with `stepRunning` across the whole environment (the projection already computes
`runningByCard`). `cap` = `board.concurrency.globalMaxConcurrent`, which the modal already receives
as `boardSettings`.

Copy clamps honestly rather than breaking when a force-start pushes past the cap:

- `running < cap` → `2 of 3 agents busy`
- `running >= cap` → `3 of 3 agents busy`
- `running > cap` (post force-start) → `4 agents running (limit 3)`

Followed by `· 1 task ahead` only when `ahead > 0`, then
`It starts on its own when an agent frees up.`

The copy never names a project, because the queue is global and the blocker is frequently on
another board.

### D3 — `Start now` is a real server command

Nothing today admits a step past the ceiling; `BoardStepSlots.acquire` is the only admission path.

- **Contract** `board.card.force-start-step { cardId }` → event
  `board.card-step-force-start-requested { cardId, stepId }`. The command carries no `stepId`: one
  step-state row per card (D4), so the server resolves it and cannot be handed a stale one.
- **Decider** rejects unless the card's live step is `queued`.
- **Migration** `033_BoardCardStepStateForceStart.ts` —
  `ALTER TABLE board_card_step_state ADD COLUMN force_start INTEGER NOT NULL DEFAULT 0`. Appended to
  `BOARD_MIGRATIONS`. Board ledger only, never `persistence/Migrations/`.
- **Governor** a candidate whose state carries `forceStart` is admitted **first** and takes its slot
  through `BoardStepSlots.restore` — the existing unconditional take — not `acquire`. Accounting
  stays balanced, so the single release at every terminal outcome still cancels it and the count
  returns below the cap on its own.
- The flag is cleared by the events that rewrite the step-state row (`admit-step`, `select-step`,
  `settle-step`), so it never leaks into the card's next step.
- The new event triggers a `schedule()` pass, so the click starts the card rather than waiting for
  the next step boundary.
- Force-start does **not** bypass worktree provisioning. The button goes to a local optimistic
  `Starting…` on click; the banner clears when the shell reports the step running.

### D4 — `Move to front` never lies

It reorders through the existing `board.card.reorder`, giving the card an orderKey below the global
minimum among queued cards. But orderKey is the governor's *last* tiebreak, so a card behind one on
a later stage cannot overtake it by reordering at all.

So: compute the projected orderKey, re-derive the position with it, and **offer the button only
when the projected position beats the current one**. A button that visibly does nothing is worse
than an absent one.

### D5 — Queued stays neutral, not violet

**This is a deliberate divergence from the mockup and needs a look.** `docs/t3o/status-colours.md`
locks violet (`--attention`) to *waiting on a human*. A queued card is waiting on a machine and
needs nothing from anyone — it starts by itself. Painting it violet puts an "answer me" colour on a
card with no question, which is the exact misread that doc exists to prevent.

The banner, both pills and the strip use the neutral/muted treatment the shipped board pill already
wears (`bg-muted`, `text-muted-foreground`), with a clock icon. Flipping to `--attention` is a
one-token change if the maintainer overrules this.

### D6 — The queued strip lives above the thread pane, not inside a build tab

The mockup shows the strip inside a `Build` tab. That tab does not exist for a queued card: nothing
is spawned, so there is no build thread and the modal opens on the planning conversation.

The strip therefore renders at pane level, above whatever thread is selected, so it is visible on
every tab. The brief's *"replace the build-thread summary text for `state === queued`"* item is
dropped for the same reason — there is no build thread to summarise.

Strip copy: **Queued #2 for build.** `No agent has picked this up yet.` + inline `Start now`.

### D7 — Queued and blocked both show

The queue banner sits directly above the dependency/blocked banner. Blocked keeps its amber and its
precedence in meaning; the queue banner explains the other half of why nothing is moving.

## Surfaces

| Surface | Change |
| --- | --- |
| Board card (`BoardCardItem.tsx`) | Pill keeps its place; its `BoardHint` carries the full detail string. |
| Modal header (`BoardCardDetailView.tsx`) | `Queued #n` pill in the identity row beside the stage badge, detail as tooltip. |
| Modal right rail | Banner above the dependency block: clock + bold `Queued #2 for build`, one muted detail line, `Start now` / `Move to front`. |
| Thread pane | Pane-level strip + inline `Start now`. |
| Drop toast (`BoardPage.tsx`) | Reuses the new global derivation, so the announced position matches the card. |

## Acceptance

1. A queued card opened from any project shows the header pill, the rail banner with its position
   and reason, and the thread-pane strip.
2. The position shown is the governor's board-wide order, not the project's column index: a card
   queued behind another project's Code review step reads `#2`, not `#1`.
3. `Start now` admits the card with the cap full: `heldTotal` reaches `cap + 1`, the step spawns,
   and the slot is released exactly once when it settles (no leak).
4. `Move to front` reorders the card and every other queued card's label updates; the button is
   absent at position 1 and absent whenever the reorder could not improve the position.
5. A card that is queued *and* dependency-blocked shows both banners, queue above blocked.
6. Force-starting past the cap renders `4 agents running (limit 3)` rather than `4 of 3`.
7. No new field crosses the wire.

## Tests

- `boardBuildQueue` — global across projects, stage-desc dominance, orderKey then cardId tiebreak,
  non-queued excluded, empty when nothing is queued.
- The move-to-front planner — returns `null` when the reorder cannot improve the position.
- The copy builder — all four running/cap branches and the `ahead === 0` case.
- Decider — force-start on a queued step emits; on a running, settled or absent step it rejects.
- Supervisor — a force-started candidate is admitted while the global cap is saturated, and its
  slot is released on settle.
- `BoardCardDetailView` — banner renders position and both buttons; `Move to front` absent at #1.

## Verification

Per-package, never repo-wide: `vp test run` on the touched files, `vp typecheck` in
`apps/server`, `apps/web`, `packages/contracts`, `packages/client-runtime`, and `vp lint apps/web`
(the board plugin rules are missed by a whole-tree lint).
