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

Seams (each one line, `T3o:` marked):

- `packages/contracts/src/rpc.ts` — method name in `WS_METHODS`, an `Rpc.make`, a group member.
- `apps/server/src/ws.ts` — handler.
- `apps/server/src/auth/RpcAuthorization.ts` — scope entry. Use the same scope class as thread
  reads; do not invent a new scope tier.

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
