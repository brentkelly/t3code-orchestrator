---
id: t3o-04
title: Board RPC surface and shared client state
phase: 1
prerequisites: [t3o-03]
---

# Board RPC and client state

Get board data to clients without regressing reconnect payloads, and put the client-side state where
mobile could reuse it later.

## Locked decisions

- **D7** — shell/detail split, mirroring `subscribeShell` / `subscribeThread` exactly.
- **D17** — board client state lives in `packages/client-runtime`, not in the web package.

## Scope

### `BoardCardShell`

The bounded per-card summary that rides the existing `OrchestrationShellSnapshot`. Scalars only. It
must carry exactly what a column card renders and nothing more:

- identity: `cardId`, `key`, `projectId`, `type`, `stage`, `orderKey`, `title`
- flags: `blocked`, `dependencyCount`, `hasPlan`, `hasPr`, `attachmentCount`, `queued`
- thread-derived: `threadState` (working / waiting / stopped / none), `awaitingInput`
- sub-board: `planTotal`, `planDone` (nulls when not a parent)
- review summary: `prNumber`, `roundCurrent`, `roundMax`, `stepLabel`, `severityCritical`,
  `severityImprovement`, `severityNitpick`, `issuesFixed`, `issuesRejected`, `issuesOpen`,
  `issuesDisputed`

`awaitingInput` derives from the linked thread's existing `hasPendingUserInput` on
`OrchestrationThreadShell` — no new plumbing.

The review fields are nullable and only populated in the review stage. They are counts, never
bodies; this is what makes the stage-specific card summaries cheap.

### `board.subscribeCard`

A new streaming RPC for the one open card: brief body, plan bodies, full issue ledger, activity log,
thread link detail.

Seams — **four spreads, frozen** (`T3o:` marked). This spec originally enumerated five insertions
per RPC method; `t3o-02a` forbids that. Every target is a literal that accepts a spread, so board
RPCs register from board-owned registries and the seam never grows:

- `packages/contracts/src/rpc.ts` — `...BOARD_WS_METHODS,` into `WS_METHODS` (object literal,
  `rpc.ts:168`) and `...BOARD_RPCS,` into `WsRpcGroup` (`RpcGroup.make` is variadic, `rpc.ts:805`).
  Both registries live in `packages/contracts/src/board.ts` beside `BOARD_CLIENT_COMMANDS`.
- `apps/server/src/ws.ts` — `...boardRpcHandlers(deps),` into the `WsRpcGroup.toLayer` handler
  object (`ws.ts:355`). Same injected-factory shape as `boardSnapshotQueryMethods`.
- `apps/server/src/auth/RpcAuthorization.ts` — `...BOARD_RPC_SCOPES,` into `RPC_REQUIRED_SCOPES`
  (object literal, `RpcAuthorization.ts:23`). Use the same scope class as thread reads; do not
  invent a new scope tier.

Adding a second board RPC (the post-MVP review pipeline will want several) must touch zero
upstream files. Prove it the way `t3o-03` proves the command seams: core-only diff, empty.

### Client runtime

New module `packages/client-runtime/src/state/board.ts`:

- Atom factories for the card list, filtered/grouped by project and stage.
- Application of `card-upserted` / `card-removed` shell deltas into cached state.
- A card-detail subscription hook keyed by `cardId`, disposed on close.
- Command dispatch helpers wrapping `orchestration.dispatchCommand`.

Follow the existing subpath-export convention: no barrel, import
`@t3tools/client-runtime/state/board`.

## Payload discipline

This is the spec where the performance non-negotiable is won or lost.

- Add a test asserting `BoardCardShell` stays under a fixed serialized byte budget, and a second
  asserting the shell snapshot grows linearly and modestly with card count. A regression here is
  invisible until someone's phone is slow on cellular.
- Archived cards must be absent from the snapshot (`t3o-03`).

## Out of scope

- Rendering (`t3o-05`, `t3o-06`).
- Any mobile UI.

## Verification

- Two clients; a card edit on one appears on the other via delta, with no full snapshot refetch.
- Opening a card starts exactly one detail subscription; closing it disposes.
- Byte-budget tests pass at 10 and at 1,000 cards.
