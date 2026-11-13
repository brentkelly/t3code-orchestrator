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

A worker added by its address in an earlier release stays on the board but stops connecting once the
board is updated: join it again with a new code. It keeps its name, abbreviation and placements.

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

## Planning runs on the board server

Every new planning step runs on the board server, whatever the card's pin, in the project's own
folder there, after fetching it. So the board server needs, for each project with cards:

- **A checkout of the project.** If the project's folder on the board server isn't a checkout, cards
  wait amber with "isn't a checkout". When the folder is missing or empty, **Clone here** (on the
  Workers page) clones the project from its remote with the board server's own git credentials. A
  folder that exists and isn't a checkout has to be fixed by hand.
- **The step's provider signed in there.** If it isn't, cards wait violet with "Sign in on the board
  server": run `claude auth login` (or your provider's sign-in) on the board server.

The board server's readiness script only matters for builds, so a board server that fails it still
plans. Planning that was already running on a worker when you upgraded carries on there.

## How a worker is chosen

A card is placed on a worker when its build starts, not before. The board picks among workers that
are online, ready for the project, signed in to the step's provider with quota to spare, not
reserved, and with room for the whole card:

1. **Warm first:** a worker that finished building one of this board's cards for the same repository
   in the last 24 hours, the most recent first. Reviews and CI don't count.
2. Then the worker with the most room left after the card.

The card's **Worker** row says where it was placed, when, and why ("offered the most RAM among ready
workers", "built z5 most recently", "pinned"), or **Not placed yet: chosen when the build starts**.
The board server is in the pool when it's ready; declare it zero build capacity to keep it for
planning only.

**Pin builds to…** in a card's details restricts its builds to one worker; it doesn't affect
planning. Each worker in the picker says whether it's ready and what it offers. A card that holds a
worktree stays on its worker: the board only moves it if you **Move** it or its worker is removed.
**Unpin** leaves a placed card where it is. There is no longer a default worker.

A card that no worker can take says why: **No ready worker for this project** (amber: set the
project up on a worker, or fix its readiness), **Too big for any worker** (amber: lower its size or
the baseline, or raise a worker's capacity), or a wait that clears by itself (room, quota, an agent).

If a step's provider isn't on the card's pinned worker, the step doesn't start and the card says
**Provider missing**. Pin the card to a worker that has it, or pick a model the worker offers in the
card's **Models**, and the step starts again.

## Showing the cards on one worker

On a board with workers, **Worker** beside **Filter cards** shows only the cards whose worktree is
on the workers you pick; **Not placed yet** shows the cards that haven't started building. A card
planned on the board server and built on build-01 shows under build-01. The filter is in the page's
address, so you can share it, and the board remembers your last choice in this browser. **Show cards
on this worker** in a worker's menu on the Workers page opens the board filtered to it.

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

## Capacity: what a worker can take

Each worker decides how much work it takes. It declares its CPU cores, RAM and disk, and the board
asks it for room before a card gets a worktree there. A card is placed only when the worker has room
for it, and a queued card says what it's waiting on: **waiting for room** (its details name the
worker and whether it's CPU, RAM or disk), **Next on build-01** when it holds a worker,
**build-01 is reserved for T3O-90** when this board holds that worker for an earlier card,
**build-01 isn't taking new cards**, **agents busy** when the worker's agent cap is full, **provider
near quota** when the provider's subscription is nearly used up, or **needs update** when the
worker is too old to be asked. Cards queue in Building in the usual order; **Start now** jumps
the queue and starts a card even on a worker that isn't taking new cards (the worker still refuses
it if the machine lacks the disk or half the RAM).

### Holds: a large card doesn't wait forever

When no worker can take a card now, it **holds** a worker straight away: that worker takes no new
cards from any board until the held card starts. Cards behind it can still start on other workers.
The held card starts as soon as all of its disk and half of its CPU and RAM are free, so a worker
will often run one card over its declared capacity: declare capacity with that in mind.

- A card holds at most two workers and releases the other when it starts. A board holds at most half
  of its ready workers, so a second hold only happens with four or more.
- A card short of disk, quota, readiness or a provider sign-in holds nothing: freeing CPU and RAM
  can't help it.
- A board that started a card early on a worker can't hold it again until the worker is back within
  its capacity, or for 30 minutes; any other board can.
- After two hours, a hold ends as soon as another board is waiting, and that board can't hold the
  worker again for two hours (the card's waiting details show when). With nobody waiting, a hold
  carries on.
- A card that needs more room to carry on its own build holds its own worker, ahead of new cards.

On the worker, `pnpm t3o-worker config` sets `hold.earlyStartFraction` (default 0.5) and
`hold.maxMinutes` (default 120), and `pnpm t3o-worker status` shows any hold.

By default a worker declares every core it has, its RAM less 8 GiB (at least half of it; less where
T3 Code limits its agents' memory), and 90% of the free disk where worktrees live. Change these on the worker with
`pnpm t3o-worker config`:

- `capacity.cpuCores`, `capacity.ramGiB`, `capacity.diskGB` — what the worker offers to boards.
- `maxAgents` — the most agents running at once on this worker, from every board. Unset means no cap.
- `providerCaps.<providerInstanceId>` — the most agents of one provider instance, such as
  `providerCaps.claudeAgent`.
- `quotaThresholdPercent` — how much of a subscription's usage window can be used before the worker
  stops taking new cards for that provider (default 95).

`pnpm t3o-worker status` shows what the worker declares, what it has free, and its agents.

**What counts toward a worker's load.** Every card with a worktree holds its disk. A card holds its
CPU and RAM while an agent or CI runs for it, and for 10 minutes after; a card that's waiting on
you frees them after that. Planning threads on the board's own server count too, and so does
anything else running on the machine: if real usage goes over what the worker declares, it takes
no new work until usage drops.

**Quota.** A worker stops taking new cards for a provider whose subscription is nearly used up, and
starts again when the window resets. Workers signed into the same subscription see the same usage,
so they stop together.

**After upgrading.** The old Concurrency settings are gone; **Settings → Board** says where each
limit went. Your workers declare their capacity instead, `maxAgents` and provider caps start unset,
and each project gets a baseline worked out from its recent cards, marked **set at upgrade** until
you change it.

## Card sizes and a project's baseline

A card reserves its project's **baseline** on its worker: what one normal card of that project
needs in CPU, RAM and disk. Set it in **Settings → Board → Projects → <project> → Resources**, or
in the `resources` block of the project's `t3o.json`. Each card has a size per dimension — S, M, L
or XL — that scales the baseline (M is the baseline itself). The planner suggests a size with its
plan; change it in the card's details, where **Reset to planner** goes back to the suggestion. A
new size applies the next time the card is placed: a card that already has a worktree keeps the
size it was granted.

A card bigger than its worker's whole capacity says **Too big** and can't be placed there. Lower
its size or the project's baseline, or pin it to a bigger worker. The Resources tab warns about
workers that can't take even an M card of the project.

## Measured resources and learned baselines

On Linux, a worker measures what each card's heavy steps actually used: CPU (core-seconds, and the
highest one-minute rate), peak RAM, disk reads and writes, and the worktree's size at the end of
the step. The card's Summary shows them in **Measured**, beside Usage, with the worker each step ran
on. A running step shows its figures so far. **Partial** means the worker restarted during the step,
so the figures are a lower bound. The footer compares the card's peak with what it reserved on its
current worker.

Some steps are **Not measured**, never shown as zero: Codex, Cursor, Grok, OpenCode, Antigravity
and Kiro steps (only Claude agents run in a space of their own that can be measured), and every
step on macOS or a machine without systemd. CI passes and setup runs are measured for every
provider. Measurements are approximate: programs that detach from the agent aren't counted, and a
memory spike shorter than five seconds can be missed.

The board **learns** each project's baseline from its cards. Each card that had a measured CI pass
or setup gives one sample per dimension, its largest step scaled to an M card; the learned value is
the 90th percentile of the last 30 days, once there are at least five cards. In **Settings → Board
→ Projects → <project> → Resources**, the table shows each dimension's declared and learned values
and what the planner uses for new placements.

- A learned **increase** applies to new placements, and grows cards already placed in the
  background when their worker has room. Against a value you declared it's capped at twice that
  value; against the placeholder or a value set at upgrade it isn't.
- A learned **decrease** is only offered: **Use learned** writes it as the declared value, which you
  can edit back.
- An increase that would leave an M card too big for every ready worker isn't used; the Resources
  tab shows it as a warning instead.
- **Pin declared** makes a dimension ignore learning until you switch it off.

## Setup and readiness

**Setup** runs once for each new worktree, before the card's agent starts: fetch, checkout,
submodules, then the project's setup script. The card shows **Preparing** while it runs and its
details list the stages, with **Retry**, **Cancel setup** and the full log. Setup that runs longer
than the project's setup timeout (30 minutes unless changed in the Resources tab) fails.

**Readiness** says whether a worker can run a project's cards at all. The worker runs the project's
readiness script, `.t3/ready.sh` unless the Resources tab names another, as it's committed on the
default branch. Write it to check the machine — tools installed, services running, credentials
present — not files in the repository. A project with no readiness script is ready wherever it has
a checkout. A worker that isn't ready for a project takes none of its cards and can't be pinned
for it. The worker re-checks every hour while ready and every 15 minutes while not;
**Re-check** in the Resources tab, or **Re-check all** on the Workers page, checks now.

Setup and readiness output is visible to everyone who uses the board, so scripts shouldn't print
secrets.

**Several boards on one worker.** A worker can serve more than one board, and each board only sees
its own cards. Boards that share a repository on the same worker should use different project key
prefixes, so their cards' branches never share a name.

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
worker is offline, its threads can't be opened; they open again, transcript and all, once it
reconnects. A device connected to the board through a relay or SSH can't open worker threads yet;
connect to the board's address directly.

Agents on a worker keep reaching the board through their own server, which passes their board calls
on to the board server. While the board server isn't connected to that worker, an agent's board
calls fail with a message telling it to retry shortly.

## Removing a worker

**Remove worker…** in a worker's menu takes it off the board, gives back everything the board held
on that machine (its own access and every user's), and stops the worker's credential working. An
offline worker can be removed too; work it never pushed may be lost. Nothing on the worker is
deleted: its worktrees, branches and thread history stay there.

When the worker can be reached, the board first pauses any step running there, then pushes each
card's branch where the remote is missing commits:

- Cards with no worktree there are placed again when they next build.
- A card whose work is all pushed carries on from its branch on whichever worker it's placed on
  next.
- A card with uncommitted or unpushable work, and every card on a worker that can't be reached,
  shows **Worker removed: move this card** until you move it.

Joining the same server again, with a new code, puts the cards still placed there back on it.

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
