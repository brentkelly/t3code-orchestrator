# Running the board across several machines

One server hosts the board. Other T3o servers you own can join it as **workers**: machines that
connect out to the board and run its cards. The server hosting the board is always a worker itself,
listed as **This server (local)**, so a board with no workers added works exactly as it always has.

Workers are managed under **Settings → Board → Workers**. Every device connected to the board
server sees the same list, with each worker's live status.

## Viewing the board from another device

Every device shows the board of one server. By default that is the server the app runs (the
desktop app's own local server, or the server a browser loaded the page from). To see the central
board from another device, pair with the board server in **Settings → Environments**, then pick it in
**Settings → Board → Board server**. The choice is saved on that device only. If the chosen server
is not connected, the board says so and offers to reconnect or switch back to this device's server.

## Workers

### What a worker needs

- A T3o release checkout on **Linux** (other platforms are below), its projects, and its providers
  signed in (Claude Code and so on).
- **Outbound HTTPS to the board's address.** That's all: no open port, no reverse proxy, no SSH.
  The worker connects out to the board, and the board reaches the worker back through that
  connection.
- The board's address must reach the board server directly: your own domain behind Caddy or nginx,
  the LAN, or Tailscale. Fronts that only pass WebSockets (Cloudflare's proxy) and corporate HTTP
  proxies don't work yet, nor does T3 Connect. Plain `http://` is refused unless it's loopback or a
  Tailscale address; pass `--insecure` to override.
- Run one board server process per address.

Set the address workers should use under **Settings → Board → Board address**. Until you do, the
join command uses the address your browser has open, which may not be reachable from the worker.

### Adding a worker

Press **Add worker** under **Settings → Board → Workers**. The dialog shows a one-time code (it works
once, for 10 minutes) and the command to run on the worker, in its T3o checkout:

```sh
pnpm t3o-worker join https://board.example --code ABCD-EFGH
```

On Linux, the first join installs the T3o background service (listening on `127.0.0.1` only). On
macOS, start a T3o server with the same home first and keep it running; Windows workers aren't
supported yet. The dialog ticks off each step as the worker checks in, then lets you name it and
pick its 1–3 character abbreviation. If it stalls, run `pnpm t3o-worker status` on the worker: it
shows the last error (DNS, TLS, a refused upgrade, a revoked credential).

A code that expires, or one already used, needs a new one. If the worker's T3o is too old or too
new for the board, the dialog says **Needs update**; update the older side, and the same code still
works.

**Everyone who uses the board can see every thread on its workers.** A worker that serves two boards
lets users of both see all of its threads; `join` warns when you add a second board.

### The worker's commands

Run these in the worker's T3o checkout:

- `pnpm t3o-worker status` — the service, and each board's connection and last error.
- `pnpm t3o-worker boards` — the boards this worker serves.
- `pnpm t3o-worker leave [board]` (or `boards remove [board]`) — stop working for a board. It takes
  back everything the board held on this machine, even while the board is unreachable.
- `pnpm t3o-worker config` — the worker's own settings in `worker.json`; `config --help` lists them.

If the worker's managed policy forbids remote clients, it can't join a board.

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

While any worker is offline or needs an update, the board's header shows how many, and its
popover lists the cards each one has paused, with **Open Workers settings**.

- **Offline** — the board server can't reach it. It keeps trying, and the worker comes back by
  itself when it's reachable again. Its cards show **Worker offline**: their work is paused, not
  restarted or moved, and nothing new starts there. An agent that's still running on that machine
  isn't treated as dead, and the time the worker is offline doesn't count toward a step's timeout.
  When the worker is back, the board catches up on what happened there first, then carries on.
  A card that can't wait can be **Force-move**d to another worker (see below).
- **Reconnecting** — the worker is connected but the board's access there has to be renewed; it
  happens by itself on the worker's next connection.
- **Needs update** — the worker is connected but too old for this board, so it takes no new cards;
  its threads stay readable. Run `pnpm t3o-update` on the worker.

## Threads on a worker

A card's thread runs on the worker the card was placed on, and opens in place through the board:
nothing to add on your device. The thread's header says which worker it's running on. While that
worker is offline, the transcript up to that point stays readable and you can reply again once it
reconnects. A device connected to the board through a relay or SSH can't open worker threads yet;
connect to the board's address directly.

Agents on a worker keep reaching the board through their own server, which passes their board calls
on to the board server. While the board server isn't connected to that worker, an agent's board
calls fail with a message telling it to retry shortly.

## Removing a worker

**Remove worker…** in a worker's menu takes it off the board, gives back everything the board held
on that machine (its own access and every user's), and stops the worker's credential working. An
offline worker can be removed too; work it never pushed may be lost. Nothing on the worker is deleted: its worktrees, branches and
thread history stay there. The default worker can't be removed; make another one the default first.

The confirmation lists the cards on that worker:

- Cards with no worktree yet move to the default worker.
- Cards with a worktree, or a step running there, show **Worker removed: move this card** until you
  move them. A running step is stopped first, if the worker can be reached.

Joining the same server again, with a new code, puts those cards back on it, and a stopped step
carries on.

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
