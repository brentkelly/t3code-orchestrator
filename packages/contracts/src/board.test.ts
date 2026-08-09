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
  BoardCardId,
  boardCardShellFromCard,
  BoardCardShell,
  deriveBoardCardThreadState,
  makeBoardCardShell,
  type BoardCard,
} from "./board.ts";
import { OrchestrationShellSnapshot } from "./orchestration.ts";
import { ProjectId, ThreadId } from "./baseSchemas.ts";

const encodeShell = Schema.encodeUnknownSync(BoardCardShell);
const decodeShell = Schema.decodeUnknownSync(BoardCardShell);
const encodeSnapshot = Schema.encodeUnknownSync(OrchestrationShellSnapshot);

const utf8Bytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * Measured at 726 bytes on implementation (2026-08-10) for a worst-case
 * shell — review stage with every nullable field populated, UUID-length
 * ids, and a 67-character title — then rounded up modestly. Not a guess: if
 * a change pushes past this, it added real bytes to every card on every
 * reconnect, and the right fix is almost never raising the number.
 */
const BOARD_CARD_SHELL_BYTE_BUDGET = 1024;

/** Worst case: every nullable populated (review stage), long ids, long title. */
const fullyPopulatedShell = {
  cardId: BoardCardId.make("0b8a2c3d-4e5f-6789-abcd-ef0123456789"),
  key: "T3O-1234",
  projectId: ProjectId.make("project-0b8a2c3d-4e5f-6789-abcd-ef0123456789"),
  type: "feature",
  stage: "review",
  orderKey: "mmmmzz",
  title: "Implement the board RPC surface and shared client state end to end",
  blocked: true,
  dependencyCount: 12,
  hasBrief: true,
  hasPr: true,
  attachmentCount: 42,
  queued: true,
  threadState: "waiting",
  awaitingInput: true,
  activeThreadId: ThreadId.make("thread-0b8a2c3d-4e5f-6789-abcd-ef0123456789"),
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
  type: "feature",
  stage: "building",
  orderKey: "mmmm",
  title: `A realistically sized card title for card number ${index}`,
  briefRef: "brief",
  dependsOn: [],
  parentCardId: null,
  threadLinks: [
    {
      threadId: ThreadId.make(`thread-${index}-4e5f-6789-abcd-ef0123456789`),
      role: "build",
      linkedAt: "2026-01-01T00:00:00.000Z",
      tombstonedAt: null,
    },
  ],
  externalRef: null,
  recipeSnapshot: null,
  blocked: false,
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

  it("serializes to scalars only — no arrays, no nested objects", () => {
    // The structural form of the D7 promise: nothing unbounded can hide in
    // a field whose every value is a primitive or null.
    const encoded = encodeShell(fullyPopulatedShell) as Record<string, unknown>;
    for (const [field, value] of Object.entries(encoded)) {
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

describe("board card shell derivation", () => {
  it("boardCardShellFromCard produces a schema-valid shell with derived scalars", () => {
    const card = typicalCard(7);
    const shell = decodeShell(encodeShell(boardCardShellFromCard(card)));
    expect(shell.cardId).toBe(card.id);
    expect(shell.dependencyCount).toBe(0);
    expect(shell.hasBrief).toBe(true);
    expect(shell.activeThreadId).toBe(card.threadLinks[0]?.threadId);
    // No thread source at hand: thread-derived fields at rest (the client
    // reducer re-derives them via activeThreadId).
    expect(shell.threadState).toBe("none");
    expect(shell.awaitingInput).toBe(false);
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
      type: "feature",
      stage: "backlog",
      orderKey: "m",
      title: "Card",
      blocked: false,
      dependencyCount: 0,
      hasBrief: false,
      activeThreadId: null,
    });
    // t3o-11 fields
    expect(shell.hasPr).toBe(false);
    expect(shell.attachmentCount).toBe(0);
    expect(shell.queued).toBe(false);
    // post-MVP sub-boards and review pipeline: key-optional and absent, so
    // an unsourced field costs zero wire bytes per card.
    expect("planTotal" in shell).toBe(false);
    expect("planDone" in shell).toBe(false);
    expect("prNumber" in shell).toBe(false);
    expect("issuesOpen" in shell).toBe(false);
  });
});
