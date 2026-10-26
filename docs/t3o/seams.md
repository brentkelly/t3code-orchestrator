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
// T3o: board RPC handlers register from the board module (t3o-04).
...(yield* boardRpcHandlers({ currentSession, boardSupervisor })),
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

1. **A predicate delegation** — `if (input.resource._tag === "board-attachment") …`, placed
   before upstream's own handling so upstream never sees the board's input.
2. **A spread of a board-owned registry** — `...BOARD_RPCS,`, `...BOARD_RPC_SCOPES,` etc.,
   appended at a list/record tail. (Database migrations are the exception — see the note below;
   they are no longer a seam in `Migrations.ts`.)
3. **A single injected factory call** — `...(yield* boardRpcHandlers({ … }))`.
4. **A re-export** — `export * from "./board.ts"`.

> **The board has its own engine (`T3O-56`).** Board commands are decided, logged and published by
> `board/BoardEngine.ts` against `boards.board_events`, not by upstream's orchestration engine, so
> the decider, projector, engine, projection-pipeline and receipt seams are gone, and board events
> and commands are no longer members of `OrchestrationEvent` / `OrchestrationCommand`
> (`contracts/boardEvent.ts`, `BoardCommand` in `board.ts`). A seam that routes INTO upstream's
> command loop is no longer an option for new board work.

> **The board has its own client protocol (`T3O-57`).** Clients send board commands on
> `board.dispatchCommand` and hold the board through `board.subscribeBoard`: a `BoardShellSnapshot`
> (cards, labels, stages, card threads, provider limits) stamped with the board log's sequence,
> then that log's deltas, resuming from the client's cursor like upstream's shell does
> (`board/boardSubscription.ts`, client `state/boardSubscription.ts`). The orchestration shell
> snapshot, its stream, `ClientOrchestrationCommand` and the client shell reducer carry nothing
> board-shaped. Card thread state (`threadState`, `awaitingInput`, `waitingOnBackground`) is
> derived on the client from the thread shells, so a thread changing needs no board delta.

> **Database migrations are a separate lineage, not a seam.** Board migrations were originally
> spread (`...BOARD_MIGRATIONS`) into upstream's `migrationEntries` and numbered from 900 to dodge
> id collisions. That is a trap: effect's `Migrator` advances a single high-water mark per ledger
> table and skips any id `<=` it, so once a `900` migration ran, every later upstream migration
> (all `< 900`) was silently skipped. Board migrations now live in their own directory
> (`apps/server/src/board/migrations/`, ids restart at **1**) and run against their own ledger
> table `t3o_sql_migrations` via `runBoardMigrations()`. The two lineages have independent
> high-water marks, so `Migrations.ts` is now pure upstream and no longer conflicts when upstream
> appends a migration. `layerSetup` in `persistence/Sqlite.ts` boots them in order:
> `initialiseBoardDatabase()` → `runMigrations()` (upstream) → `runBoardMigrations()` (board).
> `initialiseBoardDatabase()` (`board/migrations/index.ts`) attaches `boards.sqlite`, backs it up
> before the v2 upgrade, runs `reconcileLegacyBoardLedger()`, then relocates a pre-`t3o-26`
> layout's board tables and ledger out of `main`. It runs **before** upstream migrations —
> otherwise a database still pinned at the legacy `910` high-water mark would skip pending
> upstream migrations on its first boot. Reconciliation maps each recorded legacy `900+` id back
> to its new id, seeds exactly those into the board ledger (in `main`, beside the board tables, so
> relocation moves both together) as already-applied, then evicts the legacy rows: seeding only
> what actually ran leaves a partially-migrated database's pending migrations for the board
> Migrator, and not replaying applied migrations protects the one-time data backfill (007) from
> resurrecting user-removed seed labels. To add a board migration: drop `NNN_Name.ts` in
> `board/migrations/` and append it to `BOARD_MIGRATIONS` in that dir's `index.ts`.

Plus the frozen once-only edits recorded in the inventory. Everything else — registries, factories, type guards, reducers, SQL —
lives in board-owned files (`packages/contracts/src/board.ts`, `apps/server/src/board/*`,
`packages/client-runtime/src/state/board.ts`). The consequence, and the test of this grammar:
**adding a board command, event, projector, or migration touches zero upstream-owned files.**

### The `board.` prefix rule

- Every board command and event `type` starts with **`board.`**, and so does every board RPC
  method. `isBoardCommand` / `isBoardEvent` (`packages/contracts/src/board.ts`) key on it: the
  supervisor routes a command it dispatches to the board engine or upstream's by it.
- Board deltas keep their **`card-`**, **`label-`** and **`stage-`** kinds, but they ride the
  board's own stream (`T3O-57`), so nothing routes on those prefixes any more.

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
  supervisor starts after v2's `orchestration-v2.recovery` phase (`T3O-59`), and its boot reconcile
  still waits on the `ServerActivation` boundary before reading any thread, because a thread read
  before recovery has settled shows a run the restart killed as active and a dead step reads alive
  (`supervisorReactor.ts`, t3o-10 D3). Keep the wait even though the start line now sits after
  recovery: our correctness must not be a property of upstream's phase ordering, which a sync can
  reshuffle with no test that could catch it.

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
git diff --name-status vPREV vNEXT -- .github/workflows/   # new CI needs a decision
```

New workflow files are the easiest thing in a sync to miss, because nothing fails when one starts
firing on every PR — see "Inherited workflows".

and run the normal checks for whatever the merge touched. Two things the root scripts hide
(learned on the `v0.0.38` sync):

- `vp run -r typecheck` stops early on this box (mobile is OOM-killed at the default concurrency
  and `t3`/desktop never run). Typecheck **per package**: `pnpm run typecheck` in
  `packages/contracts`, `packages/shared`, `packages/client-runtime`, `apps/web`, `apps/server`,
  `apps/desktop`, then in `apps/mobile` alone. (Since `v0.0.42` that script is the effect-patched
  `tsc`; `tsgo` is gone. Filter its output for `error TS` — the effect diagnostics it prints as
  `suggestion` are not failures.)
- A whole-tree `vp lint` does not report the repo's own JS-plugin rules (`t3code/*`) for
  `apps/web/src/board`; `vp lint apps/web` does. Run both.

Land the sync with a **merge commit, never a squash**: squashing a 1,500-file upstream merge
destroys the ancestry the next `git merge main` relies on.

**A sync PR is landed by hand, never through the merge button and never by the board's auto-merge**
— both squash. Open the PR for review as normal, then:

```bash
git checkout t3o && git merge --no-ff sync/upstream-vX.Y.Z && git push
git push origin main vX.Y.Z                         # the fast-forwarded mirror and its tag
git merge-base --is-ancestor vX.Y.Z t3o && echo ok  # must print ok
```

Turn **auto-merge off** on the sync's card. The repository's default merge method stays squash on
purpose: every other board card relies on squash merges being clean, so the protection is this rule,
not a setting.

### If a sync was squashed anyway

It has happened twice. PR #57 landed the `v0.0.38` sync as a squash (`5698920b4`, one parent). The
tree was right and the ancestry was gone, so `git merge-base t3o v0.0.42` resolved to a commit a
month older than `v0.0.38` and the next merge produced **891** conflicted files instead of 50. PR
#110 then squashed the `v0.0.42` sync the same way (`6268e74c4`), and `T3O-54` grafted it back. The
alarm is `git merge-base --is-ancestor <last-synced-tag> t3o` returning false.

The repair is a graft — a merge that changes no file and records the missing parent:

```bash
git merge -s ours vX.Y.Z      # the tag the squashed sync brought in
git diff HEAD~1 HEAD          # must be empty; if it is not, stop
```

It is truthful rather than a trick: `t3o`'s tree really does contain that tag, the squash only threw
away the pointer. Say so in the commit message, because a `-s ours` merge is otherwise unreadable in
history. Do it as the first commit of the next sync branch, not on `t3o` directly.

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

| Date       | Upstream delta                                                                                                                                          | Conflicts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Time                                                                                                                                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-09 | 20 commits, 101 files, ~9.2k insertions (`main` ff'd to `05eb05118`)                                                                                    | **1 file**: `apps/server/src/persistence/Migrations.ts` — two hunks, both "upstream appended `039` where we appended `900`" at the list tails                                                                                                                                                                                                                                                                                                                                                                                                                                           | Kept both lines, upstream's first. No seam needed re-applying; all 38 markers survived intact (verified with `rg "T3o:"` against the inventory).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Merge + resolution ≈ 1 minute; full verification (install, typechecks for contracts/client-runtime/server/web, walking-skeleton + engine + pipeline tests, all green) ≈ 4 minutes.                                                                                                                          |
| 2026-08-09 | 4 commits, 68 files, ~1.6k insertions (`main` ff'd to `1a003e383`), run against the `t3o-02a` generalised seams                                         | **1 file**: `apps/server/src/persistence/Migrations.ts` — two hunks, both "upstream appended `039`/`040` where we spread `...BOARD_MIGRATIONS`" at the list tails                                                                                                                                                                                                                                                                                                                                                                                                                       | Kept both, upstream first. Every other seamed file — including four the delta churned directly (`decider.ts`, `projector.ts`, `ProjectionPipeline.ts`, `ProjectionSnapshotQuery.ts`, `orchestration.ts`, `ws.ts`) — auto-merged through the new predicate/spread seams. All 38 markers survived (`rg "T3o:"` row-for-row against the inventory).                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Merge + resolution ≈ 1 minute; verification (install, 4 typechecks, walking-skeleton + engine + pipeline + snapshot-query + projector + event-store + reducer + contracts suites, all green) ≈ 3 minutes.                                                                                                   |
| 2026-09-02 | 595 commits, 1,591 files (`main` ff'd to tag `v0.0.38`, `c0995d2ea`); spec `t3o-31`                                                                     | **18 files, 27 hunks** + 32 `.plans` rename/delete. 11 were inventoried seams that moved with upstream churn (`ws.ts` dispatch body rewritten around the t3o-18 actor stamp; the t3o-05 tabs moved into upstream's new `WorkspacePageHeader`; three import seams; `index.css`; `orchestration.ts`/`rpc.ts`/`settings.ts`). 7 were **unmarked** fork edits (`serverSettings.ts`, `GitHubCli.ts`, `AppSidebarLayout.tsx`, `ChatComposer.tsx`, `server.ts` layer substitution, `contracts/orchestration.ts` `RuntimeMode` move, `settingsSearch.test.ts`). `routeTree.gen.ts` regenerated. | Every conflict resolved as upstream's code with the seam re-inserted; the unmarked hunks got markers on the way through. After the merge: 3 type errors (`planModeEnabled` on the board model row, a widened PR-cache key, an upstream-new integration test that drives the startup seam), 2 test failures (upstream tests now enumerate `ORCHESTRATION_PROJECTOR_NAMES` against the split `projection_state`; a settings-search substring), and 61 errors from upstream's new `no-native-title-tooltip` rule, fixed with a board-owned `BoardHint`. Ten pre-existing fork type errors were cleared first so the merge's own breakage was attributable.                                                                                                                                                                      | Trial merge + measurement ≈ 2 h; real merge + resolution ≈ 20 min; fixes ≈ 1 h; verification (per-package typecheck, 5 test suites: 3,539 server / 3,280 web / 633 / 446 / 379, lint, two headless boots against copies of real databases) ≈ 40 min.                                                        |
| 2026-09-20 | 1,051 commits, 14,650 files — 11,726 of them `.repos/` vendored references that merge silently, ~2,900 real (tag `v0.0.42`, `719a76ca1`); card `T3O-46` | **50 files, ≈120 hunks** after the ancestry graft; **891 files** before it (the `v0.0.38` sync had been squash-merged — see "If a sync was squashed anyway"). 3 needed thought (`ws.ts` shell coalescing, `OrchestrationEventStore.ts` paging, the composer pair), 3 were the MCP capability union, 3 + 13 registration files were Forgejo, 4 docs, 2 regenerated (`routeTree.gen.ts`, `pnpm-lock.yaml`), the rest keep-both.                                                                                                                                                           | Forgejo resolved wholly to upstream's `fj`/`tea` implementation, with the board's two merge seams re-attached from a fork-owned `forgejoMerge.ts`. Everything else: upstream's code with the seam re-inserted. After the merge: `Schema.TaggedErrorClass` → `TaggedError` (5 fork files), `NodeSqliteClient` moved to `@t3tools/shared` (6 board tests), `ProjectionStateRepository` gained `upsertMany`, `thread.auto-settle` gained `settledAt`, thread shells gained `pullRequests` (3 fixtures), and four web helpers the board used were replaced upstream (`useAssetUrl`, `openPullRequestLink`, `createDebouncedStorage`, a router search reducer). 3 upstream tests needed a marked fork expectation. Lint: 2 `Array#toSorted` hits from the one new rule (`no-hermes-unsupported-array-methods`), 1 unused disable. | Merge + resolution ≈ 1 h 15 min; type/test/lint fixes ≈ 50 min; Forgejo seams + tests ≈ 25 min; verification (7 per-package typechecks, 952 board + 1,742 + 1,932 server / 3,172 packages / 5,493 web tests, both lint passes, the boot-time database sequence twice against copies of real data) ≈ 30 min. |
| 2026-10-20 | 551 commits, 1,996 files outside `.repos/` (tag `v0.0.45`, `6c8fed35d`, the last orchestration-v1 release); card `T3O-54`                               | **24 files** (23 content, 1 modify/delete) after re-grafting `v0.0.42`, which PR #110 had squashed. 4 needed thought (`serviceProtocol.ts`, `GitHubPullRequestCli.ts`, `GitHubCli.ts` + `GitHubSourceControlProvider.ts`, `GitManager.ts`); 2 keep-both test files; 1 regenerated (`pnpm-lock.yaml`); the rest upstream's code with the seam re-inserted.                                                                                                                                                                                                                               | Mobile `threadPresentation.ts` deletion accepted (the surviving v2 list already had the fork palette). After the merge: 2 server API removals (`NodeSqliteClient.layerMemory`, `minLastAppliedSequence`), 6 web type errors from upstream dropping `viewportClassName`/`inputClassName`/`SheetPanel`, the new `monogram` icon kind and `speedIcon`; 3 upstream tests caught the board snapshot wrapper dropping `unsettledOnly`; 2 provider tests moved to the batched head lookup. Lint: ~600 findings from upstream's design-token rules, almost all in board UI (see decisions). 1 pre-existing test failure (`t3ProjectFile.test.ts`, from #175) cleared.                                                                                                                                                                | Merge + resolution ≈ 1 h; fixes ≈ 45 min; verification (7 per-package typechecks; 3,491 server / 1,553 web / 3,616 package / 245 mobile tests; both lint passes; the boot-time database sequence twice against copies of real data) ≈ 50 min.                                                               |
| 2026-10-20 | 1,051 commits to tag `v0.1.0` (`81493efb7`, the first orchestration-v2 release); card `T3O-59`                                                          | **52 files** (39 content, 13 modify/delete). The deletions were all v1 or gh-CLI files carrying seams; the content conflicts were the usual registries plus `ChatView.tsx`, `server.ts`, `serverRuntimeStartup.ts`, `ws.ts`, `serviceLauncher.ts` and the GitHub API rewrite.                                                                                                                                                                                                                                                                                                           | Deletions taken; seams re-applied at their new homes (see decisions). The real work was the port: `ThreadGatewayV2`, the board server layer, MCP and RPC re-declarations, the v2 board test stack, usage limits on v2's failure class.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | One long session: merge ≈ 1 h; port, tests and boot checks the rest.                                                                                                                                                                                                                                        |

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
- **Launcher protocol.** The fork is at `SERVICE_LAUNCHER_PROTOCOL = 4`: upstream's `3` plus the
  multi-database backup (`t3o-26`). The fork's number must stay ahead of upstream's, so an upstream
  bump is a _semantic_ conflict even when it merges cleanly. Check `cloud/serviceProtocol.ts` on
  every sync (see the `v0.0.45` decisions).
- **`migrate-dev-db`** (new upstream script) rebuilds and migrates `state.sqlite` only. It neither
  copies nor migrates `boards.sqlite`. Follow-up, not blocking.
- **Adopted in `T3O-47`:** upstream's `apps/server/src/pullRequest/` module. See the decisions
  recorded on that card below.

### Decisions recorded on the `v0.0.42` sync (`T3O-46`)

- **The squash incident and the graft.** The `v0.0.38` sync was squash-merged (PR #57), which cost
  this sync 891 conflicts until a `git merge -s ours v0.0.38` graft restored the ancestry (50
  after). The graft is the first commit of the sync; the runbook above now carries both the
  never-squash landing rule and the repair.
- **Forgejo: upstream's implementation, not ours.** Upstream shipped Forgejo/Gitea support
  (`fj` + `tea`, `6fd68f5c3`) at the same file paths as the fork's `fgj`-based `t3o-28`, and its new
  `pullRequest/ForgejoPullRequestProvider.ts` imports symbols only its own `ForgejoCli.ts` exports.
  The fork's 15 Forgejo files and all 26 registration markers are retired. What the board still
  needed — `mergeChangeRequest` and the `changeRequestMergeState` refusal probe, neither of which
  upstream's `sourceControl` provider has — lived in fork-owned `sourceControl/forgejoMerge.ts` +
  `forgejoMergeState.ts`, hung off the provider by one spread, until `T3O-47` retired both by
  moving the board onto upstream's `pullRequest/ForgejoPullRequestProvider.ts`.
  **`ForgejoCli.ts` and `ForgejoSourceControlProvider.ts` now carry no fork edit at all.**
  Operational consequence: a Forgejo server must be signed in with `fj` or `tea`; an `fgj` login
  no longer counts.
- **Upstream's `pullRequest/` module was not adopted on this sync** — deferred to card `T3O-47`. A
  250-line architectural move inside a 50-file merge would have made any auto-merge regression
  ambiguous between the two.
- **The `ws.ts` shell-coalescing seam and the per-database cursor batches are gone (`T3O-56`).**
  Both existed because board events rode upstream's event stream and projection pipeline. Board
  deltas now come from the board engine and the board's tail of upstream's log, on the board's own
  `board.subscribeBoard` stream (`T3O-57`), so `ws.ts` coalesces exactly as upstream does and the
  pipeline commits upstream's cursors with upstream's own repository.
- **A pinned GitHub credential outranks `gitenv`.** Upstream's `PinnedGitHubCredential` sets
  `GH_TOKEN` on the calls it verifies; `VcsProcess` now applies the per-project token only when the
  caller did not set one.
- **`GitHubApi.credential` must still consult gitenv (`T3O-67`).** Upstream resolves the API
  transport's token per host, so a sync that rewrites `credential`, the providers' returned objects
  or the head-lookup resolver can silently drop the seams. Board merges then run as the ambient
  account and GitHub refuses them. After every sync, check that `credential` calls
  `t3oGitenvCredential` after the pinned check and that both GitHub providers return through
  `t3oWithGitenvProject`. `t3oGitenvCredential.test.ts` fails if the first goes.
- **The board's model-row menu is its own component.** Upstream extracted `runtimeModeConfig` and
  rebuilt `CompactComposerControlsMenu` around composer-only plumbing, so the fork's
  `AccessLevelPicker` is deleted and the `t3o-27` menu reuse moved to fork-owned
  `settings/BoardModelControlsMenu.tsx`. `ChatComposer.tsx` and `CompactComposerControlsMenu.tsx`
  are upstream's again, bar one marked `attention` variant.
- **`docs/internals/scripts.md` was deleted upstream**; accepted. Its one fork section (the
  fork-owned `scripts/kill-dev.ts`) moved to `docs/t3o/dev-ports.md`.
- **Headless boots were narrowed on purpose.** A full server on a copy of live board data starts a
  second supervisor with real credentials, which could spawn agents or merge real pull requests.
  The check run instead is the boot-time database sequence itself (`makeSqlitePersistenceLive`:
  attach, upstream migrations, board migrations) plus a decode of the shell and command read
  models, twice, against `VACUUM INTO` copies: upstream ledger 43 → 52, board ledger steady at 43,
  both integrity checks `ok`, 866 threads and 111 cards read back. A supervisor kill-switch for
  sandboxes would let the next sync boot for real.

### Decisions recorded on adopting `pullRequest/` (`T3O-47`)

The board's merge path was hand-rolled through `SourceControlProvider` because, when `t3o-16` was
written, upstream had nothing that merged a pull request. `v0.0.38` shipped
`apps/server/src/pullRequest/` — a whole provider layer with `runAction`, a mergeability model,
viewer permissions and per-host capabilities — and made every line of it redundant.
`BoardPullRequestGateway` now delegates all three of its methods to upstream services and the
fork owns no forge-merge code below it.

| Board operation | Was                                                                                                                                             | Is                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `find`          | fork's `GitManager.findBranchPullRequest`                                                                                                       | upstream's `GitManager.branchPullRequest`, after `invalidateStatus` on a forced lookup |
| `merge`         | `GitManager.mergeBranchPullRequest` → `SourceControlProvider.mergeChangeRequest` → five provider implementations → `GitHubCli.mergePullRequest` | `PullRequestService.runAction({ action: "merge", mergeMethod })`                       |
| `mergeState`    | `changeRequestMergeState` → `gitHubMergeState.ts` / `forgejoMergeState.ts`                                                                      | `PullRequestService.detail` → fork-owned `board/boardMergeState.ts`                    |

- **The board merges on every host upstream supports now.** The fork had implemented merging for
  GitHub and Forgejo and stubbed the rest out with "supported for GitHub only". Upstream's
  providers cover GitLab, Bitbucket and Azure DevOps as well, so those stubs are gone rather than
  reimplemented, and `runAction` refuses a strategy the host does not offer instead of silently
  merging with the host's default.
- **A pull request is addressed by project, not by checkout.** `PullRequestRef` wants
  `{ projectId, repository }` where the fork's path passed a `cwd`. The gateway resolves
  `repository` with `sourceControlRepositorySelector(project.repositoryIdentity)` — the same
  expression `PullRequestService.listWorkspaceProjects` uses on its own side, so the two can never
  disagree about what a project's repository is. Nothing is persisted on the card and no migration
  was needed.
- **The forge's verbatim refusal is gone, deliberately.** `VcsProcessExitError` drops a
  subprocess's stderr on purpose (it can carry credentialed URLs), so a refused `gh pr merge`
  through upstream's path reports "Process exited with a non-zero status." The fork's
  `allowNonZeroExit` + `GitHubPullRequestMergeRefusedError` existed only to keep that text. The
  board now asks the host WHY instead: one `detail` read after a refusal, mapped to a merge state,
  which decides the conflict route AND writes the card's sentence. That is what `T3O-38`'s own doc
  comment always said the decision should key on — `isMergeConflictRefusal`'s prose matching is
  retired with it.
- **"Blocked with everything green" is now read by elimination.** GitHub's `mergeStateStatus`
  is not in upstream's detail, and its `mergeability` speaks only about conflicts. But the probe
  runs only after a refusal, so a pull request the host reports as mergeable, green, ready and up
  to date, that it nonetheless refused, was refused for a reason it does not report: an approval, a
  protection rule, an unresolved conversation. All need a person, so that is `approval-required`.
  Guarded on a definite `baseComparison: "up-to-date"` — every host but GitHub reports no
  comparison, and a branch that is merely behind must stay soft.
- **…which is only sound when the HOST is the one that refused.** Upstream refuses several things
  itself, before any host is asked: a merge strategy or an action outside
  `capabilities.mergeMethods` / `capabilities.actions`, a permission the viewer lacks. A missing
  CLI, a missing credential and a rate limit stop the request as well. Each carries a sentence that
  names the fix, and each would leave the elimination above reading a pull request that was never
  the problem — a squash-disabled repository would park every card as "needs an approval". So the
  gateway tags a refused merge with `BoardPullRequestRefusal`: `host` is the only one worth a probe,
  `blocked` stops the ladder on the spot with upstream's own words (the same bucket as a closed
  pull request, D8), and `unavailable` shows those words and keeps climbing. `PullRequestService`
  buckets both its own pre-flight refusals and the host's into `PullRequestOperationError`, so the
  three are told apart by its `cause`: a `PullRequestProviderError` is the host's answer, its
  absence is upstream's own. A viewer-permissions LOOKUP that fails is indistinguishable from the
  host's "no" at this seam and is still probed — the residual, and the narrow one.
- **One optional field is the whole price.** The ladder resets on a new head sha (`T3O-38`, D9) and
  upstream's `PullRequestDetail` carries none, although GitHub's provider already reads
  `headRefOid` and spreads it. Three one-line `T3o:` markers carry it through
  (`contracts/pullRequest.ts`, `PullRequestProvider.ts`, `PullRequestService.ts`); everything else
  in this card is deletion.
- **The probe invalidates before it reads.** `runActionAndInvalidate` bumps the detail cache's
  epoch only after a SUCCESSFUL action, so a refusal would otherwise be explained by a detail read
  up to fifteen seconds before the merge was attempted. The gateway calls `invalidate({ reference })`
  and reads with `allowStale: false`.
- **`BoardGitLayerLive` is retired.** The gateway needs `PullRequestService` as well as
  `GitManager`, and both already sit in `RuntimeCoreDependenciesLive`. One inserted
  `Layer.provideMerge(BoardPullRequestGatewayLive)` above them replaces the substitution, and
  `server.ts` gets upstream's `Layer.provideMerge(GitLayerLive)` line back. The pipe was at
  thirteen arguments, not the twenty the old comment feared.

Measured: **196 → 178 markers** across upstream-owned files, and 96 → 91 upstream-owned files
differing from `v0.0.42` at all. Four files became pure upstream again
(`contracts/sourceControl.ts`, `SourceControlProvider.ts`, `ForgejoSourceControlProvider.ts`,
`SourceControlProviderRegistry.ts`), as did the three non-GitHub provider stubs and
`SourceControlRepositoryService.test.ts`. `GitHubCli.ts` went 18 → 6, all `T3O-48` repository
pinning. Five fork-owned files were deleted outright (`gitHubMergeState.ts`, `forgejoMerge.ts`,
`forgejoMergeState.ts` and two test files); `board/boardMergeState.ts` is the one added.

### Decisions recorded on the `v0.0.45` sync (`T3O-54`)

- **`v0.0.45` is the last orchestration-v1 release.** `v0.1.0` deleted orchestration v1 and
  replaced it with `orchestration-v2`, which everything the board builds on depends on. Syncing past
  `v0.0.45` is a port, not a merge, and is card `T3O-55`.
- **The squash happened a second time, and was grafted again.** PR #110 landed the `v0.0.42` sync
  as a squash, so `git merge-base t3o upstream/main` had fallen back to `0640410726` (2026-08-08).
  The sync branch opens with `git merge -s ours v0.0.42` (empty diff, verified), which took the
  conflict count to 24. `origin/main` had also been left at `v0.0.38`; the landing commands push
  the mirror and the tag.
- **Launcher protocol 4.** Upstream bumped `SERVICE_LAUNCHER_PROTOCOL` to `3` for the standalone
  executable layout, the same number the fork already used for the multi-database snapshot. It
  merged as a one-comment conflict, but keeping `3` would have let an upstream `v0.0.43+` launcher,
  which snapshots only `state.sqlite`, trial a fork server and roll back with `boards.sqlite`
  migrated forward. The fork is now at `4`, and `servicePreflight.test.ts` carries a marked `3` in
  its blocked list. Existing fork installs need their launcher updated once, which is exactly what
  preflight's exact-match block asks for.
- **The `T3O-8` missing-scope fallback now covers GraphQL.** Upstream reads a pull request's detail
  through one GraphQL document that asks for team review requests and the check rollup, and GitHub
  refuses the whole document over either. The fork's `withReviewScopeFallback` now wraps that read
  too: it drops `reviewRequests`, then the `commits` connection carrying the rollup, from the
  document, and fills them back in empty before decoding (fork-owned
  `pullRequest/t3oGraphQlScopeFallback.ts`). A detail read without the rollup is marked
  `checksUnread`, as before. Upstream's batched summary read already falls back to one `gh pr view`
  per pull request when the batch fails; that per-entry read keeps the fork's field fallback.
- **The batched head lookup honours the `T3O-48` origin pin.** Upstream's new
  `GitHubCli.listPullRequestsByHead` picks its repository the way `gh` does, which in a fork is the
  `upstream` parent. It now takes the pinned `repository`: on the lookup's own host it replaces the
  guess, on another host the lookup stays on `gh` with `--repo`, and the batch's per-head `gh`
  fallback names it too (`t3oPinnedHeadRepository` in `githubRemote.ts`).
- **PR lookup TTLs.** Upstream now caches "no open PR" answers for five minutes and open ones for
  one. The `T3O-45` rule still runs first: an answer that never reached the forge is not cached.
- **The board snapshot wrapper passes options through.** Upstream's background sweeps read
  `getShellSnapshot({ unsettledOnly: true })`; the board's wrapper took no options, so every sweep
  read every thread. Three upstream tests caught it.
- **Upstream's design-token lint rules are off for fork-owned web files.** `v0.0.43`–`v0.0.45`
  rolled out `shadcn/no-arbitrary-values`, `no-restyle`, `no-raw-colors` and
  `require-static-classes` across `apps/web`. The board UI produced about 600 findings, almost all
  pixel sizes and restyles on ui components. Restyling the board onto the tokens is a redesign, not
  sync fallout, so one marked override in `vite.config.ts` turns those four rules off for
  `apps/web/src/board/**` and `components/settings/Board*.tsx` only. The board's pull-request icons
  moved onto `PullRequestGlyph`, which the restricted-import rule asks for.
- **Upstream removed `SheetPanel`, `viewportClassName` and `inputClassName`** from the ui
  components. Board popovers use `padding="none"`; the archived-cards sheet keeps a local scrolling
  body; the card sheet keeps T3O-51's 0.5rem short-screen sliver with a negative margin into the
  dialog viewport's padding instead of overriding the padding.
- **Mobile `threadPresentation.ts` was deleted upstream**, with the legacy grouped thread list. The
  fork's violet "awaiting input" lived there; the surviving v2 list already carried the fork's
  violet/blue palette, so the deletion was accepted.
- **Boot check, as on `v0.0.42`:** the boot-time database sequence plus a decode of the shell and
  command read models, twice, against `VACUUM INTO` copies of real data. Upstream ledger 52 → 54,
  board ledger steady at 43, both integrity checks `ok`, 966 threads and 121 cards read back; the
  second boot ran no migration.

### Decisions recorded on the `v0.1.0` sync (`T3O-59`)

`v0.1.0` deleted orchestration v1 (`orchestration/`, `persistence/Layers/*`,
`contracts/orchestration.ts`, the Claude/Codex/ACP runtimes) for `orchestration-v2`. The board
reaches it only through `board/ThreadGatewayV2.ts`; everything else here is wiring.

- **`ThreadGatewayV2` replaces `ThreadGatewayV1`.** Commands go through
  `ThreadManagementService.dispatch` (upstream's enablement chokepoint); reads come from
  `ProjectionStoreV2` / `ProjectStoreV2` / `ProjectService`; signals and the todo log read
  `EventSinkV2.stream`, unbounded, not the bounded RPC variant (`streamStoredEventsFrom`), which may
  drop a slow subscriber and strips payloads for the wire. A board-minted `commandId` still tells
  the board's turns from a human's; a v2 usage-limit resume (`limit-resume:`) reads as a human
  restart, which is what un-parks the step. The v1 tolerance (`decodeReadRow`, the retired-board
  skip) went with the v1 event store. `ThreadGatewayV2.contract.test.ts` runs the contract against
  the real v2 engine (no provider), on the rebuilt `boardStack.testkit.ts`.
- **`spawn` does not use `ThreadLaunchService.launch`.** Its preparation runs the project's setup
  script on every launch — into an existing worktree and at the project root too — so each review
  phase would re-run `vp i` and planning would run it in the main checkout. A spawn is `launch`
  minus preparation: `thread.create`, then `message.dispatch` with `start_immediately`. Planning
  (branch `null`) creates the thread with no worktree (D6). v2 does not check that a thread's project
  exists, so the gateway does before it creates one.
- **One board server layer.** `board/serverLayer.ts` carries the supervisor, engine, queries,
  todo tail, forge gateway, worktree retirer and gateway into `layerRuntimeCoreDependenciesBase`
  with one seam, provided `RuntimeLayer.layerEventSink` — the same layer value the orchestrator is
  built from, so the runtime builds one `EventSinkV2` and the gateway hears its live events.
- **The supervisor starts after v2's restart recovery** (`board.supervisor.start`, after
  `orchestration-v2.recovery`), so the boot reconcile reads a run the restart killed as dead.
- **Usage limits are v2's failure class.** `UsageLimitDetector` stays as the stubbable seam the
  supervisor suites drive, but reads `class: "usage_limit"` and `resetAt` off the thread instead of
  matching provider prose. A limited board step parks as before and arms v2's own
  `limitRecovery` with `autoResume` on its thread (`armLimitRecovery`), so v2's recovery worker
  resumes it whatever the user's global setting; `boardWokenLimitParks` keeps the board's probe
  and cooldown lift from waking a park v2 will resume, so it is resumed once. A limit with no reset
  time is never armed by v2, and the board's blind poll still covers it. Provider-limit records
  still hold new spawns and colour the card.
- **Board MCP tools are declared through `McpToolAccess`.** Reads are `readsAsCaller`, writes
  `writesWithCapability`; every tool needs a T3 thread caller, resolved with `requireThreadScope`,
  and its failure schema admits `OrchestratorMcpFailure`. Registration is
  `toolkitRegistration(BoardToolkit, …)` in `McpHttpServer.ts`; `"board"` joined
  `ALL_MCP_CAPABILITIES`. The boundary suite now sees `orchestration-v2/` (its regex had only
  matched `orchestration/`, so it was blind to v2) and allows the tools' dependency on
  `ThreadManagementService`, which `McpToolAccess` requires.
- **Board RPCs** keep their own scope check but drop their `observeRpc*` wrappers for upstream's
  `RpcInstrumentation` middleware, and spread `BOARD_RPC_AGGREGATES` into `RPC_AGGREGATES`. The two
  subscriptions return a `Stream`. With the board's RPCs in `WsRpcGroup`, the CLI's inference
  through the whole server layer graph gave up as `any` (one extra RPC was enough); `runServer` in
  `server.ts` now carries an explicit type.
- **`boards.sqlite` gets a pre-v2 copy.** The first v2 boot copies `state.sqlite` to
  `statev2.sqlite` and leaves it; `boards.sqlite` is migrated in place. `backupBoardDatabaseBeforeV2`
  takes one SQLite backup to `boards.pre-v2.sqlite` before anything writes, keyed on board
  migration 045 (a no-op whose absence marks a ledger a v1 build left). The board stays attached to
  upstream's writer connection, at a path derived from the main file's directory, which is
  `statev2.sqlite`'s. Upstream's reader worker is opt-in (`readOnly`) and the board never uses it.
- **Card thread state reads v2 shells** through `@t3tools/shared/boardThreadState`, used by the
  client overlay, the web board and the gateway alike. A run in `waiting` has finished its provider
  turn and only awaits its checkpoint; background work that does not wake the agent (a command left
  running) no longer reads as a background wait, following upstream (#14872).
- **`T3O-48` and `T3O-8` moved with GitHub support** into `packages/source-control-github`, which
  talks to GitHub's API, not `gh`. The origin rule is a one-line seam in
  `resolveGitHubRepository` (`t3oOriginRepository.ts`), and it beats a `gh repo set-default` mark,
  as the fork's pin did; three upstream provider tests carry marked origin expectations. The scope
  fallback (`t3oGraphQlScopeFallback.ts`) wraps the core detail read and recognises GitHub's
  refusal by message, since the API client keeps messages, not error types. The summary read,
  batched and single, keeps `T3O-54`'s fallback through `readSummariesWithScopeFallback`, which
  drops the check rollup on a scope refusal. The gh-CLI origin pin (`githubRemote.ts`) is gone.
- **`T3O-47`'s `headSha` seams are retired.** Upstream `v0.1.0` declares `headSha` on
  `PullRequestDetail` and carries it through `PullRequestService` itself.
- **`t3o-34` gitenv moved to `@t3tools/shared/gitenv`** so the ACP package can reach it; the agent
  seams sit on the v2 Claude query options, the Codex app-server spawn and the ACP spawn env.
- **Project scripts.** `ProjectScript` moved to `contracts/project.ts` and upstream added
  `runOnSettle`; `runOnWorktreeRemove` sits beside it. The mobile menu label moved to
  `shared/projectScripts.ts` upstream and the `(teardown)` seam moved with it. The web
  `newProjectScriptInputFromFile` helper went: upstream's two import paths now differ.
- **Web.** The embedded card chat drops `BoardRestingComposerControlsStrip`: upstream's model
  strip mounts whenever the context strip does not, which is the embedded case. Upstream's new
  rules (`no-test-in-loop`, `no-raw-resize-observer`, `no-outset-state-indicators`,
  `prefer-catch-tags`) were applied to board code.
- **Upstream tests with fork expectations:** `Sqlite.test.ts` (with `boards.sqlite` attached,
  `optimize` samples, so the rows-per-key statistic is an estimate),
  `McpSessionRegistry.test.ts` (the `board` capability), `registration.test.ts` and
  `serverRuntimeStartup.autoPull.test.ts` (board service mocks).
- **Boot check.** Two boots against `VACUUM INTO` copies of real data, with no provider
  credentials (an empty `HOME`, no `GH_TOKEN`) so nothing reached a provider or a forge: upstream
  ledger 54 → v2 with no fork id ≥ 55 (`assertV2MigrationsCanRun` passed), 1,025 v1 threads and
  23,186 messages imported, board ledger 43 → 45 with 6,390 board events in the board's own log,
  `boards.pre-v2.sqlite` kept, all 699 live card→thread links resolving in v2. The one running step
  (whose run vanished at the upgrade) was read as dead and parked for retry. The second boot ran
  no migration or import and left the backup alone.

### Unmarked edits (debt)

Upstream-owned files the fork changes **without** a `T3o` marker, measured after the `v0.0.45`
merge (`git diff --numstat v0.0.45 HEAD`, files present in `v0.0.45`, excluding `.plans/` and
`.repos/`; 108 upstream-owned files differ in all, 93 of them marked). These are where the next
sync's non-seam conflicts will come from. Tests, docs and generated files are listed for
completeness; the code rows are the ones worth seaming.

| File                                                                                                                                                             | +/−      | Owner / what                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------- |
| `packages/contracts/src/git.ts`                                                                                                                                  | 5/1      | board PR lookup                 |
| `apps/web/src/main.tsx`, `apps/web/src/appearanceFonts.ts`                                                                                                       | 5/0, 4/1 | DM Sans font                    |
| `vite.config.ts`, `package.json`, `scripts/dev-runner.ts`, `apps/web/package.json`                                                                               | ≤6       | tooling                         |
| `apps/web/src/components/chat/TraitsPicker.tsx`                                                                                                                  | 1/1      | export                          |
| tests: `serviceLauncher.test.ts` (159), `shared/serverSettings.test.ts` (93), `GitManager.test.ts` (58), `GitHubCli.test.ts` (140), `settingsSearch.test.ts` (6) |          | fork test additions             |
| docs: `docs/user/thread-sidebar.md` (+6)                                                                                                                         |          | the Board/Threads tabs section  |
| docs: `docs/user/project-settings.md` (+3)                                                                                                                       |          | the `T3O-23` remove-script flag |
| generated: `apps/web/src/routeTree.gen.ts` (+63), `apps/mobile/generated-uniwind-themes.css` (+12), `pnpm-lock.yaml` (+10)                                       |          | regenerate / reinstall          |

Cleared on the `v0.1.0` sync: `contracts/model.ts` (upstream's `providerPolicy.ts` now owns
`RuntimeMode`), `serviceLauncher.ts` (now marked) and `GitHubCli.test.ts` (deleted upstream).

Cleared on the `v0.0.45` sync: `cloud/serviceProtocol.ts` (now marked, protocol 4).

Cleared on the `v0.0.42` sync: `CompactComposerControlsMenu.tsx` and the `ChatComposer.tsx` picker
extraction (both upstream's again — see the decisions above), `GitManager.ts`, `VcsProcess.ts`,
`SourceControlProvider.ts`, `GitHubSourceControlProvider.ts`, `contracts/sourceControl.ts`,
`t3-sqlite-state.ts`, `cli/config.test.ts`, `server/serverSettings.test.ts` and
`docs/internals/server-updates.md` (now marked), and `docs/internals/scripts.md` (deleted upstream).

Cleared by `T3O-47`: `SourceControlProviderRegistry.ts`, the three non-GitHub
`*SourceControlProvider.ts` stubs and `SourceControlRepositoryService.test.ts` — the whole
unsupported-provider apron of the hand-rolled merge path. They are byte-identical to `v0.0.42`
again.

### Marker census

The row table below is maintained by hand and lags. The authoritative count is per file, from
`git grep -c "T3o:"` restricted to files that exist in the synced upstream tag. After the `v0.0.42`
sync (`T3O-46`): **177 markers across 66 upstream-owned files**, down from 206 across 73 the moment
before it — the Forgejo retirement removed 38 (26 registrations + 12 in tests) and the sync added 9:
`ForgejoSourceControlProvider.ts` 2 (the merge-seam import and spread), `ComposerBanner.tsx` +2 (3;
the `attention` variant's two maps), `GitManager.ts` +1 (4; `askedForge` on upstream's new skip
path), `OrchestrationEventStore.ts` +1 (10; rows-scanned paging on `Stream.paginate`),
`OrchestrationEventStore.test.ts` +1 (2), `settingsSearch.ts` +1 (5; the board page's scope),
`docs/internals/server-updates.md` 1, and three upstream tests that now carry a marked fork
expectation — `McpSessionRegistry.test.ts` 1 (`"board"` capability), `ProjectionPipeline.test.ts`
1 (cursor batch is 3 statements), `serverSettings.test.ts` 1. `McpInvocationContext.ts` went 2 → 1:
upstream generalised `requireMcpCapability`, so the fork's note explaining why it stayed
`"preview"`-only was obsolete and is gone.

After the `v0.0.45` sync (`T3O-54`): **214 markers across 81 upstream-owned files**, from 206
across 77 the moment before it (cards since `v0.0.42` had added 29). The sync added 8:
`GitHubCli.ts` +4 (10; the batched head lookup's `repository` input, its request field, its `gh`
fallback args and the pin itself), `serviceProtocol.ts` 1, `servicePreflight.test.ts` 1,
`GitHubSourceControlProvider.test.ts` 1, `t3ProjectFile.test.ts` 1 and `vite.config.ts` 1 (the
design-token override). `threadPresentation.ts` and its 1 marker were deleted upstream. The
`GitHubPullRequestCli.ts` fallback markers use the `T3o (T3O-N):` form, which this metric does not
count.

The board's own engine (`T3O-56`): **190 markers across 74 upstream-owned files**, from 214
across 81. Seven files left the diff entirely — `orchestration/decider.ts`, `projector.ts`,
`commandInvariants.ts`, `Layers/OrchestrationEngine.ts`, `Layers/ProjectionPipeline.ts`,
`ProjectionPipeline.test.ts` and `Services/OrchestrationCommandReceipts.ts` — and
`contracts/orchestration.ts` went 18 → 12 as the board's event types, aggregate kinds and
aggregate ids left upstream's unions. `OrchestrationEventStore.ts` 10 → 9 (the `streamId`
widening went; the `decodeReadRow` tolerance stays, now skipping every `board.*` row, until the
orchestration-v2 merge). `ws.ts` 13 → 11: the board's shell deltas, the actor stamp and the board
dispatch route moved behind one board-owned `boardClientConnection`. Added: `server.ts` +1 (the
board runtime layer), `server.test.ts` +1 (its mocks), `shell.ts` +2 (board deltas skip the shell's
sequence guard). `shellCoalesce.ts` was fork-owned and is deleted.

The board's own subscription (`T3O-57`): **171 markers across 72 upstream-owned files**, from 190
across 74. `ProjectionSnapshotQuery.ts` and `shellReducer.ts` left the diff entirely (as did the
`T3O-56` test in `shell-sync.test.ts`, which used the uncounted `T3o (T3O-N):` form).
`contracts/orchestration.ts` 12 → 3: every board field on the shell snapshot and read model, the
board delta and client-command spreads, and their import are gone; what stays is the `RuntimeMode`
move and `runOnWorktreeRemove`. `ws.ts` 11 → 7: the client connection, the dispatch route and the
three shell-stream seams went; the board's RPCs, including dispatch and subscription, come in
through the one `boardRpcHandlers` spread. `client-runtime/state/shell.ts` 3 → 1 (only the
re-export stays). `BoardOrchestrationReadModel` (`board/projector.ts`) is upstream's read model
with the board slice on it, now that `board` is off upstream's read model schema; after `T3O-58`
only decider test fixtures still build one.

The thread gateway (`T3O-58`) added 2: `server.ts` +1 (the v1 gateway layer, provided below the
board's PR gateway and worktree retirer, which both read through it) and `server.test.ts` +1 (its
mock). `ws.ts` is untouched: the board's RPC handlers resolve the gateway themselves. Everything
else the board knew about threads moved into `board/ThreadGatewayV1.ts`, the one board file
allowed to import upstream orchestration, persistence or provider code.

For reference, the `v0.0.38` sync stood at 121 markers across 44 files. Counts recorded then that
differ from their rows in the table below:
`serverSettings.ts` 2 (indivisible settings keys), `GitHubCli.ts` 7 (board merge path),
`AppSidebarLayout.tsx` 3 (`isOnBoard`), `server.ts` 4 (+`BoardGitLayerLive`, retired by `T3O-47`),
`ChatView.tsx` 5
(+`chrome` prop), `contracts/orchestration.ts` 16 (+`RuntimeMode` re-export), `.gitignore` 1
(`!.plans/`), `AGENTS.md` 5 (+plans policy), `Sqlite.ts` 2 (`t3o-26` attach + board migrations),
`OrchestrationEventStore.ts` 7 (`t3o-26` retired-event replay), `server.test.ts` 1 and
`orphanedProviderSessionStartup.integration.test.ts` 2 (supervisor reactor mocks),
`OrchestrationEventStore.test.ts` 1.

T3O-17 added 2 markers, both in `OrchestrationEventStore.ts` (7 → 9): the import of the shared
command-id origin rule and the `inferActorKind` call that replaced its two inline prefix tests.
`contracts/commandOrigin.ts` is a new T3o-owned file exported under `contracts/index.ts`'s existing
board-schema marker. The board-side halves — the steer signal, the Stop handover and the sweep's
pending-turn guard — are all in board-owned files.

Brief attachments (`t3o-32`) added 6 markers: `contracts/assets.ts` 1, `AssetAccess.ts` 4 (import,
claims member, mint case, resolve branch) and `ws.ts` +1 (6). The upload, storage, claim and
manifest all live in board-owned files (`board/attachments.ts`, migration `032`).

Auto-merge's structured refusal probe (`T3O-38`) added 12 markers across 9 upstream-owned files,
all of them the same shape as the `t3o-16` merge path they sat beside. **`T3O-47` removed every one
of them**, along with the `t3o-16` merge path itself: the probe now reads upstream's
`PullRequestService.detail`. What survives is one marker in each of `contracts/pullRequest.ts`,
`PullRequestProvider.ts` and `PullRequestService.ts`, all three the same optional `headSha`
field (retired on the `v0.1.0` sync, which carries it natively). Everything the board DOES with the answer was already in fork-owned files and stayed there:
the mapper (`board/boardMergeState.ts`, which replaces `sourceControl/gitHubMergeState.ts` and
`sourceControl/forgejoMergeState.ts`), the classifier (`board/autoMergeClassification.ts`), the
gateway (`board/BoardPullRequestGateway.ts`) and the reactor.

Pinning `gh` to the project's origin repository (`T3O-48`) touched 2 upstream-owned files. By the
census metric (`git grep -c "T3o:"`): `GitHubCli.ts` 10 → 18 and `GitHubSourceControlProvider.ts`
1 → 3. `T3O-47` then took `GitHubCli.ts` to 6 and `GitHubSourceControlProvider.ts` to 2, because
the `pr merge` and merge-state `pr view` invocations it pinned no longer exist here — upstream's
`GitHubPullRequestCli.repositoryArgs` pins those itself.

`GitHubCli.ts` carries the import, the `repository` member on the service interface, and one marker
per remaining `gh` invocation — `pr list`, `pr view`, `pr create`, `pr checkout` and `repo view`.
`GitHubSourceControlProvider.ts` carries the import and the non-open list path, which builds its
own args and calls `execute` directly. The parser and both arg helpers are in the new fork-owned
`sourceControl/githubRemote.ts`, which mirrors `forgejoRemote.ts`; `ForgejoCli.ts` already pinned
its own repository and needed nothing.

`repo view` is the odd one out, the same way it is for Forgejo: it takes the repository
POSITIONALLY and has no `--repo` flag, so `gitHubRepositoryPositionalArgs` flattens the pair into
the one argument the command accepts. Both forms are host-QUALIFIED (`github.com/owner/repo`),
matching upstream's own `GitHubPullRequestCli.repositoryArgs`, so a GHES repository cannot collide
with a same-named repository on github.com. An unresolved remote adds no argument at all, leaving
every invocation byte-identical to what it was before.

The bug this closed: `gh` resolves the base repository itself when no `--repo` is given, and its
rule PREFERS a remote literally named `upstream`. This repository gained that remote during the
`t3o-31` sync, so from then on every board pull request lookup asked `pingdotgg/t3code` and
truthfully answered "no pull request" — and a Merge click would have merged upstream's PR of the
same number. The rule the card settled: **T3 Code acts on the project's `origin` remote, always**,
the same default as plain `git push`, with no `gh repo set-default` read and no fallback to gh's own
guess. `SourceControlProviderRegistry.selectProviderContext` already resolves an origin-preferring
context; only the GitHub provider was ignoring it.

**The same bug one level up (`T3O-24`).** Upstream's `RepositoryIdentityResolver.pickPrimaryRemote`
prefers `upstream` over `origin` on purpose: a contributor-style fork opens its pull requests
against upstream. Once `T3O-47` routed the board through `apps/server/src/pullRequest/`, which
addresses a project by that identity, Merge on a T3o card targeted `pingdotgg/t3code#N` and linking
the fork's own pull request was refused. The resolver is left alone, because changing it would
regress those contributor forks. Instead the board resolves its own repository from `origin` in
`board/boardRepository.ts` and passes `host` on every `PullRequestService` reference, which routes
an explicitly hosted repository. One marker in `PullRequestService.requireProject` makes that route
prefer the referencing project's own checkout over the first one on the host, so the fork's pull
requests run with that project's credentials. Card keys restart, so a board branch can carry an
earlier card's closed pull request. A marker in `GitManager.findLatestPrForHeadContext` therefore
picks the PR that closed last when none is open, not the one updated last. A late comment on the
earlier PR would otherwise win. The Threads view's Pull Requests page
still follows the identity. Board worktrees also get `remote.origin.gh-resolved=base` at worktree
scope when a repo has several remotes and no `gh` default, so agents' own `gh pr create` opens on
origin too. That turns on `extensions.worktreeConfig` in the shared config, which outlives the
worktree, so it is done only at `core.repositoryformatversion` 0, where no tool can refuse the repo
over it. The pin runs on every build-mode spawn as well as at provisioning, so a worktree that
predates it is pinned before its next agent runs.

Per-project GitHub token overrides (`t3o-34`, see [gitenv](./gitenv.md)) added 15 markers across 7
upstream-owned files: `config.ts` 2 (import + `initGitenv` in `make`, which only `pair` still reaches),
`cli/config.ts` 2 (import + `initGitenv` at the end of `resolveServerConfig`, the real server boot
path), `vcs/VcsProcess.ts` 3
(import, `gh` env merge in `run`, exact-value scrub in `safeProcessOutput`),
`vcs/GitVcsDriverCore.ts` 2 (import + env spread in the git spawn), `Layers/ClaudeAdapter.ts` 2,
`acp/AcpSessionRuntime.ts` 2 and `Layers/CodexSessionRuntime.ts` 2 (import + env merge at each
agent-session spawn). All the logic lives in the new `sourceControl/gitenv.ts`; every seam is an
import or a one-expression env merge.

`T3O-67` extended gitenv to the server's own GitHub API calls, which since `v0.1.0` carry the merge
and every PR read over HTTP rather than through `gh`. It added 14 markers across 5 upstream-owned
files: in `packages/source-control-github`, `GitHubApi.ts` 3 (import, the delegating check in
`credential`, and a 401 that leaves the ambient cache alone when the gitenv token was refused),
`GitHubPullRequestProvider.ts` 2 (import + the wrapped return), `GitHubSourceControlProvider.ts` 3
(import, wrapped return, batch-key entry) and `GitHubPullRequestApi.ts` 3 (import + the summary and
watch-fingerprint batch keys); in `apps/server`, `pullRequest/PullRequestService.ts` 3 (import + the
cross-repository search and stats batches split by gitenv identity). The logic lives in the new
`t3oGitenvCredential.ts`; the token lookup is `gitenvToken` in `@t3tools/shared/gitenv`. The
listing's viewer is still resolved once per host, so with a gitenv project on github.com the
involvement filter ("mine", "review requested") uses whichever identity answered first.

Making the board primary (`T3O-34`) added 7 markers across 3 upstream-owned files:
`__root.tsx` 2 (import + the cold-start guard), `pair.tsx` 3 (import + the two pairing exits) and
`SidebarChrome.tsx` 2 (import + the mode-tabs slot). `SidebarChrome.tsx` was pristine upstream
before this card, so its two rows are new rather than restored. Every seam is an import or a
one-expression delegation; the redirect rule, the fit measurement and the corner menu all live in
board-owned files (`boardHomeRedirect.ts`, `modeTabsSlot.ts`, `BoardModeTabsSidebarSlot.tsx`,
`BoardUtilityMenu.tsx`). The corner menu deliberately **mounts** upstream's `SidebarUtilityMenu`
rather than seaming into it, so the board and the sidebar footer cannot drift apart.

The **unified status palette** (see [Status colours](./status-colours.md)) added 12 markers across
9 upstream-owned files, 8 of them newly marked: `apps/web/src/index.css` 3 (the `--attention`
token), `Sidebar.logic.ts` 1 and `Sidebar.tsx` 2 (thread status pills), `ComposerBanner.tsx` 1 (the
`attention` banner variant) and `ChatComposer.tsx` 3 (+1, the question drawer's variant), plus four
on mobile: `threadPresentation.ts` 1, `thread-list-v2-items.tsx` 1, `widgets/AgentActivity.tsx` 1
and `scripts/generate-uniwind-themes.mts` 1. Every one is a colour-class or token swap — no logic
moved, so all 12 are frozen one-line edits rather than growable seams.

**Forgejo support** (`t3o-28`) once added 26 markers across 13 upstream-owned files (plus 12 in
four test files), all of them a kind literal, a registration, an icon or a label. **All retired on
the `v0.0.42` sync (`T3O-46`)**, when upstream shipped its own Forgejo/Gitea support at the same
paths. The two markers that survived it — the board's merge seams on
`ForgejoSourceControlProvider.ts`, backed by fork-owned `sourceControl/forgejoMerge.ts` +
`forgejoMergeState.ts` — went with `T3O-47`. **The fork now carries no Forgejo code at all.**

---

After the `v0.1.0` sync (`T3O-59`): **150 markers across 70 upstream-owned files**. The v1
seams went with their files (`OrchestrationEventStore.ts`, `persistence/Layers/Sqlite.ts`,
`contracts/orchestration.ts`, `GitHubCli.ts`, `GitHubPullRequestCli.ts`, the v1 provider runtimes,
`server.test.ts`); the inventory's rows for them are replaced by the new homes listed there.

## Seam inventory

Maintained by hand. Every row is one seam in an upstream-owned file: one marker, or the few
adjacent markers of a single edit (an import and its call, `AGENTS.md`'s fork block). Markers in the
`T3o (T3O-N):` form and marked fork test expectations count too. After an upstream merge, every
upstream-owned file `rg -l "T3o"` finds should have its rows here; a marker that vanished is a seam a
conflict resolution silently dropped.

New files are **not** listed — they are ours and they never conflict. Only insertions into
upstream-owned files belong here. (Board-owned files also carry `T3o` headers; they are outside
this inventory.)

Shapes marked **frozen** are once-only edits that never grow again; every other seam is a
predicate, spread, injected factory call, or re-export whose growth happens inside board-owned
files (see [Seam grammar](#seam-grammar-since-t3o-02a)).

| File                                                                            | Spec              | Reason                                                                                                                                               | Shape                                                                     |
| ------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `AGENTS.md`                                                                     | `t3o-01`          | Fork status, branch topology, seam rules                                                                                                             | Self-contained block at the top                                           |
| `AGENTS.md`                                                                     | `t3o-01`          | Rebase-target note (`t3o`, not `main`) in upstream's PR guidance                                                                                     | one-line edit (frozen)                                                    |
| `AGENTS.md`                                                                     | `t3o-01`          | PR-target rule (`t3o`, never `main`) in upstream's PR guidance                                                                                       | one-line edit (frozen)                                                    |
| `README.md`                                                                     | `t3o-01`          | Fork section: what T3o is, and that registries and installers give upstream                                                                          | Self-contained block                                                      |
| `.gitignore`                                                                    | `t3o-01`          | `!.plans/` re-includes the fork's tracked plans under upstream's ignore                                                                              | one-line edit (frozen)                                                    |
| `.gitignore`                                                                    | `npm pack`        | `dist-npm/` ignores `scripts/t3o-pack.mjs` tarballs                                                                                                  | one-line append (frozen)                                                  |
| `apps/server/src/persistence/Sqlite.ts`                                         | `T3O-59`          | Import the board database boot                                                                                                                       | one-line append (import)                                                  |
| `apps/server/src/persistence/Sqlite.ts`                                         | `ledger split`    | Attach `boards.sqlite`, keep its pre-v2 copy and heal legacy layouts before upstream migrations (`initialiseBoardDatabase()`)                        | one-line append (delegating call)                                         |
| `apps/server/src/persistence/Sqlite.ts`                                         | `ledger split`    | Board migration lineage runs after upstream's (`runBoardMigrations()`)                                                                               | one-line append (delegating call)                                         |
| `apps/server/src/persistence/Sqlite.test.ts`                                    | `T3O-59`          | `optimize` stat is an estimate once `boards.sqlite` is attached                                                                                      | marked fork expectation                                                   |
| `apps/server/scripts/t3-sqlite-state.ts`                                        | `t3o-26`          | The state tool attaches `boards.sqlite`, so `board_*` queries resolve                                                                                | import + one delegating call                                              |
| `apps/server/src/server.ts`                                                     | `T3O-59`          | Import the board's server layer                                                                                                                      | one-line append (import)                                                  |
| `apps/server/src/server.ts`                                                     | `T3O-59`          | `BoardServerLive` joins `layerRuntimeCoreDependenciesBase`, given the PR service, projection store and upstream's own `layerEventSink`               | one merge entry (delegating layer)                                        |
| `apps/server/src/server.ts`                                                     | `T3O-59`          | Import the service types `runServer`'s annotation names                                                                                              | type-only imports                                                         |
| `apps/server/src/server.ts`                                                     | `T3O-59`          | `runServer` carries an explicit type: with the board's RPCs in `WsRpcGroup` the CLI's inference otherwise gives up as `any`                          | annotation (frozen)                                                       |
| `apps/server/src/serverRuntimeStartup.ts`                                       | `T3O-59`          | Import `startBoardSupervisor`                                                                                                                        | one-line append (import)                                                  |
| `apps/server/src/serverRuntimeStartup.ts`                                       | `t3o-10`          | Start the supervisor once v2 recovery has settled the runs a restart killed                                                                          | one-line append (delegating call)                                         |
| `apps/server/src/serverRuntimeStartup.autoPull.test.ts`                         | `t3o-10`          | Import and mock `SupervisorReactor`, which startup now starts                                                                                        | import + one mock layer                                                   |
| `apps/server/src/mcp/McpInvocationContext.ts`                                   | `t3o-08`          | `"board"` joins `ALL_MCP_CAPABILITIES` (D3)                                                                                                          | list append                                                               |
| `apps/server/src/mcp/McpHttpServer.ts`                                          | `t3o-08`          | Import the board toolkit and its declared handlers                                                                                                   | one-line append (import)                                                  |
| `apps/server/src/mcp/McpHttpServer.ts`                                          | `t3o-08`          | `toolkitRegistration(BoardToolkit, BoardToolkitHandlersLive)` joins the MCP layer merge (D3)                                                         | one merge entry                                                           |
| `apps/server/src/mcp/toolkits/worktree/registration.test.ts`                    | `t3o-08`          | Import and mock the board toolkit's services, registered on the same server                                                                          | import + mock layers                                                      |
| `apps/server/src/observability/RpcInstrumentation.ts`                           | `T3O-59`          | Import `BOARD_RPC_AGGREGATES`                                                                                                                        | one-line append (import)                                                  |
| `apps/server/src/observability/RpcInstrumentation.ts`                           | `T3O-59`          | Board RPCs carry the `board` aggregate label                                                                                                         | registry spread                                                           |
| `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`                  | `t3o-34`          | Import `withGitenvTokenEnv`; the Claude query options take the project's token                                                                       | import + one wrapped expression                                           |
| `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`                   | `t3o-34`          | Import `withGitenvTokenEnv`; the Codex app-server spawn takes the project's token                                                                    | import + one wrapped expression                                           |
| `packages/provider-acp/src/server/AcpSessionRuntime.ts`                         | `t3o-34`          | Import `withGitenvTokenEnv`; the ACP spawn environment takes the project's token                                                                     | import + one wrapped expression                                           |
| `apps/server/src/config.ts`                                                     | `t3o-34`          | Import `initGitenv`; `make` points it at the state dir (only `pair` reaches this)                                                                    | import + one delegating call                                              |
| `apps/server/src/cli/config.ts`                                                 | `t3o-34`          | Import `initGitenv`; `resolveServerConfig` points it at the state dir (every server boot)                                                            | import + one delegating call                                              |
| `apps/server/src/cli/config.test.ts`                                            | `t3o-34`          | The resolver initialises gitenv, not only `ServerConfig.layer`                                                                                       | fork test                                                                 |
| `apps/server/src/vcs/VcsProcess.ts`                                             | `t3o-34`          | Import the gitenv helpers; `gh` takes the project's token unless the caller pinned one                                                               | import + one env merge                                                    |
| `apps/server/src/vcs/VcsProcess.ts`                                             | `t3o-34`          | `safeProcessOutput` also scrubs the exact gitenv token values                                                                                        | one delegating call                                                       |
| `apps/server/src/vcs/GitVcsDriverCore.ts`                                       | `t3o-34`          | Import `gitenvTokenEnv`; git subprocesses take the project's token, merged last                                                                      | import + one env spread                                                   |
| `packages/source-control-github/src/server/gitHubRepositoryResolution.ts`       | `T3O-48`          | Import `t3oOriginRepository`; act on `origin`, never gh's `upstream` preference                                                                      | import + one delegating early return                                      |
| `packages/source-control-github/src/server/GitHubPullRequestApi.ts`             | `T3O-8`, `T3O-54` | Import the scope fallback; the core detail read runs through `readCoreWithScopeFallback`, the summary reads through `readSummariesWithScopeFallback` | import + three wrapped reads                                              |
| `packages/source-control-github/src/server/GitHubApi.ts`                        | `T3O-67`          | Import the gitenv helpers; `credential` asks gitenv after a pinned credential; a refused gitenv token keeps the ambient cache                        | import + early return + wrapped invalidate                                |
| `packages/source-control-github/src/server/GitHubPullRequestApi.ts`             | `T3O-67`          | Import `t3oGitenvBatchKey`; the summary and watch-fingerprint batch keys separate gitenv projects                                                    | import + two key entries                                                  |
| `apps/server/src/pullRequest/PullRequestService.ts`                             | `T3O-67`          | Import `gitenvToken`; cross-repository search and stats batches are split by gitenv identity                                                         | import + two key suffixes                                                 |
| `packages/source-control-github/src/server/GitHubPullRequestProvider.ts`        | `T3O-67`          | Import `t3oWithGitenvProject`; every provider call runs under its `cwd`'s gitenv project                                                             | import + one wrapped return                                               |
| `packages/source-control-github/src/server/GitHubSourceControlProvider.ts`      | `T3O-67`          | Import the gitenv helpers; calls run under their `cwd`'s gitenv project, and the head-lookup batch key separates projects                            | import + wrapped return + key entry                                       |
| `packages/source-control-github/src/server/GitHubSourceControlProvider.test.ts` | `T3O-48`          | Three upstream assertions expect `origin` where gh would pick `upstream`                                                                             | marked fork expectation                                                   |
| `packages/contracts/src/vcs.ts`                                                 | `T3O-8`           | `missing-scope` failure kind and its message: a scope refusal is not a missing resource                                                              | literal member + one ternary branch                                       |
| `apps/server/src/vcs/VcsProcess.ts`                                             | `T3O-8`           | A GitHub scope or fine-grained refusal classifies as `missing-scope`, not not-found                                                                  | one predicate branch                                                      |
| `apps/server/src/vcs/VcsProcess.test.ts`                                        | `T3O-8`           | Both refusal shapes classify as `missing-scope`                                                                                                      | fork tests                                                                |
| `packages/source-control-gitlab/src/server/GitLabCli.ts`                        | `T3O-8`           | `missing-scope` joins the exhaustive switch; glab never reports it                                                                                   | one `case` label                                                          |
| `packages/contracts/src/pullRequest.ts`                                         | `T3O-8`           | `checksUnread` on `PullRequestDetail`: empty `checks` means "could not look"                                                                         | one optional field                                                        |
| `packages/source-control-core/src/server/PullRequestProvider.ts`                | `T3O-8`           | `checksUnread` on the provider detail                                                                                                                | one optional field                                                        |
| `packages/source-control-github/src/server/gitHubPullRequestJson.ts`            | `T3O-8`           | `checksUnread` on the decoded GitHub detail                                                                                                          | one optional field                                                        |
| `apps/server/src/pullRequest/PullRequestService.ts`                             | `T3O-8`           | `checksUnread` carried through to the detail                                                                                                         | one conditional spread                                                    |
| `packages/source-control-github/src/server/GitHubPullRequestApi.test.ts`        | `T3O-54`          | A token refused the Checks permission still reads the batch, minus the rollup                                                                        | fork test                                                                 |
| `apps/server/src/pullRequest/PullRequestService.ts`                             | `T3O-24`          | `requireProject` prefers the referencing project's own checkout on the host                                                                          | one `??` fallback                                                         |
| `apps/server/src/pullRequest/PullRequestService.test.ts`                        | `T3O-24`          | A hosted reference routes through the referencing project                                                                                            | fork test                                                                 |
| `apps/server/src/git/GitManager.ts`                                             | `T3O-24`          | With no open PR, a reused branch's latest PR is the one that closed last                                                                             | one `Order` + one sort                                                    |
| `apps/server/src/git/GitManager.ts`                                             | `T3O-45`          | A skip that never reached the forge (`askedForge: false`) is not cached                                                                              | one field + one TTL guard                                                 |
| `apps/server/src/git/GitManager.test.ts`                                        | `T3O-24`          | A reused branch's latest PR is the one that closed last                                                                                              | fork test                                                                 |
| `apps/server/src/git/GitManager.test.ts`                                        | `T3O-45`          | An unpublished branch's skip does not occupy the forge cache                                                                                         | fork test                                                                 |
| `apps/server/src/git/GitManager.test.ts`                                        | `T3O-48`          | "Check again" gets past the failure backoff                                                                                                          | fork test                                                                 |
| `packages/contracts/src/project.ts`                                             | `T3O-23`          | `runOnWorktreeRemove` on a stored `ProjectScript`                                                                                                    | one-line append (field)                                                   |
| `packages/shared/src/projectScripts.ts`                                         | `T3O-23`          | `(teardown)` menu label, mirroring `(setup)` (moved from mobile `terminalMenu.ts`)                                                                   | one-line append                                                           |
| `apps/web/src/components/ChatView.tsx`                                          | `t3o-05`          | Import `BoardModeTabs`                                                                                                                               | one-line append (import)                                                  |
| `apps/web/src/components/ChatView.tsx`                                          | `t3o-05`          | Threads/Board mode tabs before the breadcrumb (D1 shell tab)                                                                                         | one-line append (delegating element)                                      |
| `apps/web/src/components/ChatView.tsx`                                          | `t3o-06`          | `ChatViewChrome` type and `chrome` prop (default `"full"`); `"embedded"` for the card modal                                                          | one type + one destructured default                                       |
| `apps/web/src/components/ChatView.tsx`                                          | `t3o-06`          | Embedded chat hides the worktree/branch strip                                                                                                        | one boolean                                                               |
| `apps/web/src/components/ChatView.tsx`                                          | `t3o-06`          | Embedded chat renders no workspace top bar                                                                                                           | one conditional wrap                                                      |
| `apps/web/src/components/NoActiveThreadState.tsx`                               | `t3o-05`          | Import `BoardModeTabs`                                                                                                                               | one-line append (import)                                                  |
| `apps/web/src/components/NoActiveThreadState.tsx`                               | `t3o-05`          | Mode tabs in the no-thread top bar (Board entry must survive it)                                                                                     | one-line append (delegating element)                                      |
| `apps/web/src/components/AppSidebarLayout.tsx`                                  | `t3o-05`          | `isOnBoard`: no thread sidebar and no sidebar toggle on the board                                                                                    | one derived boolean + two conditional wraps                               |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`                             | `T3O-34`          | Import `BoardModeTabsSidebarSlot`                                                                                                                    | one-line append (import)                                                  |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`                             | `T3O-34`          | Mode-tabs slot in the sidebar header (measures its own fit)                                                                                          | one-line append (delegating element)                                      |
| `apps/web/src/routes/__root.tsx`                                                | `T3O-34`          | Import `redirectColdStartToBoard`                                                                                                                    | one-line append (import)                                                  |
| `apps/web/src/routes/__root.tsx`                                                | `T3O-34`          | Cold start at `/` opens the board (D1); `/` stays threads home after                                                                                 | one-line append (delegating call, throws the redirect itself)             |
| `apps/web/src/routes/pair.tsx`                                                  | `T3O-34`          | Import `resolvePairExitTarget`                                                                                                                       | one-line append (import)                                                  |
| `apps/web/src/routes/pair.tsx`                                                  | `T3O-34`          | Already-paired client redirects to the board, not `/` (D2/D3)                                                                                        | one-line edit (delegating call in the existing `redirect`)                |
| `apps/web/src/routes/pair.tsx`                                                  | `T3O-34`          | Completed pairing navigates to the board, not `/` (D2/D3)                                                                                            | one-line edit (delegating call in the existing `navigate`)                |
| `apps/web/src/routes/welcome.tsx`                                               | `T3O-34`          | Import `resolveOnboardingExitTarget`; the onboarding wizard exits to the board (D2)                                                                  | import + one delegating call                                              |
| `apps/web/src/routes/settings.connections.tsx`                                  | `T3O-63`          | Import `validateConnectionsSearch`; a board thread on a worker links here with the worker's address (`addHost`)                                      | import + one `validateSearch` line                                        |
| `apps/web/src/components/settings/ConnectionsSettings.tsx`                      | `T3O-63`          | Import `useConnectionsAddHostPrefill`                                                                                                                | one-line append (import)                                                  |
| `apps/web/src/components/settings/ConnectionsSettings.tsx`                      | `T3O-63`          | `addHost` opens Add environment prefilled with the worker's address                                                                                  | one delegating hook call                                                  |
| `packages/client-runtime/src/state/shell.ts`                                    | `t3o-02`          | Export board client state through `state/shell`                                                                                                      | one-line append (re-export)                                               |
| `packages/contracts/src/index.ts`                                               | `t3o-02`          | Export `board.ts`                                                                                                                                    | one-line append (re-export)                                               |
| `packages/contracts/src/rpc.ts`                                                 | `t3o-04`          | Import board RPC registries                                                                                                                          | one-line append (import)                                                  |
| `packages/contracts/src/rpc.ts`                                                 | `t3o-04`          | Board methods join `WS_METHODS`                                                                                                                      | registry spread (`BOARD_WS_METHODS`)                                      |
| `packages/contracts/src/rpc.ts`                                                 | `t3o-04`          | Board RPCs join `WsRpcGroup` (`RpcGroup.make` is variadic)                                                                                           | registry spread (`BOARD_RPCS`)                                            |
| `apps/server/src/auth/RpcAuthorization.ts`                                      | `t3o-04`          | Import board RPC scope registry                                                                                                                      | one-line append (import)                                                  |
| `apps/server/src/auth/RpcAuthorization.ts`                                      | `t3o-04`          | Board scopes join `RPC_REQUIRED_SCOPES`                                                                                                              | registry spread (`BOARD_RPC_SCOPES`)                                      |
| `apps/server/src/ws.ts`                                                         | `t3o-04`          | Import board RPC handler factory and `SupervisorReactor`                                                                                             | import block                                                              |
| `apps/server/src/ws.ts`                                                         | `t3o-04`          | Board RPC handlers join the `toLayer` handler record                                                                                                 | spread (injected factory call, `boardRpcHandlers(deps)`)                  |
| `apps/server/src/ws.ts`                                                         | `t3o-04`          | Resolve `SupervisorReactor`; the board's pull-request actions run through it                                                                         | one-line append (service yield)                                           |
| `apps/server/src/ws.ts`                                                         | `t3o-32`          | `board-attachment` asset resources mint like chat attachments                                                                                        | one-line predicate widening (frozen)                                      |
| `packages/contracts/src/assets.ts`                                              | `t3o-32`          | `board-attachment` member of `AssetResource` (card folder + filename)                                                                                | union member (frozen)                                                     |
| `apps/server/src/assets/AssetAccess.ts`                                         | `t3o-32`          | Import the board attachment path resolver                                                                                                            | one-line append (import)                                                  |
| `apps/server/src/assets/AssetAccess.ts`                                         | `t3o-32`          | Import `SAFE_IMAGE_FILE_EXTENSIONS` for the board attachment's inline disposition                                                                    | one-line append (import)                                                  |
| `apps/server/src/assets/AssetAccess.ts`                                         | `t3o-32`          | `board-attachment` claims member (card folder + filename, download/mime)                                                                             | union member (frozen)                                                     |
| `apps/server/src/assets/AssetAccess.ts`                                         | `t3o-32`          | `issueAssetUrl` mints a board attachment (same disposition rules as `attachment`)                                                                    | `case` delegating to the board resolver                                   |
| `apps/server/src/assets/AssetAccess.ts`                                         | `t3o-32`          | `resolveAsset` serves a board attachment from the card folder                                                                                        | predicate branch delegating to the board resolver                         |
| `packages/client-runtime/src/rpc/client.ts`                                     | `t3o-04`          | Import board subscription tag type                                                                                                                   | one-line append (type import)                                             |
| `packages/client-runtime/src/rpc/client.ts`                                     | `t3o-04`          | Board tags join `EnvironmentSubscriptionRpcTag`                                                                                                      | one-line union member (`BoardSubscriptionRpcTag`, grows in board.ts)      |
| `packages/contracts/src/settings.ts`                                            | `t3o-07`          | Import `BoardSettings` / `BoardSettingsPatch` from board.ts                                                                                          | one-line append (import)                                                  |
| `packages/contracts/src/settings.ts`                                            | `t3o-07`          | `board` field on `ServerSettings` (D10)                                                                                                              | one-line append, single field (frozen; shape grows in `BoardSettings`)    |
| `packages/contracts/src/settings.ts`                                            | `t3o-07`          | `board` field on `ServerSettingsPatch` (D10)                                                                                                         | one-line append, single field (frozen; whole-map, merged by `deepMerge`)  |
| `apps/server/src/serverSettings.ts`                                             | `t3o-15`          | `INDIVISIBLE_SETTINGS_KEYS`: board settings are written whole, never diffed field-wise                                                               | one block + one branch                                                    |
| `apps/server/src/serverSettings.test.ts`                                        | `t3o-07`          | `PositiveInt` import for the board settings write tests                                                                                              | one-line append (import)                                                  |
| `packages/shared/src/serverSettings.test.ts`                                    | `t3o-15`          | `applyServerSettingsPatch` board settings tests (D4)                                                                                                 | fork tests                                                                |
| `apps/web/src/components/settings/settingsSearch.ts`                            | `t3o-07`          | Import `BOARD_SETTINGS_SEARCH_ITEMS` from board-owned registry                                                                                       | one-line append (import)                                                  |
| `apps/web/src/components/settings/settingsSearch.ts`                            | `t3o-07`          | `/settings/board` in `SettingsPath` union (single board page, D1)                                                                                    | one-line union member (frozen)                                            |
| `apps/web/src/components/settings/settingsSearch.ts`                            | `t3o-07`          | Board label in `SETTINGS_SECTION_LABELS` (`SETTINGS_NAV_ITEMS` derives)                                                                              | one-line record entry (frozen)                                            |
| `apps/web/src/components/settings/settingsSearch.ts`                            | `t3o-07`          | Board search items join `SETTINGS_SEARCH_ITEMS`                                                                                                      | registry spread (`BOARD_SETTINGS_SEARCH_ITEMS`)                           |
| `apps/web/src/components/settings/settingsSearch.ts`                            | `T3O-46`          | `/settings/board` scope: the primary environment's settings at any selection                                                                         | one-line record entry (frozen)                                            |
| `apps/web/src/components/settings/SettingsSidebarNav.tsx`                       | `t3o-07`          | `LayoutGridIcon` import for the board nav icon                                                                                                       | one-line append (import)                                                  |
| `apps/web/src/components/settings/SettingsSidebarNav.tsx`                       | `t3o-07`          | Board icon in `SETTINGS_SECTION_ICONS`                                                                                                               | one-line record entry (frozen)                                            |
| `apps/server/src/mcp/McpSessionRegistry.ts`                                     | `t3o-08`          | Granted capability set gains `"board"` (D3)                                                                                                          | one-line edit (frozen)                                                    |
| `apps/server/src/mcp/McpSessionRegistry.test.ts`                                | `t3o-08`          | Every thread session carries `"board"`                                                                                                               | marked fork expectation                                                   |
| `apps/server/src/cloud/serviceProtocol.ts`                                      | `T3O-54`          | `SERVICE_LAUNCHER_PROTOCOL = 4` (upstream's 3 + multi-database snapshot)                                                                             | constant + comment (re-check every sync)                                  |
| `apps/server/src/cloud/servicePreflight.test.ts`                                | `T3O-54`          | Protocol 3 is blocked too: upstream's protocol-3 launcher snapshots only `state.sqlite`                                                              | marked fork expectation                                                   |
| `apps/server/src/serviceLauncher.ts`                                            | `t3o-26`          | Update backup and restore cover every database in the state dir (`databaseBaseNames`)                                                                | one helper + two loops                                                    |
| `apps/server/src/serviceLauncher.test.ts`                                       | `t3o-26`          | Import and exercise the multi-database backup helpers                                                                                                | import + fork tests                                                       |
| `docs/internals/server-updates.md`                                              | `t3o-26`          | "Every database, not just `state.sqlite`" section                                                                                                    | Self-contained section                                                    |
| `vite.config.ts`                                                                | `T3O-54`          | Design-token lint rules off for fork-owned web files                                                                                                 | one override block                                                        |
| `apps/server/src/ws.ts`                                                         | `T3O-23`          | Import the worktree retirer and its thread-delete delegate                                                                                           | one-line append (import)                                                  |
| `apps/server/src/ws.ts`                                                         | `T3O-23`          | Resolve `WorktreeRetirer` for the RPC handlers                                                                                                       | one-line append (service yield)                                           |
| `apps/server/src/ws.ts`                                                         | `T3O-23`          | `vcsRemoveWorktree` retires (stop, remove scripts) before the stock removal                                                                          | one-line delegation (`retireRemovedThreadWorktree`), stock call passed in |
| `packages/contracts/src/t3ProjectFile.ts`                                       | `T3O-23`          | `runOnWorktreeRemove` on a `t3.json` script                                                                                                          | one optional field                                                        |
| `packages/shared/src/t3ProjectFile.test.ts`                                     | `T3O-23`          | `runOnWorktreeRemove` in the expected `t3.json` script keys                                                                                          | marked fork expectation                                                   |
| `apps/web/src/projectScripts.ts`                                                | `T3O-23`          | `runOnWorktreeRemove` input, stored only when set; never the primary script                                                                          | one field + one spread + predicate widening                               |
| `apps/web/src/components/projectScriptEditor.tsx`                               | `T3O-23`          | Editor carries the flag (form state, hydrate, payload) and a switch                                                                                  | one line per form step + one switch                                       |
| `apps/web/src/components/projectScriptEditor.tsx`                               | `T3O-23`          | `newProjectScriptInputFromFile`: one import mapping for both import paths                                                                            | new exported function                                                     |
| `apps/web/src/components/ProjectScriptsControl.tsx`                             | `T3O-23`          | Import through `newProjectScriptInputFromFile`; `(teardown)` menu label                                                                              | delegating call + label branch                                            |
| `apps/web/src/components/settings/ProjectActionsSettings.tsx`                   | `T3O-23`          | Import through `newProjectScriptInputFromFile`                                                                                                       | delegating call                                                           |
| `apps/web/src/components/settings/ProjectActionsList.tsx`                       | `T3O-23`          | `teardown` badge beside `setup`                                                                                                                      | one badge                                                                 |
| `apps/web/src/components/ComposerPromptEditorTiptap.tsx`                        | `upstream bug`    | Editor destroyed in useEditor's 1 ms render-to-commit race is skipped where `view` is read; drop once @tiptap/react fixes it                         | three `isDestroyed` guards                                                |
| `apps/web/src/index.css`                                                        | `status palette`  | `--attention` violet token: theme mapping, light and dark values                                                                                     | three token blocks (frozen)                                               |
| `apps/web/src/components/Sidebar.logic.ts`                                      | `status palette`  | Awaiting Input pill reads violet                                                                                                                     | colour-class swap (frozen)                                                |
| `apps/web/src/components/Sidebar.tsx`                                           | `status palette`  | Running pill reads blue, waiting reads violet                                                                                                        | two colour-class swaps (frozen)                                           |
| `apps/web/src/components/chat/ComposerBanner.tsx`                               | `status palette`  | `attention` banner variant and its two style maps                                                                                                    | union member + two record entries (frozen)                                |
| `apps/web/src/components/chat/ChatComposer.tsx`                                 | `status palette`  | The question drawer uses the `attention` variant                                                                                                     | one-line edit (frozen)                                                    |
| `apps/mobile/scripts/generate-uniwind-themes.mts`                               | `status palette`  | Adaptive violet tokens for the thread list                                                                                                           | token entries (frozen)                                                    |
| `apps/mobile/src/features/threads/thread-list-v2-items.tsx`                     | `status palette`  | Thread status hues follow the shared palette                                                                                                         | colour swap (frozen)                                                      |
| `apps/mobile/src/widgets/AgentActivity.tsx`                                     | `status palette`  | Live Activity status tints mirror the web pills                                                                                                      | colour swap (frozen)                                                      |
| `apps/desktop/src/app/DesktopStatePaths.ts`                                     | `T3O-71`          | Default T3 home is `~/.t3o`, from `scripts/lib/t3o-desktop-identity.ts`                                                                              | import + one delegating expression                                        |
| `apps/desktop/src/app/DesktopUserData.ts`                                       | `T3O-71`          | Own Electron profile names; legacy equals current and the Windows fallback reads T3o's own profile, so upstream's are never adopted                  | import + two delegating expressions                                       |
| `apps/desktop/src/app/DesktopEnvironment.ts`                                    | `T3O-71`          | Product name, appId and Linux WM class from the identity module                                                                                      | import + three delegating expressions                                     |
| `apps/desktop/src/app/DesktopEarlyElectronStartup.ts`                           | `T3O-71`          | Portal desktop-entry id and pre-ready WM class from the identity module                                                                              | import + two delegating expressions                                       |
| `apps/desktop/src/app/DesktopLinuxUrlHandler.ts`                                | `T3O-71`          | Portal entry has no `x-scheme-handler`; `register` stops before `xdg-mime default` (`t3code://` stays upstream's)                                    | import + conditional spread + early return                                |
| `apps/desktop/src/app/DesktopLinuxUrlHandler.test.ts`                           | `T3O-71`          | Upstream's tests run with the scheme claim mocked on; a fork suite asserts it is off                                                                 | mock + fork test                                                          |
| `apps/desktop/src/app/*.test.ts`                                                | `T3O-71`          | Identity, profile, home and product-name expectations in seven desktop app test files                                                                | marked fork expectations                                                  |
| `apps/desktop/src/window/DesktopApplicationMenu.test.ts`                        | `T3O-71`          | Menu labels use the T3o product name                                                                                                                 | marked fork expectation                                                   |
| `scripts/build-desktop-artifact.ts`                                             | `T3O-71`          | appId, product/artifact names, Linux executable, WM class, maintainer, no Linux `protocols`, metainfo/doc paths, staged package metadata             | import + delegating expressions                                           |
| `scripts/build-desktop-artifact.test.ts`                                        | `T3O-71`          | Product name, appId, Linux protocols/executable/artifact expectations                                                                                | marked fork expectations                                                  |
| `package.json`                                                                  | `T3O-71`          | `dist:desktop:deb` beside the `t3o-service` scripts (JSON carries no marker)                                                                         | one-line append                                                           |
| `packages/contracts/src/settings.ts`                                            | `T3O-71`          | `boardEnvironmentId` client setting, its patch entry and the `EnvironmentId` import                                                                  | import + two single-field appends                                         |
| `apps/server/src/binCli.ts`                                                     | `T3O-71`          | `importThreadsCommand` joins the CLI's subcommands                                                                                                   | import + one list entry                                                   |
| `apps/server/scripts/migrate-dev-db.ts`                                         | `T3O-71`          | `workspaceRoots` / `includeSettled` inputs, so `t3 import-threads` reuses the copy-and-prune                                                         | two optional inputs + filter fragments                                    |

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

## Inherited workflows

These are upstream's CI, inherited by the fork. They are switched off **from the GitHub Actions UI**
(Actions → the workflow → ⋯ → Disable workflow) or with `gh workflow disable <file>`, **never by
editing or deleting the YAML** — editing guarantees a conflict on every upstream CI change, for a
file we do not otherwise care about. The YAML never says whether a workflow is on;
`gh workflow list --all -R brentkelly/t3code-orchestrator` does. Pass `-R` explicitly: a bare
`gh workflow list` in a worktree can resolve to the `upstream` remote and report pingdotgg's state.

Recorded here so a future reader knows what was switched off deliberately and what was not. The
state below was read off the fork on the `v0.0.42` sync (2026-09-21).

**Off — deliberately:**

| Workflow                          | Why disabled                                                                                                                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy-relay.yml`                | Deploys the T3 Connect relay to upstream's infrastructure on every push to `main`. We do not own that infrastructure and have none of the credentials; a fork running it is at best a failed job and at worst points at someone else's deployment. |
| `mobile-eas-preview.yml`          | Builds preview binaries through upstream's Expo/EAS account on every PR. No EAS credentials here, and mobile is explicitly out of scope for T3o (D17). Burns a build slot per PR for nothing.                                                      |
| `mobile-eas-production.yml`       | Production mobile builds and OTA updates. Same missing EAS credentials, and shipping mobile releases from a fork is never something we want to happen — least of all by accident.                                                                  |
| `mobile-showcase-screenshots.yml` | Captures marketing screenshots on simulators for upstream's showcase. Long, expensive, and irrelevant to a fork that ships no mobile UI.                                                                                                           |
| `release.yml`                     | Publishes the `t3` CLI to NPM on tags and a 3-hourly nightly cron. T3o publishes nothing. Leaving this on means a recurring scheduled job whose only possible outcomes are failure or, given credentials, publishing over upstream's package.      |
| `thread-transfer-report.yml`      | Posts an upstream-specific report after each CI run, aimed at upstream's own review process. Noise here.                                                                                                                                           |
| `ci.yml`                          | The build, lint, typecheck and test gates. Off on the fork — every board card verifies in its own worktree instead, and no card has ever waited on a green check here. Turning it back on is a decision, not a repair.                             |
| `pr-size.yml`, `pr-vouch.yml`     | Upstream's contribution gates, meaningless on a single-maintainer fork whose PRs are all its own.                                                                                                                                                  |

**On — and should not be:**

| Workflow                       | What it costs                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop-macos-preview.yml`    | Triggers on every PR and skips inside the job (label-gated), so it is a queued runner per PR for a guaranteed no-op.                                                                                                      |
| `web-preview.yml`              | Same: triggers per PR, skips inside.                                                                                                                                                                                      |
| `mobile-fingerprint-check.yml` | Triggers per PR and does **not** always skip — one run on `board/t3o-38` sat for 24 hours before being cancelled. Mobile is out of scope (D17).                                                                           |
| `cursor-hygiene-webhook.yml`   | (since `v0.0.42`) POSTs to Cursor's hygiene endpoint on every PR open/reopen/ready-for-review, every push to `main`, and every issue or discussion. Ran on PR #110 as a no-op because the secret is absent — off by luck. |

**On — deliberately:** `issue-labels.yml`, which is cheap, self-contained and harmless.

**Cannot fire on their own,** so they need nothing: `publish-aur.yml` (since `v0.0.38`),
`release-desktop.yml` (since `v0.0.42`) — both `workflow_call`-only; `windows-tests.yml` (since
`v0.0.42`) — `workflow_dispatch`-only; and `desktop-macos-preview-publish.yml` (since `v0.0.42`),
which runs on `workflow_run` of `desktop-macos-preview.yml` and so dies with it.

**Every sync adds more.** Upstream shipped four new workflow files between `v0.0.38` and `v0.0.42`
and nobody noticed until review. Diff the directory as part of the sync:

```bash
git diff --name-status vPREV vNEXT -- .github/workflows/
gh workflow list --all -R brentkelly/t3code-orchestrator   # what is actually on
```

A new file that triggers on `push`, `pull_request` or `schedule` needs a decision and a row above;
`workflow_call` and `workflow_dispatch` need neither.

---

## Manual GitHub settings

Things that cannot be done from the repo because the PAT in use lacks `administration` scope. Kept
here so the repo state is reproducible from the docs.

- Default branch set to `t3o` (Settings → General → Default branch).
- Inherited workflows switched off (Actions → each workflow → ⋯ → Disable workflow). Which ones,
  and which are still on that should not be, is in "Inherited workflows" above.
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
