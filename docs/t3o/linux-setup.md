# Set up T3o from GitHub on Linux

Copy-paste path for a Linux terminal (Debian/Ubuntu and similar). It clones this repository, builds
T3o, and either runs it in the foreground or installs it as a systemd service.

Flags, Node-path caveats, takeover, and the rest of the service machinery:
[install.md](./install.md).

There is no `npx t3` for T3o, and no published desktop installer yet. `npx t3@latest`,
`t3 service install`, and upstream's `.deb` / AppImage all install **upstream T3 Code**, without the
board.

## 1. Packages

```bash
sudo apt update
sudo apt install -y git rsync build-essential python3 curl
```

## 2. Node.js 24.13.1 or newer

Distro Node is too old (`engines.node` is `^24.13.1`).

For a first try, [nvm](https://github.com/nvm-sh/nvm) is fine:

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 24
nvm use 24
node -v   # 24.13.1 or newer
```

If this machine will run **t3o.service**, install Node system-wide (NodeSource, or the official
tarball into `/usr/local`) instead of nvm. The unit's `ExecStart` is the absolute path of the `node`
that ran the install, so an nvm version that later gets pruned takes the service with it.

## 3. pnpm 11.10.0

```bash
corepack enable pnpm
# if corepack is missing:
# npm install -g pnpm@11.10.0
pnpm -v
```

## 4. Clone this repository

```bash
git clone https://github.com/brentkelly/t3code-orchestrator.git ~/t3o
cd ~/t3o
git checkout t3o
```

`t3o` is the trunk. `main` is an upstream mirror.

## 5. Provider CLI

Install and log in as **the same user** that will run T3o. You need at least one:

```bash
# Claude  — https://claude.com/product/claude-code
claude auth login

# Codex   — https://developers.openai.com/codex/cli
codex login

# Grok    — https://x.ai/cli
grok login

# Cursor  — https://cursor.com/cli
agent login

# OpenCode — https://opencode.ai
opencode auth login
```

Do this before installing the systemd unit. The unit captures PATH at install time; a CLI added
later needs `pnpm run install-t3o-service` again.

## 6. Install workspace dependencies

```bash
cd ~/t3o
pnpm install
```

Use `pnpm install`. `npm install` fails on `catalog:` versions. Do not pass `--frozen-lockfile` on a
fresh clone.

## 7. Run it

**Foreground (try it once):**

```bash
cd ~/t3o
pnpm run dev
```

Watch the terminal for a **Pairing URL** and open it in a browser on this machine. Ctrl+C to stop.
`pnpm run dev` uses a gitignored `.t3` under the checkout, not `~/.t3`.

**Background service (recommended on a box you leave running):**

```bash
cd ~/t3o
pnpm run install-t3o-service
```

That builds the server, copies it to `~/.t3/app`, writes `/etc/systemd/system/t3o.service`, and
starts it on `http://127.0.0.1:3773` with data in `~/.t3`.

If something else already holds port 3773:

```bash
pnpm run install-t3o-service -- --takeover
```

Pairing URL:

```bash
journalctl -u t3o.service -n 200 --no-pager | grep -i 'Pairing URL'
```

If that token was already used:

```bash
cd ~/t3o
node apps/server/src/bin.ts pair
```

The default bind is `127.0.0.1`. Reach it from another machine through a reverse proxy rather than
binding `0.0.0.0`.

## 8. After a `git pull`

```bash
cd ~/t3o
git pull
pnpm install                     # only if the lockfile moved
pnpm run install-t3o-service     # skip this if you are only using pnpm run dev
```

## Uninstall

```bash
cd ~/t3o
pnpm run uninstall-t3o-service
```

That removes the unit. `~/.t3` (your data) is left in place.

## If a command fails

| What you see                                                 | What to run                                                       |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| `Unsupported URL Type "catalog:"`                            | `pnpm install` (you used npm)                                     |
| `node_modules/.bin/vp … ENOENT`                              | `pnpm install`                                                    |
| `corepack: command not found`                                | `npm install -g pnpm@11.10.0`                                     |
| `node-gyp` / `node-pty` compile error                        | `sudo apt install -y build-essential python3` then `pnpm install` |
| Card turn fails with `ENOENT` on `claude` / `codex` / `grok` | Re-run `pnpm run install-t3o-service` after the CLI is on PATH    |

Longer notes: [install.md](./install.md).
