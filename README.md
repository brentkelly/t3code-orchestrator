# T3 Code

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, and OpenCode. If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

<!-- T3o: fork section. Upstream's README has no equivalent; keep fork additions together under this marker. -->

## This is T3o, a fork

This repository is **T3o**, a fork of [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) that adds
**Board** mode: work is managed as cards moving through a fixed engineering pipeline (Backlog → Sprint →
Planning → Ready → Building → Code review → Ready for merge → Done), and the app spawns, supervises and
restarts the agent threads that do the work.

T3o is not published to any registry. `npx t3@latest`, the desktop installers and the package-manager
recipes under [Installation](#installation) all give you **upstream**, without the board. To run T3o you
build it from this checkout.

### Requirements

- **Node.js 24.13.1 or newer** — `engines.node` is pinned to `^24.13.1`. Distro packages are usually far
  older; use [nvm](https://github.com/nvm-sh/nvm), [fnm](https://github.com/Schniz/fnm) or
  [NodeSource](https://github.com/nodesource/distributions).
- **pnpm 11.10.0** — the workspace uses pnpm catalogs (the `catalog:` versions in `package.json`), which
  npm and yarn cannot resolve. An `EUNSUPPORTEDPROTOCOL` / `Unsupported URL Type "catalog:"` failure means
  the wrong package manager, not a broken lockfile.
- **A C++ toolchain** — `node-pty` ships no Linux prebuild and compiles during install. On Debian/Ubuntu:
  `sudo apt install -y build-essential python3`.
- **`git` and `rsync`**, plus `sudo` rights if you want the systemd service.
- **At least one provider CLI**, installed and authenticated as the user that will run the server. See the
  warning under [Installation](#installation).

### Install and build

```bash
corepack enable pnpm     # or: npm install -g pnpm@11.10.0
pnpm install             # not `npm install`, and not `--frozen-lockfile`
pnpm run build           # every app; the service install below builds the server on its own
```

`pnpm install` is what puts `vp` (Vite+, the build tool) at `node_modules/.bin/vp`. Until it has run, every
script in `package.json` dies with `node_modules/.bin/vp … ENOENT`, `install-t3o-service` included. The
global `vp` install described near the bottom of this file is optional — the repo carries its own copy.

### Run it as a service (Linux, systemd)

Install the provider CLIs first: the unit is written with a PATH resolved at install time, and a provider
that was not on your PATH then will fail to spawn with `ENOENT`. Re-run the install after adding one.

`pnpm run install-t3o-service` builds the server, copies the build to `~/.t3/app` so the service never runs
out of the worktree, and writes a `t3o.service` unit serving `http://127.0.0.1:3773` from your `~/.t3` data
directory:

```bash
pnpm run install-t3o-service                 # install, enable and start
pnpm run install-t3o-service -- --takeover   # ...and switch off whatever else holds the port
pnpm run t3o-service-status
pnpm run uninstall-t3o-service               # remove the unit, restore whatever --takeover displaced
```

`--takeover` only matters on a machine already running another T3 Code server (upstream's
`t3code.service`, say). On a fresh one, nothing holds port 3773 and the plain install starts straight away.

The pairing URL is printed once at startup, and you need it to reach the web app:

```bash
journalctl -u t3o.service -n 200 --no-pager | grep -i 'Pairing URL'
```

Do **not** use upstream's `t3 service install` here. It runs `npm install t3@<version>` against the public
registry, and would serve upstream's build against this fork's data — no board, and no error to say so.

Flags, redeploying after a pull, running without systemd, and troubleshooting:
[docs/t3o/install.md](./docs/t3o/install.md).

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build and OpenCode. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Try it out (install-free)

The easiest way to test T3 Code is to run the server in your terminal (requires Node.js 22.16+, 23.11+, or 24.10+):

```bash
npx t3@latest
```

This will launch T3 Code's backend on your machine as well as the local web app to control your agents.

Tip: Use `npx t3@latest --help` for the full CLI reference.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Customize a project icon](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- Linux: [run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
