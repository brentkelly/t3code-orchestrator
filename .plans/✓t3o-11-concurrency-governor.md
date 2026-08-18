---
id: t3o-11
title: Concurrency governor — slots, queue ordering, step-boundary preemption
phase: 2
prerequisites: [t3o-10]
---

# Concurrency governor

There is **no concurrency limit anywhere in the T3 server today**. The only semaphores guard settings
writes, keybindings, and the SQLite connection. T3 is throttled by how fast a human can start
threads. T3o removes that throttle, so it has to supply its own.

Without this, a queued sprint means twenty provider CLIs, twenty subprocesses, a melted laptop and a
burned rate limit — and an orchestrator that feels broken rather than powerful.

## Locked decisions

- **D11** — `maxConcurrent` per `providerInstanceId` plus a global ceiling. The Building column is
  the queue. Ordering is **stage descending → started before unstarted → drag order**. Preemption
  takes effect at the **next step boundary**.

## Slot model

A slot is acquired **per running step**, against the step's provider instance — not per card, not per
stage. A card between steps holds nothing.

Per-instance limits are the right unit because rate limits are per-subscription. A single global
number would let three threads on one vendor starve a step assigned to a vendor with headroom, which
is precisely the situation D4's per-step provider assignment exists to exploit.

## Ordering

Applied in order:

1. **Stage descending.** A card one round from merge outranks a card about to start building.
   Finishing beats starting; otherwise new work strangles nearly-done work and everything sits at
   90%.
2. **Started before unstarted.** A card mid-stage waiting for a slot on a *different* provider
   outranks a card that has not begun. Without this, a board fills with half-done work — the
   starvation case created by per-step slot acquisition.
3. **Drag order** (`orderKey`). This governs what starts next, which is what dragging is actually
   for.

## Queue visibility

A queued card sits in **Building**, flagged as queued, with its queue position. It does not sit in
Ready — Ready means "not started"; a queued card has been committed to. And it does not render as
running: a card that claims to be building while it waits is the lying-spinner failure the upstream
`AGENTS.md` calls out by name.

Dragging within Building is queue prioritisation, and the UI must say so on drop (`t3o-05`).

## Preemption

Dragging a card above a running card marks the dragged card **next**. The running card finishes its
**current step**, releases the slot, and returns to the queue at its new position.

Rejected alternatives: no preemption (the drag lies — you move a card to the top and nothing happens
for two hours) and hard preemption (throws away an in-flight turn and the tokens that bought it, and
leaves a worktree mid-edit).

Step boundaries are the only points where the worktree is guaranteed idle, which is the same
property `t3o-09` relies on for `sync-base`.

## Failure modes to build against

- **Slot leaks.** Every terminal outcome releases, including crash and server restart. Reconcile
  held slots against live steps at boot; a leaked slot silently halves throughput forever.
- **Starvation.** Assert that a card cannot remain `queued` indefinitely while lower-priority cards
  start. Rule 2 is the mitigation; test it.
- **Thrash.** Repeated preemption of the same card should be bounded — a card preempted repeatedly
  never finishes.

## Out of scope

- Adaptive throttling from resource telemetry. `server.getResourceTelemetryHistory` exists if it is
  wanted later; fixed limits you can see and predict beat an adaptive system you cannot.

## Verification

- With `maxConcurrent: 1` on an instance, two cards needing it run strictly sequentially.
- A card whose next step targets an idle provider is not blocked by a saturated one.
- Preemption takes effect at the next step boundary, and the preempted card resumes.
- Slot accounting reconciles to zero held after all work drains, including after a forced restart.
