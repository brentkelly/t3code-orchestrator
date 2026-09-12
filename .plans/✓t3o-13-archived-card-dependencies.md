---
id: t3o-13
title: Archived cards — dependency semantics, archive guard, and an archive view
phase: 2
prerequisites: [t3o-03, t3o-06]
---

# Archived cards — dependency semantics, archive guard, and an archive view

Archiving a card that other cards depend on is currently a one-way trap. Three defects, one
spec.

## The defects

1. **`Unknown task` on `unknown card`.** `listBoardCardShellRows`
   (`apps/server/src/board/projection.ts:411`) filters `WHERE archived_at IS NULL` — correct
   per D15, the archive must not ride the live shell — but `BoardCardDetail.tsx:107` resolves
   dependency chips *from that shell*. An archived dependency resolves to nothing and renders
   as `Unknown task` / `unknown card`.

2. **Permanent block.** `unmetBoardCardDependencies` (`packages/contracts/src/board.ts:549`)
   counts a dependency as unmet unless `stage === "done"`. An archived-but-not-done card is
   unmet forever, so the decider's Ready-crossing gate (`decider.ts:409`) refuses to let any
   dependent past Ready — with no recourse, because nothing surfaces the archived card.

3. **No archive view.** `board.card.unarchive` exists end-to-end and the detail modal already
   renders **Restore card** for an archived card (`BoardCardDetailView.tsx:594`) — but there is
   no way to *find* an archived card, so the button is unreachable.

## Goal

Archiving becomes a safe, reversible, non-destructive act: it never destroys a dependency edge,
never permanently blocks another card, always tells you what pointed at the card, and is always
undoable from the board.

## Scope

**In**

- Archived dependencies stop gating (contract-level derivation change).
- Stored `blocked` flags stay truthful across archive/unarchive.
- Card detail carries resolved `dependencies` and `dependents`.
- Dependency chips render archived dependencies properly.
- A confirmation modal before archiving a not-done card with live dependents.
- An **Archived** view on the board, with restore.
- A projection migration recomputing stale `blocked` flags.

**Out**

- Deleting cards (archive is the only removal; no `board.card.delete`).
- Any change to thread archiving or the Settings → Archived threads panel.
- Auto-archive / `archiveAfterDays` (D10's Phase-2 archiver, untouched).
- Cascading archive of dependents.
- An agent-facing archive tool — see *Assumption* below.

## Locked decisions

### D1 — Dependency edges survive archive; archived dependencies stop gating

`dependsOn` is never rewritten by archive. Instead `unmetBoardCardDependencies` skips any
dependency whose card is archived:

```ts
export function unmetBoardCardDependencies(input: {
  readonly dependsOn: ReadonlyArray<BoardCardId>;
  readonly cards: ReadonlyArray<Pick<BoardCard, "id" | "stage" | "archivedAt">>;
}): ReadonlyArray<BoardCardId> {
  return input.dependsOn.filter((dependencyId) => {
    const dependency = input.cards.find((card) => card.id === dependencyId);
    if (dependency === undefined) return true;          // genuinely missing → still unmet
    if (dependency.archivedAt !== null) return false;   // archived → no longer gates
    return dependency.stage !== "done";
  });
}
```

*Rationale.* Archiving means "this work is not happening" — a gate on work that will never
arrive is not a gate, it is a deadlock. Keeping the edge makes unarchive a true inverse: restore
the card and the gate returns by itself, with no restoration bookkeeping and no lost data.

The `cards` parameter widens from `Pick<BoardCard, "id" | "stage">` to include `archivedAt`. All
four call sites (`decider.ts:411,435,543,697`) already pass `board.cards` — full `BoardCard`s
from a read model that retains archived cards — so no call site changes.

The decider's unmet-rejection message keeps its `an archived or deleted card ('<id>')` branch;
it now only describes a genuinely missing id.

### D2 — The archive guard is a UI confirmation, not a server invariant

`decideBoardCommand` keeps accepting `board.card.archive` unconditionally. Under D1 archiving is
non-destructive and fully reversible, so there is no data invariant left to protect; the guard
exists to inform a human, and lives where the human is.

**Assumption, recorded deliberately:** the sole dispatcher of `board.card.archive` is
`apps/web/src/board/BoardCardDetail.tsx:208`. The MCP board toolkit (`mcp/toolkits/board/tools.ts`)
exposes create / move / update / list / plan tools and **no archive tool**. If an agent-facing
archive tool is ever added, this decision must be revisited — the guard would have to move into
the decider behind an explicit `force` flag on the command.

### D3 — The modal fires on: not done, and at least one live dependent

Warn when **both** hold:

- the card's `stage !== "done"`, and
- at least one **non-archived** card lists it in `dependsOn`.

Archiving a done card cannot affect any dependent (done already satisfies the gate, and stays
satisfying it once archived), and a card nothing depends on has nothing to warn about — both
stay a single click. Archived dependents are not counted: they are not affected and not visible.

Dependents are counted regardless of *their* stage. A dependent already past Ready is not harmed,
but "what pointed at this card" is exactly the question the modal answers.

### D4 — Resolved `dependencies` and `dependents` ride `BoardCardDetail`

The shell snapshot excludes archived cards and carries only `dependencyCount`, never the ids, so
the client can resolve neither an archived dependency's title nor the set of dependents.
`BoardCardDetail` — the per-card `board.subscribeCard` stream, which exists only while a card is
open — grows two resolved arrays:

```ts
export const BoardCardDependencyRef = Schema.Struct({
  cardId: BoardCardId,
  key: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  stage: BoardStage,
  archivedAt: Schema.NullOr(IsoDateTime),
});

export const BoardCardDetail = Schema.Struct({
  card: BoardCard,
  brief: Schema.NullOr(TrimmedNonEmptyString),
  /** `card.dependsOn` resolved, in `dependsOn` order; archived ones included. */
  dependencies: Schema.Array(BoardCardDependencyRef),
  /** Cards whose `dependsOn` names this card; archived ones included. */
  dependents: Schema.Array(BoardCardDependencyRef),
});
```

Resolved server-side in `makeBoardCardDetailLoader` (`board/projection.ts`) from the projection
table, which retains archived rows. Rejected alternatives: putting archived cards back on the
shell (breaks D15, grows every client's snapshot by the whole archive forever, and still leaves
dependents uncomputable); a dedicated `board.cardDependents` RPC (extra RPC + scope + atom, and
leaves the chip bug needing its own fix).

`BoardCardDetail.tsx` stops deriving `dependencies` from the shell snapshot and reads
`detail.dependencies`. The shell lookup stays only as the source of `dependencyOptions` (the
add-picker), which correctly offers live cards only.

### D5 — Archive and unarchive re-derive dependents' stored `blocked`

`blocked` is a stored column re-derived at move / dependency edit / unarchive. Under D1,
archiving card X now changes whether X's dependents are blocked, so the flag would otherwise go
stale — a card showing a blocked badge that the decider will happily move.

`board.card.archive` and `board.card.unarchive` therefore decide an **array**: the
archived/unarchived event first, then one `board.card-updated` event per live dependent whose
re-derived `blocked` differs from its stored value. Dependents whose flag does not flip emit
nothing.

This is supported and safe:

- `DecideOrchestrationCommandResult` is `PlannedOrchestrationEvent | ReadonlyArray<…>`
  (`orchestration/decider.ts:179`) and the engine already loops over the array
  (`OrchestrationEngine.ts:176`), appending inside one transaction.
- `eventStore.append(event)` takes each event's own `aggregateId` with no expected-version
  argument, and commands are serialised through a single-writer queue — cross-aggregate events
  from one command are fine.
- The projector already maps `board.card-updated` → `upsertCard` and → a `card-upserted` shell
  delta, so every client's board updates live with no new projector or reducer code.

Blocked is not transitive (the gate reads only *direct* dependencies' stage), so there is no
cascade — one level of dependents is complete.

`decideBoardCommand`'s return type widens to
`PlannedOrchestrationEvent | ReadonlyArray<PlannedOrchestrationEvent>`.

Both derivations run against the post-change card set — the archived card substituted into
`board.cards` — so the flag reflects the world after the event, not before it.

### D6 — Migration 012 recomputes stale `blocked`

Databases already carry cards flagged `blocked = 1` because of an archived dependency. The gate
itself is derived live at move time, so those cards are no longer *stuck* once D1 lands — but the
badge lies until the card's next move or dependency edit.

`apps/server/src/board/migrations/012_BoardCardsRecomputeBlocked.ts` recomputes `blocked` for
every row from `depends_on`, the dependency's `stage`, and the dependency's `archived_at`,
applying the D1 rule and the Ready-or-beyond stage condition. Archived rows are recomputed too —
their flag is re-derived on unarchive anyway, and excluding them would only add a branch. Follows the guarded,
idempotent style of `004_BoardCardsColumns.ts`. Board migrations are id-mapped — check
`migrations/index.ts` and `reconcile.test.ts` for the id this file must claim before writing it.

### D7 — An **Archived** sheet on the board, not a column filter

The board top bar gains an **Archived** button opening a sheet (`components/ui/sheet.tsx`) that
lists archived cards for the current project scope — key, title, stage at archive, archived-at,
newest first — each with a **Restore** action and click-through to the existing detail modal.
Open/closed is transient component state — nothing about a sheet you opened once is worth
persisting across sessions, so `boardUiStore` stays as it is.

Rejected: rendering archived cards inline in their stage columns behind a "show archived" toggle.
That means merging a second snapshot source into `BoardStageColumns`, which is fed by the live
shell stream through `applyBoardCardPlacements` / `mergeBoardStageColumns` / optimistic drag
reconciliation — the one piece of board code whose header warns it decides *when* to dispatch and
never *what number* to store. The sheet leaves all of it untouched.

Data reuses the existing archive-page seam rather than inventing an RPC:

- `BoardCardShell` gains `archivedAt: Schema.NullOr(IsoDateTime)` — additive, null on the live
  shell (whose SQL already filters `archived_at IS NULL`), and a pass-through in
  `makeBoardCardShell` / `boardCardShellFromCard`.
- `withBoardArchivedShellCards` mirrors `withBoardShellCards` with `WHERE archived_at IS NOT NULL`,
  and `boardSnapshotQueryMethods` wraps `base.getArchivedShellSnapshot()` with it. That function's
  `base` `Pick` widens by one key — the seam comment at `projection.ts:1400` anticipates exactly
  this.
- The client reads the existing `orchestrationEnvironment.archivedShellSnapshot` atom (already
  used by the Settings → Archived threads panel) and refreshes it after a restore, the same way
  `refreshArchivedThreadsForEnvironment` does.

### D8 — Archived dependency chips read as archived, not as broken

`BoardCardFields.tsx` renders a dependency from the resolved ref: real key and title, with the
trailing status reading `Archived` (muted) instead of the stage label, and the row de-emphasised.
`Unknown task` / `unknown card` survives only for a genuinely unresolvable id. The remove (`×`)
control stays available on archived dependencies. Chips remain click-through to the dependency's
own detail modal if they are today.

### D9 — Modal shape: cancel is the default

An `AlertDialog` (`components/ui/alert-dialog.tsx`):

- Title names the act: *Archive `<KEY>`?*
- Body: "`<n>` card(s) depend on this card." then the list — key + title per dependent, capped at
  10 with a `+N more` line.
- Explains the consequence in one line: archiving keeps the links but stops this card blocking
  them; restoring it puts the block back.
- **Cancel** is the default and focused action; **Archive anyway** is the secondary, destructive-styled
  action.
- Dismissing by Escape or backdrop cancels.

The dependent list comes from `detail.dependents` filtered to `archivedAt === null`.

## Acceptance criteria

1. A card whose only unmet dependency is archived-and-not-done moves past Ready, and its
   `blocked` badge is clear.
2. Archiving a not-done card with live dependents opens the modal listing them; **Cancel**
   leaves the card unarchived; **Archive anyway** archives it and its live dependents' `blocked`
   flags clear in the same board update, with no reload.
3. Archiving a **done** card, or a card with no live dependents, archives immediately with no
   modal.
4. Restoring an archived, not-done card re-blocks every dependent that the D1 rule says is now
   gated — again in the same board update.
5. A dependency on an archived card renders its real key and title, marked `Archived`; no
   `Unknown task` / `unknown card` for a card that exists.
6. The board's **Archived** sheet lists archived cards for the current project scope, newest
   first, and **Restore** returns a card to its stage column live.
7. Existing databases with stale `blocked = 1` rows read correctly after migration 012, with no
   card touched that the rule says is genuinely blocked.
8. `dependsOn` is never rewritten by archive or unarchive — round-tripping archive → unarchive
   leaves the card byte-identical apart from `archivedAt` / `updatedAt` / `blocked`.

## Tests

- `packages/contracts/src/board.test.ts` — `unmetBoardCardDependencies` /
  `deriveBoardCardBlocked` across the matrix: live-not-done, live-done, archived-not-done,
  archived-done, missing id.
- `apps/server/src/board/decider.board.test.ts` — archive/unarchive emitting the dependent
  `card-updated` events (and emitting none when no flag flips); the Ready-crossing gate passing
  with an archived dependency; the rejection message for a genuinely missing id.
- `apps/server/src/board/projector.board.test.ts` — the dependent `card-updated` events produce
  `card-upserted` shell deltas.
- `apps/server/src/board/projection.ts` coverage — detail loader resolving `dependencies` /
  `dependents` including archived ones; `withBoardArchivedShellCards` returning only archived
  cards with `archivedAt` populated.
- `apps/server/src/board/migrations/reconcile.test.ts` — migration 012 id and idempotency.
- `apps/web/src/board/BoardCardDetailView.test.tsx` — archived dependency chip; modal appears
  under D3's condition and not otherwise; Cancel is the focused action.
- A test for the Archived sheet's list + restore wiring.
