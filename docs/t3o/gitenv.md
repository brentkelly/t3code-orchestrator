# gitenv — per-project GitHub token overrides

`t3o-34`. Lets a specific project authenticate to GitHub as a different identity than the
machine's ambient `gh` login. Upstream has no mechanism for this: every `gh` call inherits the
server's environment verbatim, so auth is whatever `~/.config/gh/hosts.yml` (or an ambient
`GH_TOKEN`) says.

## The file

One hand-edited file at `<stateDir>/gitenv`:

- production: `~/.t3/userdata/gitenv`
- `vp run dev` against `~/.t3`: `~/.t3/dev/gitenv`
- a dev worktree: `<worktree>/.t3/userdata/gitenv`

Format, one entry per line — the key is the absolute path of the project's main checkout:

```
# comments and blank lines are fine
/home/me/projects/client-x=github_pat_XXXX
```

`chmod 600` it; the server logs a one-line warning (never the value) if group/other can read it.
Edits take effect on the next spawn — the file is re-read whenever its mtime changes, no restart
needed. Malformed lines (no `=`, empty value, relative key) are silently skipped.

There is no username component: `GH_TOKEN` alone authenticates `gh`, and https git pushes work
through gh's credential helper, which honors the same variable. SSH remotes ignore tokens entirely.

## What it affects

When a subprocess is spawned for a directory that resolves into a matched project,
`{ GH_TOKEN, GITHUB_TOKEN }` is merged over its inherited environment. The token rides only in the
spawn env — never in argv, never in a shell string, never in model-visible text — and persisted
forge output is scrubbed of the exact configured values on top of the usual token-shape scrub.

Covered surfaces:

- **The server's own `gh` calls** — discovery/auth probes, PR find and merge (the board's merge
  path included).
- **The server's own `git` fetch/push** — matters only for https remotes using gh's credential
  helper.
- **Agent sessions** for Claude, Codex, Cursor and Grok — the agent's `gh pr create` in a board
  worktree acts as the project's identity. OpenCode is not covered: its server process is not
  spawned per-project, so there is no per-project env seam.

Not covered, by design: interactive terminals (ambient auth stands), GitLab / Bitbucket / Azure
(no cross-forge token variable exists; the reader can grow a forge-aware variant later without
changing the file format).

## Matching is worktree-aware

The calling directory is resolved to its **main repository root** (following a linked worktree's
`.git` file back to the main checkout) and that root is matched exactly against the file's keys.
Board worktrees live under `<T3 home>/worktrees/`, outside the project directory, so key the entry
by the project root — one line covers the project and every worktree cut from it.

## Implementation

All logic lives in `apps/server/src/sourceControl/gitenv.ts` (T3o-owned, deliberately synchronous
and dependency-free so each seam stays a one-line expression). The 13 seams across 6 upstream
files are listed in the [seam inventory](./seams.md) census. `initGitenv` is wired into
`ServerConfig.make`; before it runs, or when the file is absent, behavior is exactly stock.
