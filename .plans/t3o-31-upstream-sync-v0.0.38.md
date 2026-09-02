---
id: t3o-31
title: Upstream sync — merge pingdotgg/t3code v0.0.38 into t3o
phase: 3
prerequisites: [t3o-26]
---

# Upstream sync to v0.0.38

The fork last took upstream at `064041072` (2026-08-08). Upstream `v0.0.38` (`c0995d2ea`,
2026-09-01) is **595 commits and ~1,600 files** later. The two merges in the seams-doc log cost
one conflict each; this one does not, because (a) upstream churned the exact files the seams sit
in, and (b) the fork has accumulated **34 upstream files with unmarked edits** that the seam
grammar never covered.

Everything below was measured, not guessed: a throwaway trial merge lives on local branch
`scratch/trial-merge-v0.0.38` (`eb4e0913c`, worktree
`.claude/worktrees/agent-afea8b462638fecfc`), and a pre-merge baseline of the target branch was
run in `.claude/worktrees/agent-af72f897ce1a45e6a`. Use the scratch branch as the answer key for
every conflict; do not merge it.

## Goal

`t3o` carries upstream `v0.0.38`, every package typechecks, every test passes, lint is clean,
the board works end to end against a real database, and `docs/t3o/seams.md` describes the fork
as it actually is.

## Scope

### In

- Fast-forward `main` to `v0.0.38` (not to `upstream/main`, which is 10 commits further).
- Merge `main` into a sync branch off `t3o`, resolve the 18 content conflicts, regenerate the
  route tree.
- Fix the 3 merge-caused type errors, 2 merge-caused test failures, and 61 lint errors from
  upstream's new `no-native-title-tooltip` rule.
- Fix the 10 typecheck errors that already exist on `feature/board-db-separation` before the
  merge (they are fork-owned and block a green run either way).
- Resolve four policy collisions: `.plans/` gitignore, AGENTS.md plan policy, thread
  auto-settlement, `ORCHESTRATION_PROJECTOR_NAMES` enumeration in upstream tests.
- Manual smoke against a copied real database.
- Seams doc: merge-log row, inventory refresh, and a debt table for the unmarked edits.

### Out (tracked as follow-ups at the end)

- Retro-fitting the 34 unmarked edits into proper seams or board modules.
- Migrating the board's forge-merge path onto upstream's new `PullRequestService`.
- Anything on `upstream/main` past `v0.0.38`.

## Preconditions

1. `feature/board-db-separation` (t3o-26) has merged into `t3o`. All measurements were taken
   against that branch tip (`b78e42e72`); if t3o moves past it, rerun
   `git merge-tree --write-tree t3o v0.0.38` and diff the conflict list against the table below.
2. Work in a dedicated worktree. The root checkout is shared and other sessions force-checkout
   under it. Use plain `pnpm install` in the worktree, not `--frozen-lockfile`.
3. `vp` is not on `PATH`: `./node_modules/.bin/vp`.
4. Any commit touching only `.plans/` needs `--no-verify` (the format hook fails on `.plans`).

## Measured facts

| Metric                                                        | Value                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------ |
| Upstream commits merge-base..v0.0.38                          | 595                                                    |
| Upstream files changed                                        | 1,591                                                  |
| Fork files changed since merge-base                           | 347                                                    |
| Files changed on both sides                                   | 38                                                     |
| Content conflicts                                             | 18 files, 27 hunks (+11 in `routeTree.gen.ts`)         |
| `.plans` rename/delete conflicts                              | 32 (upstream deleted `.plans/*`; fork archived them)   |
| `T3o:` markers on upstream files                              | 87 (doc says 62)                                       |
| Upstream files with unmarked fork edits                       | 34                                                     |
| Merge-caused type errors                                      | 3                                                      |
| Pre-existing type errors on the fork tip                      | 10 (server 8, web 2), all fork-owned                   |
| Merge-caused test failures                                    | 2 (server 1, web 1)                                    |
| Pre-existing test failures                                    | 0 (7,519 pass across 14 packages)                      |
| Merge-caused lint errors                                      | 61, one new upstream rule, all in `apps/web/src/board` |
| Upstream migrations added (own lineage)                       | 039–043; `Migrations.ts` and `Sqlite.ts` did not conflict |
| Lockfile                                                      | `pnpm install` after merge: no change                  |
| Full test wall time, sequential                               | ~5 min (server ~3.5 min)                               |

## Phase 0 — pre-merge cleanup on `t3o` (one small PR, before the sync)

Land these first so every post-merge failure is attributable to the merge.

1. **Fix the 10 pre-existing typecheck errors.** All fork-owned:
   - `apps/web/src/board/BoardCardDetailView.tsx:1142` — `noUncheckedIndexedAccess` on a
     `BoardCardModelRowSpec` lookup (2 errors).
   - `apps/server/src/board/cardModelOverrides.test.ts:272-278` — a closure-assigned `let`
     narrows to `never` (5 errors).
   - `apps/server/src/board/baseBranchSync.test.ts:36`,
     `apps/server/src/board/supervisorHarness.testkit.ts:394,427` — effect language-service
     `globalErrorInEffectFailure`, which `tsconfig.base.json` sets to `error` (3 errors).
2. **Confirm what `vp run -r typecheck` actually runs.** Both agents saw it stop early: web
   failed and `@t3tools/mobile` was OOM-killed (exit 137) at `--concurrency-limit 2`, so `t3`
   (apps/server), desktop and relay never ran. Server typecheck has been silently unexercised.
   Either fix the ordering/concurrency or document "run server, desktop, relay, mobile with
   `--filter`, mobile alone".
3. Optional but cheap: add `T3o:` markers to the unmarked hunks that the merge will conflict on
   anyway (`serverSettings.ts`, `GitHubCli.ts`, `AppSidebarLayout.tsx`, `ChatView.tsx` chrome
   prop, `ChatComposer.tsx`, `server.ts` `BoardGitLayerLive`, `orchestration.ts` `RuntimeMode`
   re-export). Doing it before the merge means the resolution preserves them for free.

## Phase 1 — the merge

```bash
git fetch upstream --tags
git checkout main && git merge --ff-only v0.0.38 && git push origin main
git checkout -b sync/upstream-v0.0.38 t3o
git merge main            # expect 18 content conflicts + 32 .plans rename/delete
```

Resolve `.plans` first: `git checkout --ours -- .plans && git add .plans`.

Then each content conflict. "Seam" means the fork's `T3o:` marker + delegating line; the rule is
always upstream's code with the seam re-inserted. Non-seam rows are the unmarked edits and need
the fork's logic re-applied by hand.

| File                                            | Hunks | Resolution                                                                                                                                                                                     | Seam? |
| ----------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `AGENTS.md`                                     | 1     | Upstream rewrote "Pull requests" and added "Plans and work artifacts". Re-add the two `T3o:` PR-target bullets under the new section; see Phase 3 for the plans-policy override.                | yes   |
| `orchestration/Layers/OrchestrationEngine.ts`   | 1     | Upstream import `OrchestrationClientOrigin` + fork's `BoardCardId/BoardLabelId/BoardStageId` import.                                                                                            | yes   |
| `orchestration/decider.ts`                      | 1     | Upstream `threadHasQueuedTurnStart` import + board decider import.                                                                                                                             | yes   |
| `server.ts`                                     | 3     | (1) imports: both. (2) `ThreadSettlementReactor.layer` **and** `SupervisorReactorLive` provideMerge. (3) upstream's `Layer.mergeAll(SourceControlProviderRegistryLayerLive, PullRequestServiceLive)` then fork's `BoardGitLayerLive` in place of `GitLayerLive`. | (3) no |
| `serverSettings.ts`                             | 1     | Keep both: fork's `INDIVISIBLE_SETTINGS_KEYS` / `INDIVISIBLE_ENTRY_SETTINGS_KEYS` / `stripDefaultSettingsMapEntries` and upstream's `PERSISTED_SERVER_SETTINGS_DEFAULTS`. Add a marker.         | no    |
| `sourceControl/GitHubCli.ts`                    | 2     | Keep both: fork `allowNonZeroExit` and upstream `stdin` / `maxOutputBytes` on `execute` input and its spread.                                                                                   | no    |
| `ws.ts`                                         | 3     | (1) imports: both, keep `coalesceShellWindow` (still used). (2) upstream `dispatchFromClient` / analytics block + fork `boardSupervisor`. (3) upstream's rewritten archive body; re-insert `yield* boardStampActor(normalizedCommand)` right after `normalizeDispatchCommand`. | yes   |
| `web/components/AppSidebarLayout.tsx`           | 1     | Upstream's `<ProjectProjectionRetention />` and `onDoubleClick={resetSidebarWidth}` inside the fork's `isOnBoard ? null : (...)`. Add a marker.                                                 | no    |
| `web/components/ChatView.tsx`                   | 2     | Upstream replaced `<header>` with `<WorkspacePageHeader>` and dropped `changeRequestState` from `ChatHeader`. Keep fork's `chrome === "embedded" ? null : (...)` around the new element, with `<BoardModeTabs>` as its first child. | partly |
| `web/components/NoActiveThreadState.tsx`        | 2     | Upstream `WorkspacePageHeader`; put `<BoardModeTabs className="mr-2" mode="threads" />` inside it. Drop the fork's now-unused `cn` / inset imports.                                              | yes   |
| `web/components/chat/ChatComposer.tsx`          | 1     | Upstream's lucide import list minus `LucideIcon, LockIcon, LockOpenIcon, PenLineIcon, SparklesIcon` (the runtime-mode picker now lives in fork's `AccessLevelPicker.tsx`; upstream still has it inline). | no    |
| `web/components/settings/settingsSearch.ts`     | 1     | Upstream imports + fork's `BOARD_SETTINGS_SEARCH_ITEMS` import. Other three seams auto-merged.                                                                                                 | yes   |
| `web/components/settings/settingsSearch.test.ts`| 1     | Keep both; the fork's `"work"` assertion then fails, fixed in Phase 2.                                                                                                                         | no    |
| `web/src/index.css`                             | 1     | Upstream restructured the glass block. Keep only the fork's `.board-card-done` rules at the same `@layer` position. The `--font-sans` DM Sans change auto-merged.                                | yes   |
| `web/src/routeTree.gen.ts`                      | 11    | Take upstream, then **regenerate** (no `tsr` CLI; `@tanstack/router-generator` from the pnpm store, script kept at `/tmp/gen-routes.mjs` on the trial worktree, or run `vp run dev:web` once). Expect +63 lines: `board`, `board_.$parentCardId`, `settings.board`. | n/a   |
| `contracts/src/orchestration.ts`                | 1     | `import { DEFAULT_RUNTIME_MODE, ProviderOptionSelections, RuntimeMode } from "./model.ts"` + upstream's `ThreadEnvMode` from `environment.ts`.                                                  | no    |
| `contracts/src/rpc.ts`                          | 1     | Upstream attachment imports + `BOARD_RPCS, BOARD_WS_METHODS`.                                                                                                                                  | yes   |
| `contracts/src/settings.ts`                     | 1     | Upstream preview / providerInstance imports + `BoardSettings, BoardSettingsPatch`.                                                                                                             | yes   |

After resolving: `rg -n "T3o:"` must show the same 87 markers as before the merge (row for row
against `git grep -c "T3o:" t3o`). Commit the merge before any fix-ups so the merge commit is a
pure resolution.

## Phase 2 — compile, test, lint fixes

Type errors (3, all trivial):

1. `apps/web/src/components/settings/BoardModelRow.tsx:66,100` — upstream added a
   `planModeEnabled` server setting threaded through `getTraitsSectionVisibility` /
   `TraitsMenuContent`. Read it from settings; do not hardcode `true` as the trial did.
2. `apps/server/src/git/GitManager.ts` fork's `findBranchPullRequest` — upstream added a required
   `defaultBranch: string | null` to `prLookupCacheKey`. Check why (it likely scopes the lookup to
   PRs against the default branch) and pass the project's real default branch rather than `null`
   so the card→PR link keeps matching what the status badge shows.
3. `apps/server/integration/orphanedProviderSessionStartup.integration.test.ts` — upstream-new
   test drives `ServerRuntimeStartup`, whose t3o-10 seam yields `SupervisorReactor`. Provide
   `Layer.mock(SupervisorReactor)({ start: () => Effect.void })` with a `T3o:` marker. This is a
   new inventory row.

Test failures (2):

4. `apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts` "resumes from projector
   last_applied_sequence": upstream's new tests seed and assert `projection_state` for every
   name in `ORCHESTRATION_PROJECTOR_NAMES`, which the fork spreads `BOARD_PROJECTOR_NAMES` into.
   t3o-26's `BoardAwareProjectionStateRepository` keeps board watermarks in
   `boards.projection_state`, so the seeded `main` row never advances. Apply the same
   `main ∪ boards` / `NOT LIKE 'projection.board-%'` treatment the fork already gave the older
   test at lines 164–176, marked. Order-dependent: passes in isolation, so run the whole file.
5. `apps/web/src/components/settings/settingsSearch.test.ts:56` — `searchSettings("work")` now
   also matches upstream's new worktree/network settings. Assert `toContain` the board id, or
   pick a query unique to the board item.

Lint (61 errors, one rule):

6. Upstream added `t3code(no-native-title-tooltip)`. Every hit is a `title=` attribute in
   `apps/web/src/board/*` (`BoardCardSummaryRow` 12, `BoardCardDetailView` 11,
   `BoardCardThreadPane` 7, `BoardCardItem` 5, `BoardLabelChips` 3, `BoardPipelineSection` 2,
   `BoardSearchAddPicker`, `BoardArchivedCardsSheet`, others; full list in the trial worktree's
   `/tmp/lint.txt`). Replace with the repo's `Tooltip` primitive. Mechanical but the largest
   single chunk of work in this plan; do it as its own commit. Do not disable the rule for the
   board directory.

## Phase 3 — policy collisions (decide, then implement)

1. **`.plans/` is now gitignored upstream.** The merged `.gitignore` carries `.plans/`, so the
   fork's 95 tracked plan files stay tracked but every new plan needs `git add -f`, and
   `orchestrate-build`'s ✓-rename would silently produce an untracked file. Resolution: keep
   upstream's line and add directly beneath it `# T3o: this fork tracks its plans.` and
   `!.plans/`. One conflict site, marked.
2. **AGENTS.md "Plans and work artifacts"** now says do not commit plans. The fork block at the
   top already claims precedence; add one bullet there stating `.plans/` is tracked in this fork
   and why. Also fix the fork block's stale status line ("No board code exists yet").
3. **Thread auto-settlement.** Upstream's new `ThreadSettlementReactor` settles any thread whose
   linked PR is merged (`sidebarAutoSettleOnMerge`, default on) or closed, or idle beyond
   `sidebarAutoSettleAfterDays` (default 3). The board supervisor already dispatches
   `thread.settle` itself at three sites in `supervisorReactor.ts` and drives step liveness from
   thread events. Two reactors settling the same threads is a race the board did not design for.
   Investigate what the supervisor does on an externally emitted `thread.settled` /
   `thread.unsettled` for a card thread (stall detection, step state, review loop). Recommended
   default: exclude board-managed threads from `isAutoSettlementCandidate` via a one-line
   predicate seam that delegates to a board-owned `isBoardManagedThread` (card thread links are
   in `boards.sqlite`). Only accept upstream's behaviour if the audit shows it is harmless.
4. **Upstream tests enumerating fork registries.** Item 4 in Phase 2 is the first instance;
   every future upstream test that iterates `ORCHESTRATION_PROJECTOR_NAMES` will hit the split
   `projection_state`. Either accept a marked test-side fix each time, or stop spreading board
   names into upstream's registry and register them through the board's own pipeline hook. Note
   the decision in seams.md; no need to restructure in this sync.
5. **New upstream workflows** (`desktop-macos-preview`, `mobile-fingerprint-check`,
   `web-preview` trigger on pull_request; `publish-aur` is workflow_call only). After the first
   push, disable them with `gh workflow disable` like the other eight; do not edit the YAML.
6. **Launcher protocol.** Fork is at `SERVICE_LAUNCHER_PROTOCOL = 3`, upstream still `2`. No
   collision today; record it in seams.md so a future upstream bump to 3 is caught as a semantic
   conflict, not an auto-merge.
7. **`migrate-dev-db`** (new upstream script) rebuilds `state.sqlite` only and runs upstream
   migrations only. Fine for now because `boards.sqlite` is a separate file, but it will not copy
   or migrate the board database. Follow-up, not blocking.

## Phase 4 — verification

Run per package; the recursive runner is unreliable here (Phase 0 item 2). Compare against the
baseline numbers above.

1. `pnpm install` (expect no lockfile change), then typecheck: contracts, client-runtime, shared,
   web, server, desktop, relay, then mobile alone.
2. Tests per package with `--filter`, sequentially. Expected: server ~3,535, web ~3,279,
   client-runtime 633, contracts 446, others as baseline; 0 failures, 10 env-gated skips.
3. `vp lint --report-unused-disable-directives`: 0 errors. Clear the pre-existing unused-disable
   in `BoardCardDetail.tsx:174` while there.
4. Manual smoke on a dev instance against a `VACUUM INTO` copy of the real database (both
   `state.sqlite` and `boards.sqlite`; the dev instance is `:13773`, pair via
   `auth pairing create --dev-url`, headless via playwright-core):
   - Boot log shows upstream migrations 041–043 applied, board ledger untouched, no relocation.
   - Board loads, sub-board drill-in, card modal with embedded chat (header hidden), Board tab
     visible on both the thread view and the no-thread state.
   - Settings → Board page reachable from the sidebar and from search.
   - Card model row renders traits with the new `planModeEnabled` setting.
   - Card PR badge resolves for a card with a pushed branch.
   - MCP `tools/list` still returns the board toolkit (one bad schema drops all tools).
   - Upstream's new pull-requests view and settings integrations page do not 404 or crash with
     the board routes present.
5. Pre-existing typecheck errors from Phase 0 are gone.

## Phase 5 — docs and memory

1. `docs/t3o/seams.md`:
   - Merge-log row: 18 content conflicts, which seams moved (t3o-05 tabs now inside
     `WorkspacePageHeader`; t3o-18 stamp inside the rewritten dispatch body), time taken.
   - Inventory refresh to 87 markers plus the new integration-test mock row. Add rows for the
     `Sqlite.ts` t3o-26 attach seam and the `boards.sqlite` layering, which post-date the doc.
   - New **"Unmarked edits (debt)"** table listing all 34 files with size and owning spec, so the
     next merge knows where the non-seam conflicts will come from. Largest: `serviceLauncher.ts`
     (115, t3o-26 multi-db backup), `GitManager.ts` (89, PR link/merge), `serverSettings.ts`
     (56), `VcsProcess.ts` (52, `safeProcessOutput`), the five `sourceControl/*Provider.ts`
     `mergeChangeRequest` additions, `CompactComposerControlsMenu.tsx` (154) and
     `ChatComposer.tsx` (85, `AccessLevelPicker` extraction).
   - Record the three decisions from Phase 3 (plans tracking, auto-settle exclusion, registry
     enumeration) and the launcher-protocol note.
2. Update the memory index entry for branch topology with the v0.0.38 merge-base.

## Phase 6 — land

PR `sync/upstream-v0.0.38` → `t3o` with the conventional title
`chore(sync): merge upstream v0.0.38`. Body: the metric table and the Phase 3 decisions. Disable
the three new pull_request workflows after the first push. Merge with a merge commit, never
squash: squashing a 1,559-file upstream merge destroys the ancestry the next `git merge main`
relies on.

## Follow-ups (separate specs)

- **Adopt upstream `PullRequestService`.** Its `runAction({ action: "merge", mergeMethod })`,
  `detail` and `list` cover what the fork's `mergeChangeRequest` on `SourceControlProvider` plus
  four provider stubs, `GitHubCli.mergePullRequest`, `GitHubPullRequestMergeRefusedError`, and
  `GitManager.findBranchPullRequest` / `mergeBranchPullRequest` do. Moving
  `BoardPullRequestGateway` onto it deletes roughly 250 unmarked lines from upstream files and
  the `BoardGitLayerLive` substitution in `server.ts`. Highest-value seam reduction available.
- **Seam the remaining unmarked edits**: `serviceLauncher.ts` multi-database backup (could be a
  delegating call into a board module), `serverSettings.ts` indivisible keys (a board-owned set
  spread into a registry), `AppSidebarLayout.tsx` `isOnBoard`, `ChatView.tsx` `chrome` prop,
  the `AccessLevelPicker` extraction (or upstream it).
- `migrate-dev-db` awareness of `boards.sqlite`.
- Take `upstream/main` past v0.0.38 on the normal cadence once this lands.
