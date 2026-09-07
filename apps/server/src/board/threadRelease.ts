/**
 * When the board is finished with a thread (t3o-13).
 *
 * The board spawns a thread per step and links it to the card. Once that step
 * is behind the card, the thread is finished work: it must drop out of the
 * thread inbox so the sidebar shows the runs that still want a human, not every
 * review round the board has ever driven. The card keeps its link either way —
 * settling clears the inbox, not the card's tabs.
 *
 * The rule lives here, once, as a pure function of board state, and the
 * supervisor reactor is the only caller. That is deliberate: settling used to be
 * three ad-hoc `thread.settle` dispatches fired at the moments a thread became
 * finished — graduation, the review loop's phase advance, a conflict fix — and
 * every one of them was fire-and-forget. The decider refuses to settle a thread
 * whose session is still `running`, and an agent reports its step complete from
 * INSIDE its turn, so the refusal was the normal case rather than the edge one:
 * in the maintainer's own database not a single review-phase settle had ever
 * landed, and 30-odd finished threads sat unsettled forever because nothing ever
 * asked again.
 *
 * So the release is stated as a PREDICATE over state rather than as an event to
 * catch. The reactor re-derives it — at every step boundary and on a timer — and
 * a settle refused because the agent was mid-turn simply lands at the next pass.
 * It also self-heals: a restart re-derives the whole set from the board, so a
 * release missed while the server was down is picked up at boot rather than lost.
 *
 * ## The rule
 *
 * Every live link on a card is released EXCEPT the card's current work — the
 * step-state row's own thread, while that row still belongs to the stage the
 * card is standing in. Everything that rule protects is deliberate:
 *
 *  - A `running` step's thread, obviously.
 *  - An `awaiting-input` or `stalled` step's thread: the whole point of those
 *    statuses is that a human is being asked for something, and settling one
 *    would hide the request.
 *  - A SUCCEEDED step's thread while the card has not moved on. A
 *    human-in-the-loop stage never auto-advances (`advanceStage` returns early),
 *    so its finished run sits in its column waiting to be dragged, and its
 *    thread is exactly where the human picks the work back up.
 *  - The thread of a step that is still being admitted, matched by the link's
 *    ROLE as well as by thread id: `spawnStepThread` links before
 *    `board.card.admit-step` records the thread on the row, and a sweep landing
 *    in that window must not settle a thread that is about to run.
 *
 * A settle is not a one-way door, which is what lets the rule be this blunt. A
 * settled thread un-settles the moment its session comes alive again (the
 * decider emits `thread.unsettled(reason: "activity")` on a `starting`/`running`
 * session), so a stage RE-ENTRY that adopts the thread it left behind — or a
 * human simply typing into it — brings it straight back into the inbox. Nothing
 * here needs to guess in advance which finished thread might be wanted again.
 * That is also why a BACKWARD move settles: the card is not in that stage any
 * more, and if it comes back the thread comes back with it.
 *
 * And everything it releases is a thread nothing will use again: every earlier
 * review-loop phase (the row has moved to the next `<phase>@<round>` step), every
 * earlier stage's run (the row has moved to the new stage's step, or the card has
 * walked past the row's stage into a column that runs nothing), and every link on
 * an archived card.
 *
 * A thread the board UNLINKED while it was alive — a leftover step abandoned by
 * a stage move, a conflict fix that finished — is not derivable from the card at
 * all, because unlinking a live thread removes the link outright. The reactor
 * names those explicitly through `abandoned`, and that set is in-memory, which
 * is the one hole left here: a restart in the window between the unlink and the
 * settle landing loses the thread, and nothing re-derives it, because the
 * removed link left no trace to re-derive it FROM. Upstream's
 * `ThreadSettlementReactor` is a partial backstop rather than a guarantee — its
 * `shouldAutoSettleThread` only settles on a merged/closed pull request or after
 * `sidebarAutoSettleAfterDays`, so with neither configured the thread stays in
 * the inbox until a human settles it by hand. It is a small hole (the window is
 * one sweep, abandoning a live thread is rare, and the cost is one stale inbox
 * row rather than lost work), and closing it properly means a durable record of
 * "the board is done with this thread" — which is a bigger idea than this file.
 */
import {
  boardCardStepState,
  boardStageById,
  effectiveBoardStageRole,
  parseReviewStepId,
  ThreadId,
  type BoardCard,
  type BoardCardStepState,
  type BoardState,
} from "@t3tools/contracts";

/**
 * Whether a card's step-state row is work of the stage the card is standing in.
 *
 * A row is normally keyed by the stage id itself (D1: one step per stage). The
 * review loop is the exception — its steps are round-scoped `<phase>@<round>`
 * ids — so a review-shaped step id belongs to whichever stage carries the
 * `review` role.
 *
 * The question matters because the row OUTLIVES the stage: a card that graduates
 * into a column with nothing to auto-execute keeps its old row untouched, and
 * without this test that finished run's thread would be protected forever.
 */
export function boardStepBelongsToStage(
  board: BoardState,
  card: Pick<BoardCard, "stage">,
  state: Pick<BoardCardStepState, "stepId">,
): boolean {
  if (state.stepId === card.stage) return true;
  if (parseReviewStepId(state.stepId) === null) return false;
  const stage = boardStageById(board, card.stage);
  return stage !== null && effectiveBoardStageRole(stage) === "review";
}

/**
 * Every thread the board is finished with: the settle candidates, in card then
 * link order.
 *
 * `abandoned` is the reactor's own set of threads it unlinked while they were
 * still alive — see the note at the top of this file. Ids in it are returned
 * verbatim, since there is no card left to derive them from.
 *
 * This says nothing about whether a thread CAN be settled right now (it may be
 * mid-turn, already settled, or pinned active by a human). That is the decider's
 * call, and the caller's job is only to ask again later.
 */
export function boardReleasedThreadIds(
  board: BoardState,
  abandoned: ReadonlySet<string> = new Set(),
): ReadonlyArray<ThreadId> {
  const released: Array<ThreadId> = [];
  const seen = new Set<string>();
  const add = (threadId: ThreadId) => {
    if (seen.has(String(threadId))) return;
    seen.add(String(threadId));
    released.push(threadId);
  };
  for (const card of board.cards) {
    const state = boardCardStepState(board, card.id);
    // An archived card is done with every thread it holds, whatever its last
    // step row still says.
    const current =
      card.archivedAt !== null || state === null || !boardStepBelongsToStage(board, card, state)
        ? null
        : state;
    for (const link of card.threadLinks) {
      if (link.tombstonedAt !== null) continue;
      if (current !== null && (current.threadId === link.threadId || current.stepId === link.role))
        continue;
      add(link.threadId);
    }
  }
  for (const threadId of abandoned) add(ThreadId.make(threadId));
  return released;
}
