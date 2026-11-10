# GitHub tokens by owner

When the projects on one server belong to different GitHub owners, each needing its own token,
put the tokens in one file and T3 picks the right one for each project. The same file signs in
git and `gh` in your terminals.

## Set it up

Create `~/.t3/userdata/gitenv` on the server and make it private (`chmod 600`). One line per
token:

```
github.com/your-org = github_pat_...
github.com/your-name = github_pat_...
github.com/your-org/one-repo = github_pat_...
/home/you/projects/special = github_pat_...
```

A project uses its folder's line if there is one, then its repo's line, then its owner's line,
then the token from **Settings → Source Control → GitHub**, `GH_TOKEN`, or `gh auth login`. T3
reads the repo from the project's `origin` remote, so every worktree of a project gets the same
token. Changes apply on the next GitHub call; no restart.

To rotate a token, edit its one line.

## Check which token a project uses

**Settings → Source Control → Project tokens** lists each project with where its token comes from
and whether GitHub accepts it. A token GitHub rejects is marked, with the line to edit. Use the
refresh button after changing the file.

## git and gh in your terminals

Installing the T3o service adds a `t3-git-credential` helper and a `gh` wrapper to `~/.local/bin`,
and prints the lines to add to `~/.gitconfig` if they are missing:

```
[credential "https://github.com"]
	helper =
	helper = !t3-git-credential
	helper = !gh auth git-credential
	useHttpPath = true
```

After that, `git push` and `gh` in any checkout sign in with the token T3 would use. A repo with
no line in the file falls through to your normal `gh` sign-in.
