# Running the board across several machines

One server hosts the board. Other T3o servers you own can be added to it as **workers**: machines
the board connects to and can run cards on. The server hosting the board is always a worker itself,
listed as **This server (local)**, so a board with no workers added works exactly as it always has.

Workers are managed under **Settings → Board → Workers**. Every device connected to the board
server sees the same list, with each worker's live status.

## Viewing the board from another device

Every device shows the board of one server. By default that is the server the app runs (the
desktop app's own local server, or the server a browser loaded the page from). To see the central
board from another device, pair with the board server in **Settings → Connections**, then pick it in
**Settings → Board → Board server**. The choice is saved on that device only. If the chosen server
is not connected, the board says so and offers to reconnect or switch back to this device's server.

## Before you add one

- The worker must run T3o, at or above the version the board needs. A worker on an older version
  shows **Incompatible version** and says which version it needs. Upstream T3 Code servers can't be
  workers.
- **The board server** must be able to reach the worker over the network, for example on the same
  LAN or over Tailscale. It's not enough for your laptop to reach it. Workers never connect to the
  board server; the board server connects to them.

## Adding a worker

Press **Add worker**. The dialog lists the environments this device is already connected to in
**Settings → Connections**. Pick one and press **Use as worker**. This device creates a one-time
pairing token on that machine, and the board server uses it to get its own access there.

If an environment says **Needs a pairing link**, your connection to it doesn't have admin access, so
this device can't create a token there. In that case, and for a server this device isn't connected
to at all, run `t3 pair` on the worker machine and paste the link it prints. Links work once and
expire after 5 minutes.

On the worker, the board then appears under **Settings → Connections → Clients** as
**T3o board (_board server name_)**.

## Default worker

Unpinned cards run on the default worker, which starts out as this server. Change it with
**Default worker**, or **Make default** in a worker's menu. Only an online worker can be the default.
Changing it only affects cards that don't have a worktree yet.

## Choosing where a card runs

Once a board has a worker, cards show a small worker chip and get a **Worker** field, in the new card
dialog and in the card's details. A card either follows the default worker or is pinned to one.
Planning and every later step run on the same worker, in that worker's checkout of the project.

Each worker in the picker says how busy it is, or why it can't be picked: no checkout of the project
(with **Set up on worker**), offline, access revoked, or too old a T3o. A card pinned to a worker
that's still cloning the project waits as **Queued · setting up** and starts once the clone
finishes. Sub-board cards start out pinned where their parent is.

If a step's provider isn't on the card's worker, the step doesn't start and the card says
**Provider missing**. Pin the card to a worker that has it, or pick a model the worker offers in the
card's **Models**, and the step starts again.

## Moving a card to another worker

Before a card has a worktree, picking another worker simply re-pins it. Once it has one, the card is
tied to that worker, and picking another worker opens **Move**. A move needs everything on the
card's branch pushed: the old worktree is retired and a new one is created on the other worker from
the branch on the remote. Nothing is copied between machines. Earlier threads stay on the worker
they ran on and stay linked from the card.

A move is refused while a step is running, and when the worktree has commits or files the remote
doesn't have. The dialog lists them, and **Ask agent to push** asks the card's agent to push its
work. If creating the new worktree fails, the card shows **Move failed**; its branch is safe on the
remote, so **Retry** it or pick another worker.

## Concurrency across workers

With workers, **Settings → Board → Concurrency** has a board limit, and each worker has its own limit
and a cap for each of its provider instances. A card starts only when all three have room. A
queued card says which limit it's waiting on: **worker full**, **provider full** or **board full**.
**Start now** runs a queued card past all of them. Your old limit and provider caps carry over as
the board limit and this server's limits.

## When a worker needs attention

While any worker is offline, revoked or incompatible, the board's header shows how many, and its
popover lists the cards each one has paused, with **Open Workers settings**.

- **Offline** — the board server can't reach it. It keeps trying, and the worker comes back by
  itself when it's reachable again. Its cards show **Worker offline**: their work is paused, not
  restarted or moved, and nothing new starts there. An agent that's still running on that machine
  isn't treated as dead, and the time the worker is offline doesn't count toward a step's timeout.
  When the worker is back, the board catches up on what happened there first, then carries on.
  A card that can't wait can be **Force-move**d to another worker (see below).
- **Access revoked** — someone removed the board under Settings → Connections → Clients on that
  machine, or the worker was reset. The board renews its own access while it runs, but if the board
  server was off for most of a month its access has expired, and that shows here too. Use **Re-pair…** to give the board access again. The worker
  keeps its label and settings.
- **Incompatible version** — update T3o on the worker.

## Threads on a worker

A card's thread runs on the worker the card was placed on, and that's where it opens. On a board
with workers, each thread row says which worker it ran on. The board itself works without a
connection to the worker, but to read or reply in one of its threads this device needs a connection
to that worker too. If it has none, the thread pane says so and **Open Settings → Connections**
opens the Add environment dialog with the worker's address filled in.

Agents on a worker keep reaching the board through their own server, which passes their board calls
on to the board server. While the board server isn't connected to that worker, an agent's board
calls fail with a message telling it to retry shortly.

## Removing a worker

**Remove worker…** in a worker's menu takes it off the board and gives the board's access back on
that machine, if it can be reached. Nothing on the worker is deleted: its worktrees, branches and
thread history stay there. The default worker can't be removed; make another one the default first.

The confirmation lists the cards on that worker:

- Cards with no worktree yet move to the default worker.
- Cards with a worktree, or a step running there, show **Worker removed — move this card** until you
  move them. A running step is stopped first, if the worker can be reached.

Adding the same server back as a worker puts those cards back on it, and a stopped step carries on.

## Force-moving a card off an unreachable worker

A card whose worker is offline or removed can't be checked for unpushed work, so the usual move
isn't possible. **Force-move…** (or **Move…** on a removed worker's card) moves it anyway: pick the
worker to move to, and the card continues from its branch on the remote, shown with its last pushed
commit. Anything that wasn't pushed is left behind on the old machine, so tick **Abandon unpushed
work** to confirm. If the branch was never pushed, there's nothing to continue from, and a second
confirmation offers to restart the card's Build from its base branch instead. Its brief, plan and
threads are kept.

## Project checkouts

Once a board has a worker, **Settings → Board → Project checkouts** shows which board projects each
worker has a copy of. A worker can only run cards for projects it has checked out. It matches them
by the repository's git remote.

For a project a worker doesn't have, press **Set up on worker**. The worker clones the project's
remote into its projects folder, using that machine's git credentials, and you can change the
folder before cloning. The clone runs on the worker, so you can leave the page while it runs. If a
clone fails, the cell says why. **Details** shows git's own output, which you can copy, and you can
**Retry** from there.
