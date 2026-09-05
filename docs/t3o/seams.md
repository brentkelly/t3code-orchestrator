# T3o seams

T3o is a fork of [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code). It adds a Board mode that
supervises agent threads (see `.plans/t3o-00-overview.md` for the locked architecture).

A fork lives or dies on the cost of the next upstream merge. This document is the contract that keeps
that cost near zero: how we mark the places we touch upstream code, how we sync, and what we
deliberately turned off.

Everything here is **convention plus a hand-maintained inventory**. There is no CI enforcement during
MVP — see [Why no automation yet](#why-no-automation-yet).

---

## Branch topology

| Branch | Role                                                                           |
| ------ | ------------------------------------------------------------------------------ |
| `main` | Pristine **fast-forward-only mirror** of `upstream/main`. Never commit to it.  |
| `t3o`  | The trunk and the repo default branch. All work lands here; all PRs target it. |

`main` exists for exactly one reason: to be conflict-free so a sync can fast-forward. A single commit
on it breaks that permanently. `t3o` is the default branch specifically so nothing lands on the
mirror by accident.

Upstream is **merged, never rebased**, into `t3o`. The branch is long-lived and has real PR history;
rebasing it would rewrite published commits.

---

## The `T3o:` marker convention

**Every insertion into an upstream-owned file is preceded by a `T3o:` marker comment naming the
reason.**

The marker is exactly `T3o:` — capital `T`, digit `3`, **lowercase `o`**. Lowercase is deliberate:
`T3O` reads as `T30`. Grep is the whole point, so the token has to be unambiguous and never a
homoglyph for a version number.

Per file type:

```ts
// T3o: register the board toolkit alongside the stock toolkits.
```

```tsx
{
  /* T3o: Board tab, next to Threads. */
}
```

```html
<!-- T3o: fork status and branch topology. -->
```

```sql
-- T3o: board card projection.
```

Then the whole fork surface is one command:

```bash
rg -n "T3o:"
```

### Keep seams one line

**Anything larger than a few lines does not go inline.** It goes in a T3o-owned module, and the seam
in the upstream file becomes a single delegating call.

```ts
// T3o: board commands join the orchestration dispatcher.
...decideBoardCommand(input),
```

Not:

```ts
// T3o: board commands
if (command.type === "board.moveCard") {
  // ...thirty lines of board logic in an upstream file...
}
```

The reasoning is mechanical, not aesthetic. A one-line append inside an array or an object literal
conflicts only when upstream edits that exact line; git resolves everything around it. A thirty-line
block sitting in the middle of a function upstream is actively developing conflicts on almost every
merge, and each conflict has to be _understood_ rather than re-applied.

Corollaries:

- **New files never conflict.** Reach for a new file before editing an existing one.
- **Prefer appending to editing.** Adding an entry to a list is cheaper than changing one.
- **Never reformat or reorder upstream code** while adding a seam. A drive-by import sort turns a
  one-line conflict into a whole-file one.
- **One seam, one reason.** If the marker comment needs an "and", it is probably two seams or it
  belongs in our module.

### Seam grammar (since `t3o-02a`)

A core seam may contain **only** one of these four shapes:

1. **A predicate delegation** — `if (isBoardCommand(command)) return decideBoardCommand(...)`,
   placed inside upstream's existing `default` branch _before_ its `satisfies never` (so upstream's
   exhaustiveness checks keep firing on upstream additions) or before its permissive fallback.
2. **A spread of a board-owned registry** — `...BOARD_CLIENT_COMMANDS,`,
   `...BOARD_PROJECTOR_NAMES,` etc., appended at a list/record tail. (Database migrations are the
   exception — see the note below; they are no longer a seam in `Migrations.ts`.)
3. **A single injected factory call** — `...makeBoardOrchestrationEvents(EventBaseFields),` (the
   base fields are injected because `board.ts` importing them back would be a module cycle).
4. **A re-export** — `export * from "./board.ts"`.

> **Database migrations are a separate lineage, not a seam.** Board migrations were originally
> spread (`...BOARD_MIGRATIONS`) into upstream's `migrationEntries` and numbered from 900 to dodge
> id collisions. That is a trap: effect's `Migrator` advances a single high-water mark per ledger
> table and skips any id `<=` it, so once a `900` migration ran, every later upstream migration
> (all `< 900`) was silently skipped. Board migrations now live in their own directory
> (`apps/server/src/board/migrations/`, ids restart at **1**) and run against their own ledger
> table `t3o_sql_migrations` via `runBoardMigrations()`. The two lineages have independent
> high-water marks, so `Migrations.ts` is now pure upstream and no longer conflicts when upstream
> appends a migration. `persistence/Layers/Sqlite.ts` boots them in order:
> `reconcileLegacyBoardLedger()` → `runMigrations()` (upstream) → `runBoardMigrations()` (board).
> Reconciliation runs **before** upstream migrations — otherwise a database still pinned at the
> legacy `910` high-water mark would skip pending upstream migrations on its first boot. It maps
> each recorded legacy `900+` id back to its new id, seeds exactly those into `t3o_sql_migrations`
> as already-applied, then evicts the legacy rows: seeding only what actually ran leaves a
> partially-migrated database's pending migrations for the board Migrator, and not replaying
> applied migrations protects the one-time data backfill (007) from resurrecting user-removed seed
> labels. To add a board migration: drop `NNN_Name.ts` in `board/migrations/` and append it to
> `BOARD_MIGRATIONS` in that dir's `index.ts`.

Plus the frozen once-only edits recorded in the inventory (D9 aggregate-id union widenings, the two
optional snapshot fields). Everything else — registries, factories, type guards, reducers, SQL —
lives in board-owned files (`packages/contracts/src/board.ts`, `apps/server/src/board/*`,
`packages/client-runtime/src/state/board.ts`). The consequence, and the test of this grammar:
**adding a board command, event, projector, or migration touches zero upstream-owned files.**

### The `board.` prefix rule

The predicates that make generic seams possible key on naming:

- Every board command `type` starts with **`board.`** —
  `BoardCommand = Extract<OrchestrationCommand, { type: `board.${string}` }>`.
- Every board event `type` starts with **`board.`**.
- Every board shell-stream delta `kind` starts with **`card-`** or **`label-`**. Originally
  `card-` only; **`t3o-06a` added the label catalogue delta (`label-upserted`)** — the non-card
  board delta the original rule flagged ("revisit if non-card board deltas ever appear"). The delta
  is _about a label, not a card_, so it takes the honest `label-` prefix, and
  `isBoardShellStreamEvent` was widened to `startsWith("card-") || startsWith("label-")`. A future
  board delta about neither adds its own prefix here and to that predicate — both are board-owned
  (`board.ts`), so this stays a zero-core-line change.

`isBoardCommand` / `isBoardEvent` / `isBoardShellStreamEvent` are type guards exported from
`packages/contracts/src/board.ts` (server and clients both need them), implemented as
`type.startsWith("board.")` etc. The convention is self-policing: a board command named without the
prefix falls outside the `Extract`, reaches upstream's `satisfies never`, and fails the build.

### Rules that ride alongside

- **Board migrations are a separate lineage in `board/migrations/`, numbered from `1`.** They run
  against their own ledger table `t3o_sql_migrations`, never sharing upstream's `effect_sql_migrations`
  high-water mark. See the migration note under [Seam grammar](#seam-grammar-since-t3o-02a) — sharing
  one ledger (the old `900_` scheme) silently skipped every lower-numbered upstream migration.
- **Workspace packages keep their `@t3tools/*` names.** They are `private: true` and resolved through
  `workspace:*`, so nothing is fetched from NPM and renaming would touch every import for zero gain.
- **Branding is a single seam.** `apps/web/src/branding.ts` (`APP_BASE_NAME`, `APP_DISPLAY_NAME`,
  `APP_STAGE_LABEL`) is the only place a product name belongs. Do not scatter naming elsewhere.
- **The board reads upstream's startup ORDER through `ServerActivation`, never by position.** The
  supervisor is started in the `reactors.start` phase, one phase before upstream's
  `provider-sessions.reconcile` marks a session orphaned by a restart `error`. Its boot reconcile
  therefore waits on the `ServerActivation` boundary before reading any thread shell, because a
  shell read earlier still shows the killed turn as active and a dead step reads alive
  (`supervisorReactor.ts`, t3o-10 D3). Do not "simplify" that wait into moving our start line below
  upstream's phase: it would make our correctness a property of upstream's phase ordering, which a
  sync can reshuffle with no test that could catch it.

---

## Upstream sync runbook

Manual and on demand. **Run it when there is a reason to** — a fix you want, or before starting a
spec that touches a file upstream has been churning. Not on a calendar.

```bash
git fetch upstream

git checkout main
git merge --ff-only vX.Y.Z          # a release tag, not upstream/main — never force;
                                    # a failure means someone committed to the mirror

git checkout -b sync/upstream-vX.Y.Z t3o
git merge main
git checkout --ours -- .plans && git add .plans   # upstream deletes its own plans; we archive ours
```

Then, before pushing:

```bash
rg -n "T3o:"          # eyeball against the seam inventory below
```

and run the normal checks for whatever the merge touched. Two things the root scripts hide
(learned on the `v0.0.38` sync):

- `vp run -r typecheck` stops early on this box (mobile is OOM-killed at the default concurrency
  and `t3`/desktop never run). Typecheck **per package**: `pnpm exec tsgo --noEmit` in
  `packages/contracts`, `packages/shared`, `packages/client-runtime`, `apps/web`, `apps/server`,
  `apps/desktop`, then `pnpm run typecheck` in `apps/mobile` alone.
- A whole-tree `vp lint` does not report the repo's own JS-plugin rules (`t3code/*`) for
  `apps/web/src/board`; `vp lint apps/web` does. Run both.

Land the sync with a **merge commit, never a squash**: squashing a 1,500-file upstream merge
destroys the ancestry the next `git merge main` relies on.

### If `--ff-only` fails

Do **not** reach for `--force` or `-X ours`. The failure is the alarm working. Someone committed to
`main`, and the fix is to move that commit onto `t3o` and reset the mirror:

```bash
git log --oneline upstream/main..main   # what should not be there
```

Cherry-pick anything worth keeping onto `t3o`, then hard-reset `main` to `upstream/main`.

### Sanity check, any time

```bash
git fetch upstream
git log upstream/main..main   # must be empty
```

### After a merge

Record what it cost — how many files conflicted, which seams needed re-applying, how long it took.
The central bet of this fork is that ~20 mechanical seams stay cheap, and the only evidence that
settles it is a few merges done by hand. `t3o-02` is the first place that gets written down.

### Merge log

| Date       | Upstream delta                                                                                                  | Conflicts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Time                                                                                                                                                                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-09 | 20 commits, 101 files, ~9.2k insertions (`main` ff'd to `05eb05118`)                                            | **1 file**: `apps/server/src/persistence/Migrations.ts` — two hunks, both "upstream appended `039` where we appended `900`" at the list tails                                                                                                                                                                                                                                                                                                                                                                                                                                           | Kept both lines, upstream's first. No seam needed re-applying; all 38 markers survived intact (verified with `rg "T3o:"` against the inventory).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Merge + resolution ≈ 1 minute; full verification (install, typechecks for contracts/client-runtime/server/web, walking-skeleton + engine + pipeline tests, all green) ≈ 4 minutes.                                                                   |
| 2026-08-09 | 4 commits, 68 files, ~1.6k insertions (`main` ff'd to `1a003e383`), run against the `t3o-02a` generalised seams | **1 file**: `apps/server/src/persistence/Migrations.ts` — two hunks, both "upstream appended `039`/`040` where we spread `...BOARD_MIGRATIONS`" at the list tails                                                                                                                                                                                                                                                                                                                                                                                                                       | Kept both, upstream first. Every other seamed file — including four the delta churned directly (`decider.ts`, `projector.ts`, `ProjectionPipeline.ts`, `ProjectionSnapshotQuery.ts`, `orchestration.ts`, `ws.ts`) — auto-merged through the new predicate/spread seams. All 38 markers survived (`rg "T3o:"` row-for-row against the inventory).                                                                                                                                                                                                                                                                                                        | Merge + resolution ≈ 1 minute; verification (install, 4 typechecks, walking-skeleton + engine + pipeline + snapshot-query + projector + event-store + reducer + contracts suites, all green) ≈ 3 minutes.                                            |
| 2026-09-02 | 595 commits, 1,591 files (`main` ff'd to tag `v0.0.38`, `c0995d2ea`); spec `t3o-31`                             | **18 files, 27 hunks** + 32 `.plans` rename/delete. 11 were inventoried seams that moved with upstream churn (`ws.ts` dispatch body rewritten around the t3o-18 actor stamp; the t3o-05 tabs moved into upstream's new `WorkspacePageHeader`; three import seams; `index.css`; `orchestration.ts`/`rpc.ts`/`settings.ts`). 7 were **unmarked** fork edits (`serverSettings.ts`, `GitHubCli.ts`, `AppSidebarLayout.tsx`, `ChatComposer.tsx`, `server.ts` layer substitution, `contracts/orchestration.ts` `RuntimeMode` move, `settingsSearch.test.ts`). `routeTree.gen.ts` regenerated. | Every conflict resolved as upstream's code with the seam re-inserted; the unmarked hunks got markers on the way through. After the merge: 3 type errors (`planModeEnabled` on the board model row, a widened PR-cache key, an upstream-new integration test that drives the startup seam), 2 test failures (upstream tests now enumerate `ORCHESTRATION_PROJECTOR_NAMES` against the split `projection_state`; a settings-search substring), and 61 errors from upstream's new `no-native-title-tooltip` rule, fixed with a board-owned `BoardHint`. Ten pre-existing fork type errors were cleared first so the merge's own breakage was attributable. | Trial merge + measurement ≈ 2 h; real merge + resolution ≈ 20 min; fixes ≈ 1 h; verification (per-package typecheck, 5 test suites: 3,539 server / 3,280 web / 633 / 446 / 379, lint, two headless boots against copies of real databases) ≈ 40 min. |

Notes from the first run: the merge was executed against a scratch branch carrying the full `t3o-02`
seam set (a merge against bare `t3o` would not have exercised the seams). Every other seamed file —
including the two heaviest (`orchestration.ts`, `ProjectionPipeline.ts`) — auto-merged cleanly
through real upstream churn. The one conflict was the migration registry, which is a _predictable_
conflict site: upstream appends `NNN` at the same tail where we append `9xx`, and the resolution is
always "keep both, upstream first". `routeTree.gen.ts` also auto-merged; had it conflicted, the
resolution is regenerate, not hand-merge.

### Decisions recorded on the `v0.0.38` sync (`t3o-31`)

- **`.plans/` stays tracked.** Upstream now gitignores `.plans/` and its `AGENTS.md` forbids
  committed plans. The fork re-includes the directory (`!.plans/`, marked) directly beneath
  upstream's line and the `AGENTS.md` fork block says why. Resolve future `.plans` conflicts with
  `--ours`.
- **Upstream's `ThreadSettlementReactor` is accepted without a seam.** It auto-settles threads
  whose PR merged/closed or that idled past `sidebarAutoSettleAfterDays`. Audit: the decider treats
  settling a settled thread as a silent no-op; the board's three `thread.settle` dispatches go
  through its swallow-on-reject helper; auto-settle candidates exclude any thread with a live
  session, a pending request or a queued turn, so no in-flight step can be settled; and nothing in
  `board/` reads settlement state. The one observable effect is that an idle card thread's
  provider session may be stopped after three days, which a later turn restarts. Revisit if the
  board ever keys step liveness off settlement.
- **Upstream tests that enumerate `ORCHESTRATION_PROJECTOR_NAMES`** see the board names the fork
  spreads in and, since `t3o-26`, hit the split `projection_state`. Policy: a marked test-side fix
  each time (`isBoardProjectorName` routes seeding/assertions to `boards.projection_state`), not a
  registry restructure.
- **Launcher protocol.** The fork is at `SERVICE_LAUNCHER_PROTOCOL = 3` (multi-database backup,
  `t3o-26`); upstream is still `2`. A future upstream bump to `3` auto-merges as a _semantic_
  conflict — check `cloud/serviceProtocol.ts` on every sync.
- **`migrate-dev-db`** (new upstream script) rebuilds and migrates `state.sqlite` only. It neither
  copies nor migrates `boards.sqlite`. Follow-up, not blocking.
- **Not adopted yet:** upstream's new `apps/server/src/pullRequest/` module
  (`PullRequestService.runAction({ action: "merge", mergeMethod })`, `detail`, `list`). It covers
  what the fork's forge-merge path does by hand across ~250 unmarked lines (`SourceControlProvider`
  `mergeChangeRequest` + four provider stubs, `GitHubCli.mergePullRequest`,
  `GitManager.findBranchPullRequest` / `mergeBranchPullRequest`, the `BoardGitLayerLive`
  substitution in `server.ts`). Moving `BoardPullRequestGateway` onto it is the single largest seam
  reduction available; separate spec.

### Unmarked edits (debt)

Upstream-owned files the fork changes **without** a `T3o:` marker, measured after the `v0.0.38`
merge (`git diff --numstat main HEAD`, files present in `main`, excluding `.plans/`). These are
where the next sync's non-seam conflicts will come from. Tests, docs and generated files are listed
for completeness; the code rows are the ones worth seaming.

| File                                                                                                                                                                                                                                        | +/−            | Owner / what                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------- |
| `apps/web/src/components/chat/CompactComposerControlsMenu.tsx`                                                                                                                                                                              | 107/47         | `t3o-27` model-row menu reuse                               |
| `apps/server/src/git/GitManager.ts`                                                                                                                                                                                                         | 101/1          | `t3o-16` `findBranchPullRequest` / `mergeBranchPullRequest` |
| `apps/server/src/serviceLauncher.ts`                                                                                                                                                                                                        | 97/18          | `t3o-26` multi-database backup/restore (protocol 3)         |
| `apps/server/src/vcs/VcsProcess.ts`                                                                                                                                                                                                         | 52/0           | `t3o-16` `safeProcessOutput` credential scrubber            |
| `apps/server/src/sourceControl/SourceControlProvider.ts`                                                                                                                                                                                    | 22/0           | `t3o-16` `mergeChangeRequest` on the provider interface     |
| `apps/server/src/sourceControl/GitHubSourceControlProvider.ts`                                                                                                                                                                              | 20/0           | `t3o-16` `mergeChangeRequest`                               |
| `apps/server/src/sourceControl/{AzureDevOps,Bitbucket,GitLab}SourceControlProvider.ts`, `SourceControlProviderRegistry.ts`                                                                                                                  | 13/0 each      | `t3o-16` `mergeChangeRequest` stubs                         |
| `packages/contracts/src/model.ts`                                                                                                                                                                                                           | 16/0           | `t3o-21` `RuntimeMode` moved here from `orchestration.ts`   |
| `apps/server/src/cloud/serviceProtocol.ts`                                                                                                                                                                                                  | 10/2           | `t3o-26` `SERVICE_LAUNCHER_PROTOCOL = 3`                    |
| `apps/web/src/components/chat/ChatComposer.tsx`                                                                                                                                                                                             | 9/71           | `t3o-27` `AccessLevelPicker` extraction (import now marked) |
| `packages/contracts/src/sourceControl.ts`                                                                                                                                                                                                   | 6/0            | `t3o-16` `ChangeRequestMergeStrategy`                       |
| `apps/web/src/main.tsx`, `apps/web/src/appearanceFonts.ts`, `apps/web/src/index.css`                                                                                                                                                        | 5/0, 4/1, 28/1 | DM Sans font + `.board-card-done` (css marked)              |
| `vite.config.ts`, `package.json`, `scripts/dev-runner.ts`, `apps/web/package.json`                                                                                                                                                          | ≤6             | tooling                                                     |
| `apps/server/scripts/t3-sqlite-state.ts`                                                                                                                                                                                                    | 33/0           | `t3o-26` board database awareness                           |
| `apps/web/src/components/chat/TraitsPicker.tsx`                                                                                                                                                                                             | 1/1            | export                                                      |
| tests: `serviceLauncher.test.ts` (159), `serverSettings.test.ts` ×2 (86), `GitHubCli.test.ts` (70), `ProjectionPipeline.test.ts` (32, now marked), `GitManager.test.ts`, `settingsSearch.test.ts`, `SourceControlRepositoryService.test.ts` |                | fork test additions                                         |
| docs: `docs/internals/server-updates.md`, `docs/internals/scripts.md`                                                                                                                                                                       |                | `t3o-26`                                                    |
| generated: `apps/web/src/routeTree.gen.ts` (+63), `pnpm-lock.yaml` (+8)                                                                                                                                                                     |                | regenerate / reinstall                                      |

### Marker census

The row table below is maintained by hand and lags. The authoritative count is per file, from
`git grep -c "T3o:"` restricted to files that exist in `main`. After the `v0.0.38` sync:
**121 markers across 44 upstream-owned files.** Files whose count differs from their rows in the
table below (rows added on this sync are listed here, not yet expanded into the table):
`serverSettings.ts` 2 (indivisible settings keys), `GitHubCli.ts` 7 (board merge path),
`AppSidebarLayout.tsx` 3 (`isOnBoard`), `server.ts` 4 (+`BoardGitLayerLive`), `ChatView.tsx` 5
(+`chrome` prop), `contracts/orchestration.ts` 16 (+`RuntimeMode` re-export), `.gitignore` 1
(`!.plans/`), `AGENTS.md` 5 (+plans policy), `Sqlite.ts` 2 (`t3o-26` attach + board migrations),
`OrchestrationEventStore.ts` 7 (`t3o-26` retired-event replay), `server.test.ts` 1 and
`orphanedProviderSessionStartup.integration.test.ts` 2 (supervisor reactor mocks),
`OrchestrationEventStore.test.ts` 1.

Brief attachments (`t3o-32`) added 6 markers: `contracts/assets.ts` 1, `AssetAccess.ts` 4 (import,
claims member, mint case, resolve branch) and `ws.ts` +1 (6). The upload, storage, claim and
manifest all live in board-owned files (`board/attachments.ts`, migration `032`).

Per-project GitHub token overrides (`t3o-34`, see [gitenv](./gitenv.md)) added 15 markers across 7
upstream-owned files: `config.ts` 2 (import + `initGitenv` in `make`, which only `pair` still reaches),
`cli/config.ts` 2 (import + `initGitenv` at the end of `resolveServerConfig`, the real server boot
path), `vcs/VcsProcess.ts` 3
(import, `gh` env merge in `run`, exact-value scrub in `safeProcessOutput`),
`vcs/GitVcsDriverCore.ts` 2 (import + env spread in the git spawn), `Layers/ClaudeAdapter.ts` 2,
`acp/AcpSessionRuntime.ts` 2 and `Layers/CodexSessionRuntime.ts` 2 (import + env merge at each
agent-session spawn). All the logic lives in the new `sourceControl/gitenv.ts`; every seam is an
import or a one-expression env merge.

The **unified status palette** (see [Status colours](./status-colours.md)) added 12 markers across
9 upstream-owned files, 8 of them newly marked: `apps/web/src/index.css` 3 (the `--attention`
token), `Sidebar.logic.ts` 1 and `Sidebar.tsx` 2 (thread status pills), `ComposerBanner.tsx` 1 (the
`attention` banner variant) and `ChatComposer.tsx` 3 (+1, the question drawer's variant), plus four
on mobile: `threadPresentation.ts` 1, `thread-list-v2-items.tsx` 1, `widgets/AgentActivity.tsx` 1
and `scripts/generate-uniwind-themes.mts` 1. Every one is a colour-class or token swap — no logic
moved, so all 12 are frozen one-line edits rather than growable seams.

---

## Seam inventory

Maintained by hand. Every row is one `T3o:` marker in an upstream-owned file (`AGENTS.md`'s
self-contained fork block is one row even though the block itself contains several marker lines).
After an upstream merge, `rg -n "T3o:"` should match this table row for row; a marker that vanished
is a seam a conflict resolution silently dropped.

New files are **not** listed — they are ours and they never conflict. Only insertions into
upstream-owned files belong here. (Board-owned files also carry `T3o` headers; they are outside
this inventory.)

Shapes marked **frozen** are once-only edits that never grow again; every other seam is a
predicate, spread, injected factory call, or re-export whose growth happens inside board-owned
files (see [Seam grammar](#seam-grammar-since-t3o-02a)).

| File                                                                   | Spec         | Reason                                                                                    | Shape                                                                    |
| ---------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `AGENTS.md`                                                            | `t3o-01`     | Fork status, branch topology, seam rules                                                  | Self-contained block at the top                                          |
| `AGENTS.md`                                                            | `t3o-01`     | Rebase-target note (`t3o`, not `main`) in upstream's PR guidance                          | one-line edit (frozen)                                                   |
| `AGENTS.md`                                                            | `t3o-01`     | PR-target rule (`t3o`, never `main`) in upstream's PR guidance                            | one-line edit (frozen)                                                   |
| `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`          | `t3o-02`     | `BoardCardId` type import                                                                 | one-line append, import (frozen, D9)                                     |
| `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`          | `t3o-02a`    | Import board aggregate-ref builder + predicate                                            | one-line append (import)                                                 |
| `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`          | `t3o-02`     | Widen `commandToAggregateRef` return type with `"card"` / `BoardCardId`                   | two-line edit, type annotation (frozen)                                  |
| `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`          | `t3o-06a`    | Widen `commandToAggregateRef` return type with `"label"` / `BoardLabelId`                 | two-line edit, type annotation (frozen, D9-class)                        |
| `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`          | `t3o-02a`    | Board commands aggregate on the card                                                      | predicate delegation in `default`                                        |
| `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`           | `t3o-02`     | Import board projection module                                                            | one-line append (import)                                                 |
| `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`           | `t3o-02a`    | Board projector names join `ORCHESTRATION_PROJECTOR_NAMES`                                | registry spread                                                          |
| `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`           | `t3o-02`     | Board projectors join the projector list                                                  | registry spread (factory call)                                           |
| `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`      | `t3o-02`     | Import board snapshot enrichment                                                          | one-line append (import)                                                 |
| `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`      | `t3o-02a`    | Board-wrapped query methods override the base methods (D2/D8)                             | spread (factory call), after base methods                                |
| `apps/server/src/orchestration/commandInvariants.ts`                   | `t3o-08`     | `requireProject` rejection names the live projects (bounded to 10)                        | in-place message enrichment (marked)                                     |
| `apps/server/src/orchestration/decider.ts`                             | `t3o-02`     | Import board decider + predicate                                                          | one-line append (import)                                                 |
| `apps/server/src/orchestration/decider.ts`                             | `t3o-02a`    | Board commands are decided in the board module                                            | predicate delegation in `default`, before `satisfies never`              |
| `apps/server/src/orchestration/projector.ts`                           | `t3o-02`     | Import board projector + predicate                                                        | one-line append (import)                                                 |
| `apps/server/src/orchestration/projector.ts`                           | `t3o-02a`    | Board events are projected in the board module                                            | predicate delegation in `default`                                        |
| `apps/server/src/persistence/Layers/OrchestrationEventStore.ts`        | `t3o-02`     | `BoardCardId` import                                                                      | one-line append, import (frozen, D9)                                     |
| `apps/server/src/persistence/Layers/OrchestrationEventStore.ts`        | `t3o-02`     | Widen append-request `streamId` union                                                     | one-line edit (frozen, D9)                                               |
| `apps/server/src/persistence/Layers/OrchestrationEventStore.ts`        | `t3o-06a`    | Widen append-request `streamId` union with `BoardLabelId`                                 | one-line edit (frozen, D9-class)                                         |
| `apps/server/src/persistence/Layers/OrchestrationEventStore.ts`        | `t3o-02`     | Widen persisted-row `aggregateId` union                                                   | one-line edit (frozen, D9)                                               |
| `apps/server/src/persistence/Layers/OrchestrationEventStore.ts`        | `t3o-06a`    | Widen persisted-row `aggregateId` union with `BoardLabelId`                               | one-line edit (frozen, D9-class)                                         |
| `apps/server/src/persistence/Layers/Sqlite.ts`                         | ledger split | Legacy board-ledger reconcile before upstream migrations (`reconcileLegacyBoardLedger()`) | one-line append (delegating call)                                        |
| `apps/server/src/persistence/Layers/Sqlite.ts`                         | ledger split | Board migration lineage runs after upstream's (`runBoardMigrations()`)                    | one-line append (delegating call)                                        |
| `apps/server/src/persistence/Services/OrchestrationCommandReceipts.ts` | `t3o-02`     | `BoardCardId` import                                                                      | one-line append, import (frozen, D9)                                     |
| `apps/server/src/persistence/Services/OrchestrationCommandReceipts.ts` | `t3o-02`     | Widen receipt `aggregateId` union                                                         | one-line edit (frozen, D9)                                               |
| `apps/server/src/persistence/Services/OrchestrationCommandReceipts.ts` | `t3o-06a`    | Widen receipt `aggregateId` union with `BoardLabelId`                                     | one-line edit (frozen, D9-class)                                         |
| `apps/server/src/ws.ts`                                                | `t3o-02`     | Import board shell-delta mapper + predicate                                               | one-line append (import)                                                 |
| `apps/server/src/ws.ts`                                                | `t3o-02a`    | Board events become card shell deltas in `toShellStreamEvent`                             | predicate delegation in `default`, before the thread-aggregate check     |
| `apps/server/src/ws.ts`                                                | `t3o-18`     | `toShellStreamEvents` fans one event to N deltas (board `card-threads`)                   | one-line wrapper delegating to a board-owned mapper                      |
| `apps/server/src/ws.ts`                                                | `t3o-18`     | Human actor stamped on board commands before `dispatchCommand` dispatches                 | one-line delegation to a board-owned stamp (D11)                         |
| `apps/web/src/components/ChatView.tsx`                                 | `t3o-05`     | Import `BoardModeTabs`                                                                    | one-line append (import)                                                 |
| `apps/web/src/components/ChatView.tsx`                                 | `t3o-05`     | Threads/Board mode tabs before the breadcrumb (D1 shell tab)                              | one-line append (delegating element)                                     |
| `apps/web/src/components/NoActiveThreadState.tsx`                      | `t3o-05`     | Import `BoardModeTabs`                                                                    | one-line append (import)                                                 |
| `apps/web/src/components/NoActiveThreadState.tsx`                      | `t3o-05`     | Mode tabs in the no-thread top bar (Board entry must survive it)                          | one-line append (delegating element)                                     |
| `packages/client-runtime/src/state/shell.ts`                           | `t3o-02`     | Export board client state through `state/shell`                                           | one-line append (re-export)                                              |
| `packages/client-runtime/src/state/shellReducer.ts`                    | `t3o-02`     | Import board reducer + predicate                                                          | one-line append (import)                                                 |
| `packages/client-runtime/src/state/shellReducer.ts`                    | `t3o-02a`    | Card deltas delegate to the board reducer                                                 | predicate delegation in `default`                                        |
| `packages/contracts/src/index.ts`                                      | `t3o-02`     | Export `board.ts`                                                                         | one-line append (re-export)                                              |
| `packages/contracts/src/orchestration.ts`                              | `t3o-02`     | Import board schema + registries                                                          | one-line append (import)                                                 |
| `packages/contracts/src/orchestration.ts`                              | `t3o-02`     | `board` field on `OrchestrationReadModel` (optional)                                      | one-line append (frozen)                                                 |
| `packages/contracts/src/orchestration.ts`                              | `t3o-02`     | `cards` field on `OrchestrationShellSnapshot` (optional)                                  | one-line append (frozen)                                                 |
| `packages/contracts/src/orchestration.ts`                              | `t3o-06a`    | `boardLabels` field on `OrchestrationShellSnapshot` (catalogue once)                      | one-line append (frozen)                                                 |
| `packages/contracts/src/orchestration.ts`                              | `t3o-18`     | `boardCardThreads` field on `OrchestrationShellSnapshot` (links + todos)                  | one-line append (frozen)                                                 |
| `packages/contracts/src/orchestration.ts`                              | `t3o-02a`    | Card shell deltas in `OrchestrationShellStreamEvent` union                                | registry spread (`BOARD_SHELL_STREAM_EVENTS`)                            |
| `packages/contracts/src/orchestration.ts`                              | `t3o-02a`    | Board commands in `DispatchableClientOrchestrationCommand`                                | registry spread (`BOARD_CLIENT_COMMANDS`)                                |
| `packages/contracts/src/orchestration.ts`                              | `t3o-02a`    | Board commands in `ClientOrchestrationCommand`                                            | registry spread (`BOARD_CLIENT_COMMANDS`)                                |
| `packages/contracts/src/orchestration.ts`                              | `t3o-02a`    | Board event types in `OrchestrationEventType`                                             | registry spread (`BOARD_EVENT_TYPES`)                                    |
| `packages/contracts/src/orchestration.ts`                              | `t3o-02`     | `"card"` in `OrchestrationAggregateKind` (D9)                                             | one-line edit (frozen)                                                   |
| `packages/contracts/src/orchestration.ts`                              | `t3o-06a`    | `"label"` in `OrchestrationAggregateKind` (2nd board aggregate)                           | one-line edit (frozen, D9-class)                                         |
| `packages/contracts/src/orchestration.ts`                              | `t3o-02`     | `BoardCardId` in event-base `aggregateId` union (D9)                                      | one-line edit (frozen)                                                   |
| `packages/contracts/src/orchestration.ts`                              | `t3o-06a`    | `BoardLabelId` in event-base `aggregateId` union (label aggregate)                        | one-line edit (frozen, D9-class)                                         |
| `packages/contracts/src/orchestration.ts`                              | `t3o-02a`    | Board event members in the `OrchestrationEvent` union                                     | injected factory call (`makeBoardOrchestrationEvents(EventBaseFields)`)  |
| `packages/contracts/src/rpc.ts`                                        | `t3o-04`     | Import board RPC registries                                                               | one-line append (import)                                                 |
| `packages/contracts/src/rpc.ts`                                        | `t3o-04`     | Board methods join `WS_METHODS`                                                           | registry spread (`BOARD_WS_METHODS`)                                     |
| `packages/contracts/src/rpc.ts`                                        | `t3o-04`     | Board RPCs join `WsRpcGroup` (`RpcGroup.make` is variadic)                                | registry spread (`BOARD_RPCS`)                                           |
| `apps/server/src/auth/RpcAuthorization.ts`                             | `t3o-04`     | Import board RPC scope registry                                                           | one-line append (import)                                                 |
| `apps/server/src/auth/RpcAuthorization.ts`                             | `t3o-04`     | Board scopes join `RPC_REQUIRED_SCOPES`                                                   | registry spread (`BOARD_RPC_SCOPES`)                                     |
| `apps/server/src/ws.ts`                                                | `t3o-04`     | Import board RPC handler factory                                                          | one-line append (import)                                                 |
| `apps/server/src/ws.ts`                                                | `t3o-04`     | Board RPC handlers join the `toLayer` handler record                                      | spread (injected factory call, `boardRpcHandlers(deps)`)                 |
| `apps/server/src/ws.ts`                                                | `t3o-32`     | `board-attachment` asset resources mint like chat attachments                             | one-line predicate widening (frozen)                                     |
| `packages/contracts/src/assets.ts`                                     | `t3o-32`     | `board-attachment` member of `AssetResource` (card folder + filename)                     | union member (frozen)                                                    |
| `apps/server/src/assets/AssetAccess.ts`                                | `t3o-32`     | Import the board attachment path resolver                                                 | one-line append (import)                                                 |
| `apps/server/src/assets/AssetAccess.ts`                                | `t3o-32`     | `board-attachment` claims member (card folder + filename, download/mime)                  | union member (frozen)                                                    |
| `apps/server/src/assets/AssetAccess.ts`                                | `t3o-32`     | `issueAssetUrl` mints a board attachment (same disposition rules as `attachment`)         | `case` delegating to the board resolver                                  |
| `apps/server/src/assets/AssetAccess.ts`                                | `t3o-32`     | `resolveAsset` serves a board attachment from the card folder                             | predicate branch delegating to the board resolver                        |
| `packages/client-runtime/src/rpc/client.ts`                            | `t3o-04`     | Import board subscription tag type                                                        | one-line append (type import)                                            |
| `packages/client-runtime/src/rpc/client.ts`                            | `t3o-04`     | Board tags join `EnvironmentSubscriptionRpcTag`                                           | one-line union member (`BoardSubscriptionRpcTag`, grows in board.ts)     |
| `packages/contracts/src/settings.ts`                                   | `t3o-07`     | Import `BoardSettings` / `BoardSettingsPatch` from board.ts                               | one-line append (import)                                                 |
| `packages/contracts/src/settings.ts`                                   | `t3o-07`     | `board` field on `ServerSettings` (D10)                                                   | one-line append, single field (frozen; shape grows in `BoardSettings`)   |
| `packages/contracts/src/settings.ts`                                   | `t3o-07`     | `board` field on `ServerSettingsPatch` (D10)                                              | one-line append, single field (frozen; whole-map, merged by `deepMerge`) |
| `apps/web/src/components/settings/settingsSearch.ts`                   | `t3o-07`     | Import `BOARD_SETTINGS_SEARCH_ITEMS` from board-owned registry                            | one-line append (import)                                                 |
| `apps/web/src/components/settings/settingsSearch.ts`                   | `t3o-07`     | `/settings/board` in `SettingsPath` union (single board page, D1)                         | one-line union member (frozen)                                           |
| `apps/web/src/components/settings/settingsSearch.ts`                   | `t3o-07`     | Board label in `SETTINGS_SECTION_LABELS` (`SETTINGS_NAV_ITEMS` derives)                   | one-line record entry (frozen)                                           |
| `apps/web/src/components/settings/settingsSearch.ts`                   | `t3o-07`     | Board search items join `SETTINGS_SEARCH_ITEMS`                                           | registry spread (`BOARD_SETTINGS_SEARCH_ITEMS`)                          |
| `apps/web/src/components/settings/SettingsSidebarNav.tsx`              | `t3o-07`     | `LayoutGridIcon` import for the board nav icon                                            | one-line append (import)                                                 |
| `apps/web/src/components/settings/SettingsSidebarNav.tsx`              | `t3o-07`     | Board icon in `SETTINGS_SECTION_ICONS`                                                    | one-line record entry (frozen)                                           |
| `apps/server/src/mcp/McpInvocationContext.ts`                          | `t3o-08`     | `McpCapability` gains `"board"` (D3)                                                      | one-line edit (frozen)                                                   |
| `apps/server/src/mcp/McpInvocationContext.ts`                          | `t3o-08`     | `requireMcpCapability` stays preview-scoped after the widening                            | one-line edit (frozen)                                                   |
| `apps/server/src/mcp/McpSessionRegistry.ts`                            | `t3o-08`     | Granted capability set gains `"board"` (D3)                                               | one-line edit (frozen)                                                   |
| `apps/server/src/mcp/McpHttpServer.ts`                                 | `t3o-08`     | Import `BoardToolkitRegistrationLive`                                                     | one-line append (import)                                                 |
| `apps/server/src/mcp/McpHttpServer.ts`                                 | `t3o-08`     | Board toolkit joins the MCP server layer merge (D3)                                       | spread of a board-owned registration layer                               |
| `packages/contracts/src/orchestration.ts`                              | `t3o-09`     | Server-internal board commands in `InternalOrchestrationCommand`                          | registry spread (`BOARD_INTERNAL_COMMANDS`)                              |
| `apps/server/src/server.ts`                                            | `t3o-10`     | Import the supervisor reactor + its slots layer                                           | one-line append (import)                                                 |
| `apps/server/src/server.ts`                                            | `t3o-10`     | Supervisor reactor joins `ReactorLayerLive`                                               | provideMerge of a board-owned reactor layer                              |
| `apps/server/src/serverRuntimeStartup.ts`                              | `t3o-10`     | Import the supervisor reactor tag                                                         | one-line append (import)                                                 |
| `apps/server/src/serverRuntimeStartup.ts`                              | `t3o-10`     | Resolve the supervisor reactor in the startup effect                                      | one-line append (`yield*` the tag)                                       |
| `apps/server/src/serverRuntimeStartup.ts`                              | `t3o-10`     | Start the supervisor reactor in the `reactors.start` phase                                | one-line append (start call)                                             |

Marker count after `t3o-02a`: **38 marker lines across 14 upstream code files**, plus `AGENTS.md`
(5 marker lines: the fork block's open/end markers, the convention's own mention of the token, the
rebase-target note, and the PR-target note). The count is now **frozen by construction**:
`t3o-03`'s seven commands and seven events must land with zero new lines in upstream-owned files —
that claim held when `t3o-03` landed (zero new upstream lines; verified against this inventory).

`t3o-05` **moved the D1 shell-tab hook point** (marker count **49**): the walking skeleton's
sidebar-footer Board entry (`SidebarChrome.tsx`, 2 markers) is removed — two entry points to the
same mode is exactly the "entry points" defect upstream's `AGENTS.md` warns about, and the spec's
Threads/Board segmented control in the workspace top bar is the canonical entry — and replaced by
2 markers in `ChatView.tsx` (import + delegating `<BoardModeTabs mode="threads" />` before the
breadcrumb) plus 2 in `NoActiveThreadState.tsx` (the same delegating element; without it the
no-thread state would strand a user with no Board entry at all once the sidebar link is gone).
`SidebarChrome.tsx` is pristine upstream again and its inventory rows are retired. The board
surface's own top bar is board-owned (`apps/web/src/board/BoardPage.tsx`) and needs no seam.

`t3o-04` opened the **RPC seam layer** — a layer `t3o-02a` never generalised because the walking
skeleton created no RPCs. It added **9 marker lines across 3 new upstream files and ws.ts**
(marker count now **47**): the four registry spreads its spec declares (`WS_METHODS`,
`WsRpcGroup`, `RPC_REQUIRED_SCOPES`, the ws `toLayer` handler record) plus one the spec did not
anticipate — a one-line union widening of client-runtime's hardcoded
`EnvironmentSubscriptionRpcTag` (`rpc/client.ts`), without which a streaming board RPC types as
unary on the client. Each spread's registry lives in `packages/contracts/src/board.ts`; adding
another board RPC grows those registries and `apps/server/src/board/rpc.ts` only (a further
_streaming_ RPC also grows the board-owned `BoardSubscriptionRpcTag` type, still zero upstream
edits). Note also that `t3o-04` narrowed the existing frozen
`OrchestrationShellSnapshot.cards` seam from `BoardCard` to `BoardCardShell` (D7 payload split) —
a content change inside an inventoried line, not a new seam.

`t3o-07` opened the **settings seam layer** and added **9 marker lines across 3 upstream files**
(marker count now **56**). Two are the frozen server appends the spec declared (`ServerSettings.board`
and `ServerSettingsPatch.board`) plus their shared import — a single `board` field whose entire shape
(`BoardStep`, pipeline, projects, concurrency, lifecycle) grows inside `BoardSettings` in `board.ts`,
the same category as `providerInstances`. Crucially the whole-map recipe replacement needs **no merge
seam**: the stock `applyServerSettingsPatch` `deepMerge` (`packages/shared/src/Struct.ts`) replaces
arrays wholesale (`Predicate.isObject` excludes arrays), so a stage's step list is never half-merged,
and board-specific replacement logic never enters that upstream function. The web side is 4 markers in
`settingsSearch.ts` (import, the `SettingsPath` union member, the `SETTINGS_SECTION_LABELS` entry, and
the `...BOARD_SETTINGS_SEARCH_ITEMS` registry spread — the searchable-setting index is a **spread of a
board-owned registry**, never per-setting entries, as the spec requires) plus 2 in `SettingsSidebarNav.tsx`
(the nav icon import and its `SETTINGS_SECTION_ICONS` entry). The spec named four frozen web appends,
but `SETTINGS_NAV_ITEMS` **auto-derives** from `SETTINGS_SECTION_LABELS` in the current upstream, so it
needs no seam — three frozen web entries, not four. New files (the `settings.board.tsx` route and the
`BoardSettingsPanel*` components) are ours and never conflict. Adding a second board settings page would
mean generalising the three frozen web entries to spreads of one board-owned nav registry, not appending
a second entry to each.

`t3o-06a` introduced the **second board aggregate kind (`"label"`)** and with it the same once-only
D9-class widenings the fork blessed for `BoardCardId` — now for `BoardLabelId` — across the four
narrowly-typed aggregate-id unions (`OrchestrationEngine` return type, `OrchestrationEventStore` ×2,
`OrchestrationCommandReceipts`) plus `"label"` in `OrchestrationAggregateKind` and `BoardLabelId` in
the event-base `aggregateId` union (`orchestration.ts`). **7 new marker lines, all frozen widenings
that never grow again per feature.** Everything else labels needed — four commands, four events, a
catalogue shell delta, label tables/queries, the picker and chips — landed in board-owned files with
**zero** further upstream lines, exactly as the seam grammar promises for a new aggregate's
commands/events/projectors.

One seam the plan's own cost paragraph under-counted: the label **catalogue rides the shell snapshot
once** as `OrchestrationShellSnapshot.boardLabels`, a genuine (frozen, optional) new field on an
upstream-owned schema — the plan said "every other part of this spec adds zero core lines," but a
top-level catalogue array on the snapshot cannot be board-owned. It is the exact same shape/class as
the `cards` field `t3o-02` added (one-line optional append, frozen), so it is inventoried as such
rather than absorbed. The `card-`/`label-` shell-delta prefix rule was widened in the board-owned
predicate (see [The `board.` prefix rule](#the-board-prefix-rule)), which is zero core lines.

`t3o-08` opened the **MCP toolkit seam layer** (the D3 agent write path) and added **5 marker lines
across 3 upstream files** (marker count now **61**), exactly the three the spec named plus one
collateral of the capability widening. `McpInvocationContext.ts` gains `"board"` on the
`McpCapability` union (frozen edit) and — because that widening would otherwise break the
preview-specific `requireMcpCapability`, whose error type is `Schema.Literal("preview")` — that
helper's parameter is pinned to `"preview"` (board authorization is in the tool handlers, D3, not in
capability gating, so nothing board reaches this gate). `McpSessionRegistry.ts` grants `"board"`
alongside `"preview"` on every issued credential (frozen edit). `McpHttpServer.ts` imports the
board-owned `BoardToolkitRegistrationLive` and adds it to the `Layer.mergeAll` of registered
toolkits — a spread of a board-owned registration layer, the same shape as every other generalised
seam, so the entire toolkit (tools, handlers, five new board commands/events/projectors, three
`9xx` migrations, the thread↔card authorization) grows in board-owned files
(`apps/server/src/mcp/toolkits/board/*`, `board.ts`, `apps/server/src/board/*`) with zero further
upstream lines. The new agent-write commands ride the **existing** `...BOARD_CLIENT_COMMANDS` /
`...BOARD_EVENT_TYPES` / `makeBoardOrchestrationEvents` spreads (they are `board.` commands like every
other board write), which is why a whole new command family — progress, human-input, the completion
contract, and plan propose/write — touched no `orchestration.ts` seam. The core-only diff audit
yields exactly these three MCP files (the board toolkit directory is already covered by the
`*/board/*` exclude).

`t3o-09` opened the **internal-command seam** — one marker line (marker count now **62**;
`...BOARD_INTERNAL_COMMANDS,` in
`orchestration.ts`'s `InternalOrchestrationCommand` union). `t3o-02a` generalised the _client_
command union (`BOARD_CLIENT_COMMANDS`) but not the internal one, because no board spec before
`t3o-09` needed a server-only command; the worktree lifecycle commands are the first (a client must
never be able to record a worktree it cannot create on disk, and provisioning sits downstream of the
human "Begin build" gate). This mirrors how `t3o-04` opened the RPC seam layer. The registry lives
in `packages/contracts/src/board.ts`; adding another internal board command grows it and the board
decider only — zero further upstream edits. `t3o-09` also added its `worktree` column to
`board_cards` through a new board-owned migration (now `011_BoardCardsWorktree` in
`board/migrations/` after the ledger split; originally numbered `910`, registered in
`BOARD_MIGRATIONS`) and grew `BoardCard` plus the board command/event registries — all board-owned,
no upstream file beyond the one spread above.

`t3o-10` opened the **reactor seam layer** — **5 marker lines across 2 upstream files** (marker count
now **67**): a reactor has to be _registered_ in the runtime and _started_ in the boot sequence, and
no board spec before `t3o-10` shipped a reactor, so this is the reactor analogue of how `t3o-04`
opened the RPC seam and `t3o-09` opened the internal-command seam. `server.ts` imports the
board-owned `SupervisorReactorLive` (provided its `BoardStepSlotsLive`) and `provideMerge`s it into
`ReactorLayerLive` alongside the stock reactors; `serverRuntimeStartup.ts` imports the
`SupervisorReactor` tag, resolves it, and starts it in the existing `reactors.start` phase against
the shared `reactorScope`, exactly as `providerSessionReaper` is started one line above. Everything
the supervisor _does_ — the step machine (six internal step-lifecycle commands/events, the
`board_card_step_state` table via board migration **013**), the prompt envelope, death detection,
escalating recovery, boot reconciliation, the one-writer enforcement and the concurrency-slot
lifecycle — lives in board-owned files (`apps/server/src/board/supervisorReactor.ts`,
`supervisor.ts`, `BoardStepSlots.ts`, `decider.ts`, `projector.ts`, `projection.ts`,
`packages/contracts/src/board.ts`), so the whole subsystem grows behind those 5 lines. The
core-only diff audit yields exactly `server.ts` and `serverRuntimeStartup.ts`. Adding a second board
reactor grows the same two seams by one merge line and one start line — it never opens a new one.

`t3o-11` (the concurrency governor) added **zero new core seams** — marker count stays **67** and the
core-only diff audit is empty. This is the seam grammar paying off: the governor's whole surface lives
in board-owned files. The admission policy (per-`providerInstanceId` `maxConcurrent` + global ceiling)
and boot-time `restore` are in `BoardStepSlots.ts`; the pure ordering (stage desc → started before
unstarted → drag order) and `resolveBoardConcurrencyLimit` are in `supervisor.ts`; the `schedule`
pass (offer candidates to `acquire` in priority order, queue the rest, run after every slot release
for step-boundary preemption) and the `reschedule` boot decision are in `supervisorReactor.ts`. The
one bit of governor state that reaches the column card — the `queued` flag on `BoardCardShell` — was
already a placeholder field on the shell (from `t3o-04`), so wiring it added no core line: the
snapshot builder (`projection.ts`) sources it from `board_card_step_state`, and a new **`card-queued`**
shell delta carries live flips. That delta is board-owned in every respect — it rides the existing
`...BOARD_SHELL_STREAM_EVENTS` spread into `OrchestrationShellStreamEvent`, its `card-` prefix already
routes through `isBoardShellStreamEvent`, and the client reducer delegates through the existing board
seam — so it needed no edit to `orchestration.ts`, `ws.ts`, `shellReducer.ts` or the settings files
(the concurrency settings shape already existed under `BoardSettings.concurrency` from `t3o-07`).
`queued` is derived from step state the card aggregate does not carry, so — exactly like `threadState`
— it rests at `false` on card-carrying deltas and the client preserves its last value, with the
`card-queued` delta and the snapshot as its authoritative source. The byte-budget tests were extended
to cover the now-sourced `queued` field and still pass (position is derived client-side in
`boardBuildingQueueInfo`, never on the wire, so the shell stays scalar-plus-one-array under budget).

`t3o-18` (thread todos on cards + the deterministic Activity rail) added **two core seam lines and
one frozen contract field**, all in shapes the grammar already has. The todo cache
(`board_thread_todos`, board migration **017**), the structured actor-attributed activity table
(migration **018**), the projector that writes both, the `card-threads` shell delta, the strip, the
rail and the tool deletions are all board-owned.

Three things are worth recording because they read as deviations from the spec's own decision list:

- **The todo cache is written by the board PROJECTOR, from the `thread.activity-appended` domain
  event, not by the supervisor reactor off the provider runtime stream (spec D1/D2).** The observable
  outcomes are identical — a projection-only side table, nothing stored for an unlinked thread, no
  backfill — but the domain event carries a `sequence` and commits in the same transaction, which the
  runtime stream does not. Without that, the `card-threads` shell delta (which must ride the domain
  stream with the causing event's sequence, like every other delta) would race the reactor's write and
  render the previous revision. It also makes D14's "rebuild from thread activities" path real rather
  than theoretical. The board projector still writes only `board_*` tables.
- **The actor reaches the projector through a board-owned in-process side channel keyed by
  `commandId`** (`board/activityActors.ts`), because the projection pipeline runs on a different fiber
  from the dispatcher and the event envelope is upstream-owned. It is bounded, read without eviction
  (one command may land several events), and degrades to the system actor — so a rebuilt projection
  attributes historic rows to the system rather than inventing a human.
- **The two internal `board.card.request-input` dispatches in the supervisor reactor were dropped, not
  re-homed.** D13 deletes that command, and D12's nine curated activity kinds have no "escalation
  note" among them. Nothing rendered those rows before, so nothing regresses visually; the
  human-facing signal stays the `stalled` badge (t3o-17, D3) and the question goes to the server log.

`toShellStreamEvent` was widened to `toShellStreamEvents` (an array) because a thread event now
implies two orthogonal deltas — its own thread shell, and its card's todo summaries — and neither may
swallow the other.

Marker-less upstream churn that rides along with `t3o-02`:

- `apps/web/src/routeTree.gen.ts` — regenerated by TanStack Router for the new `/board` route file.
  Never hand-edited; on a conflicted merge, take either side and regenerate.

Where `t3o-02`'s estimate met reality: the spec listed ~20 insertion points; the landed count was
**38 markers across 14 upstream files**. The delta was almost entirely the card aggregate (D9)
rippling through three narrowly-typed `ProjectId | ThreadId` unions (event store, receipts, engine)
plus one import line per touched file — all mechanical one-liners. Two planned seams turned out to
be unnecessary: `OrchestrationCommand` (derived union — covered by the dispatchable append) and
`createEmptyReadModel` (the `board` field is optional, so the empty model needs no edit). The
`ClientOrchestrationCommand` → engine path also needed **no** Normalizer seam — unrecognized
commands pass through untouched. `t3o-02a` then converted every enumeration seam (a case per
command, a union member per event, a registry entry per projector/migration) into the
predicate/spread/injected-factory shapes above without changing the marker count materially.

### Core-only diff audit

The fork's invasiveness claim rests on one command: the diff against upstream, excluding
board-owned paths, must show _only_ the surgical seams above.

```bash
git diff upstream/main...t3o -- . \
  ':!*/board/*' ':!*/board.ts' ':!*/board.test.ts' ':!*/board.tsx' \
  ':!*/boardCommands.ts' \
  ':!docs/t3o' ':!.plans' ':!AGENTS.md' ':!*routeTree.gen.ts'
```

The excludes name board-owned paths **precisely** — a catch-all like `':!*board*'` would silently
hide unrelated upstream files (`Dashboard*`, `Keyboard*`, `clipboard*`, …) and make the audit read
clean when it is not. Board migrations need no exclude of their own since the ledger split: they
live in `apps/server/src/board/migrations/` (numbered from `1`), which the `*/board/*` glob already
covers, and `persistence/Migrations.ts` is pure upstream again. Keep the exclusion list honest as
board-owned paths are added. Run it after each spec lands and after each upstream merge; a hunk you
cannot map to an inventory row is a seam that escaped the grammar. (After `t3o-04` it yields
exactly the 17 seamed code files.)

---

## Inherited workflows to disable

These are upstream's CI, inherited by the fork. They are disabled **from the GitHub Actions UI**
(Actions → the workflow → ⋯ → Disable workflow), **never by editing or deleting the YAML** — editing
guarantees a conflict on every upstream CI change, for a file we do not otherwise care about.

Recorded here so a future reader knows they were switched off deliberately, not left broken.

| Workflow                          | Why disabled                                                                                                                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy-relay.yml`                | Deploys the T3 Connect relay to upstream's infrastructure on every push to `main`. We do not own that infrastructure and have none of the credentials; a fork running it is at best a failed job and at worst points at someone else's deployment. |
| `mobile-eas-preview.yml`          | Builds preview binaries through upstream's Expo/EAS account on every PR. No EAS credentials here, and mobile is explicitly out of scope for T3o (D17). Burns a build slot per PR for nothing.                                                      |
| `mobile-eas-production.yml`       | Production mobile builds and OTA updates. Same missing EAS credentials, and shipping mobile releases from a fork is never something we want to happen — least of all by accident.                                                                  |
| `mobile-showcase-screenshots.yml` | Captures marketing screenshots on simulators for upstream's showcase. Long, expensive, and irrelevant to a fork that ships no mobile UI.                                                                                                           |
| `release.yml`                     | Publishes the `t3` CLI to NPM on tags and a 3-hourly nightly cron. T3o publishes nothing. Leaving this on means a recurring scheduled job whose only possible outcomes are failure or, given credentials, publishing over upstream's package.      |
| `thread-transfer-report.yml`      | Posts an upstream-specific report after each CI run, aimed at upstream's own review process. Noise here.                                                                                                                                           |
| `desktop-macos-preview.yml`       | (since `v0.0.38`) Builds a signed macOS preview on every PR through upstream\'s Apple credentials. None here.                                                                                                                                      |
| `mobile-fingerprint-check.yml`    | (since `v0.0.38`) Expo native-fingerprint gate on every PR. Mobile is out of scope (D17).                                                                                                                                                          |
| `web-preview.yml`                 | (since `v0.0.38`) Deploys a web preview per PR to upstream\'s hosting. Not ours.                                                                                                                                                                   |

**Kept on:** `ci.yml` (the actual build, lint, typecheck and test gates — we want these), plus
`pr-size.yml`, `pr-vouch.yml` and `issue-labels.yml`, which are cheap, self-contained, and harmless
if they never fire on a single-maintainer repo. Revisit if they turn out to be noisy.
`publish-aur.yml` (since `v0.0.38`) is `workflow_call`-only and never fires on its own.

Disable with `gh workflow disable <file>`; `gh workflow list --all` shows what is actually off —
the YAML never says.

---

## Manual GitHub settings

Things that cannot be done from the repo because the PAT in use lacks `administration` scope. Kept
here so the repo state is reproducible from the docs.

- Default branch set to `t3o` (Settings → General → Default branch).
- The six workflows above disabled (Actions → each workflow → ⋯ → Disable workflow).
- Optional: branch protection on `main`, restricting it to fast-forward pushes only. Convention plus
  `t3o` being the default branch already covers this in practice; add it if a stray commit ever
  actually lands.

---

## Why no automation yet

Two obvious pieces of machinery are deliberately **not** built during MVP.

**Scheduled upstream sync.** A workflow would automate something that happens three or four times
before the MVP is proved. The value we want from early merges is _information_ — how bad are the
conflicts, really — and that comes from doing them by hand and writing the answer down. Automation
returns post-MVP, at which point T3o's own scheduled-cards feature may be a better home for it than a
GitHub workflow. Either way **the manual runbook above stays permanently**: an orchestrator that is
broken cannot merge the fix that unbreaks it.

**A CI gate on the seam count.** Seams are being added on nearly every commit right now, so a count
gate would be friction rather than protection — a check whose failure means "yes, we did the work".
It becomes worth adding once the inventory stops moving.
