---
id: t3o-34
title: Per-project GitHub token override (gitenv)
status: ready
prerequisites: []
---

# t3o-34 — Per-project GitHub token override (gitenv)

## Goal

Let a specific project authenticate to GitHub as a different identity than the machine's
ambient `gh` login. A hand-edited file maps project roots to PATs; T3o injects the token
into every subprocess that talks to GitHub on that project's behalf.

Upstream has no mechanism for this: every `gh`/`glab` call inherits the server's
`process.env` verbatim (verified — `GitHubCli.ts`, `GitLabCli.ts`, and the three
discovery probes pass no `env`).

## The gitenv file

- **Location:** `<stateDir>/gitenv` (i.e. `~/.t3/userdata/gitenv` in prod, the worktree's
  sandboxed `.t3` state dir in dev). Not hardcoded to `~/.t3`.
- **Format:** one `<project_root>=<pat>` per line. `#` comments and blank lines allowed.
  Keys are absolute paths to the project's main repository root. No username component —
  `GH_TOKEN` alone authenticates `gh`, and gh's git credential helper honors it for
  https git auth too.
- **Permissions:** created/expected `0600`. Log a one-line warning (no values) if looser.
- **Reload:** read on use with an mtime cache — no restart needed to change a token.

## Matching semantics

Resolve the calling `cwd` to its **main repository root** (worktree-aware, e.g. via
`git rev-parse --git-common-dir`), then exact-match that root against gitenv keys.
Cache the cwd→root resolution per directory.

Rationale (locked): board worktrees live at `<T3 home>/worktrees/…`, *outside* the
project directory, so the originally proposed raw prefix match on cwd would silently
miss every board build.

## Injection points

When a match is found, merge `{ GH_TOKEN, GITHUB_TOKEN }` over the inherited env
(existing `extendEnv: true` semantics — never replaces `PATH` etc.). gitenv wins over
any ambient `GH_TOKEN` in the server's own environment.

1. **Server forge CLI seam** — `GitHubCli.execute` (`sourceControl/GitHubCli.ts:374`)
   and the three `SourceControlProviderDiscovery.ts` probes (version, auth-status,
   remote refinement). All already accept an optional `env`.
2. **Agent provider subprocesses** — thread spawn path where
   `mergeProviderInstanceEnvironment` is applied (all five drivers in
   `provider/Drivers/`). Project is known at spawn; match on its `workspaceRoot`.
   This is what makes agent-run `gh pr create` use the right identity.
3. **Server git subprocesses** — `GitVcsDriverCore` git spawns (already build an
   explicit env), so server-side fetch/push (board base-branch sync, checkpoint
   pushes) honor the identity when the remote authenticates via https + gh helper.

Explicitly **out of scope**: interactive terminal sessions (ambient auth stands),
GitLab/Bitbucket/Azure (no universal token var exists; the reader is structured so a
forge-aware variant can be added later without changing the file format), any UI or
settings-store surface, and worktree setup scripts.

## Security constraints (locked)

- The token rides only in spawn `env` options — never in argv, never string-built into
  a shell command, never sent to a model prompt.
- Never log the value. `safeProcessOutput` already scrubs `ghp_/gho_/github_pat_/…`
  shapes from persisted output; additionally scrub the exact configured token values
  from persisted forge output as defense for nonstandard token formats.

## Implementation shape

New T3o-owned module (e.g. `apps/server/src/sourceControl/gitenv.ts` or
`apps/server/src/board/…` adjacent): parse + cache the file, resolve cwd→repo-root,
return `{ GH_TOKEN, GITHUB_TOKEN } | undefined`. Upstream files get one-line `T3o:`
marked delegating calls at the seams above. New files over edits wherever possible.

## Acceptance criteria

- With a gitenv entry for a project, `gh auth status` run through discovery, server PR
  find/merge, and an agent's `gh` calls in a board worktree all act as the overridden
  identity; a project without an entry behaves exactly as today.
- A gh call from a board worktree under `<T3 home>/worktrees/` matches its project's
  entry (worktree-aware resolution proven by test).
- Editing the file takes effect without a server restart.
- The token value appears in no log line, no persisted event/output, and no argv.
- Focused server tests cover: parse (comments/blank/malformed lines), match/no-match,
  worktree resolution, env merge precedence over ambient `GH_TOKEN`.
- Docs: short page under `docs/t3o/` describing the file, its location per environment,
  and the GitHub-only scope.
