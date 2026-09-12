/**
 * The Activity rail's collapsed rendering (T3O-35). The grouping rule and the
 * expand/collapse behaviour behind the toggle are pinned in
 * `boardActivityGroups.test.ts`; these check the rail wires them to the screen —
 * a run reads as one sentence plus its toggle, and an unrepeated rail is left
 * alone.
 */
import {
  BoardActivityId,
  BoardCardId,
  BoardStageId,
  type BoardCardActivityEntry,
  type BoardStageDefinition,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BoardCardActivityRail } from "./BoardCardActivityRail";

const cardId = BoardCardId.make("card-1");
const stageId = BoardStageId.make("planning");

const stages: ReadonlyArray<BoardStageDefinition> = [
  {
    stageId,
    label: "Planning",
    role: null,
    orderKey: "a",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

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

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
/** How many rows the rail actually drew. */
const rowCount = (html: string) => occurrences(html, "<li class");

describe("BoardCardActivityRail", () => {
  it("renders nothing for a card with no activity", () => {
    expect(renderToStaticMarkup(<BoardCardActivityRail entries={[]} stages={stages} />)).toBe("");
  });

  it("T3O-39: says WHY a card walked back to Code review", () => {
    // `card-moved` says where, never why — so without this row a card jumping
    // from Ready for merge back to Code review reads as a drag that silently
    // snapped back.
    const html = renderToStaticMarkup(
      <BoardCardActivityRail
        entries={[
          entry({
            kind: "card-review-round-requested",
            payload: { detail: "Requested review round 6 on this branch." },
          }),
        ]}
        stages={stages}
      />,
    );
    expect(html).toContain("Requested review round 6 on this branch.");
  });

  it("shows a run of repeated rows once, with a toggle for the rest", () => {
    const html = renderToStaticMarkup(
      <BoardCardActivityRail
        entries={[
          entry({ kind: "card-created", payload: { toStage: stageId } }),
          entry(),
          entry(),
          entry(),
          entry(),
          entry(),
          entry(),
          entry({ kind: "plans-proposed", payload: { planCount: 1 } }),
        ]}
        stages={stages}
      />,
    );
    expect(occurrences(html, "asked for input on Planning")).toBe(1);
    expect(html).toContain("+5 more");
    // The rows around the run are untouched.
    expect(html).toContain("created the card in Planning");
    expect(html).toContain("proposed 1 plan");
    expect(rowCount(html)).toBe(3);
  });

  it("leaves a rail with nothing repeated fully expanded and toggle-free", () => {
    const html = renderToStaticMarkup(
      <BoardCardActivityRail
        entries={[
          entry({ kind: "card-created", payload: { toStage: stageId } }),
          entry(),
          entry({ kind: "plans-proposed", payload: { planCount: 2 } }),
        ]}
        stages={stages}
      />,
    );
    expect(rowCount(html)).toBe(3);
    expect(html).not.toContain("more");
    expect(html).not.toContain("Show less");
  });
});
