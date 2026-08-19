---
id: t3o-16
title: Code review — the review loop service
phase: 2
prerequisites: [t3o-15]
---

# Code review loop

Code review is not a stage that runs a prompt. It is a **loop**: review the work, triage the
findings, adjudicate whether the fixes hold, repeat until a review pass comes back clean or a round
cap stops it.

t3o-15 gives every stage exactly one configurable step, which is right for Build and for any stage a
user invents, and wrong for this one. Review's phases are a fixed sequence — their order and
existence are product decisions, not user configuration — while their prompts and models must be
editable, because the loop's whole economics depend on running a cheap reviewer against an expensive
adjudicator.

Review is therefore the one stage with a bespoke settings card and the one stage that runs more than
one step per entry. **All of it lives in one service.** Nothing else in the codebase learns that
review is special.

## Goal

A `ReviewLoopExecutor` behind t3o-15's `BoardStageExecutor` seam, holding the phases, the rounds and
the convergence rule; plus the settings card that feeds it.

## Scope

**In**

1. `ReviewLoopExecutor` — the whole loop, behind t3o-15 D15's `planNext` interface.
2. `BoardStageExecution` gains its `kind: "review"` member: `rounds` + per-phase prompt and model.
3. The bespoke settings card.
4. Structured findings on the completion payload, and their schemas.
5. Findings rendered on the card detail view.

**Out**

- Any change to the supervisor reactor, decider, projector or MCP toolkit. If this spec needs one,
  the t3o-15 seam is wrong and that is the bug to fix.
- PR creation, pushing, forge integration. The loop reviews the worktree (D6); `externalRef` still
  has no producer, and giving it one belongs to a later "Ready for merge" spec.
- Letting a user add, remove or reorder phases. That is the thing this spec exists to refuse.

## Locked decisions

### D1 — One service, no conditionals anywhere else

The loop is a single `ReviewLoopExecutor` implementing t3o-15's `BoardStageExecutor`:

```
planNext({ card, config, completions, runState })
  -> { kind: "run", round, stepId, label, prompt, model, timeoutMs, maxAttempts }
   | { kind: "complete", outcome }
   | { kind: "escalate", question }
```

Registered against the `review` role in t3o-15's executor registry. That registration is the **only**
place in the codebase that knows this stage differs, alongside the settings panel choosing which card
to render.

*Explicitly forbidden:* `if (stage.role === "review")` in the supervisor reactor, the decider, the
projector, the MCP handlers or the board UI. The reactor keeps driving threads, slots, worktrees,
death detection, recovery and auto-advance exactly as it does for a one-step stage; it only ever asks
`planNext` what to run.

`planNext` stays **pure** — no SQL, no git, no thread handles — so the entire loop is unit-testable
by feeding it a completions array. This is the same discipline `selectNextStep` and
`decideBoardCommand` already hold.

### D2 — Phases are code, prompts and models are settings

```
BoardStageExecution = { kind: "review", rounds, phases: { review, triage, adjudicate } }

  rounds     PositiveInt          how many times the loop may repeat
  phases[id] prompt               required
             model                ModelSelection | null
             timeoutMs            PositiveInt
             maxAttempts          PositiveInt
```

Phase `id` and `label` are compiled in. No add, no remove, no reorder. The stage's `mode` is fixed at
`build` (the loop needs the worktree) and `humanInLoop` is fixed off (an unattended loop is the point).

**Per-phase models are a hard requirement, not a nicety.** A thorough reviewer with a cheap triager,
or a cheap first pass with an expensive adjudicator, are the two configurations people actually run,
and neither is expressible with one model per stage.

### D3 — The loop shape, and review owns convergence

```
round N:
  review      -> no blocking findings?  -> COMPLETE, stage succeeds
              -> blocking findings      -> continue
  triage      -> fix each finding, or reject it with a reason
  adjudicate  -> rule on each fix and each rejection
              -> round N+1
```

**Convergence is decided by `review`, not by `adjudicate`.**

- It is the terminating condition the repository's own `pullrequest` skill uses — the loop ends when
  a review round raises no new blocking findings — and that loop is what this ports.
- Adjudicate answers a narrower question ("did this claimed fix hold?"). It cannot see problems the
  fix *introduced*; only the next review can.
- It makes the clean case free: a good build runs `review` once, finds nothing, and the stage
  completes. One agent invocation, not three.

**No inner loop.** If adjudicate finds a fix did not hold, it does *not* bounce back to triage. Its
verdicts ride into the next round's review as context and the unresolved item resurfaces there
naturally. One linear pass per round; the only repetition is the round itself.

### D4 — Findings ride the completion payload

No new MCP tool and no new table. `BoardStepCompletion.payload` is already an opaque JSON string
carried verbatim (`board.ts:632`), and `board_get_card_context` already returns a card's full
completion list including payloads (`handlers.ts:336`). So the reviewer completes with findings, and
the next phase reads them through a tool it already has.

```
review payload
  reviewedSha   string                      the commit the findings were raised against (D7)
  findings      [ { id, severity, file, line, title, detail } ]

triage payload
  fixedSha      string
  dispositions  [ { findingId, action: "fixed" | "rejected", note } ]

adjudicate payload
  verdicts      [ { findingId, verdict, note } ]
    verdict: "fix-upheld" | "fix-incomplete" | "fix-absent"
           | "rejection-justified" | "rejection-unjustified"
```

Ported from the `pullrequest-review` / `pullrequest-rereview` skills, which already run this exact
vocabulary against real PRs.

**A malformed or missing payload fails the phase.** It must never be read as "no findings", which
would converge the loop on a broken reviewer and pass unreviewed code. A failed phase drops into the
reactor's ordinary recovery ladder and retries under `maxAttempts`.

### D5 — Blocking severity

`critical` and `improvement` block; `nitpick` never does. A review round reporting only nitpicks
converges.

This is the `pullrequest` skill's rule verbatim (convergence on no new 🔴/🟡), and it exists because
a loop that blocks on nitpicks never terminates — there is always another one.

### D6 — The loop reviews the worktree, not a PR

The reviewer diffs the card's branch against `worktree.baseRefName` — which already exists on the
card, and already resolves to the parent's integration branch for a sub-board plan card (D12), so
stacked branches work with no extra design.

*Why not a PR:* nothing in the board creates or pushes one. `externalRef` exists but its only writer
is an agent calling `board_update_card`. Beyond that: `git diff` needs no credentials, works for
Codex / Cursor / Grok threads that have no `gh` auth (D5's provider neutrality), and catching
problems *before* a PR exists is more useful than duplicating what forge review bots already do.

The consequence, accepted: findings live on the card rather than as inline PR comments, so the card
detail view has to render them (D9).

### D7 — Adjudication needs a baseline

The review phase records the SHA it reviewed; triage records the SHA it produced. Adjudicate can then
scope itself to exactly what changed between them rather than re-reading the whole branch.

Without this, adjudicate either re-reviews everything — which is the expensive pass it exists to
avoid — or trusts triage's account of its own work, which is the failure mode `pullrequest-rereview`
was written to catch.

The executor stays pure: it puts both SHAs in the prompt, and the agent runs the `git` command.

### D8 — Rounds and attempts are different counters

| | Counts | Owner | On exhaustion |
| --- | --- | --- | --- |
| `maxAttempts` | retries of a phase whose **thread died** | the reactor's recovery ladder (D13) | escalate to human |
| `rounds` | repeats of a sequence that **completed without converging** | `ReviewLoopExecutor` | complete the stage `blocked` |

`round` lives in t3o-15's `runState`, stamped by the executor. Both are bounded and both end at a
human; conflating them would give 3 attempts × N rounds × 3 phases of ambiguity on the card.

**Round-scoped step ids are what make this work against the existing completion key**, and they are
the whole answer to the collision this spec was deferred over. `BoardStepCompletion` is keyed
`(cardId, stepId)` with first-outcome-wins idempotency (`board.ts:1101`): a second completion for
`(card, "review")` is discarded and the first outcome re-emitted, so round 2 could neither record its
result nor be seen by the executor reading `completions`.

The executor therefore mints `stepId` as `<phase>@<round>` — `review@1`, `triage@1`, `review@2` — so
every phase of every round is a distinct key. The decider's idempotency then does exactly the right
thing at both levels: a single agent double-calling `board_complete_step` within one phase is still
deduplicated, while two rounds of the same phase are two independent records.

`stepId` is already a free `TrimmedNonEmptyString` on the completion, the run row and the
`select-step` command, so **this needs no schema change, no new column and no decider edit** — which
is what keeps D1's "the reactor is unmodified" promise honest. `stepLabel` carries the human form
(`Review · round 2`).

The alternatives considered and rejected: a `runId` or round column on the completion (a schema and
decider change, for a distinction the id can already express), and tracking loop state outside the
completion table (a second source of truth for something the completions already record).

Exhausting the round cap completes the stage with outcome `blocked`: the card stays in Code review,
does not auto-advance (t3o-15 D8 advances only on success), and its unresolved findings stay visible.

### D9 — Findings on the card

The card detail view gains a review panel, reading the same completion payloads the agents write:
findings grouped by round, each showing its severity, its triage disposition and its adjudicated
verdict. A converged card shows the round that came back clean; a capped-out card shows exactly what
is still open.

This is the UI half of D6 — with no PR, the board is the only place findings can live.

## Acceptance criteria

1. `Settings → Board` renders Code review with a `Rounds` field and one block per phase; no add,
   remove or reorder control, and no uniform prompt, model or mode field.
2. Each phase's prompt and model persist independently, and each phase runs on its own model.
3. A card whose review pass reports no blocking findings completes the stage after **one** agent
   invocation — triage and adjudicate never run.
4. A card reporting only `nitpick` findings also converges.
5. A card needing two rounds records **both** rounds' completions under distinct `<phase>@<round>`
   step ids, and both are visible on the card — the round-1/round-2 collision does not occur.
6. Within a single phase, an agent calling `board_complete_step` twice is still deduplicated to the
   first outcome.
7. Exhausting `rounds` completes the stage `blocked`, leaves the card in Code review, does not
   auto-advance, and leaves open findings visible.
8. A phase completing with a malformed or absent payload fails and is retried by the recovery ladder;
   it is never read as "no findings".
9. `ReviewLoopExecutor.planNext` is unit-tested purely — a completions array in, a decision out, with
   no reactor, database, git or thread.
10. `grep` finds no branch on the `review` role outside the executor registry and the settings panel.
11. The supervisor reactor, decider, projector and MCP toolkit are **unmodified** by this spec.
12. The loop holds exactly one concurrency slot for its whole run, released once at the terminal
    outcome, whatever the round count.
13. Every t3o-15 behaviour is unchanged for non-review stages.

### Watched-run items

- A real card runs a full two-round loop end to end, and the round-2 reviewer demonstrably sees
  round-1 findings and verdicts through `board_get_card_context`.
- A long loop holding a slot does not starve the Building queue in practice; if it does, the fix is
  releasing between phases, not shortening the loop.

## Files

| File | Change |
| --- | --- |
| `apps/server/src/board/reviewLoopExecutor.ts` | **new** — the entire loop; registered against the `review` role |
| `packages/contracts/src/board.ts` | `kind: "review"` member of `BoardStageExecution`; the three payload schemas; compiled-in phase ids, labels and default prompts |
| `apps/web/src/components/settings/BoardSettingsPanel.tsx` | the bespoke review card |
| `apps/web/src/board/BoardCardDetailView.tsx` | the findings panel |
