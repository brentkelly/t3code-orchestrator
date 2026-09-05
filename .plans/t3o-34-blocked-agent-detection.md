---
id: t3o-34
title: Blocked-agent detection — a stopped human-in-the-loop step stops pretending to work
phase: 3
prerequisites: [t3o-17, t3o-18]
---

# Blocked-agent detection

A planning card whose agent asked a question in prose shows a blue pulsing dot, as if it were
working. It is not working. It stopped, and it will not move again until a human answers.

## The defect

`handleTurnCompleted` (`supervisorReactor.ts:2810`) is the death/stall test every step thread's
`turn.completed` runs through. It has three arms:

| Arm                                                                    | Today                                                                            |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| thread has a structured pending question (`shell.hasPendingUserInput`) | → `board.card.await-step-input`, step goes `awaiting-input` ✅                   |
| **human-in-the-loop, no pending question**                             | **`if (found.state.humanInLoop) return;` — nothing happens** ❌                  |
| unattended, no pending question                                        | → `recoverStep`: nudge, and after `maxAttempts` consecutive stalls, `stalled` ✅ |

The middle arm is the bug. The step stays `running`, so the shell's `stepRunning` stays true
(`projection.ts:2841`), and the card dot — `threadState === "working" || stepRunning` — pulses blue
for as long as the card sits there. The comment says the run is "WAITING on the human, not dead",
which is true; the card just never says so.

It bites hardest in Planning, because the planning interview is the one stage where asking is the
job, and a question with a paragraph of consequence per option is a bad fit for the structured
question mechanism — so agents write it in prose. The envelope already forbids that
(`boardEnvelope.ts:146`, `never end a turn with an unanswered question in prose`) and agents do it
anyway. Prompting harder has been tried; this spec stops relying on it.

The "auto-prompt it to continue" half of the ask **already ships** for unattended runs — that is
exactly what `recoverStep`'s nudge ladder is (t3o-17). This spec adds one line to that nudge and
otherwise leaves it alone.

## Goal

A step that has stopped and will not continue on its own says so on the card, in the right colour,
on every surface — and clears itself the moment work resumes.

## Scope

**In**

1. A pure heuristic that decides whether an agent's final message ends blocked on a human.
2. The human-in-the-loop turn-end arm lands the step in `awaiting-input`, carrying a reason.
3. `awaiting-input` becomes visible on the column card, in two tones.
4. The step returns to `running` when any turn starts on its thread.
5. One extra nudge line when an _unattended_ agent stops with a question.

**Out**

- Any change to the structured-question path, the unattended recovery ladder, `stalled`, the
  invocation ceiling, or the timeout sweep. All correct; all untouched.
- A timeout sweep for human-in-the-loop steps. A hung HITL turn (no `turn.completed` at all) stays
  out of scope — this spec fixes the turn that _ended_.
- Notifications. Making the state visible on the board is this spec.
- Non-step threads on a card. They already read `stopped` with no dot; there is no lie to fix.

## Locked decisions

### D1 — Two states, and the text decides which

A human-in-the-loop step that ends a turn without completing is, by definition, not continuing on
its own. So the state change is unconditional; only the _tone_ is earned by reading the text.

| Final message       | Tone                           | Label             |
| ------------------- | ------------------------------ | ----------------- |
| reads as a question | violet (`--attention`)         | **Input needed**  |
| does not            | amber (`--warning-foreground`) | **Needs a human** |

Per `docs/t3o/status-colours.md`: violet is "waiting on a human", amber is "blocked or held".
Both are correct readings of a stopped step; the split tells the human whether there is something to
_answer_ or something to _look at_.

_Rejected:_ one state (always violet). Cheaper, no heuristic, no false positives — but a planning
agent that died mid-thought would read identically to one politely asking which auth library to use,
and those need different responses from the human.

### D2 — Detection is a pure text heuristic, biased toward "question"

New fork-owned file `packages/contracts/src/boardStopSignal.ts`:

```ts
export function boardTextEndsWithQuestion(text: string): boolean;
```

1. Strip fenced code blocks (```and ~~~) and inline code spans, so a`?` in a shell snippet or a
   regex never counts.
2. Take the trailing **4000 characters** of what remains. Long enough to reach back past several
   paragraph-sized options to the question that introduced them — which is the exact shape this
   spec exists for — and short enough that a whole plan document pasted into chat is not swept for
   an incidental `?` in its opening.
3. True if any non-blank line in that window, after trimming trailing whitespace and markdown
   emphasis, ends with `?`.
4. Or if the window matches one of a short, case-insensitive ask-phrase list: `let me know`,
   `your call`, `please confirm`, `waiting for your`, `awaiting your`, `tell me which`,
   `which would you prefer`. These are the ask-shapes that routinely arrive without a `?`.
5. Or if the window contains a markdown heading whose text contains "question".

**The heuristic is deliberately generous.** Both outcomes mean "come look at this card"; a false
positive costs violet instead of amber, never a card that keeps lying. Precision would be worth
paying for only if one branch were silent, and neither is.

_Rejected:_ LLM classification. More accurate on genuinely ambiguous prose, but it puts a model call
and its latency on every step turn-end, is untestable without stubbing, and fails open when the
provider is down — to buy accuracy on a distinction whose two outcomes are both "a human is needed".

_Rejected:_ asking the agent to declare it. Already tried: it is the envelope line at
`boardEnvelope.ts:146`, and its failure is why this spec exists.

The text comes from a new `BoardQueries` reader, `boardLatestAssistantText(threadId)` — a single
indexed row off `projection_thread_messages` (`WHERE thread_id = ? AND role = 'assistant' ORDER BY
created_at DESC, message_id DESC LIMIT 1`), which the `idx_projection_thread_messages_thread_created_id`
index from upstream migration 029 already serves. The board database is ATTACHED to the same
connection (`boardDatabase.ts:4`), so this is one query on one connection, no new plumbing. It runs
once per step turn-end, on both the HITL and the unattended arm.

### D3 — Both cases land in `awaiting-input`, discriminated by a reason

Not a new status. `awaiting-input` already means exactly "this step is parked until a human acts":
it is non-terminal, boot reconciliation resumes-watch it while the thread lives
(`supervisor.ts:215`), the governor stops counting it, and it takes the step out of `running` so the
blue dot dies. Both new cases are that state. Only the label differs.

`BoardCardStepState` gains:

```ts
awaitingReason: "question" | "stopped"; // decoding default "question"
```

- `question` — a structured pending question (today's path), an agent-reported `blocked` completion,
  or prose the heuristic read as a question.
- `stopped` — a human-in-the-loop turn that ended with nothing to answer.

`board.card.await-step-input` carries the reason; the decider writes it onto the state. A board
migration `033_BoardCardStepStateAwaitingReason.ts` adds `awaiting_reason TEXT` to
`board_card_step_state` (plain `ADD COLUMN`, nullable, no history rewrite — NULL reads as
`question`, which is what every pre-existing awaiting-input row was).

_Rejected:_ reusing `stalled` for the amber case. It carries all the right machinery (slot release,
resume-on-human-turn, the board's stalled filter) but the wrong meaning and the wrong words:
"recovery gave up" is a lie about an agent that simply finished a turn, and every HITL stop would
charge `attempt` and `stallCount` through `board.card.recover-step`, inflating "attempt 7" on a
perfectly healthy interview and eventually tripping the D5 stage-entry ceiling.

_Rejected:_ a new `needs-human` status. It would duplicate `awaiting-input`'s decider branch,
projector case, reconciliation arm and terminal-status rules to express a difference that is one
enum on one row.

### D4 — The step status becomes a card-face fact

Today the column card's violet comes only from the _thread_ (`hasPendingUserInput`), never from the
step status — which is why `awaiting-input` has been invisible on the board all along. That is
correct while the two always agree; it stops being correct here.

`BoardCardShell` gains one step-derived field, following `stalled`/`queued`/`held` exactly:

```ts
stepAwaiting: BoardCardStepAwaitingReason | null;
```

- Produced by the snapshot from the step-state row, and by the `card-stalled` delta, which gains the
  same field. Card-carrying deltas rest it at `null` and the client preserves the last known value
  (`applyBoardShellStreamEvent`), the same rule `stalled` follows.
- `board.card-step-awaiting-input` currently emits **no** shell delta (`projector.ts:934`). It now
  emits `card-stalled` with `stalled: false, stepRunning: false, held: false, stepAwaiting: <reason>`
  — the delta already exists and already carries the other three step booleans; this is a fourth
  field on it, not a fourth delta.

`boardCardAttention` (`board.ts:2039`) — the one definition every surface reads — gains, just above
its existing `awaitingInput` branch:

```ts
if (card.stepAwaiting === "stopped") →
  { reason: "stopped", tone: "warning", label: "Needs a human",
    detail: "The agent stopped without asking anything — this step needs a human to continue it" }
if (card.awaitingInput || card.stepAwaiting === "question") →
  { reason: "input", tone: "attention", label: "Input needed", … }
```

Not stage-gated. `held`'s build-role gate exists because `held` rests on the shell across a drag back
to Backlog; `stepAwaiting` is cleared by the resume in D5 and by the next select, and Planning is
precisely the stage this spec is about.

Because it is one function, the card face, the card tint and ring, the parent's sub-board roll-up
(`deriveBoardCardChildAttention`) and every other consumer follow for free.

### D5 — Any turn on the thread returns the step to `running`

Without this, D4 trades one stale indicator for another: the human answers, the agent works, and the
card still says "Input needed".

`handleTurnStartRequested` (`supervisorReactor.ts:3665`) resumes only from `stalled` today. It now
resumes from `awaiting-input` as well, and `board.card.resume-step`'s decider guard widens to accept
both. From `awaiting-input`, `slotHeld` is preserved (nothing released it) rather than forced false
as the `stalled` path leaves it.

This also closes a latent hole: a step that entered `awaiting-input` by the _structured_ path and was
then answered has been sitting at `stepRunning: false` ever since, invisible only because the thread
flag happened to cover for it.

### D6 — Unattended stops with a question get one extra nudge line

An unattended run that ends with a question is already nudged — that is the "auto-prompt it to
continue" the ask calls for, shipped in t3o-17. But the nudge tells it to continue without
acknowledging that it asked something, so a determined agent asks again.

`recoveryDecision` takes one more scalar, `endedWithQuestion: boolean` (resolved by the reactor from
the same D2 read, keeping the function pure), and on `resume` appends:

> Your turn ended with a question, but this run is unattended: decide it yourself with your best
> judgement, record the decision, and continue.

Nothing else about the ladder changes — not the counters, not the ceilings, not the escalation.

## Acceptance criteria

1. A human-in-the-loop step whose thread ends a turn with prose containing a question, with no
   structured pending input and no step completion, moves to `awaiting-input` with
   `awaitingReason: "question"`.
2. The same, with no question in the final message, moves to `awaiting-input` with
   `awaitingReason: "stopped"`.
3. Neither case consumes a recovery attempt, bumps `stallCount`, or releases a slot.
4. Both cases clear `stepRunning`, so the card's blue pulsing dot goes dark.
5. The card renders violet "Input needed" for `question` and amber "Needs a human" for `stopped`,
   from `boardCardAttention`, with no renderer-local condition.
6. A turn starting on the thread of an `awaiting-input` step returns it to `running`, and the card's
   attention badge clears.
7. The structured-question path is unchanged: a thread with `hasPendingUserInput` still lands
   `awaiting-input`, now with reason `question`.
8. An unattended step is still nudged, not parked, and its nudge names the question when it ended
   with one.
9. `boardTextEndsWithQuestion` ignores `?` inside fenced code blocks and inline code spans, and
   returns true for a question followed by several paragraph-length options.
10. A pre-existing `board_card_step_state` row with a NULL `awaiting_reason` reads as `question`.
11. A sub-board parent's roll-up shows a child's new attention state, unchanged from how it shows
    the existing ones.

## Files

- `packages/contracts/src/boardStopSignal.ts` — **new**, the heuristic (+ test).
- `packages/contracts/src/board.ts` — `awaitingReason` on the step state, `stepAwaiting` on the shell
  and the `card-stalled` delta, the two `boardCardAttention` branches, the `await-step-input` command
  payload.
- `apps/server/src/board/migrations/033_BoardCardStepStateAwaitingReason.ts` — **new**.
- `apps/server/src/board/decider.ts` — reason on `await-step-input`, `resume-step` accepts
  `awaiting-input`.
- `apps/server/src/board/projector.ts` — `card-stalled` delta from `board.card-step-awaiting-input`.
- `apps/server/src/board/projection.ts` — `stepAwaiting` in the shell snapshot,
  `boardLatestAssistantText` on `BoardQueries`.
- `apps/server/src/board/supervisor.ts` — `endedWithQuestion` in `recoveryDecision`.
- `apps/server/src/board/supervisorReactor.ts` — the HITL arm of `handleTurnCompleted`, the resolver
  for the message text, `handleTurnStartRequested`.
- `packages/client-runtime/src/state/board.ts` — `stepAwaiting` preserve-on-card-delta.
