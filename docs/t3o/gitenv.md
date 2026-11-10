# gitenv — GitHub tokens by folder, repo or owner

`t3o-34`, extended by `T3O-58`. Lets a project authenticate to GitHub as a different identity than
the machine's ambient `gh` login, chosen by the project's folder, its GitHub repo, or the repo's
owner. Upstream has one identity per host (a Settings token, `GH_TOKEN`/`GITHUB_TOKEN`, or
`gh auth token`). The same file also signs in git and `gh` outside T3, through a credential helper
and a `gh` shim, so rotating a token means editing one line.

## The file

One hand-edited file at `<stateDir>/gitenv`:

- production: `~/.t3/userdata/gitenv`
- `vp run dev` against `~/.t3`: `~/.t3/dev/gitenv`
- a dev worktree: `<worktree>/.t3/userdata/gitenv`

One `key = token` per line. A key is one of three forms:

```
# comments and blank lines are fine
github.com/Zeald = github_pat_...                       # every Zeald repo
github.com/brentkelly = github_pat_...                  # every brentkelly repo
github.com/Zeald/client.z5.macjimray = github_pat_...   # one repo wins over its owner
/home/me/projects/client-x = github_pat_...             # one project folder wins over both
```

For a project, the order is: its folder entry, then `github.com/<owner>/<repo>`, then
`github.com/<owner>`, then upstream's chain (Settings token, the GitHub app, `GH_TOKEN`,
`gh auth token`). The repo is the main checkout's `origin` remote, read from its `.git/config`
(https, `git@github.com:` and `ssh://` URLs); an origin on another host, or a repo with no `origin`,
matches no repo or owner line. Owner and repo keys match without regard to case, and a trailing
`.git` on a repo key is ignored.

`chmod 600` it; the server logs a one-line warning (never the value) if group/other can read it.
Edits take effect on the next lookup — the file is re-read whenever its mtime changes, no restart
needed. Malformed lines (no `=`, empty value, a key that is neither an absolute path nor a
`github.com/` key) are silently skipped.

There is no username component: `GH_TOKEN` alone authenticates `gh`, and https git signs in with
`x-access-token` and the token. SSH remotes ignore tokens entirely.

Moving from folder entries: replace them with one `github.com/<owner>` line per owner, keep a
folder or repo line only where a project needs a different identity, then retire any hand-made
`gh` wrapper, its token file, and a server-wide `GITHUB_TOKEN` in the service environment.

## git and gh outside T3

`pnpm run install-t3o-service` writes two shims to `~/.local/bin`, both running the built
`dist/t3oGitCredential.mjs` against this install's file (`--file <home>/userdata/gitenv`):

- **`t3-git-credential`**, a git credential helper. It answers `get` for `https://github.com` with
  the token for the repo git names in `path=` (the folder entry for the current checkout first, when its `origin` is that repo),
  or for the folder's `origin` when git sends no path. With no match it prints nothing, so git
  asks its next helper. `store` and `erase` do nothing.
- **`gh`**, which works out the repo from `-R`/`--repo`, then `$GH_REPO`, then the folder's
  `origin`; on a match it sets `GH_TOKEN`, drops `GITHUB_TOKEN`, and runs the real `gh` (the next
  one on `PATH` that is not a T3o shim). With no match it runs `gh` untouched. An existing
  `~/.local/bin/gh` that is not a T3o shim moves to `gh.bak`; uninstall puts it back.

The installer never edits `~/.gitconfig`. When the helper is missing it prints the lines to add:

```
[credential "https://github.com"]
	helper =
	helper = !t3-git-credential
	helper = !gh auth git-credential
	useHttpPath = true
```

The empty `helper =` drops helpers set earlier for every host; `useHttpPath` makes git send the
repo path, without which every repo on github.com would get the folder's answer. The shim costs
about 25 ms of Node start-up per call. The server's own `gh` runs also reach the shim, because the
service `PATH` starts with `~/.local/bin`; it picks the same entry the server already put in
`GH_TOKEN`.

## Rejected tokens

When GitHub answers 401 to a token from this file, the server logs one warning per entry and token,
naming the entry and never the value: `GitHub rejected the token from gitenv entry github.com/Zeald
(401)`. **Settings → Source Control → Project tokens** lists every project with where its token
comes from (folder, repo or owner line with its key, Settings, the GitHub app, the environment, or
`gh`) and whether GitHub accepts it, checked with one `GET /user` per distinct token when the page
opens and on refresh. No token reaches the browser. Web and desktop only.

`gh auth token` runs from the project's main checkout rather than the server's home folder, so a
per-repo `gh` setup answers for it, and its cached answer is kept per project.

## What it affects

When a subprocess is spawned for a directory whose project matches a line,
`{ GH_TOKEN, GITHUB_TOKEN }` is merged over its inherited environment. The token rides only in the
spawn env — never in argv, never in a shell string, never in T3o's own persisted or logged output —
and persisted forge output is scrubbed of the exact configured values on top of the usual
token-shape scrub.

The containment stops at the agent's process boundary. To make an agent's own `gh pr create`
authenticate as the project, the token has to be in that agent process's environment — and, exactly
as with any ambient credential the process inherits, an agent that deliberately reads its own
environment (`printenv`, a tool that dumps env) can observe it. The guarantee is that T3o never puts
the token in a prompt, a tool argument, argv, or a log; it is not that the value is invisible to the
agent. If that exposure is unacceptable for a given project, don't give its agents an entry — the
server's own `gh`/`git` calls still get the override.

Covered surfaces:

- **The server's own `gh` calls** — discovery and auth probes.
- **The server's own GitHub API calls** — PR reads, PR discovery, actions and the merge (the
  board's merge path included), which since `v0.1.0` go over HTTP rather than through `gh`
  (`T3O-67`). Each GitHub provider call runs under its project directory, and the API transport
  resolves its token in this order: a pinned credential (a page that verified one identity keeps
  it), then the project's gitenv token, then the Settings token, `GH_TOKEN`, and `gh auth token`.
  Only requests to `github.com` take the gitenv token. Batched reads never mix identities, but the
  PR listing still asks each host once who you are, so its "mine" and "review requested" filters
  follow one identity per host.
- **The server's own `git` fetch/push** — matters only for https remotes, signing in through
  gh's credential helper or `t3-git-credential`.
- **Agent sessions** for Claude, Codex, Cursor and Grok — the agent's `gh pr create` in a board
  worktree acts as the project's identity. OpenCode is not covered: its server process is not
  spawned per-project, so there is no per-project env seam.

Interactive terminals are covered only through the helper and shim above. Not covered, by design:
GitLab / Bitbucket / Azure
(no cross-forge token variable exists; the reader can grow a forge-aware variant later without
changing the file format).

## Matching is worktree-aware

The calling directory is resolved to its **main repository root** (following a linked worktree's
`.git` file back to the main checkout); that root is matched exactly against folder keys, and its
`origin` is what repo and owner keys match.
Board worktrees live under `<T3 home>/worktrees/`, outside the project directory, so key the entry
by the project root — one line covers the project and every worktree cut from it. A linked-worktree
path works as a key too: keys are resolved to their main checkout exactly as lookups are.

## Implementation

All logic lives in `packages/shared/src/gitenv.ts` (`@t3tools/shared/gitenv`; T3o-owned,
deliberately synchronous and dependency-free so each seam stays a one-line expression). The API
transport's side is `packages/source-control-github/src/server/t3oGitenvCredential.ts`, the
Settings check is `t3oProjectTokens.ts` beside it, and the helper and shim are
`apps/server/src/t3o/gitCredential.ts` (entry `src/t3oGitCredential.ts`, which imports nothing but
the reader so it starts fast). The seams are listed in the [seam inventory](./seams.md) census. `initGitenv` is wired into
`resolveServerConfig` — the resolver every `t3` server boot goes through (`start`, `serve`, the
desktop bootstrap, `vp run dev`) — and into `ServerConfig.make`, which only `pair` still reaches with a hand-built config; it is
idempotent on the same path. Before it runs, or when the file is absent, behavior is exactly stock.
A focused test in `cli/config.test.ts` proves the boot-path wiring, not just the module.
