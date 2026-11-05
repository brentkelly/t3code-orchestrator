# Per-project pipeline (t3o.json)

Every project follows the board's global pipeline, set in **Settings** → **Board** → **Pipeline**.
A project can change its own copy by committing a `t3o.json` at its repository root, so everyone
working on that project gets the same board.

A project's file can:

- **add stages** of its own, placed after any stage except Done and the stage just before
  Building,
- **remove stages** it does not use (stages with a role, such as Planning, Building, Code review,
  Ready for merge and Done, cannot be removed, and neither can Ready, the stage just before
  Building where approved cards wait for Auto-build),
- **override any stage setting** the global pipeline has, such as a prompt, model, timeout or the
  review loop's rounds.

A project can also turn on a **Continuous integration** stage that runs its checks after Code
review; see [Continuous integration](./board-continuous-integration.md).

Stage names cannot be changed per project. Settings layer in order: the built-in defaults, then
**Settings** → **Board**, then the project's `t3o.json`.

```json
{
  "stages": {
    "remove": ["sprint"],
    "add": [
      {
        "id": "security",
        "label": "Security review",
        "after": "review",
        "autoExecute": true,
        "autoAdvance": true,
        "prompt": "Review this card's changes for security problems."
      }
    ],
    "settings": {
      "review": {
        "phases": { "triage": { "prompt": "Run only the tests for the areas you touched." } }
      },
      "building": { "timeoutMs": 3600000 },
      "security": { "timeoutMs": 1200000 }
    }
  }
}
```

`settings` is keyed by stage id: a global stage's id, or the `id` of a stage the file adds. An
entry the board cannot use, such as an unknown stage, a misspelt setting or a role stage in
`remove`, is ignored and the rest of the file still applies.

## Where the board reads it

The board reads `t3o.json` from the board server's own checkout of the project, for every stage,
and picks up a change within about 30 seconds. A branch's edits to the file take effect once the
branch is merged and that checkout has it.

## Seeing what a project changed

**Settings** → **Board** → **Project pipelines** has a row per project. It shows what the file
adds, removes and overrides, each overridden setting beside the global value, any entries the
board ignored and why, and the commit the file was read from. **Open t3o.json** opens the file.

On the board, a column only some projects use names them under its header. In the All projects
view, **Pipelines** shows every project against every stage.

## Removing a stage that still has cards

Cards already in a stage that a project's file removes stay where they are, and the column stays
until they leave. Nothing new can enter it, and cards do not advance into it. Move the cards on and
the column goes.
