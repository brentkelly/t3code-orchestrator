# Installing and deploying T3o

T3o is a fork of T3 Code and is published nowhere. There is no `npx`, no installer and no package
registry — you clone this repository, build it, and point a service at the build. This page is the long
form of the fork section in [`README.md`](../../README.md).

Upstream's own background-service instructions ([docs/user/background-service.md](../user/background-service.md))
do not apply. `t3 service install` runs `npm install t3@<version>` from the public registry
(`apps/server/src/cloud/pinnedRuntime.ts`), so it would serve **upstream's** server against this fork's
data directory: no board, no warning, and a database written by a build that has never heard of it.

## Prerequisites

| Need                         | Why                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| Node.js `^24.13.1`           | `engines.node`. Distro packages are older; see the note below on installing it.        |
| pnpm 11.10.0                 | The workspace uses pnpm catalogs. npm and yarn cannot resolve `catalog:` versions.     |
| `build-essential`, `python3` | `node-pty` has no Linux prebuild and compiles on install.                              |
| `rsync`                      | The service install copies the build out of the worktree with it.                      |
| `git`                        | Checkpointing, worktrees and every board branch operation shell out to it.             |
| systemd + `sudo`             | Only for the service. You can run the build by hand without either.                    |
| A provider CLI               | Claude, Codex, Cursor, Grok or OpenCode, authenticated as the user running the server. |

## Install

```bash
corepack enable pnpm     # or: npm install -g pnpm@11.10.0
pnpm install
```

Install Node system-wide (NodeSource, or the official tarball into `/usr/local`) if this machine will run
the service. The unit's `ExecStart` is written with `process.execPath` — the absolute path of the `node`
that ran the install — so an nvm- or fnm-managed Node pins the service to a version-specific path under
your home directory, and the unit breaks the day that version is pruned or upgraded. Either is fine for
building; only the deployed unit cares.

Switching Node major versions invalidates the compiled `node-pty` binding. Re-run `pnpm install` after an
upgrade.

Use plain `pnpm install`. `--frozen-lockfile` under-links workspace binaries on a fresh checkout, which
shows up later as a missing `vp` or a missing test runner.

`pnpm install` is also what creates `node_modules/.bin/vp`. Every script in the root `package.json` calls
`vp`, so before the install they all fail identically:

```
t3o-service: /path/to/t3o/node_modules/.bin/vp failed to start: ENOENT
```

The global `vp` from `curl -fsSL https://vite.plus | bash` is optional. The repo pins its own copy through
the `vite-plus` devDependency, and the service install invokes it by path.

## Build

```bash
pnpm run build                      # every app and package
pnpm exec vp run --filter t3 build  # just the server + web client the service runs
```

The second is exactly what `install-t3o-service` runs for you, so a deploy does not need a separate build
step. `t3` is the package name of `apps/server`; its build emits `apps/server/dist/bin.mjs` with the web
client bundled underneath at `dist/client/`.

## Deploy as a systemd service

```bash
pnpm run install-t3o-service
```

That builds, rsyncs `apps/server/dist` to `~/.t3/app/dist`, writes `/etc/systemd/system/t3o.service`, and
enables and starts it on `http://127.0.0.1:3773` against the `~/.t3` data directory.

The build is copied out of the worktree on purpose: `vp pack` wipes `apps/server/dist` on every build, which
would pull the tree out from under a live process. Only changed chunks move, so redeploys are quick.

`dist/` alone is not runnable — the bundler leaves the native packages external, and outside the worktree
there is no `node_modules` to resolve them from. The app directory therefore also gets a small
`package.json` listing exactly those roots at the versions the worktree resolved, plus an `npm install`
that re-runs only when one of them moves.

### Flags

| Flag              | Default      | Meaning                                                         |
| ----------------- | ------------ | --------------------------------------------------------------- |
| `--home <dir>`    | `~/.t3`      | Data directory. Becomes `T3CODE_HOME` in the unit.              |
| `--app-dir <dir>` | `<home>/app` | Where the build is synced.                                      |
| `--port <n>`      | `3773`       | Listen port.                                                    |
| `--host <addr>`   | `127.0.0.1`  | Listen address.                                                 |
| `--unit <name>`   | `t3o`        | Unit name without `.service`.                                   |
| `--no-build`      | off          | Sync the existing `apps/server/dist` instead of rebuilding.     |
| `--takeover`      | off          | Stop and disable whatever else holds the port, then start.      |
| `--no-restore`    | off          | (uninstall) leave the unit `--takeover` displaced switched off. |

Pass them after `--` so the package manager forwards them:
`pnpm run install-t3o-service -- --port 3800 --unit t3o-staging`.

Other subcommands, via `node scripts/t3o-service.mjs <command>`:

- `sync` — build and publish to the app directory without touching systemd. Refuses to run while the unit
  is active, since it would be rewriting files the running process has open.
- `status` — `systemctl status`, plus a note about anything `--takeover` displaced.
- `unit` — print the unit file to stdout without writing it. Useful for reviewing the resolved PATH.

### What the unit contains

- `User=` you, `WorkingDirectory=` your home.
- `T3CODE_HOME=<home>` and `NODE_OPTIONS=--enable-source-maps`, so stack traces point at source lines
  rather than into `bin.mjs`.
- `EnvironmentFile=-~/.secrets` — optional, the `-` means the unit still starts when the file is absent.
- A **PATH resolved at install time** from where your provider CLIs, `git` and `rg` actually live. systemd
  hands a service a bare PATH, so anything missing from this list fails at spawn with `ENOENT` when a card
  tries to start a turn. Install providers before installing the service; re-run the install after adding
  one.
- `Restart=on-failure`, plus `MemoryHigh=65%`, `MemoryMax=80%` and `OOMPolicy=continue`. Board agents' builds
  run inside the service's cgroup, so a build that exhausts memory is killed there, and the server keeps
  running, instead of the kernel killing unrelated services across the machine. Don't add a negative
  `OOMScoreAdjust`: every agent child inherits it.

### Taking over from another server

Only one server can own a data directory, so if something already holds the port the install stops short
and tells you what it found rather than starting a second writer:

```
Installed t3o.service, but did NOT start it: port 3773 is already held by
  t3code.service (pid 1234)
```

`--takeover` disables that unit and starts ours, recording the displaced unit and whether it was enabled in
`<home>/.t3o-service-takeover.json`. `uninstall` reads that file and puts it back, so the switch is
reversible. If the holder is not a systemd unit, the install refuses and asks you to stop it yourself —
by the PID it printed, never by pattern.

Note that the holder is often the very instance you are reading this through, and the switch drops that
session.

### First connection

The pairing URL, token included, is printed once at startup:

```bash
journalctl -u t3o.service -n 200 --no-pager | grep -i 'Pairing URL'
```

If it has been consumed or scrolled out of the journal, mint another from the checkout:

```bash
node apps/server/src/bin.ts pair
```

The startup URL carries admin scopes, which Settings → Connections needs. A minted one carries the
standard scopes.

The default bind is `127.0.0.1`. To reach it from another machine, put a reverse proxy in front of it
rather than moving the bind to `0.0.0.0` — the server is designed to sit behind one, and `--host` exists
mainly for the proxy-less local case.

## Redeploy after a pull

```bash
git pull
pnpm install                     # only if the lockfile moved
pnpm run install-t3o-service
```

The build runs first, while the old version keeps serving; the unit is stopped only for the sync and
restart. That window is a few seconds, but agent turns in flight are still interrupted, so pick a quiet
moment.

Nothing else is needed. Migrations — upstream's and the board's — run at startup, and if the upgrade
changed a native dependency the app directory's npm install re-runs on its own.

## Running without systemd

After a `sync` (or a full install), the app directory is self-contained:

```bash
T3CODE_HOME="$HOME/.t3" node ~/.t3/app/dist/bin.mjs serve --host 127.0.0.1 --port 3773
```

That is exactly the unit's `ExecStart`. For development, use `pnpm run dev` instead — in a worktree it
defaults to that worktree's gitignored `.t3`, so it cannot land on your real data by accident.

## Desktop app (.deb)

The Electron app builds as a T3o-branded Debian package (x64 only) that installs **alongside**
upstream T3 Code. It bundles this checkout's server and web client, so the board comes with it.

Building needs the Linux desktop prerequisites on top of the ones above — Rust (`cargo`, `rustc`),
`libsecret-1-dev`, `pkg-config` and ImageMagick:

```bash
sudo apt-get install cargo rustc libsecret-1-dev pkg-config imagemagick
pnpm run dist:desktop:deb
sudo apt install ./release/T3o-*.deb
```

Never set `T3CODE_DESKTOP_UPDATE_REPOSITORY` or `GITHUB_REPOSITORY` for a local build. With neither
set the app has no update feed, which is what keeps it from auto-updating into upstream's release.
Rebuild and reinstall the .deb to update.

### Why it has its own identity and home

The package is `t3o` (`/opt/T3o/t3o`, app id `com.brentkelly.t3o`, WM class `t3o`), its Electron
profile is `~/.config/t3o`, and its T3 home is **`~/.t3o`**. `T3CODE_HOME` still overrides the home.
It claims no `t3code://` handler: that scheme stays with upstream, so sign-in callbacks that go
through `t3code://` open upstream T3 Code (or nothing) rather than T3o.

The two apps never share `~/.t3`, even though the board's tables are separate:

1. Upstream rewrites `settings.json` from its own schema, which drops T3o's `board` block.
2. Upstream auto-updates ahead of T3o, so T3o would open a database migrated by a newer upstream.
3. One server per data directory: they could not run together, and both own `<home>/bin/t3`.

### Using it with the central board

The desktop app is a client of the board server. Pair it with the central server under **Settings →
Connections**, then choose that server under **Settings → Board → Board server**. The setting is
saved on this device only; until it is set the app shows its own local server's board.

### Bringing your threads across

The app's launcher lives at `~/.t3o/bin/t3`. With T3o closed, copy your upstream threads in:

```bash
~/.t3o/bin/t3 import-threads                          # every project, 50 recent threads each
~/.t3o/bin/t3 import-threads --project ~/src/app      # one project; repeat --project for more
```

It reads `~/.t3/userdata/statev2.sqlite` read-only (`--from` picks another home) and copies the
attachments of the threads it keeps. Stopped and settled threads come with their forks and
subagents. Running, archived and deleted threads, scheduled tasks, queued work, sign-ins and pairing
links stay behind, so T3o never picks up upstream's running agents. Board cards and `settings.json`
are not imported.

It refuses to run while T3o's server is running, when your T3 Code is newer than this T3o build
("update T3o first"), and when `~/.t3o` already has threads. `--replace` discards those after asking.

### Optional: the desktop's server as a worker

The app's local server can also be a worker for the central board. Open **Settings → Connections**,
enable **Network access** (the app restarts), then add it from the board server's **Settings → Board
→ Workers** — or run `~/.t3o/bin/t3 pair` on the desktop and paste the link into **Add worker**. The
board server must be able to reach the desktop over the network.

## Uninstall

```bash
pnpm run uninstall-t3o-service
```

Removes the unit, and restores whatever `--takeover` displaced unless you pass `-- --no-restore`. The
synced build at `~/.t3/app` is left behind for you to `rm -rf`, and your data at `~/.t3` is never touched.

## Troubleshooting

**`npm ERR! code EUNSUPPORTEDPROTOCOL` / `Unsupported URL Type "catalog:"`**
You ran `npm install`. `catalog:` is a pnpm feature; use `pnpm install`.

**`node_modules/.bin/vp failed to start: ENOENT`**
Dependencies were never installed, or were installed with `--frozen-lockfile` on a fresh checkout. Run
`pnpm install`.

**`corepack: command not found`**
Not every Node build ships corepack. Use `npm install -g pnpm@11.10.0` instead.

**`node-gyp` / `node-pty` build failure**
Missing compiler. `sudo apt install -y build-essential python3`, then `pnpm install` again.

**`missing build asset apps/server/dist/bin.mjs`**
You passed `--no-build` without a build in the tree. Drop the flag.

**A card's turn fails immediately with `ENOENT` on the provider**
The unit's PATH was resolved before that CLI existed. Re-run `pnpm run install-t3o-service`, and check the
result with `node scripts/t3o-service.mjs unit`.
