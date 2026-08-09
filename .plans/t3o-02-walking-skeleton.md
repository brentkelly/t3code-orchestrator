---
id: t3o-02
title: Walking skeleton — every seam, end to end, with one trivial command
phase: 0
prerequisites: [t3o-01]
---

# Walking skeleton

Land **every** insertion point into upstream-owned files in one commit, carrying the smallest
possible board: one command, one event, one card field, rendered on screen. Then pull upstream once
or twice against it.

This exists to falsify the seam estimate cheaply. If tracking upstream is harder than ~20 mechanical
appends suggest, that must surface in week one, not month three.

## Locked decisions

Per `t3o-00` D2 and D8: board commands ride `orchestration.dispatchCommand`; board shell data rides
`orchestration.subscribeShell`; all schema lives in new T3o-owned files; every upstream edit is a
one-line append carrying a `T3o:` marker.

## Scope

### New files (T3o-owned, zero conflict surface)

- `packages/contracts/src/board.ts` — all board schema. Lives inside `contracts` deliberately: a
  separate package importing contracts while contracts imports it would be a cycle.
- `apps/server/src/board/decider.ts` — `decideBoardCommand`.
- `apps/server/src/board/projector.ts` — `projectBoardEvent`.
- `apps/server/src/persistence/Migrations/900_BoardCards.ts`.

### Seam inventory to land

Each of these is one line (or one small delegating block) with a `T3o:` marker.

**`packages/contracts/src/orchestration.ts`**

1. `ClientOrchestrationCommand` union — append board commands.
2. `DispatchableClientOrchestrationCommand` union — append.
3. `OrchestrationCommand` union — append.
4. `OrchestrationEventType` literals — append.
5. Event payload union — append.
6. `OrchestrationReadModel` struct — add `board` field.
7. `OrchestrationShellSnapshot` — add `cards` field.
8. `OrchestrationShellStreamEvent` union — add `card-upserted` / `card-removed`.

**`apps/server/src/orchestration/decider.ts`**

9. Delegate block at the head of the switch → `decideBoardCommand`.

**`apps/server/src/orchestration/projector.ts`**

10. Delegate block → `projectBoardEvent`.
11. `createEmptyReadModel` — one field.

**`apps/server/src/ws.ts`**

12. `toShellStreamEvent` — a branch mapping board events to card shell deltas.

**`apps/server/src/orchestration/Layers/ProjectionPipeline.ts`**

13. Persisted-projection delegate.

**`apps/server/src/persistence/Migrations.ts`**

14. Import line.
15. Registry array entry.

**`packages/client-runtime/src/state/…`**

16–17. Apply `card-upserted` / `card-removed` to cached shell state.

**`apps/web`**

18–20. Route registration, mode tab, lazy import of the board package.

### The trivial vertical slice

- One command: `board.card.create` with `{ cardId, projectId, title }`.
- One event: `board.card-created`.
- One read-model entry and one projected row.
- One shell delta reaching a connected client.
- A bare list of card titles rendered under a `/board` route.

No stages, no drag, no detail pane, no MCP. Those are `t3o-03` onward.

## Out of scope

Everything except proving the seams conduct signal from a dispatched command to a rendered pixel.

## Verification

- A dispatched `board.card.create` appears in a second connected client without a reload.
- Server restart replays the event and the card survives.
- `rg "T3o:"` matches the inventory above, and the count is recorded in `docs/t3o/seams.md`.
- **Merge `upstream/main` at least once** before declaring this done, and record the actual conflict
  count and resolution time in the seam doc. That number is the input to every future scope
  decision about how much more we are willing to touch.
