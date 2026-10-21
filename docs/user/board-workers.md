# Running the board across several machines

One server hosts the board. Other T3o servers you own can be added to it as **workers**: machines
the board connects to and can run cards on. The server hosting the board is always a worker itself,
listed as **This server (local)**, so a board with no workers added works exactly as it always has.

Workers are managed under **Settings → Board → Workers**. Every device connected to the board
server sees the same list, with each worker's live status.

> Choosing which worker a card runs on is still being built. For now, adding workers sets up the
> connections, the default worker and the project checkouts that card placement will use.

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

## When a worker needs attention

- **Offline** — the board server can't reach it. It keeps trying, and the worker comes back by
  itself when it's reachable again.
- **Access revoked** — someone removed the board under Settings → Connections → Clients on that
  machine, or the worker was reset. The board renews its own access while it runs, but if the board
  server was off for most of a month its access has expired, and that shows here too. Use **Re-pair…** to give the board access again. The worker
  keeps its label and settings.
- **Incompatible version** — update T3o on the worker.

## Removing a worker

**Remove worker…** in a worker's menu takes it off the board and gives the board's access back on
that machine, if it can be reached. Nothing on the worker is deleted. The default worker can't be
removed; make another one the default first.

## Project checkouts

Once a board has a worker, **Settings → Board → Project checkouts** shows which board projects each
worker has a copy of. A worker can only run cards for projects it has checked out. It matches them
by the repository's git remote.

For a project a worker doesn't have, press **Set up on worker**. The worker clones the project's
remote into its projects folder, using that machine's git credentials, and you can change the
folder before cloning. The clone runs on the worker, so you can leave the page while it runs. If a
clone fails, the cell says why. **Details** shows git's own output, which you can copy, and you can
**Retry** from there.
