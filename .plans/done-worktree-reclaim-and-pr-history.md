# Reclaim worktrees at Done, and give a card a PR history

## Goal

A card that reaches Done with a merged pull request gives its disk back: the
worktree is removed, the local branch deleted, the remote branch deleted. A card
dragged back out of Done rebuilds itself lazily and safely — a fresh worktree, a
fresh cut of the same branch, and a new pull request that cannot be confused
with the one that already merged.

The disk problem is real and currently unbounded: `archiveAfterDays` has **no
consumer anywhere in the server**, so a Done card never archives on its own, and
`handleArchived` is the only thing that ever reclaims a worktree. Dozens of Done
cards means dozens of live worktrees, each one a `vp i` and a dependency cache.

## Scope

### In

1. Reclaim a card's worktree when it is in the done-role stage and its PR is
   observed merged — from any of the existing D2 refresh triggers, not only the
   stage move.
2. Local branch deletion now actually succeeds, because the worktree that held
   it is gone by the time cleanup runs.
3. `BoardLifecycleSettings` reshaped: `worktreeRetention` and `archiveAfterDays`
   both removed, replaced by a single `reclaimWorktreeOnDone: boolean`.
4. A boot-time sweep so the pile that already exists gets reclaimed.
5. A card aggregate that holds **many** pull requests over its life: current one
   plus history, with a floor that keeps rounds from bleeding into each other.
6. Re-provisioning a reclaimed worktree, which the decider refuses today.
7. `Merge PR #23` on the merge button; **View PR** and the column badge fall
   back to history.

### Out

- Any auto-archiver. `archiveAfterDays` is deleted, not implemented — it only
  ever existed to bound worktree bloat, which this spec bounds directly.
- Reclaiming a card that reaches Done without a merged PR. Its commits may live
  nowhere but that worktree's branch; it waits for archive.
- Any new PR polling. Zero forge calls are added by this spec.
- A pull-request history panel in card detail. The list is stored; only the
  current entry and the newest historical one are rendered.

## Key decisions

### D1 — Reclaim fires on "in Done + PR observed merged", not on the stage move

The trigger is not the stage change. It is the **conjunction**, evaluated after
every PR refresh: if the card sits in the done-role stage and the refresh
recorded `state === "merged"`, settle the card.

That covers every D2 trigger for free — the Merge click, a card detail opened, a
stage move — so a card that sat in Done with an open PR someone merged on GitHub
reclaims the next time anyone looks at it. No timer, no sweep, no forge call
that was not already being made.

`supervisorReactor.ts:2256` currently special-cases the done-role stage change to
run `cleanupBranchOnDone`. That branch is replaced by a single
`settleCardAtDone(card)` called from the refresh path, which runs, in order:

1. **Reclaim the worktree** — gated on `reclaimWorktreeOnDone`, via the existing
   `reclaimBoardCardWorktree` and its clean-and-pushed check.
2. **Delete the branches** — the existing `cleanupBranchOnDone`, unchanged and
   still gated on the merge stage's `deleteBranchOnDone`.

The order is the point. `branchCleanup.ts:16` documents its own defeat — *"a card
at Done normally STILL HAS its worktree; the usual outcome is that the local
branch is left alone"* — because `parseWorktreeBranches` sees the branch checked
out and refuses. Reclaim first and that refusal never arises: worktree and local
branch both go, in one move.

Every arm stays best-effort and reports on the card's activity rail. A reclaim
blocked by a dirty tree leaves the worktree, records `reclaimBlockedReason`, and
the local delete is then correctly refused for the same underlying reason.
Nothing here may block or fail the card's move to Done.

### D2 — Archive always reclaims; one boolean governs Done

`handleArchived` reclaims unconditionally today, reading no setting at all. That
stays true: archive is the guaranteed cleanup point, and no worktree may outlive
its card.

So the setting only ever answers one question — *does the card also get reclaimed
earlier, at Done?* — which is a boolean, not a three-value enum. Under an
always-reclaiming archive, `keep` and `reclaim-on-archive` are the same
behaviour, and one of them has to go.

`BoardLifecycleSettings` becomes:

```ts
export const BoardLifecycleSettings = Schema.Struct({
  reclaimWorktreeOnDone: Schema.Boolean,   // default true
})
```

`BoardWorktreeRetention`, `DEFAULT_BOARD_ARCHIVE_AFTER_DAYS` and `archiveAfterDays`
are deleted outright, along with the settings-panel stepper whose description
promises *"Cards auto-archive after this many days in Done"* — a promise nothing
has ever kept.

This is the upgrade-safe reshape. Settings persist **sparsely**: a user who
touched either field has `{"board":{"lifecycle":{"worktreeRetention":"keep"}}}`
on disk. Renaming the field makes those stale keys *unknown*, and
`Schema.Struct` drops unknown keys silently, so the user lands on the new
default. Narrowing the existing `Schema.Literals` instead would have failed to
decode that exact file.

Default `true`: the disk problem is solved out of the box, and the opt-out is a
checkbox.

### D3 — A card has many pull requests, and knows which one is current

`pullRequest` keeps meaning precisely what it means today — **the current
round's PR** — so every existing consumer is untouched: both `json_extract`
shell producers (`projection.ts:697`, `:731`), `boardCardPullRequestsEqual`, the
merge path, `cleanupBranchOnDone`, the replay shim. Two fields are added beside
it:

- `pullRequestHistory: ReadonlyArray<BoardCardPullRequest>` — append-only,
  ordered by number ascending. Grows only at re-provision.
- `pullRequestFloor: number | null` — the highest PR number the card knew at the
  moment its current round began.

Migration **024_BoardCardsPullRequestHistory** adds `pull_request_history TEXT`
and `pull_request_floor INTEGER`, both nullable, both `withDecodingDefault` on
the schema — additive and guarded, the same shape as `011_BoardCardsWorktree`
and `022_BoardCardsPullRequest`. A from-empty replay of a pre-this-spec log must
match table rehydration for both new fields.

The floor is what makes rounds safe. `findLatestPrForHeadContext` queries
`state: "all"` and falls back to the latest PR overall when none is open, so a
re-cut `board/t3o-42` resolves straight back to the merged `#284`. Without a
floor the card would show a merged PR for work not yet done, the merge stage
would fall through to a plain **Move to Done**, and entering Done a second time
would hand branch cleanup a "merged" link for a live branch — **deleting the
remote branch of unmerged work.** That is the failure this field exists to
prevent, and it should be named as such in the code.

The rule is one comparison: the decider refuses `record-pull-request` for any PR
whose `number <= pullRequestFloor`. Between re-provision and the new PR opening,
`pullRequest` is null — so the merge stage shows a plain **Move to Done** and
`settleCardAtDone` deletes nothing, which is correct.

PR numbers are monotonic per repository on every forge in the registry,
including the cross-repo fork case, where the number comes from the upstream
repo.

### D4 — Re-provisioning a reclaimed worktree

`decider.ts:1393` rejects `provision-worktree` unless the worktree is `failed`:
*"only a failed worktree can be re-provisioned."* A reclaimed card dragged back
to Building therefore gets a rejected dispatch, `ensureWorktree` returns null,
and the card wedges with no explanation. That is already true for unarchived
cards today; reclaiming at Done makes it the common path.

Admit `reclaimed` alongside `failed`. Two transitions with different meanings
now share the command, and they must be distinguished:

| from | meaning | `attempts` | `pullRequestFloor` |
| --- | --- | --- | --- |
| `failed` | retry of the current round | `+1` | unchanged |
| `reclaimed` | a **new round** | reset to `1` | stamped |

On the `reclaimed → provisioning` transition only:

- `attempts` resets to 1, so the count keeps meaning "retries of *this*
  provision" rather than a lifetime tally.
- The current `pullRequest`, if any, is appended to `pullRequestHistory` and
  `pullRequest` is set to null.
- `pullRequestFloor` is set to the highest number across history.

A retry from `failed` must do none of that — it is the same round, and stamping
a floor mid-round would orphan the round's own PR.

Nothing else needs building. `beginStageRun` already returns early unless the
stage auto-executes or a human clicks (`:1040`), and provisioning is
`schedule()`'s job for any pending build-mode step — so recovery is lazy by
construction. Dragging a Done card to Backlog or Planning costs nothing
(planning is read-only in the project root, D6 of t3o-09); the worktree is
rebuilt only when a build-mode step actually starts, and t3o-09 already models
that as a step with its own state, retries and visible failure. The minutes of
`vp i` show up as a card that says what it is doing.

Which work re-runs is not this spec's problem: the stage the card is dropped
into decides it, and `beginStageRun`'s re-entry rule (`:1042`) already opens a
clean human-in-the-loop conversation rather than silently redoing the stage.

The branch keeps its deterministic name, `board/<key>`, and is cut fresh from
the **current** default branch — which now contains round one's merged work, so
round two starts from round one rather than duplicating it.

### D5 — A merged parent is no longer a base

`resolveBoardCardBaseRef` cuts a sub-board plan card's branch from the parent
card's `worktree.branch`. Once parents actually lose their local branch at Done,
that ref can be gone, and the child fails with the generic *"git worktree add
failed; retry the build."*

Add one rule to that pure function: if the parent's `pullRequest.state ===
"merged"`, return the default branch instead. Correct by the same argument that
makes the deletion safe — a merged parent's commits **are** in the default
branch. Gated on exactly the condition that caused the deletion, so a parent
that reached Done without a merged PR keeps its branch and keeps being the base,
unchanged. No git query, no new state; the function stays pure and stays decided
in the read model.

### D6 — The boot sweep costs nothing

`reconcile` gains a pass: every card in the done-role stage with a `ready`
worktree and a **cached** `pullRequest.state === "merged"` runs
`settleCardAtDone`. Merged is terminal state, so a cached value cannot be stale
and no refresh is needed — the sweep issues **zero forge calls**.

Cards whose cached PR is still `open` are deliberately left alone; D1's
conjunction picks them up on the next natural refresh. Refreshing them at boot
would be a burst of `gh pr list` proportional to the Done pile at every restart,
which is the periodic sweep the PR-merge spec explicitly refused.

Idempotent by construction: a reclaimed worktree is no longer `ready`, so a
second boot skips it.

### D7 — The button names its PR

`boardStagePrimaryAction`'s `merge` arm carries the PR number, so the primary
button reads `→ Merge PR #23`. With many PRs on a card, an unnumbered "Merge" is
genuinely ambiguous; numbering it removes the ambiguity at the only moment it
costs anything.

**View PR** and the column-card `#N` badge both resolve to
`current ?? most recent historical`. `BoardCardDetailView.tsx:641` keeps the link
visible in Done deliberately — *"a card in Done is exactly when you want to find"*
the PR — and round two nulling `pullRequest` would otherwise make round one's PR
unreachable from the card entirely.

The badge fallback is a `COALESCE(json_extract(pull_request, '$.number'),
json_extract(pull_request_history, '$[#-1].number'))` in **both** shell
producers, plus the matching JS derivation on the delta path. The
two-producers-must-agree test (`cardMetaShellFields.test.ts`) covers it and must
be extended, not worked around.

## Acceptance criteria

1. A card entering Done with a merged PR and `reclaimWorktreeOnDone` on has its
   worktree removed, its local branch deleted, and its remote branch deleted.
2. The local branch deletion succeeds — asserted, since it is the thing that
   fails today.
3. A card entering Done with a **dirty or unpushed** worktree keeps both
   worktree and local branch, and the card's activity rail says why.
4. A card entering Done with no PR, an unmerged PR, or a closed PR keeps its
   worktree and both branches.
5. With `reclaimWorktreeOnDone` off, nothing is reclaimed at Done; archive still
   reclaims, unconditionally, whatever the setting says.
6. A card sitting in Done whose PR is merged externally reclaims on the next
   ordinary refresh (card detail opened) — with no PR lookup issued on a timer.
7. On boot, a Done card with a ready worktree and a cached merged PR is settled,
   and the sweep makes zero forge calls.
8. A reclaimed card dragged back to Building and started provisions a fresh
   worktree on `board/<key>`, cut from the current default branch, with
   `attempts` back at 1.
9. That card's `pullRequest` is null and `#284` is in `pullRequestHistory`; a
   refresh that resolves `#284` again is refused by the floor and leaves
   `pullRequest` null.
10. When the round-two PR `#301` opens it becomes `pullRequest`; the merge button
    reads `Merge PR #301`.
11. A retry from a **failed** worktree increments `attempts` and does **not**
    stamp a floor or touch the PR history.
12. A child card whose parent reached Done with a merged PR cuts from the default
    branch; one whose parent has no merged PR still cuts from the parent's
    branch.
13. **View PR** and the column badge show the historical PR when there is no
    current one, and agree across snapshot and delta.
14. A settings.json carrying the old `worktreeRetention` or `archiveAfterDays`
    keys loads without error onto the new defaults.
15. A replay from an empty event log matches table rehydration for
    `pullRequestHistory` and `pullRequestFloor`.
16. Nothing in the settle path can fail a card's move to Done.

## Touch points

- `packages/contracts/src/board.ts` — `BoardLifecycleSettings` reshape,
  `BoardWorktreeRetention` + `archiveAfterDays` removal, `pullRequestHistory` /
  `pullRequestFloor` on `BoardCard`.
- `apps/server/src/board/migrations/024_BoardCardsPullRequestHistory.ts`.
- `apps/server/src/board/decider.ts` — `provision-worktree` guard (`:1393`),
  round-vs-retry transition, `record-pull-request` floor guard.
- `apps/server/src/board/supervisorReactor.ts` — `settleCardAtDone`, the refresh
  conjunction (replacing `:2256`), the reconcile sweep, `handleArchived` left
  unconditional.
- `apps/server/src/board/worktree.ts` — `resolveBoardCardBaseRef` merged-parent
  fallback.
- `apps/server/src/board/projection.ts` — both shell producers' `prNumber`
  COALESCE, history/floor columns.
- `apps/web/src/board/boardStageActions.ts`, `BoardCardDetailView.tsx` —
  numbered merge button, View PR fallback.
- `apps/web/src/components/settings/BoardSettingsPanel.tsx` — drop the archive
  stepper and the retention dropdown, add the checkbox.
- `apps/server/src/board/supervisorHarness.testkit.ts:257`, `branchCleanup.test.ts`,
  `cardMetaShellFields.test.ts`, `serverSettings.test.ts`,
  `board.settings.test.ts`.
