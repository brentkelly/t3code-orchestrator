/**
 * Collapsing repeated Activity rows (T3O-35).
 *
 * The rule these pin down: a run collapses only when every row in it would read
 * the same, it keeps its newest member, and its identity is the OLDEST member —
 * so a run that grows does not lose the user's expansion.
 */
import {
  BoardActivityId,
  BoardCardId,
  BoardStageId,
  ProviderInstanceId,
  ThreadId,
  type BoardCardActivityEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardActivityGroupView,
  groupBoardActivity,
  toggleBoardActivityGroup,
} from "./boardActivityGroups";

const cardId = BoardCardId.make("card-1");
const stage = (id: string) => BoardStageId.make(id);

let seq = 0;
const entry = (
  overrides: Partial<Omit<BoardCardActivityEntry, "cardId">> = {},
): BoardCardActivityEntry => ({
  activityId: BoardActivityId.make(`activity-${++seq}`),
  cardId,
  kind: "card-input-requested",
  payload: { stepLabel: "Planning" },
  actor: { kind: "system", name: null, providerInstanceId: null, threadId: null },
  threadId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const shape = (entries: ReadonlyArray<BoardCardActivityEntry>) =>
  groupBoardActivity(entries).map((group) => ({
    key: String(group.key),
    ids: group.entries.map((member) => String(member.activityId)),
    collapsible: group.collapsible,
  }));

describe("groupBoardActivity", () => {
  it("returns nothing for an empty rail", () => {
    expect(groupBoardActivity([])).toEqual([]);
  });

  it("collapses a run of identical consecutive rows and keys it on the oldest", () => {
    const rows = [entry(), entry(), entry(), entry(), entry(), entry()];
    const groups = groupBoardActivity(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.collapsible).toBe(true);
    expect(groups[0]!.key).toBe(rows[0]!.activityId);
    // The rail shows the newest member of a collapsed run.
    expect(groups[0]!.entries.at(-1)).toBe(rows.at(-1));
  });

  it("leaves a run of two expanded — hiding one row behind a toggle saves nothing", () => {
    const rows = [entry(), entry()];
    const groups = groupBoardActivity(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.collapsible).toBe(false);
  });

  it("collapses at exactly three, the floor", () => {
    expect(groupBoardActivity([entry(), entry(), entry()])[0]!.collapsible).toBe(true);
  });

  it("keeps every entry, once, in order", () => {
    const rows = [
      entry({ kind: "card-created", payload: { toStage: stage("planning") } }),
      entry(),
      entry(),
      entry(),
      entry({ kind: "plans-proposed", payload: { planCount: 1 } }),
    ];
    expect(groupBoardActivity(rows).flatMap((group) => group.entries)).toEqual(rows);
  });

  it("does not merge rows that would read differently", () => {
    const planning = [entry(), entry()];
    const review = entry({ payload: { stepLabel: "Code review" } });
    expect(shape([...planning, review])).toEqual([
      {
        key: String(planning[0]!.activityId),
        ids: planning.map((row) => String(row.activityId)),
        collapsible: false,
      },
      { key: String(review.activityId), ids: [String(review.activityId)], collapsible: false },
    ]);
  });

  it("does not merge rows from different actors", () => {
    const agentActor = {
      kind: "agent",
      name: null,
      providerInstanceId: ProviderInstanceId.make("provider-1"),
      threadId: ThreadId.make("thread-1"),
    } as const;
    const groups = groupBoardActivity([
      entry(),
      entry(),
      entry(),
      entry({ actor: agentActor }),
      entry({ actor: agentActor }),
      entry({ actor: agentActor }),
    ]);
    expect(groups.map((group) => group.entries.length)).toEqual([3, 3]);
    expect(groups.every((group) => group.collapsible)).toBe(true);
  });

  it("does not merge two agents' rows just because the sentence matches", () => {
    const actorFor = (id: string) =>
      ({
        kind: "agent",
        name: null,
        providerInstanceId: ProviderInstanceId.make(id),
        threadId: null,
      }) as const;
    const groups = groupBoardActivity([
      entry({ actor: actorFor("provider-1") }),
      entry({ actor: actorFor("provider-2") }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("treats a run broken by a different row as two runs", () => {
    const groups = groupBoardActivity([
      entry(),
      entry(),
      entry(),
      entry({ kind: "plans-proposed", payload: { planCount: 2 } }),
      entry(),
      entry(),
      entry(),
    ]);
    expect(groups.map((group) => group.entries.length)).toEqual([3, 1, 3]);
    expect(groups.map((group) => group.collapsible)).toEqual([true, false, true]);
  });

  it("ignores threadId, which the rail never shows", () => {
    const groups = groupBoardActivity([
      entry({ threadId: ThreadId.make("thread-a") }),
      entry({ threadId: ThreadId.make("thread-b") }),
      entry({ threadId: ThreadId.make("thread-c") }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.collapsible).toBe(true);
  });

  it("is insensitive to payload key order", () => {
    const groups = groupBoardActivity([
      entry({
        kind: "card-moved",
        payload: { fromStage: stage("ready"), toStage: stage("building") },
      }),
      entry({
        kind: "card-moved",
        payload: { toStage: stage("building"), fromStage: stage("ready") },
      }),
      entry({
        kind: "card-moved",
        payload: { fromStage: stage("ready"), toStage: stage("building") },
      }),
    ]);
    expect(groups).toHaveLength(1);
  });

  it("distinguishes an absent payload field from a present one", () => {
    expect(groupBoardActivity([entry(), entry({ payload: {} }), entry()])).toHaveLength(3);
  });

  it("keeps the run's identity stable as it grows, so an expansion survives", () => {
    const rows = [entry(), entry(), entry()];
    const before = groupBoardActivity(rows)[0]!.key;
    expect(groupBoardActivity([...rows, entry()])[0]!.key).toBe(before);
  });

  it("never collapses below a run of two, whatever the caller asks for", () => {
    expect(groupBoardActivity([entry()], 1)[0]!.collapsible).toBe(false);
  });
});

/**
 * Pressing the toggle. The rail's own state is a set of expanded run keys and a
 * pure view over it, so what the user actually sees — one row and "+5 more",
 * then six rows and "Show less", then one row again — is checked here rather
 * than through rendered markup. The web unit project runs without a DOM (no
 * `document`, and neither jsdom nor a client testing library is a dependency),
 * so a rendered click is not available to assert on.
 */
describe("expanding a collapsed run", () => {
  const runOfSix = () =>
    groupBoardActivity([entry(), entry(), entry(), entry(), entry(), entry()])[0]!;

  it("shows only the newest row until it is pressed, then all six", () => {
    const group = runOfSix();
    const collapsed = boardActivityGroupView(group, false);
    expect(collapsed.rows).toEqual([group.entries.at(-1)]);
    expect(collapsed.toggleLabel).toBe("+5 more");

    const expanded = boardActivityGroupView(group, true);
    expect(expanded.rows).toEqual(group.entries);
    expect(expanded.toggleLabel).toBe("Show less");
  });

  it("goes back to one row when the toggle is pressed a second time", () => {
    const group = runOfSix();
    const opened = toggleBoardActivityGroup(new Set(), group.key);
    expect(opened.has(group.key)).toBe(true);
    expect(boardActivityGroupView(group, opened.has(group.key)).rows).toHaveLength(6);

    const closed = toggleBoardActivityGroup(opened, group.key);
    expect(closed.has(group.key)).toBe(false);
    expect(boardActivityGroupView(group, closed.has(group.key)).rows).toHaveLength(1);
  });

  it("opens one run without opening another", () => {
    const groups = groupBoardActivity([
      entry(),
      entry(),
      entry(),
      entry({ kind: "card-step-completed", payload: { stepId: "building" } }),
      entry({ kind: "card-step-completed", payload: { stepId: "building" } }),
      entry({ kind: "card-step-completed", payload: { stepId: "building" } }),
    ]);
    expect(groups).toHaveLength(2);
    const expanded = toggleBoardActivityGroup(new Set(), groups[0]!.key);
    expect(boardActivityGroupView(groups[0]!, expanded.has(groups[0]!.key)).rows).toHaveLength(3);
    expect(boardActivityGroupView(groups[1]!, expanded.has(groups[1]!.key)).rows).toHaveLength(1);
  });

  it("stays open, and shows the new row, when the run grows underneath it", () => {
    const rows = [entry(), entry(), entry()];
    const before = groupBoardActivity(rows)[0]!;
    const expanded = toggleBoardActivityGroup(new Set(), before.key);

    const grown = groupBoardActivity([...rows, entry()])[0]!;
    const view = boardActivityGroupView(grown, expanded.has(grown.key));
    expect(view.rows).toHaveLength(4);
    expect(view.toggleLabel).toBe("Show less");
  });

  it("gives a run too short to collapse no toggle in either state", () => {
    const group = groupBoardActivity([entry(), entry()])[0]!;
    expect(boardActivityGroupView(group, false).toggleLabel).toBeNull();
    expect(boardActivityGroupView(group, true).toggleLabel).toBeNull();
    expect(boardActivityGroupView(group, false).rows).toHaveLength(2);
  });
});
