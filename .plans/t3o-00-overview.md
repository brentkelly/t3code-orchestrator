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
only *replace* web, not layer over it.

**Decision:** board code lives in its own package; `apps/web` receives roughly four hook points (a
route, a tab in the shell, a lazy import, a settings entry). Desktop inherits the board for free.

### D2 — Board state is server-authoritative and event-sourced

Rejected alternatives: JSON files in the repo via `projects.writeFile` (no push, no ordering, no
atomicity), and a sidecar service (unreachable over T3 Connect, which only proxies the T3 server).

**Decision:** board commands and events join T3's own orchestration engine. Board commands ride the
existing `orchestration.dispatchCommand`; board *shell* data rides the existing
`orchestration.subscribeShell`. This inherits ordering, idempotent retries, crash consistency,
replay, and the entire remote-connection story at no cost.

**Seam size — measured, not estimated.** `t3o-02` landed **39 markers across 15 upstream files**.
The original estimate of ~20 across ~8 was low: introducing a new *aggregate kind* (D9) means every
`ProjectId | ThreadId` union in the persistence layer needs `BoardCardId` too — `OrchestrationEngine`,
`OrchestrationEventStore`, `OrchestrationCommandReceipts` and `ProjectionSnapshotQuery` were all
missed in planning. Every one is still a union append or a wrapped call; the *shape* held even though
the count did not.

**The bet is validated.** First upstream merge: 20 commits, 101 files, ~9.2k insertions → **one
conflict**, in `Migrations.ts`, of the exact predicted form (upstream appends `039` where we append
`900`; keep both, upstream first). All markers survived. ~1 minute to merge, ~4 to verify. The merge
log in `docs/t3o/seams.md` is the running record — keep writing to it.

### D3 — Agents write to the board over MCP, not files

T3 ships its own authenticated MCP server at `/mcp` (`apps/server/src/mcp/McpHttpServer.ts`) with a
one-line toolkit registration seam. Critically, `McpInvocationScope` carries `threadId`, so the
server already knows which thread is calling and can resolve the card through the card↔thread link.

**Decision:** a `board` MCP toolkit is the agent write path. Agents never need to be told their own
card id. Because it rides the same authenticated HTTP server, it works remotely for free.

**Authorization** happens in the tool handlers (is this thread linked to a card?), not through
capability gating, because thread adoption is dynamic by design.

### D4 — The board orchestrates; agents execute one step at a time

Rejected: one thread running an end-to-end review loop and self-reporting. That forfeits per-step
model choice, forfeits death detection, and concentrates failure.

**Decision:** the board spawns one thread per step. A step is complete **only** when the agent calls
`board_complete_step`. A thread that settles without that call has died or stalled, and enters the
recovery path.

### D5 — Prompt envelopes, not skills

Skills are Claude-specific (`~/.claude/skills`). D4 requires provider neutrality — the whole point is
mixing vendors across steps.

**Decision:** the board wraps every step prompt in a provider-neutral envelope: a preamble carrying
card context, and a postamble carrying the completion contract and the "ask questions through your
question tool, never in prose" rule, worded per provider instance. The same mechanism later wraps a
user's own custom skill.

Context is available both ways: **pushed** as a short preamble so a fresh small thread is oriented
from token zero, and **pulled** via `board_get_card_context` so prompts stay small.

### D6 — Worktrees are lazy; planning needs none

Worktree creation runs `runOnWorktreeCreate`, which in a repo like this is `vp i` plus a dep-cache
warm — minutes and gigabytes each. Two hundred planned cards must not mean two hundred worktrees.

**Decision:** planning runs **read-only in the project root** with `worktreePath: null` and
`ProviderSandboxMode: "read-only"`, emitting the plan through MCP. No branch, no worktree, no install.
The card's branch and worktree are created on entry to **Building** and reclaimed at archive.

### D7 — Shell/detail split, mirroring threads exactly

`OrchestrationShellSnapshot` goes to every client on every connect. Plan bodies and review ledgers
cannot live there.

**Decision:** `BoardCardShell` is a small bounded summary (the fields the column cards render) and
rides the existing shell snapshot. Heavy detail streams through a new `board.subscribeCard`, exactly
as `orchestration.subscribeThread` does for threads.

### D8 — Read model holds what the decider branches on; tables hold the rest

`decideOrchestrationCommand({ command, readModel })` has `Crypto` as its only requirement. **The
decider has no SQL client and cannot query a table.** Therefore any state a transition depends on
must be in the in-memory read model.

**Decision:**

| State | In read model? | Why |
| --- | --- | --- |
| card stage, order key, blocked, links | yes | gates transitions |
| plan status, `dependsOn`, `locked`, order | yes | gates approval, blocking, parent auto-advance |
| plan body (markdown) | no | nothing branches on it |
| review issue ledger | no (summary counts only) | card summary needs counts, not bodies |

Bodies live in projected tables (`board_plans`), following the existing
`projection_thread_proposed_plans` and `checkpoint_diff_blobs` precedents. Writes always go
MCP tool → command → decider → event → projector → table, in one transaction. The table is a
first-class queryable read surface; it is just never written through the back door.

### D9 — Cards are a new aggregate

A backlog card has zero threads; a Code Review card can have twenty. Cards outlive threads.

**Decision:** `BoardCard` is its own aggregate holding an ordered list of `{ threadId, role }` links.
Threads created outside the board are **orphans by default**, adoptable **only from the card side**
(a picker in the card's thread area) so that `apps/web`'s thread action menu is never touched.
Deleted threads leave **tombstones** on the card rather than vanishing.

### D10 — Fixed stages, configurable steps

Stages are the product: `Backlog → Sprint → Planning → Ready → Building → Code review →
Ready for merge → Done`. What varies between users is the *steps within* a stage and who runs them.

**Decision:** the recipe (per-step prompt, provider instance, model, timeout, max attempts) is typed
data in `ServerSettings.board`, edited from a new Settings → Board tab, with defaults compiled in so
zero configuration works. **The resolved recipe is snapshotted onto the card on stage entry** so that
editing settings mid-flight cannot corrupt a running pipeline.

### D11 — Concurrency is governed per provider instance

There is no concurrency limit anywhere in the T3 server today; a human's typing speed is the
throttle. T3o removes that throttle.

**Decision:** `maxConcurrent` per `providerInstanceId` plus a global ceiling. The **Building column is
the queue** — position is priority, drag to reprioritise, queued cards sit in Building flagged as
queued (never in Ready, which would lie about their state).

Ordering rule: **stage descending → started before unstarted → drag order.** Finishing beats
starting; a nearly-merged card is never starved by new work. Preemption takes effect at the **next
step boundary** — nothing in flight is wasted and the worktree is always left clean.

### D12 — Sub-boards are stacked branches, depth 1

**Decision:** the planning agent *proposes* a split; the human approves it at the existing
"Approve plan" gate, which materialises the plan cards and the integration branch. Plan cards are
real cards with fewer columns (Ready onward). They branch off `feat/x` and their PRs target it. The
parent's own Code Review is the final `feat/x → main` review, gated until every plan is Done. The
parent's stage is **derived** while children are live and cannot be dragged independently.

The dependency graph is **agent-authored and therefore validated for cycles at the approve gate**.
Single-plan is the default; most cards never split. No nesting beyond depth 1.

Sibling plans run in parallel from the same base, so a merge makes siblings stale. That is resolved
by a **`sync-base` step** enqueued at a stage boundary — never by writing into a worktree while an
agent is live in it. If the base moved since the last review round started, one final single-reviewer
round runs on the rebased diff before merge, so the reviewed diff is the merged diff.

### D13 — Human gates are thread questions

**Decision:** every human gate ends with the agent asking a real question in its thread, which puts
the thread into T3's existing pending-user-input state and flows through `AgentAwarenessRelay` →
relay → APNs to the phone. The card renders "Input needed" and deep-links to the thread. Card
buttons remain, but resolve the *same* gate — a gate reachable only from the board is a gate you
cannot clear from bed.

Repeated step failure is also a question: retry, switch provider, or take it manually. Recovery
prompts **escalate** (nudge → nudge with outstanding summary → ask the human) and never loop
unbounded.

### D14 — Standalone cards with an external escape hatch

**Decision:** T3o owns cards and generates keys (per-project prefix from settings + counter in the
read model). Every card carries an optional `externalRef { system, id, url }` so import from, and
later outbound sync to, GitHub Issues / Linear / Jira is a field that already exists rather than a
migration.

### D15 — Archive, don't accumulate

**Decision:** cards auto-archive after **7 days in Done** (setting). Archiving removes them from the
shell snapshot and the in-memory read model, reclaims any surviving worktree, and leaves the events
in the log. Archived cards remain searchable and restorable through a settings route, mirroring
`thread.archived` / `/settings/archived`.

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
- Reserve migration numbers from **`900_`** upward. Colliding with an upstream migration number
  corrupts the applied-migration ledger — that is data loss, not a merge conflict.

### D17 — Mobile is out of scope, but the seam stays honest

A board UI on `apps/mobile` (React Native, separate navigation) is not in scope. But D13 already
delivers the thing that matters on a phone: answering the board's questions to keep cards moving.

**Decision:** board client state lives in `packages/client-runtime` (where T3 puts shared client
concerns) rather than in the web package, so a future mobile board is a UI project rather than a
rewrite. Costs nothing now.

### D18 — Stage advancement is human-gated; work inside a stage is automatic

The board never decides on its own that a card should move forward. Entering a stage may start that
stage's work automatically — that is the point of the supervisor — but crossing a stage boundary is
a human act unless listed below.

**Human-gated transitions** (a click, a drag, or an answered thread question):

| From → To | Action |
| --- | --- |
| Backlog → Sprint | Add to sprint |
| Sprint → Planning | Begin planning *(starts the planning thread on entry)* |
| Planning → Ready | Approve plan |
| **Ready → Building** | **Begin build — never automatic** |
| Code review → Ready for merge | Approve review |
| Ready for merge → Done | Merge |

**Board-driven transitions** (the only ones):

- Building → Code review when the build step reports success.
- A parent card advances when its last child plan card reaches Done (D12).
- Done → archived after the configured window (D15).

The Ready gate is the one that matters most in daily use: it exists so a planning session can queue
up a dozen features without a single build starting. Planning is cheap, reversible and read-only
(D6); building costs a worktree, an install, and real tokens. **Nothing crosses that line without
you.**

Note that "Begin build" means *commit this card to the build queue*, not *start now* — the governor
may hold it as `queued` in Building (D11). Queued is still a state you chose.

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

| # | Spec | Phase | Prerequisites |
| --- | --- | --- | --- |
| 01 | `t3o-01-fork-foundation.md` | 0 | — |
| 02 | `t3o-02-walking-skeleton.md` | 0 | 01 |
| 02a | `t3o-02a-seam-generalisation.md` | 0 | 02 |
| 03 | `t3o-03-board-domain-model.md` | 1 | 02a |
| 04 | `t3o-04-board-rpc-and-client-state.md` | 1 | 03 |
| 05 | `t3o-05-board-shell-and-navigation.md` | 1 | 04 |
| 06 | `t3o-06-card-ui-and-detail.md` | 1 | 05 |
| 07 | `t3o-07-settings-board-tab.md` | 1 | 03 |
| 08 | `t3o-08-mcp-board-toolkit.md` | 2 | 03 |
| 09 | `t3o-09-worktree-branch-lifecycle.md` | 2 | 03 |
| 10 | `t3o-10-supervisor-reactor.md` | 2 | 08, 09 |
| 11 | `t3o-11-concurrency-governor.md` | 2 | 10 |
| 12 | `t3o-12-building-stage-automation.md` | 2 | 06, 07, 11 |

Waves, once prerequisites are honoured:

```
01 → 02 → 02a → 03 ─┬─→ 04 → 05 → 06 ─┐
                    ├─→ 07 ────────────┤
                    ├─→ 08 ─┐          │
                    └─→ 09 ─┴→ 10 → 11 ┴→ 12
```

**02 is deliberately first and deliberately thin.** It lands every seam end-to-end with a trivial
board command before any volume is built on top. Pull upstream once or twice against it. If the
seam estimate is wrong, that is discovered in week one with nothing invested. *(Done — the estimate
was low on count and right on shape; see D2.)*

**02a exists because 02 taught us the seams were the wrong shape.** They *enumerated* — a case per
command in three files, an entry per projector in a fourth — so the core would have changed every
time the board grew. 02a converts them to predicate-delegation and registry-spread, which freezes the
seam count. It runs while there is exactly one board command, because refactoring one enumeration is
trivial and refactoring nine is not. **After 02a, adding a board command, event or projector must
touch zero upstream files** — and `t3o-03` is the test of that claim.

## Dogfooding note

`t3o-08` includes `board_create_card` and `board_move_card` specifically so that an agent can
populate a board. Once Phase 1 lands, these specs themselves should become the board's first cards.
