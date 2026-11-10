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
  `echo '::t3o-progress::{"message":"Running unit tests","done":128,"total":212}'`. The step shows
  the latest message, count and bar, and the card shows the count instead of a timer. Any field can
  be left out.
- print a failure line saying what failed and why, which becomes the step's headline:
  `echo '::t3o-failure::{"step":"lint","reason":"No files matched src/**"}'`. `step` (the sub-step)
  and `machine` are optional; the first failure line a step prints is the one used.
- write a result file at `$T3O_CI_RESULT` before it exits, with a summary and failures the CI tab
  and the fix agent show. Mark a failure `"machine": true` when the machine, not the code, is to
  blame (a missing browser library, say):

```sh
cat > "$T3O_CI_RESULT" <<'JSON'
{ "summary": "3 of 212 tests failed",
  "failures": [{ "title": "slow_consumer_drops_oldest", "detail": "dropped frames",
                 "file": "src/fanout.rs", "line": 311 }] }
JSON
```

The result file adds detail only; it never turns a failing exit code into a pass, or the reverse.

## When a step fails

A failed step gets a headline at the top of the CI tab and on the card: what failed (the step, or
"step → sub-step") and why, with **Show in log** opening the log at that line. The reason is, in
order: the script's `::t3o-failure::` line or a result-file failure marked `machine`, a machine
problem in the output, the result file's first failure, a tool that stopped outright (such as "No
files matching the pattern" or "Cannot find module"), the first error line near the end of the
output, the last line of output, and finally the exit code or time limit. Only the failed step's own
output is read.

**Machine problems** are held for you instead of being handed to a fix agent: a missing system
library, no space left on the disk, a read-only filesystem, a command that isn't installed (exit
127), and a step the system killed: "Killed" or "Out of memory" in its output, exit 137 or SIGKILL,
and no time limit reached. The card shows **Machine problem** in amber, naming the machine and what
to fix there. No fix attempt is used:
fix the machine, then press **Retry CI**. A script's own `machine` flag always wins: `false` keeps a
failure with the code even when its output looks like a machine problem.

Any other failure goes to a fix agent. It gets every failure the pass reported, each told what failed
and why first, as a numbered list of issues, and fixes them on the card's branch. Then every step
runs again from the top. CI never sends a card back to Code review by itself.

**Fix attempts** caps the fix agents one visit to CI may start (3 by default). When they run out, or
the fix agent reports something it can't fix, CI stops and the card waits for you, marked **Needs
you** with the reason: **Retry CI** starts over with fresh attempts, **Send back to review anyway**
sends the card to Code review with every failure as a must-fix finding, and **Skip CI…** moves it
on. Defaults are in **Settings** → **Board** → **Pipeline** → **Continuous integration**; each
project can override them on its **CI** tab, under **Fix agent**.

## Following a run

The card's **CI** tab shows each step, how long it took, a failed step's output and reported
failures, an agent step's thread, a forge step's checks, the fix agent at work, and earlier passes.
A failed pass ends with a **Fix failures** row listing each issue; once the fix agent reports, each
shows as resolved or can't fix.

- A running script shows its time against its limit, such as "Running 12 / 60 min", and its progress
  if it prints any. The card catches up about every 10 seconds, and a failed step keeps the last
  progress it reported, so you can see where it stopped.
- A running script that has printed nothing for 10 minutes shows "No output for N min". It's only a
  warning: the step keeps running until it finishes or reaches its limit.
- **View live log** on a running script, or **View log** on a finished one in any pass, opens its
  output. A running step's log follows new output; scroll up to pause, and **jump to latest** to
  follow again. Colours are kept. **Copy** copies what's shown, and **Download** saves the whole
  log. The viewer holds the last 2 MB or so of a long log; Download always has all of it. This
  works the same for a card on a worker.
- Each pass's log folder, `.t3/ci/<runId>/` in the card's worktree, is shown under the pass with a
  copy button, for opening in a terminal. The board keeps it out of git. When the worktree is
  removed, its logs go with it, and the viewer says the log is no longer available.

## Can't run, Stop CI, Skip CI and turning CI off

When a pass can't run, the card shows **Can't run** with the reason: no worktree, a worker out of
reach or whose connection closed mid-run, no pull request for a forge step, or a CI script that
stopped without its result being saved. The board notices a pass with nothing left running within
about a minute, so a crashed or killed script never leaves a card stuck on running. Fix what's in the
way and press **Retry CI**, or **Skip CI…**, which moves the card to Ready for merge without a
passing run and records the skip under your name.

Before a pass runs, the board checks that the disk holding the card's worktree, and the disk holding
the T3 Code data on the server running the board, each have at least 2 GiB free. If not, the card
shows **Machine problem** with the free space on that machine, and no fix agent starts: free some
space, then press **Retry CI**.

**Stop CI**, in the CI tab's header while a pass is queued, running or being fixed, stops it: running
steps and any CI agent are stopped, and the card waits with "Stopped by you" until you press Retry
CI.

Retry CI, Stop CI, Send back to review anyway and Skip CI are for people only; agents can't press
them.

Turning **Run CI for this project** off asks first when cards are in CI: they move on to Ready for
merge with auto-merge off. Removing every step does not turn CI off: cards already in CI wait until
you add a step and retry, and new cards skip CI.

## Moving cards by hand

Cards enter CI on their own when Code review finishes, and leave it by passing or by Skip CI. You can
move a card into CI yourself only from the stage just before it, and you can't move a card past CI.
You can still move a card out of CI back to an earlier stage.
