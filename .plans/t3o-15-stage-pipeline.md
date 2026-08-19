---
id: t3o-15
title: Stage pipeline — stage-owned execution, user-defined stages
phase: 2
prerequisites: [t3o-07, t3o-10, t3o-11, t3o-12, t3o-13]
---

# Stage pipeline

`Settings → Board → Pipeline` lets a user build an ordered list of *steps* inside each of eight
fixed stages. Nothing uses it. The only step anyone has ever had is `DEFAULT_BOARD_BUILD_STEP`; the
only multi-step recipe in the repository is a test fixture (`supervisor.test.ts:87`). Seven of the
eight stages render an editor whose output is never executed.

Worse, the feature it models is the wrong one. A stage's steps duplicate what stages already are —
`Planning → Building → Code review` is the pipeline, and expressing "plan then build" as two steps
*inside* Building rebuilds the board one level down. Code review is not a step list either; it is a
**loop** whose phases must be hardcoded, not user-assembled (t3o-16). Splitting a large feature into
parts is a **sub-board** (D12), a card-level structure that has nothing to do with settings.

What users actually lack is the ability to add stages. `Backlog → Sprint → Planning → Ready →
Building → Code review → Ready for merge → Done` is one team's board. Another wants "End-user
testing" after review, or "Triage" before planning.

## Goal

Delete per-stage step lists. Move prompt, model and execution behaviour onto the **stage**. Make the
stage list itself user-editable, with `build`, `review` and `done` locked as the product's spine.

## Scope

**In**

1. Steps stop being user data; every stage runs exactly one step, seeded from code.
2. Stage execution config in settings, keyed by stable stage id: auto-execute, prompt, model, mode,
   human-in-the-loop, auto-advance, timeout, attempts.
3. Stages become a board aggregate in the read model — create, rename, reorder, delete.
4. Generic auto-kickoff: a card landing in an auto-executing stage starts a thread.
5. Per-card human-in-the-loop toggle on Build.
6. Auto-advance to the next stage in order on a successful unattended run.
7. `ProviderModelPicker` (the composer's picker) replaces the provider Select + free-text model box.
8. `board.card.start-stage-thread` command + RPC, the on-demand counterpart of auto-kickoff
   (consumed by t3o-14's `+` menu).
9. The `BoardStageExecutor` seam (D15) — the extension point t3o-16's review loop plugs into
   without touching the reactor.

**Out**

- The Code review loop — rounds, phases, per-phase models, the bespoke settings card. **t3o-16.**
- The card thread pane `+` menu. **t3o-14**, which this spec reduces to that menu alone.
- Plan materialisation / locking, still deferred from t3o-12.
- Backwards compatibility of any kind (D14).

## Locked decisions

**D10 is revised, not discarded.** "Fixed stages, configurable steps" becomes **configurable stages,
one step each**. What survives verbatim: the recipe is typed data in `ServerSettings.board`, defaults
are compiled in so zero configuration works, and **the resolved config is frozen onto the card at
stage entry** so editing settings mid-flight cannot corrupt a running card.

**D4 survives intact.** The board still orchestrates and an agent still executes one step at a time,
completing only via `board_complete_step`. Only the *authorship* of the step list changes.

**D18 is relaxed.** Building → Code review stops being the single hardcoded board-driven crossing and
becomes a per-stage `Auto advance` setting (D8).

**D6 is preserved through `Mode`** rather than through a hardcoded stage name (D5).

---

### D1 — Steps stop being user data; the step machine stays

The array goes; the machine does not. `stepStates`, `stepCompletions`, `board_complete_step`,
`BoardStepSlots`, `selectNextStep` and the recovery/escalation ladder are all retained unchanged.

*Why:* they are the unit of "one agent run" and t3o-16's review loop needs every one of them — three
prompts, three models, a completion contract between each. Removing the machine would leave an
auto-executing stage with no timeout, no attempt cap and no death detection: a thread that ends its
turn without completing is *currently* treated as failure, and losing that makes a stalled build
look finished.

Vocabulary stays "step". It is still accurate — one agent run, of which a normal stage has exactly
one and Review (t3o-16) has several per round — and `board_complete_step` is agent-facing, quoted in
prompts, and not worth churning.

**Deleted:** `BoardPipeline` as `Record<string, BoardStep[]>`; `makeNewBoardStep`, `appendBoardStep`,
`removeBoardStep`, `setBoardStepField`; the `StepEditor` list and its Add/Remove controls;
`BoardResolvedRecipe`, `BoardCardRecipeSnapshot`, `boardRecipeSnapshotDiffersFromCurrent`,
`boardStepsEqual`, `board.card.snapshot-recipe`, `BoardCard.recipeSnapshot`, the
`board_cards.recipe_snapshot` column. The divergence check has **zero production callers** — only
`board.settings.test.ts` — and was built for a card-UI signal that never shipped.

### D2 — Stages live in the read model, not in settings

Stage definitions become a board aggregate: `BoardState.stages`, with create / rename / reorder /
delete commands and events, a `board_stages` table, and a board-ledger migration.

*Why not settings:* `decideBoardCommand({ command, readModel })` (`decider.ts:396`) has no settings
and no SQL client (D8). It validates every transition with `boardStageIndex` /
`areBoardStagesAdjacent` off the compiled-in array. A user-editable stage list must therefore reach
the decider, and there are only two routes:

| | Upstream files touched |
| --- | --- |
| Read-model aggregate | **one word** — `"stage"` into `OrchestrationAggregateKind` (`orchestration.ts:1088`) |
| Settings passed into the decider | `orchestration/decider.ts` signature + pass-through, `OrchestrationEngine.ts:162`, every upstream call site and test |

The aggregate is the *less* invasive option on a fork, and it is the path labels already walked in
t3o-06a — `"label"` joined that same union for the same reason. It also makes stage mutation
transactional with card moves: "refuse to delete a stage that still holds cards" is an ordinary
decider invariant rather than a best-effort check in an RPC handler.

**Settings still own what a stage *does* (D4). The read model owns what a stage *is*.** The decider
never branches on a prompt; only the reactor does, and the reactor has settings in hand.

### D3 — Three roles: `build`, `review`, `done`

A stage carries an optional role. Exactly one stage holds each of the three; the rest carry none.

| Role | Anchors |
| --- | --- |
| `build` | worktree/branch entry point; dependency blocking from here onward; the per-card human-in-the-loop toggle; `Auto advance` default |
| `review` | t3o-16's bespoke settings card and review loop |
| `done` | dependency satisfaction (`unmetBoardCardDependencies`); `archiveAfterDays`; `worktreeRetention` |

**Ordering invariant:** `build` before `review`; `done` last. Custom stages may sit anywhere else —
before, between or after. Enforced in the decider on create and reorder.

Backlog, Sprint, Planning, Ready and Merge become ordinary seeded stages: renameable, movable,
deletable. Nothing keys on their names any more.

- `unmetBoardCardDependencies` (`board.ts:2298`) keys on the `done` role, not `stage === "done"`.
- `isBoardStageReadyOrBeyond` / `isBoardStageBeforeReady` are replaced by "at or after the `build`
  role" (D11).
- `BOARD_CREATABLE_STAGES` is deleted (D10).
- `worktreeRetention: "reclaim-on-merge"` retargets to the `done` role and is renamed accordingly —
  "merge" as a lifecycle anchor stops being meaningful when Merge is a deletable column.
- `advanceStage`'s hardcoded `"review"` target becomes "next stage in order" (D8).

`BoardStage` widens from `Schema.Literals(BOARD_STAGES)` to a branded open string (`BoardStageId`).
It is embedded in persisted event payloads (`board.card-created.stage`,
`board.card-moved.fromStage/toStage`), and a closed literal cannot decode an event naming a
since-deleted stage.

The eight current stages ship as compiled-in seeds with fixed ids and staggered genesis timestamps,
mirroring `BOARD_SEED_LABELS` — so a from-empty replay and a table rehydration produce an identical
stage list.

### D4 — Stage execution config, keyed by stage id

`BoardSettings.pipeline: Record<BoardStageId, BoardStageExecution>`, where `BoardStageExecution` is
a **discriminated union** on `kind` (D15). Every stage this spec ships is `kind: "simple"`; t3o-16
adds `kind: "review"` and nothing else in the codebase learns about it:

```
BoardStageExecution = { kind: "simple", … }        this spec
                    | { kind: "review", … }        t3o-16
```

The `simple` member:

```
BoardStageExecution
  autoExecute      boolean          default false
  prompt           string           required when autoExecute
  model            ModelSelection | null   null = the global text-generation model
  mode             "plan" | "build"        default "plan"
  humanInLoop      boolean                 non-build stages
  humanInLoopWithPlan     boolean          build role only
  humanInLoopWithoutPlan  boolean          build role only, default true
  autoAdvance      boolean                 default true for the build role
  timeoutMs        PositiveInt             unattended only
  maxAttempts      PositiveInt             unattended only
```

Keyed by **stage id, not stage name**, so renaming a stage never orphans its config — the same
lesson `keyPrefix` learned in D14. Whole-map replacement through the stock `deepMerge`, exactly as
today.

The settings card is progressive: `Auto execute` alone by default; everything else appears when it
is on, with `prompt` required. `Timeout` and `Max attempts` render only when the stage is
unattended. `Auto advance` renders only when the stage is not unconditionally human-in-the-loop
(so it always shows on the `build` role, whose human-in-the-loop is per-card).

**Model** is a single `ModelSelection | null`, not today's `providerInstanceId` + free-text `model`
pair — they are only meaningful together, which is why the current UI's Select and text box can
drift apart. `null` lets a new custom stage run on the global default without forcing a provider
decision, something `BoardStep` cannot express.

The control is `ProviderModelPicker` (`apps/web/src/components/chat/ProviderModelPicker.tsx`), the
composer's own picker. It already has a settings-panel precedent at
`SourceControlWritingSettings.tsx:182`, wired with `deriveProviderInstanceEntries` +
`applyProviderInstanceSettings` + `getCustomModelOptionsByInstance`.

#### Seeded defaults

Two stages ship with `Auto execute` on so an empty settings file is a working pipeline.

**Building** — `mode: build`, `humanInLoopWithPlan: false`, `humanInLoopWithoutPlan: true`,
`autoAdvance: true`, prompt as `DEFAULT_BOARD_BUILD_STEP` carries today.

**Planning** — `mode: plan`, `humanInLoop: true`, `autoAdvance: false`, and the prompt text drafted
for the superseded planning spawner, verbatim:

```
Build a plan that allows us to implement the functionality requested on this card. Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time.

If a question can be answered by exploring the codebase, explore the codebase instead.

When we have agreed a plan, record it with board_propose_plans. Do not move the card yourself.
```

The `board_propose_plans` instruction lives in the **prompt**, not in the envelope. The envelope is
generic (D5) and cannot know that one stage happens to be about planning; putting stage-specific
tool guidance in editable text is what makes a user-invented stage able to do the same thing.

Every other stage ships with `Auto execute` off.

### D5 — Mode governs resources; human-in-the-loop governs conversation

Two orthogonal settings, each owning a coherent set of consequences.

| **Mode** | worktree + branch | sandbox | concurrency slot |
| --- | --- | --- | --- |
| `plan` (default) | none | read-only | none |
| `build` | created / reused | write | held |

| **Human in the loop** | prompt envelope | turn ends without `board_complete_step` | timeout / attempts | drop |
| --- | --- | --- | --- | --- |
| on | question-friendly | waiting | not enforced | left alone |
| off (unattended) | `/unattended` preamble | dead → recovered | enforced | auto-resume |

*Why the slot follows Mode and not human-in-the-loop:* a human-in-the-loop **build** is still a real
build, holding a worktree and a provider, and must count against the ceiling — otherwise flipping a
toggle silently breaches `globalMaxConcurrent`. t3o-14's original objection (an hours-long interview
must not hold a slot meant for bounding concurrent builds) is fully satisfied by Mode: a planning
stage is `plan` mode, so it holds nothing.

`composeStepPrompt` currently hardcodes the unattended stance — *"`board_complete_step` is the ONLY
way to complete"* and *"never end a turn with an unanswered question in prose"* (`supervisor.ts:85-88`).
Both are wrong under human-in-the-loop. The postamble branches on the toggle; the unattended branch
is the `/unattended` rules text.

**Flipping mid-run changes nothing about resources.** It sends a turn into the live thread through
the existing `sendTurn` path (`supervisorReactor.ts:163,668`, already used for recovery nudges):
switching to unattended sends the preamble and starts drop-monitoring; switching to human-in-the-loop
sends the inverse and stops auto-healing. No slot is released, no thread is stopped, nothing is
reacquired if the user flips back. `supervisorReactor.ts:810` already establishes that recovery
keeps the slot.

### D6 — Human-in-the-loop is a per-card toggle, on Build only

`BoardCard.humanInLoop: boolean | null` — `null` means untouched. Rendered as a plain two-state
toggle showing the computed default; flipping it writes an explicit value.

The default comes from the Build stage's **two** settings:

- card has a plan → `humanInLoopWithPlan` (default false)
- card has no plan → `humanInLoopWithoutPlan` (default true)

*Why two settings rather than a hidden rule:* "you cannot reach Build without planning first" is
deleted outright — a one-line bug fix from a pasted screenshot does not need a plan. But an
unplanned card has no brief for an agent to work from, so the sensible default is a conversation.
Expressing that as two visible settings puts the behaviour in the UI instead of in code.

Because the value is computed until it is touched, writing a plan before the card reaches Build
moves the default with it — no stale "human in the loop" left over from when the card was planless.
At kickoff the resolved value freezes onto the run row (D12).

Only Build shows the toggle. Elsewhere the stage setting is the whole story.

### D7 — Auto-execute fires on first entry only

A card entering an auto-executing stage for the first time starts a run with the stage's prompt.
**Re-entering that stage starts a clean conversational thread with no prompt injected**, human in
the loop, regardless of the stage's settings.

*Why:* a card dragged back to Build has already satisfied the build prompt. Re-firing it would have
the agent redo work nobody asked for; only the human knows why the card came back, so the human
opens the conversation. Once they have explained it, flipping the toggle to unattended sends the
`/unattended` preamble and supervision resumes on the same thread (D5).

This also fixes a live defect. Today, dragging a card back into Building does **nothing at all**:
`selectNextStep` finds the `succeeded` completion and returns null (`supervisor.ts:104`), and a fresh
Building entry passes `advanceWhenDone: false` (`supervisorReactor.ts:531`), so the card sits there
silently. "First entry" is answerable from the existing `(cardId, stepId)` completion record — no
re-keying needed.

Auto-execute is additionally suppressed when the card already has a live (non-tombstoned) linked
thread for that stage, so a manually adopted thread is never trampled.

Triggers: `board.card-moved (toStage: X)` **and** `board.card-created (stage: X)`. Creating a card
straight into an auto-executing stage is now a real path (D10), and must behave identically to a
drag. `supervisorReactor.start` adds `board.card-created` to its event filter
(`supervisorReactor.ts:889`).

No boot sweep, no retroactive pass — cards already parked in a stage are untouched, or the first
restart after this ships would spawn a thread for every one of them.

### D8 — Auto advance to the next stage in order

On a **successful** completion of an **unattended** run, if the stage's `autoAdvance` is on, the
card moves to the next stage in order.

*Why per-stage and not build-only:* auto-execute makes a card *do* something on arrival, but nothing
makes it *arrive*. A user who adds "End-user testing" with a prompt would find that nothing ever
lands there, because only Building advances and it advances to a hardcoded `"review"`. Without
auto-advance the feature does not compose.

*Why "next in order" and not "the review-role stage":* inserting a stage between Build and Review
must not be skipped. Same name-decoupling applied everywhere else in this spec.

Never on `blocked` or `failed`; never for a human-in-the-loop run (there is no completion signal to
trigger on). `stay` remains right for a conversational stage — which is D18's original instinct
("a human moves Planning → Ready"), now a setting rather than a hardcoded rule.

### D9 — Stage lifecycle

**Rename** — label only, `id` immutable, always allowed, no side effects.

**Delete** — refused if the stage holds **any** card, archived included. Refused outright for the
three role-holders. The error names the count.

*Rejected:* relocating cards to a neighbour (invisible data movement, and the destination may be a
different Mode, so a card could land somewhere expecting a worktree it does not have); cascade
archiving (destructive). This is why **t3o-13 is a prerequisite**: `listBoardCardShellRows` filters
`WHERE archived_at IS NULL` (`projection.ts:411`), so without an archive view the error is a dead
end — "move 3 archived cards out first", with no way to see them.

**Reorder** — allowed subject to the D3 ordering invariant, and **refused in either direction across
the `build` boundary while the stage holds cards**.

*Why:* crossing that boundary changes the answer to "is this card subject to dependency blocking?",
and `blocked` is a stored column re-derived at each move (`decider.ts:274`) — a stale flag renders a
badge the decider disagrees with, the class of bug t3o-13 exists to fix. Refusing the move removes
the hazard instead of handling it. Symmetric in both directions because the reverse crossing needs
the same re-derivation, and symmetry is easier to explain.

Reorder never moves cards and never retro-applies Mode: a card in a stage that moves does not
retroactively gain a worktree, it gets one on its next Build-mode stage entry. Mass-provisioning on
a settings drag is precisely the cost explosion D6 was written to prevent.

**Create** — insert at any position satisfying the ordering invariant.

### D10 — A card may be created into any stage

`BOARD_CREATABLE_STAGES` is deleted. Its rationale — "later stages describe work the board has
already started shepherding" — does not survive user-defined stages, where "mid-pipeline" is
whatever the user drew. Its real job was keeping cards out of Building because Building implied a
worktree and a slot; those now come from **Mode**, applied on stage entry regardless of how the card
arrived, so creation and dragging follow an identical path.

It also serves the flow this spec is built around: create a card directly in Build, paste a
screenshot, no plan → human-in-the-loop defaults on → a conversation starts immediately.

**Required guard:** the create dialog states when the chosen stage auto-executes — *"Building runs
automatically — creating here starts an agent."* Without it this is a footgun.

### D11 — Dependency blocking is unconditional from `build` onward

A card with unmet dependencies cannot enter the `build`-role stage or anything after it. No plan
trigger, no `Ready` anchor — Ready is now an ordinary deletable stage. Simpler than either anchor it
replaces, and it survives arbitrary user stages.

Sub-board plan cards (D12), currently restricted to the Ready-onward subset via
`isBoardStageBeforeReady`, are restricted to **at or after the `build` role** — plan cards are
materialised work, not backlog.

### D12 — The run row is the frozen config

Stage entry resolves the stage's execution config once and writes it onto the card's step-state row:
`prompt`, `providerInstanceId`, `model`, `timeoutMs`, `maxAttempts`, `humanInLoop`, `mode`.

That is the whole of D10's snapshot guarantee, in one place instead of two. `BoardCardStepState`
already carries `stepId`, `stepLabel` and `maxAttempts` for exactly this reason (`board.ts:693`);
this completes the set and deletes the card-level snapshot (D1). All six `recipeSnapshot` lookups in
the reactor (`supervisorReactor.ts:449,470,522,528,579`) become field reads.

A `null` `ModelSelection` resolves to the concrete global default here, so a running card is
unaffected by a later change to that default.

### D13 — Board UI reads the stage list from the read model

Column order, labels and collapse state come from `BoardState.stages`, not from `BOARD_STAGES` /
`BOARD_STAGE_LABELS` (`apps/web/src/board/boardStages.ts`, deleted). The two exhaustive per-stage
`switch`es — `boardCardSummary.ts:63` and `boardStageActions.ts:42` — become lookups with a default
branch. Collapse state (`boardUiStore.ts:59`) keys on stage id, defaulting collapsed for the first
stage rather than for the literal `"backlog"`.

### D14 — Greenfield: no backwards compatibility

No settings migration, no lenient decoder, no legacy union, no additive-only table changes. There
are no installs beyond one dev server, and its database may be recreated.

Worth recording *why* this would otherwise matter: `loadSettingsFromDisk` decodes `settings.json` as
one unit and, on any decode failure, logs a warning and returns `DEFAULT_SERVER_SETTINGS` — the
**entire** file (`serverSettings.ts:296-304`). A shape change that cannot decode the old file
silently discards every unrelated setting: provider instances, model defaults, all of it. If this
project ever ships to a second machine, that hazard returns and the answer is a lenient decoder on
the changed field, never a migration script.

### D15 — The stage executor seam

The reactor must not learn what kind of stage it is driving. A `if (stage.role === "review")` branch
in the supervisor is the beginning of review logic leaking through the reactor, the decider, the
projector and the board UI.

So the reactor keeps everything generic — stage-entry detection, worktree provisioning, slot
acquisition, thread spawn, `sendTurn`, death detection, the recovery ladder, auto-advance — and
delegates exactly one question to a **stage executor**: *what runs next, or are we done?*

```
BoardStageExecutor.planNext({ card, config, completions, runState })
  -> { kind: "run", round, stepId, label, prompt, model, timeoutMs, maxAttempts }
   | { kind: "complete", outcome }
   | { kind: "escalate", question }
```

Pure — no SQL, no git, no thread handles — so it is unit-testable without a reactor, in the same
spirit as `selectNextStep` and `decideBoardCommand`.

This spec ships one implementation, `SimpleStageExecutor`, which wraps `selectNextStep` and returns
`complete` as soon as the stage's single step has succeeded. t3o-16 adds `ReviewLoopExecutor`,
holding the entire review loop — phases, rounds, convergence — inside itself.

Resolution is a **registry keyed by stage role**, consulted in exactly one place. Combined with the
settings union in D4, the whole codebase branches on stage kind in precisely two spots:

| Branch point | Owner |
| --- | --- |
| Which settings card to render | `BoardSettingsPanel` |
| Which executor to run | the executor registry |

Reactor, decider, projector, MCP toolkit and board UI stay uniform.

Two boundaries this fixes by construction:

- **The slot belongs to Mode, not the executor** (D5). A multi-phase executor holds one slot for its
  whole run rather than re-acquiring per phase — a half-finished loop never stalls behind newer work,
  at the cost of a longer-held slot.
- **The executor never sees a diff or a repository.** It returns a prompt; the *agent* runs `git` in
  its worktree. Git stays out of the decision path entirely, which is what keeps `planNext` pure.

`runState` carries the `round` the executor stamps, which is also what keeps rounds and
`maxAttempts` from being confused: `maxAttempts` is the reactor's recovery ladder for a step whose
thread died, `round` is the executor's counter for a sequence that completed but did not converge.
Different owners, different lifecycles.

---

## Seam inventory

Checked against t3o-02a.

**Upstream — one word, once:**

1. `OrchestrationAggregateKind` (`packages/contracts/src/orchestration.ts:1088`) — `"stage"` joins
   `["project","thread","card","label"]`. The identical widening labels made in t3o-06a.

Everything else grows in board-owned files:

- `BoardState.stages` — `BoardState` is board-owned and already carries five optional slices.
- Stage commands / events append to `BOARD_CLIENT_COMMANDS`, `BOARD_INTERNAL_COMMANDS`,
  `BOARD_EVENT_TYPES` — registries that upstream spreads.
- `BOARD_SETTINGS_SEARCH_ITEMS` (`apps/web/src/board/boardSettingsSearch.ts`) — already a spread;
  entries change, the seam does not.
- New board migrations in the board ledger (`apps/server/src/board/migrations/index.ts`), numbered
  from 14. Board migrations have their own `t3o_sql_migrations` table.

## Acceptance criteria

1. `Settings → Board → Pipeline` shows one card per stage with a single `Auto execute` toggle; no
   Add step / Remove step control exists anywhere.
2. Turning `Auto execute` on reveals prompt, model, mode, human-in-the-loop and auto-advance; saving
   with an empty prompt is refused.
3. The model control is `ProviderModelPicker`, opens the composer's model list, and persists a
   `ModelSelection`; leaving it unset runs the stage on the global text-generation model.
4. A card dragged into a `plan`-mode auto-executing stage starts a thread with **no** worktree, no
   branch, and no concurrency slot consumed.
5. A card dragged into a `build`-mode unattended stage provisions a worktree, holds a slot, and is
   recovered if its thread dies — t3o-10/11/12 behaviour unchanged.
6. A card with no plan entering Build shows its human-in-the-loop toggle already on; writing a plan
   first shows it off; flipping it explicitly survives both.
7. Flipping human-in-the-loop mid-run sends a turn into the live thread, and the card's slot,
   worktree and thread are untouched.
8. A successful unattended run advances the card to the **next stage in order** — verified with a
   custom stage inserted between Build and Code review, which is not skipped.
9. A human-in-the-loop run never auto-advances, and neither does a `blocked` or `failed` outcome.
10. Dragging a card back into Build starts a clean thread with no prompt injected, human in the
    loop, and does not re-run the build prompt.
11. Adding a stage between Ready and Building, setting a prompt and auto-execute, and dragging a
    card in starts an agent — with no code change.
12. Renaming a stage preserves its execution config and every card in it.
13. Deleting a stage holding any card, archived included, is refused with the count; deleting an
    empty non-role stage succeeds; deleting a role-holder is refused.
14. Reordering a stage across the Build boundary while it holds cards is refused in both directions;
    reordering it while empty succeeds.
15. Creating a stage that would put `review` before `build`, or anything after `done`, is refused.
16. A card can be created directly into any stage, and the create dialog warns when that stage
    auto-executes.
17. A card with unmet dependencies cannot enter the `build`-role stage or anything after it,
    whatever the stages are called.
18. A from-empty event replay and a table rehydration produce an identical stage list.
19. `SimpleStageExecutor.planNext` is unit-tested with no reactor, no database and no git.
20. The supervisor reactor contains **no** branch on stage role or stage id; the only role lookup is
    the executor registry, and the only stage-kind branch in the web app is the settings card.
21. `pnpm test` passes, with t3o-10/11/12 supervisor suites adapted only where the step array became
    a single seeded step.

### Watched-run items

- A `plan`-mode stage does not hard-block the MCP write tools its prompt needs; the fallback is
  `interactionMode: "default"`.
- A human-in-the-loop build parked waiting on a human holds its slot, and the Building column shows
  which cards are waiting on the user rather than working.

## Files

| File | Change |
| --- | --- |
| `packages/contracts/src/orchestration.ts` | `"stage"` into `OrchestrationAggregateKind` (the only upstream edit) |
| `packages/contracts/src/board.ts` | `BoardStageId`, `BoardStageDefinition`, `BoardStageRole`, seeds, ordering invariant; `BoardStageExecution` replaces `BoardStep`/`BoardPipeline`; stage CRUD commands + events; `BoardCard.humanInLoop`; delete the recipe-snapshot family; role-key the dependency/lifecycle helpers |
| `apps/server/src/board/decider.ts` | stage CRUD invariants; role-keyed gates; `blocked` derivation from the `build` role |
| `apps/server/src/board/projector.ts` / `projection.ts` | `stages` slice; run-row config columns; drop `recipe_snapshot` |
| `apps/server/src/board/supervisor.ts` | `composeStepPrompt` branches on human-in-the-loop; `/unattended` postamble |
| `apps/server/src/board/stageExecutor.ts` | **new** — `BoardStageExecutor`, `SimpleStageExecutor`, the role-keyed registry (D15) |
| `apps/server/src/board/supervisorReactor.ts` | generic auto-kickoff; first-entry vs re-entry; Mode-driven worktree/slot; auto-advance to next in order; mid-run toggle turn; `board.card-created` in the event filter; `start-stage-thread` |
| `apps/server/src/board/migrations/014_…` onward | `board_stages`; run-row columns; drop `recipe_snapshot` |
| `apps/server/src/board/rpc.ts` | stage CRUD + `startStageThread` RPCs |
| `packages/client-runtime/src/state/board.ts` | stage CRUD + `startStageThread` environment commands |
| `apps/web/src/components/settings/BoardSettingsPanel.tsx` | stage cards replace the step editor; `ProviderModelPicker`; stage CRUD + reorder |
| `apps/web/src/board/boardStages.ts` | deleted — labels come from the read model |
| `apps/web/src/board/BoardPage.tsx`, `boardCardSummary.ts`, `boardStageActions.ts`, `boardUiStore.ts` | dynamic columns; switches become lookups |
| `apps/web/src/board/BoardCardCreateDialog.tsx` | any-stage creation + auto-execute warning |
| `apps/web/src/board/BoardCardDetailView.tsx` | per-card human-in-the-loop toggle on Build |
