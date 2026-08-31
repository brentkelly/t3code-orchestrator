---
id: t3o-26
title: Board database separation — all t3o state in boards.sqlite, nothing upstream cannot read
phase: 3
prerequisites: []
---

# Board database separation

Today a t3o database is a one-way door. Board rows live in upstream's `orchestration_events`
under types (`board.*`) and aggregate kinds (`card` / `label` / `stage`) that stock t3code's
closed `Schema.Literals` unions reject on read. Point upstream at a database t3o has touched and
its replay fails — not degrades, fails.

That is the whole obstacle to trialling t3o. Nobody wants to try a fork that eats the database
holding every thread they have.

This spec moves every t3o-owned row into its own `boards.sqlite` and leaves upstream's file
carrying only rows upstream already understands. The promise it delivers is deliberately narrower
than "t3o never writes to your database", because that promise is not achievable — see D5.

## The promise

> **t3o writes nothing to your database that stock t3code cannot read.**

Delete `boards.sqlite` and what remains is a stock t3code database with some extra threads in it.
No eject script, no cleanup step, no decode failures.

## What already exists (so that none of it is rebuilt)

| Thing | Where | Status |
| --- | --- | --- |
| Separate board migration lineage + ledger | `board/migrations/index.ts`, `t3o_sql_migrations` | Done, retargeted in P1 |
| Board tables carry **zero** foreign keys | all 26 board migrations | Done, nothing to sever |
| Every board SQL `JOIN` is board↔board | `projection.ts:1311`, `:1332` | Done, untouched |
| Retired `board.*` event types survive replay | `OrchestrationEventStore.ts` `decodeReadRow` | Done, prerequisite met |
| Board events are namespaced `board.*` | `contracts/board.ts:3557` | Done, the partition key |
| No t3o migrations in upstream's lineage | `persistence/Migrations/` | Done, upstream schema is pristine |
| Board projector is already a separate module | `board/projection.ts`, spread at `ProjectionPipeline.ts:1642` | Done, unhooked in P2 |
| Board commands already carry their own aggregate refs | `OrchestrationEngine.ts`, `boardCommandAggregateRef` | Done, retargeted in P2 |

## Scope

**In:** the 12 `board_*` tables, the board migration ledger (`t3o_sql_migrations`), board events, board command receipts,
the board projector watermark, the board settings key, and the client protocol changes those
imply.

**Out:** thread and project data of any kind. Worktrees the board provisions stay in
`baseDir/worktrees` — they are git worktrees on disk, not database rows, and they are the user's
work. Attachments and logs are unchanged.

## Locked decisions

### D1 — One connection, `ATTACH`, not a second client

`boards.sqlite` is `ATTACH`ed to the existing connection as schema `boards`. Not a second
`SqlClient`, not a second connection pool.

SQLite handles the locking, cross-schema reads stay one statement, and — critically — the board
projector's transaction only ever *writes* one database. SQLite's caveat that multi-database
transactions lose atomicity under WAL applies to transactions that modify more than one attached
file; a transaction confined to `boards.*` tables is atomic regardless. That is why D2 moves the
board event log across in the same step as the tables, and never leaves a half-split state
running.

`journal_mode` is per-database, so the `PRAGMA journal_mode = WAL` at `Sqlite.ts:38` must be
issued for the attached database too. `foreign_keys` is per-connection and needs no change.

### D2 — The board gets its own event log, with its own sequence

`boards.orchestration_events` (same DDL as upstream's, own `AUTOINCREMENT`), plus
`boards.command_receipts` and `boards.projection_state`. Board commands append there; the board
projector reads there and records its watermark there.

The two logs have independent sequence counters and no defined interleaving between them. That is
a genuine loss and D3 is what makes it survivable.

### D3 — The board tails upstream's log read-only; the watermark lives in `boards.sqlite`

The board projector consumes exactly two upstream event types — `thread.activity-appended` and
`thread.deleted` (`projection.ts:1985`, `:1997`) — and both feed only `board_thread_todos`, a
cache with an existing boot orphan sweep (`projection.ts:1281`).

So the board keeps reading `main.orchestration_events`, filtered to those two types, with its
cursor stored in `boards.projection_state` under a distinct projector name. Reading is not
writing; the promise holds.

Everything else the supervisor learns from thread events it *records as a board event* before it
matters, so board replay needs the board log and nothing else. This is what makes two logs
tractable at all — verify it holds before building P2, because the whole design rests on it.

The one cross-schema SQL reference in the codebase — the orphan sweep's
`SELECT thread_id FROM projection_threads` (`projection.ts:1290`) — becomes
`main.projection_threads` and is otherwise unchanged.

### D4 — The board gets its own subscription, not a widened shell sequence

This is the hard part, and the reason P3 is its own phase.

The client's shell protocol assumes **one monotonic sequence space**. Board events are mapped into
the shell stream carrying `event.sequence` (`ws.ts:604`), the client drops anything at or below its
snapshot sequence (`ws.ts:710-726`), and resume replays from the durable log after `afterSequence`
against `orchestrationEngine.latestSequence` (`ws.ts:1251`). Two logs means two counters, and a
board sequence of 412 is meaningless against a thread sequence of 88301.

**Decision: give the board its own subscription** — its own snapshot, its own sequence, its own
resume cursor — and stop mapping board events into the orchestration shell stream. One store, one
stream, one cursor per system. The `boardCardThreadsShellEvents` derivation that currently rides
thread events (`ws.ts:571`) moves onto the board stream, which already tails upstream's log per D3.

Rejected: adding a second cursor to `subscribeShell`. It is less client work, but it makes every
shell delta carry a discriminator and leaves two sequence spaces interleaved in one stream — on top
of the sibling-sequence fragility already flagged at `ws.ts:719`. Cheaper now, worse forever. If P3
proves too large to land in one go, this is the fallback, not the plan.

### D5 — What the promise does not cover

The board's job is to drive thread work. `supervisorReactor.ts` dispatches `thread.create` (`:604`),
`thread.turn.start` (`:622`), `thread.settle` (`:1254`) and `thread.delete` (`:640`). Those run
through upstream's engine and write ordinary thread events to `state.sqlite`. A card that runs a
build has to create a thread.

This is not a leak to be plugged — it is the product, and those threads are exactly what the user
wants to keep when they leave. The promise is about *legibility*, not abstinence: everything t3o
writes to `state.sqlite` is a row stock t3code already knows how to read.

Say this plainly in the README. A promise stated precisely is worth more than a broader one that
turns out to have an asterisk.

### D6 — Data migration is one-way, idempotent, and lives in the board lineage

Moving existing databases is `INSERT INTO boards.x SELECT * FROM main.x` followed by
`DROP TABLE main.x`, as numbered migrations in the existing board lineage (`t3o_sql_migrations`),
which already runs after upstream's and has its own high-water mark.

There is no down-migration. Going back to stock t3code is `rm boards.sqlite`, which is the point.

### D7 — Settings is a file, not a table

`settings.json` is a file (`config.ts`, `settingsPath`); t3o adds one top-level `board` key with a
decoding default (`contracts/settings.ts`). It moves to its own `board-settings.json` in the same
state dir.

Effect Schema ignores unknown keys by default and there is no `onExcessProperty: "error"` on the
settings decode, so a leftover `board` key is very likely harmless to upstream — but this is a
five-minute test, not an assumption, and P0 is where it gets written.

## Upstream surface budget

Keeping the diff against core t3code small is a hard constraint on this work, not a preference.
Baseline at time of writing: **36 upstream non-test files, +691/-46** across `apps/server/src` and
`packages/`. Ten are in this plan's blast radius; the rest (MCP, source control, VCS, auth,
client-runtime, settings) are board feature wiring or unrelated t3o work and are not touched.

The plan must come out **net negative**. Where it does not, say why in review.

| Upstream file | Now | After | Why |
| --- | --- | --- | --- |
| `OrchestrationEventStore.ts` | +84 -15 | net -~55 | -74 when `decodeReadRow` goes (end of P2), +~20 for the D8 parameterisation |
| `ws.ts` | +76 -20 | -~30 | board deltas leave the shell stream (P3) |
| `contracts/orchestration.ts` | +68 -11 | -~10 | board fields off the shell snapshot (P3) |
| `ProjectionSnapshotQuery.ts` | +8 | -8 | the board snapshot wrapper goes with P3 |
| `ProjectionPipeline.ts` | +6 | -6 | board projector spread deleted (P2) |
| `OrchestrationEngine.ts` | +13 -2 | +1 | export `makeOrchestrationEngine` |
| `Sqlite.ts` | +8 | +0 | see D8 |
| `decider.ts`, `projector.ts`, `OrchestrationCommandReceipts.ts` | +17 -1 | unchanged | see D9 |

### D8 — No new upstream files, and no new lines in `Sqlite.ts`

`config.ts` is currently **unmodified**. Adding `boardDbPath` to `deriveServerPaths` would make it
the 37th upstream file for a path join — derive the board path in board code from the `stateDir`
that is already exposed.

`Sqlite.ts` already calls two board-owned functions. The `ATTACH` and the per-database WAL pragma
go *inside* those, so the upstream file's line count does not move.

For the board's own engine instance, `makeOrchestrationEngine` (`OrchestrationEngine.ts:353`) is
module-private but already takes every dependency as an injected Effect service — export it and
build a board-scoped layer in `board/`.

The event store needs more than an export. `makeEventStore` (`OrchestrationEventStore.ts:167`)
hardcodes the `orchestration_events` table name in its SQL, and under D1 there is only one
`SqlClient`, so a board instance cannot be obtained by swapping the client. It must be
parameterised over its schema-qualified table name. Parameterise the event schema in the same pass
(three constants: `AppendEventRequestSchema`, `OrchestrationEventPersistedRowSchema`,
`decodeEvent`) — it is nearly free once the signature is opening, and it is what D9 needs later.

This is safe to do structurally: `OrchestrationEventStore.ts` took **2 commits in 6 months** on
main, the coldest file in the seam.

### D9 — The type-union widenings stay in this plan, but inherit rather than duplicate later

Roughly 196 lines across 8 upstream files exist only because board data shares upstream's closed
type unions: `BOARD_EVENT_TYPES` spliced into `OrchestrationEventType`, `card` / `label` / `stage`
in `OrchestrationAggregateKind`, `BoardCardId` in three `aggregateId` unions, and the delegation
guards in `decider.ts` and `projector.ts`.

**They stay for t3o-26.** Reverting them is not required by the database split and would double the
risk of a plan that already touches the event log.

But when it is revisited, the answer is to **inherit the machinery, not duplicate it** — and the
churn data says that is a better trade than "splices are cheap":

| File | Upstream commits (6mo) | t3o edit |
| --- | --- | --- |
| `decider.ts` | **30** | +5 guard |
| `projector.ts` | **18** | +4 guard |
| `OrchestrationEngine.ts` | 11 | +13 |
| `OrchestrationEventStore.ts` | **2** | +84 |

`makeOrchestrationEngine` is 354 lines coupled to the domain at exactly four points, ten call sites
total: `decideOrchestrationCommand` (2), `projectEvent` (4), `createEmptyReadModel` (2), and
`commandToAggregateRef`, defined locally at `:65` (2). Everything else — queue, pubsub, receipts,
metrics, tracing, transactions, read-model reconciliation after dispatch failure — is
domain-neutral. Pass those four in as a domain record and the board gets a second instance of the
real engine, with no copy to maintain.

That removes t3o's edits from the two files upstream touches most, at the cost of ~25 lines of
parameterisation in one file it touches moderately. A splice living in a file that takes 30
upstream commits in six months is the expensive kind of splice, not the cheap kind.

Two constraints on doing it:

- **Not in this plan.** It is a refactor of upstream's core command loop and is independent of the
  database work. Bundled together, a failure is unattributable. Sequence it after t3o-26 lands.
- **It puts indirection into upstream code that only t3o benefits from.** Worth paying, worth
  naming, and worth remembering if any of this is ever offered upstream.

## Phases

Each phase is independently shippable except where noted.

### P0 — The verification harness (do this first)

A test that provisions a database, drives real board work against it, then boots a
stock-upstream-shaped runtime against that same file and asserts a clean full replay from sequence
zero. Plus the settings-decode check from D7.

This is the definition of done for every later phase, and it is the artifact that makes the promise
checkable rather than aspirational. It also has standalone value today: it is the regression test
for the retired-event-type class of bug.

### P1 — `boards.sqlite`, attached, with the board tables in it

Provision and attach the file, retarget the board migration lineage at it, move the 12 tables and the ledger with
their data, qualify the orphan sweep's subquery.

**Do not ship P1 alone.** Between P1 and P2 the board projector's transaction spans two databases —
it writes `boards.board_*` and `main.projection_state` in one `withTransaction`
(`ProjectionPipeline.ts:1655`) — which is precisely the non-atomic case under WAL. Land P1 and P2
together, or keep P1 behind a flag.

### P2 — The board event log

Create the board log, receipts and projection_state; retarget board command append and the board
projector; migrate `board.*` rows across; unhook board projectors from `ProjectionPipeline` into
their own pipeline; wire the read-only upstream tail per D3.

This closes the cross-database transaction window and is the phase that actually delivers the
promise. Deleting `...makeBoardProjectors(sql)` from `ProjectionPipeline.ts:1642` also shrinks the
diff against upstream, which is worth something on every future rebase.

### P3 — The client protocol

Per D4: a board subscription with its own snapshot, sequence and resume cursor; board deltas off
the shell stream; `BoardState` and friends off the shell snapshot schema; web and mobile clients
updated to consume it.

Largest and riskiest phase. Scope it on its own once P2 is real.

### P4 — Settings split and the guarantee as a gate

`board` settings key to its own file per D7; P0's harness becomes a CI gate so the promise cannot
silently regress. Note CI is currently disabled on this fork — check `gh workflow list --all`
before assuming the gate runs.

## Acceptance criteria

- [ ] AC1 — A stock-upstream-shaped runtime boots against a t3o-exercised `state.sqlite` and
      replays every event from sequence zero with no decode failure. (P0, gated in P4.)
- [ ] AC2 — `state.sqlite` contains no row whose `event_type` starts with `board.`, and no
      `aggregate_kind` outside `project` / `thread`, after any amount of board use.
- [ ] AC3 — `state.sqlite` contains no `board_*` table and no `t3o_sql_migrations` table.
- [ ] AC4 — Deleting `boards.sqlite` leaves a working t3code database; threads the board spawned
      are present and openable, with full history.
- [ ] AC5 — An existing t3o database migrates forward with no card, label, stage, plan, activity
      or todo-cache loss. Re-running the migration is a no-op.
- [ ] AC6 — The board projector's write transaction touches exactly one database file.
- [ ] AC7 — Board replay from an empty board read model reproduces board state identically, using
      only `boards.sqlite` plus the read-only upstream tail of D3.
- [ ] AC8 — A board subscription resumes correctly from its own cursor across a disconnect, and
      the orchestration shell stream carries no board deltas. (P3.)
- [ ] AC9 — Stock t3code loads a `settings.json` written by t3o without error. (P0/P4.)
- [ ] AC10 — The upstream diff is net smaller than the 36-file / +691 baseline: no upstream file
      joins the diff that was not already in it, and `ProjectionPipeline.ts`,
      `ProjectionSnapshotQuery.ts` and the `decodeReadRow` block have left it.

## Files

| File | Change |
| --- | --- |
| `persistence/Layers/Sqlite.ts` | attach `boards.sqlite`, WAL pragma on it, ordering of the two lineages |
| `board/migrations/index.ts` | lineage targets the `boards` schema; new move-migrations |
| `board/projection.ts` | schema-qualify writes; `main.projection_threads` in the orphan sweep; upstream tail + its own watermark |
| `orchestration/Layers/ProjectionPipeline.ts` | remove the board projector spread (`:1642`) — diff against upstream shrinks |
| `board/` (new pipeline) | board projector pipeline over the board log |
| `persistence/Layers/OrchestrationEventStore.ts` | parameterise over schema-qualified table + event schema (D8); `decodeReadRow` deleted at the end of P2 |
| `orchestration/Layers/OrchestrationEngine.ts` | route board command append to the board store |
| `ws.ts` | board deltas off the shell stream; board subscription (P3) |
| `contracts/orchestration.ts` | `BoardState` / `cards` / `boardLabels` / `boardStages` / `boardCardThreads` off the shell snapshot (P3) |
| `contracts/settings.ts`, `serverSettings.ts` | `board` key to its own file (P4) |

## Open questions

1. **D3 is load-bearing and unverified.** Confirm that no board projector or supervisor path
   depends on upstream events beyond the two named types before building P2. If a third dependency
   exists, the two-log design needs revisiting, not patching.
2. **Test harness shape.** Tests run on `:memory:` (`Sqlite.ts:71`); each attached `:memory:` is a
   distinct database. Every test that seeds board tables directly needs the attach in place.
3. **P3 sizing.** Unknown until P2 lands. The existing sibling-sequence TODO (`ws.ts:719`) is in
   the blast radius and may be cheaper to fix as part of P3 than to work around.
