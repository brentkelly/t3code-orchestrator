# When a card gives its worktree back

Each card gets its own worktree when it starts building: a full checkout, plus whatever your setup
script installs or builds into it. Once the card is finished, the board gets that disk space back.

## What happens at Done

**Settings → Board → At Done, a card's worktree is…** has three options. The same setting applies
when a card is archived or its work is cancelled. (Archiving used to remove the worktree whatever
the setting said; it now follows it.)

- **Removed** (the default). The worktree is removed as the card arrives, whether or not its work
  is committed or pushed. The card's branch stays, so committed work is never lost. Uncommitted
  and untracked changes are saved first (see [Getting uncommitted work back](#getting-uncommitted-work-back)).
- **Removed if everything is committed and pushed.** The worktree is removed only when nothing in
  it would be lost (see [What it will not remove](#what-it-will-not-remove)); otherwise it is kept
  and the card says why.
- **Kept.** Finished cards keep their worktrees.

A worktree that stays, for either reason, has the files git ignores deleted (see
[Kept worktrees are slimmed down](#kept-worktrees-are-slimmed-down)).

Cancelled work is never removed with changes in it, even under **Removed**: its branch is deleted
once the worktree goes, so commits that exist nowhere else keep the worktree.

The board also checks again when the server starts and whenever a worktree is created or removed,
so a worktree that was kept earlier is collected once whatever held it back is gone. Leftover
`board/*` worktrees that no card owns any more are removed the same way, but only ones inside this
server's own worktrees folder: another T3 Code install on the same repository keeps its worktrees.

The card's branch is not deleted with the worktree. Branches are only deleted at Done, after a merged
pull request, if the merge stage is set to delete them. A card moved back out of Done starts again
from its branch, in a fresh worktree.

## Getting uncommitted work back

Under **Removed**, a worktree with uncommitted or untracked changes is saved as a commit before it
goes. The card's activity names the ref, the folder and the machine, for example
`refs/t3o/discarded/T3O-42-20261118T101500`. The ref is kept for 30 days, and only in the project's
checkout on the machine that held the worktree (for a card on a worker, that worker). To restore
it, run this in that checkout:

```sh
git checkout -b recovered-work refs/t3o/discarded/T3O-42-20261118T101500
```

Moving the card back out of Done does not restore it for you.

The worktree is not force-removed, and is kept as under the second option instead, when its
changes can't be saved: more than 200 MB of changed and untracked files, git failing, or a worker
running an older T3o. The card's **Worktree kept** reason says which.

## Kept worktrees are slimmed down

A worktree that stays has everything git ignores deleted: build output, `node_modules/`, caches.
Files whose name starts with `.env`, and the `.claude/`, `.vscode/` and `.idea/` folders, are kept.
Tracked files are never touched. The card's activity says how much was freed, and the board counts
the worktree at its new size when it decides where cards can run.

This happens once, when the card reaches Done, is archived or has its work cancelled, and when you
use **Check again**. The board first stops the card's own terminals and agent sessions. If anything
else is still running in the worktree, such as a dev server you started, it leaves the files alone,
says so, and tries again on later checks until it can. Worktrees kept before this existed are not
touched until one of those events happens to them. Setup runs again if the card later reuses the
worktree.

## What it will not remove

Under **Removed if everything is committed and pushed**, a worktree is only removed when nothing in
it would be lost:

- it has no uncommitted changes, and
- its commits are already somewhere else: in the base branch on your remote, in a merged pull
  request, or on any branch you pushed.

A worktree that fails either test is kept, and the card shows an amber **Worktree kept** badge with
the reason, for example `2 uncommitted changes (.vscode/settings.json, .env.local)` or
`3 commits not in the base branch or a merged pull request`. Build output your project ignores
(`target/`, `node_modules/`, `dist/`) does not count as uncommitted, so it never holds a worktree
back. Under **Kept** there is no badge: keeping it is what you asked for.

If you delete a finished card's worktree folder yourself, the board notices on its next check and
tidies git's record of it. The branch and its commits stay.

Automatic worktree cleanup (**Settings → Worktrees → Cleanup**) leaves card worktrees alone, whatever their
inactivity or merge state. The board removes a card's worktree itself, as described here; once it
has, those rules apply to that folder again.

## Clearing a kept worktree

Open the card. Its banner names the reason and the worktree's folder, and offers two actions:

- **Check again** looks up the pull request and retries the cleanup. Use it after you have committed
  or discarded the stray changes, or merged the pull request. If the worktree is still kept, it
  tells you why.
- **Remove worktree** removes it anyway, after asking you to confirm. Uncommitted changes in it are
  lost. Committed work is not: the branch stays, so you can check it out again any time.

## Before a worktree is removed

Before T3 Code removes a worktree, it closes the terminals and stops the agent sessions working in
it. Under **Removed if everything is committed and pushed**, a finished card whose worktree still
has something running in it, such as a dev server or a build, is kept with a reason like
`cargo is still running in the worktree`. **Check again** retries once it has stopped. **Removed**,
**Remove worktree** and deleting a card stop those processes for you.

A project can also run its own script just before the removal, for example to move build caches
somewhere the next worktree can pick them up. Mark a project action **Run before the worktree is
removed**, or set `"runOnWorktreeRemove": true` on a script in `t3.json`:

```json
{
  "scripts": [
    { "name": "Park caches", "command": "./scripts/park-caches.sh", "runOnWorktreeRemove": true }
  ]
}
```

- The script runs in the worktree being removed, with `T3_WORKTREE_PATH`, `T3_PROJECT_ROOT`,
  `T3_REMOVAL` (`reclaim`, or `forced` for the **Removed** setting, **Remove worktree**, a card
  delete or a thread delete)
  and `T3_WORKTREE_VERIFIED_CLEAN` (`1` only when the worktree was just checked clean and its work
  saved elsewhere).
- On a card's worktree, the project's run-on-settle action runs first, once, since card threads
  skip it when they settle.
- Several scripts may be marked; they run in order. The removal waits for them, up to 5 minutes
  each. Deleting a thread or a card does not wait: the worktree goes once the scripts finish.
- A script that fails or times out does not stop the removal. The card's activity notes the failure.
- T3 Code cannot see processes running inside containers. If the worktree starts containers, stop
  them in this script, or they keep writing into the deleted folder.
- A `t3.json` script only takes effect once it is imported into the project, from the actions menu
  or **Settings → Project actions**. Later edits to `t3.json` are not picked up automatically.

## Keeping a worker's disk clean

T3o cleans up what it makes itself:

- finished cards' worktrees, as above, and the local branches of deleted cards;
- snapshot refs older than 30 days;
- temporary files from its own status writes, and browser profiles a stopped preview left in the
  temp folder (hourly, on servers that are not dev servers).

It does not clean up after your projects' own tools: Docker build caches, compiler caches, or test
leftovers in the temp folder. A project may ship a cleanup script for that, for example
`.t3/cleanup.sh`. T3o never runs it. Read it, then install it yourself on each machine, for
example with cron:

```sh
crontab -e
# then add a line such as:
0 * * * * /path/to/checkout/.t3/cleanup.sh >> ~/.cache/project-cleanup.log 2>&1
```
