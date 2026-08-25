# Auto-settle card threads when a card is finished with them

## Goal

When a card is finished with a thread, automatically dispatch the orchestration
`thread.settle` command on that thread so it drops out of the thread inbox. Two
triggers, both server-side in the board supervisor reactor.

## Key terminology (do not confuse)

- **Thread settle** — orchestration `thread.settle` → `thread.settled`, sets
  `settledOverride: "settled"` / `settledAt`, removes the thread from the inbox.
  Contract at `packages/contracts/src/orchestration.ts:702`; decider at
  `apps/server/src/orchestration/decider.ts:450`. **This is what this feature
  dispatches.**
- **Step settle** — board-internal `board.card.settle-step` (releases the
  concurrency slot). Unrelated bookkeeping; NOT changed here.

## Scope

### In

Two settle triggers in `apps/server/src/board/supervisorReactor.ts`:

- **Rule 1 — stage graduation.** On a **forward** `board.card-moved` (auto-advance
  or manual drag), settle every unsettled, non-running thread linked to the card.
  Hook: `handleCardMoved` (~`:1661`). Classify forward vs. backward with
  `compareBoardStages(fromStage, toStage)` from the payload
  (`BoardCardMovedPayload.fromStage/toStage`, `contracts/src/board.ts:1916`).
  Iterate `event.payload.card.threadLinks` (non-tombstoned), dispatching
  `thread.settle` on each `threadId`. Runs alongside the existing leftover-step
  abandon logic; the just-abandoned leftover is already tombstoned so the sweep
  skips it. Place the sweep before `beginStageRun` so the destination's fresh
  thread (not yet linked) is never settled.

- **Rule 2 — intra-stage step advance (the review loop).** When a step completes
  `succeeded` and the executor plans another step **within the same stage** (the
  review loop), settle the just-finished step's thread. Hook: `continueStage`
  `case "run"` (~`:1174`) — dispatch `thread.settle` on `input.state.threadId`
  (the completing phase's thread) as the next step is selected. Implemented
  generically off the `run` arm — it only manifests for the review loop today,
  keeping the reactor stage-agnostic (its stated design philosophy).

### Out

- No auto-**unsettle**. Backward/reopen moves settle nothing; reactivation stays
  governed by the existing `effectiveSettled` / "active" override.
- No unlinking or hiding of tabs — settling leaves the card↔thread link intact;
  the card keeps its phase tabs (`review@1`, `triage@1`, …), each just marked
  settled.
- No client-side derivation change (server reactor is authoritative). The
  existing `effectiveSettled` auto-settle-on-merged-PR path is untouched.
- No change to step-settle (concurrency) semantics.

## Key decisions

1. **Server-side, in the reactor.** Both triggers are board-reactor events, so the
   settle is dispatched server-side, not derived on the client.
2. **Forward moves only, auto + manual.** Both auto-advance and a human drag emit
   `board.card-moved`; `compareBoardStages` gates the sweep to strictly-forward
   moves. A backward (reopen) move settles nothing.
3. **"Not running" is enforced by the existing `canSettle` guard.** The
   `thread.settle` decider already refuses a thread whose session is
   starting/running or has an open blocking request. Dispatch through the
   reactor's swallow-on-reject helper, so a still-running thread is simply skipped
   and a reject never crashes the move/loop handler. No separate running-check.
4. **Review granularity: progressive.** Each phase thread settles as the loop
   advances past it (Rule 2); the final converging phase thread settles when the
   card leaves the review stage (Rule 1). Failed/blocked phases do not hit the
   `run` arm, so their threads stay active until recovery/human resolves them.
5. **Best-effort, idempotent.** The settle decider idempotently re-emits on an
   already-settled thread, so a Rule-1 sweep that re-touches a thread Rule 2
   already settled is harmless.

## Acceptance criteria

1. A card auto-advancing to the next stage settles every previously-linked,
   non-running, unsettled thread on it (`settledOverride === "settled"`).
2. A manual forward drag does the same.
3. A backward drag settles no threads.
4. In the review loop, when a phase completes and the loop selects the next phase,
   the finished phase's thread is settled; the newly-selected/running phase is not.
5. The final review phase thread is settled when the card graduates out of review.
6. A thread whose session is running is never settled (the `canSettle` reject is
   swallowed); the reactor never crashes on a settle reject.
7. A failed or blocked review phase keeps its thread unsettled until resolved.
8. Settled threads remain linked — the card keeps its tabs.

## Test surfaces

- Reactor tests exercising `handleCardMoved` (forward vs. backward; multi-thread
  card) and `continueStage`'s `run` arm (per-phase settle) — the board reactor's
  existing `apps/server/src/board/*.test.ts` suites.
- Reuse existing `thread.settle` decider/projector coverage
  (`apps/server/src/orchestration/decider.settled.test.ts`,
  `projector.settled.test.ts`) — no new contract behavior, just new dispatch sites.
