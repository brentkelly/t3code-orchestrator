/**
 * T3o board projector (t3o-03): legacy walking-skeleton payloads decode to
 * the documented defaults, archive keeps the card in the read model while
 * the shell drops it, tombstoned links survive projection, and the created
 * counter bump is monotonic.
 */
import {
  BOARD_SEED_LABEL_IDS,
  BoardCardId,
  BoardPlanId,
  BoardStageId,
  boardCardShellFromCard,
  EventId,
  LEGACY_BOARD_CARD_KEY,
  LEGACY_BOARD_CARD_NUMBER,
  LEGACY_BOARD_CARD_ORDER_KEY,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardCardStepState,
  type BoardPlan,
  type BoardStepCompletion,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { boardShellStreamEvent, projectBoardEvent, type BoardEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const cardId = BoardCardId.make("card-1");

function emptyModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    updatedAt: NOW,
  };
}

function makeCard(overrides: Partial<BoardCard>): BoardCard {
  return {
    id: cardId,
    key: "CARD-1",
    cardNumber: 1,
    projectId,
    labels: [],
    stage: BoardStageId.make("backlog"),
    orderKey: "m",
    title: "Card",
    briefRef: null,
    dependsOn: [],
    parentCardId: null,
    sourcePlanId: null,
    threadLinks: [],
    externalRef: null,
    humanInLoop: null,
    reviewOverrides: null,
    modelOverrides: null,
    worktree: null,
    pullRequest: null,
    pullRequestHistory: [],
    pullRequestFloor: null,
    blocked: false,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** A minimal-but-valid step state for a card, so a delete test can prove the
    purge drops the deleted card's row while keeping a survivor's. */
function makeStepState(id: string): BoardCardStepState {
  return {
    cardId: BoardCardId.make(id),
    stepId: "s1",
    stepLabel: "Build",
    stageLabel: "Building",
    attempt: 1,
    stallCount: 0,
    lastNudgeAt: null,
    baseTipAtRoundStart: null,
    prompt: "",
    providerInstanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5-codex",
    mode: "build",
    runtimeMode: "approval-required",
    humanInLoop: false,
    maxAttempts: 3,
    timeoutMs: 1000,
    threadId: null,
    status: "succeeded",
    slotHeld: false,
    startedAt: null,
    updatedAt: NOW,
  };
}

function makeCompletion(id: string): BoardStepCompletion {
  return {
    cardId: BoardCardId.make(id),
    stepId: "s1",
    outcome: "succeeded",
    summary: "done",
    payload: null,
    threadId: null,
    completedAt: NOW,
  };
}

function makePlan(id: string): BoardPlan {
  return {
    planId: BoardPlanId.make(`${id}::p1`),
    cardId: BoardCardId.make(id),
    title: "Plan",
    summary: "Plan summary",
    dependsOn: [],
    ordinal: 0,
    locked: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const eventBase = {
  sequence: 1,
  eventId: EventId.make("event-1"),
  aggregateKind: "card",
  aggregateId: cardId,
  occurredAt: NOW,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
} as const;

describe("board projector", () => {
  it.effect("replays a walking-skeleton created payload with the legacy defaults", () =>
    Effect.gen(function* () {
      // The exact five-field payload t3o-02 wrote to real event logs.
      const legacyEvent = {
        ...eventBase,
        type: "board.card-created",
        payload: {
          cardId,
          projectId,
          title: "Legacy card",
          createdAt: NOW,
          updatedAt: NOW,
        },
      } as unknown as BoardEvent;

      const model = yield* projectBoardEvent(emptyModel(), legacyEvent);
      const card = model.board?.cards[0];
      assert.isDefined(card);
      assert.strictEqual(card?.key, LEGACY_BOARD_CARD_KEY);
      assert.strictEqual(card?.cardNumber, LEGACY_BOARD_CARD_NUMBER);
      // A legacy payload with no cardType/labels maps to the feature seed label.
      assert.deepStrictEqual(card?.labels, [BOARD_SEED_LABEL_IDS.feature]);
      // No dependsOn/brief on a pre-t3o-06 event: empty deps, no brief ref —
      // matching migration 903's `depends_on DEFAULT '[]'` and null brief_ref.
      assert.deepStrictEqual(card?.dependsOn, []);
      assert.strictEqual(card?.briefRef, null);
      assert.strictEqual(card?.stage, "backlog");
      assert.strictEqual(card?.orderKey, LEGACY_BOARD_CARD_ORDER_KEY);
      // Legacy card 0 still reserves number 1 for the next create, matching
      // the MAX(card_number) + 1 rehydration.
      assert.deepStrictEqual(model.board?.nextCardNumberByProject, { [projectId]: 1 });
    }),
  );

  it.effect("bumps the project counter monotonically on create", () =>
    Effect.gen(function* () {
      const event = {
        ...eventBase,
        type: "board.card-created",
        payload: {
          cardId,
          projectId,
          title: "Card",
          key: "CARD-5",
          cardNumber: 5,
          cardType: "bug",
          stage: "backlog",
          orderKey: "m",
          createdAt: NOW,
          updatedAt: NOW,
        },
      } as unknown as BoardEvent;
      const model = yield* projectBoardEvent(emptyModel(), event);
      assert.deepStrictEqual(model.board?.nextCardNumberByProject, { [projectId]: 6 });
    }),
  );

  it.effect("projects a create-time brief and dependencies (t3o-06)", () =>
    Effect.gen(function* () {
      const dependencyId = BoardCardId.make("card-dep");
      const event = {
        ...eventBase,
        type: "board.card-created",
        payload: {
          cardId,
          projectId,
          title: "Card with brief",
          key: "CARD-1",
          cardNumber: 1,
          labels: [BOARD_SEED_LABEL_IDS.feature],
          brief: "The write-up",
          dependsOn: [dependencyId],
          stage: "backlog",
          orderKey: "m",
          createdAt: NOW,
          updatedAt: NOW,
        },
      } as unknown as BoardEvent;
      const model = yield* projectBoardEvent(emptyModel(), event);
      const card = model.board?.cards[0];
      assert.isDefined(card);
      // briefRef is the sentinel kind (D8: the body never enters the read model).
      assert.strictEqual(card?.briefRef, "brief");
      assert.deepStrictEqual(card?.dependsOn, [dependencyId]);
      // A creation-stage card is before Ready, so it is never blocked at birth.
      assert.strictEqual(card?.blocked, false);
      // The shell delta reflects the brief and dependency count.
      const delta = Option.getOrNull(boardShellStreamEvent(event));
      assert.strictEqual(delta?.kind, "card-upserted");
      if (delta?.kind === "card-upserted") {
        assert.strictEqual(delta.card.hasBrief, true);
        assert.strictEqual(delta.card.dependencyCount, 1);
        // A create always knows its brief — with one or without one — so the
        // footer's image flag is decided here rather than left to preserve.
        assert.strictEqual(delta.card.briefHasImage, false);
      }
    }),
  );

  // The footer's image indicator (t3o-06). The brief BODY is not on the card
  // aggregate (D8), so the flag can only be decided by the two events that
  // carry a brief; every other card delta has to leave it alone, or a drag
  // would blank the icon.
  it("decides the brief-image flag only on the events that carry a brief", () => {
    const created = {
      ...eventBase,
      type: "board.card-created",
      payload: {
        cardId,
        projectId,
        title: "Card with a picture",
        key: "CARD-1",
        cardNumber: 1,
        labels: [BOARD_SEED_LABEL_IDS.feature],
        brief: "Here it is: ![mockup](./mockup.png)",
        stage: "backlog",
        orderKey: "m",
        createdAt: NOW,
        updatedAt: NOW,
      },
    } as unknown as BoardEvent;
    const createdDelta = Option.getOrNull(boardShellStreamEvent(created));
    assert.strictEqual(
      createdDelta?.kind === "card-upserted" ? createdDelta.card.briefHasImage : null,
      true,
    );

    const card = makeCard({ briefRef: "brief" });
    // Brief edited to drop the image: `false` is a real value and must ride.
    const cleared: BoardEvent = {
      ...eventBase,
      sequence: 2,
      type: "board.card-updated",
      payload: { cardId, brief: "Described in words instead.", card },
    };
    const clearedDelta = Option.getOrNull(boardShellStreamEvent(cleared));
    assert.strictEqual(
      clearedDelta?.kind === "card-upserted" ? clearedDelta.card.briefHasImage : null,
      false,
    );

    // Brief cleared outright is also `false`, not "unknown".
    const removed: BoardEvent = {
      ...eventBase,
      sequence: 3,
      type: "board.card-updated",
      payload: { cardId, brief: null, card: makeCard({}) },
    };
    const removedDelta = Option.getOrNull(boardShellStreamEvent(removed));
    assert.strictEqual(
      removedDelta?.kind === "card-upserted" ? removedDelta.card.briefHasImage : null,
      false,
    );

    // A title-only edit does not know the brief, so it omits the key and the
    // client keeps what it has.
    const retitled: BoardEvent = {
      ...eventBase,
      sequence: 4,
      type: "board.card-updated",
      payload: { cardId, card },
    };
    const retitledDelta = Option.getOrNull(boardShellStreamEvent(retitled));
    assert.strictEqual(
      retitledDelta?.kind === "card-upserted" ? "briefHasImage" in retitledDelta.card : null,
      false,
    );

    // As does a plain move — the same rule for every card-carrying event.
    const moved: BoardEvent = {
      ...eventBase,
      sequence: 5,
      type: "board.card-moved",
      payload: {
        cardId,
        fromStage: BoardStageId.make("backlog"),
        toStage: BoardStageId.make("sprint"),
        card,
      },
    };
    const movedDelta = Option.getOrNull(boardShellStreamEvent(moved));
    assert.strictEqual(
      movedDelta?.kind === "card-upserted" ? "briefHasImage" in movedDelta.card : null,
      false,
    );
  });

  // The footer's plan indicator (t3o-08): the plan set is its own slice, so a
  // proposal emits a one-number delta of its own rather than a card upsert.
  it("emits a plan-count delta when the card's plans are replaced", () => {
    const plan = (key: string, ordinal: number) => ({
      planId: BoardPlanId.make(`${cardId}::${key}`),
      cardId,
      title: key,
      summary: "s",
      dependsOn: [],
      ordinal,
      locked: false,
      createdAt: NOW,
      updatedAt: NOW,
      body: `# ${key}`,
    });
    const proposed: BoardEvent = {
      ...eventBase,
      type: "board.plans-proposed",
      payload: { cardId, plans: [plan("one", 0), plan("two", 1)] },
    };
    assert.deepStrictEqual(Option.getOrNull(boardShellStreamEvent(proposed)), {
      kind: "card-plans",
      sequence: 1,
      cardId,
      planCount: 2,
    });

    // Rewriting one plan's BODY changes no count, so it stays card DETAIL.
    const written: BoardEvent = {
      ...eventBase,
      sequence: 2,
      type: "board.plan-written",
      payload: {
        cardId,
        planId: BoardPlanId.make(`${cardId}::one`),
        body: "# One, rewritten",
        plan: (({ body: _body, ...rest }) => rest)(plan("one", 0)),
      },
    };
    assert.strictEqual(Option.getOrNull(boardShellStreamEvent(written)), null);
  });

  it.effect("keeps an archived card in the read model while the shell drops it", () =>
    Effect.gen(function* () {
      const archivedCard = makeCard({ archivedAt: NOW });
      const event: BoardEvent = {
        ...eventBase,
        type: "board.card-archived",
        payload: { cardId, archivedAt: NOW, card: archivedCard },
      };

      const model = yield* projectBoardEvent(
        {
          ...emptyModel(),
          board: { cards: [makeCard({})], labels: [], nextCardNumberByProject: { [projectId]: 2 } },
        },
        event,
      );
      // Still in the model — unarchive must be able to restore it on replay.
      assert.deepStrictEqual(model.board?.cards, [archivedCard]);

      // But the shell sees a removal.
      const delta = boardShellStreamEvent(event);
      assert.deepStrictEqual(Option.getOrNull(delta), {
        kind: "card-removed",
        sequence: 1,
        cardId,
      });

      // And unarchiving emits the card back onto the shell — as the bounded
      // shell (t3o-04), never the full aggregate.
      const restoredCard = makeCard({});
      const unarchived: BoardEvent = {
        ...eventBase,
        sequence: 2,
        type: "board.card-unarchived",
        payload: { cardId, card: restoredCard },
      };
      assert.deepStrictEqual(Option.getOrNull(boardShellStreamEvent(unarchived)), {
        kind: "card-upserted",
        sequence: 2,
        card: boardCardShellFromCard(restoredCard),
      });
    }),
  );

  // Delete is archive's opposite: the card leaves the model along with every
  // slice keyed on it, while a survivor's rows in those same slices stay
  // untouched. This is the branch a full-engine replay test cannot reach
  // without driving the step/plan machinery — so it is exercised directly.
  it.effect("drops the deleted card and its step/completion/plan rows, keeping a survivor's", () =>
    Effect.gen(function* () {
      const survivorId = BoardCardId.make("card-2");
      const deleted = makeCard({});
      const survivor = makeCard({ id: survivorId, key: "CARD-2", cardNumber: 2 });
      const event: BoardEvent = {
        ...eventBase,
        type: "board.card-deleted",
        payload: { cardId, deletedAt: NOW, card: deleted, threadIds: [], stepState: null },
      };

      const model = yield* projectBoardEvent(
        {
          ...emptyModel(),
          board: {
            cards: [deleted, survivor],
            labels: [],
            nextCardNumberByProject: { [projectId]: 3 },
            stepStates: [makeStepState(cardId), makeStepState(survivorId)],
            stepCompletions: [makeCompletion(cardId), makeCompletion(survivorId)],
            plans: [makePlan(cardId), makePlan(survivorId)],
          },
        },
        event,
      );

      // The card is gone; the survivor stays.
      assert.deepStrictEqual(model.board?.cards, [survivor]);
      // Each per-card slice keeps EXACTLY the survivor's row — the present,
      // non-empty branch of the purge (a bug that filtered by identity would
      // drop or keep the wrong one).
      assert.deepStrictEqual(model.board?.stepStates, [makeStepState(survivorId)]);
      assert.deepStrictEqual(model.board?.stepCompletions, [makeCompletion(survivorId)]);
      assert.deepStrictEqual(model.board?.plans, [makePlan(survivorId)]);

      // The shell sees a plain removal — indistinguishable from an archive.
      assert.deepStrictEqual(Option.getOrNull(boardShellStreamEvent(event)), {
        kind: "card-removed",
        sequence: 1,
        cardId,
      });
    }),
  );

  // The absent-vs-empty rule `loadBoardState` enforces on rehydration must
  // hold on the replay edge too, or D7's replay-equals-rehydration (compared
  // with deepStrictEqual) breaks. Two ways it could:
  //  - an absent slice becoming a present `undefined`, and
  //  - a slice the delete EMPTIES becoming a present `[]` instead of omitted
  //    (rehydration drops an empty table — deleting the last plan-holder would
  //    otherwise leave replay with `plans: []` and rehydration with no key).
  it.effect("omits a slice the delete empties, and leaves an absent slice absent", () =>
    Effect.gen(function* () {
      // The deleted card is the SOLE holder of every per-card slice; plans is
      // simply absent. After the delete, the emptied slices are OMITTED (not
      // `[]`) and the absent one stays absent.
      const event: BoardEvent = {
        ...eventBase,
        type: "board.card-deleted",
        payload: { cardId, deletedAt: NOW, card: makeCard({}), threadIds: [], stepState: null },
      };
      const model = yield* projectBoardEvent(
        {
          ...emptyModel(),
          board: {
            cards: [makeCard({})],
            labels: [],
            nextCardNumberByProject: { [projectId]: 2 },
            stepStates: [makeStepState(cardId)],
            stepCompletions: [makeCompletion(cardId)],
          },
        },
        event,
      );
      assert.deepStrictEqual(model.board?.cards, []);
      // Emptied → omitted, exactly as rehydration would leave them.
      assert.isFalse(Object.hasOwn(model.board ?? {}, "stepStates"));
      assert.isFalse(Object.hasOwn(model.board ?? {}, "stepCompletions"));
      // Never a holder → still absent.
      assert.isFalse(Object.hasOwn(model.board ?? {}, "plans"));
    }),
  );

  // The `blocked` re-flag an archive emits for its dependents (t3o-13, D5)
  // rides the ordinary card-updated event, so it must reach every client the
  // same way any other card change does — via a shell delta, with no reload.
  it.effect("emits a shell upsert for a dependent re-flagged by an archive", () =>
    Effect.gen(function* () {
      const dependentId = BoardCardId.make("card-dependent");
      const unblocked = makeCard({
        id: dependentId,
        key: "CARD-2",
        cardNumber: 2,
        stage: BoardStageId.make("ready"),
        blocked: false,
        dependsOn: [cardId],
      });
      const event: BoardEvent = {
        ...eventBase,
        sequence: 2,
        aggregateId: dependentId,
        type: "board.card-updated",
        payload: { cardId: dependentId, card: unblocked },
      };

      const model = yield* projectBoardEvent(
        {
          ...emptyModel(),
          board: {
            cards: [makeCard({ archivedAt: NOW }), makeCard({ id: dependentId, blocked: true })],
            labels: [],
            nextCardNumberByProject: { [projectId]: 3 },
          },
        },
        event,
      );
      assert.strictEqual(
        model.board?.cards.find((card) => card.id === dependentId)?.blocked,
        false,
      );

      const delta = Option.getOrNull(boardShellStreamEvent(event));
      assert.deepStrictEqual(delta, {
        kind: "card-upserted",
        sequence: 2,
        card: boardCardShellFromCard(unblocked),
      });
      assert.strictEqual(
        delta?.kind === "card-upserted" ? delta.card.blocked : null,
        false,
        "the client learns the card is unblocked from the delta alone",
      );
    }),
  );

  it.effect("projects a tombstoned link as retained, not removed", () =>
    Effect.gen(function* () {
      const tombstonedCard = makeCard({
        threadLinks: [
          {
            threadId: ThreadId.make("thread-1"),
            role: "review:r1:triage",
            linkedAt: NOW,
            tombstonedAt: NOW,
          },
        ],
      });
      const event: BoardEvent = {
        ...eventBase,
        type: "board.card-thread-unlinked",
        payload: {
          cardId,
          threadId: ThreadId.make("thread-1"),
          tombstonedAt: NOW,
          card: tombstonedCard,
        },
      };
      const model = yield* projectBoardEvent(
        {
          ...emptyModel(),
          board: { cards: [makeCard({})], labels: [], nextCardNumberByProject: {} },
        },
        event,
      );
      assert.deepStrictEqual(model.board?.cards[0]?.threadLinks, tombstonedCard.threadLinks);
    }),
  );

  it.effect("projects step state as one record per card, overwriting on transition (t3o-10)", () =>
    Effect.gen(function* () {
      const running = {
        cardId,
        stepId: "build",
        stepLabel: "Build",
        stageLabel: "Building",
        attempt: 1,
        stallCount: 0,
        lastNudgeAt: null,
        baseTipAtRoundStart: null,
        // Frozen execution config on the run row (D12).
        prompt: "do it",
        providerInstanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        mode: "build" as const,
        runtimeMode: "auto" as const,
        humanInLoop: false,
        maxAttempts: 3,
        timeoutMs: 1000,
        threadId: ThreadId.make("thread-1"),
        status: "running" as const,
        slotHeld: true,
        startedAt: NOW,
        updatedAt: NOW,
      };
      const selectedEvent: BoardEvent = {
        ...eventBase,
        type: "board.card-step-selected",
        payload: {
          cardId,
          state: {
            ...running,
            status: "pending",
            threadId: null,
            slotHeld: false,
            startedAt: null,
          },
        },
      };
      const admittedEvent: BoardEvent = {
        ...eventBase,
        type: "board.card-step-admitted",
        payload: { cardId, state: running },
      };
      const settledEvent: BoardEvent = {
        ...eventBase,
        type: "board.card-step-settled",
        payload: { cardId, state: { ...running, status: "succeeded", slotHeld: false } },
      };
      const base = {
        ...emptyModel(),
        board: { cards: [makeCard({})], labels: [], nextCardNumberByProject: {} },
      };
      const afterSelect = yield* projectBoardEvent(base, selectedEvent);
      assert.strictEqual(afterSelect.board?.stepStates?.length, 1);
      assert.strictEqual(afterSelect.board?.stepStates?.[0]?.status, "pending");
      const afterAdmit = yield* projectBoardEvent(afterSelect, admittedEvent);
      assert.strictEqual(afterAdmit.board?.stepStates?.length, 1); // still one record per card
      assert.strictEqual(afterAdmit.board?.stepStates?.[0]?.status, "running");
      const afterSettle = yield* projectBoardEvent(afterAdmit, settledEvent);
      assert.strictEqual(afterSettle.board?.stepStates?.[0]?.status, "succeeded");
      assert.strictEqual(afterSettle.board?.stepStates?.[0]?.slotHeld, false);
      // Admission to RUNNING flips the one step field on the shell (t3o-11,
      // D11): a `card-queued` delta clearing the queued badge (queued=false).
      // Every other step field stays card DETAIL on the subscription (D7).
      const admittedDelta = boardShellStreamEvent(admittedEvent);
      assert.strictEqual(Option.isSome(admittedDelta), true);
      assert.deepStrictEqual(Option.getOrThrow(admittedDelta), {
        kind: "card-queued",
        sequence: admittedEvent.sequence,
        cardId,
        queued: false,
        stepRunning: true,
      });
      // A step only leaves `queued` via admission above, never via settle — but
      // settling clears the stalled badge (t3o-17, D3): the one path a stalled
      // step leaves without a fresh select-step is a human taking over its live
      // thread and completing it, so settle emits card-stalled=false.
      assert.deepStrictEqual(Option.getOrThrow(boardShellStreamEvent(settledEvent)), {
        kind: "card-stalled",
        sequence: settledEvent.sequence,
        cardId,
        stalled: false,
        stepRunning: false,
      });
    }),
  );

  it.effect("admission that queues the step raises the queued badge (t3o-11)", () =>
    Effect.sync(() => {
      const queuedState = {
        cardId,
        stepId: "build",
        stepLabel: "Build",
        stageLabel: "Building",
        attempt: 1,
        stallCount: 0,
        lastNudgeAt: null,
        baseTipAtRoundStart: null,
        prompt: "do it",
        providerInstanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        mode: "build" as const,
        runtimeMode: "auto" as const,
        humanInLoop: false,
        maxAttempts: 3,
        timeoutMs: 1000,
        threadId: null,
        status: "queued" as const,
        slotHeld: false,
        startedAt: null,
        updatedAt: NOW,
      };
      const queuedAdmit: BoardEvent = {
        ...eventBase,
        type: "board.card-step-admitted",
        payload: { cardId, state: queuedState },
      };
      const delta = boardShellStreamEvent(queuedAdmit);
      assert.deepStrictEqual(Option.getOrThrow(delta), {
        kind: "card-queued",
        sequence: queuedAdmit.sequence,
        cardId,
        queued: true,
        stepRunning: false,
      });
    }),
  );

  it.effect("recovery giving up raises the stalled badge; a fresh run clears it (t3o-17, D3)", () =>
    Effect.sync(() => {
      const baseState = {
        cardId,
        stepId: "build",
        stepLabel: "Build",
        stageLabel: "Building",
        attempt: 5,
        stallCount: 5,
        lastNudgeAt: NOW,
        baseTipAtRoundStart: null,
        prompt: "do it",
        providerInstanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        mode: "build" as const,
        runtimeMode: "auto" as const,
        humanInLoop: false,
        maxAttempts: 5,
        timeoutMs: 1000,
        threadId: ThreadId.make("thread-1"),
        slotHeld: false,
        startedAt: NOW,
        updatedAt: NOW,
      };
      // A recover event that landed the step in `stalled` emits card-stalled=true.
      const stalledRecover: BoardEvent = {
        ...eventBase,
        type: "board.card-step-recovered",
        payload: { cardId, state: { ...baseState, status: "stalled" as const } },
      };
      assert.deepStrictEqual(Option.getOrThrow(boardShellStreamEvent(stalledRecover)), {
        kind: "card-stalled",
        sequence: stalledRecover.sequence,
        cardId,
        stalled: true,
        stepRunning: false,
      });
      // An ordinary retry (status running) clears the badge.
      const retryRecover: BoardEvent = {
        ...eventBase,
        type: "board.card-step-recovered",
        payload: { cardId, state: { ...baseState, status: "running" as const } },
      };
      assert.deepStrictEqual(Option.getOrThrow(boardShellStreamEvent(retryRecover)), {
        kind: "card-stalled",
        sequence: retryRecover.sequence,
        cardId,
        stalled: false,
        stepRunning: true,
      });
      // A fresh stage run (select-step) also clears any lingering stalled badge.
      const selected: BoardEvent = {
        ...eventBase,
        type: "board.card-step-selected",
        payload: {
          cardId,
          state: { ...baseState, attempt: 1, stallCount: 0, status: "pending" as const },
        },
      };
      assert.deepStrictEqual(Option.getOrThrow(boardShellStreamEvent(selected)), {
        kind: "card-stalled",
        sequence: selected.sequence,
        cardId,
        stalled: false,
        stepRunning: false,
      });
    }),
  );

  // ── Sub-boards (t3o-23) ──────────────────────────────────────────────

  it.effect("projects a sub-board child creation: parent link, source plan, brief pointer", () =>
    Effect.gen(function* () {
      const parentId = BoardCardId.make("card-parent");
      const planId = BoardPlanId.make("card-parent::p1");
      const event: BoardEvent = {
        ...eventBase,
        type: "board.card-created",
        payload: {
          cardId,
          projectId,
          title: "Part one",
          key: "T3-191",
          cardNumber: 191,
          labels: [],
          briefFromPlanId: planId,
          dependsOn: [],
          parentCardId: parentId,
          sourcePlanId: planId,
          stage: BoardStageId.make("ready"),
          orderKey: "m",
          createdAt: NOW,
          updatedAt: NOW,
        },
      };
      const model = yield* projectBoardEvent(emptyModel(), event);
      const card = model.board?.cards.find((existing) => existing.id === cardId);
      assert.ok(card !== undefined);
      assert.strictEqual(card.parentCardId, parentId);
      assert.strictEqual(card.sourcePlanId, planId);
      // A brief-by-pointer still means the card HAS a brief — the SQL
      // projector resolves the body in the same transaction.
      assert.notStrictEqual(card.briefRef, null);

      // The child's shell delta carries its parent for the "part of" chip.
      const delta = Option.getOrThrow(boardShellStreamEvent(event));
      assert.ok(delta.kind === "card-upserted");
      assert.strictEqual(delta.card.parentCardId, parentId);
    }),
  );

  it.effect("projects plans-approved and the integration-branch record via the carried card", () =>
    Effect.gen(function* () {
      const parent = makeCard({ stage: BoardStageId.make("building") });
      const approved: BoardEvent = {
        ...eventBase,
        type: "board.plans-approved",
        payload: {
          cardId,
          card: parent,
          childCardIds: [BoardCardId.make("card-a"), BoardCardId.make("card-b")],
          approvedAt: NOW,
        },
      };
      const afterApproval = yield* projectBoardEvent(emptyModel(), approved);
      assert.strictEqual(
        afterApproval.board?.cards.find((existing) => existing.id === cardId)?.stage,
        parent.stage,
      );
      const approvedDelta = Option.getOrThrow(boardShellStreamEvent(approved));
      assert.strictEqual(approvedDelta.kind, "card-upserted");

      const withBranch = makeCard({
        stage: BoardStageId.make("building"),
        worktree: {
          branch: "board/card-1",
          baseRefName: "main",
          path: null,
          status: "branch-only",
          attempts: 1,
          lastError: null,
          reclaimBlockedReason: null,
        },
      });
      const recorded: BoardEvent = {
        ...eventBase,
        type: "board.card-integration-branch-recorded",
        payload: { cardId, branch: "board/card-1", baseRefName: "main", card: withBranch },
      };
      const afterRecord = yield* projectBoardEvent(afterApproval, recorded);
      assert.strictEqual(
        afterRecord.board?.cards.find((existing) => existing.id === cardId)?.worktree?.status,
        "branch-only",
      );
      const recordedDelta = Option.getOrThrow(boardShellStreamEvent(recorded));
      assert.strictEqual(recordedDelta.kind, "card-upserted");
    }),
  );
});
