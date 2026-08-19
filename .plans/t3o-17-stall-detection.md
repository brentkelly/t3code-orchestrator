---
id: t3o-17
title: Stall detection — consecutive-stall recovery, loud escalation, invocation ceiling
phase: 2
prerequisites: [t3o-15]
---

# Stall detection

An unattended step that ends a turn without calling `board_complete_step` is nudged and resumed
(D13, `supervisor.ts:127`). That is correct and it is bounded — `attempt` against `maxAttempts`,
then escalate, "which never loops."

But the counter measures the wrong thing, and the escalation is invisible.

## The three defects

**1. `attempt` is cumulative, not consecutive.** It counts every nudge for the life of the step and
never resets. A six-hour unattended build nudged three times across three genuinely productive
stretches escalates on the third, even though it was never stuck. Meanwhile an agent wedged in a
ninety-second stop/nudge cycle burns exactly the same budget. The number is a poor proxy for the
thing worth capping, in both directions.

**2. Escalation is silent.** `recoveryDecision` returning `escalate` dispatches
`board.card.request-input` and the step lands in `awaiting-input`
(`supervisorReactor.ts:615-634`) — the **same** status an agent reaches by asking an ordinary
question. A card that gave up after N stalls and a card mid-conversation with its human look
identical on the board. On forty cards, the one that needs rescuing is unfindable without opening
each.

**3. A stalled card holds its concurrency slot forever.** Recovery deliberately never releases the
slot ("a retry keeps its place", `supervisorReactor.ts:637`), which is right for a retry — but an
escalated step has no live thread doing anything. It is parked until a human appears, and until then
it occupies a slot that bounds real work. With t3o-16 landed the exposure compounds: rounds ×
phases × attempts is deep, and every level of it is silent.

## Goal

Cap *consecutive stalls* rather than total nudges, make giving up visible, and stop a parked card
holding capacity.

## Scope

**In**

1. Split the counter: `attempt` (total) and `stallCount` (consecutive, gated by `maxAttempts`).
2. A progress signal that resets `stallCount`.
3. A distinct `stalled` step status and its card treatment.
4. Slot release on escalation.
5. A per-stage-entry invocation ceiling above the per-step ladder.

**Out**

- Any change to the nudge text or the escalation question. Both are fine.
- Notifications / push. Making the state visible on the board is this spec; routing it elsewhere is
  a later one.

## Locked decisions

### D1 — Two counters, each measuring one thing

`BoardCardStepState` carries both:

| | Counts | Gated by | Resets |
| --- | --- | --- | --- |
| `attempt` | every invocation of this step this stage entry | D5's ceiling | on stage entry |
| `stallCount` | **consecutive** stalls with no progress between them | `maxAttempts` | on progress (D2) |

`recoveryDecision` switches to comparing `stallCount` against `maxAttempts`. `attempt` stays for
display ("attempt 7") and for D5.

Two counters rather than redefining one, because both facts are worth knowing: "this has stalled
twice in a row" is the escalation trigger, "this step has been invoked eleven times" is what tells a
human the card is a swamp even though it keeps inching forward.

**Default `maxAttempts` rises from 3 to 5.** Safe only because of the reset: five *unproductive*
consecutive stops is a wedged agent, where five cumulative nudges was often just a long job.

### D2 — Progress is an explicit signal, not an inference

`stallCount` resets to zero when, since the last nudge, the step's thread has either:

- written a card activity entry (`board_report_progress`, which already exists and already stores
  `threadId` — `handlers.ts:341`), or
- produced a new commit on the card's branch.

`BoardCardStepState` gains `lastNudgeAt` so "since the last nudge" is answerable.

`recoveryDecision` stays **pure**: the reactor resolves a `progressedSinceLastNudge: boolean` and
passes it in. Git and SQL stay out of the decision function, exactly as t3o-15 D15 keeps them out of
`planNext`.

**The unattended envelope must ask for progress reports.** This is load-bearing, not a nicety: if
the agent never calls `board_report_progress` and never commits, progress is unobservable, the reset
never fires and D1 degrades to today's behaviour with a higher ceiling — strictly worse. The
unattended postamble (t3o-15 D5) gains a line instructing periodic `board_report_progress` calls on
long work.

*Rejected:* inferring progress from token output or tool calls. Both are noise — a wedged agent
emits plenty of tokens. The point is to detect *work*, and a progress report or a commit is the
agent asserting it did some.

### D3 — `stalled` is its own status

`BOARD_STEP_STATUSES` gains `stalled`, distinct from `awaiting-input`.

| Status | Means |
| --- | --- |
| `awaiting-input` | the agent asked a question; the work is healthy and paused |
| `stalled` | recovery gave up; nobody is working and nobody will until a human acts |

The escalation path sets `stalled` and still asks its question, so the human gets both the signal and
the choice. The card renders it distinctly — this is the "loud" half — and the board offers a way to
find every stalled card without opening them.

`stalled` is **not** terminal (`isBoardTerminalStepStatus` unchanged): the step is unsettled and boot
reconciliation must keep re-reading it. But supervision does not act on it — the existing "it stops
here until a human acts" comment (`supervisorReactor.ts:613`) stays true.

### D4 — Escalation releases the slot

A `stalled` step releases its concurrency slot. Nothing is running; the thread has ended.

This does **not** change the retry rule — an ordinary retry still keeps its place (D13), because a
retry has a live thread or is about to spawn one. Only giving up releases.

When the human chooses retry, the card re-enters the queue through the ordinary governor path rather
than resuming in place. The cost is losing queue position; the benefit is that one wedged card
cannot hold a slot for a weekend. `slotHeld` already exists on the step state precisely so release
happens exactly once (`board.ts:699`), so this rides existing machinery.

### D5 — A ceiling on invocations per stage entry

Per-stage setting `maxInvocationsPerStageEntry` (compiled default 20). When a stage entry's total
`attempt` count across all its steps crosses it, the stage stops and escalates as `stalled`,
whatever the per-step ladder says.

*Why a second ceiling:* the per-step ladder bounds one step. t3o-16's loop multiplies — rounds ×
phases × attempts — and each level is individually reasonable while the product is not. A card can
consume dozens of agent invocations, and a slot throughout, without a human being asked anything.
This is the backstop that makes the compound bound observable.

It is deliberately generous. It is a runaway detector, not a budget.

## Acceptance criteria

1. A step nudged twice with a `board_report_progress` call between the nudges has `stallCount` 1, not
   2, and does not escalate.
2. A step nudged five consecutive times with no progress between them escalates on the fifth.
3. A step that commits to its branch between nudges resets `stallCount`.
4. `attempt` keeps counting across resets and is visible on the card.
5. `recoveryDecision` remains pure — unit-tested with a `progressedSinceLastNudge` boolean, no git
   and no database.
6. The unattended envelope instructs periodic `board_report_progress` calls; the human-in-the-loop
   envelope does not.
7. An escalated step lands in `stalled`, not `awaiting-input`, and the two render differently.
8. A card whose agent asked an ordinary question is still `awaiting-input` and is not flagged as
   stalled.
9. A `stalled` step releases its concurrency slot exactly once, and a queued card starts.
10. Choosing retry on a stalled card re-queues it through the governor and it runs again.
11. Crossing `maxInvocationsPerStageEntry` stalls the stage even when no single step exhausted
    `maxAttempts`.
12. `stalled` is non-terminal: boot reconciliation still re-reads a stalled step and leaves it alone.
13. With t3o-16 landed, a review loop cannot exceed the invocation ceiling silently.

## Files

| File | Change |
| --- | --- |
| `packages/contracts/src/board.ts` | `stallCount`, `lastNudgeAt` on `BoardCardStepState`; `stalled` in `BOARD_STEP_STATUSES`; `maxInvocationsPerStageEntry` on the stage config |
| `apps/server/src/board/supervisor.ts` | `recoveryDecision` gates on `stallCount` + `progressedSinceLastNudge`; unattended postamble asks for progress reports |
| `apps/server/src/board/supervisorReactor.ts` | resolve the progress signal; set `stalled`; release the slot; enforce the ceiling |
| `apps/server/src/board/decider.ts` / `projector.ts` | the new status and counters |
| `apps/server/src/board/migrations/` | step-state columns |
| `apps/web/src/board/` | stalled treatment on the card and a way to find stalled cards |
