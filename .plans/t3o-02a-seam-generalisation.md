---
id: t3o-02a
title: Seam generalisation — move all board-specific code out of core directories
phase: 0
prerequisites: [t3o-02]
---

# Seam generalisation

The walking skeleton proved the core can accept a board extension — one conflict in 20 upstream commits validates the seam strategy. But the code is scattered across core directories.

**The rule going forward:** predicates only in core. Everything else moves to board-owned code or spreads from it. A diff between their repo and ours should show *only* the surgical seams, not board logic threaded through the core directory structure.

## Analysis of PR #1 against this rule

Twenty-nine files touched. Categorise each: **board-owned** (new or naturally board-scoped), **seam** (core file with a predicate/delegation), or **must-move** (board logic in core dirs).

### ✅ Board-owned (stays where it is)

These live in board-specific directories or packages that upstream will never touch:

- `apps/server/src/board/decider.ts` — board command decisions
- `apps/server/src/board/projection.ts` — board projections and shell enrichment
- `apps/server/src/board/projector.ts` — board event projection
- `apps/server/src/board/walkingSkeleton.test.ts` — board tests
- `apps/web/src/board/BoardPage.tsx` — skeleton board UI
- `apps/web/src/board/SidebarBoardLink.tsx` — board mode entry in sidebar
- `packages/contracts/src/board.ts` — board schema
- `packages/client-runtime/src/state/board.ts` — board atoms
- `packages/client-runtime/src/operations/boardCommands.ts` — board RPC dispatch
- `packages/client-runtime/src/state/board.test.ts` — board state tests
- `apps/server/src/persistence/Migrations/900_BoardCards.ts` — board migration
- `docs/t3o/seams.md` — fork documentation

### ✅ Acceptable core seams (one-time union appends)

These are D9 consequences (new aggregate kind). Upstream will never create `BoardCardId`. Once-only edits, deferred to `t3o-02a` analysis only:

- `packages/contracts/src/orchestration.ts` — append `BoardCardId` to aggregate-id unions
  (Acceptable: never conflicts; upstream owns no code that writes these.)

### 🔴 Must refactor — predicates only

These currently **delegate by enumeration** — a case per command, an entry per projector. Must convert to **predicate-delegation** so the core never grows:

#### Orchestration layer

**`apps/server/src/orchestration/decider.ts`**
- Currently: `case "board.card.create": return yield* decideBoardCommand(...)`
- Should be: `default: if (isBoardCommand(command)) return yield* decideBoardCommand(...)`
- Why: every new board command adds a case. Predicate freezes the seam.

**`apps/server/src/orchestration/projector.ts`**
- Currently: `case "board.card-created": return projectBoardEvent(...)`
- Should be: `default: if (isBoardEvent(event)) return projectBoardEvent(...)`
- Why: same; every event adds a case.

**`apps/server/src/orchestration/Layers/OrchestrationEngine.ts`**
- Currently: inline `case "board.card.create": return { aggregateKind: "card", ... }`
- Should be: `default: if (isBoardCommand(command)) return boardCommandAggregateRef(command)`
- Why: moves the business logic to `board/` and the core becomes a dispatcher.

**`apps/server/src/orchestration/Layers/ProjectionPipeline.ts`**
- Currently: `boardCards: BOARD_CARDS_PROJECTOR_NAME, ...makeBoardProjectors(sql)`
- Should be: `...BOARD_PROJECTOR_REGISTRY(sql)` (spread the whole registry)
- Why: one registry export, one spread. New projectors are added to the registry, not the pipeline.

**`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`**
- Currently: wraps board methods inline:
  ```
  getCommandReadModel: () => withBoardReadModel(sql, getCommandReadModel()),
  getShellSnapshot: () => withBoardShellCards(sql, getShellSnapshot()),
  ```
- Should be: spread from board module:
  ```
  ...boardProjectionSnapshotQueryMethods(sql, { getCommandReadModel, getShellSnapshot })
  ```
- Why: board logic leaves core; core calls a board-owned factory.

#### Persistence layer

**`apps/server/src/persistence/Migrations.ts`**
- Currently: `import Migration0900 from "./Migrations/900_BoardCards.ts"` + named entry
- Should be: spread from board-owned export: `...BOARD_MIGRATIONS()`
- Why: migrations are board-owned; the registry is a data structure, not scattered imports.

**`apps/server/src/persistence/Layers/OrchestrationEventStore.ts`**
- Currently: appends `BoardCardId` to three `Schema.Union([ProjectId, ThreadId, BoardCardId])`
- Keep as-is: these are D9 consequence. Once-only. Upstream will not create `BoardCardId`.

**`apps/server/src/persistence/Services/OrchestrationCommandReceipts.ts`**
- Currently: appends `BoardCardId` to `Schema.Union([ProjectId, ThreadId, BoardCardId])`
- Keep as-is: once-only D9 consequence.

#### WebSocket layer

**`apps/server/src/ws.ts`**
- Currently: `import { boardCardShellStreamEvent } from "./board/projector.ts"` + named case
- Should be: `if (isBoardEvent(event)) return boardCardShellStreamEvent(event)`
- Why: predicates freeze the seam; logic stays in board/.

### 🟡 Web routing (framework-constrained; keep as minimal seams)

**`apps/web/src/routes/board.tsx`**
- This is a new route file. Unavoidable core edit (routes are framework-driven).
- Keep it: one file, ~20 lines, imports from `../board/BoardPage`.
- Cannot move: TanStack Router requires route files in `src/routes/`.

**`apps/web/src/routeTree.gen.ts`**
- Auto-generated by TanStack Router. Do not edit by hand; it regenerates.
- Accept: framework-driven, not a seam you control.

**`apps/web/src/components/sidebar/SidebarChrome.tsx`**
- Currently: `import { SidebarBoardLink } from "../../board/SidebarBoardLink"` + one line to render it
- This is acceptable: the sidebar itself is framework-scoped, and the edit is a one-liner.
  If the edit grows (multiple sidebar items for board), move the whole sidebar integration
  to a board module function and call it from SidebarChrome.

### ✅ Client runtime (properly scoped)

**`packages/client-runtime/src/state/shell.ts`**
- Currently: `export * from "./board.ts"`
- This is re-export, not new logic. Acceptable: board state is part of shell, extension is expected.

**`packages/client-runtime/src/state/shellReducer.ts`**
- Currently: `if (isBoardEvent(event)) return applyBoardShellStreamEvent(event)`
- Already uses predicate! This is the pattern.
- Keep as-is.

**`packages/contracts/src/index.ts`**
- Currently: `export * from "./board.ts"`
- Re-export. Acceptable: board schema is part of contracts, extension is expected.

## Refactoring scope for t3o-02a

This spec converts **five files** from enumeration to predicate-delegation:

1. **`apps/server/src/orchestration/decider.ts`** — switch-default predicate
2. **`apps/server/src/orchestration/projector.ts`** — switch-default predicate
3. **`apps/server/src/orchestration/Layers/OrchestrationEngine.ts`** — switch-default predicate
4. **`apps/server/src/orchestration/Layers/ProjectionPipeline.ts`** — spread registry
5. **`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`** — factory spread
6. **`apps/server/src/persistence/Migrations.ts`** — spread registry
7. **`apps/server/src/ws.ts`** — switch-default predicate

Deferred (cannot refactor these now without breaking):
- `ProjectionSnapshotQuery.ts` — internally complex; has no clean split point yet. Mark as
  TODO in code with a clear refactoring target.
- Aggregate-id unions — kept for now; once-only D9, and refactoring Schema unions is
  tedious. Mark as acceptable-once-only.

## The exhaustiveness guarantee

**Non-negotiable:** every predicate must fall through to upstream's existing exhaustiveness
handler when false. Today, if upstream adds a command and forgets a case, TypeScript errors.
A bare `default:` that swallows board commands must NOT hide upstream errors.

```ts
// WRONG:
default:
  if (isBoardCommand(command)) return decideBoardCommand(...)
  // falls through if false — upstream errors disappear

// RIGHT:
default:
  if (isBoardCommand(command)) return decideBoardCommand(...)
  return upstreamExhaustiveHandler(command)  // absurd / assertNever
```

Verify both directions before calling done:
- Add a scratch command to the upstream union → **build must fail**
- Add a scratch board command with no branch in board/decider.ts → **build must fail**

Then delete both scratches and state you ran the check.

## Success criteria

After this pass:

1. **Zero board logic in core directories.** Everything board-specific is in `board/` or
   `@t3tools/board-*` packages.
2. **Predicates only in core.** A seam is a conditional dispatch, a registry spread, or a
   re-export. No inline board logic.
3. **The diff is sparse.** A reader can see at a glance where the core was touched and why.
4. **t3o-03 adds zero core seams.** Seven new commands, seven new events, zero new cases
   in upstream files. Proof that the refactor worked.

After this commit, the fork's invasiveness is quantified and capped: the diff is frozen at its
current size, and every feature we add after it grows the board module, not the core diff.

## Verification

- Walking-skeleton tests pass unchanged.
- Exhaustiveness holds both ways (see guarantee above).
- Re-run upstream sync runbook and add a row to the merge log. Seams that just changed
  should be re-proved against real churn.
