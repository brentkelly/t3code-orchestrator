---
id: t3o-35
title: Worktree remove hook — stop a worktree's processes before removal, and let the project save its caches
phase: 3
prerequisites: []
---

# Worktree remove hook

Two gaps in how t3o removes a worktree, fixed together because the second needs the first.

1. **t3o deletes worktrees with things still running in them.** The normal reclaim
   (`reclaimCardWorktree`, `supervisorReactor.ts:4695`) checks that the card's step has finished
   (`cardStillFinished`, `:4664`) and that the work is durable, then calls `git worktree remove`.
   It never closes the card's terminals, stops its provider sessions, or checks for processes. A
   dev server, a background test run or a container outlives the step and keeps writing into a
   deleted directory. Forced removals (`forceRemoveBoardCardWorktree`, `board/worktree.ts:514`)
   check nothing at all. The one path that gets this right is bootstrap cancel (`ws.ts:1666`): it
   closes the setup terminal first so a running script "cannot hold files open in the worktree
   while git removes it", then retries the remove.

   You can see the result on disk today: `~/.t3/worktrees/z5/board-z5-37`, `-77` and `-95` are
   root-owned `docker/` directories that a bind-mounted container recreated after their worktrees
   were removed. Stopping t3o's own processes does not prevent that on its own: a container's
   processes run as root in their own namespace, so the process check cannot see them. Stopping
   containers started from the worktree is the project's `runOnWorktreeRemove` script's job.

2. **A project can't save anything from a worktree before t3o deletes it.** `t3.json` has
   `runOnWorktreeCreate` but no counterpart for removal, and git has no worktree-removal hook. On
   z5 (Rust, 472 crates) every new worktree therefore starts with a cold build: ~1,750
   CPU-seconds and ~5 GB. A finished card's build output would make the next card's start almost
   free if the project could move it aside first.

## Goal

Before any t3o-initiated removal, the worktree is stopped (nothing runs in it), then the project's
`runOnWorktreeRemove` scripts run, then git removes it. t3o adds no cache logic. What a project
saves, and how a new worktree picks it up, lives in the project's own scripts (see the
**Appendix** for z5's).

## Scope

**In**

1. One "retire worktree" step (stop, then hook, then remove) used by every t3o-initiated
   removal.
2. A `runOnWorktreeRemove` flag on project scripts, end to end: the contracts, the web import and
   editor, and the server.
3. Card-facing reporting when a reclaim is held back because something is still running.

**Out**

- **Any change to the reclaim decision** (`boardCardWorktreeReclaimDecision`) or the "Reclaim
  worktrees at Done" setting. Worktrees are removed exactly when they are today; they're just
  retired properly first.
- **Worktree reuse or pooling.** An earlier draft of t3o-35 parked worktrees for reuse. Dropped:
  a fresh worktree per card means nothing leaks between cards, and the caching benefit is
  available to projects through the hook.
- **Cache management of any kind in t3o.**

## Background: why caches move in and out, rather than being shared

Projects might be tempted to point every worktree at one shared build directory instead. For Cargo,
and any tool that judges freshness by file mtime, that is **unsafe**. Cargo identifies a workspace
crate by its path **relative to the workspace root**, so `crates/domain` in two worktrees is the
same unit. If B built more recently than A's files last changed, A silently links B's code. Tested
and reproduced on Cargo 1.98 with both a shared `target-dir` and a shared `build-dir`.

Moving a whole cache into a **freshly checked-out** worktree is safe, because every source file
there is newer than the cache. This hook is what lets projects do that.

## Retire step

A new `retireWorktree(input)` in `board/worktree.ts` (or a small service beside it). Input fields:

- `projectCwd`
- `worktreePath`
- `kind`: `"reclaim"` or `"forced"`
- `verifiedClean`: `boolean`; true only when the reclaim decision just checked that the tree is
  clean and its work durable

Steps, in order:

1. **Stop t3o's own processes.** For every thread whose `worktreePath` is this worktree, close all
   of its terminals and stop its provider session. Reuse the pattern at `ws.ts:1666`: closing
   kills processes asynchronously, so poll briefly before treating them as gone.
2. **Check nothing else is still running there.**
   - **Linux:** any process whose `/proc/<pid>/cwd` resolves inside the worktree.
   - **macOS:** `lsof +D` (slower but acceptable at this frequency).
   - **Windows:** skip; the OS already refuses to delete open files.

   What happens with survivors depends on `kind`:
   - **`reclaim`:** don't remove. Return `{ outcome: "blocked", reason }`, with a reason such as
     `cargo (pid 4412) is still running in the worktree`. This flows through the existing kept
     path, so the card shows the amber "Worktree kept" flag with that reason. The next reclaim
     trigger, or "Check again", retries.
   - **`forced`:** a person confirmed the removal at a dialog. SIGTERM, wait about 5 seconds,
     SIGKILL, re-check, continue.

3. **Run the project's `runOnWorktreeRemove` scripts** (see **Hook contract**).
4. **`git worktree remove`** as each caller does today: `force` for forced removals, no `force`
   for reclaim.

Steps 1 and 2 must come before step 3. A project script that moves a cache out of the worktree must
be able to rely on nothing still writing into it.

### Call sites

| Call site                                                                  | `kind`    | Notes                                                                                    |
| -------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------- |
| `reclaimBoardCardWorktree` (`board/worktree.ts:503`)                       | `reclaim` | After the decision is safe and `stillWanted` passes. `verifiedClean: true`.              |
| `reclaimBoardCardWorktree` "already gone" branch (`board/worktree.ts:494`) | —         | No directory, nothing to stop or save. Unchanged.                                        |
| `forceRemoveBoardCardWorktree` (`supervisorReactor.ts:5192`, `:7383`)      | `forced`  | Card delete and the card's "Remove worktree" action.                                     |
| Orphan sweep (`supervisorReactor.ts:4992`, via `reclaimBoardCardWorktree`) | `reclaim` | Covered by the first row.                                                                |
| `WS_METHODS.vcsRemoveWorktree` (`ws.ts:3317`)                              | `forced`  | Thread-level removal from the UI. `verifiedClean: false`.                                |
| Bootstrap cancel (`ws.ts:1666`)                                            | —         | Already stops its terminal. Skip the hook: the setup never finished, so nothing to save. |

Run `stillWanted` again **after** steps 1–3 and before step 4. Stopping processes and running the
hook can take long enough for a person to drag the card back out of Done. If the card is wanted
again, return `null` as the existing abandoned path does, and leave the worktree in place: its
build caches may now have been moved out, which only costs a rebuild.

## Hook contract

### Where scripts come from

**The server never reads `t3.json` for scripts.** It reads the **project record** (or the script
overrides in settings) through `resolveProjectScripts` (`packages/shared/src/projectScripts.ts:17`),
as `ProjectSetupScriptRunner` does (`ProjectSetupScriptRunner.ts:334`). `t3.json` is only an
import source. The project's actions menu (`ProjectScriptsControl.tsx:110`) and Settings →
Project actions (`ProjectActionsSettings.tsx:108`) list its scripts that haven't been imported and
copy one into the project record when the user picks it.

Both import paths and the editor build a script **one field at a time**. A field they don't name
is dropped on import, and dropped again whenever the script is edited in Settings. So the flag has
to be threaded through each layer:

1. **`t3.json` schema** (`packages/contracts/src/t3ProjectFile.ts:39`), next to
   `runOnWorktreeCreate`:

   ```ts
   runOnWorktreeRemove: Schema.optionalKey(
     Schema.Boolean.annotate({
       description:
         "When true, the script runs in a worktree just before T3 Code removes it, after every process in it has been stopped. Removal waits for the script (up to 5 minutes).",
     }),
   ),
   ```

   Update the `async` field's description to say it applies to `runOnWorktreeCreate` only.

2. **Stored script** (`ProjectScript`, `packages/contracts/src/orchestration.ts:416`):
   `runOnWorktreeRemove: Schema.optional(Schema.Boolean)`. It must be **optional**, because every
   stored project record and settings override was written without it.
3. **Import:** copy `fileScript.runOnWorktreeRemove ?? false` in both `importFileScript` functions
   (`ProjectScriptsControl.tsx:110`, `ProjectActionsSettings.tsx:108`).
4. **Editor round trip:**
   - add the field to `ProjectScriptInput` and `buildProjectScript`
     (`apps/web/src/projectScripts.ts:10`, `:20`)
   - add it to the editor's form state and initial values (`projectScriptEditor.tsx:87`, `:103`,
     `:128`)
   - add a checkbox, "Run before the worktree is removed", beside the existing worktree-create
     option
5. **Not the default action:** the "regular" script pick (`apps/web/src/projectScripts.ts:90`)
   already skips setup scripts. Skip remove scripts too, so one is never the project's main run
   button. In the script menu, label them `(teardown)` the way setup scripts get `(setup)`
   (`ProjectScriptsControl.tsx:207`).
6. **Server:** the retire step finds its scripts with
   `resolveProjectScripts(settings, project).filter((s) => s.runOnWorktreeRemove === true)`.

**Projects must import the script.** Adding the flag to `t3.json` changes nothing until someone
imports that script, and later edits to `t3.json` aren't picked up automatically. Say so in the
user docs next to `runOnWorktreeCreate`.

| Aspect      | Contract                                                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source      | `resolveProjectScripts`, filtered to `runOnWorktreeRemove` (see above). Never `t3.json` directly.                                                                                                                                           |
| Working dir | The worktree being removed.                                                                                                                                                                                                                 |
| Environment | `T3_WORKTREE_PATH`, `T3_PROJECT_ROOT`, `T3_REMOVAL` (`reclaim` or `forced`), `T3_WORKTREE_VERIFIED_CLEAN` (`1` or `0`).                                                                                                                     |
| Runs as     | A plain child process, not a terminal. The orphan sweep and forced removals may have no live thread to own a terminal. Output goes to the server log, prefixed with the worktree path.                                                      |
| Blocking    | Removal waits for it. Several scripts run in order.                                                                                                                                                                                         |
| Timeout     | 5 minutes, then the process group is killed.                                                                                                                                                                                                |
| Failure     | Non-zero exit or timeout is logged with a warning and **does not stop the removal**. The hook exists to save things, and it must never be able to wedge a card in Done. Show a failure on the card's activity rail when a card is involved. |

## Tests

- **Order:** terminals are closed and sessions stopped before the process check; the hook runs
  after the check; removal comes last.
- **Reclaim with a survivor:** a process left in the worktree turns into `blocked` with a reason
  naming it, the worktree stays, and "Check again" retries.
- **Forced with a survivor:** the process is killed and the removal completes.
- **Hook contract:** it runs with the right working directory and environment;
  `T3_WORKTREE_VERIFIED_CLEAN` is `1` only on the reclaim path.
- **Hook failures:**
  - a failing hook still removes the worktree, logs a warning, and shows a rail entry
  - a hook that hangs is killed at the timeout and the removal proceeds
- **Card wanted again:** a card dragged out of Done while the hook runs keeps its worktree.
- **No hook configured:** behaviour is identical to today, apart from the new stop step.
- **Flag survives import and editing:**
  - importing a `t3.json` script with `runOnWorktreeRemove: true` from either import path stores
    the flag
  - opening that script in the editor and saving it unchanged keeps the flag
  - a stored script without the field still decodes
- **Not the default action:** a project whose first script is a remove script doesn't get it as
  its main run button.

---

## Appendix: z5's side (reference, not part of this spec)

How z5 would use the hook to carry build caches between worktrees. Lives in the z5 repo and on the
machine, not in t3o. Untested sketches.

### Layout

`~/.t3/worktree-cache/z5/` must be on the same filesystem as the worktrees, so moves are instant
renames. It holds one folder per saved cache, named `<YYYYmmddTHHMMSS>-<random>`; `ls` sorts them
oldest first. A rename is the lock: a claimer that loses the race gets `ENOENT` and tries the next
folder. Transient suffixes:

| Suffix           | Meaning                            |
| ---------------- | ---------------------------------- |
| `.partial`       | being written; ignored by claimers |
| `.claimed-<pid>` | being emptied by a create script   |
| `.deleting`      | being removed                      |

### Remove script (`runOnWorktreeRemove`)

```sh
#!/usr/bin/env bash
# Park this worktree's build caches for the next new worktree.
set -uo pipefail
cache="$HOME/.t3/worktree-cache/z5"; keep=(target node_modules); max=5
mkdir -p "$cache"
# Scratch output inside kept directories must not reach the next branch.
rm -rf target/tmp target/nextest target/sqlx/sqlx-tmp
name="$(date +%Y%m%dT%H%M%S)-$(tr -dc a-z0-9 </dev/urandom | head -c8)"
mkdir "$cache/$name.partial"
for k in "${keep[@]}"; do [[ -e $k ]] && mv "$k" "$cache/$name.partial/"; done
mv "$cache/$name.partial" "$cache/$name"   # publish last
# Keep at most $max caches; drop the oldest.
ls -1 "$cache" | grep -E '^[0-9]{8}T[0-9]{6}-[a-z0-9]+$' | sort | head -n -"$max" |
  while read -r d; do mv "$cache/$d" "$cache/$d.deleting" 2>/dev/null && rm -rf "$cache/$d.deleting"; done
```

z5 doesn't need to drop databases here. `cargo xtask db up` already prunes the databases of
worktrees whose directory is gone (`xtask/src/db/prune.rs`).

### Create script (`runOnWorktreeCreate`, with `"async": false`)

`async` must be false. Otherwise the agent may start a cold build before the cache is moved in.

**Both scripts must be imported into the z5 project record**, from the actions menu or Settings →
Project actions. `async: false` arrives on import as "Wait for setup". As of 2026-10-20, z5's
project record has no scripts at all, so the existing "Setup Worktree" script in `t3.json` has
never run. Agents run `cargo xtask db up` themselves, following z5's `AGENTS.md`.

```sh
#!/usr/bin/env bash
set -uo pipefail
cache="$HOME/.t3/worktree-cache/z5"; nightly="$HOME/.local/state/nightly-check"
if [[ ! -e target ]]; then
  for d in $(ls -1 "$cache" 2>/dev/null | grep -E '^[0-9]{8}T[0-9]{6}-[a-z0-9]+$' | sort -r); do
    claim="$cache/$d.claimed-$$"
    mv "$cache/$d" "$claim" 2>/dev/null || continue   # lost the race: try the next
    for k in "$claim"/* ; do mv "$k" ./; done
    rm -rf "$claim"; break
  done
fi
if [[ ! -e target && -d $nightly/checkout/target ]]; then
  # The nightly job holds run.lock for its whole run; don't wait for it.
  flock -w 10 "$nightly/run.lock" cp -a "$nightly/checkout/target" target || echo "nightly build busy: starting cold"
fi
# Make every source file newer than anything moved in, so Cargo can never trust an artifact
# that was built from different code. (A cache claimed seconds after a late build in the old
# worktree could otherwise look newer than this checkout.) Costs nothing extra: a fresh checkout
# already rebuilds every workspace crate.
git ls-files -z | xargs -0 touch -h
pnpm install --frozen-lockfile
cargo xtask db up
```

### Nightly cleanup (in `~/.local/bin/nightly-check`)

Once the nightly build of a **new** commit has compiled, it's newer than every cache made before
the run started, so those caches are dropped:

- **Record the start time** at the top of the script: `run_started=$(date +%Y%m%dT%H%M%S)`.
- **Skip the cleanup** on nights that stop early because `main` hasn't moved. Yesterday's caches
  are then newer than the nightly build.
- **Run it after the compile succeeds, even if tests fail.** The build is still good.

```sh
cache="$HOME/.t3/worktree-cache/z5"
for d in "$cache"/*; do
  n=$(basename "$d")
  [[ $n == *.claimed-* ]] && [[ -n $(find "$d" -maxdepth 0 -mmin -60) ]] && continue  # in use right now
  [[ ${n:0:15} < $run_started ]] || continue   # created during this run: keep
  mv "$d" "$d.deleting" 2>/dev/null && rm -rf "$d.deleting"
done
```

Result: while you're working, new worktrees take a cache that's minutes or hours old. Each night,
caches older than the new nightly build are dropped. If you stop working on the project, only
the nightly checkout is left.

### Optional later: rebuild only what changed

As written, the `touch` makes every workspace crate rebuild on each new worktree: about 530
CPU-seconds on z5, against ~1,750 cold. To rebuild only crates whose files actually changed:

1. **Remove script**, only when `T3_WORKTREE_VERIFIED_CLEAN=1`: also save `git rev-parse HEAD` and
   every tracked file's mtime into the cache.
2. **Create script:** for files that `git diff --name-only <saved commit> HEAD` does **not** list,
   restore the saved mtime instead of touching them.

Unchanged files then carry the same timestamps Cargo judged the old build against, so Cargo makes
the same decision a `git switch` in the old worktree would. This is untested. Prove it with the
same two-folder wrong-code test as the background section before relying on it.
