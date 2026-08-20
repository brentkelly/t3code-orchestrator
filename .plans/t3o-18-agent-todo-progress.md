---
id: t3o-18
title: Agent todo progress on cards — thread todo lists, and a deterministic activity rail
phase: 2
prerequisites: [t3o-17]
---

# Agent todo progress on cards

Every provider the fork drives already emits a task list — Claude's `TodoWrite`, Codex's
`update_plan`, Cursor's `cursor/update_todos` — and t3code already normalises all of them into one
`turn.plan.updated` event (`providerRuntime.ts:216`). It is the single best answer to "what is this
agent actually doing", it costs nothing to obtain, and the board throws it away.

Meanwhile the board has a card Activity log that no UI renders (`BoardCardDetailView.tsx:687`,
`:738` are literal placeholders) and whose only writer is an agent tool that asks the model to
narrate its own work in prose.

Both problems have the same shape: the board is asking agents to *tell* it things it could simply
*observe*. This spec inverts that. Todo lists become an observed, cached, card-visible fact; the
Activity rail becomes a deterministic projection of the board's own event log; and the two
agent-driven activity tools are deleted.

## What already exists (so that none of it is rebuilt)

| Thing | Where | Status |
| --- | --- | --- |
| Cross-provider todo normalisation | `providerRuntime.ts:216`, `ClaudeAdapter.ts:2147`, `CodexAdapter.ts:1068`, `CursorAdapter.ts:643` | Done, untouched |
| Durable per-revision record | thread activity `kind: "turn.plan.updated"` with the full plan (`ProviderRuntimeIngestion.ts:483`) | Done, untouched |
| Live in-chat plan chip, one per turn | `session-logic.ts:618 deriveTurnPlans` | Done, untouched |
| Sidebar live step indicator | `ThreadPlanProgressService`, `Sidebar.tsx:1197` | Done, untouched |
| A runtime event stream the board already consumes | `supervisorReactor.ts:903` | Extended by one case |
| Card ↔ thread links, many per card | `board_card_thread_links` (migration 003) | Done, untouched |
| Card activity table | `board_card_activity` (migration 008) | Repurposed |

## The three concepts, kept apart

| Concept | Owner | Lifetime | Surface |
| --- | --- | --- | --- |
| **Todos** | a thread | the current list, retained past turn settle | card strip, modal strip |
| **Activity** | a card | append-only milestones | Activity rail |
| **Steps** (`BoardStep`) | a card's recipe | unchanged | unchanged |

Naming discipline is part of the spec. `planTotal` / `planDone` / `PlanPips` remain reserved for
D12 sub-board plan cards; `projection_thread_proposed_plans` remains plan-mode. Four meanings of
"plan" already coexist in this codebase — this feature is called **todos**, everywhere, and never
adds a fifth.

## Scope

**In**

1. A board-owned cache of each linked thread's current todo list.
2. One new t3o array on the shell snapshot carrying card→thread links and their todo summary.
3. The card todo strip, its multi-thread chip, and the modal todos strip.
4. Card badge aggregation across all live threads.
5. A deterministic, actor-attributed Activity rail.
6. Removal of `board_report_progress` and `board_request_input`.
7. Re-pointing t3o-17's stall reset signal and unattended envelope onto todo lists, since item 6
   removes what they depend on (D16).

**Out**

- Mobile. `apps/mobile` has no board at all — no `BoardCardShell` consumer exists outside
  `apps/web` and `apps/server`.
- Any change to `apps/*` t3code tables or contracts owned upstream. Everything new lives in
  `board_*` tables and the board migration ledger.
- The sidebar indicator and the in-chat plan chip. Both stay exactly as they are (D15).
- Sub-board plan progress and the review summary. Their precedence over todos is specified here
  (D8); their data sources remain deferred to D12 / the review pipeline.

## Locked decisions

### D1 — Todos are thread-owned, cached by the board, never a board event

A todo list belongs to a thread, not a card. A card may have several threads and therefore several
lists.

The board stores its own copy in `board_thread_todos` (board migration 014) as a **projection-only
side table** — written directly by the reactor, never a board domain command or event, never
replayed. This is licensed by the board's own D8 rule: nothing branches on a todo. No stage
transition, no step outcome, no gate, no concurrency decision reads one. It is display state.

The alternative — a `board.thread.todos-updated` event per revision — was rejected on volume. A
nine-item list is 10–18 revisions per thread-turn; within a week that traffic would dwarf every
other board event in the log, and every replay would re-walk it, all for state nothing decides on.

This table is a **cache, not a source of truth**. The authoritative record already exists upstream
and durably: every `turn.plan.updated` is persisted as a thread activity carrying the full plan
(`ProviderRuntimeIngestion.ts:483`). That is what makes a non-event-sourced board table safe to own
here, and it is the property that must not be quietly lost.

```
board_thread_todos
  thread_id           TEXT PRIMARY KEY
  card_id             TEXT NOT NULL
  statuses            TEXT NOT NULL      -- one char per item, 'd' | 'i' | 'p'
  current_text        TEXT               -- the in-progress item's text, or NULL
  done_count          INTEGER NOT NULL
  total_count         INTEGER NOT NULL
  current_started_at  TEXT               -- see D6
  updated_at          TEXT NOT NULL
  INDEX (card_id)
```

`done_count` / `total_count` are the *true* counts before capping (D4), so `2/47` stays honest even
when only 30 pips are stored.

Rows are swept when the thread's link is tombstoned, when the thread is deleted, and when the card
is archived — plus a sweep of orphaned rows at boot reconciliation.

### D2 — The reactor captures todos from the stream it already consumes

`supervisorReactor.ts:903` already runs `Stream.runForEach(providerService.streamEvents, …)` and
filters for `turn.completed`. `turn.plan.updated` rides the same `ProviderRuntimeEvent` stream. The
capture is therefore one additional case in an existing subscription, resolving the card from the
emitting thread via `board_card_thread_links`.

An event from a thread with no live card link is ignored, not stored.

**No t3code table, migration, or contract is modified anywhere in this spec.** This is a hard
constraint on the implementation, not a preference.

### D3 — One t3o array on the shell snapshot; the card shell gains nothing

`BoardCardShell` is under a fixed 1280-byte budget asserted at 1,000 cards, and under a structural
test that every field serialises to a scalar apart from the single bounded `labelIds` array
(`board.test.ts:48`, `:143`). Its own comment: *"If a change pushes past this, it added real bytes
to every card on every reconnect, and the right fix is almost never raising the number."*

More decisively, `board.ts:1670` records that card deltas *"are a pure function of the card event
and cannot carry live thread state"* — which is precisely what a todo summary and a thread-priority
rule are. Denormalising onto the card shell would fight the architecture head-on.

So the data rides the shell snapshot as its own array, following the `boardLabels` precedent
(`orchestration.ts:487` — *"rides the shell ONCE … never denormalised per card"*):

```ts
boardCardThreads: Schema.optional(Schema.Array(BoardCardThreadShell))

BoardCardThreadShell = {
  cardId, threadId,
  todoStatuses?, todoCurrent?, todoDone?, todoTotal?,
  todoStartedAt?, todoUpdatedAt?,
}
```

One entry per **live (non-tombstoned) link on a non-archived card**. Todo fields are key-optional
and absent when the thread has no list, so a bare link entry is ~90 bytes and a populated one
~150 — and the common case (threads without lists) costs almost nothing.

`BoardCardShell` gains **no** field. The 1280-byte budget and the scalars-only test are untouched
and unamended; `todoStatuses` is a string, so even the new entry is scalars-only.

Everything else the UI needs — thread label, running/idle state, "idle 2h" — is joined client-side
from the `OrchestrationThreadShell`s the client already holds. Nothing is duplicated onto the wire.

### D4 — Pip fidelity: a capped status string, not derived counts

The card strip renders one pip per item, coloured by that item's status. Deriving pips from
`(done, total, hasDoing)` renders a tidy `[done…][doing][pending…]` fiction that is wrong whenever
an agent completes an item out of order — which they do.

`todoStatuses` is therefore one character per item: `d` done, `i` in progress, `p` pending. Exact
colours, still a scalar, ~30 bytes at the cap.

- `BOARD_THREAD_TODO_ITEMS_MAX = 30` — items beyond this are not stored; the counts stay true.
- `BOARD_THREAD_TODO_CURRENT_MAX_BYTES = 120`, truncated on code-point boundaries, matching the
  existing `BOARD_CARD_SHELL_TITLE_MAX_BYTES` treatment (`board.ts:1757`).

All stored pips render, at `flex:1`. At 24 items each pip is ~7px on a ~230px card — thin, but it
reads as the progress bar it is, and the `2/24` count carries the precision. The existing
`MAX_SUMMARY_PIPS = 6` cap (`BoardCardSummaryRow.tsx:18`) is **not** reused: six pips standing for
twenty-four items is actively misleading rather than merely coarse.

### D5 — Retention is a storage rule; visibility is a render rule

`ThreadPlanProgressService` deletes an all-complete plan and clears on turn settle. That is right
for a live working indicator and wrong here — the prototype shows `Migration spike 3/3 idle 2h` for
a thread that finished. The service is not reused (it is also in-memory, so it could not persist
anyway).

- **Storage:** the board cache retains the last list for a live-linked thread regardless of
  completion or thread state. It changes only when a new `turn.plan.updated` arrives, or when the
  row is swept.
- **Render:** the card *strip* hides itself when the winning list is complete **and** its thread is
  stopped. The expanded thread panel and the modal always show what is stored.

That split is what lets a card show `5/5` at the moment the agent succeeds, and lets a stale card
fall back to its plain meta row, without two different retention policies.

### D6 — Elapsed time is stamped on in-progress-text change

`RuntimePlanStep` is `{ step, status }`. There is no item id and no timestamp anywhere upstream, so
"how long has it been on this item" has to be derived.

`current_started_at` is reset **only when the in-progress item's text changes**. It survives
reordering and insertion, needs nothing new from any provider, and costs one column. It resets
incorrectly only when an agent rewords a todo mid-flight — wrong, harmless, and rare.

Index-based matching was rejected: agents insert and remove items routinely, and index matching
either resets constantly or, worse, carries an elapsed time onto a different task.

### D7 — Card badges aggregate across all live threads; the strip picks its own winner

`deriveBoardCardThreadState` (`board.ts:1722`) takes exactly one thread — `activeBoardCardThreadId`,
defined as the most recently *linked* live link. A card whose *older* thread is awaiting input
therefore shows no "Input needed" badge at all today. That is a shipped bug and this spec fixes it.

- `awaitingInput` becomes an **OR across every live-linked thread**.
- `threadState` aggregates with the same precedence the function already documents, lifted from one
  thread to N: `waiting` if any thread waits, else `working` if any runs, else `stopped`. A card
  with work running in a non-active thread stops looking dead.
- The function keeps its shared server/client shape, so the snapshot and the client's live
  re-derivation stay in agreement.

The **todo strip picks its winner independently**: awaiting input → running → most recently updated
→ `activeThreadId` as final tiebreak. This runs client-side, because only the client holds the live
thread shells the rule reads.

The badge and the strip are allowed to reflect different threads. That is correct: the badge answers
"does this card need me", which is a question about *any* thread; the strip answers "what is being
worked on", which is a question about *one*.

### D8 — One progress block per card, in a pure function

`boardCardSummary` is provably shell-only — `boardCardSummary.test.ts:3` asserts it *"renders its
documented variant from `BoardCardShell` fields ALONE (D7)"*, and that guarantee is what
structurally prevents the column view from ever reaching for `subscribeCard`. Todos need
thread-joined data, so they cannot live inside it and its signature is not widened.

Instead, a new pure sibling:

```ts
boardCardProgressBlock(summary: BoardCardSummary, todo: BoardCardThreadShell | null)
  : { kind: "subcards" | "review" | "todos" | "none"; … }
```

returning **exactly one** block, with precedence **subcards > review > todos**. Sub-board plan
progress and review summaries are absent until their data sources land, so today the function
resolves to `todos` or `none` — but the precedence ships now, tested, rather than being discovered
later.

This also gives the "a second thread must add no height until clicked" rule one place to be
verified.

### D9 — Client UI state is in-memory and session-scoped

Two pieces of client-only state: which cards have their thread panel expanded, and each thread's
todo-strip collapse state in the modal. Both are React state keyed by `cardId` / `threadId`, lost on
reload.

The brief already calls the card panel state client-side only, and a collapse preference has
near-zero value across reloads. Weighed against that: persisted board UI state has already caused a
navigation bug in this codebase, where stale `localStorage` routed Board clicks to a thread. Not
worth re-entering that surface for a chevron.

Auto-expand behaviour: the modal strip defaults to expanded while its thread is awaiting input, and
collapsed otherwise. A manual collapse sticks for that thread until the awaiting-input state clears
and returns.

### D10 — Activity is a projection of the board's own event log

The board already emits `board.card-created`, `board.card-moved`, `board.plans-proposed`,
`board.plan-written` and 19 others — the exact moments the rail wants to show. The rail is therefore
**derived**, not separately written.

The board projector, which already handles these events in the same transaction, writes a row into
`board_card_activity` for the curated subset (D12). Single source of truth, so the rail can never
drift from what actually happened; materialised, so reads stay cheap with stable ids and ordering,
and `board_get_card_context` does not become a log scan.

Activity rows become **structured**: a kind plus a small typed payload (from/to stage, plan id, step
id, outcome) plus an actor. The client renders the sentence and the "drafted the plan" link. The
server never writes English — otherwise the log is unqueryable, unrelabelable, and "who approved
it" ends up buried in prose.

### D11 — The actor is stamped at the dispatch boundary

`board.ts` contains no `actor`, `userId`, or `author` — board commands carry no provenance at all,
and a stage move may originate from a human drag, an agent's MCP tool call, or the supervisor
reactor.

The dispatcher stamps the actor onto the event envelope, because the transport already knows who
called:

| Origin | Actor |
| --- | --- |
| Board RPC from the web client | `{ kind: "human", name }` |
| MCP board toolkit | `{ kind: "agent", providerInstanceId, threadId }` |
| Supervisor reactor / internal commands | `{ kind: "system" }` |

No command schema changes, and no caller can misreport itself. `BOARD_CLIENT_COMMANDS` vs
`BOARD_INTERNAL_COMMANDS` (`board.ts:1223`) already draws half this line.

**Human name:** the card's project git `user.name`, cached, falling back to `"You"`. There is no
user identity anywhere in t3code — it is a single-user local server — and for a dev tool the git
identity is the right one: it is already what lands on every commit the agent makes. The resolved
name is stored on the row so it stays correct after the git config changes.

**Agent name and colour:** resolved from the thread's `ProviderInstanceId`, which is exactly where
"Claude Opus 4.8" and its accent already come from (`server.ts:160`).

### D12 — Nine curated activity kinds

`card-created`, `card-moved`, `plans-proposed`, `plan-written`, `card-step-completed`,
`card-input-requested`, `card-archived`, `card-unarchived`, `card-worktree-failed`.

Everything else stays out: `card-reordered`, `card-updated`, `card-thread-linked/unlinked`,
`card-recipe-snapshotted`, the four non-terminal step events
(`admitted` / `selected` / `awaiting-input` / `recovered` / `settled`), and the three non-failure
worktree events.

This matches "major stages being completed, or the card moving from one stage to the next" and keeps
the rail scannable. The full lifecycle would put ~20 rows on a card that ran three steps — which is
the same unreadability that motivated removing agent-written notes. Each excluded kind is a one-line
addition later if it earns its place.

`card-input-requested` is now sourced from the runtime event, not the deleted tool (D13).

### D13 — The agent-written activity tools are deleted

Removed: `board_report_progress`, `board_request_input`, `BoardCardReportProgressCommand`,
`BoardCardRequestInputCommand`, `board.card-progress-reported`, `board.card-input-requested` as an
*agent-originated* command, and the `progress` / `input-requested` activity kinds.

- **Progress notes.** The agent's narration is already durable in its transcript, and its intent is
  now on the card as the todo strip. Nothing renders progress notes today, so nothing regresses
  visually. The tool description told models to *"call it often"*, which was buying tokens for a
  log with no reader.
- **Input requests.** The tool's own description admits its gap: *"you should still ask the same
  question through your normal question mechanism so your thread waits for the reply."* An agent
  that asks normally and skips the tool leaves the board blind — today's actual failure mode.

`handleInputRequested` (`supervisorReactor.ts:765`) moves the step to `awaiting-input`, which is
what stops a card waiting on a human from being counted as stalled. It is **re-sourced, not
removed**: the reactor switches from the `board.card-input-requested` domain event to the runtime
`user-input.requested` event (`providerRuntime.ts:226`) on the stream it already consumes,
resolving the card from the thread. This is strictly more complete than what it replaces, because
it fires for every input request rather than only the ones an agent remembered to double-report.

`board_get_card_context` gains per-thread todo summaries, which is what a restarted agent — or a
second thread on the same card — actually wanted from the progress notes.

### D14 — No backfill; the cache populates forward only

On upgrade the cache is empty and fills as threads take their next turn. No migration-time scan.

Accepted consequence, stated plainly: on a board with in-flight cards the strip is blank until each
thread next emits a todo update, and the rebuild-from-thread-activities path that makes this cache
safe to own (D1) ships unexercised. If that becomes uncomfortable, seeding from the latest
`turn.plan.updated` activity per live-linked thread is a read-only query against t3code tables and
roughly twenty lines.

### D15 — The transcript keeps its per-turn chip

No `Todo list updated` divider per revision. `deriveTurnPlans` (`session-logic.ts:618`) already
renders one chip per turn showing the latest snapshot, anchored where planning began, with the
explicit note *"plans rewrite constantly; the row must not churn"*. Fifteen dividers per turn is the
shape t3code deliberately rejected. Confirmed with the designer.

### D16 — t3o-18 owns the stall-signal migration; t3o-17 is not amended

t3o-17 is already underway. It ships **as written**: `board_report_progress` is one of its two
signals that reset `stallCount`, and its unattended postamble asks for periodic calls to it. That is
correct against the world t3o-17 lands into, and nothing in this spec edits that file.

D13 removes the tool, so the migration is **t3o-18's work**, carried in the same commit series as
the removal. This is why `prerequisites: [t3o-17]` — not because the todo strip or the Activity rail
need anything from stall detection, but because deleting a tool before the spec that depends on it
has landed would have t3o-17 re-introduce a reference to something that no longer exists.

Everything below replaces the corresponding parts of t3o-17 D2 at the point t3o-18 builds.

#### The reset signal

`stallCount` resets to zero when, since the last nudge, the step's thread has either

- **advanced its todo list** — a `turn.plan.updated` whose `done_count` increased or whose
  in-progress item changed — or
- produced a new commit on the card's branch.

This is a better signal than a progress note on t3o-17's own terms. It wanted "the agent asserting
it did some work" and rejected token output and tool-call counts as noise: a ticked todo names the
specific item finished, where a prose note asserts only that the model still had tokens to spend.

#### The envelope asks for a list, and the nudge asks again

t3o-17 D2 argues that the envelope instruction is *"load-bearing, not a nicety"* — without an
observable progress signal, D1 degrades to today's behaviour with a higher ceiling, which is
*"strictly worse"*. That argument survives the substitution intact, so the requirement is **kept and
re-pointed rather than deleted**. A short step, or a provider in a mode that produces no plan, emits
no `turn.plan.updated` at all; assuming agents always keep a list would reopen exactly the hole
t3o-17 identified.

**Unattended postamble** (t3o-15 D5's unattended branch): the `board_report_progress` line is
replaced by one instructing the agent to keep a todo list current as it works. Replaced, not joined
— leaving a dangling instruction that names a deleted tool is a defect, not a leftover.

The compliance cost is lower than what it replaces. `board_report_progress` was an extra MCP call
that did nothing for the agent, so it was pure overhead the model had every incentive to drop. A
todo list is the model's own working memory — every supported provider ships the tool and uses it
unprompted on non-trivial work. The instruction nudges a behaviour the agent already wants, which is
why it can be relied on where an unrewarded reporting call could not.

**The nudge asks again, conditionally.** `recoveryDecision` gains `hasTodoList: boolean`, resolved
by the reactor from `board_thread_todos` and passed in — the same pattern t3o-17 D2 establishes for
`progressedSinceLastNudge`, so the function stays pure with no git and no SQL. When a nudged thread
has no list, the nudge explicitly asks it to write one and work through it. This is the conditional
the initial envelope cannot express: at step start no turn has run, so *no* thread has a list yet,
and only recovery time knows the difference.

An agent that produces a list and then freezes it still stalls correctly — absence of a list and a
frozen list are both "no progress", which is the right reading of each.

**Human-in-the-loop envelopes are unchanged**, preserving t3o-17 AC 6's asymmetry. Those steps are
not stall-supervised and the human is already in the conversation; nagging a conversational turn
into producing a todo list for a one-line answer is noise. If such an agent writes a list anyway it
renders on the card like any other — the honest outcome, and the common one on real work.

## Acceptance criteria

1. A `turn.plan.updated` from a thread with a live card link writes `board_thread_todos`; one from
   an unlinked thread writes nothing.
2. No t3code table, migration, or contract is modified by this spec.
3. `BoardCardShell` gains no field, and both `board.test.ts` payload-discipline tests pass
   unamended.
4. A 47-item list stores 30 status characters and still reports `n/47`.
5. A list whose items complete out of order renders pips in their true positions.
6. A thread that finishes 5/5 keeps its row; the card strip hides once that thread is also stopped;
   the expanded panel still shows `5/5`.
7. Reordering or inserting a todo does not reset the current item's elapsed time; rewording the
   in-progress item does.
8. A card whose *older* linked thread awaits input shows "Input needed".
9. A card whose non-active linked thread is running shows the running dot.
10. The badge and the todo strip may reflect different threads without either being wrong.
11. `boardCardProgressBlock` returns exactly one block, with subcards outranking review outranking
    todos, and is unit-tested against all four outcomes.
12. `boardCardSummary` still compiles against `BoardCardShell` alone and its purity test is
    unchanged.
13. A second thread appearing on a card adds no card height until the chip is clicked; the chip does
    not open the card.
14. Reloading the page collapses every expanded thread panel and every modal strip preference.
15. Moving a card by drag records `brent moved to Building`; the same move made by the reactor
    records a system actor; the same move via an MCP tool records the agent's provider display name.
16. The Activity rail renders nine kinds and no step-lifecycle or worktree-progress noise.
17. `board_report_progress` and `board_request_input` no longer appear in `tools/list`.
18. An agent that asks an ordinary question — calling no board tool — still moves its step to
    `awaiting-input` and is not counted as stalled.
19. Tombstoning a card's thread link, deleting the thread, or archiving the card removes its
    `board_thread_todos` row.
20. Boot reconciliation sweeps rows whose thread or link no longer exists.
21. The sidebar indicator, the in-chat plan chip, and `ThreadPlanProgressService` behave exactly as
    before this spec.
22. A step nudged twice that advanced its todo list between the nudges has `stallCount` 1, not 2,
    and does not escalate.
23. A step nudged five consecutive times with neither a todo advance nor a commit still escalates on
    the fifth — t3o-17 D1's ceiling is re-pointed, not weakened.
24. The unattended postamble instructs the agent to keep a todo list current and contains no
    reference to `board_report_progress`; no envelope, nudge or escalation text names a deleted tool.
25. The human-in-the-loop postamble does not ask for a todo list.
26. A nudged thread with no todo list is asked to write one; a nudged thread that already has one is
    not.
27. `recoveryDecision` stays pure — unit-tested with `progressedSinceLastNudge` and `hasTodoList`
    booleans, no git and no database.

## Files

| File | Change |
| --- | --- |
| `apps/server/src/board/migrations/014_BoardThreadTodos.ts` | new cache table + `card_id` index |
| `apps/server/src/board/migrations/015_BoardCardActivityStructured.ts` | structured kind, typed payload, actor columns on `board_card_activity`; drop the `progress` / `input-requested` rows |
| `apps/server/src/board/supervisorReactor.ts` | capture `turn.plan.updated`; re-source input-requested from `user-input.requested`; sweep on link/thread/card removal |
| `apps/server/src/board/projector.ts` | write curated activity rows from the events it already projects |
| `apps/server/src/board/projection.ts` | read `board_thread_todos` for the shell; boot sweep of orphans |
| `apps/server/src/board/rpc.ts` | stamp the human actor at the dispatch boundary |
| `apps/server/src/mcp/toolkits/board/tools.ts` / `handlers.ts` | delete the two tools; add todo summaries to `board_get_card_context`; stamp the agent actor |
| `packages/contracts/src/board.ts` | `BoardCardThreadShell`; structured activity kinds + actor; aggregate `deriveBoardCardThreadState`; delete the two commands and their payloads; item/text caps |
| `packages/contracts/src/orchestration.ts` | `boardCardThreads` on `OrchestrationShellSnapshot` + its shell stream delta |
| `apps/web/src/board/boardCardProgressBlock.ts` | new pure precedence function |
| `apps/web/src/board/BoardCardItem.tsx` / `BoardCardSummaryRow.tsx` | todo strip, pip row, thread chip and expanded rows |
| `apps/web/src/board/BoardCardDetailView.tsx` | Activity rail in place of the two placeholders |
| `apps/web/src/board/BoardCardThreadPane.tsx` | per-tab counts and the sticky todos strip |
| `apps/server/src/board/supervisor.ts` | re-point the stall reset signal to todo advance; swap the unattended postamble line; `recoveryDecision` gains `hasTodoList` (D16) |
