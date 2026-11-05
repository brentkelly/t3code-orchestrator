# Continuous integration

A project can have the board run its CI checks on every card after Code review and before Ready for
merge. Each check is a shell command the board runs in the card's worktree. CI is per project: a
project gets the **Continuous integration** column (**CI** on the card) only once its `t3o.json`
lists steps.

## Defining steps

Add the steps under `stages.settings.ci` in the project's `t3o.json`:

```json
{
  "stages": {
    "settings": {
      "ci": {
        "steps": [{ "name": "Check", "command": "cargo xtask check", "timeoutMinutes": 30 }],
        "maxFixAttempts": 2
      }
    }
  }
}
```

Steps run in order and stop at the first failure. A step that runs longer than `timeoutMinutes`
(30 if left out, at most 1440, a day) is stopped and counts as failed. A project can list at most 12 steps; the rest are
ignored. `"enabled": false` pauses CI without deleting the steps. The CI stage itself cannot be
removed or renamed: a project has CI exactly while its file lists steps.

## When a step fails

A fix agent looks at the failure. If it is small and mechanical, such as lint, formatting or a test
the card broke, the agent fixes it on the card's branch and every step runs again from the top.
Otherwise the card goes back to Code review with the failure as a must-fix finding, and a fresh
review round starts. If the card had already used all its review rounds, it gets one more.

`maxFixAttempts` caps how many fix agents one visit to CI may start (2 by default; 0 sends every
failure straight back). The default for every project, along with the fix agent's prompt and model,
is in **Settings** → **Board** → **Pipeline** → **Continuous integration**.

## Following a run

The card's **CI** tab shows each step, its command and how long it took, the last 200 lines of a
failed step's output, the fix agent at work, and earlier passes. Full logs stay in the worktree's
`.t3/ci/<runId>/` folder, which the board adds to the repository's `.git/info/exclude` so git
never sees it.

## Skip CI

**Skip CI…** on the CI tab stops the run and moves the card to Ready for merge without a passing
run. The skip is recorded on the card under your name.

## Moving cards by hand

Cards enter CI on their own when Code review finishes, and leave it by passing or by Skip CI. When
review stops short and holds a card, you can move it on into CI yourself, but only from the stage
just before CI, and you cannot move a card past CI. You can still move a card out of CI back to an
earlier stage.
