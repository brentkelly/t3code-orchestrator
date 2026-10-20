/**
 * T3o board reducer (T3O-57): folds `board.subscribeBoard` items into the
 * board's bounded snapshot.
 *
 * Cards arrive with thread-derived fields at their "none" resting state (the
 * server maps each board event purely from its payload); the board views
 * overlay them from the thread shells (`withBoardThreadFields`, board.ts).
 */
import {
  compareBoardStages,
  type BoardCardShell,
  type BoardShellSnapshot,
  type BoardShellStreamEvent,
  type BoardShellStreamItem,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";

/** The review slice (t3o-22, D7) — carried as a group, never field by field.
    The counts and the outcome describe ONE loop, so a half-carried slice would
    blend one round's tallies with another's verdict. */
const REVIEW_SHELL_FIELDS = [
  "roundCurrent",
  "roundMax",
  "reviewOutcome",
  "reviewHeldOutcome",
  "reviewRoundComplete",
  "severityCritical",
  "severityImprovement",
  "severityNitpick",
  "issuesFixed",
  "issuesRejected",
  "issuesOpen",
  "issuesDisputed",
] as const satisfies ReadonlyArray<keyof BoardCardShell>;

/** The stall slice (T3O-22, D10/D14) — carried as a group for the same reason
    the review slice is: the reason, the retry time and the provider holding the
    card describe ONE stop, and half of them left behind would put a stale
    "resuming 2:50am" under a card that is running again. */
const STALL_SHELL_FIELDS = [
  "stalledReason",
  "retryAt",
  "limitedByInstanceId",
] as const satisfies ReadonlyArray<keyof BoardCardShell>;

/**
 * Carry forward the key-optional shell fields a card-carrying delta cannot
 * know: `briefHasImage` (the brief BODY lives in `board_card_bodies`, D8),
 * `planCount` (the plan set is its own slice), the review slice (a fold
 * over the step-completion ledger, which no card-carrying event can see) and
 * the stall slice (step state, which the card aggregate does not carry).
 * Their resting value is the ABSENT key, not `false`/`0`, so "the producer
 * could not see it" and "the producer saw nothing there" stay
 * distinguishable — a brief whose image was deleted sends
 * `briefHasImage: false` and clears the icon, while a drag
 * (`card-reordered` → `card-upserted`) omits the key and changes nothing.
 *
 * Without the review keys here, a card mid-review that the user drags,
 * retitles, or extends the round budget on loses its pips and its
 * `NO CONVERGENCE` flag until the next reconnect — and the "Run round N+1"
 * click is itself one of the triggers, so the feature would blank itself at
 * the exact moment it is used.
 *
 * The stall keys are here for the same reason and cost more when missing: a
 * card parked on a usage limit sits for HOURS, so a drag, a rename or a
 * PR-link refresh in that window is likely. The preserved `stalled` flag
 * would survive it while the three keys did not, and the card face's words
 * would fall back from "waiting to resume 2:50am" to the gave-up phrasing
 * while the detail modal recomputed `boardStallIsWaiting` to false and
 * painted its red "stopped" banner over a card calmly counting down.
 *
 * Returns the same reference when there is nothing to carry, so memoized
 * consumers keep their identity.
 */
function preserveAbsentShellFields(
  next: BoardCardShell,
  existing: BoardCardShell | undefined,
): BoardCardShell {
  if (existing === undefined) return next;
  const briefHasImage = next.briefHasImage ?? existing.briefHasImage;
  const planCount = next.planCount ?? existing.planCount;
  // The review slice rides or rests as a whole: `reviewOutcome` present means
  // the producer saw the ledger, so every key it holds is authoritative.
  const carryReview = next.reviewOutcome === undefined && existing.reviewOutcome !== undefined;
  // The stall slice rides or rests as a whole too, and only under a card that
  // is still stalled: `next.stalled` is the flag the caller already preserved,
  // and `card-stalled` is what deletes the three keys when the stop ends. So
  // "still stalled, but this delta asserts no reason" is the one shape that
  // means "the producer could not see step state" — carry.
  const carryStall =
    next.stalled && next.stalledReason === undefined && existing.stalledReason !== undefined;
  if (
    briefHasImage === next.briefHasImage &&
    planCount === next.planCount &&
    !carryReview &&
    !carryStall
  ) {
    return next;
  }
  const carried: Partial<BoardCardShell> = {};
  if (carryReview) {
    for (const field of REVIEW_SHELL_FIELDS) {
      const value = existing[field];
      if (value !== undefined) Object.assign(carried, { [field]: value });
    }
  }
  if (carryStall) {
    for (const field of STALL_SHELL_FIELDS) {
      const value = existing[field];
      if (value !== undefined) Object.assign(carried, { [field]: value });
    }
  }
  return {
    ...next,
    ...(briefHasImage === undefined ? {} : { briefHasImage }),
    ...(planCount === undefined ? {} : { planCount }),
    ...carried,
  };
}

/**
 * Fold one board item from `board.subscribeBoard` into the board snapshot
 * (T3O-57). A snapshot replaces whatever was held; a delta needs one.
 *
 * Deltas at or below `snapshotSequence` are dropped and every applied delta
 * advances it, exactly like the orchestration shell's guard — that cursor is
 * what a reconnect resumes from. `card-threads` is the exception: it is a fresh
 * read of the card's link set rather than an event, stamped with whatever the
 * board head was, so it is always applied and never moves the cursor.
 */
export function applyBoardShellStreamItem(
  snapshot: BoardShellSnapshot | null,
  item: BoardShellStreamItem,
): BoardShellSnapshot | null {
  if (item.kind === "snapshot") return item.snapshot;
  if (snapshot === null) return null;
  if (item.kind === "card-threads") return applyBoardShellStreamEvent(snapshot, item);
  if (item.sequence <= snapshot.snapshotSequence) return snapshot;
  return { ...applyBoardShellStreamEvent(snapshot, item), snapshotSequence: item.sequence };
}

/**
 * Fold one board delta into the board snapshot, ignoring its sequence (see
 * `applyBoardShellStreamItem` for the guard). Every board delta is an
 * idempotent upsert or removal, so a delta replayed over a snapshot that
 * already holds it changes nothing.
 */
export function applyBoardShellStreamEvent(
  snapshot: BoardShellSnapshot,
  event: BoardShellStreamEvent,
): BoardShellSnapshot {
  const cards = snapshot.cards;
  switch (event.kind) {
    case "card-upserted": {
      // `queued` is derived from step state the card aggregate does not carry
      // (t3o-11, D11), so a card-carrying delta rests it at false. Preserve the
      // last known value from the card we already hold — exactly as
      // `withDerivedThreadFields` re-derives `threadState` — so reprioritising
      // the queue (a drag = `card-reordered` → `card-upserted`) never blanks a
      // card's queued badge. The authoritative changes arrive via `card-queued`
      // and the snapshot.
      const existing = cards.find((entry) => entry.cardId === event.card.cardId);
      const withQueued =
        existing === undefined || existing.queued === event.card.queued
          ? event.card
          : { ...event.card, queued: existing.queued };
      // `stalled` (t3o-17, D3) is derived from step state the same way, so a
      // card-carrying delta rests it at false too — preserve the last known
      // value so a drag never blanks a stalled badge.
      const withStalled =
        existing === undefined || existing.stalled === withQueued.stalled
          ? withQueued
          : { ...withQueued, stalled: existing.stalled };
      // `stepRunning` (the durable "being worked" dot) is derived from the
      // step-state slice the card aggregate does not carry, so a card-carrying
      // delta rests it at false — preserve the last known value the same way as
      // `queued`/`stalled`, so a drag never blanks a working card's dot. The
      // authoritative flips arrive via `card-queued`/`card-stalled` and the
      // snapshot.
      const withStepRunning =
        existing === undefined || existing.stepRunning === withStalled.stepRunning
          ? withStalled
          : { ...withStalled, stepRunning: existing.stepRunning };
      // `held` is derived from the same step-state slice, so a card-carrying
      // delta rests it at false too — preserve the last known value, or a plain
      // title edit on a parked card would clear the one flag saying it needs a
      // human. The authoritative flips arrive on `card-stalled` (settle raises
      // it, select/recover clear it) and the snapshot.
      const withHeld =
        existing === undefined || existing.held === withStepRunning.held
          ? withStepRunning
          : { ...withStepRunning, held: existing.held };
      // `stepAwaiting` (t3o-34, D4) comes off the same slice and rests at null
      // on a card-carrying delta, so preserve it too — otherwise renaming a card
      // that is waiting on an answer clears the badge that says so.
      const withStepAwaiting =
        existing === undefined || existing.stepAwaiting === withHeld.stepAwaiting
          ? withHeld
          : { ...withHeld, stepAwaiting: existing.stepAwaiting };
      // `briefHasImage` and `planCount` are derived from slices the card
      // aggregate does not carry (the brief BODY, the plan set), so a
      // card-carrying delta that cannot see them OMITS the key rather than
      // asserting a false/zero — absent means "unchanged, keep what you have".
      // A present key is authoritative, including `false`/`0`: clearing an
      // image out of a brief has to clear the icon.
      // `stepConflictFix` (T3O-9) comes off the same slice and rests at false on
      // a card-carrying delta, so preserve it too — otherwise a label edit on a
      // card whose merge is held by conflicts clears the pill that says so.
      const withConflictFixOnly =
        existing === undefined || existing.stepConflictFix === withStepAwaiting.stepConflictFix
          ? withStepAwaiting
          : { ...withStepAwaiting, stepConflictFix: existing.stepConflictFix };
      // `stepChecksFix` (T3O-12) likewise: a card-carrying delta omits it, so
      // the last known value stands until the next `card-stalled`.
      const withConflictFix =
        existing?.stepChecksFix === true && withConflictFixOnly.stepChecksFix === undefined
          ? { ...withConflictFixOnly, stepChecksFix: true }
          : withConflictFixOnly;
      // Thread-derived fields stay at rest here: the board views overlay them
      // from the thread shells (`withDerivedThreadFields`).
      const card = preserveAbsentShellFields(withConflictFix, existing);
      const nextCards = cards.some((entry) => entry.cardId === card.cardId)
        ? Arr.map(cards, (entry) => (entry.cardId === card.cardId ? card : entry))
        : Arr.append(cards, card);
      return { ...snapshot, cards: nextCards };
    }
    case "card-queued": {
      // The one authoritative live flip of `queued` (t3o-11): the governor
      // admitted the card's step (→ false) or held it for a slot (→ true). A
      // no-op for a card we do not hold (archived / not yet arrived).
      // Admission also settles the durable `stepRunning` dot: admitted-to-running
      // (`queued=false, stepRunning=true`) vs held-for-a-slot (`queued=true,
      // stepRunning=false`). Both flip on this one delta.
      const nextCards = Arr.map(cards, (card) =>
        card.cardId === event.cardId &&
        (card.queued !== event.queued || card.stepRunning !== event.stepRunning)
          ? { ...card, queued: event.queued, stepRunning: event.stepRunning }
          : card,
      );
      return { ...snapshot, cards: nextCards };
    }
    case "card-stalled": {
      // The authoritative live flip of `stalled` (t3o-17, D3): recovery gave up
      // on the card's step (→ true) or a retry / fresh run put it back to work
      // (→ false). A no-op for a card we do not hold.
      //
      // It also carries `queued`, which every emitter sets false: recovered,
      // freshly selected, settled and awaiting-input are all statuses that are
      // not `queued`, so this delta is the general clear. It used to be inferred
      // here — lowered only when `stalled` rose — on the belief that a step
      // always leaves the queue through `card-step-admitted`. It does not: a
      // step held for a slot can settle straight out of the queue, and the card
      // then kept a queue badge no later delta cleared, going on to occupy a
      // displayed queue position for every card behind it until a reconnect
      // re-derived the shell from the snapshot.
      // Recovery/select/settle also settle the durable `stepRunning` dot on this
      // same delta: recovered-to-running lights it, while stalled / freshly
      // selected (pending) / settled (terminal) put it out.
      //
      // And it carries `stepAwaiting` (t3o-34, D4; T3O-23), which is why a step
      // PARKING publishes through this delta at all: awaiting-input emitted
      // nothing to the column card before. Two emitters SET it — the step
      // parking on a question and a human pausing it — and every other one
      // clears it, so answering the question or pressing Resume clears the badge
      // on the same event that re-lights the dot or raises the queue pill.
      //
      // And `stepConflictFix` (T3O-9): the fix's own select-step raises it, its
      // settle lowers it, and the awaiting/recovered emitters carry it through —
      // so the amber "Conflicts" pill tracks the step rather than an in-memory
      // server arm that a restart would drop.
      const nextCards = Arr.map(cards, (card) => {
        if (card.cardId !== event.cardId) return card;
        // …and WHY it stalled, plus when it next tries (T3O-22, D10). Both are
        // key-optional and cleared by their absence HERE: this delta describes
        // the whole step-derived slice, so an absent key on it is a real "no
        // longer stalled", where an absent key on a card-carrying delta means
        // "preserve", as it does for every other step-derived field.
        const nextStalledReason = event.stalledReason;
        const nextRetryAt = event.retryAt;
        const nextLimitedBy = event.limitedByInstanceId;
        if (
          card.stalled === event.stalled &&
          card.queued === event.queued &&
          card.stepRunning === event.stepRunning &&
          card.held === event.held &&
          card.stepAwaiting === event.stepAwaiting &&
          card.stepConflictFix === event.stepConflictFix &&
          card.stepChecksFix === event.stepChecksFix &&
          card.stalledReason === nextStalledReason &&
          card.retryAt === nextRetryAt &&
          card.limitedByInstanceId === nextLimitedBy
        ) {
          return card;
        }
        // The three stall keys are DELETED first, then re-applied from the
        // delta. Spreading them conditionally over `...card` would preserve a
        // stale reason on the delta that says the step is no longer stalled —
        // and this delta is the only thing that ever clears the chip.
        const stripped = { ...card };
        for (const field of STALL_SHELL_FIELDS) delete stripped[field];
        // Key-optional and authoritative here too (T3O-12): absent means false.
        delete stripped.stepChecksFix;
        return {
          ...stripped,
          stalled: event.stalled,
          queued: event.queued,
          stepRunning: event.stepRunning,
          held: event.held,
          stepAwaiting: event.stepAwaiting,
          stepConflictFix: event.stepConflictFix,
          ...(event.stepChecksFix === true ? { stepChecksFix: true } : {}),
          ...(nextStalledReason === undefined ? {} : { stalledReason: nextStalledReason }),
          ...(nextRetryAt === undefined ? {} : { retryAt: nextRetryAt }),
          ...(nextLimitedBy === undefined ? {} : { limitedByInstanceId: nextLimitedBy }),
        };
      });
      return { ...snapshot, cards: nextCards };
    }
    case "card-plans": {
      // The card's plan set was replaced (t3o-08) — the authoritative live
      // change of the footer's plan count. A no-op for a card we do not hold.
      const nextCards = Arr.map(cards, (card) =>
        card.cardId === event.cardId && card.planCount !== event.planCount
          ? { ...card, planCount: event.planCount }
          : card,
      );
      return { ...snapshot, cards: nextCards };
    }
    case "card-review": {
      // A review phase completed (t3o-22, D7) — the authoritative live change
      // of the card face's round pips, severity chip and convergence flag. A
      // no-op for a card we do not hold. Applied as a whole slice, and cleared
      // as a whole when the summary is null.
      const nextCards = Arr.map(cards, (card) => {
        if (card.cardId !== event.cardId) return card;
        const stripped = { ...card };
        for (const field of REVIEW_SHELL_FIELDS) delete stripped[field];
        return event.summary === null
          ? stripped
          : {
              ...stripped,
              roundCurrent: event.summary.roundCurrent,
              // Omitted, not nulled, when the producer could not see the
              // budget: the shell key is optional and its absence is the
              // signal the row reads.
              ...(event.summary.roundMax === null ? {} : { roundMax: event.summary.roundMax }),
              reviewOutcome: event.summary.outcome,
              reviewHeldOutcome: event.summary.heldOutcome,
              reviewRoundComplete: event.summary.roundComplete,
              severityCritical: event.summary.severityCritical,
              severityImprovement: event.summary.severityImprovement,
              severityNitpick: event.summary.severityNitpick,
              issuesFixed: event.summary.issuesFixed,
              issuesRejected: event.summary.issuesRejected,
              issuesOpen: event.summary.issuesOpen,
              issuesDisputed: event.summary.issuesDisputed,
            };
      });
      return { ...snapshot, cards: nextCards };
    }
    case "card-threads": {
      // The card's whole live link set, replaced wholesale (t3o-18, D3): the set
      // changes for three different reasons — a todo revision, a link, an unlink
      // — and a replace is idempotent under all three.
      const others = snapshot.cardThreads.filter(
        (entry) => entry.cardId !== event.cardId,
      );
      return {
        ...snapshot,
        cardThreads: [...others, ...event.threads],
      };
    }
    case "card-removed":
      return {
        ...snapshot,
        cards: Arr.filter(cards, (card) => card.cardId !== event.cardId),
        // A card that left the board takes its thread entries with it; leaving
        // them would leak an unbounded list across a long-lived session.
        cardThreads: snapshot.cardThreads.filter(
          (entry) => entry.cardId !== event.cardId,
        ),
      };
    case "label-upserted": {
      // Catalogue delta (t3o-06a): the whole board's label vocabulary rides
      // once. A recolour arrives here and repaints every chip that references
      // the id, with no card deltas. Delete/undelete are upserts carrying
      // `deletedAt` set/cleared — the label stays in the catalogue.
      const labels = snapshot.labels;
      const nextLabels = labels.some((existing) => existing.labelId === event.label.labelId)
        ? Arr.map(labels, (existing) =>
            existing.labelId === event.label.labelId ? event.label : existing,
          )
        : Arr.append(labels, event.label);
      return { ...snapshot, labels: nextLabels };
    }
    case "stage-upserted": {
      // Stage aggregate delta (t3o-15): the whole stage list rides so the board
      // reads column order and labels from it (D13). Create / rename / reorder
      // all arrive here; kept in canonical `compareBoardStages` order.
      const stages = snapshot.stages;
      // Spread-then-sort: Hermes (mobile) has no `Array#toSorted`.
      const nextStages = [
        ...(stages.some((existing) => existing.stageId === event.stage.stageId)
          ? Arr.map(stages, (existing) =>
              existing.stageId === event.stage.stageId ? event.stage : existing,
            )
          : Arr.append(stages, event.stage)),
      ].sort(compareBoardStages);
      return { ...snapshot, stages: nextStages };
    }
    case "card-provider-limit-upserted": {
      // The provider-cooldown slice (T3O-22, D14): one fact per provider
      // ACCOUNT, riding once like the label catalogue rather than denormalised
      // onto every card that shares it — which is also what lets the top bar
      // say "Anthropic limit · 1:00 AM" with no card on screen.
      const limits = snapshot.providerLimits;
      const nextLimits = limits.some(
        (existing) => existing.providerInstanceId === event.limit.providerInstanceId,
      )
        ? Arr.map(limits, (existing) =>
            existing.providerInstanceId === event.limit.providerInstanceId ? event.limit : existing,
          )
        : Arr.append(limits, event.limit);
      return { ...snapshot, providerLimits: nextLimits };
    }
    case "card-provider-limit-cleared":
      return {
        ...snapshot,
        providerLimits: Arr.filter(
          snapshot.providerLimits,
          (existing) => existing.providerInstanceId !== event.providerInstanceId,
        ),
      };
    case "stage-removed": {
      const stages = snapshot.stages;
      return {
        ...snapshot,
        stages: Arr.filter(stages, (stage) => stage.stageId !== event.stageId),
      };
    }
  }
}
