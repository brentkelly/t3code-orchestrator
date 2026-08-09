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

### Rules that ride alongside

- **Migrations are numbered from `900_` upward.** Colliding with an upstream migration number
  corrupts the applied-migration ledger on every machine that has already run it. That is data loss,
  not a merge conflict.
- **Workspace packages keep their `@t3tools/*` names.** They are `private: true` and resolved through
  `workspace:*`, so nothing is fetched from NPM and renaming would touch every import for zero gain.
- **Branding is a single seam.** `apps/web/src/branding.ts` (`APP_BASE_NAME`, `APP_DISPLAY_NAME`,
  `APP_STAGE_LABEL`) is the only place a product name belongs. Do not scatter naming elsewhere.

---

## Upstream sync runbook

Manual and on demand. **Run it when there is a reason to** — a fix you want, or before starting a
spec that touches a file upstream has been churning. Not on a calendar.

```bash
git fetch upstream

git checkout main
git merge --ff-only upstream/main   # never force; a failure means someone
                                    # committed to the mirror

git checkout t3o
git merge main
```

Then, before pushing:

```bash
rg -n "T3o:"          # eyeball against the seam inventory below
```

and run the normal checks for whatever the merge touched.

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

---

## Seam inventory

Maintained by hand. Every row is one `T3o:` marker in an upstream-owned file. After an upstream
merge, `rg -n "T3o:"` should match this table row for row; a marker that vanished is a seam a
conflict resolution silently dropped.

New files are **not** listed — they are ours and they never conflict. Only insertions into
upstream-owned files belong here.

| File                                                                   | Spec     | Reason                                                                  | Shape                                    |
| ---------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------- | ---------------------------------------- |
| `AGENTS.md`                                                            | `t3o-01` | Fork status, branch topology, seam rules                                | Self-contained block at the top          |
| `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`          | `t3o-02` | `BoardCardId` type import                                               | one-line append (import)                 |
| `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`          | `t3o-02` | Widen `commandToAggregateRef` return type with `"card"` / `BoardCardId` | two-line edit (type annotation)          |
| `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`          | `t3o-02` | Board commands aggregate on the card                                    | case append (2 lines)                    |
| `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`           | `t3o-02` | Import board projection module                                          | one-line append (import)                 |
| `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`           | `t3o-02` | `boardCards` entry in `ORCHESTRATION_PROJECTOR_NAMES`                   | one-line append                          |
| `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`           | `t3o-02` | Board projector joins the projector list                                | one-line append (spread delegating call) |
| `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`      | `t3o-02` | Import board snapshot enrichment                                        | one-line append (import)                 |
| `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`      | `t3o-02` | Wrap `getCommandReadModel` with board state (D8)                        | one-line edit (delegating call)          |
| `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`      | `t3o-02` | Wrap `getShellSnapshot` with cards (D2)                                 | one-line edit (delegating call)          |
| `apps/server/src/orchestration/decider.ts`                             | `t3o-02` | Import board decider                                                    | one-line append (import)                 |
| `apps/server/src/orchestration/decider.ts`                             | `t3o-02` | Delegate board commands at the head of the switch                       | case append (2 lines, delegating call)   |
| `apps/server/src/orchestration/projector.ts`                           | `t3o-02` | Import board projector                                                  | one-line append (import)                 |
| `apps/server/src/orchestration/projector.ts`                           | `t3o-02` | Delegate board events before the default case                           | case append (2 lines, delegating call)   |
| `apps/server/src/persistence/Layers/OrchestrationEventStore.ts`        | `t3o-02` | `BoardCardId` import                                                    | one-line append (import)                 |
| `apps/server/src/persistence/Layers/OrchestrationEventStore.ts`        | `t3o-02` | Widen append-request `streamId` union                                   | one-line edit                            |
| `apps/server/src/persistence/Layers/OrchestrationEventStore.ts`        | `t3o-02` | Widen persisted-row `aggregateId` union                                 | one-line edit                            |
| `apps/server/src/persistence/Migrations.ts`                            | `t3o-02` | Import `900_BoardCards`                                                 | one-line append (import)                 |
| `apps/server/src/persistence/Migrations.ts`                            | `t3o-02` | Registry entry `[900, "BoardCards", …]`                                 | one-line append                          |
| `apps/server/src/persistence/Services/OrchestrationCommandReceipts.ts` | `t3o-02` | `BoardCardId` import                                                    | one-line append (import)                 |
| `apps/server/src/persistence/Services/OrchestrationCommandReceipts.ts` | `t3o-02` | Widen receipt `aggregateId` union                                       | one-line edit                            |
| `apps/server/src/ws.ts`                                                | `t3o-02` | Import board shell-delta mapper                                         | one-line append (import)                 |
| `apps/server/src/ws.ts`                                                | `t3o-02` | Board events become card shell deltas in `toShellStreamEvent`           | case append (2 lines, delegating call)   |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`                    | `t3o-02` | Import `SidebarBoardLink`                                               | one-line append (import)                 |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`                    | `t3o-02` | Board mode entry above Settings                                         | one-line append (delegating element)     |
| `packages/client-runtime/src/state/shell.ts`                           | `t3o-02` | Export board client state through `state/shell`                         | one-line append (re-export)              |
| `packages/client-runtime/src/state/shellReducer.ts`                    | `t3o-02` | Import board reducer                                                    | one-line append (import)                 |
| `packages/client-runtime/src/state/shellReducer.ts`                    | `t3o-02` | Card deltas delegate to the board reducer                               | case append (3 lines, delegating call)   |
| `packages/contracts/src/index.ts`                                      | `t3o-02` | Export `board.ts`                                                       | one-line append                          |
| `packages/contracts/src/orchestration.ts`                              | `t3o-02` | Import board schema                                                     | one-line append (import)                 |
| `packages/contracts/src/orchestration.ts`                              | `t3o-02` | `board` field on `OrchestrationReadModel` (optional)                    | one-line append                          |
| `packages/contracts/src/orchestration.ts`                              | `t3o-02` | `cards` field on `OrchestrationShellSnapshot` (optional)                | one-line append                          |
| `packages/contracts/src/orchestration.ts`                              | `t3o-02` | Card deltas in `OrchestrationShellStreamEvent` union                    | two-line append                          |
| `packages/contracts/src/orchestration.ts`                              | `t3o-02` | `BoardCardCreateCommand` in `DispatchableClientOrchestrationCommand`    | one-line append                          |
| `packages/contracts/src/orchestration.ts`                              | `t3o-02` | `BoardCardCreateCommand` in `ClientOrchestrationCommand`                | one-line append                          |
| `packages/contracts/src/orchestration.ts`                              | `t3o-02` | `board.card-created` in `OrchestrationEventType`                        | one-line append                          |
| `packages/contracts/src/orchestration.ts`                              | `t3o-02` | `"card"` in `OrchestrationAggregateKind` (D9)                           | one-line edit                            |
| `packages/contracts/src/orchestration.ts`                              | `t3o-02` | `BoardCardId` in event-base `aggregateId` union (D9)                    | one-line edit                            |
| `packages/contracts/src/orchestration.ts`                              | `t3o-02` | Board event member in the `OrchestrationEvent` union                    | block (5-line union member)              |

Marker-less upstream churn that rides along with `t3o-02`:

- `apps/web/src/routeTree.gen.ts` — regenerated by TanStack Router for the new `/board` route file.
  Never hand-edited; on a conflicted merge, take either side and regenerate.

Where the spec's estimate met reality: the spec listed ~20 insertion points; the landed count is
**38 markers across 13 upstream files**. The delta is almost entirely the card aggregate (D9)
rippling through three narrowly-typed `ProjectId | ThreadId` unions (event store, receipts, engine)
plus one import line per touched file — all mechanical one-liners. Two planned seams turned out to
be unnecessary: `OrchestrationCommand` (derived union — covered by the dispatchable append) and
`createEmptyReadModel` (the `board` field is optional, so the empty model needs no edit). The
`ClientOrchestrationCommand` → engine path also needed **no** Normalizer seam — unrecognized
commands pass through untouched.

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

**Kept on:** `ci.yml` (the actual build, lint, typecheck and test gates — we want these), plus
`pr-size.yml`, `pr-vouch.yml` and `issue-labels.yml`, which are cheap, self-contained, and harmless
if they never fire on a single-maintainer repo. Revisit if they turn out to be noisy.

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
