---
id: t3o-16
title: Code review — the hardcoded review loop and its settings card
phase: 2
prerequisites: [t3o-15]
---

# Code review loop

Code review is not a stage that runs a prompt. It is a **loop**: review, then triage the findings,
then adjudicate whether the fixes actually hold, repeated until it converges or a round cap stops it.

t3o-15 gives every stage exactly one configurable step, which is right for Build and for any stage a
user invents, and wrong for this one. Review's phases are a fixed sequence — their *order* and
*existence* are product decisions, not user configuration — while their prompts and models must be
editable, because the economics of the loop depend on running a cheap reviewer and an expensive
adjudicator.

So Review is the one stage exempt from the uniform settings card, and the one stage that runs more
than one step per entry.

## Goal

A hardcoded review loop, and a bespoke settings card that configures it: round count, plus prompt
and model per phase.

## Scope

**In**

1. A fixed phase sequence for the `review`-role stage, defined in code.
2. A bespoke settings card: `Rounds`, then one editable block per phase.
3. Per-phase `prompt` and `ModelSelection | null` — **individually settable, a hard requirement**.
4. Round-aware step completions (D2).
5. Convergence and exhaustion outcomes.

**Out**

- Any change to the uniform stage card, generic auto-kickoff, Mode, human-in-the-loop, or
  auto-advance. t3o-15 owns all of it and this spec consumes it unchanged.
- Letting the user add, remove or reorder phases. That is the thing this spec exists to refuse.

## Locked decisions

### D1 — Phases are code, prompts are settings

The `review` role's stage ignores `BoardStageExecution.prompt` and `model` entirely. Its settings
card renders `Rounds` plus one block per compiled-in phase, each carrying its own prompt and its own
`ModelSelection | null` through `ProviderModelPicker`.

A phase's `id` and `label` are not editable and no phase can be added or removed. The mechanism is
t3o-15's step machine with the array authored in code instead of by the user — the same completion
contract, timeout, attempt cap and recovery ladder per phase.

*Why per-phase models are non-negotiable:* the loop's whole value is asymmetric spend. A thorough
reviewer and a cheap triager, or a cheap first pass and an expensive adjudicator, are the two
configurations people actually want, and neither is expressible with one model per stage.

### D2 — Completions must become round-aware

**This is the one real blocker and it must be solved before anything else.**

`BoardStepCompletion` is keyed `(cardId, stepId)` with **first-outcome-wins** idempotency
(`board.ts:1101`). Round 1's review phase writes a completion for `(card, "review")`. When round 2's
review phase finishes, its outcome is discarded as a duplicate, and `selectNextStep`
(`supervisor.ts:99`) independently treats `"review"` as already succeeded and skips it. The loop
cannot record its own second lap.

Three viable fixes, to be chosen when this is built:

| | Shape | Note |
| --- | --- | --- |
| Round-scoped step ids | `review@2` | Cheapest; makes step ids synthetic |
| A `runId` / round column on the completion | `(runId, stepId)` | Cleanest; every stage entry mints a run, and card history gains "built three times, each with the config it ran under" |
| Loop state outside the completion table | phase cursor on the card | Keeps completions untouched; a second source of truth |

The `runId` option is the recommendation, and its incidental payoff is the per-run audit trail that
t3o-15's D12 gives up when it collapses the recipe snapshot onto the run row. The database is
disposable (t3o-15 D14), so re-keying costs nothing but the edit.

### D3 — Rounds are bounded and exhaustion is a human gate

`Rounds` is a positive integer in settings. Convergence ends the loop early; exhausting the cap ends
it by escalating to the human, never by looping forever and never by silently passing.

This mirrors the recovery ladder's existing shape (D13): bounded attempts, then stop and ask.

### D4 — The loop reports, it does not decide

Convergence advances the card by t3o-15's ordinary `Auto advance` setting on the `review` stage — the
loop does not carry its own bespoke stage crossing. Exhaustion leaves the card in Review, flagged for
a human, which is what a `blocked` outcome already does.

## Open — resolve when this is built

- **The exact phase list.** "review / triage / adjudicate" is the working shape; the repository's own
  `pullrequest` review loop (REVIEW → author triage and fix → RE-REVIEW adjudication → converge) is
  the reference implementation to port from.
- **What "converged" means mechanically** — an adjudicator verdict, a finding count of zero, or a
  structured outcome from the final phase.
- **Whether a round runs against a PR or the worktree**, and whether the loop requires a PR to exist.

## Acceptance criteria

1. `Settings → Board` renders Review with a `Rounds` field and one block per phase — no Add / Remove
   / reorder control, and no uniform prompt or model field.
2. Each phase's prompt and model persist independently, and a card entering Review runs each phase on
   its own configured model.
3. A card runs two full rounds, and **both** rounds' completions are recorded and visible — the D2
   collision does not occur.
4. Converging before the cap ends the loop early and advances the card if `Auto advance` is on.
5. Exhausting the cap leaves the card in Review, flagged for a human, and never loops again.
6. Every t3o-15 behaviour is unchanged for non-Review stages.
