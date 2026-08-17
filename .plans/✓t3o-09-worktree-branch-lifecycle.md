---
id: t3o-09
title: Worktree and branch lifecycle
phase: 2
prerequisites: [t3o-03]
---

# Worktree and branch lifecycle

When a card gets a branch, when it gets a worktree, who is allowed to touch it, and when it is
reclaimed.

## Locked decisions

- **D6** — planning runs read-only in the project root with no worktree and no branch. The branch
  and worktree are created on entry to **Building** and reclaimed at archive.
- **All threads on a card share one worktree, and steps within a card are serialised.** Two agents
  in one worktree corrupt each other.
- **D12** — the `sync-base` step, never a write into a live worktree.

## Why lazy

`VcsCreateWorktreeInput` creation triggers the project's `runOnWorktreeCreate` script — in this repo
`vp i` plus a dependency-cache warm. Minutes and gigabytes per worktree. Two hundred planned cards
must cost nothing.

## Planning without a worktree

`thread.create` accepts `worktreePath: null` (project root) and `ProviderSandboxMode` includes
`"read-only"`. A planning thread reads the codebase in place and emits its plan through MCP
(`t3o-08`), so nothing needs to be written and nothing needs a branch.

Two consequences to handle explicitly:

- **Read-only sandbox support varies by provider.** The recipe's planning step must be validated
  against the assigned provider instance at stage entry, and refuse with a clear message rather than
  silently running a writable agent in the project root.
- Multiple cards may plan concurrently in the same project root. That is safe *only* because they
  are read-only, so this is an invariant to assert, not an assumption to hold loosely.

## Building entry

On entry to Building:

1. Create the card's branch from the project's default branch (or from the parent card's
   integration branch when `parentCardId` is set).
2. Create the worktree with `baseRefName` set accordingly, and run the project's worktree setup
   script.
3. Materialise the plan to `.plans/` and emit `board.plan.locked` (D8, `t3o-08`).
4. Record `worktreePath` and `branch` on the card; every subsequent thread on the card is created
   with that same `worktreePath`.

Worktree creation is slow and can fail. It is a **step** with its own state, retries and visible
failure — not a silent precondition. A card stuck installing dependencies must say so.

## Serialisation

One writer at a time per card worktree, enforced by the supervisor (`t3o-10`). This is the invariant
that makes the whole design safe; state it in code as an assertion, not just in prose.

## Base drift

Sibling cards branch from the same base and diverge as siblings merge. Resolution is a **`sync-base`
step**, enqueued at a stage boundary where the worktree is guaranteed idle. It is an ordinary step:
its own thread, its own provider assignment, its own retry, its own failure gate. Conflicts become a
visible card state, not a background explosion.

If the base moved since the last review round began, the merge stage runs one final single-reviewer
round on the rebased diff, so the reviewed diff is the merged diff. (The review pipeline itself is
post-MVP; the hook belongs here.)

## Reclaim

Worktrees are reclaimed on archive, and optionally earlier per a retention setting
(`keep until Done` default, or `release when idle N days`). Reclaim requires the tree to be **clean
and pushed**; otherwise the card is flagged and reclaim is skipped. Never delete uncommitted work to
save disk.

The web app already has `worktreeCleanup` logic; reuse rather than reinvent, and make sure a
card-owned worktree is not reclaimed by the generic path behind the board's back.

## Out of scope

- Sub-board integration branches beyond schema (post-MVP), though `baseRefName` support is built here
  because it is the same code path.

## Verification

- A card planned and left for a week has no worktree and no branch.
- Entering Building creates both, runs the setup script, and materialises the plan file.
- A failed worktree creation surfaces as a failed step with a retry, not a wedged card.
- A dirty worktree is not reclaimed, and says why.
- Two threads on one card never hold the worktree simultaneously — assert it.
