import { describe, expect, it } from "@effect/vitest";
import { BoardCardId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import type { BoardCardShell, BoardProviderLimit } from "@t3tools/contracts";

import {
  boardProviderUsageBar,
  boardUsageCheckedLabel,
  boardUsageUntilLabel,
} from "./boardProviderUsage";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const NOW_ISO = "2026-09-10T23:22:00.000Z";
const NOW = Date.parse(NOW_ISO);

const limit = (over: Partial<BoardProviderLimit> = {}): BoardProviderLimit => ({
  providerInstanceId: codex,
  kind: "wait",
  until: "2026-09-11T01:00:00.000Z",
  detectedAt: "2026-09-10T23:00:00.000Z",
  lastCheckedAt: "2026-09-10T23:20:00.000Z",
  reason: "You've hit your session limit · resets 2:50am (Pacific/Auckland)",
  ruleId: "claude-code.session-limit",
  sourceCardId: BoardCardId.make("card-1"),
  knownTime: true,
  blindSince: null,
  probeCardId: null,
  setByHuman: false,
  ...over,
});

const card = (over: Record<string, unknown> = {}): BoardCardShell =>
  ({
    cardId: BoardCardId.make("card-1"),
    key: "T3O-1",
    projectId: ProjectId.make("project-1"),
    labelIds: [],
    stage: "building",
    orderKey: "m",
    title: "Wire the retry ladder",
    blocked: false,
    dependencyCount: 0,
    hasBrief: false,
    archivedAt: null,
    hasPr: false,
    attachmentCount: 0,
    queued: false,
    stalled: true,
    stepRunning: false,
    held: false,
    stepAwaiting: null,
    stepConflictFix: false,
    stalledReason: "usage-limit",
    limitedByInstanceId: codex,
    threadState: "idle",
    awaitingInput: false,
    activeThreadId: null,
    ...over,
  }) as unknown as BoardCardShell;

describe("boardProviderUsageBar", () => {
  it("says nothing at all when no provider is limited", () => {
    const bar = boardProviderUsageBar({ limits: [], cards: [card()], nowMs: NOW });
    expect(bar.show).toBe(false);
    expect(bar.rows).toEqual([]);
  });

  it("names the provider, its reset clock and the cards it is holding", () => {
    const bar = boardProviderUsageBar({
      limits: [limit()],
      cards: [card()],
      nameFor: () => "OpenAI Codex",
      nowMs: NOW,
    });
    expect(bar.show).toBe(true);
    expect(bar.label).toBe("OpenAI Codex limit");
    expect(bar.rows[0]?.limited).toBe(true);
    expect(bar.rows[0]?.taskCount).toBe("1 task waiting");
    expect(bar.rows[0]?.tasks[0]?.key).toBe("T3O-1");
    // The provider's own sentence, never our paraphrase.
    expect(bar.rows[0]?.detail).toBe(limit().reason);
    expect(bar.rows[0]?.resumeIn).toBe("in 1h 38m");
    expect(bar.checked).toBe("checked 2m ago");
  });

  it("falls back to the instance id when nothing can name the provider", () => {
    const bar = boardProviderUsageBar({ limits: [limit()], cards: [], nowMs: NOW });
    expect(bar.label).toBe("codex limit");
  });

  it("scopes each waiting list to the account actually holding the card", () => {
    // A board with two limited providers must never list one card under both.
    const bar = boardProviderUsageBar({
      limits: [limit(), limit({ providerInstanceId: claude })],
      cards: [
        card(),
        card({
          cardId: BoardCardId.make("card-2"),
          key: "T3O-2",
          limitedByInstanceId: claude,
        }),
      ],
      nowMs: NOW,
    });
    expect(bar.rows[0]?.tasks.map((task) => task.key)).toEqual(["T3O-1"]);
    expect(bar.rows[1]?.tasks.map((task) => task.key)).toEqual(["T3O-2"]);
    expect(bar.label).toBe("2 provider limits");
  });

  it("never lists a card parked for any other reason", () => {
    // A card sitting on an unanswered question is not waiting on the provider,
    // and saying it is would be a lie the human acts on.
    const bar = boardProviderUsageBar({
      limits: [limit()],
      cards: [
        card({ stalledReason: "gave-up", limitedByInstanceId: undefined }),
        card({ stalled: false, stalledReason: undefined, limitedByInstanceId: undefined }),
        card({ archivedAt: "2026-09-10T22:00:00.000Z" }),
      ],
      nowMs: NOW,
    });
    expect(bar.rows[0]?.tasks).toEqual([]);
    expect(bar.rows[0]?.taskCount).toBe("0 tasks waiting");
  });

  it("gives an exhausted account no countdown and no reset clock", () => {
    // Waiting fixes nothing, so a time beside it would be a promise the board
    // cannot keep.
    const bar = boardProviderUsageBar({
      limits: [limit({ kind: "exhausted", knownTime: false })],
      cards: [card()],
      nameFor: () => "OpenAI Codex",
      nowMs: NOW,
    });
    expect(bar.label).toBe("OpenAI Codex — out of credits");
    expect(bar.resume).toBe("");
    expect(bar.rows[0]?.exhausted).toBe(true);
    expect(bar.rows[0]?.resumeWhen).toBe("");
    expect(bar.rows[0]?.tasks).toEqual([]);
    expect(bar.tip).toContain("needs a human");
  });

  it("shows no countdown while the board is polling blind", () => {
    const bar = boardProviderUsageBar({
      limits: [limit({ knownTime: false, blindSince: "2026-09-10T23:00:00.000Z" })],
      cards: [card()],
      nowMs: NOW,
    });
    expect(bar.rows[0]?.limited).toBe(true);
    expect(bar.rows[0]?.resumeWhen).toBe("");
    expect(bar.rows[0]?.knownTime).toBe(false);
    expect(bar.tip).toContain("no reset time given");
    // The pill is always on screen while the popover is not, so a clock here
    // would be the board promising a reset its own popover says it cannot name.
    expect(bar.rows[0]?.resumeAt).toBe(null);
    expect(bar.resume).toBe("");
  });

  it("ignores a blind cooldown when picking the pill's clock", () => {
    // The blind row's `until` is the next probe and sorts first; the clock must
    // still be the only reset a provider actually named.
    const bar = boardProviderUsageBar({
      limits: [
        limit({ knownTime: false, until: "2026-09-10T23:30:00.000Z", blindSince: NOW_ISO }),
        limit({ providerInstanceId: claude, until: "2026-09-11T01:00:00.000Z" }),
      ],
      cards: [],
      nowMs: NOW,
    });
    expect(bar.resume).toBe(
      new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
        Date.parse("2026-09-11T01:00:00.000Z"),
      ),
    );
  });

  it("takes the SOONEST reset across providers for the pill's clock", () => {
    const bar = boardProviderUsageBar({
      limits: [
        limit({ until: "2026-09-11T05:00:00.000Z" }),
        limit({ providerInstanceId: claude, until: "2026-09-11T01:00:00.000Z" }),
      ],
      cards: [],
      nowMs: NOW,
    });
    expect(bar.resume).toBe(
      new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
        Date.parse("2026-09-11T01:00:00.000Z"),
      ),
    );
  });
});

describe("boardUsageUntilLabel", () => {
  it("coarsens as the wait grows, and says so plainly when it is due", () => {
    const at = (ms: number) => new Date(NOW + ms).toISOString();
    expect(boardUsageUntilLabel(at(-1), NOW)).toBe("due now");
    expect(boardUsageUntilLabel(at(12 * 60_000), NOW)).toBe("in 12m");
    expect(boardUsageUntilLabel(at(98 * 60_000), NOW)).toBe("in 1h 38m");
    expect(boardUsageUntilLabel(at(3 * 3_600_000), NOW)).toBe("in 3h");
    expect(boardUsageUntilLabel(at(50 * 3_600_000), NOW)).toBe("in 2d 2h");
  });

  it("reads an unparseable instant as nothing rather than as Invalid Date", () => {
    expect(boardUsageUntilLabel("not a time", NOW)).toBe("");
  });
});

describe("boardUsageCheckedLabel", () => {
  it("tells a live cooldown from a forgotten one", () => {
    const ago = (ms: number) => new Date(NOW - ms).toISOString();
    expect(boardUsageCheckedLabel(ago(0), NOW)).toBe("checked just now");
    expect(boardUsageCheckedLabel(ago(9 * 60_000), NOW)).toBe("checked 9m ago");
    expect(boardUsageCheckedLabel(ago(4 * 3_600_000), NOW)).toBe("checked 4h ago");
    expect(boardUsageCheckedLabel(ago(3 * 86_400_000), NOW)).toBe("checked 3d ago");
    expect(boardUsageCheckedLabel(undefined, NOW)).toBe("");
  });
});
