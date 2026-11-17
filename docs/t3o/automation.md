# Card automation: the contract

Automation is how a card goes from Planning to merged without a person. Users turn the toggles on and
walk away for hours, so each toggle is a promise. A card that stops at a gate whose toggle is on has
broken that promise, and the user only finds out when they come back to it. This page says what each
toggle promises. When the code and this page disagree, the code is wrong.

User-facing wording lives in `docs/user/board-auto-plan.md`, `board-plan-review.md` and
`board-auto-merge.md`. Those pages must not promise less than this one.

## The toggles

1. **Auto-plan.** The planning process runs on its own. The agent asks the user nothing: it answers
   its own questions, makes every call, and logs each decision on the card.
2. **Auto plan review** (the plan review's **Unattended** setting). When the plan review starts, the
   agent works through every finding on its own, answering questions and making calls. It flags the
   contentious calls in the card summary (decisions marked Unclear or Important) and does not stop
   to ask.
3. **Auto sign-off.** When the plan is complete, the card moves to Ready. If a split was approved
   beforehand, the card is split first and then the parent moves to Ready.
4. **Auto-build.** A card in Ready moves to Building, including one that has only just arrived in
   Ready. "Ready" covers every way in: auto sign-off, a human approval, a dependency finishing, a
   restart, or the toggle being turned on while the card is already there.
5. **Auto-merge.** A card merges into its target branch as soon as it reaches Ready for merge. If
   the merge conflicts, the conflicts are resolved automatically and the merge goes ahead.

The toggles chain. A card with all five on goes from Planning to merged with no human step, apart
from approving a split, which only a person can do.

## Rules every toggle obeys

- **Events for speed, the tick for certainty.** Each gate fires from the event that put the card
  there, so a clean run responds at once. The 30-second tick, and the boot pass, re-check every
  card's current state against every gate and fire whatever is due, so a restart, a missed or
  re-delivered event, or a toggle turned on late costs at most 30 seconds. Both paths ask the same
  question ("is this gate due now?"), so they cannot disagree. A card resting at a gate whose
  toggle is on, past one tick, is a bug.
- **Never stall silently.** When a toggle cannot act (dependencies not met, no capacity, a refused
  move, a merge it cannot resolve), the card shows why, in the status colour for that state
  (`docs/t3o/status-colours.md`), and the gate acts by itself once the obstacle clears.
- **Only a person turns a toggle off.** Dragging a card backwards turns off the toggle for the stage
  it left (see `board-auto-plan.md`). Nothing else turns a toggle off, and a failure never does.
