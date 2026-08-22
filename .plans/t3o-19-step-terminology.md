---
id: t3o-19
title: Step terminology — stop rendering steps where a stage has none
phase: 3
prerequisites: [t3o-15, t3o-16, t3o-17, t3o-18]
---

# Step terminology — stop rendering steps where a stage has none

Every stage but Code review runs exactly one step, and that step's id *is* the stage id and
its label *is* the stage label (`board.ts:759`). So the envelope renders a tautology into
every Planning and Building system prompt:

```
Stage: planning. Step: Planning.
```

Worse, that redundant line is load-bearing by accident. The decider rejects any `stepId` that
is not the card's live step (`decider.ts:1224` — *"complete the step you were assigned"*), but
nothing ever tells the agent what it was assigned: the preamble prints `stepLabel`, not the id,
and `board_get_card_context.steps` returns *prior completions* only. Non-review stages complete
at all because the preamble happens to print `Stage: planning.` and seeded stage ids happen to
be slugs, so the agent infers `stepId = "planning"`. Code review works reliably for the opposite
reason: its protocol injects the literal string (`boardEnvelope.ts:157`).

Custom stages are where the accident stops working. They are created with
`stageId = randomUUID()` (`BoardPipelineSection.tsx:706`), so an auto-executing custom stage
renders `Stage: 3f2a1b9c-….  Step: New stage.` and expects the agent to pass that UUID.

## Goal

A stage that has no steps says nothing about steps — in its prompt or its tool call — and an
agent never has to guess an identifier. A stage that genuinely has steps (today the review
loop; tomorrow any sequence stage) keeps the full vocabulary and is told its `stepId` outright.

## Scope

**In**

- `stepLabel` becomes nullable end to end: the plan, the `select-step` event payload, the run
  row, the envelope. `null` means "this stage has no steps".
- `stage_label` frozen onto the run row so readers resolve `stepLabel ?? stageLabel` without a
  board read, and the preamble prints the stage's label instead of its id/UUID.
- `board_complete_step.stepId` becomes optional, resolved server-side from the calling thread's
  live step.
- Envelope and MCP tool descriptions reworded.
- `board_get_card_context` gains a `currentStep` field.
- Migration 020 relaxing `board_card_step_state`.

**Out**

- Internal identifiers stay `step` — `stepCompletions`, `stepStates`, `board_card_steps`,
  `BoardStepOutcome`, `stepPromptFor`. Step remains the general unit (see D1).
- `board_complete_step` keeps its name (D2).
- The five seeded default prompts are unchanged — none mention steps since the envelope split,
  so there is no new `LEGACY_BOARD_PROMPT_UPGRADES` entry and no user-prompt migration.
- Multi-step support for arbitrary stages. The substrate already allows it (D1); this spec only
  stops non-stepped stages from pretending.
- Rewriting historical events or completed runs (D7).

## Key decisions

**D1 — "Step" survives as the noun; the defect is rendering it where there is none.**
The runtime is already multi-step-generic: `board_card_steps` is keyed `(card_id, step_id)`,
`BoardStageExecutor.planNext` answers *"what runs next, or are we done?"* with the reactor never
learning how many steps exist (`stageExecutor.ts:104`), `BoardStageRunState.completedStepIds` is
an array, and `ReviewLoopExecutor` already drives 3 phases × N rounds through that seam. Adding
sequence stages later needs a third `BoardStageExecution` member, a `SequenceExecutor`, settings
UI — and a schema change, since `board_card_step_state` is PK `card_id` (one live step per card,
so sequences are sequential only). None of that is this spec's work, but all of it argues
against scrubbing a vocabulary we will want back.

**D2 — `board_complete_step` is not renamed.**
It is the completion contract for both cases and its description can carry the nuance in one
sentence. Renaming breaks an MCP surface for cosmetics, strands in-flight agents mid-run, and
desynchronises the tool from `board_card_steps`, `stepId` and the review protocol, all of which
legitimately say "step".

**D3 — `stepId` is optional, resolved thread-scoped.**
Omitted means "my live step", resolved from `board_card_step_state.thread_id`
(`013_BoardCardStepState.ts:24`) for the calling thread. An unstepped stage then needs no step
vocabulary at all, and the "pre-complete a future step" attack `decider.ts:1220` guards against
becomes structurally impossible rather than merely validated. Thread-scoping is what makes a
retry safe: if the board has advanced past the caller's step, no live step matches that thread,
so the call is rejected with the recorded outcome instead of silently completing the *next*
stage's step. Stages that run several steps state the `stepId` in the prompt and pass it back.

**D4 — The signal is a nullable step identity, not a boolean, and not an array.**
An array of step ids cannot be built: `reviewLoopDecision` terminates the moment a round comes
back with no blocking findings (`reviewLoopExecutor.ts:129`), so a card may run one step or
fifteen. `{index, total}` fails identically. A boolean would say a step exists without saying
what it is. A nullable `{ id, label }` subsumes both, and a future `SequenceExecutor` gets
correct behaviour by construction rather than by remembering to set a flag.

Rejected: deriving `stepped = stepId !== card.stage`. It is free and works today, but it makes
prompt wording depend on a string coincidence between two independently maintained values —
which is the exact failure this spec exists to fix.

**D5 — The preamble prints the stage label, not the stage id.**
`Stage: 3f2a1b9c-…` is the same "prompt does not make sense" defect. Freezing `stage_label` on
the run row supplies it without a board read and gives `stepLabel`'s three existing readers
(thread title `supervisorReactor.ts:521`, stall message `supervisor.ts:133`, activity rail
`BoardCardActivityRail.tsx:144`) their fallback.

**D6 — The envelope owns the `stepId` instruction; the review protocol keeps the payload shape.**
Today `boardEnvelope.ts:157,165,172` each say *"Complete this step by calling board_complete_step
with stepId …"*. Once the envelope states it for every stepped stage, those three sentences are
duplicates and are stripped. The protocol keeps what is genuinely phase-specific: the payload
schema, the severity vocabulary, the diff scope.

**D7 — History is not rewritten.**
`projection.ts:1988` guarantees a table rehydration equals a from-empty replay, and the
`select-step` event payload carries `stepLabel` (`projection.ts:1837`). New events carry `null`
for unstepped stages; old events keep what they recorded; neither path coerces, so the two stay
identical by construction. A card already mid-stage at deploy keeps its tautological preamble
until that stage ends. The alternative — coercing legacy payloads in the projector — reimports
the D4-rejected derivation into the one path where a bug is most expensive, to fix cosmetics on
runs that already finished.

## The wording

Preamble, unstepped:

```
You are working card T3O-42 — "Add dark mode".
Stage: Planning.
Call board_get_card_context for the brief, plan, dependencies and prior progress.
```

Preamble, stepped: `Stage: Code review. Step: Review · round 1.`

Postamble — the step clause appears only when there is a step:

| | unstepped | stepped |
|---|---|---|
| human-in-loop | `When the work is done, call board_complete_step.` | `… call board_complete_step with stepId "review@1".` |
| unattended | `When the work is done, call board_complete_step — that is the ONLY way to finish; ending your turn any other way is treated as a failure and recovered.` | `When this step is finished, call board_complete_step with stepId "review@1" — that is the ONLY way …` |

Todo-list line: *"… without it a working **agent** looks the same as a stalled one"* (was "a
working step").

Move guard, one wording for both: *"Never move the card between stages yourself; finish your
work and the board or a human moves the card on."*

`board_complete_step` description gains: *"Omit `stepId` — the board resolves your assigned work
from your thread. Pass one only if your prompt explicitly gave you a stepId (stages that run
several steps, such as the code review loop, always do); pass exactly that string."*

`board_get_card_context`: *"Call this first when you start a step"* → *"when you start work"*.

Settings copy (`BoardPipelineSection.tsx:713`): *"Each stage runs a single agent step."* →
*"Each stage runs one agent, except code review, which runs a review loop."*

Drive-by: `handlers.ts:406` still points agents at `board_report_progress`, deleted by t3o-18.

## Acceptance criteria

1. A Planning or Building run's composed prompt contains no occurrence of the word "step"
   outside the tool name `board_complete_step`.
2. A Planning run's preamble reads `Stage: Planning.` — the stage's label, not `planning`.
3. An auto-executing custom stage whose id is a UUID renders its label in the preamble, and its
   agent completes successfully without ever being told an identifier.
4. A review run's preamble still reads `Stage: Code review. Step: Review · round 1.`
5. A review run's composed prompt states `stepId "review@1"` exactly once.
6. `board_complete_step` with no `stepId` completes the calling thread's live step.
7. `board_complete_step` with no `stepId` from a thread with no live step is rejected, and does
   not complete another card or stage's step.
8. `board_complete_step` with an explicit non-live `stepId` is still rejected as today.
9. An idempotent retry — same explicit `stepId`, already `succeeded` — still re-returns the
   first outcome with `alreadyCompleted: true`.
10. `board_get_card_context` returns `currentStep` for a running card and `null` for an idle one;
    `steps` still contains only prior completions.
11. Thread title, stall message and activity rail render identically for an unstepped stage
    (via `stepLabel ?? stageLabel`) and for a legacy row with `stage_label = NULL`.
12. Rehydration from the projection tables equals a from-empty replay, for a board containing
    both pre- and post-migration `select-step` events.
13. Migration 020 leaves existing rows readable: `step_label` retained, `stage_label` NULL.
14. The settings pipeline preview shows no `Step:` line for a simple stage and does show one for
    the review phases.
15. No stored user prompt is rewritten by this change.
