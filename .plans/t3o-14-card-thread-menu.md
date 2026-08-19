---
id: t3o-14
title: Card thread pane — an adopt-or-create thread menu
phase: 2
prerequisites: [t3o-06, t3o-15]
---

# The card thread pane `+` menu

The card modal's thread pane offers exactly one action: "Adopt a thread"
(`BoardCardThreadPane.tsx:184`). When t3o-06 shipped, board-driven thread spawning did not exist —
the empty-state copy literally says so. It exists now, and t3o-15 generalises it to any stage.

So the pane is left claiming the board cannot start a thread, while the board starts threads by
itself on every stage entry, and a human who wants a *second* thread — or wants to restart one they
deleted — has no way to ask for one.

## What this spec used to be

This was "Planning stage — auto-spawn the planning thread". **t3o-15 subsumes that half.** Planning
is no longer special: it is a stage with `Auto execute` on, `Mode: plan`, human-in-the-loop on, and a
seeded prompt. The bespoke planning spawner, the planning-specific envelope, the settings-vs-skill
argument and the plan-mode/no-worktree decision all became general stage behaviour there.

What did **not** generalise is the UI half, which is all that remains here.

## Scope

**In**

1. The `+` affordance becomes a dropdown: restart the stage thread / new blank thread / adopt.
2. The stale empty-state copy is rewritten.
3. Wiring to `board.card.start-stage-thread` (the command and RPC ship in t3o-15).

**Out**

- Auto-kickoff, prompts, envelopes, Mode, human-in-the-loop. All t3o-15.
- Any new server behaviour. This spec adds no command, no event, no reactor path.

## Locked decisions

### D1 — The menu

`BoardSearchAddPicker` is currently the whole `+` affordance. It becomes a dropdown:

```
Stage auto-executes:   [ New thread — restart <stage label> ]   → board.card.start-stage-thread
                       [ New blank thread                   ]   → empty thread, linked, composer focused
                       [ Adopt an existing thread…          ]   → today's search picker

Otherwise:             [ New thread                         ]
                       [ Adopt an existing thread…          ]
```

The restart item appears only when the card's current stage has `Auto execute` on, and is **disabled
while a supervised run is in flight for that card** — restarting under the supervisor would leave two
threads believing they own the same step. Drag out and back remains the way to restart a supervised
run, which under t3o-15's D7 gives a clean conversational thread rather than a silent no-op.

### D2 — Restart is a server command, not a client-composed prompt

The prompt and its envelope live on the server. Composing them in the browser guarantees drift the
first time the envelope changes, so the menu item dispatches
`board.card.start-stage-thread` (t3o-15) and the reactor handles it through the **same** function the
automatic trigger calls.

The only difference between the two entry points is suppression: the automatic trigger skips a card
that already has a live linked thread for the stage (t3o-15 D7); the explicit command does not. That
is the entire point of an escape hatch — you asked for it on a card that already has a thread.

### D3 — "New blank thread"

Creates a thread with no first turn and links it, role `"linked"`. No prompt, no envelope, no step.
The agent still resolves the card through `board_get_card_context`, which reads the calling thread's
link (`apps/server/src/mcp/toolkits/board/handlers.ts:162`, `requireCallerCard`) and needs no card id — so a human can simply start typing.

Client-side: `threadEnvironment.create`, then the existing `boardEnvironment.linkThread`
(`state/board.ts:482`). The composer takes focus on open.

### D4 — Edge behaviour

- Stage does not auto-execute → the restart item is absent, not disabled.
- Dispatch fails → `logWarning`, no card mutation, no retry; the menu is its own recovery.
- Thread title follows the existing shape (`supervisorReactor.ts:299`): `` `${card.key} · ${label}` ``.
- Threads created here are ordinary threads — they appear in the sidebar, open full-screen, and can
  be unlinked or deleted like any other. Deleting one leaves a tombstone, which does not suppress a
  future auto-spawn.

## Acceptance criteria

1. The `+` in the card thread pane opens a menu rather than going straight to the adopt picker.
2. On a card in an auto-executing stage the menu offers three items; elsewhere two, with no restart
   item.
3. The restart item is disabled, with a reason, while that card has a supervised run in flight.
4. Restart produces a thread running the stage's configured prompt through the server-side envelope —
   byte-identical to what an automatic kickoff would send.
5. Restart works on a card that already has a live linked thread (no suppression on the explicit path).
6. "New blank thread" produces an empty linked thread with the composer focused, and its agent can
   call `board_get_card_context` successfully without being told the card id.
7. The empty-state copy no longer claims the board cannot start threads.
8. No server-side behaviour changes: the t3o-15 supervisor suites pass untouched.

## Files

| File | Change |
| --- | --- |
| `apps/web/src/board/BoardCardThreadPane.tsx` | the `+` dropdown; rewrite the empty-state copy |
| `apps/web/src/board/BoardCardDetail.tsx` | wire the two new actions |
