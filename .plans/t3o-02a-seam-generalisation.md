---
id: t3o-02a
title: Seam generalisation — move all board-specific code out of core directories
phase: 0
prerequisites: [t3o-02]
---

# Seam generalisation

The walking skeleton proved the core can accept a board extension — one conflict in 20 upstream
commits validated the seam strategy. But several seams are **enumerations** (a case per command, an
entry per registry, a union member per event), so the core diff grows with every feature.

**The rule going forward: predicates, spreads, and re-exports only in core.** A core seam is a
conditional dispatch on a board predicate, a spread of a board-owned registry, a single injected
factory call, or a re-export. Everything else lives in board-owned code. A diff between upstream's
repo and ours, excluding board-owned files, should show *only* the surgical seams — and that diff
should be **frozen**: t3o-03's seven commands and seven events must add zero lines to it.

## The `board.` prefix rule (new, load-bearing)

The predicates that make generic seams possible key on naming:

- Every board command `type` starts with `board.` — `BoardCommand = Extract<OrchestrationCommand,
  { type: `board.${string}` }>`.
- Every board event `type` starts with `board.`.
- Every board shell-stream delta `kind` starts with `card-` (revisit if non-card board deltas ever
  appear).

`isBoardCommand` / `isBoardEvent` / `isBoardShellStreamEvent` are type guards exported from
`packages/contracts/src/board.ts` (server and clients both need them), implemented as
`type.startsWith("board.")` etc. This convention is self-policing: a board command named without
the prefix falls outside the `Extract`, reaches upstream's `satisfies never`, and fails the build.

**Record this rule in `docs/t3o/seams.md`** as part of this spec.

## Analysis of PR #1 against the rule

### ✅ Board-owned (stays where it is)

New files or naturally board-scoped; upstream will never touch them:

- `apps/server/src/board/decider.ts`, `projector.ts`, `projection.ts`, `walkingSkeleton.test.ts`
- `apps/server/src/persistence/Migrations/900_BoardCards.ts`
- `apps/web/src/board/BoardPage.tsx`, `SidebarBoardLink.tsx`; `apps/web/src/state/board.ts`
- `packages/contracts/src/board.ts`
- `packages/client-runtime/src/state/board.ts`, `board.test.ts`;
  `packages/client-runtime/src/operations/boardCommands.ts`
- `docs/t3o/seams.md`

### ✅ Acceptable frozen core seams (once-only, do not grow per feature)

- Aggregate-id union widenings (`ProjectId | ThreadId | BoardCardId`) in
  `packages/contracts/src/orchestration.ts`, `apps/server/src/persistence/Layers/OrchestrationEventStore.ts`
  (×2), `apps/server/src/persistence/Services/OrchestrationCommandReceipts.ts` — D9 consequences;
  upstream will never create `BoardCardId`. Keep as-is.
- `"card"` in `OrchestrationAggregateKind` and in `commandToAggregateRef`'s return-type annotation
  (plus its `BoardCardId` import) in `OrchestrationEngine.ts` — same D9 class. Keep as-is.
- `OrchestrationReadModel.board` (optional `BoardState`) and `OrchestrationShellSnapshot.cards`
  (optional array) — single fields whose *shape* grows inside board-owned `BoardState`, never at
  the seam. Keep as-is.
- `export * from "./board.ts"` in `packages/contracts/src/index.ts` and
  `packages/client-runtime/src/state/shell.ts` — re-exports, frozen. Keep as-is.
- One `T3o:` import line per seamed core file — frozen (imports reference board-owned registries
  and predicates, which grow internally).

### 🔴 Must refactor — contracts (the biggest omission from the first draft of this spec)

`packages/contracts/src/orchestration.ts` currently enumerates board members in four places.
Under t3o-03 these alone would grow ~15–20 lines. Generalise all four:

1. **Client command unions** (`DispatchableClientOrchestrationCommand`, `ClientOrchestrationCommand`)
   — replace the `BoardCardCreateCommand,` member with a spread of a board-owned array:
   `...BOARD_CLIENT_COMMANDS,` (a `readonly [...]` of command schemas exported from `board.ts`;
   `Schema.Union` takes an array, so a spread of schema members works).
2. **`OrchestrationEventType` literals** — replace `"board.card-created",` with
   `...BOARD_EVENT_TYPES,` (board-owned `as const` string array).
3. **`OrchestrationEvent` union** — replace the inline 5-line member with one injected factory
   call: `...makeBoardOrchestrationEvents(EventBaseFields),`. `board.ts` cannot import
   `EventBaseFields` (orchestration.ts imports board.ts — a module cycle with TDZ failure at
   load), so the seam *injects* the base fields into a board-owned factory that returns the event
   struct members. Upstream base-field changes then flow into board events automatically.
4. **`OrchestrationShellStreamEvent` union** — replace the two named members with
   `...BOARD_SHELL_STREAM_EVENTS,`.

After this, adding a board command/event touches only `board.ts`.

### 🔴 Must refactor — server (enumeration → predicate/spread)

**`apps/server/src/orchestration/decider.ts`**
- Currently: `case "board.card.create": return yield* decideBoardCommand(...)` at the switch head.
- Should be: inside upstream's existing `default` block, *before* `command satisfies never`:
  ```ts
  // T3o: board commands are decided in the board module.
  if (isBoardCommand(command)) return yield* decideBoardCommand({ command, readModel });
  ```
- Why it stays exhaustive: the type guard narrows, so after the board branch returns, `command`
  excludes board members and upstream's `satisfies never` still fails the build when upstream adds
  an unhandled command.

**`apps/server/src/orchestration/projector.ts`**
- Currently: `case "board.card-created": return projectBoardEvent(nextBase, event)`.
- Should be: predicate before the (permissive) `default` return:
  `if (isBoardEvent(event)) return projectBoardEvent(nextBase, event);`

**`apps/server/src/orchestration/Layers/OrchestrationEngine.ts`**
- Currently: inline `case "board.card.create": return { aggregateKind: "card", ... }`.
- Should be: `if (isBoardCommand(command)) return boardCommandAggregateRef(command);` before the
  default (the ref-building logic moves to `board/`). After the guard, board commands are excluded
  from the default branch, so upstream's `command.threadId` access still typechecks. The widened
  return-type annotation stays (frozen seam, see above).

**`apps/server/src/orchestration/Layers/ProjectionPipeline.ts`** *(already half-done)*
- The projector list already spreads `...makeBoardProjectors(sql)` — keep.
- Remaining: remove the `boardCards: BOARD_CARDS_PROJECTOR_NAME` entry from
  `ORCHESTRATION_PROJECTOR_NAMES` (it grows per projector) and instead widen the
  `ProjectorDefinition.name` type by one frozen union member
  (`ProjectorName | BoardProjectorName`, the latter exported from `board/projection.ts`). This
  swaps a per-projector seam for a once-only type widening — t3o-03+ adds more projectors
  (`board_plans`, …) with zero pipeline edits.

**`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`** *(scope clarified)*
- In scope: replace the two inline method wraps with one spread of a board-owned factory, placed
  after the base methods in the returned object literal so board-wrapped versions override:
  ```ts
  // T3o: board snapshot enrichment (D2/D8) — board module wraps what it needs.
  ...boardSnapshotQueryMethods(sql, { getCommandReadModel, getShellSnapshot }),
  ```
  When t3o-03 needs to wrap more methods (e.g. `getSnapshot`), only the board factory's parameter
  list grows — hand it the whole method record if that is cleaner.
- Out of scope (deferred): any deeper restructuring of this file's internals. It has no clean
  split point; do not attempt one here.

**`apps/server/src/ws.ts`**
- Currently: `case "board.card-created": return Effect.succeed(boardCardShellStreamEvent(event))`.
- Should be: at the top of the `default` branch (before the `aggregateKind !== "thread"` check —
  board events would otherwise be swallowed by it):
  `if (isBoardEvent(event)) return Effect.succeed(boardShellStreamEvent(event));`
  (Rename the board-side function to `boardShellStreamEvent` — it will handle all board events,
  not just card creation.)

### 🔴 Must refactor — persistence registry

**`apps/server/src/persistence/Migrations.ts`**
- Currently: `import Migration0900 …` + named `[900, "BoardCards", Migration0900]` entry — grows
  per migration.
- Should be: one import of a board-owned registry (e.g. `apps/server/src/board/migrations.ts`
  exporting `BOARD_MIGRATIONS: readonly (readonly [number, string, Migration])[]`) and one spread
  `...BOARD_MIGRATIONS,` at the tail of `migrationEntries`. `Migrator.fromRecord` sorts by id, so
  position is irrelevant; ids stay 900+. Mind the `as const` typing on `migrationEntries` — type
  the board registry so the spread stays assignable to what `makeMigrationLoader` and
  `migrationManifest` consume.

### 🔴 Must refactor — client runtime (correcting the first draft's misaudit)

**`packages/client-runtime/src/state/shellReducer.ts`**
- The first draft claimed this "already uses a predicate" — **it does not**; it enumerates
  `case "card-upserted": case "card-removed":` delegating to the board reducer.
- Convert for consistency: predicate before the (permissive, forward-compatible) `default`:
  `if (isBoardShellStreamEvent(event)) return applyBoardShellStreamEvent(snapshot, event);`

### 🟡 Web routing (framework-constrained; keep as-is)

- `apps/web/src/routes/board.tsx` — route files are framework-mandated locations. Keep.
- `apps/web/src/routeTree.gen.ts` — generated; never hand-edit; regenerate on conflict.
- `apps/web/src/components/sidebar/SidebarChrome.tsx` — one delegating element
  (`<SidebarBoardLink />`) + import. Already the pattern; keep. If board sidebar presence ever
  grows, it grows inside `SidebarBoardLink`, not here.

## Refactoring scope — summary

Nine core files change shape (contracts ×1, server ×6, persistence registry ×1, client runtime ×1);
`packages/contracts/src/board.ts` and `apps/server/src/board/*` gain the registries, factories, and
predicates those seams consume. Nothing else in core is touched. The earlier "five files" count and
the ProjectionSnapshotQuery in-scope/deferred contradiction from the first draft are superseded by
the lists above.

## The exhaustiveness guarantee

**Non-negotiable:** every predicate must fall through to upstream's existing exhaustiveness handler
when false. A bare `default:` that swallows board members must NOT hide upstream errors.

```ts
// WRONG:
default:
  if (isBoardCommand(command)) return decideBoardCommand(...)
  // silently falls through — upstream's missing-case errors disappear

// RIGHT:
default:
  if (isBoardCommand(command)) return decideBoardCommand(...)
  command satisfies never;            // upstream's existing handler, untouched
  return upstreamInvariantError(...)
```

Verify both directions before calling done:

- Add a scratch command to the **upstream** union → build must fail (at upstream's
  `satisfies never`, proving the predicate narrowing preserved it).
- Add a scratch **board** command to `BoardCommand` with no branch in `board/decider.ts` → this
  fails at build time **only once `BoardCommand` has ≥2 members** (single-member unions don't
  narrow through `satisfies never` — discovered in PR #1 round 1; the board decider's explicit
  runtime default covers the one-member window today). With the scratch command added the union
  has 2 members, so the build-failure check works — run it.

Delete both scratches afterwards and state in the PR that both checks ran.

## Success criteria

1. **Zero board logic in core directories.** Board behaviour lives in `board/` modules and
   `contracts/src/board.ts`; core files contain only predicates, spreads, injected factory calls,
   re-exports, and the frozen once-only seams listed above.
2. **The core diff is frozen.** After this spec, t3o-03's seven commands and seven events add
   **zero** lines to upstream-owned files. That is the falsifiable test of this refactor — check it
   explicitly when t3o-03 lands.
3. **The diff is auditable in one command.** Add the core-only diff audit to `docs/t3o/seams.md`
   alongside `rg "T3o:"`:
   ```bash
   git diff upstream/main...t3o -- . ':!*/board/*' ':!*board*' ':!docs/t3o' ':!.plans' ':!AGENTS.md' ':!*routeTree.gen.ts'
   ```
   This is the artifact the fork's invasiveness claim rests on; keep the exclusion list honest as
   board-owned paths are added.
4. **The seam inventory matches reality.** The refactor changes seam shapes and counts — rewrite
   the inventory table in `docs/t3o/seams.md` row-for-row against `rg "T3o:"`, and record the new
   marker count.

## Verification

- Walking-skeleton tests pass unchanged (`apps/server/src/board/walkingSkeleton.test.ts`,
  `packages/client-runtime/src/state/board.test.ts`), plus the seam-adjacent upstream suites
  (engine, projection pipeline, snapshot query, projector, event store, shell reducer, contracts).
- Typecheck clean in contracts, client-runtime, server, web.
- Exhaustiveness holds both ways (see guarantee above, including the ≥2-member caveat).
- Re-run the upstream sync runbook once and add a row to the merge log in `docs/t3o/seams.md` —
  the seams that just changed shape should be re-proved against real churn.
