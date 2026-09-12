---
id: t3o-22
title: Review round controls — a loop that runs out of rounds must hold, not graduate
phase: 3
prerequisites: [t3o-15, t3o-16]
---

# Review round controls

t3o-16 shipped the review loop with two exits and one behaviour. A round that closes clean has
*converged*: the reviewer read the branch and found nothing blocking. A loop that burns its last
round with criticals still open has *failed to converge*: nobody signed anything off, the code is
exactly as unreviewed as it was, and the loop simply ran out of budget. Today both return the same
thing:

```ts
// reviewLoopExecutor.ts:170
// The round cap: the loop check's second condition failed, so the loop ends
// exactly as a converged one does — `succeeded`, the stage may auto-advance —
return { kind: "complete", outcome: "succeeded" };
```

`advanceStage` moves the card on any `succeeded` plan whose stage has `autoAdvance`, and the review
stage's `autoAdvance` **defaults to `true`** (`board.ts:3985`). So a card whose reviewer raised five
criticals it never resolved auto-graduates to Ready for merge, indistinguishable from one that
passed. That is the failure mode the loop exists to prevent.

It is also a regression, not an oversight. t3o-16 D8 and acceptance criterion 7 both specify the
opposite — *"Exhausting `rounds` completes the stage `blocked`, leaves the card in Code review, does
not auto-advance, and leaves open findings visible"* — and the original implementation did that.
PR #40 conflated the two exits, flipped `autoAdvance` on, and rewrote the test to assert the
inverse of the criterion it is still named after:

```ts
// reviewLoopExecutor.test.ts:185
it("AC7: exhausting the round cap ends the loop succeeded (the stage may auto-advance)", …)
```

The Review pane already knows better: `deriveBoardReviewLoop` derives a distinct `"round-cap"`
status and paints an amber pill for it. The pane is telling the truth about a card that has already
left the column.

Behind the defect sits a missing capability. When a loop stalls, the useful responses are *give it
more rounds*, *give the reviewer a better model*, or *stop wasting rounds and let me look*. None
exist: `rounds` is a board-wide stage setting, phase models are board-wide, and there is no way to
halt a loop short of its cap. The card face says nothing either — `BoardCardShell` has carried
`roundCurrent`, `roundMax`, `severity*` and `issues*` since t3o-04 and **no projector has ever
populated them**, so the column shows no sign a card's review is in trouble.

## Goal

A review loop that ends without convergence **holds the card and says so** — on the card face, in
the pane, and in what the reactor does next. From that hold, the user can extend the budget, escalate
the reviewer's model, or advance manually. And the budget, the per-round reviewer model and an
early stop are controls on the run, not settings you have to go change for the whole board.

## Scope

**In.** The cap's terminal outcome; per-card review overrides (round budget, per-round review model,
stop-after-round) with their command, decider, projector, migration and reactor re-plan path; the
card-face review summary the shell has always had fields for; the pane's no-convergence block, round
stepper and future-round settings drawer; the detail pane's *Stop after this round* button.

**Out.** The convergence rule itself — the loop still converges when a round's **review** raises no
blocking finding, so a fixed critical is always confirmed by a fresh pass. (The prototype settles a
round whose issues are merely all dispositioned; that is mock simplification and is explicitly not
adopted.) The prototype's fourth `assess` phase is likewise out — the shipped loop's three phases
stand. No change to severity vocabulary, payload schemas, worktrees, slots or the recovery ladder.

## Locked decisions

### D1 — The cap is a hold, not a success

`reviewLoopDecision` returns `{ kind: "complete", outcome: "blocked" }` when the round loop falls
through. That restores t3o-16 AC7 and needs nothing else: `advanceStage` is already gated on
`succeeded`, so the card stays in Code review with its findings and its worktree intact.

`autoAdvance` keeps its `true` default. Its meaning narrows to what it should always have meant —
*advance on convergence* — and the doc comment at `board.ts:3981`, which currently names the round
cap as one of the exits that advances, is corrected to say the opposite. A user who wants a stalled
loop to graduate anyway does it with the pane's explicit *Advance* button (D8), which is a decision
someone made rather than a default nobody saw.

**No new `BoardStepOutcome` literal.** The cap and a malformed payload both terminate `blocked`,
and the two are already distinguishable where the distinction is used: `deriveBoardReviewLoop`
yields `"round-cap"` vs `"unreadable"` from the completions themselves. Adding a fourth outcome
would mean a schema change, a migration and a decider edit to express something the read model
already expresses.

### D2 — Per-card review overrides live on the card

A nullable JSON column `review_overrides` on `board_cards` (migration 025), guarded and additive
exactly like 011's `worktree` and 022's `pull_request`, decoding to `null` so a from-empty replay of
a pre-t3o-22 log matches a rehydrated row.

```ts
BoardCardReviewOverrides = {
  /** Per-card round budget. Null means the stage setting governs. */
  rounds: number | null
  /** Hold the loop once this round closes, even if budget remains. Null = run on. */
  stopAfterRound: number | null
  /** Review-phase model per round number, for rounds not yet run. */
  roundModels: Record<string, BoardModelSelection>
}
```

On the card rather than in a new table because the reactor reads it on **every** re-plan, in the
same breath as `card.humanInLoop` — the same per-card-scalar-override shape t3o-15 D6 already
established. A side table would put a join in the planning path for three scalars.

`roundModels` is keyed by round number as a string, and entries for rounds already run are inert:
the executor only ever reads the entry for the round it is about to plan, so a stale key is history,
not a contradiction. `BoardModelSelection.options` already carries reasoning effort (t3o-21), so
the drawer's model + effort + access ride one value with no new schema.

### D3 — The budget is per-card and floored at what has **started**

```
effectiveReviewRounds(card, exec) = clamp(card.reviewOverrides?.rounds ?? exec.rounds,
                                          roundsStarted, BOARD_REVIEW_MAX_ROUNDS)
```

with `BOARD_REVIEW_MAX_ROUNDS = 10`.

**A round that has started can never be removed.** The floor is not "rounds that recorded a
completion" — it is `roundsStarted`, the highest round the loop has actually entered:

```
roundsStarted = max(highest round with any succeeded completion,
                    round of the card's live step, if its step id parses to one)
```

The distinction matters exactly where it is dangerous. Round 4's review is dispatched and running in
a worktree; no completion exists for it yet. Flooring on completions alone would let `−` drop the
budget to 3 while that agent is mid-turn, leaving a live step the executor's walk will never reach —
its completion lands against a round beyond the cap, and the loop is wedged with an orphaned run
holding a concurrency slot. Flooring on *started* refuses that write outright.

It is enforced in the **decider**, not merely greyed out in the UI: the client is not the guard, and
a stale pane must not be able to strand a running round.

Raising the budget and "run another round" are the same intent, so they are the same write: the
pane's *Run round N+1* button sets `rounds = N + 1`. There is no separate resume command.

`deriveBoardReviewLoop` already takes `maxRounds` as an argument and already renders rounds recorded
beyond a since-lowered cap as skipped history, so the client side of a shrinking budget needs no new
logic — only the effective value passed in.

### D4 — A round override changes the review phase only

The executor's `resolvePhaseModel` gains the round number. The override applies **when
`phase === "review"`**; triage and adjudicate keep their configured per-phase models.

The override exists to escalate the *reviewer* when a loop will not converge — a sharper pair of
eyes on the same branch. Re-modelling the triager is a different decision (it changes who is writing
the code), and silently bundling it into one dropdown would make "put round 4 on Opus" mean more
than it says. The drawer is labelled *Review model for round N* accordingly, and its default option
reads `Same as round N-1` — meaning "inherit", stored as no entry at all rather than a copied value,
so changing the stage setting still moves un-overridden rounds with it.

### D5 — Stop-after-round is a round number, not a flag

`stopAfterRound: N` means: let round N finish its phases, then hold instead of planning round N+1.
The executor applies it at the loop check, before the budget check — a stop is the user's decision
and outranks remaining budget. It terminates `blocked`, like the cap, and the pane distinguishes the
two from the completions (a loop that held at round 3 of 6 stopped; one that held at 6 of 6 capped).

A number rather than a boolean because it is self-superseding: extending the budget to round 5 while
`stopAfterRound` is 3 is a contradiction the decider resolves by clearing the stop, and a bare
boolean gives it nothing to compare. It also lets the button read *Stopping after round 3* instead
of an ambiguous toggle state.

### D6 — Re-planning on card update stays generic

Extending a stalled loop must make the reactor plan again, and `handleCardUpdated` currently returns
early on a terminal step status (`supervisorReactor.ts:2334`) — which a settled loop always has.

The fix is **not** `if (stage.role === "review")`; that would be the first leak of review logic into
the reactor and would break t3o-16 AC10. Instead `handleCardUpdated` gains a generic tail: when the
card's step state is terminal and its stage `autoExecute`s, ask the stage's executor to plan again
and act **only on a `run` plan**. A `complete` plan on a re-plan is a no-op — the stage already
settled, and re-running `advanceStage` from here is exactly the double-advance this must not cause.

`SimpleStageExecutor` is unaffected: its one step is recorded, so it plans `complete` and the tail
does nothing. The review loop plans round N+1 and the ordinary select-step → schedule → spawn path
takes over.

### D7 — The card face gets the summary its shell was built for

The projector maintains a `review_summary` JSON column on `board_cards`, written when a review step
completion lands and when review overrides change. Both shell producers — the SQL query at
`projection.ts:688` and the JS delta path — read it as a plain column, exactly as they already do for
`prNumber`. Parsing finding payloads in SQL is not on the table.

It is a **projection cache, never a source of truth**: the pane keeps deriving from completions via
`deriveBoardReviewLoop`, so the two can be compared and the cache can be rebuilt from the ledger.

It fills the shell's long-dormant `roundCurrent` / `roundMax` / `severity*` / `issues*` fields and
adds one new optional key:

```ts
reviewOutcome: "running" | "converged" | "round-cap" | "stopped" | "unreadable"
```

`boardCardSummary`'s `review` case already emits `round`, `severity` and `issues` items, and
`BoardCardSummaryRow` already renders all three — round pips, the `c / i / n` severity chip and the
issue tally. Both are dead code today for want of data. They need only the outcome flag: the row
paints the `NO CONVERGENCE` chip and turns **every** round pip amber when the outcome is
`round-cap` — the whole strip, not just the last, because the finding is about the loop and not
about round 5.

### D8 — The pane's no-convergence block

Above the round list, when the loop ended `round-cap` or `stopped`:

- an amber-bordered panel headed **Round limit reached without convergence**;
- the count line — *All N rounds ran and round N still closed with K unsettled issues. The loop
  stops here and will not hand the task to Ready for merge on its own.*;
- **Run round N+1** (primary — writes `rounds = N + 1`) and **Advance to `<next stage>`** (an
  ordinary `board.card.move`, gated like every other transition).

The round strip gains `−` / `+` at its right, and a click on a **future** round segment opens an
inline settings drawer for that round's review model and effort. The detail pane's button column
gains **Stop after this round**, shown only while a round is in flight, which toggles
`stopAfterRound` between the current round and null.

Every one of these is a `board.card.update` carrying `reviewOverrides`; no new command type.

### D9 — What each state looks like

| Loop state | Card face | Pane pill | Pane body |
| --- | --- | --- | --- |
| running | pips, current filled | accent | phase progress |
| converged | pips, `Settled` | emerald | — |
| round-cap | **all pips amber**, `NO CONVERGENCE` | amber | no-convergence block |
| stopped | all pips amber, `STOPPED` | amber | held block, *Run round N+1* |
| unreadable | pips amber, `UNREADABLE` | destructive | existing halt note |

## Acceptance criteria

1. A loop that exhausts its rounds with blocking findings outstanding completes the stage `blocked`,
   the card **stays in Code review**, and `advanceStage` is not called — with the review stage's
   `autoAdvance` left at its `true` default.
2. A loop whose final round raises no blocking finding still completes `succeeded` and still
   auto-advances. Convergence behaviour is unchanged in every respect.
3. `reviewLoopExecutor.test.ts`'s AC7 asserts `blocked`, and a reactor-level test proves no
   `board.card.move` is dispatched for a capped loop.
4. The `−`/`+` stepper changes only that card's budget; a second card in Code review is unaffected,
   and the board-wide `rounds` setting is unchanged.
5. Lowering the budget below a round that has already **started** is **rejected by the decider**,
   not merely disabled in the UI — including when that round is still in flight with no completion
   recorded, so a running round can never be stranded beyond the cap.
6. *Run round N+1* on a settled-at-cap card causes the reactor to plan and spawn `review@N+1`
   without any stage move, and the pane returns to `running`.
7. A round override set on round 4 makes `review@4` run on the overridden model; `triage@4` and
   `adjudicate@4` run on their **configured per-phase** models.
8. An un-overridden future round inherits the stage's review-phase model, and changing that setting
   moves it — the drawer's default stores no entry.
9. `stopAfterRound = N` holds the loop after round N's phases complete even when budget remains, and
   raising the budget past N clears the stop.
10. A card in Code review renders round pips, severity and issue tallies on the column card face;
    a capped loop renders every pip amber plus a `NO CONVERGENCE` chip.
11. The `review_summary` cache agrees with `deriveBoardReviewLoop` over the same completions, and is
    rebuilt correctly by a from-empty replay.
12. `grep` still finds no branch on the `review` role outside the executor registry and the settings
    panel — the reactor's re-plan tail is role-agnostic (t3o-16 AC10 holds).
13. A non-review stage's behaviour under `board.card-updated` is unchanged: `SimpleStageExecutor`
    plans `complete` on the re-plan tail and nothing happens.
14. Replay equals rehydration for a log written before this spec: `reviewOverrides` decodes to null
    and `review_summary` to absent.

### Watched-run items

- A real card is driven to its cap, held, extended by two rounds with the reviewer escalated to a
  stronger model, and converges — with the pane and the card face agreeing at every step.
- A loop is stopped mid-run with *Stop after this round* and does not start the next round.

## Files

| File | Change |
| --- | --- |
| `apps/server/src/board/reviewLoopExecutor.ts` | cap → `blocked` (D1); stop-after-round check (D5); round-scoped review model (D4) |
| `apps/server/src/board/supervisorReactor.ts` | generic re-plan tail on `board.card-updated` (D6) |
| `apps/server/src/board/decider.ts` | validate `reviewOverrides` on update — budget floor, stop/budget reconciliation (D3/D5) |
| `apps/server/src/board/projector.ts` | maintain `review_summary` (D7); apply `reviewOverrides` to the aggregate |
| `apps/server/src/board/projection.ts` | `review_summary` on both shell producers (D7) |
| `apps/server/src/board/migrations/025_BoardCardsReviewOverrides.ts` | **new** — `review_overrides`, `review_summary` columns |
| `packages/contracts/src/board.ts` | `BoardCardReviewOverrides`; card field; `reviewOverrides` on the update command; `reviewOutcome` shell key; `effectiveReviewRounds`; corrected `autoAdvance` comment |
| `packages/client-runtime/src/operations/boardCommands.ts` | carry `reviewOverrides` through `updateBoardCard` |
| `apps/web/src/board/boardReviewLoop.ts` | `"stopped"` status; effective-budget input |
| `apps/web/src/board/BoardCardReviewPane.tsx` | no-convergence block, round stepper, future-round drawer (D8) |
| `apps/web/src/board/BoardCardDetailView.tsx` | *Stop after this round* button (D8) |
| `apps/web/src/board/boardCardSummary.ts` | emit the `reviewOutcome` item from the review case (D7) |
| `apps/web/src/board/BoardCardSummaryRow.tsx` | `NO CONVERGENCE` chip and amber pip tint (D7/D9) |
