# Card ↔ pull request: links, merge, and branch cleanup

## Goal

A card that has a pull request says so, everywhere it matters: a `#284` badge on
the card in its column, a **View PR** link in the card detail, and — once the
card reaches a new `merge`-role stage with the PR still open — a primary
**Merge** button that merges the PR on the forge and advances the card to Done.
When a card lands in Done with a merged PR, its branch is cleaned up.

This is the follow-up `t3o-20` explicitly deferred: *"The server-side card→PR
link (D6) and settings-time GitHub gating are DEFERRED to a follow-up."*

## Why nothing shows today

`BoardCardShell.prNumber` exists (`contracts/src/board.ts:2461`) and the badge
that renders it exists (`BoardCardSummaryRow.tsx:256`), but **no producer ever
sets it**: `makeBoardCardShell` hardcodes `hasPr: false` and omits `prNumber`
with the comment *"post-MVP review pipeline: key-optional and deliberately
absent until their producing specs land"* (`board.ts:2656`). There is no PR
column in any of the 21 board migrations. The review agent is *told* to open a
PR (`board.ts:3577`) but reports nothing back. This spec is the producer.

## Scope

### In

1. A `pullRequest` slice on the card aggregate, with a migration and a
   command/event, refreshed on defined events.
2. `prNumber` populated on the card shell (snapshot + delta), lighting the
   existing badge.
3. A new `merge` stage role, seeded onto "Ready for merge", carrying the merge
   settings.
4. Card detail: **View PR #N** button always when a PR exists; primary
   **Merge** button in the merge-role stage when the PR is open.
5. Server-side PR merge (GitHub only), then advance to Done.
6. Conflict handling via a card step that merges base in and pushes, then
   completes the merge.
7. `deleteBranchOnDone`: remote branch deleted on entry to Done when the PR is
   merged; local branch too when no worktree holds it.

### Out

- Any **automatic** merge. Merging is always a deliberate human click. The
  merge-role stage does not auto-execute.
- Any **periodic** PR polling. Refresh is event-driven only (D2).
- Merge on GitLab / Bitbucket / Azure DevOps. PR *lookup* is provider-agnostic
  and works on all of them; `mergeChangeRequest` is GitHub-only in v1, matching
  t3o-20's GitHub-mandatory precedent. Other providers return the registry's
  standard unsupported-operation error.
- GitHub's native auto-merge (`gh pr merge --auto`).
- Rebase / force-push as a conflict strategy (D9).
- A clickable badge on the column card (D8).

## Key decisions

### D1 — The card learns its PR by branch lookup, and stores it on the aggregate

The server resolves the card's PR by asking the forge for a PR whose head is the
card's `worktree.branch`. **Reuse `GitManager`'s existing resolver** — do not
write a second one:

- `findLatestPrForHeadContext` (`GitManager.ts:1291`) already queries
  `state: "all"`, prefers the latest open PR and falls back to the latest
  overall, and probes every head selector for cross-repo forks.
- It sits behind `prLookupCache`: 2-minute success TTL (`:112`), per-branch
  exponential failure backoff 20s→15min cleared on success (`:127`), and
  `rememberLastKnownPr`, so a rate-limit blip goes stale rather than blank.
- It surfaces as `VcsStatusChangeRequest` (`contracts/git.ts:227`) carrying
  `{number, title, url, baseRef, headRef, state}` — including `"merged"`.

Expose a narrow `GitManager` entry point for "PR for this branch" rather than
routing through full `status`, so a refresh does not run `git status` over a
worktree just to read a cached PR.

The result is stored **on the card aggregate**, mirroring the `worktree`
precedent exactly (`board.ts:644`):

- `BoardCard.pullRequest: Schema.NullOr(BoardCardPullRequest)` with
  `withDecodingDefault(null)` so a from-empty replay of a pre-this-spec log
  matches table rehydration.
- `BoardCardPullRequest = { number, url, state: "open"|"closed"|"merged",
  headBranch, baseRef, updatedAt }`.
- Migration **022_BoardCardsPullRequest** — additive and guarded, adding a
  `pull_request TEXT` column defaulting NULL, exactly like
  `011_BoardCardsWorktree`.
- New command/event `board.card.record-pull-request`, dispatched by the reactor
  only when the resolved value differs from what the card holds — no event
  storm from repeated identical lookups. Each transition lands in the card's
  activity rail.

Rationale for the aggregate over a read-model slice: the decider needs PR state
to gate branch deletion, and the activity rail gets "PR #284 opened" /
"PR #284 merged" as history for free.

### D2 — Refresh is event-driven; there is no sweep

Explicitly **no** periodic poll. Cost is driven by branch fan-out, not cadence:
each lookup is one `gh pr list` per head selector (one, for a normal same-repo
branch), and at 30 lookups/hour/branch a large board would eat a real fraction
of the 5,000/hour budget for no benefit.

Refresh triggers, all of which are moments where the answer can have changed or
is about to be read:

| Trigger | Why |
| --- | --- |
| Each review-loop step boundary | Natural heartbeat while the PR must be open anyway; catches an early external merge/close mid-review |
| Card moved between stages | Includes the entry to Done that gates branch deletion |
| Card detail opened | The Merge button is fresh at the moment it becomes visible |
| **View PR** clicked | Cheap, cache-guarded |
| After a merge attempt | Records the new state either way |

A `board.card.refreshPullRequest` RPC serves the client-initiated triggers. The
2-minute cache means a burst of these costs one forge call.

Cards with no worktree, or an unpushed branch, are never looked up.

### D3 — A new `merge` stage role

`BoardStageRole` gains `"merge"` (`board.ts:289`), seeded onto the existing
"Ready for merge" stage, which is role-less today (`board.ts:351`). Touch points,
all of which have a `plan`-role precedent from the board settings redesign:

- `BOARD_SEED_STAGES` — set `role: "merge"` on the merge seed.
- `boardSeedStageRole` (`board.ts:396`) — add the `merge` case.
- The untouched-seed tolerance check (`board.ts:386`) — accept a persisted merge
  stage with a null role as untouched, the same allowance Planning has.
- Migration **023_BoardStageMergeRole**, a one-liner mirroring
  `019_BoardStagePlanRole`:
  `UPDATE board_stages SET role = 'merge' WHERE stage_id = 'merge' AND role IS NULL`.
- The decider's role-uniqueness guard admits the new role like any other.

Merge settings live on that stage as a `BoardStageExecution` member
`kind: "merge"`, joining `"simple"` and `"review"`:

- `strategy: "squash" | "merge" | "rebase"`, default **`"squash"`** — a card's
  branch is one unit of work, and `gh pr merge` with no flag prompts
  interactively, which is unusable headless.
- `conflictPrompt` (editable, with a compiled-in
  `DEFAULT_BOARD_MERGE_CONFLICT_PROMPT`) and `model`, following how every other
  stage prompt is configured.
- `deleteBranchOnDone: boolean`, default **`true`**.
- `autoExecute` is **not** offered — nothing in this stage runs on entry.

Note the tradeoff accepted here: deleting the merge-role stage takes its config
with it, so `deleteBranchOnDone` stops applying. That is consistent with how
every other role-held config behaves.

### D4 — The Merge button

Shown **only** when the card is in the merge-role stage. Rendered by
`boardStagePrimaryAction` (`boardStageActions.ts`), which already special-cases
a role to change the primary button's label and emphasis — `"Begin build"` for
the build role (`:68-70`). Add the merge case, so the button is the *existing*
`<ArrowRightIcon /> {label}` emphasised control (`BoardCardDetailView.tsx:568`)
with the label `Merge`. This is exactly the blue `→ Merge` in the prototype
screenshot.

State table for the primary button in the merge-role stage:

| PR state | Button |
| --- | --- |
| `open` | **Merge** — blue, enabled |
| `open`, conflict step running | **Merge** — disabled, tooltip "Resolving conflicts…" |
| `merged` / `closed` / no PR | Falls back to the ordinary **Move to Done** (plain, not blue) |

The fallback matters: a card is never stranded, cards that never had a PR behave
exactly as they do today, and merging on GitHub yourself still leaves a path
forward. Existing gates still apply — `card.blocked` disables it as now.

**View PR #N** sits directly below the primary button whenever the card has a
PR, at any stage, opening the URL via the existing
`openPullRequestLink(api.shell, url)` helper. Clicking it also refreshes (D2).

### D5 — Merging

Add `mergeChangeRequest` to the `SourceControlProvider` interface, implemented
on `GitHubCli` (`gh pr merge --<strategy>`); every other provider gets the
registry's existing unsupported-operation error. Runs with `cwd` = the card's
worktree path, falling back to the project workspace root if the worktree has
been reclaimed.

On success: record the merged PR, then move the card to the next stage (Done).
On failure: the card does **not** advance, and the branch below applies.

### D6 — Merge refused: checks, approvals, conflicts

Two distinct paths, because they need different responses:

**Failing checks / required approvals / any other refusal.** Surface the forge's
own reason — a toast plus an entry in the card's activity rail — and leave the
button enabled to retry. No second-guessing GitHub's rules, and no automatic
retry: the block needs a human, so the next attempt should be a human's.

**Conflicts.** Spawn a conflict-resolution **card step** and disable the Merge
button with a "Resolving conflicts…" note while it runs. Modelled as a step, not
a bare thread, because the step machine is what gives it a concurrency slot, a
timeout, stall detection, attempt limits, an activity-rail entry — and, decisive
here, `board_complete_step` is the *only* channel an agent has to report "I've
achieved that". A bare thread ending cannot distinguish "fixed it" from "gave
up".

- On a **success** outcome, the reactor retries the merge and, on success,
  advances to Done — finishing the job the human's click asked for. This is not
  auto-merge: no merge happens that a human did not initiate.
- On **failure, timeout or exhausted attempts**, the button re-enables and the
  reason is surfaced.

### D7 — Conflict resolution never rewrites history

The step merges the base branch into the card's branch, resolves, commits, and
does an ordinary push. **Never rebase, never force-push.** A force-push on a
branch with an open PR strands the review loop's inline comments, invalidates
the round's `reviewedSha`, and can silently destroy a concurrent human push. The
extra merge commit is invisible under the default squash strategy anyway. The
compiled-in prompt states this as a constraint rather than leaving it to the
agent's judgement.

### D8 — The badge is a read-only indicator

The shell carries `prNumber` only — no `prUrl`. The badge in the card's meta row
(`boardCardMeta`, `boardCardSummary.ts:163`; rendered at
`BoardCardSummaryRow.tsx:256`) stays non-interactive; the link lives in the
detail pane, which subscribes to the full card and has the URL. Keeps the
byte-conscious shell contract intact and avoids a click target inside a
draggable card.

`prNumber` must be produced by **both** shell producers, and they must agree —
the SQL expression on the shell-snapshot query and the JS derivation on the
delta path — following the `briefHasImage` / `planCount` precedent and its
two-producers-must-agree test (`cardMetaShellFields.test.ts`). It follows the
same absent-means-preserve rule: only the snapshot and the PR-carrying delta
assert it.

`hasPr` stops being hardcoded `false` and becomes `pullRequest !== null`.

### D9 — Branch cleanup on Done

On a card entering the Done-role stage with `pullRequest.state === "merged"` and
`deleteBranchOnDone` on:

- **Remote branch: deleted.** Same thing GitHub's own delete-on-merge does.
- **Local branch: deleted only when no worktree still has it checked out.**
  `worktreeRetention` defaults to `"reclaim-on-archive"`, so in practice the
  worktree usually still holds the branch at Done and the local branch is left
  for worktree reclaim at archive to clean up.

Safe by construction: a merged PR means the commits already live in the base
branch. Nothing is deleted for an unmerged or closed PR. Both outcomes land in
the activity rail; a failed deletion is logged and surfaced, never fatal to the
stage move.

## Acceptance criteria

1. A card whose branch has a PR shows `#N` in its column-card meta row.
2. Opening that card's detail shows **View PR #N**; clicking it opens the PR and
   refreshes the PR state.
3. `prNumber` is identical after a reconnect (snapshot) and after a live edit
   (delta) — asserted through the real seams, as `cardMetaShellFields.test.ts`
   does.
4. No PR lookup is ever issued on a timer. Lookups occur only on the D2
   triggers, and never for a card with no worktree or an unpushed branch.
5. "Ready for merge" resolves to role `merge` on a fresh board *and* on a board
   whose `board_stages` row predates this spec.
6. In the merge stage with an open PR, the primary button is a blue **Merge**.
   With a merged, closed or absent PR it is a plain **Move to Done**.
7. Clicking **Merge** merges via the configured strategy (default squash) and
   moves the card to Done.
8. A merge refused for failing checks surfaces the forge's reason, leaves the
   card in place, and leaves the button enabled. No automatic retry.
9. A merge refused for conflicts starts a conflict-resolution step and disables
   the button with a "Resolving conflicts…" note; a successful step completes
   the merge and advances to Done; a failed one re-enables the button with the
   reason.
10. The conflict step never force-pushes and never rebases.
11. A card entering Done with a merged PR and the setting on has its remote
    branch deleted; the local branch is deleted only when unheld by a worktree.
12. Nothing is deleted when the PR is unmerged, when there is no PR, or when the
    setting is off.
13. On a non-GitHub remote, the badge and View PR still work; **Merge** reports
    that merging is unsupported for that provider rather than failing obscurely.
14. A replay from an empty event log matches table rehydration for both new
    nullable fields.
