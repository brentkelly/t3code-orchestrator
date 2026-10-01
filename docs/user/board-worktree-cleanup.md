# When a card gives its worktree back

Each card gets its own worktree when it starts building: a full checkout, plus whatever your setup
script installs or builds into it. Once the card is finished, the board removes that worktree to get
the disk space back.

## When it happens

- **A card reaches Done.** Its worktree is removed as it arrives, whether or not it ever had a pull
  request. Turn this off with **Settings → Board → Reclaim worktrees at "Done"** if you want finished
  cards to keep their checkouts.
- **A card is archived.** Always, whatever that setting says.
- **The server starts, and whenever a worktree is created or removed.** The board checks every
  finished card that still has one, so a worktree that was kept earlier is collected once whatever
  held it back is gone. Leftover `board/*` worktrees that no card owns any more are removed the
  same way, but only ones inside this server's own worktrees folder: another T3 Code install on
  the same repository keeps its worktrees.

The card's branch is not deleted with the worktree. Branches are only deleted at Done, after a merged
pull request, if the merge stage is set to delete them.

## What it will not remove

A worktree is only removed when nothing in it would be lost:

- it has no uncommitted changes, and
- its commits are already somewhere else: in the base branch on your remote, in a merged pull
  request, or on any branch you pushed.

A worktree that fails either test is kept, and the card shows an amber **Worktree kept** badge with
the reason, for example `2 uncommitted changes (.vscode/settings.json, .env.local)` or
`3 commits not in the base branch or a merged pull request`. Build output your project ignores
(`target/`, `node_modules/`, `dist/`) does not count as uncommitted, so it never holds a worktree
back.

## Clearing a kept worktree

Open the card. Its banner names the reason and the worktree's folder, and offers two actions:

- **Check again** looks up the pull request and retries the cleanup. Use it after you have committed
  or discarded the stray changes, or merged the pull request.
- **Remove worktree** removes it anyway, after asking you to confirm. Uncommitted changes in it are
  lost. Committed work is not: the branch stays, so you can check it out again any time.
