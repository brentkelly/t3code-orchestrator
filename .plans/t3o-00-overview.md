---
id: t3o-00
title: T3o — Kanban orchestrator layer for T3 Code
type: overview
---

# T3o — Overview

T3o is a Kanban-shaped **orchestration layer** built on top of a fork of
[T3 Code](https://github.com/pingdotgg/t3code). It adds a second top-level mode to the workspace
shell — **Threads** (stock T3) and **Board** (T3o) — where work is managed as cards moving through a
rigid, opinionated engineering pipeline, and where the app itself spawns, supervises, and restarts
the agent threads that do the work.

## The thesis

T3o is **not a view over T3 threads**. It is a supervisor.

Long-running agent threads are unreliable: they die quietly, they stall waiting on a question they
asked in prose, and they drift when one agent owns too many concerns at once. T3o inverts the
control relationship. The board owns a state machine; each step of that machine is a small,
short-lived, tightly scoped thread; the board assigns each step to a specific provider and model,
detects death, and restarts.

Since `T3O-60` the board is also **distributed**: one central T3o server hosts the board and places
cards on workers, other T3o servers it dials as a paired client (D19–D22). A board with no workers
added is exactly the single-machine board, because the central server is its own implicit `local`
worker.

That buys three things a single long agent thread cannot give you:

1. **Per-step provider and model assignment.** Round 1 fresh-eyes review on one model, round 2 on a
   different vendor entirely. Triage on a cheap model, adjudication on an expensive one. An agent
   orchestrating its own review is structurally incapable of this — it is one process on one model.
2. **Death detection and automatic recovery.** A step is complete only when the agent says so
   through a tool call. Anything else is a failure with a defined recovery path.
3. **Focus.** Small threads with one job each outperform one thread carrying a whole feature. The
   Threads-view ergonomics of 20 threads per card are a UI problem, and a solvable one.

## Non-negotiables inherited from T3

These come from the upstream `AGENTS.md` and they constrain every decision below.

- **Performance.** The read model lives in memory and the shell snapshot is sent to every client on
  every reconnect. Payload discipline is not optional.
- **Remote-ready.** Everything must work identically over LAN, Tailscale, and T3 Connect. Anything
  that only works on localhost is broken.
- **Reverse states.** Every way in needs a way out and a way to see it.
- **Minimal, boring seams.** The fork's survival depends on the diff into upstream files being
  small, mechanical, and greppable.

---

## Locked architectural decisions

Each of these was resolved deliberately; the rationale is recorded because the reasoning matters
more than the conclusion when a future change pressures it.

### D1 — T3o is a package plus surgical hooks, not a separate app

`apps/web` is a private Vite SPA with file-based TanStack routing and a single `index.html`. The
server serves exactly one bundle (`apps/server/src/config.ts`, `../../web/dist`) and desktop loads
that same bundle over `t3code://`. There is no extension point. A sibling app under `apps/` could
only _replace_ web, not layer over it.

**Decision:** board code lives in its own package; `apps/web` receives roughly four hook points (a
route, a tab in the shell, a lazy import, a settings entry). Desktop inherits the board for free.

### D2 — Board state is server-authoritative and event-sourced, on the board's own engine

Rejected alternatives: JSON files in the repo via `projects.writeFile` (no push, no ordering, no
atomicity), and a sidecar service (unreachable over T3 Connect, which only proxies the T3 server).

**Decision:** the board is event-sourced in the T3 server, by its **own engine** —
`board/BoardEngine.ts` (`T3O-56`). It decides board commands, appends their events to its own log
(`boards.board_events`, own sequence), folds them into the `board_*` tables, writes its own command
receipts and watermark, all in one transaction on one database file, and then publishes on its own
stream. Ordering, idempotent retries and crash consistency are the board's, built the way upstream
builds them. Remote access is still upstream's transport, the same socket and auth, with the
board's own RPCs on it (`T3O-57`): clients send board commands through `board.dispatchCommand` and
hold the board through `board.subscribeBoard`, a snapshot and the board log's deltas resumed from the
board's own sequence. The orchestration shell carries nothing board-shaped.

**Why not upstream's engine, which is what this decision originally said.** Riding upstream's
orchestration engine inherited all of the above for free, and `t3o-02` paid for it in 39 markers
across 15 upstream files, because a new aggregate kind widens every `ProjectId | ThreadId` union in
the persistence layer. The bet held for as long as upstream's engine had seams to delegate from.
Upstream v0.1.0 replaced it with `orchestration-v2`, whose command and event unions, projection
switch and receipts are closed — there is no extension point left to ride. A second engine owned by
the board is the only design that survives the port, and it also takes the board's rows out of
upstream's log (t3o-26) and the board's markers out of upstream's busiest files.

Since `T3O-59` the board runs on `orchestration-v2` and touches it only through
`board/ThreadGatewayV2.ts` (commands through `ThreadManagementService`, reads from its projection
store, signals off its stored event log), plus the wiring seams in `docs/t3o/seams.md`.

Rejected: keeping the board on the v1 engine through the port by forking `orchestration-v2`'s
unions. That re-creates the seam count of `t3o-02` inside code upstream is still actively
reshaping.

**The engine runs only on the central server (`T3O-60`).** Workers are T3o servers too, so each one
has a board engine of its own; that board is independent and the central server never reads or
writes it. Every card, step and settings decision for a distributed board is decided, logged and
projected once, on the central server. Combining several boards into one is out of scope: two
engines that each believe they own a card is the failure this decision exists to prevent.

### D3 — Agents write to the board over MCP, not files

T3 ships its own authenticated MCP server at `/mcp` (`apps/server/src/mcp/McpHttpServer.ts`) with a
one-line toolkit registration seam. Critically, `McpInvocationScope` carries `threadId`, so the
server already knows which thread is calling and can resolve the card through the card↔thread link.

**Decision:** a `board` MCP toolkit is the agent write path. Agents never need to be told their own
card id. Because it rides the same authenticated HTTP server, it works remotely for free.

**Authorization** happens in the tool handlers (is this thread linked to a card?), not through
capability gating, because thread adoption is dynamic by design.

**On a worker (`T3O-60`), the path is agent → its own server's `/mcp` → relay → central server.**
Agents keep calling the `/mcp` of the server their thread runs on, with today's tokens and today's
injection, so no provider adapter changes. The worker's board toolkit recognises a thread a central
server placed and forwards the call over the connection the **central server** holds open to it (a
relay stream plus a respond RPC; the worker never dials out). The central server authorizes twice:
the calling thread must be linked to a card, **and** that card must be placed on the worker the
call arrived from, so one worker cannot touch another worker's cards. Relayed calls must be safe to
repeat, because a dropped connection can deliver one twice. When the central server is not
connected the tool returns a retryable "board unreachable" error, never a silent success.

Rejected: handing agents on a worker the central server's `/mcp` URL and a per-card credential. It
needs the central server reachable from every worker (the firewall rule D19 avoids), a second
token-minting path, and provider-specific MCP injection on every adapter.

### D4 — The board orchestrates; agents execute one step at a time

Rejected: one thread running an end-to-end review loop and self-reporting. That forfeits per-step
model choice, forfeits death detection, and concentrates failure.

**Decision:** the board spawns one thread per step. A step is complete **only** when the agent calls
`board_complete_step`. A thread that settles without that call has died or stalled, and enters the
recovery path.

A thread on an **offline worker** is unknown, not dead (D22). Death detection needs evidence, and a
worker the board cannot reach supplies none, so its steps hold their state until the worker comes
back.

### D5 — Prompt envelopes, not skills

Skills are Claude-specific (`~/.claude/skills`). D4 requires provider neutrality — the whole point is
mixing vendors across steps.

**Decision:** the board wraps every step prompt in a provider-neutral envelope: a preamble carrying
card context, and a postamble carrying the completion contract and the "ask questions through your
question tool, never in prose" rule, worded per provider instance. The same mechanism later wraps a
user's own custom skill.

Context is available both ways: **pushed** as a short preamble so a fresh small thread is oriented
from token zero, and **pulled** via `board_get_card_context` so prompts stay small.

Paths in that context (brief attachments, worktree paths) are **worker-local**: they name files on
the machine the card is placed on, because that is where the agent reading them runs.

### D6 — Worktrees are lazy; planning needs none

Worktree creation runs `runOnWorktreeCreate`, which in a repo like this is `vp i` plus a dep-cache
warm — minutes and gigabytes each. Two hundred planned cards must not mean two hundred worktrees.

**Decision:** planning runs **read-only in the checkout of the card's project on the card's
worker** with `worktreePath: null` and `ProviderSandboxMode: "read-only"`, emitting the plan through
MCP. No branch, no worktree, no install. The card's branch and worktree are created lazily, **on the
worker**, on entry to **Building**, and reclaimed there at archive. The central server needs no
checkout of anything: its only view of a repo is through the worker that has one (D21).

### D7 — Shell/detail split, mirroring threads exactly

`OrchestrationShellSnapshot` goes to every client on every connect. Plan bodies and review ledgers
cannot live there.

**Decision:** `BoardCardShell` is a small bounded summary (the fields the column cards render) and
rides the existing shell snapshot. Heavy detail streams through a new `board.subscribeCard`, exactly
as `orchestration.subscribeThread` does for threads.

Distribution adds only small, bounded worker fields to the shell (a card's pin and placement, a few
ids). Worker status is one short summary per worker on `board.subscribeBoard`, never repeated on
every card.

### D8 — Read model holds what the decider branches on; tables hold the rest

`decideOrchestrationCommand({ command, readModel })` has `Crypto` as its only requirement. **The
decider has no SQL client and cannot query a table.** Therefore any state a transition depends on
must be in the in-memory read model.

**Decision:**

| State                                     | In read model?           | Why                                           |
| ----------------------------------------- | ------------------------ | --------------------------------------------- |
| card stage, order key, blocked, links     | yes                      | gates transitions                             |
| plan status, `dependsOn`, `locked`, order | yes                      | gates approval, blocking, parent auto-advance |
| plan body (markdown)                      | no                       | nothing branches on it                        |
| review issue ledger                       | no (summary counts only) | card summary needs counts, not bodies         |

Bodies live in projected tables (`board_plans`), following the existing
`projection_thread_proposed_plans` and `checkpoint_diff_blobs` precedents. Writes always go
MCP tool → command → decider → event → projector → table, in one transaction. The table is a
first-class queryable read surface; it is just never written through the back door.

The **worker registry, the default worker, and each card's pin and placement** are in the read
model, because transitions branch on them: removing the default worker is refused, placement
decides where a step spawns, and a move is gated on it. A worker's **connection state** (online,
offline, unauthorized…) is not: it is supervisor runtime state, re-derived by dialing on every
boot, and event-sourcing it would write a log entry for every network blip. The last providers and
checkouts a worker reported are persisted beside the registry as a snapshot, so an offline worker
can still show what it had.

### D9 — Cards are a new aggregate

A backlog card has zero threads; a Code Review card can have twenty. Cards outlive threads.

**Decision:** `BoardCard` is its own aggregate holding an ordered list of `{ threadId, role }` links.
Threads created outside the board are **orphans by default**, adoptable **only from the card side**
(a picker in the card's thread area) so that `apps/web`'s thread action menu is never touched.
Deleted threads leave **tombstones** on the card rather than vanishing.

Each thread link carries the **worker id** (the worker's environment id) of the server the thread
lives on, so a client knows which environment to open it in.

### D10 — Fixed stages, configurable steps

Stages are the product: `Backlog → Sprint → Planning → Ready → Building → Code review →
Ready for merge → Done`. What varies between users is the _steps within_ a stage and who runs them.

**Decision:** the recipe (per-step prompt, provider instance, model, timeout, max attempts) is typed
data in `ServerSettings.board`, edited from a new Settings → Board tab, with defaults compiled in so
zero configuration works. **The resolved recipe is snapshotted onto the card on stage entry** so that
editing settings mid-flight cannot corrupt a running pipeline.

Recipes keep naming **provider instance ids**, and an id resolves on the **placed worker**. A step
whose instance the worker does not have stalls amber ("Provider not on worker") rather than
silently running elsewhere or on another provider.

### D11 — Concurrency is a board limit, a worker limit, and per-worker provider caps

There is no concurrency limit anywhere in the T3 server today; a human's typing speed is the
throttle. T3o removes that throttle.

**Decision:** three ceilings, all of which must have room before a step starts:

- a **board limit**: agents running across every worker;
- a **worker limit** for each worker: agents running on that machine;
- **provider-instance caps** for each worker, because an instance id on one machine is a different
  account and a different CPU from the same id on another.

Each worker's provider list comes from that worker's own server config, as it reports it; the
central server never invents one. Replaced: the single-machine rule of `maxConcurrent` per
`providerInstanceId` plus a global ceiling, which is the one-worker special case of the above.

The **Building column is the queue** — position is priority, drag to reprioritise, queued cards sit
in Building flagged as queued (never in Ready, which would lie about their state). The card says
which ceiling it is waiting on.

Ordering rule, unchanged: **stage descending → started before unstarted → drag order.** Finishing
beats starting; a nearly-merged card is never starved by new work. Preemption takes effect at the
**next step boundary** — nothing in flight is wasted and the worktree is always left clean.

### D12 — Sub-boards are stacked branches, depth 1

**Decision:** the planning agent _proposes_ a split; the human approves it at the existing
"Approve plan" gate, which materialises the plan cards and the integration branch. Plan cards are
real cards with fewer columns (Ready onward). They branch off `feat/x` and their PRs target it. The
parent's own Code Review is the final `feat/x → main` review, gated until every plan is Done. The
parent's stage is **derived** while children are live and cannot be dragged independently.

The dependency graph is **agent-authored and therefore validated for cycles at the approve gate**.
Single-plan is the default; most cards never split. No nesting beyond depth 1.

On a distributed board the integration branch is **cut on the parent's worker and pushed**, and
children cut their branches **from the remote**, so a child placed on another worker never needs
the parent's checkout (D21).

Sibling plans run in parallel from the same base, so a merge makes siblings stale. That is resolved
by a **`sync-base` step** enqueued at a stage boundary — never by writing into a worktree while an
agent is live in it. If the base moved since the last review round started, one final single-reviewer
round runs on the rebased diff before merge, so the reviewed diff is the merged diff.

### D13 — Human gates are thread questions

**Decision:** every human gate ends with the agent asking a real question in its thread, which puts
the thread into T3's existing pending-user-input state and flows through `AgentAwarenessRelay` →
relay → APNs to the phone. The card renders "Input needed" and deep-links to the thread. Card
buttons remain, but resolve the _same_ gate — a gate reachable only from the board is a gate you
cannot clear from bed.

On a distributed board the thread, and so the question, lives on the card's worker. It is answered
**in the thread through that worker's environment**, which a client reaches by pairing with the
worker through upstream Connections; stock upstream web, desktop and mobile apps can do that with
no board-only fields. Card buttons are proxied: the client asks the central server, and the central
server answers the gate on the worker.

Repeated step failure is also a question: retry, switch provider, or take it manually. Recovery
prompts **escalate** (nudge → nudge with outstanding summary → ask the human) and never loop
unbounded.

### D14 — Standalone cards with an external escape hatch

**Decision:** T3o owns cards and generates keys (per-project prefix from settings + counter in the
read model). Every card carries an optional `externalRef { system, id, url }` so import from, and
later outbound sync to, GitHub Issues / Linear / Jira is a field that already exists rather than a
migration.

### D15 — Archive, don't accumulate

**Decision:** cards **may** auto-archive after N days untouched in Done — an opt-in board setting
(`lifecycle.autoArchiveDone`, default **off**; `autoArchiveAfterDays`, default **7**). The clock is
the card's last touch (`updatedAt`), which entering Done and unarchiving both reset, so no
stage-entry timestamp is stored. A card whose reclaim at Done was refused for unsaved work stays in
Done for a human (T3O-77); with `reclaimWorktreeOnDone` off no reclaim runs at Done, so the card is
archived and the archive's safe reclaim keeps the worktree. Archiving removes cards from the shell
snapshot and the in-memory read model, reclaims any surviving worktree, and leaves the events
in the log. Archived cards remain searchable and restorable through a settings route, mirroring
`thread.archived` / `/settings/archived`.

The reclaim runs **on the card's worker**, where the worktree is.

### D16 — Fork strategy

- Remote `upstream` → `pingdotgg/t3code`.
- `main` is a **pristine fast-forward-only mirror** of `upstream/main`. Never commit to it.
- `t3o` is the trunk and the **repo default branch**, so nothing can accidentally land on
  the mirror.
- Sync **manually and on demand** — fast-forward `main`, then merge `main → t3o`. Not on a calendar,
  and **not automated during MVP**: a scheduled workflow defends a bet that has not been placed yet,
  and the information worth having from early merges (how bad are the conflicts, really) comes from
  doing a few by hand. Automation returns post-MVP. **Merge, not rebase** — the branch is long-lived
  with real PR history.
- Every seam insertion carries a **`T3o:`** marker comment, making the whole fork surface greppable
  after each merge. (Lowercase `o` deliberately — `T3O` reads as `T30`.)
- Workspace packages keep their `@t3tools/*` names. They are `private: true` and resolved via
  `workspace:*` — nothing is fetched from NPM, so renaming would touch every import for zero gain.
  Only the published CLI (`apps/server`, named `t3`) would ever need renaming, and only if T3o
  publishes its own CLI.
- Irrelevant inherited workflows (`deploy-relay`, `mobile-eas-*`, `release`,
  `thread-transfer-report`) are disabled **from the GitHub Actions UI**, not by editing YAML, which
  would conflict on every upstream CI change.
- Board migrations live in **`apps/server/src/board/migrations/`**, numbered from `001` against
  their own ledger table (`t3o_sql_migrations`), never in upstream's `persistence/Migrations/`.
  Sharing upstream's ledger would let one high-water mark skip lower-numbered upstream migrations
  — data loss, not a merge conflict. See `docs/t3o/seams.md`.
- **Workers must meet the board-worker protocol floor.** A worker is a T3o server whose
  `boardWorker.hello` reports a protocol version at or above the central server's floor; the UI
  shows the floor as a T3o version. Upstream-only servers cannot be workers: their RPC has no
  stopSession, no global signal stream, no board git operations and no way to point an agent's MCP
  at the board. Raising the floor is a deliberate, versioned act, never a side effect.

### D17 — Mobile is out of scope, but the seam stays honest

A board UI on `apps/mobile` (React Native, separate navigation) is not in scope. But D13 already
delivers the thing that matters on a phone: answering the board's questions to keep cards moving.

**Decision:** board client state lives in `packages/client-runtime` (where T3 puts shared client
concerns) rather than in the web package, so a future mobile board is a UI project rather than a
rewrite. Costs nothing now.

On a distributed board, upstream mobile drives a worker's threads directly: a card's thread is an
ordinary upstream thread on an ordinary upstream project (D19), so a phone paired with the worker
can open, steer and answer it.

### D18 — Stage advancement is human-gated; work inside a stage is automatic

The board never decides on its own that a card should move forward. Entering a stage may start that
stage's work automatically — that is the point of the supervisor — but crossing a stage boundary is
a human act unless listed below.

**Human-gated transitions** (a click, a drag, or an answered thread question):

| From → To                     | Action                                                 |
| ----------------------------- | ------------------------------------------------------ |
| Backlog → Sprint              | Add to sprint                                          |
| Sprint → Planning             | Begin planning _(starts the planning thread on entry)_ |
| Planning → Ready              | Approve plan                                           |
| **Ready → Building**          | **Begin build — never automatic**                      |
| Code review → Ready for merge | Approve review                                         |
| Ready for merge → Done        | Merge                                                  |

**Board-driven transitions** (the only ones):

- Building → Code review when the build step reports success.
- A parent card advances when its last child plan card reaches Done (D12).
- Done → archived after the configured window, when auto-archive is enabled (D15).
- A card whose worker is removed while it has no worktree falls back to the default worker, with an
  activity entry (D22).

Choosing a card's worker (pin, unpin) and **moving** a card to another worker are human acts, like
every row of the table above. The board never re-places a card on its own except by the removal
fallback just listed.

The Ready gate is the one that matters most in daily use: it exists so a planning session can queue
up a dozen features without a single build starting. Planning is cheap, reversible and read-only
(D6); building costs a worktree, an install, and real tokens. **Nothing crosses that line without
you.**

Note that "Begin build" means _commit this card to the build queue_, not _start now_ — the governor
may hold it as `queued` in Building (D11). Queued is still a state you chose.

### D19 — Topology and credentials: the central server dials workers with its own session

**Topology.** The board lives on one **central** T3o server, and that server **dials each worker**
as a paired client over the worker's ordinary T3 WebSocket. Workers never dial the central server.
That makes the firewall story short: central → worker on the worker's T3 port is required;
client → worker is needed only to open threads; worker → git remote, forge and providers is as any
server today. Transport is a **direct URL** (LAN or Tailscale); T3 Connect relay transport is a
follow-up.

The central server's own machine is the implicit **`local`** worker ("This server (local)"), using
today's `ThreadGatewayV2` and local git code. A board with no workers added is exactly today's
board: no worker chip, no worker picker, no per-worker grouping in Concurrency, no Project
checkouts page.

**Worker id = the worker's `environmentId`**, read from its `/.well-known/t3/environment`. It is
stable across restarts and re-pairs, so a re-added server reattaches its cards.

**Credentials reuse upstream environments, not a second pairing system.** Upstream's Connections
live on each client (web storage, or the desktop catalog), but the board's supervisor runs on the
central server with no client open. So **the central server holds its own session per worker**,
labelled `T3o board (<central name>)`, with standard client scopes, its bearer token in
`ServerSecretStore` under the worker's id.

- **Add.** The Add worker dialog lists the environments the _current client_ is already connected
  to. Picking one makes the client mint a one-time pairing token on that environment
  (`POST /api/auth/pairing-token`, which needs `access:write`), and hand it to the central server's
  `board.workers.add`, which exchanges it for the central server's own session. When the client's
  session lacks `access:write`, or the environment is not connected on this client, the human pastes
  a pairing link from `t3 pair` on the worker instead.
- **Remove** revokes the session on the worker if it is reachable, then deletes the secret and the
  registry record.
- **Revoked from the worker side** (upstream Settings → Connections → Clients on the worker), the
  worker turns `unauthorized` on the central server and the UI says "Access revoked".
- **Re-pair** repeats the add flow for that worker, keeping its label, pinned cards and limits.

Standard client scopes are enough: the worker RPCs join `BOARD_RPC_SCOPES` under existing scopes
(`orchestration:read`, `orchestration:operate`, `source-control:write`), so no new scope exists.
The worker list itself is server-side, so every client sees the same workers.

**Why the server holds its own session, not a client's.** Borrowing the bearer token of whichever
browser added the worker would tie the board's access to that device: revoking the browser would
silently break the board, and the board's scopes would be whatever that device happened to hold. A
session the server owns has one owner, one label on the worker's Clients list, and one way to
revoke it.

Rejected: a board-specific pairing protocol (a second auth system to secure and explain), and
workers dialing the central server (inverts the firewall rule, and the central server would need to
be reachable from every worker network).

### D20 — Placement: a pin, and where the card actually runs

A card has a **pin** (a chosen worker, or null to follow the default worker) and a **placement**
(where it actually runs). One worker is the **default**, initially `local`, changed with Make
default; only online, compatible, paired workers can become it, and the default can't be removed.

- Placement is recorded when the card's first thread spawns. Planning runs read-only in that
  worker's checkout (D6), and every later step runs on the same worker.
- Changing the pin of a card with no worktree simply re-pins it. **Unpin** means "follow the default
  worker"; changing the default only affects cards without a worktree.
- Changing the pin of a card with a worktree opens **Move**, allowed only when no step is running and
  the durability probe says the branch is pushed. The old worktree is retired and a new one is
  provisioned on the new worker from the remote branch.
- Sub-board children copy the parent's pin when created, and can be edited.
- A worker can only be chosen for a project it has a checkout of. A board project is a
  central-server project; on each worker it maps to the checkout whose repository grouping key (the
  origin-preferring key in `board/boardRepository.ts`) matches. A worker without one offers **Set up
  on worker**, which clones the repo's remote on the worker.

Placement is explicit in `T3O-60`. Automatic placement by load is a follow-up that only has to pick
a pin; nothing here assumes a human made the choice beyond D18's rule that the board never
re-places a card by itself today.

### D21 — Git runs on the worker, through named operations; the remote is the source of truth

Every board git and forge operation for a card — worktree creation and retirement, branch cleanup,
base-branch sync, merge-conflict detection — runs **on the card's worker**, as a **named**
`boardWorker` RPC operation. Remote callers never get raw `git`: a named operation has typed
inputs, a bounded effect and a test, where a shell passthrough would be remote code execution with
extra steps.

The central server needs no checkout, and merges stay on the forge. Between workers the **git
remote is the source of truth**: base-staleness checks fetch, then read the remote ref, and moving
a card requires its branch to be pushed. Nothing is ever copied worker to worker.

### D22 — Offline, reconnect and removal

**Offline.** A worker the central server cannot reach is `offline`, and its cards show amber
"Worker offline". Signals, timeouts and recovery pause for its steps, and their concurrency slots
stay held — an offline worker is never a dead thread (D4), because the agent may still be working
on a machine the board merely cannot see.

**Reconnect.** The boot `reconcile`, scoped to that worker, runs before anything else acts on its
cards. Threads match by id, so nothing is spawned twice.

**Removal** is allowed for any worker except the default, behind a confirm dialog listing the
affected cards:

- Cards with no worktree fall back to the default worker, with an activity entry (the one
  board-driven placement change, D18).
- Cards with a worktree or a running step hold with "Worker removed — move this card". A running
  step is stopped on the worker if it is reachable, then stalled, and its slot is released.
- Nothing on the worker is deleted: worktrees, branches and thread history stay there.
- **Force-move** continues from the remote branch, with an explicit choice to abandon unpushed
  work. It is also offered for workers that are offline.
- Re-adding a server with the same environment id reattaches its cards.

---

## What the MVP is

**Phase 1 + Phase 2 together.** A board that only visualises work is not worth the seam risk; the
supervisor is the product.

- **Phase 1 — the board exists and you drive it.** All eight stages, drag ordering, card detail,
  dependencies and blocked gating, key generation, manual thread adoption, settings tab. No
  orchestration.
- **Phase 2 — the board spawns and supervises.** MCP toolkit, prompt envelopes, completion contract,
  death detection and recovery, concurrency governor, worktree lifecycle, and **Building as the
  first automated stage** — one long step with an unambiguous completion contract, which stresses
  the machinery hardest with the least ambiguity.

Deferred to follow-up work: the full Code Review pipeline (rounds, issue ledger, adjudication),
sub-boards, forge human-activity polling, scheduled/recurring cards, outbound external sync,
adaptive resource-based throttling, mobile board UI, **upstream-sync automation**, and a **seam-count
CI gate**.

The last two are deliberately last. Both are maintenance machinery for a fork whose central bet —
that ~20 mechanical seams stay cheap — is unproven until the MVP ships. Build them once the bet has
paid off, not before.

## Build order

| #   | Spec                                   | Phase | Prerequisites |
| --- | -------------------------------------- | ----- | ------------- |
| 01  | `t3o-01-fork-foundation.md`            | 0     | —             |
| 02  | `t3o-02-walking-skeleton.md`           | 0     | 01            |
| 02a | `t3o-02a-seam-generalisation.md`       | 0     | 02            |
| 03  | `t3o-03-board-domain-model.md`         | 1     | 02a           |
| 04  | `t3o-04-board-rpc-and-client-state.md` | 1     | 03            |
| 05  | `t3o-05-board-shell-and-navigation.md` | 1     | 04            |
| 06a | `t3o-06a-card-labels.md`               | 1     | 05            |
| 06  | `t3o-06-card-ui-and-detail.md`         | 1     | 06a           |
| 07  | `t3o-07-settings-board-tab.md`         | 1     | 03            |
| 08  | `t3o-08-mcp-board-toolkit.md`          | 2     | 03, 06a       |
| 09  | `t3o-09-worktree-branch-lifecycle.md`  | 2     | 03            |
| 10  | `t3o-10-supervisor-reactor.md`         | 2     | 08, 09        |
| 11  | `t3o-11-concurrency-governor.md`       | 2     | 10            |
| 12  | `t3o-12-building-stage-automation.md`  | 2     | 06, 07, 11    |

Waves, once prerequisites are honoured:

```
01 → 02 → 02a → 03 ─┬─→ 04 → 05 → 06a → 06 ─┐
                    ├─→ 07 ──────────────────┤
                    ├─→ 08 ─┐                │
                    └─→ 09 ─┴→ 10 → 11 ──────┴→ 12
```

**02 is deliberately first and deliberately thin.** It lands every seam end-to-end with a trivial
board command before any volume is built on top. Pull upstream once or twice against it. If the
seam estimate is wrong, that is discovered in week one with nothing invested. _(Done — the estimate
was low on count and right on shape; see D2.)_

**02a exists because 02 taught us the seams were the wrong shape.** They _enumerated_ — a case per
command in three files, an entry per projector in a fourth — so the core would have changed every
time the board grew. 02a converts them to predicate-delegation and registry-spread, which freezes the
seam count. It runs while there is exactly one board command, because refactoring one enumeration is
trivial and refactoring nine is not. **After 02a, adding a board command, event or projector must
touch zero upstream files** — and `t3o-03` is the test of that claim.

### Distributed board (`T3O-60`)

The distributed board (D19–D22) is built as five child cards of `T3O-60`, branching off and merging
back into `board/t3o-60`:

| Card     | Scope                                                                    | Prerequisites      |
| -------- | ------------------------------------------------------------------------ | ------------------ |
| `T3O-62` | 1/5 — this overview, the worker registry, connections, project checkouts | —                  |
| `T3O-63` | 2/5 — remote thread gateway and MCP relay                                | `T3O-62`           |
| `T3O-64` | 3/5 — board git and forge operations on the card's worker                | `T3O-62`           |
| `T3O-65` | 4/5 — card placement, moving, and per-worker concurrency                 | `T3O-63`, `T3O-64` |
| `T3O-66` | 5/5 — offline workers, reconnect reconciliation, and worker removal      | `T3O-65`           |

The UI for all five is designed in `.plans/prototype/Distributed Board.dc.html`.

## Dogfooding note

`t3o-08` includes `board_create_card` and `board_move_card` specifically so that an agent can
populate a board. Once Phase 1 lands, these specs themselves should become the board's first cards.
