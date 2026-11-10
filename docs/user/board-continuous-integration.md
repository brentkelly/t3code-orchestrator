# Continuous integration

A project can have the board run its CI on every card after Code review and before Ready for merge.
Set it up on the project's page: **Settings** → **Board** → the project → **CI**. A card in CI links
there from its CI tab.

## Steps

Turn on **Run CI for this project**, then add steps. They run in order:

- **Script**: a shell command run in the card's worktree. Its exit code decides pass or fail. It's
  stopped and fails after its timeout (30 minutes unless you set it, at most a day).
- **Agent**: a prompt an agent runs in its own thread, for checks a command can't make. The board
  adds what the agent needs (the card, its branch and pull request, earlier results) and how to
  report. Like every CI step it checks the branch without changing it: what it finds goes to the fix
  agent.
- **Forge checks**: waits for the pull request's checks on GitHub, GitLab, Bitbucket or Forgejo. A
  draft pull request is marked ready first. You can wait on named checks only (`*` matches anything),
  and choose whether a pull request where no checks appear passes or fails. Without an open pull
  request, or on a forge with no checks API (Azure DevOps, GitCafe), the card waits for you.

A script marked **Parallel with previous** starts together with the script before it; the group
finishes before the next step starts. Scripts in one
group share a worktree, so they can collide on build output or caches. Agent and forge-check steps
always run on their own. A group that leaves changes to tracked files fails. A project can have at
most 12 steps.

Scripts run in the card's worktree as they are, so install what they need in the command.

## Stop on failure

**Stop on failure** on the CI tab decides what a failed step does to the steps after it:

- **Yes** (the default): a failure stops the steps after its group. Passes end sooner, but one pass
  may show only the first failure, so finding the rest can take several fix rounds.
- **No**: every step runs even after one fails, and the pass fails at the end if any step did. One
  pass shows every failure, and the fix agent gets all of them at once. Passes take longer.

Choose **No** when you want several steps for their status and timings on the card and still want
every failure from one pass. Steps still run one after another, never side by side. Skip CI, moving
the card out of CI and a pass that can't run still stop everything. A change applies from the next
pass.

## Reporting from a script

Only the exit code is required. A script can also:

- print progress lines, which stay in the step's log:
  `echo '::t3o-progress::{"message":"Running unit tests","done":128,"total":212}'`
- write a result file at `$T3O_CI_RESULT` before it exits, with a summary and failures the CI tab
  and the fix agent show:

```sh
cat > "$T3O_CI_RESULT" <<'JSON'
{ "summary": "3 of 212 tests failed",
  "failures": [{ "title": "slow_consumer_drops_oldest", "detail": "dropped frames",
                 "file": "src/fanout.rs", "line": 311 }] }
JSON
```

The result file adds detail only; it never turns a failing exit code into a pass, or the reverse.

## When a step fails

A fix agent gets every failure the pass reported, as a numbered list of issues, and fixes them on
the card's branch. Then every step runs again from the top. CI never sends a card back to Code
review by itself.

**Fix attempts** caps the fix agents one visit to CI may start (3 by default). When they run out, or
the fix agent reports something it can't fix, CI stops and the card waits for you, marked **Needs
you** with the reason: **Retry CI** starts over with fresh attempts, **Send back to review anyway**
sends the card to Code review with every failure as a must-fix finding, and **Skip CI…** moves it
on. Defaults are in **Settings** → **Board** → **Pipeline** → **Continuous integration**; each
project can override them on its **CI** tab, under **Fix agent**.

## Following a run

The card's **CI** tab shows each step, how long it took, a failed step's output and reported
failures, an agent step's thread, a forge step's checks, and earlier passes. A failed pass ends with
a **Fix failures** row listing each issue; once the fix agent reports, each shows as resolved or
can't fix.
Full logs stay in the worktree's `.t3/ci/<runId>/` folder, which the board keeps out of git.

## Can't run, Skip CI and turning CI off

When a pass can't run (no worktree, a worker out of reach, no pull request for a forge step), the card
shows **Can't run**; fix what's in the way and press **Retry CI**, or **Skip CI…**, which moves the
card to Ready for merge without a passing run and records the skip under your name.

Retry CI, Send back to review anyway and Skip CI are for people only; agents can't press them.

Turning **Run CI for this project** off asks first when cards are in CI: they move on to Ready for
merge with auto-merge off. Removing every step does not turn CI off: cards already in CI wait until
you add a step and retry, and new cards skip CI.

## Moving cards by hand

Cards enter CI on their own when Code review finishes, and leave it by passing or by Skip CI. You can
move a card into CI yourself only from the stage just before it, and you can't move a card past CI.
You can still move a card out of CI back to an earlier stage.
