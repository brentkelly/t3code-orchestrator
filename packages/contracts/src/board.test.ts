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
  boardCardAutoStartDue,
  boardCardCanArmAutoStart,
  boardStageBeforeBuild,
  boardModelSelectionOfOverride,
  isBoardCardBaseBranchShape,
  isBoardCardBaseRetargeted,
  isBoardCardScheduleDue,
  isEmptyBoardCardModelOverrides,
  resolveBoardCardEffectiveBase,
  resolveBoardCardStageModelOverride,
  BoardCardId,
  boardCardArchiveNeedsConfirmation,
  boardCardShellFromCard,
  BoardCardShell,
  BoardLabelId,
  BoardLabelName,
  boardAppendOrderKey,
  boardArrivalOrderKey,
  boardColumnOrderKeys,
  boardPrependOrderKey,
  BoardStageId,
  LEGACY_BOARD_CARD_ORDER_KEY,
  boardBuildHumanInLoopDefault,
  BOARD_ATTENTION_SETTLE_MS,
  boardCardAttention,
  boardStallIsWaiting,
  boardCardChildAttentionLabel,
  boardCardChildRunningLabel,
  deriveBoardCardChildAttention,
  deriveBoardCardChildRunning,
  isBoardCardWorking,
  isBoardConflictFixLive,
  boardSelectedStepLabel,
  reviewStepLabel,
  BOARD_REVIEW_PHASE_IDS,
  BOARD_CONFLICT_STEP_LABEL,
  BOARD_STEP_STATUSES,
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
import type { BoardCardWorktree } from "./board.ts";
import { OrchestrationShellSnapshot } from "./orchestration.ts";
import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

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
 *
 * T3O-19 raised it to 1344 for the ONE case that argument does not cover: a
 * key-optional field that no ordinary card carries. `scheduledStartAt` costs a
 * scheduled card ~45 bytes and every other card exactly zero (asserted below,
 * and by the linear-growth test, which measures unscheduled cards — the real
 * per-card cost on reconnect, and unchanged). The ceiling moved only for a
 * worst case that cannot actually occur: a card cannot be scheduled and running
 * and queued and mid-review-round at the same instant.
 */
const BOARD_CARD_SHELL_BYTE_BUDGET = 1344;

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
  stepAwaiting: "stopped",
  stepConflictFix: true,
  held: true,
  threadState: "waiting",
  awaitingInput: true,
  activeThreadId: ThreadId.make("thread-0b8a2c3d-4e5f-6789-abcd-ef0123456789"),
  briefHasImage: true,
  planCount: 24,
  planTotal: 24,
  planDone: 12,
  prNumber: 48213,
  // Populated (T3O-19, D8): the budget is measured against a card that IS
  // scheduled, so the field is proven to fit in the worst case rather than
  // only in the absent-key case every unscheduled card sends.
  scheduledStartAt: "2026-01-01T00:00:00.000Z",
  // Populated (T3O-24, D8) for the same reason: the budget is measured against
  // a card that IS armed, not only against the absent-key case.
  autoStart: true,
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
  modelOverrides: null,
  splitRationale: null,
  baseBranch: null,
  scheduledStartAt: null,
  autoStart: false,
  orderKey: "mmmm",
  title: `A realistically sized card title for card number ${index}`,
  briefRef: "brief",
  dependsOn: [],
  parentCardId: null,
  sourcePlanId: null,
  attachments: [],
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

  it("costs an unscheduled card nothing and carries a scheduled card's instant (T3O-19, D8)", () => {
    // D8's whole argument: the shell is under a per-card budget and the
    // snapshot grows linearly with card count, so the COMMON card — the one
    // that is not scheduled — must be byte-for-byte what it was before this
    // field existed.
    const unscheduled = encodeShell(boardCardShellFromCard(typicalCard(1))) as Record<
      string,
      unknown
    >;
    expect("scheduledStartAt" in unscheduled).toBe(false);

    const scheduled = boardCardShellFromCard({
      ...typicalCard(1),
      scheduledStartAt: "2026-03-04T09:00:00.000Z",
    });
    expect(scheduled.scheduledStartAt).toBe("2026-03-04T09:00:00.000Z");
    // On the card aggregate, so it rides every card-carrying delta and survives
    // an encode/decode round trip rather than needing a dedicated delta.
    expect(decodeShell(encodeShell(scheduled)).scheduledStartAt).toBe("2026-03-04T09:00:00.000Z");
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

describe("isBoardCardScheduleDue (T3O-19, D1)", () => {
  const now = Date.parse("2026-03-04T09:00:00.000Z");

  it("treats an unscheduled card as always due", () => {
    expect(isBoardCardScheduleDue(null, now)).toBe(true);
    expect(isBoardCardScheduleDue(undefined, now)).toBe(true);
  });

  it("withholds a future card and admits one at or past its instant", () => {
    expect(isBoardCardScheduleDue("2026-03-04T09:00:01.000Z", now)).toBe(false);
    expect(isBoardCardScheduleDue("2026-03-04T09:00:00.000Z", now)).toBe(true);
    // A past time means "now" (D6): the picker refuses none, and a card that
    // missed its moment while the server was down catches up.
    expect(isBoardCardScheduleDue("2020-01-01T00:00:00.000Z", now)).toBe(true);
  });

  it("fails in the direction that moves the card", () => {
    expect(isBoardCardScheduleDue("not an instant", now)).toBe(true);
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
    // `stepConflictFix` (T3O-9) rests at false the same way: a card-carrying
    // delta cannot see the step row, so it must not assert "no conflict".
    expect(shell.stepConflictFix).toBe(false);
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

  it("threads a real conflict-fix flag through makeBoardCardShell (T3O-9)", () => {
    const fixing = makeBoardCardShell({
      cardId: BoardCardId.make("card-1"),
      key: "T3O-1",
      projectId: ProjectId.make("project-1"),
      labelIds: [],
      stage: BOARD_SEED_STAGE_IDS.merge,
      orderKey: "m",
      title: "Card",
      blocked: false,
      dependencyCount: 0,
      hasBrief: false,
      activeThreadId: null,
      stepConflictFix: true,
    });
    expect(fixing.stepConflictFix).toBe(true);
    // The flag says WHAT the step is, never how it is doing — the running /
    // queued / stalled flags keep their own jobs and the renderer composes them.
    expect(fixing.stepRunning).toBe(false);
    expect(fixing.queued).toBe(false);
    expect(fixing.stalled).toBe(false);
  });

  it("the conflict-fix flag keeps the shell within the fixed budget (T3O-9)", () => {
    expect(fullyPopulatedShell.stepConflictFix).toBe(true);
    expect(utf8Bytes(encodeShell(fullyPopulatedShell))).toBeLessThanOrEqual(
      BOARD_CARD_SHELL_BYTE_BUDGET,
    );
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

  // ── A dead thread is not an idle one (t3o-10, D5) ────────────────────
  //
  // A server restart marks every orphaned session `error`. Read as "not
  // running", that was indistinguishable from a thread resting between turns,
  // so nothing on the card could contradict the board's claim to be working.
  const failed = {
    hasPendingUserInput: false,
    hasPendingApprovals: false,
    session: { status: "error" },
  };

  it("AC 11: a card whose only live thread errored derives `failed`, not `stopped`", () => {
    expect(deriveBoardCardThreadState(failed)).toEqual({
      threadState: "failed",
      awaitingInput: false,
    });
  });

  it("AC 12: one live thread outranks a dead sibling, and a human gate outranks both", () => {
    expect(deriveBoardCardThreadState([failed, working]).threadState).toBe("working");
    expect(deriveBoardCardThreadState([failed, waiting]).threadState).toBe("waiting");
    // An idle thread is not evidence of life, so the failure still shows.
    expect(deriveBoardCardThreadState([failed, idle]).threadState).toBe("failed");
  });

  it("a failed session outranks lingering background liveness, as the thread list ranks it", () => {
    expect(
      deriveBoardCardThreadState({
        hasPendingUserInput: false,
        hasPendingApprovals: false,
        session: { status: "error" },
        backgroundLiveness: "working",
      }).threadState,
    ).toBe("failed");
  });

  it("awaitingInput is untouched by the new state", () => {
    expect(deriveBoardCardThreadState(failed).awaitingInput).toBe(false);
    expect(deriveBoardCardThreadState([failed, waiting]).awaitingInput).toBe(true);
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

describe("per-card model overrides (t3o-29)", () => {
  const build = BOARD_SEED_STAGE_IDS.building;
  const review = BOARD_SEED_STAGE_IDS.review;
  const opus = { instanceId: ProviderInstanceId.make("anthropic"), model: "claude-opus-5" };
  const haiku = { instanceId: ProviderInstanceId.make("anthropic"), model: "claude-haiku-4-5" };

  // AC8 (the pre-t3o-29 payload decoding to null) lives in
  // `boardReviewLoop.test.ts`, alongside the identical t3o-22 assertion and the
  // legacy card fixture both share.
  it("an empty map overrides nothing, exactly as null does", () => {
    expect(isEmptyBoardCardModelOverrides(null)).toBe(true);
    expect(isEmptyBoardCardModelOverrides({})).toBe(true);
    expect(isEmptyBoardCardModelOverrides({ [build]: opus })).toBe(false);
  });

  it("resolves the card's own override ahead of its parent's", () => {
    expect(
      resolveBoardCardStageModelOverride({
        card: { modelOverrides: { [build]: opus } },
        parent: { modelOverrides: { [build]: haiku } },
        stageId: build,
      }),
    ).toEqual(opus);
  });

  it("AC4: a child with no override of its own resolves its parent's", () => {
    expect(
      resolveBoardCardStageModelOverride({
        card: { modelOverrides: null },
        parent: { modelOverrides: { [build]: haiku } },
        stageId: build,
      }),
    ).toEqual(haiku);
  });

  it("resolves per stage, so a parent's Build override never leaks into Review", () => {
    expect(
      resolveBoardCardStageModelOverride({
        card: { modelOverrides: null },
        parent: { modelOverrides: { [build]: haiku } },
        stageId: review,
      }),
    ).toBeNull();
  });

  it("resolves null for a top-level card that overrides nothing", () => {
    expect(
      resolveBoardCardStageModelOverride({
        card: { modelOverrides: null },
        parent: null,
        stageId: build,
      }),
    ).toBeNull();
  });

  it("narrows an override to its model half, dropping the access level", () => {
    // The access level rides the override but is NOT part of the model
    // selection the spawn carries; conflating them would put a runtimeMode key
    // into a BoardModelSelection that no decoder expects.
    expect(boardModelSelectionOfOverride({ ...opus, runtimeMode: "approval-required" })).toEqual(
      opus,
    );
    const withOptions = { ...opus, options: [{ id: "reasoning", value: "high" }] } as const;
    expect(boardModelSelectionOfOverride(withOptions)).toEqual(withOptions);
  });
});

describe("build-stage human-in-the-loop default (t3o-15 D6, sub-board children)", () => {
  // The shipped defaults: a plan-less card pauses for a human, a planned one
  // runs unattended.
  const shipped = { humanInLoopWithPlan: false, humanInLoopWithoutPlan: true };
  const topLevel = { parentCardId: null };
  const child = { parentCardId: BoardCardId.make("card-parent") };

  it("flips a top-level card's default on whether it has a plan", () => {
    expect(boardBuildHumanInLoopDefault(shipped, topLevel, false)).toBe(true);
    expect(boardBuildHumanInLoopDefault(shipped, topLevel, true)).toBe(false);
  });

  it("reads the with-plan default for a sub-board child that owns no plan row", () => {
    // Materialisation made the child's plan its brief; it has no plan of its
    // own, and the plan-less pause must not park the cascade (t3o-28, D3).
    expect(boardBuildHumanInLoopDefault(shipped, child, false)).toBe(false);
    expect(boardBuildHumanInLoopDefault(shipped, child, true)).toBe(false);
  });

  it("still honours a with-plan pause the user switched on, for children too", () => {
    const pauseAll = { humanInLoopWithPlan: true, humanInLoopWithoutPlan: true };
    expect(boardBuildHumanInLoopDefault(pauseAll, child, false)).toBe(true);
    expect(boardBuildHumanInLoopDefault(pauseAll, topLevel, true)).toBe(true);
  });
});

describe("cards that need a human (boardCardAttention)", () => {
  const card = (overrides: Partial<BoardCardShell>): BoardCardShell => ({
    ...fullyPopulatedShell,
    stage: BOARD_SEED_STAGE_IDS.building,
    stalled: false,
    held: false,
    awaitingInput: false,
    stepRunning: false,
    stepAwaiting: null,
    queued: false,
    archivedAt: null,
    planCount: 0,
    // The base fixture is a split parent (it populates every field); zero the
    // child counts so the default card is an ordinary one and only the cases
    // that ask for a split get one.
    planTotal: 0,
    planDone: 0,
    ...overrides,
  });
  /** The base fixture is fully populated, review summary included — strip it
      unless the case under test is about the loop, or every card would read as
      a held review. */
  const attention = (
    overrides: Partial<BoardCardShell>,
    /** The settle-grace inputs the board page joins client-side (T3O-29).
        Omitted by every other case, which is what the production callers that
        hold no thread shells do — and means "no grace". */
    settle?: { readonly threadIdleSince?: string | null; readonly now?: number },
  ) => {
    const { reviewOutcome, reviewHeldOutcome, reviewRoundComplete, ...rest } = card(overrides);
    const shell =
      overrides.reviewOutcome === undefined
        ? rest
        : { ...rest, reviewOutcome, reviewHeldOutcome, reviewRoundComplete };
    return boardCardAttention({
      card: { ...shell, threadIdleSince: settle?.threadIdleSince },
      stages: BOARD_SEED_STAGES,
      now: settle?.now,
    });
  };

  it("ranks the reasons, loudest first", () => {
    // The ranking IS the contract: a card can satisfy several at once and the
    // face has room for one.
    // A human's own stop outranks everything (T3O-23): it is the definitive
    // statement about the card's live step, and they made it a beat ago.
    expect(
      attention({ stepAwaiting: "paused", stalled: true, held: true, awaitingInput: true })?.reason,
    ).toBe("paused");
    expect(attention({ stalled: true, held: true, awaitingInput: true })?.reason).toBe("stalled");
    expect(attention({ held: true, awaitingInput: true })?.reason).toBe("held");
    expect(attention({ awaitingInput: true })?.reason).toBe("input");
    expect(attention({})).toBeNull();
  });

  it("keeps its tones apart — a question is not a failure", () => {
    expect(attention({ stalled: true })?.tone).toBe("warning");
    expect(attention({ held: true })?.tone).toBe("warning");
    expect(attention({ awaitingInput: true })?.tone).toBe("attention");
    // Neutral, per `docs/t3o/status-colours.md`: a paused card is held by the
    // user's own instruction and nothing is waiting on an answer, so it makes
    // no claim and takes no colour.
    expect(attention({ stepAwaiting: "paused" })?.tone).toBe("neutral");
    expect(attention({ stepAwaiting: "paused" })?.label).toBe("Paused");
  });

  it("paints every reading of stalled amber, never red", () => {
    // `docs/t3o/status-colours.md` (T3O-22, D10): the vocabulary is green,
    // blue, violet and amber, and all four readings of `stalled` are the same
    // amber fact — nobody is working on this card. A usage-limit card counting
    // down to its own automatic resume rendered as an error is the case that
    // forced this: the loudest colour on the board, contradicting the chip's
    // own words.
    for (const stalledReason of [
      "usage-limit",
      "quota-exhausted",
      "waiting-retry",
      "gave-up",
    ] as const) {
      const chip = attention({ stalled: true, stalledReason });
      expect(chip?.reason).toBe("stalled");
      expect(chip?.tone).toBe("warning");
    }
  });

  it("keeps saying Paused while the card's thread is still winding down", () => {
    // Unlike the two parked-on-a-human chips, this one is NOT vetoed by the
    // working dot. Those assert "nobody is working on this card", which a blue
    // dot flatly contradicts; this asserts only that the human pressed Stop,
    // which stays true across the beat between the pause landing and the
    // interrupted turn actually ending.
    expect(attention({ stepAwaiting: "paused", threadState: "working" })?.reason).toBe("paused");
    expect(attention({ stepAwaiting: "paused", stepRunning: true })?.reason).toBe("paused");
    // …while the two it sits beside stay vetoed.
    expect(attention({ stepAwaiting: "stopped", threadState: "working" })).toBeNull();
  });

  it("never flags a finished or archived card", () => {
    // A card in Done has a settled step by definition, so without this every
    // finished card on the board would light up.
    expect(
      boardCardAttention({
        card: card({ stage: BOARD_SEED_STAGE_IDS.done, held: true, stalled: true }),
        stages: BOARD_SEED_STAGES,
      }),
    ).toBeNull();
    expect(attention({ archivedAt: "2026-01-01T00:00:00.000Z", stalled: true })).toBeNull();
  });

  it("ignores a held flag on a card sitting before the build role", () => {
    // `held` rests on the shell until the next select-step clears it, so a card
    // that ran a step and was dragged back to the backlog still carries it —
    // and a card in Ready waiting for Begin build is the resting state of the
    // whole backlog, not a card the pipeline parked.
    expect(attention({ stage: BOARD_SEED_STAGE_IDS.backlog, held: true })).toBeNull();
    expect(attention({ stage: BOARD_SEED_STAGE_IDS.ready, held: true })).toBeNull();
    // From the build role onward it means what it says.
    expect(attention({ stage: BOARD_SEED_STAGE_IDS.building, held: true })?.reason).toBe("held");
    expect(attention({ stage: BOARD_SEED_STAGE_IDS.merge, held: true })?.reason).toBe("held");
    // The other reasons are real wherever the card sits — a question asked from
    // a backlog card is still a question.
    expect(attention({ stage: BOARD_SEED_STAGE_IDS.backlog, awaitingInput: true })?.reason).toBe(
      "input",
    );
    expect(attention({ stage: BOARD_SEED_STAGE_IDS.backlog, stalled: true })?.reason).toBe(
      "stalled",
    );
  });

  it("never parks a split parent that is building through its children", () => {
    // The parent keeps its planning step's terminal row for the whole split —
    // `beginStageRun` refuses to start a run for it until the last child
    // finishes — so `held` alone would flag it "Needs a human" for the entire
    // build, when the split is exactly what is making progress.
    expect(attention({ held: true, planTotal: 3, planDone: 1 })).toBeNull();
    expect(attention({ held: true, planTotal: 3, planDone: 0 })).toBeNull();
    // Once every child is done the counts converge and a parked parent flags
    // normally — at that point nothing else is going to move it.
    expect(attention({ held: true, planTotal: 3, planDone: 3 })?.reason).toBe("held");
    // A card that is not a split parent is unaffected.
    expect(attention({ held: true, planTotal: 0 })?.reason).toBe("held");
  });

  it("lets a stuck child's roll-up reach a parent that is mid-split", () => {
    // The regression this pairs with: an own reason outranks an inherited one
    // in the renderer, so a parent that self-flagged `held` would permanently
    // shadow the roll-up of a genuinely stuck child.
    const parent = card({
      cardId: BoardCardId.make("card-parent"),
      held: true,
      planTotal: 2,
      planDone: 0,
    });
    const stuck = {
      ...card({ stalled: true }),
      cardId: BoardCardId.make("c1"),
      parentCardId: parent.cardId,
    };
    expect(boardCardAttention({ card: parent, stages: BOARD_SEED_STAGES })).toBeNull();
    expect(
      deriveBoardCardChildAttention({ cards: [parent, stuck], stages: BOARD_SEED_STAGES }).get(
        parent.cardId,
      )?.reason,
    ).toBe("stalled");
  });

  it("treats a held flag as stale while the step is live again", () => {
    // `held` rests on the shell until the next select-step clears it, and the
    // snapshot can arrive mid-flight.
    expect(attention({ held: true, stepRunning: true })).toBeNull();
    expect(attention({ held: true, queued: true })).toBeNull();
  });

  // t3o-34 D4: a step parked on a human is a card-face fact. Before this the
  // card only learned about a waiting agent from the THREAD's pending question,
  // so a step parked for a question asked in prose said nothing at all.
  it("reads a step parked for a question as Input needed, in Planning as anywhere", () => {
    const asked = attention({
      stage: BOARD_SEED_STAGE_IDS.planning,
      stepAwaiting: "question",
    });
    expect(asked?.reason).toBe("input");
    expect(asked?.tone).toBe("attention");
    expect(asked?.label).toBe("Input needed");
  });

  it("reads a step that stopped without asking as Needs a human", () => {
    const stopped = attention({
      stage: BOARD_SEED_STAGE_IDS.planning,
      stepAwaiting: "stopped",
    });
    expect(stopped?.reason).toBe("stopped");
    expect(stopped?.tone).toBe("warning");
    expect(stopped?.label).toBe("Needs a human");
  });

  it("shows the ANSWERABLE fact when a card has both", () => {
    // The two are about different threads — `awaitingInput` ORs across every
    // live thread, `stepAwaiting` describes the one live step — so both can be
    // true at once. A question the human can click through and answer beats a
    // chip that says only that something stopped.
    expect(attention({ stepAwaiting: "stopped", awaitingInput: true })?.reason).toBe("input");
    // …but a stopped step with nothing answerable still gets its amber chip.
    expect(attention({ stepAwaiting: "stopped", awaitingInput: false })?.reason).toBe("stopped");
    // A stall outranks both: recovery gave up, which is louder than either.
    expect(attention({ stepAwaiting: "stopped", stalled: true })?.reason).toBe("stalled");
  });

  it("says nothing once the step is no longer parked", () => {
    expect(attention({ stepAwaiting: null })).toBeNull();
    // …and a finished card never asks for anything, whatever its flags say.
    expect(attention({ stage: BOARD_SEED_STAGE_IDS.done, stepAwaiting: "stopped" })).toBeNull();
  });

  // T3O-18: the card face showed the blue working dot and an amber "Needs a
  // human" at once, on a planning card whose agent was demonstrably mid-turn.
  it("never says a card needs a human while a thread on it is working", () => {
    // The step row parked ("the agent stopped without asking anything") and the
    // thread went back to work without the board hearing a resume signal —
    // `turn.started` is deliberately not one (t3o-34, D5), and a
    // `turn.completed` for the PREVIOUS turn can park a step a human has
    // already resumed. The row keeps saying `stopped` for the rest of the run.
    expect(attention({ stepAwaiting: "stopped", threadState: "working" })).toBeNull();
    // Same lie in the other reason: a prose question the agent has since moved
    // past is not something to answer.
    expect(attention({ stepAwaiting: "question", threadState: "working" })).toBeNull();
    // The durable half of the dot vetoes it too — whatever lights the dot.
    expect(attention({ stepAwaiting: "stopped", stepRunning: true })).toBeNull();
  });

  // T3O-29: the same lie, one branch further up. `held` was deliberately exempt
  // from the working veto — it is a claim about the STAGE, not the agent — but
  // it wears the same three words, so a build that settled and was then chatted
  // with sat there in amber beside a pulsing blue dot.
  it("never says a card needs a human while a thread on it is working, held included", () => {
    expect(attention({ held: true, threadState: "working" })).toBeNull();
    // Both halves of the dot, and both stages the chip can appear in.
    expect(attention({ held: true, stepRunning: true })).toBeNull();
    expect(
      attention({ stage: BOARD_SEED_STAGE_IDS.merge, held: true, threadState: "working" }),
    ).toBeNull();
    // A held card whose thread is merely idle still flags — the veto is
    // EVIDENCE of work, never the absence of it.
    expect(attention({ held: true, threadState: "stopped" })?.reason).toBe("held");
    expect(attention({ held: true, threadState: "failed" })?.reason).toBe("held");
    // …and the answerable question the working card was hiding is now what it
    // shows, rather than nothing at all.
    expect(attention({ held: true, threadState: "working", awaitingInput: true })?.reason).toBe(
      "input",
    );
  });

  it("still parks a step whose threads are stopped or provably dead", () => {
    // The veto is EVIDENCE of work, not the absence of it: a failed thread is
    // not working (it vetoes the dot too), so the parked step still flags.
    expect(attention({ stepAwaiting: "stopped", threadState: "failed" })?.reason).toBe("stopped");
    expect(attention({ stepAwaiting: "stopped", threadState: "stopped" })?.reason).toBe("stopped");
    expect(attention({ stepAwaiting: "stopped", threadState: "none" })?.reason).toBe("stopped");
  });

  it("never hides an answerable question behind the working dot", () => {
    // `awaitingInput` is a REAL pending question on a live thread, one click
    // from being answered — and a card can hold one while its step runs (a
    // review loop's next phase, a sibling thread). Only the step ROW's claim is
    // vetoed, never the thread's.
    expect(
      attention({ awaitingInput: true, stepRunning: true, threadState: "waiting" })?.reason,
    ).toBe("input");
  });

  // T3O-29: the second half of the same complaint — a card that stopped a beat
  // ago is not yet a card that needs a human. The turn ends, the step row parks
  // and the supervisor decides whether to resume, over several round trips that
  // do not land together, and the chip flashed amber through all of it.
  describe("the settle grace", () => {
    const idleAt = "2026-09-09T12:00:00.000Z";
    const idle = Date.parse(idleAt);
    const settle = (offsetMs: number) => ({ threadIdleSince: idleAt, now: idle + offsetMs });

    it("withholds both Needs-a-human chips until the thread has been quiet 5s", () => {
      expect(BOARD_ATTENTION_SETTLE_MS).toBe(5_000);
      for (const parked of [{ held: true }, { stepAwaiting: "stopped" as const }]) {
        expect(attention(parked, settle(0))).toBeNull();
        expect(attention(parked, settle(BOARD_ATTENTION_SETTLE_MS - 1))).toBeNull();
        // The grace is over the instant it elapses, not a tick later.
        expect(attention(parked, settle(BOARD_ATTENTION_SETTLE_MS))).not.toBeNull();
        expect(attention(parked, settle(60_000))).not.toBeNull();
      }
      expect(attention({ held: true }, settle(BOARD_ATTENTION_SETTLE_MS))?.reason).toBe("held");
      expect(
        attention({ stepAwaiting: "stopped" }, settle(BOARD_ATTENTION_SETTLE_MS))?.reason,
      ).toBe("stopped");
    });

    it("never delays a chip that is not claiming the card went quiet", () => {
      // A pending question is answerable the moment it is asked, a stall has
      // already exhausted recovery, and a pause is the human's own instruction.
      // None of them is guessing about a beat that has not finished.
      expect(attention({ awaitingInput: true }, settle(0))?.reason).toBe("input");
      expect(attention({ stepAwaiting: "question" }, settle(0))?.reason).toBe("input");
      expect(attention({ stalled: true }, settle(0))?.reason).toBe("stalled");
      expect(attention({ stepAwaiting: "paused" }, settle(0))?.reason).toBe("paused");
      // …and a graced `held` does not swallow the answerable question ranked
      // below it: the card says the thing the human can act on.
      expect(attention({ held: true, awaitingInput: true }, settle(0))?.reason).toBe("input");
    });

    it("fails open when it has no evidence the stop is fresh", () => {
      // Both halves or neither. A caller with no clock (the detail modal), a
      // card whose thread has never finished a turn, and a timestamp nothing
      // can parse all behave exactly as they did before the grace existed.
      expect(attention({ held: true })?.reason).toBe("held");
      expect(attention({ held: true }, { threadIdleSince: idleAt })?.reason).toBe("held");
      expect(attention({ held: true }, { now: idle })?.reason).toBe("held");
      expect(attention({ held: true }, { threadIdleSince: null, now: idle })?.reason).toBe("held");
      expect(attention({ held: true }, { threadIdleSince: "not a date", now: idle })?.reason).toBe(
        "held",
      );
    });

    it("applies to a parent's roll-up of its children too", () => {
      // One chip is not allowed to appear five seconds before the one it is
      // summarising.
      const parent = card({ cardId: BoardCardId.make("card-parent"), held: false });
      const child = {
        ...card({ stepAwaiting: "stopped" }),
        cardId: BoardCardId.make("c1"),
        parentCardId: parent.cardId,
        threadIdleSince: idleAt,
      };
      const rollUp = (now: number) =>
        deriveBoardCardChildAttention({
          cards: [parent, child],
          stages: BOARD_SEED_STAGES,
          now,
        }).get(parent.cardId);
      expect(rollUp(idle + 1_000)).toBeUndefined();
      expect(rollUp(idle + BOARD_ATTENTION_SETTLE_MS)?.reason).toBe("stopped");
    });
  });

  it("reads a review loop that ran out of rounds as needing a human", () => {
    const heldLoop = attention({
      stage: BOARD_SEED_STAGE_IDS.review,
      reviewOutcome: "running",
      reviewHeldOutcome: "round-cap",
      reviewRoundComplete: true,
    });
    expect(heldLoop?.reason).toBe("review-held");
    expect(heldLoop?.label).toBe("No convergence");
    // …but a loop still going is not: `running` on the wire only means the
    // ledger's rounds are accounted for.
    expect(
      attention({
        stage: BOARD_SEED_STAGE_IDS.review,
        reviewOutcome: "running",
        reviewHeldOutcome: "round-cap",
        reviewRoundComplete: true,
        stepRunning: true,
      }),
    ).toBeNull();
  });

  it("rolls the WORST child up to the parent, with a count", () => {
    const parent = card({ cardId: BoardCardId.make("card-parent") });
    const children = [
      {
        ...card({ awaitingInput: true }),
        cardId: BoardCardId.make("c1"),
        parentCardId: parent.cardId,
      },
      { ...card({ stalled: true }), cardId: BoardCardId.make("c2"), parentCardId: parent.cardId },
      { ...card({}), cardId: BoardCardId.make("c3"), parentCardId: parent.cardId },
    ];
    const rolled = deriveBoardCardChildAttention({
      cards: [parent, ...children],
      stages: BOARD_SEED_STAGES,
    }).get(parent.cardId);
    // The stall outranks the question, and the healthy child is not counted.
    expect(rolled?.reason).toBe("stalled");
    expect(rolled?.childCount).toBe(2);
    expect(boardCardChildAttentionLabel(rolled!)).toBe("2 children need you");
  });

  it("rolls nothing up for a parent whose children are all fine", () => {
    const parent = card({ cardId: BoardCardId.make("card-parent") });
    const healthy = { ...card({}), cardId: BoardCardId.make("c1"), parentCardId: parent.cardId };
    expect(
      deriveBoardCardChildAttention({
        cards: [parent, healthy],
        stages: BOARD_SEED_STAGES,
      }).size,
    ).toBe(0);
  });
});

describe("a stall the board will end by itself (boardStallIsWaiting, T3O-22)", () => {
  it("splits the four readings by whether anything is coming", () => {
    // The two the board restarts on its own clock…
    expect(boardStallIsWaiting("usage-limit")).toBe(true);
    expect(boardStallIsWaiting("waiting-retry")).toBe(true);
    // …and the two that stay put until a human acts. The modal's banner reads
    // red and "stopped" for these and amber and "waiting to resume" for the
    // pair above; before this it called a card counting down to its own resume
    // a failure.
    expect(boardStallIsWaiting("gave-up")).toBe(false);
    expect(boardStallIsWaiting("quota-exhausted")).toBe(false);
    // A card that is not stalled at all carries no reason.
    expect(boardStallIsWaiting(null)).toBe(false);
    expect(boardStallIsWaiting(undefined)).toBe(false);
  });
});

describe("children actively working (deriveBoardCardChildRunning)", () => {
  const card = (overrides: Partial<BoardCardShell>): BoardCardShell => ({
    ...fullyPopulatedShell,
    stage: BOARD_SEED_STAGE_IDS.building,
    stalled: false,
    held: false,
    awaitingInput: false,
    stepRunning: false,
    queued: false,
    threadState: "none",
    archivedAt: null,
    planCount: 0,
    planTotal: 0,
    planDone: 0,
    ...overrides,
  });
  const parentId = BoardCardId.make("card-parent");
  const child = (id: string, overrides: Partial<BoardCardShell>): BoardCardShell => ({
    ...card(overrides),
    cardId: BoardCardId.make(id),
    parentCardId: parentId,
  });

  it("reads both halves of the working dot on a child", () => {
    // A child mid-turn and a child whose step is admitted-and-running between
    // thread spawns both count — the same two signals the card face lights on.
    expect(isBoardCardWorking(card({ threadState: "working" }))).toBe(true);
    expect(isBoardCardWorking(card({ stepRunning: true, threadState: "stopped" }))).toBe(true);
    expect(isBoardCardWorking(card({ queued: true }))).toBe(false);
    expect(isBoardCardWorking(card({ stalled: true, threadState: "stopped" }))).toBe(false);
  });

  it("AC 13: a dead thread vetoes the board's claim that a step is running", () => {
    // The incident: the step row said `running` for twelve hours after the
    // thread doing it died with a server restart.
    expect(isBoardCardWorking(card({ threadState: "failed", stepRunning: true }))).toBe(false);
    // ...while the loop-stage gap this claim exists to cover is untouched.
    expect(isBoardCardWorking(card({ threadState: "stopped", stepRunning: true }))).toBe(true);
    expect(isBoardCardWorking(card({ threadState: "none", stepRunning: true }))).toBe(true);
  });

  it("AC 14: a split parent does not light for a child whose threads are all dead", () => {
    const parent = card({ cardId: parentId, planTotal: 2, planDone: 0, held: true });
    const running = deriveBoardCardChildRunning({
      cards: [
        parent,
        child("c1", { threadState: "failed", stepRunning: true }),
        child("c2", { threadState: "working" }),
      ],
    });
    expect(running.get(parentId)).toBe(1);
  });

  it("rolls a working child up to its parent, counted", () => {
    const parent = card({ cardId: parentId, planTotal: 3, planDone: 0, held: true });
    const running = deriveBoardCardChildRunning({
      cards: [
        parent,
        child("c1", { threadState: "working" }),
        child("c2", { stepRunning: true, threadState: "stopped" }),
        child("c3", { queued: true }),
      ],
    });
    // The queued child is not working, so it is not counted.
    expect(running.get(parentId)).toBe(2);
    expect(boardCardChildRunningLabel(2)).toBe("2 child threads running");
    expect(boardCardChildRunningLabel(1)).toBe("1 child thread running");
  });

  it("rolls nothing up for a parent whose whole split is queued", () => {
    // The distinction the dot exists to make: a parent runs no step of its own
    // during a split, so with every child waiting for a slot it must stay dark.
    const parent = card({ cardId: parentId, planTotal: 2, planDone: 0, held: true });
    const running = deriveBoardCardChildRunning({
      cards: [parent, child("c1", { queued: true }), child("c2", { queued: true })],
    });
    expect(running.size).toBe(0);
  });

  it("never counts a top-level card towards anything", () => {
    // No `parentCardId`, so a working top-level card contributes to no
    // roll-up — it lights its own dot and nothing else's.
    expect(deriveBoardCardChildRunning({ cards: [card({ threadState: "working" })] }).size).toBe(0);
  });

  it("keeps each parent's count to its own children", () => {
    const otherParentId = BoardCardId.make("card-other-parent");
    const running = deriveBoardCardChildRunning({
      cards: [
        child("c1", { threadState: "working" }),
        {
          ...card({ threadState: "working" }),
          cardId: BoardCardId.make("c2"),
          parentCardId: otherParentId,
        },
      ],
    });
    expect(running.get(parentId)).toBe(1);
    expect(running.get(otherParentId)).toBe(1);
  });
});

// ── Per-card base branch (T3O-5) ────────────────────────────────────────────

describe("base branch shape (T3O-5, D5)", () => {
  it("accepts an ordinary local branch name, slashes and all", () => {
    for (const name of ["main", "develop", "release/2.4", "feat/board-mode", "v1.0"]) {
      expect(isBoardCardBaseBranchShape(name)).toBe(true);
    }
  });

  it("rejects the two shapes that would break silently downstream", () => {
    // `measureBaseTip`, `pullMergedBaseBranch` and the rebase target all
    // re-qualify a recorded base as `refs/heads/<name>`. An `origin/`-prefixed
    // or `refs/`-qualified value does not error there — it quietly measures
    // nothing, or creates a local branch literally called `origin/develop`.
    expect(isBoardCardBaseBranchShape("origin/develop")).toBe(false);
    expect(isBoardCardBaseBranchShape("refs/heads/develop")).toBe(false);
  });

  it("rejects the shapes git would not accept as a branch name either", () => {
    for (const name of ["", "   ", " develop", "develop ", "a b", "/develop", "develop/", "a..b"]) {
      expect(isBoardCardBaseBranchShape(name)).toBe(false);
    }
  });
});

describe("resolveBoardCardEffectiveBase (T3O-5, D2/D3)", () => {
  const topLevel = (baseBranch: string | null) => ({ parentCardId: null, baseBranch });

  it("AC1: a card with no pin follows the project default", () => {
    expect(
      resolveBoardCardEffectiveBase({ card: topLevel(null), cards: [], defaultBranch: "main" }),
    ).toBe("main");
  });

  it("AC2: a pinned card resolves its pin", () => {
    expect(
      resolveBoardCardEffectiveBase({
        card: topLevel("develop"),
        cards: [],
        defaultBranch: "main",
      }),
    ).toBe("develop");
  });

  it("answers null rather than inventing a branch when the default is unresolved", () => {
    // A client that has not loaded the project's refs yet must render nothing,
    // not a guess: the picker's value, the amber line and the reactor all read
    // this one function.
    expect(
      resolveBoardCardEffectiveBase({ card: topLevel(null), cards: [], defaultBranch: null }),
    ).toBeNull();
  });

  it("AC3: a child inherits its parent's live branch, whatever its own field says", () => {
    const parent = {
      id: BoardCardId.make("card-parent"),
      worktree: {
        branch: "board/card-parent",
        baseRefName: "main",
        path: null,
        status: "branch-only" as const,
        attempts: 1,
        lastError: null,
        reclaimBlockedReason: null,
      },
      pullRequest: null,
      pullRequestHistory: [],
    };
    expect(
      resolveBoardCardEffectiveBase({
        // Dead data by construction — the decider refuses to write it — and the
        // resolver must ignore it even so, or a stale row would silently
        // redirect a child away from its integration branch.
        card: { parentCardId: parent.id, baseBranch: "develop" },
        cards: [parent],
        defaultBranch: "main",
      }),
    ).toBe("board/card-parent");
  });
});

describe("isBoardCardBaseRetargeted (T3O-5, D14)", () => {
  const worktree = (baseRefName: string, status: BoardCardWorktree["status"] = "ready") => ({
    branch: "board/T3-1",
    baseRefName,
    path: status === "branch-only" ? null : "/tmp/wt",
    status,
    attempts: 1,
    lastError: null,
    reclaimBlockedReason: null,
  });

  it("is true when the card's stated base is not the one its branch was cut from", () => {
    expect(
      isBoardCardBaseRetargeted({
        card: { parentCardId: null, baseBranch: "develop", worktree: worktree("main") },
        cards: [],
        defaultBranch: "main",
      }),
    ).toBe(true);
  });

  it("AC19: reverting the pin clears it, with no stored flag to unset", () => {
    expect(
      isBoardCardBaseRetargeted({
        card: { parentCardId: null, baseBranch: null, worktree: worktree("main") },
        cards: [],
        defaultBranch: "main",
      }),
    ).toBe(false);
  });

  it("is false before a branch exists, and after one is reclaimed", () => {
    // Nothing is cut yet (or the ref is gone), so there is nothing to be
    // diverged FROM — a warning here would be about a rebase nobody needs.
    expect(
      isBoardCardBaseRetargeted({
        card: { parentCardId: null, baseBranch: "develop", worktree: null },
        cards: [],
        defaultBranch: "main",
      }),
    ).toBe(false);
    for (const status of ["failed", "reclaimed"] as const) {
      expect(
        isBoardCardBaseRetargeted({
          card: {
            parentCardId: null,
            baseBranch: "develop",
            worktree: worktree("main", status),
          },
          cards: [],
          defaultBranch: "main",
        }),
      ).toBe(false);
    }
  });

  it("an unpinned card in flight follows the project default when the project MOVES it", () => {
    // The unpinned rung is resolved live, the cut point is a snapshot, so
    // moving a project's default retargets every unpinned card that already
    // has a branch — deliberate (D2), and the reason the picker stores null for
    // the default rather than its name. Locked here because both readings look
    // reasonable in isolation: without this, "follow the default" could be
    // quietly narrowed to "the default as of provisioning" and nothing would
    // fail.
    expect(
      isBoardCardBaseRetargeted({
        card: { parentCardId: null, baseBranch: null, worktree: worktree("main") },
        cards: [],
        defaultBranch: "develop",
      }),
    ).toBe(true);
  });

  it("pinning the branch it was cut from is how a card sits out a default move", () => {
    // Same project change as above; this card expressed an opinion, so it is
    // not carried along. The pin is the documented opt-out, so it has to be a
    // real one.
    expect(
      isBoardCardBaseRetargeted({
        card: { parentCardId: null, baseBranch: "main", worktree: worktree("main") },
        cards: [],
        defaultBranch: "develop",
      }),
    ).toBe(false);
  });

  it("is false when the base cannot be resolved: staleness is measured, never assumed", () => {
    expect(
      isBoardCardBaseRetargeted({
        card: { parentCardId: null, baseBranch: null, worktree: worktree("main") },
        cards: [],
        defaultBranch: null,
      }),
    ).toBe(false);
  });
});

describe("a live merge conflict fix (isBoardConflictFixLive, T3O-9)", () => {
  const row = (
    overrides: Partial<Pick<BoardCardStepState, "stepLabel" | "status">>,
  ): Pick<BoardCardStepState, "stepLabel" | "status"> => ({
    stepLabel: BOARD_CONFLICT_STEP_LABEL,
    status: "running",
    ...overrides,
  });

  /** The whole status vocabulary, so a new status has to be classified here
      rather than silently landing on one side of the line. */
  const LIVE_STATUSES = ["pending", "queued", "running", "awaiting-input", "completing"] as const;
  const NOT_LIVE_STATUSES = ["stalled", "paused", "succeeded", "failed", "abandoned"] as const;

  it("covers every step status exactly once", () => {
    expect([...LIVE_STATUSES, ...NOT_LIVE_STATUSES].toSorted()).toEqual(
      [...BOARD_STEP_STATUSES].toSorted(),
    );
  });

  it("is live across the whole non-terminal window, queue included", () => {
    for (const status of LIVE_STATUSES) {
      expect(isBoardConflictFixLive(row({ status })), status).toBe(true);
    }
  });

  it("is not live once the step settles — or stalls, or a human pauses it", () => {
    for (const status of NOT_LIVE_STATUSES) {
      // `stalled` is excluded deliberately: it already draws the louder
      // "Stalled" chip, and two chips claiming the same card is exactly what
      // `boardCardAttention`'s ranking exists to prevent. `paused` (T3O-23) is
      // excluded for the same reason, and its chip is ranked ahead of every
      // other one.
      expect(isBoardConflictFixLive(row({ status })), status).toBe(false);
    }
  });

  it("ignores a step that is not a conflict fix, however busy it looks", () => {
    // The unarmed merge-stage re-entry conversation: a running step at the
    // merge stage with no step identity (t3o-19, D4). This is the case the old
    // `stepRunning` inference called a conflict fix.
    expect(isBoardConflictFixLive(row({ stepLabel: null }))).toBe(false);
    expect(isBoardConflictFixLive(row({ stepLabel: "review@2" }))).toBe(false);
  });
});

describe("stamping a selected step's label (boardSelectedStepLabel, T3O-9)", () => {
  it("stamps the reserved label on the armed fix, and reads back as live", () => {
    const stamped = boardSelectedStepLabel(true, null);
    expect(stamped).toBe(BOARD_CONFLICT_STEP_LABEL);
    expect(isBoardConflictFixLive({ stepLabel: stamped, status: "running" })).toBe(true);
  });

  it("passes an ordinary executor label through untouched", () => {
    expect(boardSelectedStepLabel(false, reviewStepLabel("triage", 2))).toBe("Triage · round 2");
    expect(boardSelectedStepLabel(false, null)).toBe(null);
  });

  it("takes the reserved label off a plan the reactor did not arm", () => {
    // The label is the fix's whole identity downstream — the `card-stalled`
    // delta is projected from one event and cannot reach board state to ask
    // what role the step's stage plays — so an executor naming its step
    // `Conflicts` would otherwise light the pill and disable Merge on a card
    // whose merge is not held.
    const stamped = boardSelectedStepLabel(false, BOARD_CONFLICT_STEP_LABEL);
    expect(stamped).toBe(null);
    expect(isBoardConflictFixLive({ stepLabel: stamped, status: "running" })).toBe(false);
  });

  it("is not a label today's review loop can mint", () => {
    // Pins the only executor that names steps: every phase, first rounds.
    for (const phase of [...BOARD_REVIEW_PHASE_IDS, "sync"] as const) {
      for (let round = 1; round <= 5; round += 1) {
        expect(reviewStepLabel(phase, round)).not.toBe(BOARD_CONFLICT_STEP_LABEL);
      }
    }
  });
});

describe("top-of-column order keys (T3O-15)", () => {
  const sorted = (keys: ReadonlyArray<string>) => [...keys].sort();

  it("places a card above every key in the column", () => {
    const column = ["m", "mm", "g", "zz"];
    const key = boardPrependOrderKey(column);
    expect(sorted([...column, key])[0]).toBe(key);
  });

  it("gives an empty column the same midpoint an appended card gets", () => {
    expect(boardPrependOrderKey([])).toBe(boardAppendOrderKey([]));
  });

  it("keeps prepending forever, growing a digit rather than running out", () => {
    // Done takes every finished card, so the top of that column is prepended
    // to for the life of the board: 500 arrivals must still each sort first.
    const column: string[] = ["m"];
    for (let i = 0; i < 500; i += 1) {
      const key = boardPrependOrderKey(column);
      expect(sorted([...column, key])[0]).toBe(key);
      column.push(key);
    }
    // Fractional keys, not one digit per arrival: the key grows only when the
    // digit it halves runs out of room, so 500 arrivals cost a fraction of
    // 500 digits — the same growth the client's pinned-thread prepend has.
    expect(Math.max(...column.map((key) => key.length))).toBeLessThan(column.length / 4);
  });

  it("interleaves with keys a drag left behind", () => {
    // The client bisects with `pinOrderKeyBetween` over the same alphabet, so
    // a dragged card's key is just another key to sort above.
    const key = boardPrependOrderKey(["an", "b", "mmm"]);
    expect(sorted(["an", "b", "mmm", key])[0]).toBe(key);
  });

  it("sorts under a key nothing can precede rather than failing the placement", () => {
    // Only a hand-edited row produces these; the card still lands above every
    // key that does sort, which is where the eye expects it.
    const column = ["aaa", "m", "mm"];
    const key = boardPrependOrderKey(column);
    expect(sorted([...column, key]).indexOf(key)).toBe(1);
  });
});

describe("auto-start (T3O-24)", () => {
  const NOW = "2026-01-01T00:00:00.000Z";
  const blocker = (id: string, stage: BoardCard["stage"], archivedAt: string | null = null) => ({
    ...typicalCard(9),
    id: BoardCardId.make(id),
    stage,
    archivedAt,
  });
  /** The card under test: at Ready, top-level, waiting on whatever is passed. */
  const waiting = (overrides: Partial<BoardCard> = {}): BoardCard => ({
    ...typicalCard(1),
    id: BoardCardId.make("card-waiting"),
    stage: BOARD_SEED_STAGE_IDS.ready,
    ...overrides,
  });
  const boardWith = (cards: ReadonlyArray<BoardCard>) => ({ ...EMPTY_BOARD_STATE, cards });
  const on = (card: BoardCard, ...blockers: ReadonlyArray<BoardCard>) => ({
    board: boardWith([card, ...blockers]),
    card,
  });

  describe("boardStageBeforeBuild", () => {
    it("names the stage immediately before the build role", () => {
      expect(boardStageBeforeBuild(EMPTY_BOARD_STATE)?.stageId).toBe(BOARD_SEED_STAGE_IDS.ready);
    });

    it("follows a REORDERED pipeline rather than a stage called Ready", () => {
      // Ready pushed behind Planning: the arm belongs wherever "the stage
      // before the build stage" ended up, not on the label.
      const reordered = {
        ...EMPTY_BOARD_STATE,
        stages: BOARD_SEED_STAGES.map((stage) =>
          stage.stageId === BOARD_SEED_STAGE_IDS.ready
            ? { ...stage, orderKey: "e" }
            : stage.stageId === BOARD_SEED_STAGE_IDS.planning
              ? { ...stage, orderKey: "h" }
              : stage,
        ),
      };
      expect(boardStageBeforeBuild(reordered)?.stageId).toBe(BOARD_SEED_STAGE_IDS.planning);
    });

    it("is null when the build role is the board's first stage, or absent", () => {
      const buildFirst = {
        ...EMPTY_BOARD_STATE,
        stages: BOARD_SEED_STAGES.filter(
          (stage) => stage.role === "build" || stage.role === "done",
        ),
      };
      expect(boardStageBeforeBuild(buildFirst)).toBe(null);
      const noBuild = {
        ...EMPTY_BOARD_STATE,
        stages: BOARD_SEED_STAGES.filter((stage) => stage.role !== "build"),
      };
      expect(boardStageBeforeBuild(noBuild)).toBe(null);
    });

    it("is the same stage the sub-board floor names", () => {
      // They coincide by construction; two names exist so neither reads as a
      // lie in the other's feature.
      expect(boardStageBeforeBuild(EMPTY_BOARD_STATE)?.stageId).toBe(
        boardSubBoardFloorStage(EMPTY_BOARD_STATE)?.stageId,
      );
    });
  });

  describe("boardCardCanArmAutoStart", () => {
    const open = blocker("blocker-open", BOARD_SEED_STAGE_IDS.building);
    const done = blocker("blocker-done", BOARD_SEED_STAGE_IDS.done);

    it("arms a live top-level card at Ready with an unmet dependency", () => {
      expect(boardCardCanArmAutoStart(on(waiting({ dependsOn: [open.id] }), open))).toBe(true);
    });

    it("refuses a card with nothing left to wait for", () => {
      // A control with no reverse state to reach: it would fire on the next
      // tick and be spent before the user let go of it.
      expect(boardCardCanArmAutoStart(on(waiting({ dependsOn: [done.id] }), done))).toBe(false);
      expect(boardCardCanArmAutoStart(on(waiting({ dependsOn: [] })))).toBe(false);
    });

    it("refuses a sub-board child, which already cascades", () => {
      const child = waiting({
        dependsOn: [open.id],
        parentCardId: BoardCardId.make("card-parent"),
      });
      expect(boardCardCanArmAutoStart(on(child, open))).toBe(false);
    });

    it("refuses a card at or past the build role, and one still in ideation", () => {
      for (const stage of [
        BOARD_SEED_STAGE_IDS.backlog,
        BOARD_SEED_STAGE_IDS.planning,
        BOARD_SEED_STAGE_IDS.building,
        BOARD_SEED_STAGE_IDS.review,
        BOARD_SEED_STAGE_IDS.done,
      ]) {
        expect(boardCardCanArmAutoStart(on(waiting({ dependsOn: [open.id], stage }), open))).toBe(
          false,
        );
      }
    });

    it("refuses an archived card", () => {
      expect(
        boardCardCanArmAutoStart(on(waiting({ dependsOn: [open.id], archivedAt: NOW }), open)),
      ).toBe(false);
    });
  });

  describe("boardCardAutoStartDue", () => {
    const open = blocker("blocker-open", BOARD_SEED_STAGE_IDS.building);
    const done = blocker("blocker-done", BOARD_SEED_STAGE_IDS.done);
    const archived = blocker("blocker-archived", BOARD_SEED_STAGE_IDS.building, NOW);

    it("is due once every dependency is done", () => {
      expect(
        boardCardAutoStartDue(on(waiting({ autoStart: true, dependsOn: [done.id] }), done)),
      ).toBe(true);
    });

    it("is not due while one is still outstanding", () => {
      expect(
        boardCardAutoStartDue(
          on(waiting({ autoStart: true, dependsOn: [done.id, open.id] }), done, open),
        ),
      ).toBe(false);
    });

    it("is due on an ARCHIVED dependency: archiving means the work is not happening", () => {
      // t3o-13 D1 — a gate waiting on archived work is a deadlock, not a gate,
      // so archiving the blocker fires the card exactly as finishing it would.
      expect(
        boardCardAutoStartDue(on(waiting({ autoStart: true, dependsOn: [archived.id] }), archived)),
      ).toBe(true);
    });

    it("is never due on an id with no card at all — nothing can prove it finished", () => {
      expect(
        boardCardAutoStartDue(
          on(waiting({ autoStart: true, dependsOn: [BoardCardId.make("card-gone")] })),
        ),
      ).toBe(false);
    });

    it("is never due unarmed, however met its dependencies are", () => {
      expect(boardCardAutoStartDue(on(waiting({ dependsOn: [done.id] }), done))).toBe(false);
    });

    it("is never due for a sub-board child, an archived card, or one past Ready", () => {
      const armed = { autoStart: true, dependsOn: [done.id] } as const;
      expect(
        boardCardAutoStartDue(
          on(waiting({ ...armed, parentCardId: BoardCardId.make("card-parent") }), done),
        ),
      ).toBe(false);
      expect(boardCardAutoStartDue(on(waiting({ ...armed, archivedAt: NOW }), done))).toBe(false);
      expect(
        boardCardAutoStartDue(
          on(waiting({ ...armed, stage: BOARD_SEED_STAGE_IDS.building }), done),
        ),
      ).toBe(false);
    });
  });
});

describe("board column scope and arrival placement (T3O-27)", () => {
  const sorted = (keys: ReadonlyArray<string>) => [...keys].sort();
  const stage = BoardStageId.make("building");
  const done = BoardStageId.make("done");
  const parent = BoardCardId.make("parent-1");
  const card = (input: {
    readonly stage: string;
    readonly orderKey: string;
    readonly archivedAt?: string | null;
    readonly parentCardId?: BoardCardId | null;
  }) => ({
    stage: BoardStageId.make(input.stage),
    orderKey: input.orderKey,
    archivedAt: input.archivedAt ?? null,
    parentCardId: input.parentCardId ?? null,
  });

  describe("boardColumnOrderKeys", () => {
    it("spans every project, because the default board scope merges them", () => {
      // The bug this card fixes: one key space per stage, not one per project.
      const keys = boardColumnOrderKeys({
        cards: [
          card({ stage: "building", orderKey: "n" }),
          card({ stage: "building", orderKey: "u" }),
        ],
        stage,
        parentCardId: null,
      });
      expect(sorted(keys)).toEqual(["n", "u"]);
    });

    it("holds only the named stage", () => {
      const keys = boardColumnOrderKeys({
        cards: [
          card({ stage: "building", orderKey: "n" }),
          card({ stage: "backlog", orderKey: "z" }),
        ],
        stage,
        parentCardId: null,
      });
      expect(keys).toEqual(["n"]);
    });

    it("excludes archived cards, which have left the board", () => {
      const keys = boardColumnOrderKeys({
        cards: [
          card({ stage: "building", orderKey: "n" }),
          card({ stage: "building", orderKey: "zz", archivedAt: "2026-01-01T00:00:00.000Z" }),
        ],
        stage,
        parentCardId: null,
      });
      expect(keys).toEqual(["n"]);
    });

    it("separates the root board from a parent's sub-board", () => {
      const cards = [
        card({ stage: "building", orderKey: "n" }),
        card({ stage: "building", orderKey: "u", parentCardId: parent }),
      ];
      expect(boardColumnOrderKeys({ cards, stage, parentCardId: null })).toEqual(["n"]);
      expect(boardColumnOrderKeys({ cards, stage, parentCardId: parent })).toEqual(["u"]);
    });
  });

  describe("boardArrivalOrderKey", () => {
    it("lands a card below every card in the stage, whatever project they are in", () => {
      const cards = [
        card({ stage: "building", orderKey: "n" }),
        card({ stage: "building", orderKey: "u" }),
      ];
      const key = boardArrivalOrderKey({ cards, stage, parentCardId: null, doneStageId: done });
      expect(sorted(["n", "u", key]).at(-1)).toBe(key);
    });

    it("does not let an unrelated stage push the key down", () => {
      const key = boardArrivalOrderKey({
        cards: [card({ stage: "backlog", orderKey: "zzzz" })],
        stage,
        parentCardId: null,
        doneStageId: done,
      });
      expect(key).toBe(LEGACY_BOARD_CARD_ORDER_KEY);
    });

    it("lands a card ARRIVING in the done-role stage at the top instead", () => {
      const cards = [
        card({ stage: "done", orderKey: "m" }),
        card({ stage: "done", orderKey: "u" }),
      ];
      const key = boardArrivalOrderKey({
        cards,
        stage: done,
        parentCardId: null,
        doneStageId: done,
      });
      expect(sorted(["m", "u", key])[0]).toBe(key);
    });

    it("appends when the board has no done-role stage at all", () => {
      const cards = [card({ stage: "done", orderKey: "m" })];
      const key = boardArrivalOrderKey({
        cards,
        stage: done,
        parentCardId: null,
        doneStageId: null,
      });
      expect(sorted(["m", key]).at(-1)).toBe(key);
    });

    it("keeps successive arrivals in arrival order", () => {
      const cards: Array<ReturnType<typeof card>> = [];
      const placed: Array<string> = [];
      for (let i = 0; i < 50; i += 1) {
        const key = boardArrivalOrderKey({ cards, stage, parentCardId: null, doneStageId: done });
        placed.push(key);
        cards.push(card({ stage: "building", orderKey: key }));
      }
      expect(sorted(placed)).toEqual(placed);
    });
  });
});
