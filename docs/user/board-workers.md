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

The join command uses the address your browser has the board open on. If workers reach the board
another way (you opened it on `localhost`, or through a tunnel), press **Use another address** in
the Add worker dialog. Joined workers are told about the new address and move to it.

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

The board server's readiness only matters for builds, so a board server that fails it still
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
planning. To pin a card as you create it, use the pin icon beside the clock in the New card dialog's
footer. Each worker in the picker says whether it's ready and what it offers. A card that holds a
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

A worker measures its own capacity and keeps the board up to date, so there's nothing to set up.
It offers every core it has, its RAM less 8 GiB (at least half of it; less where T3 Code limits its
agents' memory), and on the disk where worktrees live, what its worktrees already take plus 90% of
the free space. These are read again with every report, so adding RAM or disk to a machine shows on
the Workers page without doing anything. Whatever the worker offers, a card only starts when the RAM
and disk are actually free.

To hold some of a machine back, or cap it, set these on the worker with `pnpm t3o-worker config`:

- `capacity.cpuCores`, `capacity.ramGiB`, `capacity.diskGB` — a fixed amount to offer instead of the
  measured one. `pnpm t3o-worker config unset <key>` goes back to measuring.
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

**After upgrading.** The old Concurrency settings are gone. Your workers declare their capacity instead, `maxAgents` and provider caps start unset,
and each project gets a baseline worked out from its recent cards, marked **set at upgrade** until
you change it.

## Card sizes and a project's baseline

A card reserves its project's **baseline** on its worker: what one normal card of that project
needs in CPU, RAM and disk. Set it in **Settings → Board → Projects → <project> → Resources**, or
in the `resources` block of the project's `t3o.json`. Each card has a size per dimension — S, M, L
or XL — that scales the baseline (M is the baseline itself). The planner suggests a size with its
plan; change it under **Resources** in the card's sidebar, where **Reset to planner** goes back to
the suggestion. A new size applies the next time the card is placed: a card that already has a
worktree keeps the size it was granted.

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

**Readiness** says whether a worker can run a project's cards at all. T3o checks it before a
worker takes a project's cards, then every hour while ready and every 15 minutes while not;
**Re-check** in the Resources tab, or **Re-check all** on the Workers page, checks now. A worker
that isn't ready for a project takes none of its cards and can't be pinned for it. A project with no
checks and no trusted script is ready wherever it has a checkout.

Readiness comes from two places:

- **Checks** in the project's `t3o.json`, under `resources.readiness.checks`. T3o runs them itself:
  nothing in `t3o.json` chooses which program runs, what arguments it gets, or which file is read,
  so no project code runs on the hourly timer.
- **The readiness script** (`.t3/ready.sh` unless the Resources tab names another), as committed on
  the default branch. It runs only if you switch on **Run this project's readiness script** in the
  project's Resources tab. It runs on every worker, every hour, as you, so whatever lands on the
  default branch runs next: only switch it on for projects whose code you trust. No project is
  trusted until you switch it on, and agents can't switch it on. Until you do, the script is skipped
  and the worker row says so, without making the worker not-ready.

Every check takes an optional `name`, a `fix` shown when it fails (labelled as suggested by the
project, plain text, at most 200 characters), `"warn": true` to report a failure as a warning
instead of not-ready, and `os` (`linux`, `darwin`, `win32`) or `arch` (`x64`, `arm64`) to run
only on matching workers; elsewhere it shows as skipped.

```json
"readiness": {
  "checks": [
    { "command": "cmake", "fix": "sudo apt install cmake", "os": ["linux"] },
    { "command": "node", "version": { "from": ".node-version" } },
    { "command": "pnpm" },
    { "rustToolchain": "rust-toolchain.toml" },
    { "cargoConfig": { "contains": "rustc-slot" } },
    { "exists": "$PLAYWRIGHT_BROWSERS_PATH/chromium-*" },
    { "exists": "~/.local/state/build-seed/refresh.log", "maxAgeHours": 3, "warn": true },
    { "env": "ANDROID_HOME" },
    { "docker": { "plugins": ["compose", "buildx"], "loggedIn": ["ghcr.io"] } },
    { "git": "identity" }, { "git": "fetch" }, { "git": "push" },
    { "gh": "github.com" },
    { "writable": "$TMPDIR" }
  ],
  "timeoutSeconds": 120
}
```

- `command`: a bare name, found on the worker's `PATH` or in the usual places mise, asdf, nvm, fnm,
  volta, rustup and Homebrew install to. Without `version`, nothing is run: the file just has to be
  there and executable. A binary is refused if another user owns it, others can write to it, or it
  sits in a checkout, a worktree, a temp folder, `~/.cache`, a package store (`~/.npm`, cargo's
  registry, `node_modules`, …) or the T3 home.
- `version` works only for `node npm pnpm yarn bun deno cmake make gcc clang git docker gh python3
  go java ruby php dotnet rustc cargo xcodebuild`, and only when the binary is a native program:
  T3o runs it with that tool's own version flag and compares the first version number to
  `atLeast`, or to the major and minor version a repository file on the default branch names (`.node-version`,
  `.nvmrc`, `package.json`'s `engines.<command>`, `.python-version`, `pyproject.toml`, `go.mod`,
  `.ruby-version`, `.java-version`, `composer.json`, `global.json`). A tool that is a script (npm, a
  corepack pnpm) gets a warning that its version wasn't checked. Aliases like `lts/*` warn too.
- `rustToolchain`: the `channel` the repository's `rust-toolchain.toml` pins is installed in rustup.
- `cargoConfig`: your cargo config (`$CARGO_HOME/config.toml` or `~/.cargo/config.toml`) contains
  the text. Lines whose key mentions a token, password, secret, credential or auth never match.
- `exists`: the path is there, and with `maxAgeHours`, was modified that recently. `writable`: you
  can write to the path; nothing is created. Paths start with `/`, `~/` or one of `$HOME`, `$TMPDIR`,
  `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, `$JAVA_HOME`, `$CARGO_HOME`, `$RUSTUP_HOME`,
  `$PLAYWRIGHT_BROWSERS_PATH` or `$XDG_*`; never `..` or a path inside the repository. They must
  stay under your home, the temp folder, `/usr`, `/opt`, `/etc`, `/nix`, `/dev`, `/Library` or
  `/Applications`, never `/proc`, `/sys`, `/run` or a network mount. `exists` may use `*` within a
  folder name, in at most two folders, and not directly under your home.
- `env`: the environment variable is set and non-empty. Its value is never shown.
- `docker`: the daemon answers `docker info`, each plugin is installed, and you are logged in to
  each `loggedIn` registry (read from the keys of your Docker config, never the credentials).
- `git`: `identity` (your global user.name and user.email), `fetch` (the remote answers without a
  prompt), or `push` (GitHub says you can push, asked through `gh`; other hosts give a warning).
  **These contact the remote every hour, with your credentials.** No repository hook runs.
- `gh`: the GitHub CLI is signed in to that host. For github.com, a token your `gitenv` file gives
  the project counts, as it does for card work.

At most 50 checks run per project; they share `timeoutSeconds` (at most 600) with the script, and
every one runs even after one fails. Each check runs from `/`, with no input and only a short list
of environment variables (`PATH`, `HOME`, locale, `TMPDIR`, `XDG_*`, the SSH agent, Docker and Rust
homes, and GitHub tokens for `gh`). On Windows workers, checks that run a program show as
unsupported.

**Kinds T3o will not add**, so a project can never use readiness to do these: arbitrary commands or
arguments; network probes (they could reach cloud metadata or your LAN, and tell a repository's
author which machines run it); cloud or Kubernetes sign-in checks (they run credential helpers and
touch real clusters); package-manager queries like `pip show`, `npm ls` or Python imports (they run
code); `gradle`/`mvn --version`, `sdkmanager` and `xcrun simctl`; disk, memory or CPU checks (the
capacity model owns those); `/proc` and sysctl reads; and reading arbitrary files.

**What readiness can't protect against.** Code a project already ran on a machine (its setup, CI or
a card's agent) ran as you and can persist itself: in the checkout's `.git/config`, a version
manager's config, Docker CLI plugins, shell profiles and so on. The hourly checks may then run it.
Readiness can't close that; only running workers under a separate account would.

A board that doesn't know a check ignores it with a warning on import, so a newer `t3o.json` still
imports on an older board. A worker on an older T3o can't run checks, and could run a script you
haven't trusted, so the board doesn't ask it: its row says to update it, and it takes no cards for
projects that have checks or a trusted script.

Only readiness is limited this way. Setup scripts and CI still run the branch's code when a card
starts work.

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
  its threads stay readable. Run `pnpm t3o-update` on the worker, or let auto-update do it (below).

## Keeping a worker up to date

A worker learns from each board, every time it connects, whether the board can still use it and
which T3o release the board runs. A board updated past what the worker speaks, or running a newer
T3o release than the worker, says so straight away, and `pnpm t3o-worker status` shows it as
**needs update**. Only the first stops the worker taking new cards; a worker that is just behind
the board's release keeps working until it updates. Only tagged releases are compared: a board
running a build past a tag, or a dev build, never asks its workers to update.

`pnpm t3o-worker auto-update --install` adds a systemd timer that checks for that every two
minutes and runs `pnpm t3o-update` when it's set. So releasing T3o and updating the board's
service is enough: its workers follow within a few minutes. Checking only reads a file on the worker; GitHub
is contacted only when an update is due. `--check` reports without updating, and `--uninstall`
removes the timer (`pnpm run uninstall-t3o-service` removes it too). Its runs are in
`journalctl -u t3o-auto-update`.

- The update reinstalls the service with `sudo`, so the worker's user needs passwordless sudo for
  `tee` and `systemctl` for the timer to finish it. `--install` warns when it doesn't have it.
  Blanket passwordless sudo works, or a sudoers entry scoped to those commands (adjust the user,
  unit name and binary paths from `command -v tee systemctl`):

  ```
  worker ALL=(root) NOPASSWD: /usr/bin/tee /etc/systemd/system/t3o.service, /usr/bin/systemctl
  ```

- When an unattended update fails and leaves the service stopped, the timer doesn't try again: each
  run fails in the journal until you run `pnpm t3o-update` by hand to see what went wrong.
- It installs the latest T3o release. A board running a build newer than every release keeps the
  worker on **Needs update** until that release is out; the timer then retries every 30 minutes.
- Agent turns running on the worker are interrupted when the service restarts, as with any update.
- Workers on a release from before auto-update never report the flag: update them by hand once.
  Workers on a release from before boards sent their release only update for a protocol change:
  update them by hand once to follow the board's releases.

## Threads on a worker

A card's thread runs on the worker the card was placed on, and opens in place through the board:
nothing to add on your device. The thread's header says which worker it's running on. While that
worker is offline, its threads can't be opened; they open again, transcript and all, once it
reconnects. A device connected to the board through a relay or SSH can't open worker threads yet;
connect to the board's address directly.

Agents on a worker keep reaching the board through their own server, which passes their board calls
on to the board server. While the board server isn't connected to that worker, an agent's board
calls fail with a message telling it to retry shortly.

## Scheduling a t3o.json task on a worker

A project's `t3o.json` schedules can run on a worker as well as on the board server: pick the
worker in the import dialog's **Run on** picker, or later on the project's **Schedules** tab. The
picker lists each worker with whether it is connected and ready for the project; one that is
offline, out of date or not ready for the project can't be picked until it is.

- **The board server keeps the time.** Every schedule fires on the board server's clock, and only
  while the board server is up. The worker only runs what the board sends it.
- **A run due while the worker can't take it is skipped**, and shows amber as skipped with the
  reason: offline, needs a T3o update, not ready for the project, its provider signed out, or at
  its agent limit. The Schedules tab warns while its worker is offline and offers to move it.
- **Its board tools reach the board**, limited to the schedule's project, as on the board server.
  A run can't change a card that runs on another machine.
- **A worker's agent limit is approximate for schedule runs**: a run counts against it from its
  launch, but the hold lapses while the worktree is set up, so a burst can briefly exceed it. A
  schedule never has two runs going at once.
- The worker keeps the latest runs and removes older settled ones, their worktrees and branches
  with them, as on the board server; a run that filed or changed a card keeps its thread. This carries on after the schedule
  moves to another machine, each time it fires, while the old worker is online.

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

On **Settings → Board → Workers**, each worker lists the board's projects beneath it: whether it
has a copy, and what the project's readiness checks last said there. A worker can only run cards
for projects it has checked out and ready. It matches them by the repository's git remote.
**Re-check** checks again. A Ready row with warnings or a skipped script opens to the full output.

For a project a worker doesn't have, press **Set up on worker**. The worker clones the project's
remote into its projects folder, using that machine's git credentials, and you can change the
folder before cloning. The clone runs on the worker, so you can leave the page while it runs. If a
clone fails, the row says why. **Details** shows git's own output, which you can copy, and you can
**Retry** from there.
