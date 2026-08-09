---
id: t3o-03
title: Board domain model — schema, decider, projector, persistence
phase: 1
prerequisites: [t3o-02]
---

# Board domain model

The complete card aggregate, its command/event vocabulary, the transition rules, and the projected
tables. This is the spec every other Phase 1 and Phase 2 spec builds on.

## Locked decisions

- **D8** — the decider is a pure function of the read model and has no SQL client. Anything a
  transition branches on lives in the read model; bodies live in projected tables.
- **D9** — cards are their own aggregate; threads are linked, orphan by default, adoptable only from
  the card side; deleted threads leave tombstones.
- **D14** — T3o generates keys; `externalRef` exists from day one.
- **D15** — archive after 7 days in Done (setting); events stay in the log.
- **D12** — stage set is fixed; sub-board plan cards use the Ready-onward subset. The sub-board
  *behaviour* is post-MVP but the schema must not preclude it.

## Stages

Fixed and closed:

```
backlog → sprint → planning → ready → building → review → merge → done
```

Per-stage primary action labels (from the prototype): Add to sprint · Begin planning · Approve plan ·
Begin build · Submit for review · Approve review · Merge · —

**Advancement is human-gated (D18).** Every forward transition requires an explicit act — a drag, a
stage action button, or an answered thread question. The only board-driven transitions are
Building → Code review on build success, parent advancement when the last child plan is Done, and
Done → archived.

**`Ready → Building` is never automatic.** Approving a plan moves a card to Ready and stops there,
so a planning session can queue a dozen features without starting a single build. The decider must
have no path that emits a `board.card.moved` into `building` other than an explicit user-originated
command; assert this in tests rather than relying on nobody adding one later.

**Dependency gating:** dependencies do not block early stages. A card may reach Ready with unmet
dependencies and is **blocked from Ready onward**. This mirrors the prototype's `isBlocked` rule and
is deliberate — you can plan work whose prerequisites are unfinished.

## Card aggregate

```
BoardCard
  cardId            opaque id
  key               generated, e.g. "T3-195"
  projectId         references T3's own project registry — the board never owns project identity
  type              feature | bug | chore
  stage
  orderKey          fractional ordering key (follow the `pinOrderKey` precedent)
  title
  briefRef          -> board_card_bodies
  dependsOn         cardId[]
  parentCardId      null for top-level; set for sub-board plan cards (schema only in MVP)
  threadLinks       [{ threadId, role, linkedAt, tombstonedAt }]
  externalRef       { system, id, url } | null
  recipeSnapshot    resolved recipe captured on stage entry (D10)
  archivedAt
  createdAt / updatedAt
```

### Keys

Per-project prefix is a **setting**, not derived — `core.agent.advisor → T3` is not computable. The
counter (`nextCardNumber` per project) lives in the read model, which makes allocation exact and
race-free because command processing is totally ordered.

### Thread links

`role` is a string discriminator (`planning`, `build`, `review:r1:triage`, …) so the review pipeline
can extend it without a schema change. Deleting a thread sets `tombstonedAt` rather than removing the
link — a Code Review card whose round-2 triage thread vanished must say so, not silently renumber.

## Commands and events

Client-dispatchable: `board.card.create`, `board.card.move`, `board.card.reorder`,
`board.card.update` (title/brief/type/deps/externalRef), `board.card.link-thread`,
`board.card.unlink-thread`, `board.card.archive`, `board.card.unarchive`.

Internal (reactors and MCP, added by later specs): `board.step.*`, `board.plan.*`.

Every command maps to a past-tense event appended to `OrchestrationEventType`.

### Invariants enforced in the decider

- Stage transitions are to adjacent stages, or to any stage via an explicit override (drag is an
  override — a rigid board still has to let you drag a card backwards).
- A card whose `parentCardId` is set cannot enter `backlog`, `sprint`, or `planning`.
- A card with live children cannot be moved directly; its stage is derived (D12).
- Dependency edits are **cycle-checked**; a cycle is rejected with a message naming the edge.
- `board.card.move` into `ready` or beyond records `blocked` derived from unmet dependencies.
- Linking a thread already linked to another card is rejected — one thread, one card.

## Read model

`OrchestrationReadModel.board`:

- `cards`: the structural subset — id, key, projectId, type, stage, orderKey, dependsOn,
  parentCardId, thread link summaries, blocked, archivedAt.
- `nextCardNumberByProject`.

Bodies (brief, plan text, issue details) are **not** here.

## Persistence

Migrations from `900_`:

- `900_BoardCards` — `board_cards`, indexed by `(project_id, stage, order_key)` and by `key`.
- `901_BoardCardBodies` — `board_card_bodies (card_id, kind, body, updated_at)`, following the
  `checkpoint_diff_blobs` precedent for large payloads.
- `902_BoardCardThreadLinks` — indexed both ways so "which card owns this thread" is a lookup.
- `903_BoardPlans` — `board_plans (plan_id, card_id, ord, title, summary, depends_on, status,
  locked, body, created_at, updated_at)`. Schema lands now; the plan *flow* is post-MVP. This is the
  single queryable place for plans that D8 promised; it is written only by the projector.

All projections are written inside the engine's existing transaction.

## Archival

`board.card.archive` is emitted by a reactor 7 days after entry to `done` (window is a setting).
Archiving drops the card from the read model and the shell snapshot, and triggers worktree reclaim
(`t3o-09`). Unarchive exists and is reachable from a settings route — a one-way door is a bug.

## Out of scope

- RPC surface and client state (`t3o-04`).
- Any UI (`t3o-05`, `t3o-06`).
- Step/recipe execution (`t3o-10`).
- The plan proposal flow and sub-board materialisation (post-MVP) — schema only.

## Verification

Focused tests, in the style of the existing `decider.*.test.ts` / `projector.*.test.ts` files:

- Cycle rejection, including a self-edge and a three-node cycle.
- Blocked derivation exactly at the Ready boundary, not before.
- Key allocation under interleaved creates across two projects.
- Thread deletion produces a tombstone, not a removed link.
- Archive/unarchive round-trips and the card leaves and re-enters the shell snapshot.
- Replay from an empty database reproduces an identical read model.
