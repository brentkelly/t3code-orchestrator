# Board internals

Constraints in the board's server code that span several files and are easy to break without
knowing. The locked decisions behind them are in `.plans/t3o-00-overview.md`.

## The board database

`boards.sqlite` is attached to upstream's connection as the schema `boards`. One connection keeps a
transaction that writes only `boards.*` atomic under WAL; SQLite gives up cross-file atomicity
only for a transaction that modifies more than one attached file.

Name resolution across the two files decides how board SQL is written:

- An unqualified `CREATE TABLE` lands in `main`, and `CREATE INDEX` cannot cross schemas, so board
  migrations qualify both with `boards.`. A board table left in `main` makes the board's relocation
  refuse to boot.
- Unqualified `ALTER`, `INSERT`, `SELECT` and `PRAGMA table_info` resolve to `boards` only when
  `main` has no table of that name. A table present in both files (`projection_state`) is always
  qualified.

### Migration invariants

- A migration that adds a card or step-state column defaults it to exactly the contract's decode
  default (`BoardCard.*`, `BoardCardStepState.*`), so replaying an older event log from empty gives
  the same rows as rehydrating the table. History is never rewritten: old rows take the default
  and the read side resolves it.
- SQLite has no `ALTER COLUMN`, so relaxing a constraint is create, copy, drop, rename, with the
  column list spelled out (`020` is the model).

## Activity attribution

Board commands carry no provenance, and upstream owns the event envelope, so the transport stamps
the actor (a web RPC is a named human, the MCP board toolkit is an agent with its provider instance
and thread, the reactor is the system) into a bounded FIFO side channel keyed by command id
(`activityActors.ts`). The projector reads it, without evicting, inside the projection transaction.
A `FiberRef` cannot carry it because the projector runs on another fiber. A rebuilt projection
attributes historic rows to the system.

The projector writes structured activity rows (a kind, a small typed payload and the actor) for a
curated subset of events, and never writes English. All wording lives in the web rail
(`BoardCardActivityRail.tsx`), so rows stay queryable and relabelable.

## Thread release

Releasing a card's threads is a predicate over board state, not an event. Settling a thread the
moment it finishes would be refused, because the agent reports completion from inside its own
running turn, so the reactor re-derives the released set at every step boundary, on a 30-second
sweep and at boot (`threadRelease.ts`). Settles are not one-way: the decider un-settles a thread
whose session comes alive, which is why a backward move may settle bluntly.

Known gap: threads unlinked while still alive are tracked only in the reactor's in-memory
`abandoned` set, so a restart between the unlink and the settle loses them. Upstream's settlement
reactor is a partial backstop; closing the gap needs a durable "board is done with this thread"
record.

## Distributed board

### MCP relay

An agent on a worker always calls the `/mcp` of the server its thread runs on. When a central board
placed that thread there, its board tools must act on the central board: the worker hands the call
to the central server over the relay stream the central server holds open (`relay.ts`,
`relayClient.ts`). With no central connected, or no answer in time, the call fails with a retryable
`board-unreachable`, never a silent success.

The central side runs the same handlers under a synthesised invocation scope after checking that
the thread is linked to a card on the very worker the call came from, and that the routed gateway
sees it as a live caller. A card named by a write is bound the same way
(`refuseOtherWorkersCard`). Calls are answered once per worker and call id: a recorded answer is
re-sent, a running call is awaited, and transient refusals are not recorded.

### Measuring a base tip

A board with no workers reads a card's base tip from the local base branch without fetching. Its own
merges reach the local base through `pullMergedBaseBranch`, and every tip it recorded before it had
workers is a local one, so reading the remote would mistake a base that is merely behind for
movement. A board with workers fetches and reads the remote base (bounded by
`BASE_TIP_FETCH_TIMEOUT_MS`, falling back to the last-fetched ref), so a merge landed from another
worker counts.
