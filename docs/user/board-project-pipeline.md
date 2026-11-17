# Per-project pipeline

The board has one list of stages, set in **Settings** → **Board** → **Pipeline**. Each project
follows it, except for the differences you give that project on its own page: **Settings** →
**Board** → **Projects** → the project → **Pipeline**. Only the differences are stored, so a stage added to the
board later reaches every project unless a project switched it off.

## Stage defaults and switches

Every stage has a **default for projects**: on (every project runs it unless it switches it off) or
off (only projects that switch it on run it). Role stages (Planning, Building, Code review, Ready
for merge, Done) and Ready, where approved cards wait for Auto-build, are always on.

On a project's **Pipeline** tab, flip a stage's switch to turn it on or off for that project. It
saves at once. A stage switched against its default reads **On here** or **Off here**.

## Overrides

Expand a stage on the project's Pipeline tab to override its settings for that project: whether it
runs on its own, its prompt, the review loop's rounds and auto-merge. CI's fix attempts, round
trips and fix prompt are on the project's **CI** tab, under **Fix agent**. An overridden setting shows the global value beside it, and **Reset to global** clears
it. Setting a value back to the global one clears it too, except a prompt, which stays pinned until
you reset it. **Reset everything to global…** in the page header clears every switch, override and
CI step.

The page header also says how many differences the project has, and who changed it last.

## Stages made for one project

**Add stage** in the Pipeline section can make a stage **for every project** or **for one project**. A
stage for one project is off by default and switched on for that project; other projects can switch
it on later. New stages go just before Continuous integration: nothing can sit between CI and Ready
for merge, since it could change code after CI passed.

Rename, reorder and remove any stage that isn't a role stage in the Pipeline section. A stage can't be
removed while any card, archived included, sits in it.

## On the board

The board shows a column for every stage a project in view uses. In the All projects view, a stage
only some projects use carries a half-filled circle: hover it for who uses it, or click it for the
list, each project linking to its pipeline settings.

A stage switched off for a project while its cards sit in it stays, as a dashed **Off** column, until
they move on. Nothing new enters it, and cards skip it when they advance.

## Importing and exporting t3o.json

A project's pipeline can travel with its repository as a `t3o.json` at the repository root, but the
board never reads it on its own. On the project's **Import & export** tab:

- **Import…** reads the `t3o.json` committed on the default branch and replaces the project's
  differences with it. The confirmation lists what changes, any entries the board ignored, the
  stages it creates, and the full text of every command and prompt it would install. Read those
  before importing a file someone else committed.
- **Export** writes the project's differences to `t3o.json` in its checkout, uncommitted. Commit and
  push it yourself. If the checkout's `t3o.json` already has uncommitted edits, Export downloads the
  file instead of overwriting them.

When a project's committed `t3o.json` differs from its pipeline, **Settings** → **Board** →
**Projects** offers to import it. **No thanks** hides the offer until the file changes again. Import and export need the
project's checkout on the board's own server.

```json
{
  "version": 2,
  "stages": {
    "remove": ["sprint"],
    "add": [
      { "id": "security", "label": "Security review", "after": "review", "autoExecute": true }
    ],
    "settings": { "review": { "rounds": 3 } }
  },
  "ci": {
    "enabled": true,
    "stopOnFailure": false,
    "steps": [{ "kind": "script", "id": "test", "name": "Test", "command": "bun run test" }]
  }
}
```

A file written for the earlier, read-on-every-change format still imports.

### Schedules

A `t3o.json` can also declare recurring runs. Each entry needs an `id` (letters, digits, `-` or
`_`), a `title`, a `schedule`, a `prompt`, and optionally `enabled` (default `true`):

```json
{
  "version": 2,
  "schedules": [
    {
      "id": "nightly-tests",
      "title": "Nightly full test run",
      "schedule": { "type": "fixed_time", "timeOfDay": "02:00", "weekdays": [1, 2, 3, 4, 5] },
      "prompt": "Run the full test suite. File one card for anything that fails."
    },
    {
      "id": "flaky-sweep",
      "title": "Flaky test sweep",
      "schedule": { "type": "interval", "everyMs": 21600000 },
      "enabled": false,
      "prompt": "Rerun the tests marked flaky and report which still fail."
    }
  ]
}
```

- **The machine is picked at import, never written to the file.** Each schedule in the import
  dialog has a **Run on** picker that starts on **Don't schedule**; nothing runs until you pick a
  machine. Whoever imports the file picks their own. Change it later on the project's **Schedules**
  tab, which also has **Run now** and **Unschedule**.
- **Every run is a new thread in a fresh worktree** off the default branch on origin, and the
  project's setup script runs first. Write prompts with paths relative to that worktree. Runs are
  unattended, with full access to the machine; read a schedule's prompt in the import dialog before
  you pick a machine for it.
- **Old runs are cleaned up.** Each schedule keeps its newest three runs, every run from the last
  seven days up to its newest twenty, and any run still working or waiting on you. Older settled
  runs lose their thread, worktree and branch; a run that filed or changed a card keeps its thread.
- **`fixed_time` follows the board server's clock**, whatever machine runs it.
- **A run's board tools are limited to its project.** It can file cards there, and arm, move (up to
  Planning) or update only the cards that schedule's runs created. It can never turn Auto-merge on, though
  on a board with Auto-merge on for every card, the cards it files follow that setting.
- **Import never moves or stops a schedule whose definition didn't change.** Use the Schedules tab
  for that. An import that changes a schedule, or removes it from the file, shows what stops running
  before you confirm. Leaving the `schedules` key out leaves the board's schedules alone; an empty
  list removes them all.
- **Hand edits are overwritten by the next import** that changes that schedule. Tasks a file manages
  are marked **From t3o.json** on the **Scheduled tasks** page; you can edit or pause them there,
  but to change one for good, edit `t3o.json`, commit and import.
- **A hand-made scheduled task with the same title is adopted** instead of a second one being made.
  **Export** brings the project's hand-made interval and time-of-day tasks into the file. They
  keep running as hand-made tasks until you import the file and pick where each one runs; after
  that the file manages them. **Export again without them** takes out the ones not yet imported.
- `once` and webhook schedules can't be declared in the file.

## Permissions

Changing stages, a project's pipeline or its CI needs permission to change settings, because CI
steps are commands the board runs on your machines. Without it, these pages are read-only.
