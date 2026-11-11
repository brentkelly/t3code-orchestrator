/**
 * Cards arrive with thread-derived fields at rest (the server maps each event purely from
 * its payload); views overlay them via `withBoardThreadFields`.
 */
import {
  compareBoardStages,
  type BoardCardShell,
  type BoardShellSnapshot,
  type BoardShellStreamEvent,
  type BoardShellStreamItem,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";

/** The review slice — carried as a group, never field by field.
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
  "issuesEscalated",
  "reviewAdvancedRound",
  "reviewUnreviewedFixes",
] as const satisfies ReadonlyArray<keyof BoardCardShell>;

/** The stall slice — carried as a group for the same reason
    the review slice is: the reason and the retry time describe ONE stop, and
    half of them left behind would put a stale "resuming 2:50am" under a card
    that is running again. */
const STALL_SHELL_FIELDS = ["stalledReason", "retryAt"] as const satisfies ReadonlyArray<
  keyof BoardCardShell
>;

/**
 * Carries key-optional fields a card-carrying delta cannot see (brief image, plan count,
 * review and stall slices). Their resting value is the absent key, so "could not see it"
 * stays distinct from "saw nothing": an explicit `false`/`0` clears, an absent key keeps.
 */
function preserveAbsentShellFields(
  next: BoardCardShell,
  existing: BoardCardShell | undefined,
): BoardCardShell {
  if (existing === undefined) return next;
  const briefHasImage = next.briefHasImage ?? existing.briefHasImage;
  const planCount = next.planCount ?? existing.planCount;
  // Usage rides only the snapshot and `card-usage` (T3O-77).
  const usage = next.usage ?? existing.usage;
  // The review slice rides or rests as a whole: `reviewOutcome` present means
  // the producer saw the ledger, so every key it holds is authoritative.
  const carryReview = next.reviewOutcome === undefined && existing.reviewOutcome !== undefined;
  // Carry only while `next.stalled` holds: `card-stalled` deletes the keys when the stop
  // ends, so "still stalled with no reason" means the producer could not see step state.
  const carryStall =
    next.stalled && next.stalledReason === undefined && existing.stalledReason !== undefined;
  // Which limit holds a queued card rides only `card-queued` and the
  // snapshot, so under a card still queued, a delta without it means "carry".
  const carryQueuedBy =
    next.queued && next.queuedBy === undefined && existing.queuedBy !== undefined;
  if (
    briefHasImage === next.briefHasImage &&
    planCount === next.planCount &&
    usage === next.usage &&
    !carryReview &&
    !carryStall &&
    !carryQueuedBy
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
    ...(usage === undefined ? {} : { usage }),
    ...(carryQueuedBy ? { queuedBy: existing.queuedBy } : {}),
    ...carried,
  };
}

/**
 * Deltas at or below `snapshotSequence` are dropped and every applied delta advances it; a
 * reconnect resumes from that cursor. `card-threads` is a fresh read, not an event, so it is
 * always applied and never moves the cursor.
 */
export function applyBoardShellStreamItem(
  snapshot: BoardShellSnapshot | null,
  item: BoardShellStreamItem,
): BoardShellSnapshot | null {
  if (item.kind === "snapshot") return item.snapshot;
  if (snapshot === null) return null;
  if (item.kind === "card-threads" || item.kind === "card-usage") {
    return applyBoardShellStreamEvent(snapshot, item);
  }
  // The worker summary carries runtime status the board log never
  // sees, so its sequence is only the board head: a fresh read, unguarded.
  if (item.kind === "workers") return applyBoardShellStreamEvent(snapshot, item);
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
      // `queued` comes from step state a card-carrying delta cannot see, so keep the held value;
      // `card-queued` and the snapshot are authoritative.
      const existing = cards.find((entry) => entry.cardId === event.card.cardId);
      const withQueued =
        existing === undefined || existing.queued === event.card.queued
          ? event.card
          : { ...event.card, queued: existing.queued };
      // `stalled` is derived from step state the same way, so a
      // card-carrying delta rests it at false too — preserve the last known
      // value so a drag never blanks a stalled badge.
      const withStalled =
        existing === undefined || existing.stalled === withQueued.stalled
          ? withQueued
          : { ...withQueued, stalled: existing.stalled };
      // `stepRunning` also comes from step state; keep the held value so a drag never blanks a
      // working card's dot. `card-queued`/`card-stalled` and the snapshot are authoritative.
      const withStepRunning =
        existing === undefined || existing.stepRunning === withStalled.stepRunning
          ? withStalled
          : { ...withStalled, stepRunning: existing.stepRunning };
      // `held` likewise: keep it, or a title edit on a parked card clears the flag saying it
      // needs a human. `card-stalled` and the snapshot are authoritative.
      const withHeld =
        existing === undefined || existing.held === withStepRunning.held
          ? withStepRunning
          : { ...withStepRunning, held: existing.held };
      // `stepAwaiting` comes off the same slice and rests at null
      // on a card-carrying delta, so preserve it too — otherwise renaming a card
      // that is waiting on an answer clears the badge that says so.
      const withStepAwaiting =
        existing === undefined || existing.stepAwaiting === withHeld.stepAwaiting
          ? withHeld
          : { ...withHeld, stepAwaiting: existing.stepAwaiting };
      // An absent `briefHasImage`/`planCount` means "unchanged"; a present key, even
      // `false`/`0`, is authoritative. `stepConflictFix` rests at false on a card-carrying
      // delta, so keep it, or a label edit clears the Conflicts pill.
      const withConflictFixOnly =
        existing === undefined || existing.stepConflictFix === withStepAwaiting.stepConflictFix
          ? withStepAwaiting
          : { ...withStepAwaiting, stepConflictFix: existing.stepConflictFix };
      // `stepChecksFix` likewise: a card-carrying delta omits it, so
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
      // The authoritative live flip of `queued`, `stepRunning` and the holding limit (absent
      // clears). A no-op for a card we do not hold.
      const nextCards = Arr.map(cards, (card) => {
        if (
          card.cardId !== event.cardId ||
          (card.queued === event.queued &&
            card.stepRunning === event.stepRunning &&
            card.queuedBy === event.queuedBy)
        ) {
          return card;
        }
        const { queuedBy: _previous, ...rest } = card;
        return {
          ...rest,
          queued: event.queued,
          stepRunning: event.stepRunning,
          ...(event.queuedBy === undefined ? {} : { queuedBy: event.queuedBy }),
        };
      });
      return { ...snapshot, cards: nextCards };
    }
    case "card-stalled": {
      // The authoritative flip of `stalled`, and the general clear of `queued`: a step held for a
      // slot can settle straight out of the queue, so `queued` cannot be inferred. It also
      // settles `stepRunning`, `stepAwaiting` (set only by parking on a question or a pause)
      // and `stepConflictFix`. A no-op for a card we do not hold.
      const nextCards = Arr.map(cards, (card) => {
        if (card.cardId !== event.cardId) return card;
        // This delta describes the whole step-derived slice, so an absent reason or retry time
        // here clears it, unlike on a card-carrying delta, where absent means "preserve".
        const nextStalledReason = event.stalledReason;
        const nextRetryAt = event.retryAt;
        if (
          card.stalled === event.stalled &&
          card.queued === event.queued &&
          card.stepRunning === event.stepRunning &&
          card.held === event.held &&
          card.stepAwaiting === event.stepAwaiting &&
          card.stepConflictFix === event.stepConflictFix &&
          card.stepChecksFix === event.stepChecksFix &&
          card.stalledReason === nextStalledReason &&
          card.retryAt === nextRetryAt
        ) {
          return card;
        }
        // The stall keys are DELETED first, then re-applied from the
        // delta. Spreading them conditionally over `...card` would preserve a
        // stale reason on the delta that says the step is no longer stalled —
        // and this delta is the only thing that ever clears the chip.
        const stripped = { ...card };
        for (const field of STALL_SHELL_FIELDS) delete stripped[field];
        // Key-optional and authoritative here too: absent means false.
        delete stripped.stepChecksFix;
        // Every emitter of this delta leaves the step out of the queue, so the
        // limit that held it goes with it.
        if (!event.queued) delete stripped.queuedBy;
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
        };
      });
      return { ...snapshot, cards: nextCards };
    }
    case "card-plans": {
      // The card's plan set was replaced — the authoritative live
      // change of the footer's plan count. A no-op for a card we do not hold.
      const nextCards = Arr.map(cards, (card) =>
        card.cardId === event.cardId && card.planCount !== event.planCount
          ? { ...card, planCount: event.planCount }
          : card,
      );
      return { ...snapshot, cards: nextCards };
    }
    case "card-usage": {
      // A fresh read of the card's figure, like `card-threads`; null clears it.
      const nextCards = Arr.map(cards, (card) => {
        if (card.cardId !== event.cardId) return card;
        if (event.usage === null) {
          const { usage: _cleared, ...rest } = card;
          return rest;
        }
        return { ...card, usage: event.usage };
      });
      return { ...snapshot, cards: nextCards };
    }
    case "card-review": {
      // A review phase completed — the authoritative live change
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
              issuesEscalated: event.summary.issuesEscalated,
              ...(event.summary.advancedRound === null
                ? {}
                : {
                    reviewAdvancedRound: event.summary.advancedRound,
                    reviewUnreviewedFixes: event.summary.unreviewedFixes,
                  }),
            };
      });
      return { ...snapshot, cards: nextCards };
    }
    case "card-threads": {
      // The card's whole live link set, replaced wholesale: the set
      // changes for three different reasons — a todo revision, a link, an unlink
      // — and a replace is idempotent under all three.
      const others = snapshot.cardThreads.filter((entry) => entry.cardId !== event.cardId);
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
        cardThreads: snapshot.cardThreads.filter((entry) => entry.cardId !== event.cardId),
      };
    case "label-upserted": {
      // Catalogue delta: the whole board's label vocabulary rides
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
      // Stage aggregate delta: the whole stage list rides so the board
      // reads column order and labels from it. Create / rename / reorder
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
    case "workers":
      // The whole worker summary, replaced wholesale.
      return { ...snapshot, workers: event.state };
    case "stage-removed": {
      const stages = snapshot.stages;
      return {
        ...snapshot,
        stages: Arr.filter(stages, (stage) => stage.stageId !== event.stageId),
      };
    }
    case "project-stage-config": {
      // A project's delta replaced, plus any stage rows a legacy
      // payload wrote and dropped, in one delta.
      const dropped = new Set<string>(event.deletedStageIds);
      const upserted = new Map<string, (typeof event.upserts)[number]>(
        event.upserts.map((stage) => [stage.stageId, stage]),
      );
      const kept = snapshot.stages
        .filter((stage) => !dropped.has(stage.stageId) && !upserted.has(stage.stageId))
        .concat(event.upserts);
      return {
        ...snapshot,
        // Spread-then-sort: Hermes (mobile) has no `Array#toSorted`.
        stages: [...kept].sort(compareBoardStages),
        projectStageConfigs: { ...snapshot.projectStageConfigs, [event.projectId]: event.config },
      };
    }
  }
}
