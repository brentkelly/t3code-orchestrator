---
id: t3o-12
title: Building stage automation — the first automated stage, end to end
phase: 2
prerequisites: [t3o-06, t3o-07, t3o-11]
---

# Building stage automation

The MVP's payoff: drag a card into Building and walk away. Everything built in `t3o-08` through
`t3o-11` is assembled and proved on one real stage.

## Why Building first

A build step is one long step with an **unambiguous completion contract** — the work is done or it
is not. Planning ends in a judgement call, and review is a multi-round pipeline. Building stresses
the machinery hardest (worktree creation, long runtimes, death, restarts, slots) with the least
ambiguity about what "finished" means.

## Flow

1. **Entry — always human-initiated (D18).** The card enters Building only by a drag or the Ready
   stage's "Begin build" action. Approving a plan lands a card in Ready and it stays there
   indefinitely; nothing in this spec may auto-advance it. The decider rejects entry while
   dependencies are unmet (`t3o-03`).
2. **Recipe snapshot.** The Building recipe is resolved from settings and frozen onto the card
   (`t3o-07`). Later settings edits do not affect this run.
3. **Branch and worktree.** Created lazily, setup script run, plan materialised to `.plans/`, plan
   locked (`t3o-09`). This is a visible step that can fail and retry.
4. **Slot.** Acquired against the build step's provider instance, or the card sits `queued` in
   Building with its position (`t3o-11`).
5. **Build step.** A thread is spawned with the composed envelope (`t3o-10`), scoped to the card's
   worktree, told to implement the plan and to call `board_complete_step` when done.
6. **Progress.** `board_report_progress` updates card activity. Thread state and "Input needed"
   surface on the card summary (`t3o-06`).
7. **Outcomes.**
   - `succeeded` → card advances to Code review. (In the MVP, Code review is a manual stage — the
     pipeline is post-MVP. The card arrives there with its branch, worktree and threads intact.)
   - `blocked` → human gate; card renders "Input needed"; phone notification.
   - `failed` / death / stall → escalating recovery, then a human gate at `maxAttempts`.

## What must be true before this is called done

This is the acceptance gate for the whole MVP, so it is worth being strict:

- A card can go from Ready to a pushed branch with a real implementation **with no human input**.
- Killing the provider process mid-build recovers without human input.
- Restarting the server mid-build recovers without human input.
- A stalled agent (question in prose, then idle) recovers, and does **not** consume a retry when it
  asks properly instead.
- Ten cards queued against a `maxConcurrent: 2` instance run two at a time, in the documented order,
  with queue positions visible and correct throughout.
- A card left in Ready for a week has consumed no disk and no worktree.
- Every failure the board can hit is visible **on the card** — no state that only exists in a log.

## Out of scope

- The Code Review pipeline: rounds, four steps, issue ledger, adjudication, PR creation through
  `SourceControlProvider`. That is the next major workstream and the highest-value one, and it
  depends on this machinery being trustworthy first.
- Planning-stage automation, sub-boards, scheduled cards.

## Verification

Beyond the acceptance gate above, one integrated pass in a real client on a real repository —
watching an actual card build itself, including at least one induced failure and one induced
restart. Everything else in this plan set can be proved with focused tests; this one has to be
watched.
