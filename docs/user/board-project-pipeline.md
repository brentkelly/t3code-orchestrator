# Per-project pipeline

The board has one list of stages, set in **Settings** → **Board** → **Pipeline**. Each project
follows it, except for the differences you give that project on its own page: **Settings** →
**Board** → the project → **Pipeline**. Only the differences are stored, so a stage added to the
board later reaches every project unless a project switched it off.

## Stage defaults and switches

Every stage has a **default for projects**: on (every project runs it unless it switches it off) or
off (only projects that switch it on run it). Role stages (Planning, Building, Code review, Ready
for merge, Done) and Ready, where approved cards wait for Auto-build, are always on.

On a project's **Pipeline** tab, flip a stage's switch to turn it on or off for that project. It
saves at once. A stage switched against its default reads **On here** or **Off here**.

## Overrides

Expand a stage on the project's Pipeline tab to override its settings for that project: whether it
runs on its own, its prompt, the review loop's rounds, auto-merge, and CI's fix attempts and
round trips. An overridden setting shows the global value beside it, and **Reset to global** clears
it. Setting a value back to the global one clears it too, except a prompt, which stays pinned until
you reset it. **Reset everything to global…** in the page header clears every switch, override and
CI step.

The page header also says how many differences the project has, and who changed it last.

## Stages made for one project

**Add stage** on the Pipeline page can make a stage **for every project** or **for one project**. A
stage for one project is off by default and switched on for that project; other projects can switch
it on later. New stages go just before Continuous integration: nothing can sit between CI and Ready
for merge, since it could change code after CI passed.

Rename, reorder and remove any stage that isn't a role stage on the Pipeline page. A stage can't be
removed while any card, archived included, sits in it.

## On the board

The board shows a column for every stage a project in view uses. In the All projects view, a stage
only some projects use carries a half-filled circle: hover it for who uses it, or click it for the
list, each project linking to its pipeline settings. **Pipelines** shows every project against every
stage.

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

When a project's committed `t3o.json` differs from its pipeline, **Settings** → **Board** offers to
import it. **No thanks** hides the offer until the file changes again. Import and export need the
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
    "steps": [{ "kind": "script", "id": "test", "name": "Test", "command": "bun run test" }]
  }
}
```

A file written for the earlier, read-on-every-change format still imports.

## Permissions

Changing stages, a project's pipeline or its CI needs permission to change settings, because CI
steps are commands the board runs on your machines. Without it, these pages are read-only.
