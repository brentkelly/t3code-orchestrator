---
id: t3o-10
title: Supervisor reactor — step machine, prompt envelope, death detection, human gates
phase: 2
prerequisites: [t3o-08, t3o-09]
---

# Supervisor reactor

The core of T3o. The board stops being a record of work and starts causing it.

## Locked decisions

- **D4** — one thread per step; a step is complete **only** via `board_complete_step`; anything else
  is death or a stall.
- **D5** — provider-neutral prompt envelopes, never skills. Context pushed as a preamble and
  pullable via MCP.
- **D13** — human gates are real thread questions, so they reach the phone through T3's existing
  awareness/APNs path. Recovery escalates and never loops unbounded.

## Shape

A `DrainableWorker`-backed reactor, following `CheckpointReactor` and `ProviderCommandReactor`. It
consumes board events and thread lifecycle events, and dispatches commands. Registration is one line
in the server's runtime layer.

Per-card step state (in the read model, because transitions branch on it):

```
currentStepId, attempt, threadId, startedAt, slotHeld, status
status ∈ pending | queued | running | awaiting-input | completing | succeeded | failed | abandoned
```

## Step lifecycle

1. **Select** — resolve the next step from the card's `recipeSnapshot`.
2. **Admit** — acquire a concurrency slot for the step's provider instance (`t3o-11`). No slot →
   `queued`, visible on the card.
3. **Spawn** — `thread.create` with the step's `modelSelection`, the card's `worktreePath`, and the
   composed prompt. Link the thread to the card with the step's role.
4. **Run** — the agent works, may call `board_report_progress`, may call `board_request_input`.
5. **Settle** — one of:
   - `board_complete_step(succeeded)` → release slot, advance.
   - `board_complete_step(blocked)` → human gate.
   - `board_complete_step(failed)` → recovery.
   - **Thread settled without any call** → treated as death; recovery.
6. **Release** — the slot is released at every terminal outcome, including crashes. A leaked slot
   silently halves throughput and is very hard to notice.

## Prompt envelope

Every step prompt is composed as **preamble + body + postamble**:

- **Preamble** — card key, title, stage, step, attempt N of M, the one-line goal, and a pointer to
  `board_get_card_context` for more. Short by design; the pull path exists so this stays small.
- **Body** — the recipe's `promptTemplate` (later, a wrapped user skill).
- **Postamble** — the completion contract: call `board_complete_step` when done; if you need a human
  decision, ask through *this provider's* question mechanism; **never end a turn with an unanswered
  question in prose** — that is treated as a failure.

The question-mechanism wording is **per provider instance**. The board assigned the step, so it
knows which provider it is talking to. This is the concrete payoff of choosing envelopes over
Claude-specific skills.

## Death and stall detection

The board cannot distinguish "died" from "waiting on you" by thread settlement alone — settlement
covers both finishing and crashing. So:

- **Structured question** → the thread's existing `hasPendingUserInput` fires, the card renders
  "Input needed", and D13's notification path reaches the phone. Not a failure.
- **Settled with no completion call** → death or a prose-question stall. Enter recovery.

Recovery **escalates**, and never loops:

1. **Attempt 1** — resume the same thread: continue, and if you need input, ask through your
   question tool.
2. **Attempt 2** — same, plus an explicit summary of what remains outstanding.
3. **Attempt 3** — stop. Ask the human: retry, switch provider, or take it manually. Same channel,
   same notification, same phone.

`maxAttempts` comes from the recipe. Prevention lives in the envelope; cure lives here. Both are
needed — the envelope reduces stalls, it does not eliminate them.

## Boot reconciliation

The server will restart mid-step. On startup the reactor re-reads every card with a non-terminal
step and asks whether its thread still exists and is alive. Outcomes: still running → resume
watching; gone → recovery; completed while we were down → advance.

`ProviderSessionReaper` already stops idle sessions with no active turn and no live background work.
That is *aligned* with the board — it cleans up between steps — but it also means "the thread I
spawned is gone" is a routine path, not an exception. Handle it as normal control flow.

## Human gates

Gate types: approve plan, approve review, adjudicate a dispute, choose a recovery action.

Every gate is expressible **two ways that write the same event**: answering the question in the
thread, or pressing the button on the card. A gate reachable only from the board cannot be cleared
from a phone, which defeats the point of building on T3.

## Out of scope

- The concurrency governor's policy (`t3o-11`) — this spec only acquires and releases.
- Review rounds and the issue ledger (post-MVP).

## Verification

- Kill a step's provider process; the reactor detects it and retries with escalating prompts.
- An agent that asks a question in prose and stops is recovered, not abandoned.
- An agent that asks properly puts the card into "Input needed" and does **not** consume a retry.
- Restart the server mid-step; the card resumes correctly from every non-terminal status.
- `board_complete_step` delivered twice advances once.
- Slots are released on success, failure, crash, and abandonment — assert no leaks over a long run.
