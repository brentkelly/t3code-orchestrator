# Source Control Integrations

T3 Code connects to your Git hosting provider so you can create pull requests, review code, and manage repositories without leaving the app.

## Supported Providers

T3 Code works with the platforms your team already uses:

- **GitHub** – Pull requests, repository creation, and clone integration
- **GitLab** – Merge requests, repository publishing, and hosted clones
- **Bitbucket** – Pull request workflows (via API token authentication)
- **Azure DevOps** – Pull request support for Microsoft-hosted repositories

## What You Can Do

### Start Projects from Anywhere

**Clone repositories directly**

- Open the Command Palette (`Cmd/Ctrl + K`) → **Add Project**
- Choose **GitHub repository**, **GitLab repository**, **Bitbucket repository**, **Azure DevOps repository**, or paste any **Git URL**
- Enter the repository path (`owner/repo`, `group/project`, `workspace/repository`, or `project/repository`) or a full Git URL, pick a destination, and start coding

**Publish local projects to the cloud**

- Have a local Git repository without a remote?
- Use the **Publish Repository** action to create a new hosted repository (GitHub, GitLab, Bitbucket, or Azure DevOps), add it as your origin remote, and push, in one flow
- If the local repository has no commits yet, publishing creates the remote and wires it up but does not push. Make a commit, then push normally.

### Manage Code Reviews Without Context Switching

**Create pull requests while you work**

- Push a branch and create a pull request from the Git actions controls in the toolbar
- T3 Code can suggest titles and descriptions based on your commits
- With **Repository conventions** selected, generated source control text follows the project's
  `AGENTS.md` along with recent commit subjects. Claude writers also follow `CLAUDE.md`
- Supports GitHub Pull Requests, GitLab Merge Requests, Bitbucket Pull Requests, and Azure DevOps Pull Requests

**Stay on top of open reviews**

- See if your current branch already has an open PR/MR
- Open several reviews from the **Pull requests** page as tabs in the right panel
- Filter the list by author or labels, rank authors by merges in the loaded results, see label and
  change-size context on each row, and sort the results currently shown by update time, creation
  time, or change size
- While working in a thread, open linked reviews in the same compact right-panel tabs without
  leaving the conversation
- Open the review directly in your browser with one click
- If T3 Code cannot load a GitHub pull request, including when GitHub rate limits requests, use
  **Open on GitHub** in the error view
- Command-click (Control-click on Windows and Linux) a pull request number in the sidebar to open it in your browser instead of in T3 Code
- Check out a teammate's branch to review code locally

**Fix what you wrote, in place**

- Rewrite a pull request's title and description from the review itself, in Markdown, with a
  preview before you save
- Rewrite your own comments the same way, wherever they are shown
- Works on GitHub, GitLab, and Bitbucket. Azure DevOps takes a new title and description; its
  comments stay read-only here, as they already were

### Know Your Setup at a Glance

The **Source Control settings** page shows you exactly what's connected:

- ✅ Which providers are authenticated and ready
- ⚠️ What's missing and how to fix it
- 👤 Which account is signed in (when available)

Run a quick **Rescan** after setting up a new machine or changing credentials.

## Getting Started

### For GitHub (Recommended for most users)

1. Install the GitHub CLI (version 2.81.0 or newer) on the machine running T3 Code:
   ```bash
   brew install gh
   ```
2. Sign in:
   ```bash
   gh auth login
   ```
3. Open **Settings → Source Control** in T3 Code and verify GitHub shows as authenticated

You can now clone, publish, and create pull requests.

#### Using a different GitHub identity for specific projects

By default every project uses the GitHub account you signed into with `gh` above. If one project
needs to act as a **different** GitHub identity — a client's org, a bot account, a separate set of
permissions — you can give that project its own personal access token without changing your machine
login.

Create a file named `gitenv` in the T3 Code data directory on the machine running the server
(`~/.t3/userdata/gitenv` in a standard install). Add one line per project, mapping the project's
folder to a token:

```
# The key is the path to the project's main folder — an absolute path,
# or one starting with ~ for your home directory.
# Lines starting with # and blank lines are ignored.
/home/you/projects/client-site=github_pat_xxxxxxxxxxxxxxxxxxxxxxxx
~/projects/other-client=github_pat_yyyyyyyyyyyyyyyyyyyyyyyy
```

- **Token** – a GitHub personal access token (fine-grained or classic) with the scopes that project
  needs, typically repository read/write and pull requests. No username is required.
- **Permissions** – keep the file private: `chmod 600 ~/.t3/userdata/gitenv`. T3 Code logs a warning
  (never the token itself) if the file is readable by other users.
- **Takes effect immediately** – the file is read on demand, so you can create it (or edit an
  existing one) while T3 Code is running; the next action against that project picks it up, no
  restart needed. A project with no entry keeps using your normal `gh` login.

Once a project has an entry, both **T3 Code's own actions** for it (clone, publish, pull request
create and merge, fetch and push over HTTPS) and any **coding agents working in that project** use
that identity — so an agent's own `gh` commands, such as opening a pull request, act as the project
account. Board work is covered automatically: an entry keyed to the project's main folder also
applies to every card branch T3 Code checks out for it, so you only write one line.

The token is only ever handed to the tools that need it, through their environment — it is never
placed in a prompt, an agent instruction, or a log, and it is stripped from any provider output
T3 Code stores. One caveat worth understanding: to let an agent's own `gh` act as the project, the
token is present in that agent's environment, and an agent that deliberately inspects its
environment could read it. Only give an entry to projects whose agents you're willing to trust with
that token; T3 Code's own actions still get the identity either way.

This override is GitHub-only. GitLab, Bitbucket, and Azure DevOps continue to use their configured
credentials.

### For GitLab

1. Install the GitLab CLI:
   ```bash
   brew install glab
   ```
2. Authenticate:
   ```bash
   glab auth login
   ```
3. Check **Settings → Source Control** to confirm the connection

### For Bitbucket

Bitbucket uses tokens instead of a CLI tool. Two options, both set as environment variables on the
machine running T3 Code.

Recommended, a Bitbucket access token:

```bash
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
```

Or an Atlassian account email plus API token, with read/write access to pull requests and
repositories, plus read access to your user account (`read:user:bitbucket`, used to verify the
connection):

```bash
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-token"
```

If both are set, the access token wins. Restart T3 Code and verify the connection in **Source
Control settings**.

### For Azure DevOps

1. Install Azure CLI:
   ```bash
   brew install azure-cli
   ```
2. Add the DevOps extension:
   ```bash
   az extension add --name azure-devops
   ```
3. Sign in:
   ```bash
   az login
   ```

---

## Requirements & Troubleshooting

**Git is required** – T3 Code uses Git for all local operations. Ensure `git` is installed on your server.

**Server-side setup** – Authentication happens on the machine running T3 Code (the server), not your local browser. If you're using a hosted or team instance, your administrator may have already configured providers.

**Common issues:**

- **Provider shows "Not authenticated"** – Run the login command for that provider (e.g., `gh auth login`) in a terminal on the server, then rescan in Settings
- **GitHub says it could not verify sign-in status** – T3 Code needs GitHub CLI 2.81.0 or newer to check sign-in status. Update `gh` (e.g., `brew upgrade gh`), then rescan
- **Bitbucket not connecting** – Double-check your environment variables are set in the correct shell profile and the server was restarted
- **Can't push to a remote** – Verify your Git remote URL matches the provider you've authenticated with (SSH vs HTTPS remotes may need different credentials)
- **A project ignores its `gitenv` entry** – Confirm the key is the _absolute path to the project's main folder_ (not a subfolder or a symlink), the token is valid, and the `gitenv` file is readable by the account running the server. Entries apply to GitHub only

**Need more help?** Check your provider's CLI documentation:

- [GitHub CLI](https://cli.github.com/)
- [GitLab CLI](https://gitlab.com/gitlab-org/cli)
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/)
