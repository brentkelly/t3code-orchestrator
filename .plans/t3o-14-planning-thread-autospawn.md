---
id: t3o-14
title: Planning stage — auto-spawn the planning thread, and an adopt-or-create thread menu
phase: 2
prerequisites: [t3o-06, t3o-07, t3o-08, t3o-10]
---

# Planning stage — auto-spawn the planning thread, and an adopt-or-create thread menu

Dragging a card into Planning does nothing today. The card modal's thread pane offers only
"Adopt a thread" (`BoardCardThreadPane.tsx:184`), because when t3o-06 shipped, board-driven
thread spawning did not exist yet — the empty state literally says so. It exists now
(`supervisorReactor.ts`, t3o-10), but is hardwired to `toStage === "building"`
(`supervisorReactor.ts:850`), and the default pipeline defines a recipe only for `building`
(`DEFAULT_BOARD_BUILD_STEP`, `packages/contracts/src/board.ts:2431`).

So Planning is a stage the human enters and then has to hand-start every time.

## Goal

Entering Planning starts the planning conversation by itself: the board creates a thread,
links it to the card, and sends a settings-editable prompt that tells the agent to interview
the human until there is a plan. And the card thread pane's `+` becomes a real menu — restart
planning, start a blank thread, or adopt an existing one.

## Scope

**In**

1. A compiled-in default `planning` recipe step, editable at `Settings → Board → Pipeline`.
2. A lightweight planning spawner in the supervisor reactor: `board.card-moved → planning`
   and `board.card-created (stage: planning)` create + link + prompt a thread.
3. A planning prompt envelope (preamble + postamble) around the settings `promptTemplate`.
4. A new board command/RPC that starts a stage thread on demand, so the UI can re-trigger it.
5. The `+` menu in `BoardCardThreadPane`: restart planning / new blank thread / adopt.

**Out**

- Any change to Building. The step machine, governor, worktrees and recovery are untouched.
- Auto-advancing a card out of Planning. D18 holds: the only board-driven stage crossing
  remains Building → Code review. A human moves Planning → Ready.
- Plan materialisation / locking (still deferred from t3o-12).
- A `/t3o-plan` skill file. The prompt lives in settings instead — see D2.

## Key decisions

### D1 — Lightweight spawn, not the step machine

Planning spawns a thread and stops. **No** recipe snapshot, **no** `stepStates` row, **no**
governor slot, **no** worktree, **no** timeout, **no** `board_complete_step` contract, **no**
recovery escalation.

*Why:* every one of those is wrong for an interview. A grill session is human-paced and can
last hours — it would hold a `BoardStepSlots` slot meant for bounding concurrent *builds*.
`schedule()` skips any card without a ready worktree (`supervisorReactor.ts:452`), so a
planning step would force a branch + worktree onto cards that may never be built. And a turn
that ends without `board_complete_step` is treated as death (`threadIsAlive`,
`supervisorReactor.ts:97`) — which is exactly what an interview does between every question,
so the supervisor would nudge and then escalate a perfectly healthy conversation.

*Rejected:* generalising `beginCardBuild` to any stage with a recipe. Same code path, three
subsystems that all have to be special-cased off for it. Cheaper to not enter them.

### D2 — The prompt lives in settings, not in a skill

The planning prompt is the `promptTemplate` of the first step of the `planning` recipe, read
from `BoardSettings.pipeline.planning[0]`. `Settings → Board → Pipeline`
(`BoardSettingsPanel.tsx:239`) **already** renders every stage including Planning with a prompt
textarea, provider-instance picker and model picker — Planning's list is just empty and
unexecuted today. Nothing new is built for the editing surface.

*Why not a `/t3o-plan` skill:* a slash-command skill must physically exist in the repository the
thread opens on. A skill shipped in *this* fork would be a no-op for a card on any other
project, and for Codex/Cursor/Grok threads regardless of project. Settings text works
everywhere and the user can edit it, which a hidden skill file cannot claim.

Planning honours **only** `promptTemplate`, `providerInstanceId` and `model` from the step.
`timeoutMs`, `maxAttempts` and any steps after the first are ignored (they belong to the step
machine, which D1 declines to enter). The settings UI still shows those fields — accept the
cosmetic inconsistency; hiding them per stage is more UI surgery than the confusion is worth.

**The shipped default `promptTemplate`, verbatim:**

```
Build a plan that allows us to implement the functionality requested on this card. Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time.

If a question can be answered by exploring the codebase, explore the codebase instead.
```

Provider instance and model default to the same values `DEFAULT_BOARD_BUILD_STEP` uses, so an
empty settings file still yields a runnable planning stage.

### D3 — A planning envelope, mirroring `composeStepPrompt`

`composePlanningPrompt` wraps the settings text the way `composeStepPrompt`
(`supervisor.ts:composeStepPrompt`) wraps a build step, but with the *planning* contract:

```
You are planning card <KEY> — "<title>".
Stage: planning.
Call board_get_card_context for the brief, labels, dependencies and prior activity.

<promptTemplate from settings>

When you and the human have agreed a plan, record it with board_propose_plans — that is the
planning output the board reads. A human moves the card to Ready; do not move it yourself.
If you need a human decision, <providerQuestionMechanism(instance)>; never end a turn with an
unanswered question in prose.
```

This is what satisfies "the agent should be able to retrieve the details of the card it is
assigned to": `board_get_card_context` already resolves the card from the calling thread
(`handlers.ts:167`) and returns title, brief, labels, stage, dependency states, prior steps,
proposed plans and activity. It needs no card id — only the link, which the spawner creates.

The postamble must **not** mention `board_complete_step`: no step exists (D1), and the tool
would fail on a missing `stepId`. `providerQuestionMechanism` is reused unchanged.

### D4 — Plan mode, project root, no worktree

The thread is bootstrapped on the project's normal workspace — `worktreePath: null`,
`branch: null` — with `runtimeMode: "full-access"` and **`interactionMode: "plan"`**.

*Why:* planning is a conversation about a card that may never be built; provisioning a branch
and worktree for it is cost and a new pre-start failure mode. Plan mode keeps the agent out of
the shared working tree while still letting it read the codebase, which the default prompt
explicitly asks it to do.

*Verified:* `interactionMode: "plan"` maps to the Claude SDK's `setPermissionMode("plan")`
(`ClaudeAdapter.ts:4339`). Consequence to watch: `board_propose_plans` is not annotated
read-only, so plan mode will surface it as an approval prompt rather than running silently.
That is acceptable (the human sees the plan being recorded) — but it is the first thing to
check on the live run, and the fallback if it hard-blocks is `interactionMode: "default"`.

### D5 — Suppression: any live linked thread

The spawn is skipped iff the card has **at least one non-tombstoned thread link, of any role**.
The literal reading of "don't create one if there's already a thread assigned to the card".

| card's links | spawn? |
| --- | --- |
| none | yes |
| `build` (live) | no |
| `linked` (live, manually adopted) | no |
| `plan` (live) | no |
| `plan` (tombstoned only) | yes |

Consequence, accepted deliberately: a card dragged **back** from Building to Planning for
rework does *not* get a fresh planning thread, because its build thread is still linked. The
`+ → New thread — restart planning` menu item (D7) is the escape hatch.

### D6 — Trigger: moved into Planning **or** created into Planning

Both `board.card-moved (toStage: planning)` and `board.card-created (stage: planning)` spawn.
Creating into Planning is a real path — the create dialog's stage picker and `board_create_card`
(which admits `backlog | sprint | planning`) both use it, so an agent filing a card straight
into Planning must get the same behaviour as a drag.

No boot sweep and no retroactive pass. Cards already parked in Planning stay untouched;
otherwise the first restart after this ships would spawn a thread for every one of them.
`supervisorReactor.start` must add `board.card-created` to its event filter
(`supervisorReactor.ts:889`) alongside the four it already passes.

### D7 — The `+` menu

`BoardSearchAddPicker` is currently the whole `+` affordance. It becomes a dropdown:

```
Planning:   [ New thread — restart planning ]   → server-side stage spawn (D8)
            [ New blank thread              ]   → empty thread, linked, composer focused
            [ Adopt an existing thread…     ]   → today's search picker

Every       [ New thread                    ]   → empty thread, linked, composer focused
other       [ Adopt an existing thread…     ]
stage:
```

The restart item appears **only in Planning** — never in Building. In Building the supervisor
owns the threads; a lightweight spawn there would produce a thread carrying the build prompt
that has no step state, no worktree and no slot, and that the supervisor does not know exists.
Restarting a build stays a supervisor concern (drag out and back). The restart item is also
hidden when the planning recipe has no steps.

"New blank thread" creates a thread with no first turn and links it — the agent still resolves
the card through `board_get_card_context` once the human types. Client-side: `threadEnvironment.create`
then the existing `boardEnvironment.linkThread` (`state/board.ts:482`), role `"linked"`.

### D8 — On-demand spawn is a server command, not client-composed

"Restart planning" cannot be composed in the browser: the prompt and the envelope live on the
server, and duplicating `composePlanningPrompt` client-side guarantees drift. Add a board
command + RPC (`board.card.start-stage-thread` / `boardEnvironment.startStageThread`) that the
supervisor reactor handles through the **same** function the automatic trigger calls.

The difference between the two entry points is only the suppression check: the automatic
trigger applies D5, the explicit command does not (you asked for it — that is the point of the
escape hatch on a card that already has a build thread).

### D9 — Failure and edge behaviour

- Planning recipe has zero steps → no spawn, `logDebug`, restart menu item hidden. Mirrors
  `beginCardBuild`'s existing "stage has no steps" path (`supervisorReactor.ts:492`).
- Spawn dispatch fails → `logWarning`, no card mutation, no retry. The `+` menu is the recovery.
- Thread title: `` `${card.key} · ${step.label}` `` — same shape as build threads
  (`supervisorReactor.ts:299`); default label `Plan`.
- Link role: the step's `id` (default `"plan"`), matching how build threads link with `step.id`.
- The planning thread is an ordinary thread: it appears in the Threads sidebar, can be opened
  full-screen from the pane, and can be unlinked or deleted like any other.

## Acceptance criteria

1. Dragging a card with no linked threads from Sprint into Planning creates a thread inside the
   card modal within one board round-trip, titled `<KEY> · Plan`, running the default prompt.
2. That thread's agent can call `board_get_card_context` and get back the card's title, brief
   and labels without being told the card id.
3. Dragging a card that already has a live linked thread into Planning creates nothing.
4. Deleting the planning thread and dragging the card out and back into Planning creates a new
   one (tombstoned links do not suppress).
5. `board_create_card` with `stage: "planning"` produces a card that already has its planning
   thread when it appears on the board.
6. Editing the Planning prompt at `Settings → Board → Pipeline` changes what the *next* card
   entering Planning is asked; a card already planning is unaffected.
7. Clearing every Planning step in settings stops the auto-spawn and hides the restart menu item.
8. The `+` menu in Planning offers all three items; in Building and Backlog it offers two, with
   no "restart" item.
9. "New blank thread" produces an empty thread already linked to the card, with the composer focused.
10. A planning thread completing `board_propose_plans` does **not** move the card — it stays in
    Planning until a human moves it.
11. `pnpm test` passes, including the existing t3o-10/t3o-11/t3o-12 supervisor suites unchanged —
    no Building behaviour regressed.

### Watched-run items (not unit-assertable)

- Plan mode does not hard-block `board_propose_plans` (D4). If it does, flip to
  `interactionMode: "default"` and note it.
- The planning thread survives a server restart mid-conversation as an ordinary thread, and no
  reconciliation pass tries to recover or respawn it.

## Files

| File | Change |
| --- | --- |
| `packages/contracts/src/board.ts` | `DEFAULT_BOARD_PLANNING_STEP`; add `planning` to the default pipeline; `board.card.start-stage-thread` command |
| `apps/server/src/board/supervisor.ts` | `composePlanningPrompt` (pure, unit-tested) |
| `apps/server/src/board/supervisorReactor.ts` | planning spawn path; `board.card-created` in the event filter; handle the new command |
| `apps/server/src/board/decider.ts` / `projector.ts` | accept + project the new command |
| `apps/server/src/board/rpc.ts` | `startStageThread` RPC |
| `packages/client-runtime/src/state/board.ts` | `startStageThread` environment command |
| `apps/web/src/board/BoardCardThreadPane.tsx` | the `+` dropdown; rewrite the stale empty-state copy |
| `apps/web/src/board/BoardCardDetail.tsx` | wire the two new actions |
