---
id: t3o-30
title: A step that dies at spawn — a board default model, a visible reason, a way back
phase: 3
prerequisites: [t3o-17, t3o-21, t3o-29]
---

# Step failure and recovery

TT-11 passed review, reached the merge stage, and its pull request would not merge because the
branch conflicted. The board armed the conflict fix and started its step. The merge stage named
no model, so the step fell through to the app's `textGenerationModelSelection` — whose
compiled-in value is `codex` + `gpt-5.6-luna` — and `codex` is not installed on that machine:

```
spawn codex ENOENT → CodexAppServerSpawnError → session status "error"
```

No turn ever started, so no turn ever completed, and `turn.completed` is the only edge the
supervisor recovers on. The step stayed `running` with its concurrency slot held. The card
rendered a spinner against a thread that was already dead, the Merge button stayed disabled
("Resolving conflicts…"), and the merge stage does not auto-execute so the `+` menu offered no
restart item at all. The only exit was archive-and-unarchive. The single thing that would have
explained it — the provider's error — was inside a thread the card would not point at.

Three failures, one incident: a fallback nobody chose, a status that lied, and no way back.

## Goal

A stage that names no model runs on a pair the user picked and can see. A step whose provider
never starts stops immediately, says why on the card, and gives its slot back. A stalled step
can be restarted from the card, whatever its stage does on entry.

## Scope

**In.** `BoardSettings.defaultModel` and its resolution ladder; the `Default model` row in
Settings → Board and the inherited placeholder on every stage/phase model row; `lastError` on
the step run row and its migration, contract, decider, projection and detail payload; the
supervisor's subscription to `provider.turn.start.failed`; the card's failure banner and the
restart affordance on a stalled non-auto-executing stage.

**Out.** Retrying a failed spawn onto a different model (D2). Pre-flight validation that a
stage's provider instance is installed and enabled — worth doing, but it is a settings-time
check and a different change. Any change to the recovery ladder for a step whose turn *did*
start. Mobile, which has no board.

## Design decisions

### D1 — A board default model, above the app's text-generation selection

`BoardSettings.defaultModel` is a nullable `BoardModelSelection`. A stage resolves its model as:
its own `model`, else the board default, else `textGenerationModelSelection`.

The board deliberately had **no** compiled-in pair — a hardcoded one is a pair the user may not
have enabled, and that is precisely the bug above. But the fallback did not disappear when the
compiled-in default was removed; it moved one level out, to a setting chosen for summarising and
commit messages, whose own compiled-in value is a codex pair. Nothing in the settings card ever
named it. So a stage could read "Select a model" and still run, on something nobody picked.

`defaultModel` is that fallback made explicit and user-owned. It is read **live** at stage entry,
never copied into stages, so changing it moves every unset stage at once — and a card already
running keeps the pair frozen onto its run row (D12), as always.

The app-wide selection stays underneath it. Anyone who never sets a board default sees no change,
which is what makes this safe to ship without a migration.

The consequence the settings UI must carry: "nothing picked" is now two situations, not one. A
row with a default to inherit names it — `Claude Opus 5 (default)` — and drops the required-field
warning; a row with nothing to inherit keeps the warning it had. A review *phase* names the
review stage's model when the stage has one, because that is the nearer answer and saying
"default" would be a lie the user cannot check.

### D2 — A turn that never started fails fast, carrying its reason

The supervisor subscribes to one non-board event: `thread.activity-appended` with kind
`provider.turn.start.failed`. It is filtered at the stream, not in `processDomainEvent`, because
thread activity is the highest-volume event on that stream and the board wants exactly one kind.

A step whose thread raises it lands `stalled` **immediately** and releases its slot. It is not
handed to the recovery ladder, which exists for a turn that ran and went quiet: here there is no
agent to nudge, and no amount of waiting produces one, so the ladder would spend `timeoutMs` per
rung re-sending turns into a provider that cannot start one — thirty minutes of spinner, per
rung, for an error already known at second zero.

`stalled` rather than `failed`, for a reason that is load-bearing: it is non-terminal, and
`beginStageRun` already **supersedes** a stalled step on an on-demand restart. The card's Restart
button therefore needs no new command. A merge card additionally gets its Merge button back,
because that button is gated on a live step.

**Never retried automatically, not even onto the board default.** The stage names the model it
runs on; silently running the work somewhere else is worse than saying plainly that the chosen
one could not start.

The provider's error is condensed onto the run row as `lastError` (migration 030). The raw text
is a nested error — message, JS stack, then one or more `[cause]:` frames — and the actionable
sentence is never the outermost one: `Provider adapter process error (codex)` says which layer
noticed, `Error: spawn codex ENOENT` says what to fix. `boardStepErrorSummary` keeps the first
line and the innermost cause, drops the stack between them, and caps the result.

`lastError` is **replaced, never merged**, on every recovery: a nudge that returns a step to
`running` must not leave the card showing the stop before it.

### D3 — The card says what happened, and offers the one action that clears it

A stalled step already had a badge. A badge is not a reason and is not a button.

The card detail renders a failure banner whenever the card's live step is `stalled`, carrying
`lastError` when there is one and the recovery-gave-up sentence when there is not, plus a Restart
that dispatches the same `board.card.start-stage-thread` the `+` menu's restart item does. One
command, one server-side path, nothing to keep in step.

The text rides `BoardCardDetail.stepError`, not the card shell: the shell is byte-budgeted and
broadcast for every card on the board (D7), and this is a paragraph of provider error text only
ever read on the card that is open. The shell's existing `stalled` flag is what the board itself
renders, and it is what gates the banner — the error text outlives its stop on the run row until
the next step replaces it, so gating on the text alone would show a card the stop it already
recovered from.

`resolveBoardThreadStageRestart` now offers a restart on **any** stage whose step has stalled,
not only an auto-executing one. A stage that runs nothing on entry still spawns steps — the merge
role's conflict fix is one — and when one of those died the stage had no restart item at all. A
stalled step is by definition something a human has to restart, whatever the stage does on entry.
