/**
 * T3o board payload discipline (t3o-04). The shell/detail split (D7) is won
 * or lost here: `BoardCardShell` rides every shell snapshot and every
 * reconnect, so its serialized size is a contract, not an implementation
 * detail. A regression is invisible on localhost and obvious on a phone on
 * cellular — these tests are the tripwire.
 */
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  BoardCardStepState,
  BOARD_CARD_LABELS_MAX,
  BOARD_THREAD_TODO_CURRENT_MAX_BYTES,
  BOARD_THREAD_TODO_ITEMS_MAX,
  boardThreadTodosComplete,
  boardThreadTodoSummary,
  BOARD_CARD_SHELL_TITLE_MAX_BYTES,
  BOARD_LABEL_NAME_MAX_LENGTH,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  boardCardArchiveNeedsConfirmation,
  boardCardShellFromCard,
  BoardCardShell,
  BoardLabelId,
  BoardLabelName,
  boardCardPendingSplit,
  boardCardShellPendingSplit,
  boardCardUnfinishedChildren,
  boardSubBoardFloorStage,
  BoardPlanId,
  BOARD_SEED_STAGES,
  deriveBoardCardBlocked,
  deriveBoardCardPlanProgress,
  deriveBoardCardThreadState,
  EMPTY_BOARD_STATE,
  isBoardStageAtOrAfterSubBoardFloor,
  liveBoardCardDependents,
  makeBoardCardShell,
  unmetBoardCardDependencies,
  type BoardCard,
  type BoardPlan,
  type BoardState,
} from "./board.ts";
import { OrchestrationShellSnapshot } from "./orchestration.ts";
import { ProjectId, ThreadId } from "./baseSchemas.ts";

const encodeShell = Schema.encodeUnknownSync(BoardCardShell);
const decodeShell = Schema.decodeUnknownSync(BoardCardShell);
const encodeSnapshot = Schema.encodeUnknownSync(OrchestrationShellSnapshot);

const utf8Bytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * Measured at 860 bytes on implementation (2026-08-10) for a worst-case
 * shell — review stage with every optional field populated, UUID-length
 * ids, and the title cap fully saturated. t3o-06a added `labelIds` (a bounded
 * array of at most `BOARD_CARD_LABELS_MAX` UUID-length ids), which is ~200
 * bytes at the cap, so the budget rose to 1280 — still a hard ceiling, still
 * scalar-plus-one-small-array, and still linear in card count. If a change
 * pushes past this, it added real bytes to every card on every reconnect,
 * and the right fix is almost never raising the number.
 */
const BOARD_CARD_SHELL_BYTE_BUDGET = 1280;

/** Five UUID-length label ids: a card at exactly `BOARD_CARD_LABELS_MAX`,
    the worst case the shell must lay out for. */
const labelIdsAtCap = Array.from({ length: BOARD_CARD_LABELS_MAX }, (_, index) =>
  BoardLabelId.make(`label-${String(index)}b8a2c3d-4e5f-6789-abcd-ef0123456789`),
);

/** Worst case: every optional populated (review stage), long ids, labels at
    the cap, and the title at exactly `BOARD_CARD_SHELL_TITLE_MAX_BYTES`. */
const fullyPopulatedShell = {
  cardId: BoardCardId.make("0b8a2c3d-4e5f-6789-abcd-ef0123456789"),
  key: "T3O-1234",
  projectId: ProjectId.make("project-0b8a2c3d-4e5f-6789-abcd-ef0123456789"),
  labelIds: labelIdsAtCap,
  stage: BOARD_SEED_STAGE_IDS.review,
  orderKey: "mmmmzz",
  title: "t".repeat(BOARD_CARD_SHELL_TITLE_MAX_BYTES),
  blocked: true,
  dependencyCount: 12,
  hasBrief: true,
  // Never populated on the live snapshot (archived cards leave it, D15), but
  // the archive page reuses this shell — so the budget is measured against a
  // populated timestamp rather than the null every live card sends.
  archivedAt: "2026-01-01T00:00:00.000Z",
  hasPr: true,
  attachmentCount: 42,
  queued: true,
  stalled: true,
  stepRunning: true,
  threadState: "waiting",
  awaitingInput: true,
  activeThreadId: ThreadId.make("thread-0b8a2c3d-4e5f-6789-abcd-ef0123456789"),
  briefHasImage: true,
  planCount: 24,
  planTotal: 24,
  planDone: 12,
  prNumber: 48213,
  roundCurrent: 3,
  roundMax: 5,
  stepLabel: "Adjudicating reviewer findings",
  severityCritical: 12,
  severityImprovement: 34,
  severityNitpick: 56,
  issuesFixed: 78,
  issuesRejected: 90,
  issuesOpen: 12,
  issuesDisputed: 34,
} satisfies typeof BoardCardShell.Type;

const typicalCard = (index: number): BoardCard => ({
  id: BoardCardId.make(`card-${String(index).padStart(4, "0")}-4e5f-6789-abcd-ef0123456789`),
  key: `T3O-${index}`,
  cardNumber: index,
  projectId: ProjectId.make("project-0b8a2c3d-4e5f-6789-abcd-ef0123456789"),
  // Labels at the cap on every card, so the linear-growth assertion measures
  // the shell's worst per-card case (t3o-06a).
  labels: labelIdsAtCap,
  stage: BOARD_SEED_STAGE_IDS.building,
  pullRequest: null,
  pullRequestHistory: [],
  pullRequestFloor: null,
  reviewOverrides: null,
  orderKey: "mmmm",
  title: `A realistically sized card title for card number ${index}`,
  briefRef: "brief",
  dependsOn: [],
  parentCardId: null,
  sourcePlanId: null,
  threadLinks: [
    {
      threadId: ThreadId.make(`thread-${index}-4e5f-6789-abcd-ef0123456789`),
      role: "build",
      linkedAt: "2026-01-01T00:00:00.000Z",
      tombstonedAt: null,
    },
  ],
  externalRef: null,
  worktree: null,
  blocked: false,
  humanInLoop: null,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const snapshotWithCards = (count: number): typeof OrchestrationShellSnapshot.Type => ({
  snapshotSequence: count,
  projects: [],
  threads: [],
  cards: Array.from({ length: count }, (_, index) =>
    boardCardShellFromCard(typicalCard(index + 1)),
  ),
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("BoardCardShell payload discipline", () => {
  it("stays under the fixed serialized byte budget at full population", () => {
    const bytes = utf8Bytes(encodeShell(fullyPopulatedShell));
    expect(bytes).toBeLessThanOrEqual(BOARD_CARD_SHELL_BYTE_BUDGET);
  });

  it("serializes to scalars plus the one bounded labelIds array — nothing else", () => {
    // The structural form of the D7 promise: nothing unbounded can hide in
    // a field whose every value is a primitive or null. t3o-06a adds exactly
    // one array — `labelIds` — and it is bounded at `BOARD_CARD_LABELS_MAX`
    // and holds only strings; everything else stays scalar.
    const encoded = encodeShell(fullyPopulatedShell) as Record<string, unknown>;
    for (const [field, value] of Object.entries(encoded)) {
      if (field === "labelIds") {
        expect(Array.isArray(value)).toBe(true);
        const ids = value as unknown[];
        expect(ids.length).toBeLessThanOrEqual(BOARD_CARD_LABELS_MAX);
        for (const id of ids) expect(typeof id).toBe("string");
        continue;
      }
      expect(
        value === null || ["string", "number", "boolean"].includes(typeof value),
        `field ${field} must be a scalar`,
      ).toBe(true);
    }
  });

  it("grows the shell snapshot linearly and modestly with card count", () => {
    const bytesAt10 = utf8Bytes(encodeSnapshot(snapshotWithCards(10)));
    const bytesAt1000 = utf8Bytes(encodeSnapshot(snapshotWithCards(1000)));

    // Per-card cost at 1,000 cards must not exceed the per-card budget…
    expect(bytesAt1000 / 1000).toBeLessThanOrEqual(BOARD_CARD_SHELL_BYTE_BUDGET);
    // …and must not exceed the per-card cost at 10 cards by more than the
    // key-length jitter of larger indices — i.e. growth is linear, not
    // super-linear.
    expect(bytesAt1000).toBeLessThanOrEqual((bytesAt10 / 10) * 1000 * 1.05);
  });
});

describe("label name payload discipline (t3o-06a)", () => {
  const decodeName = Schema.decodeUnknownSync(BoardLabelName);

  it("accepts a name at the length cap and rejects one past it", () => {
    expect(decodeName("x".repeat(BOARD_LABEL_NAME_MAX_LENGTH))).toHaveLength(
      BOARD_LABEL_NAME_MAX_LENGTH,
    );
    // The catalogue rides every shell snapshot; an unbounded name would bloat
    // it, so an over-long name is rejected at decode.
    expect(() => decodeName("x".repeat(BOARD_LABEL_NAME_MAX_LENGTH + 1))).toThrow();
  });
});

describe("board card shell derivation", () => {
  it("boardCardShellFromCard produces a schema-valid shell with derived scalars", () => {
    const card = typicalCard(7);
    const shell = decodeShell(encodeShell(boardCardShellFromCard(card)));
    expect(shell.cardId).toBe(card.id);
    expect(shell.labelIds).toEqual(card.labels);
    expect(shell.dependencyCount).toBe(0);
    expect(shell.hasBrief).toBe(true);
    expect(shell.activeThreadId).toBe(card.threadLinks[0]?.threadId);
    // No thread source at hand: thread-derived fields at rest (the client
    // reducer re-derives them via activeThreadId).
    expect(shell.threadState).toBe("none");
    expect(shell.awaitingInput).toBe(false);
  });

  it("caps the shell title at the documented UTF-8 byte maximum", () => {
    const utf8Length = (value: string) => new TextEncoder().encode(value).length;
    const shell = boardCardShellFromCard({
      ...typicalCard(1),
      title: "long ".repeat(200).trim(),
    });
    expect(utf8Length(shell.title)).toBeLessThanOrEqual(BOARD_CARD_SHELL_TITLE_MAX_BYTES);
    expect(shell.title.endsWith("…")).toBe(true);
    // A title at the cap passes through untouched.
    const exact = "t".repeat(BOARD_CARD_SHELL_TITLE_MAX_BYTES);
    expect(boardCardShellFromCard({ ...typicalCard(2), title: exact }).title).toBe(exact);
  });

  it("caps multi-byte titles by encoded size and never splits a surrogate pair", () => {
    const utf8Length = (value: string) => new TextEncoder().encode(value).length;
    // 200 CJK code points ≈ 600 UTF-8 bytes; the shell must stay within the
    // byte cap, and therefore within the overall byte budget.
    const cjk = boardCardShellFromCard({ ...typicalCard(1), title: "板".repeat(200) });
    expect(utf8Length(cjk.title)).toBeLessThanOrEqual(BOARD_CARD_SHELL_TITLE_MAX_BYTES);
    expect(cjk.title.endsWith("…")).toBe(true);
    expect(
      utf8Length(encodeShell({ ...fullyPopulatedShell, title: cjk.title }).title as string),
    ).toBeLessThanOrEqual(BOARD_CARD_SHELL_TITLE_MAX_BYTES);
    // Astral code points (surrogate pairs in UTF-16) truncate on code-point
    // boundaries — the result is always well-formed.
    const emoji = boardCardShellFromCard({ ...typicalCard(2), title: "🚀".repeat(100) });
    expect(utf8Length(emoji.title)).toBeLessThanOrEqual(BOARD_CARD_SHELL_TITLE_MAX_BYTES);
    expect(emoji.title.isWellFormed()).toBe(true);
  });

  it("picks the most recently linked live thread as active", () => {
    const early = ThreadId.make("thread-early");
    const late = ThreadId.make("thread-late");
    const dead = ThreadId.make("thread-dead");
    const card = typicalCard(1);
    const shell = boardCardShellFromCard({
      ...card,
      threadLinks: [
        { threadId: late, role: "build", linkedAt: "2026-01-03T00:00:00.000Z", tombstonedAt: null },
        {
          threadId: early,
          role: "planning",
          linkedAt: "2026-01-01T00:00:00.000Z",
          tombstonedAt: null,
        },
        {
          threadId: dead,
          role: "review",
          linkedAt: "2026-01-04T00:00:00.000Z",
          tombstonedAt: "2026-01-05T00:00:00.000Z",
        },
      ],
    });
    expect(shell.activeThreadId).toBe(late);
  });

  it("derives thread state with waiting outranking working", () => {
    expect(deriveBoardCardThreadState(null).threadState).toBe("none");
    expect(
      deriveBoardCardThreadState({
        hasPendingUserInput: false,
        hasPendingApprovals: false,
        session: { status: "running" },
      }).threadState,
    ).toBe("working");
    expect(
      deriveBoardCardThreadState({
        hasPendingUserInput: true,
        hasPendingApprovals: false,
        session: { status: "running" },
      }),
    ).toEqual({ threadState: "waiting", awaitingInput: true });
    expect(
      deriveBoardCardThreadState({
        hasPendingUserInput: false,
        hasPendingApprovals: true,
        session: null,
      }),
    ).toEqual({ threadState: "waiting", awaitingInput: false });
    expect(
      deriveBoardCardThreadState({
        hasPendingUserInput: false,
        hasPendingApprovals: false,
        session: null,
      }).threadState,
    ).toBe("stopped");
    expect(
      deriveBoardCardThreadState({
        hasPendingUserInput: false,
        hasPendingApprovals: false,
        session: null,
        backgroundLiveness: "working",
      }).threadState,
    ).toBe("working");
  });

  it("makeBoardCardShell hardcodes the not-yet-sourced fields to their documented rest values", () => {
    const shell = makeBoardCardShell({
      cardId: BoardCardId.make("card-1"),
      key: "T3O-1",
      projectId: ProjectId.make("project-1"),
      labelIds: [],
      stage: BOARD_SEED_STAGE_IDS.backlog,
      orderKey: "m",
      title: "Card",
      blocked: false,
      dependencyCount: 0,
      hasBrief: false,
      activeThreadId: null,
    });
    // No `pullRequest` passed means the card has none: `hasPr` is a real
    // derived false here, not the hardcoded placeholder it used to be.
    expect(shell.hasPr).toBe(false);
    // Still-unsourced t3o-11 field.
    expect(shell.attachmentCount).toBe(0);
    // `queued` is now sourced (t3o-11) but rests at false when a producer omits
    // it — the card-carrying delta path, where step state is not in hand.
    expect(shell.queued).toBe(false);
    // `stalled` (t3o-17, D3) rests at false the same way.
    expect(shell.stalled).toBe(false);
    // post-MVP sub-boards and review pipeline: key-optional and absent, so
    // an unsourced field costs zero wire bytes per card.
    expect("planTotal" in shell).toBe(false);
    expect("planDone" in shell).toBe(false);
    // A card with no PR omits the key entirely, so a PR-less board's shell
    // payload is exactly the size it was before the field existed.
    expect("prNumber" in shell).toBe(false);
    expect("issuesOpen" in shell).toBe(false);
    // Absent-means-preserve: a producer that cannot see the brief body or the
    // plan slice omits the key rather than asserting a false/zero the client
    // would then apply as a real change.
    expect("briefHasImage" in shell).toBe(false);
    expect("planCount" in shell).toBe(false);
  });

  it("threads real body-derived fields through makeBoardCardShell", () => {
    const base = {
      cardId: BoardCardId.make("card-1"),
      key: "T3O-1",
      projectId: ProjectId.make("project-1"),
      labelIds: [],
      stage: BOARD_SEED_STAGE_IDS.planning,
      orderKey: "m",
      title: "Card",
      blocked: false,
      dependencyCount: 0,
      hasBrief: true,
      activeThreadId: null,
    } as const;
    const populated = makeBoardCardShell({ ...base, briefHasImage: true, planCount: 3 });
    expect(populated.briefHasImage).toBe(true);
    expect(populated.planCount).toBe(3);
    // `false` / `0` are REAL values, not the resting state — clearing the image
    // out of a brief has to be able to clear the card's icon.
    const cleared = makeBoardCardShell({ ...base, briefHasImage: false, planCount: 0 });
    expect(cleared.briefHasImage).toBe(false);
    expect(cleared.planCount).toBe(0);
  });

  it("sources hasPr / prNumber from the card's pull request", () => {
    const base = {
      cardId: BoardCardId.make("card-1"),
      key: "T3O-1",
      projectId: ProjectId.make("project-1"),
      labelIds: [],
      stage: BOARD_SEED_STAGE_IDS.merge,
      orderKey: "m",
      title: "Card",
      blocked: false,
      dependencyCount: 0,
      hasBrief: true,
      activeThreadId: null,
    } as const;
    const linked = makeBoardCardShell({
      ...base,
      prNumber: 284,
    });
    expect(linked.hasPr).toBe(true);
    expect(linked.prNumber).toBe(284);

    // A merged PR is still a PR: the badge keeps the number after the work
    // lands, which is what makes a Done card traceable back to its change.
    // Asserted through `boardCardShellFromCard`, the path that actually sees
    // the PR's state — `makeBoardCardShell` is given the number alone.
    const mergedShell = boardCardShellFromCard({
      ...typicalCard(9),
      pullRequest: {
        number: 284,
        url: "https://github.com/acme/repo/pull/284",
        state: "merged",
        headBranch: "t3o/T3O-9",
        baseRef: "main",
        checkedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(mergedShell.hasPr).toBe(true);
    expect(mergedShell.prNumber).toBe(284);

    // Explicit null is a real "we looked and there is none", and it clears.
    const none = makeBoardCardShell({ ...base, prNumber: null });
    expect(none.hasPr).toBe(false);
    expect("prNumber" in none).toBe(false);
  });

  it("boardCardShellFromCard carries the brief-derived flag only when it is given one", () => {
    const card = typicalCard(3);
    expect("briefHasImage" in boardCardShellFromCard(card)).toBe(false);
    expect(boardCardShellFromCard(card, undefined, { briefHasImage: true }).briefHasImage).toBe(
      true,
    );
    expect(boardCardShellFromCard(card, undefined, { briefHasImage: false }).briefHasImage).toBe(
      false,
    );
  });

  it("threads a real queued flag through makeBoardCardShell (t3o-11, D11)", () => {
    // The snapshot builder passes the value derived from step state; a queued
    // card renders its badge from this one boolean.
    const queued = makeBoardCardShell({
      cardId: BoardCardId.make("card-1"),
      key: "T3O-1",
      projectId: ProjectId.make("project-1"),
      labelIds: [],
      stage: BOARD_SEED_STAGE_IDS.building,
      orderKey: "m",
      title: "Card",
      blocked: false,
      dependencyCount: 0,
      hasBrief: false,
      activeThreadId: null,
      queued: true,
    });
    expect(queued.queued).toBe(true);
  });

  it("threads a real stalled flag through makeBoardCardShell (t3o-17, D3)", () => {
    const stalled = makeBoardCardShell({
      cardId: BoardCardId.make("card-1"),
      key: "T3O-1",
      projectId: ProjectId.make("project-1"),
      labelIds: [],
      stage: BOARD_SEED_STAGE_IDS.building,
      orderKey: "m",
      title: "Card",
      blocked: false,
      dependencyCount: 0,
      hasBrief: false,
      activeThreadId: null,
      stalled: true,
    });
    expect(stalled.stalled).toBe(true);
    // A stalled card is not, by that fact, queued (distinct step-state fields).
    expect(stalled.queued).toBe(false);
  });

  it("the queued flag keeps the shell within the fixed budget (t3o-11, D11)", () => {
    // The worst-case shell already carries `queued: true` (a single boolean),
    // so wiring the work queue keeps the shell scalar-plus-one-array and within
    // the byte budget — queue *position* is derived client-side, never on the
    // wire. Both truth values stay comfortably under the ceiling.
    expect(fullyPopulatedShell.queued).toBe(true);
    expect(utf8Bytes(encodeShell(fullyPopulatedShell))).toBeLessThanOrEqual(
      BOARD_CARD_SHELL_BYTE_BUDGET,
    );
    expect(utf8Bytes(encodeShell({ ...fullyPopulatedShell, queued: false }))).toBeLessThanOrEqual(
      BOARD_CARD_SHELL_BYTE_BUDGET,
    );
  });
});

describe("dependency gating across the archive (t3o-13)", () => {
  const dependency = (
    id: string,
    stage: BoardCard["stage"],
    archivedAt: string | null,
  ): Pick<BoardCard, "id" | "stage" | "archivedAt"> => ({
    id: BoardCardId.make(id),
    stage,
    archivedAt,
  });

  const cards = [
    dependency("live-open", BOARD_SEED_STAGE_IDS.building, null),
    dependency("live-done", BOARD_SEED_STAGE_IDS.done, null),
    dependency("archived-open", BOARD_SEED_STAGE_IDS.building, "2026-01-01T00:00:00.000Z"),
    dependency("archived-done", BOARD_SEED_STAGE_IDS.done, "2026-01-01T00:00:00.000Z"),
  ];

  const unmetOf = (...ids: ReadonlyArray<string>) =>
    unmetBoardCardDependencies({
      board: EMPTY_BOARD_STATE,
      dependsOn: ids.map((id) => BoardCardId.make(id)),
      cards,
    });

  it("counts a live, unfinished dependency as unmet", () => {
    expect(unmetOf("live-open")).toEqual([BoardCardId.make("live-open")]);
  });

  it("counts a finished dependency as met", () => {
    expect(unmetOf("live-done")).toEqual([]);
  });

  it("stops gating on an archived dependency, finished or not", () => {
    // The whole point of t3o-13: archiving unfinished work must not deadlock
    // everything that was waiting on it.
    expect(unmetOf("archived-open")).toEqual([]);
    expect(unmetOf("archived-done")).toEqual([]);
  });

  it("still counts an id with no card at all as unmet", () => {
    expect(unmetOf("gone")).toEqual([BoardCardId.make("gone")]);
  });

  it("blocks only at the build role and beyond, and only on a live unfinished dependency", () => {
    const blockedAt = (stage: BoardCard["stage"], dependsOn: ReadonlyArray<string>) =>
      deriveBoardCardBlocked({
        board: EMPTY_BOARD_STATE,
        stage,
        dependsOn: dependsOn.map((id) => BoardCardId.make(id)),
        cards,
      });

    // Before the build role nothing blocks; ready sits before `building`.
    expect(blockedAt(BOARD_SEED_STAGE_IDS.backlog, ["live-open"])).toBe(false);
    expect(blockedAt(BOARD_SEED_STAGE_IDS.ready, ["live-open"])).toBe(false);
    // At the build role and beyond, a live unfinished dependency blocks; an
    // archived one never does.
    expect(blockedAt(BOARD_SEED_STAGE_IDS.building, ["live-open"])).toBe(true);
    expect(blockedAt(BOARD_SEED_STAGE_IDS.building, ["archived-open"])).toBe(false);
    expect(blockedAt(BOARD_SEED_STAGE_IDS.review, ["archived-open", "live-open"])).toBe(true);
  });
});

describe("archive confirmation (t3o-13, D3)", () => {
  const dependent = (id: string, archivedAt: string | null) => ({
    cardId: BoardCardId.make(id),
    key: `T3O-${id}`,
    title: `Card ${id}`,
    stage: BOARD_SEED_STAGE_IDS.building,
    archivedAt,
  });

  const live = dependent("1", null);
  const archived = dependent("2", "2026-01-01T00:00:00.000Z");

  it("counts only live dependents", () => {
    expect(liveBoardCardDependents([live, archived])).toEqual([live]);
  });

  it("asks before archiving an unfinished card that live cards depend on", () => {
    expect(
      boardCardArchiveNeedsConfirmation({
        stage: BOARD_SEED_STAGE_IDS.building,
        dependents: [live],
      }),
    ).toBe(true);
  });

  it("does not ask when the card is done — done already satisfies the gate", () => {
    expect(
      boardCardArchiveNeedsConfirmation({ stage: BOARD_SEED_STAGE_IDS.done, dependents: [live] }),
    ).toBe(false);
  });

  it("does not ask when nothing live depends on the card", () => {
    expect(
      boardCardArchiveNeedsConfirmation({ stage: BOARD_SEED_STAGE_IDS.building, dependents: [] }),
    ).toBe(false);
    expect(
      boardCardArchiveNeedsConfirmation({
        stage: BOARD_SEED_STAGE_IDS.building,
        dependents: [archived],
      }),
    ).toBe(false);
  });
});

describe("thread todo summary (t3o-18, D4)", () => {
  it("caps stored pips at BOARD_THREAD_TODO_ITEMS_MAX while the counts stay true", () => {
    const plan = Array.from({ length: 47 }, (_, index) => ({
      step: `Item ${index}`,
      status: index < 2 ? ("completed" as const) : ("pending" as const),
    }));
    const summary = boardThreadTodoSummary(plan);
    expect(summary.statuses.length).toBe(BOARD_THREAD_TODO_ITEMS_MAX);
    // The counts are the TRUE ones, before capping — `2/47` stays honest even
    // when only 30 pips are stored.
    expect(summary.doneCount).toBe(2);
    expect(summary.totalCount).toBe(47);
  });

  it("renders out-of-order completion in TRUE positions, not a tidy fiction", () => {
    const summary = boardThreadTodoSummary([
      { step: "One", status: "pending" },
      { step: "Two", status: "completed" },
      { step: "Three", status: "inProgress" },
      { step: "Four", status: "completed" },
    ]);
    // Deriving from (done, total, hasDoing) would print `ddip`; the real list is
    // `pdid`, and an agent that finishes item 4 before item 1 must not be lied
    // about.
    expect(summary.statuses).toBe("pdid");
    expect(summary.currentText).toBe("Three");
  });

  it("truncates the in-progress text on code-point boundaries", () => {
    const long = "🙂".repeat(200);
    const summary = boardThreadTodoSummary([{ step: long, status: "inProgress" }]);
    const bytes = new TextEncoder().encode(summary.currentText ?? "").length;
    expect(bytes).toBeLessThanOrEqual(BOARD_THREAD_TODO_CURRENT_MAX_BYTES);
    // No lone surrogate survived the cut.
    expect(summary.currentText ?? "").toBe([...(summary.currentText ?? "")].join(""));
  });

  it("calls a list complete only when it has items and all of them are done", () => {
    expect(boardThreadTodosComplete({ todoDone: 5, todoTotal: 5 })).toBe(true);
    expect(boardThreadTodosComplete({ todoDone: 4, todoTotal: 5 })).toBe(false);
    // An absent list is not a complete one.
    expect(boardThreadTodosComplete({})).toBe(false);
  });
});

describe("deriveBoardCardThreadState aggregates across live threads (t3o-18, D7)", () => {
  const idle = { hasPendingUserInput: false, hasPendingApprovals: false, session: null };
  const waiting = { hasPendingUserInput: true, hasPendingApprovals: false, session: null };
  const working = {
    hasPendingUserInput: false,
    hasPendingApprovals: false,
    session: { status: "running" },
  };

  it("AC 8: a card whose OLDER linked thread awaits input still shows Input needed", () => {
    // The older thread is first; `activeThreadId` would have picked the last.
    const state = deriveBoardCardThreadState([waiting, idle]);
    expect(state.awaitingInput).toBe(true);
    expect(state.threadState).toBe("waiting");
  });

  it("AC 9: a card whose NON-active linked thread is running shows the running dot", () => {
    expect(deriveBoardCardThreadState([working, idle]).threadState).toBe("working");
  });

  it("keeps waiting above working, lifted from one thread to N", () => {
    expect(deriveBoardCardThreadState([working, waiting]).threadState).toBe("waiting");
    expect(deriveBoardCardThreadState([idle, idle]).threadState).toBe("stopped");
    expect(deriveBoardCardThreadState([]).threadState).toBe("none");
    expect(deriveBoardCardThreadState([undefined, null]).threadState).toBe("none");
  });

  it("still accepts a single thread, so every pre-t3o-18 caller is unchanged", () => {
    expect(deriveBoardCardThreadState(waiting).threadState).toBe("waiting");
    expect(deriveBoardCardThreadState(null).threadState).toBe("none");
  });
});

describe("BoardCardStepState decoding (t3o-19 D7)", () => {
  // The event log is replayed through `Schema.decodeUnknownEffect`, so a
  // `board.card-step-selected` payload written before t3o-19 — which has no
  // `stageLabel` KEY at all — must still decode. A required-but-nullable field
  // would reject it, and D7's "replay equals rehydration" would hold for the
  // projection tables while silently breaking for the log.
  const legacyPayload = {
    cardId: "card-1",
    stepId: "building",
    stepLabel: "Building",
    attempt: 1,
    stallCount: 0,
    lastNudgeAt: null,
    prompt: "Implement the brief.",
    providerInstanceId: "codex",
    model: "gpt-5-codex",
    mode: "build",
    humanInLoop: false,
    maxAttempts: 3,
    timeoutMs: 600_000,
    threadId: null,
    status: "pending",
    slotHeld: false,
    startedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("decodes a pre-t3o-19 payload that carries no stageLabel key", () => {
    const decoded = Schema.decodeUnknownSync(BoardCardStepState)(legacyPayload);
    expect(decoded.stageLabel).toBe(null);
    expect(decoded.stepLabel).toBe("Building");
  });

  it("decodes a pre-t3o-24 payload that carries no baseTipAtRoundStart key (AC7)", () => {
    // Same replay reason: an event written before t3o-24 has no key, and a
    // null already MEANS "no tip recorded — not stale".
    const decoded = Schema.decodeUnknownSync(BoardCardStepState)(legacyPayload);
    expect(decoded.baseTipAtRoundStart).toBe(null);
    const recorded = Schema.decodeUnknownSync(BoardCardStepState)({
      ...legacyPayload,
      baseTipAtRoundStart: "sha-round-start",
    });
    expect(recorded.baseTipAtRoundStart).toBe("sha-round-start");
  });

  it("still decodes a post-t3o-19 payload, stepped or unstepped", () => {
    const unstepped = Schema.decodeUnknownSync(BoardCardStepState)({
      ...legacyPayload,
      stepLabel: null,
      stageLabel: "Planning",
    });
    expect(unstepped.stepLabel).toBe(null);
    expect(unstepped.stageLabel).toBe("Planning");

    const stepped = Schema.decodeUnknownSync(BoardCardStepState)({
      ...legacyPayload,
      stepId: "review@1",
      stepLabel: "Review · round 1",
      stageLabel: "Code review",
    });
    expect(stepped.stepLabel).toBe("Review · round 1");
  });
});

describe("sub-boards (t3o-23)", () => {
  const NOW = "2026-01-01T00:00:00.000Z";
  const parent = { ...typicalCard(1), id: BoardCardId.make("card-parent") };
  const child = (id: string, stage: BoardCard["stage"], archivedAt: string | null = null) => ({
    ...typicalCard(2),
    id: BoardCardId.make(id),
    stage,
    archivedAt,
    parentCardId: parent.id,
  });
  const boardWith = (cards: ReadonlyArray<BoardCard>) => ({ ...EMPTY_BOARD_STATE, cards });

  it("resolves the materialisation floor to the stage before the build role", () => {
    expect(boardSubBoardFloorStage(EMPTY_BOARD_STATE)?.stageId).toBe(BOARD_SEED_STAGE_IDS.ready);
    // Build first: no floor.
    const buildFirst = {
      ...EMPTY_BOARD_STATE,
      stages: BOARD_SEED_STAGES.filter(
        (stage) => stage.role === "build" || stage.role === "review" || stage.role === "done",
      ),
    };
    expect(boardSubBoardFloorStage(buildFirst)).toBe(null);
    // With no floor the restriction falls back to build-onward.
    expect(isBoardStageAtOrAfterSubBoardFloor(buildFirst, BOARD_SEED_STAGE_IDS.building)).toBe(
      true,
    );
  });

  it("opens the floor and everything after it to plan cards, and nothing before", () => {
    expect(isBoardStageAtOrAfterSubBoardFloor(EMPTY_BOARD_STATE, BOARD_SEED_STAGE_IDS.ready)).toBe(
      true,
    );
    expect(isBoardStageAtOrAfterSubBoardFloor(EMPTY_BOARD_STATE, BOARD_SEED_STAGE_IDS.done)).toBe(
      true,
    );
    expect(
      isBoardStageAtOrAfterSubBoardFloor(EMPTY_BOARD_STATE, BOARD_SEED_STAGE_IDS.planning),
    ).toBe(false);
  });

  it("counts an archived child as finished, a done child as finished, and nothing else", () => {
    const board = boardWith([
      parent,
      child("child-building", BOARD_SEED_STAGE_IDS.building),
      child("child-done", BOARD_SEED_STAGE_IDS.done),
      child("child-archived", BOARD_SEED_STAGE_IDS.building, NOW),
    ]);
    expect(boardCardUnfinishedChildren(board, parent.id).map((card) => String(card.id))).toEqual([
      "child-building",
    ]);
  });

  it("derives plan progress from shells, counting only done-role children", () => {
    const shells = [
      { cardId: BoardCardId.make("card-parent"), stage: BOARD_SEED_STAGE_IDS.building },
      {
        cardId: BoardCardId.make("child-a"),
        stage: BOARD_SEED_STAGE_IDS.done,
        parentCardId: BoardCardId.make("card-parent"),
      },
      {
        cardId: BoardCardId.make("child-b"),
        stage: BOARD_SEED_STAGE_IDS.building,
        parentCardId: BoardCardId.make("card-parent"),
      },
      // A childless top-level card produces no entry at all.
      { cardId: BoardCardId.make("card-other"), stage: BOARD_SEED_STAGE_IDS.done },
    ];
    const progress = deriveBoardCardPlanProgress({ cards: shells, stages: BOARD_SEED_STAGES });
    // Statuses: child-a is done (`d`), child-b sits in the build-role stage —
    // started but not finished (`i`).
    expect(progress.get(BoardCardId.make("card-parent"))).toEqual({
      total: 2,
      done: 1,
      statuses: "di",
    });
    expect(progress.size).toBe(1);
  });

  it("asserts parentCardId on a child's shell and omits the key on a top-level card", () => {
    const childShell = boardCardShellFromCard(child("child-a", BOARD_SEED_STAGE_IDS.ready));
    expect(childShell.parentCardId).toBe(parent.id);
    const topLevel = boardCardShellFromCard(typicalCard(3));
    expect("parentCardId" in topLevel).toBe(false);
  });

  describe("pending split (t3o-27)", () => {
    const withPlans = (planCount: number): BoardPlan[] =>
      Array.from({ length: planCount }, (_, index) => ({
        planId: BoardPlanId.make(`card-parent::p${index}`),
        cardId: parent.id,
        title: `Plan ${index}`,
        summary: "s",
        dependsOn: [],
        ordinal: index,
        locked: false,
        createdAt: NOW,
        updatedAt: NOW,
      }));
    const boardWithPlans = (
      stage: BoardCard["stage"],
      planCount: number,
      extra: ReadonlyArray<BoardCard> = [],
    ): BoardState => ({
      ...EMPTY_BOARD_STATE,
      cards: [{ ...parent, stage }, ...extra],
      plans: withPlans(planCount),
    });

    it("is true for a top-level planning card with ≥2 plans and no children", () => {
      expect(
        boardCardPendingSplit(boardWithPlans(BOARD_SEED_STAGE_IDS.planning, 2), parent.id),
      ).toBe(true);
    });

    it("is false for a single plan, for children present, and past the build stage", () => {
      expect(
        boardCardPendingSplit(boardWithPlans(BOARD_SEED_STAGE_IDS.planning, 1), parent.id),
      ).toBe(false);
      expect(
        boardCardPendingSplit(
          boardWithPlans(BOARD_SEED_STAGE_IDS.planning, 2, [
            child("child-a", BOARD_SEED_STAGE_IDS.ready),
          ]),
          parent.id,
        ),
      ).toBe(false);
      // A card built as one that already reached review carries stale plans
      // but is not retroactively pinned.
      expect(boardCardPendingSplit(boardWithPlans(BOARD_SEED_STAGE_IDS.review, 2), parent.id)).toBe(
        false,
      );
    });

    it("pends again when the first round's children are ALL archived (second-round split)", () => {
      // Matches the re-approval guard's live-children semantics — and the
      // shell derivation, which only ever sees live children, agrees.
      expect(
        boardCardPendingSplit(
          boardWithPlans(BOARD_SEED_STAGE_IDS.planning, 2, [
            child("child-a", BOARD_SEED_STAGE_IDS.done, NOW),
          ]),
          parent.id,
        ),
      ).toBe(true);
    });

    it("never pends on a board with no materialisation floor", () => {
      // Build-first board: approval itself is refused there, so pinning a
      // card toward it would be a dead end.
      const buildFirst: BoardState = {
        ...boardWithPlans(BOARD_SEED_STAGE_IDS.building, 2),
        stages: BOARD_SEED_STAGES.filter(
          (stage) => stage.role === "build" || stage.role === "review" || stage.role === "done",
        ),
      };
      expect(boardCardPendingSplit(buildFirst, parent.id)).toBe(false);
      expect(
        boardCardShellPendingSplit(
          { stage: BOARD_SEED_STAGE_IDS.building, planCount: 2 },
          buildFirst.stages ?? [],
        ),
      ).toBe(false);
    });

    it("derives the same from the shell, and never for a child card", () => {
      expect(
        boardCardShellPendingSplit(
          { stage: BOARD_SEED_STAGE_IDS.planning, planCount: 2 },
          BOARD_SEED_STAGES,
        ),
      ).toBe(true);
      // A child (parentCardId set) or a parent-with-children (planTotal set) is
      // never pending.
      expect(
        boardCardShellPendingSplit(
          { stage: BOARD_SEED_STAGE_IDS.planning, planCount: 2, parentCardId: parent.id },
          BOARD_SEED_STAGES,
        ),
      ).toBe(false);
      expect(
        boardCardShellPendingSplit(
          { stage: BOARD_SEED_STAGE_IDS.planning, planCount: 2, planTotal: 2 },
          BOARD_SEED_STAGES,
        ),
      ).toBe(false);
    });
  });
});
