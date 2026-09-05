/**
 * The dependency chart's box (t3o-29).
 *
 * The layout arithmetic is pinned in `boardPlanRows.test.ts`; the one thing
 * only the component can get wrong is how its box behaves as a flex item,
 * which is what this file guards.
 */
import { BoardCardId, boardPlanId, type BoardPlanId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BoardPlanGraph } from "./BoardPlanGraph";
import type { BoardPlanRow } from "./boardPlanRows";

const parentId = BoardCardId.make("parent-1");
const planIdOf = (key: string): BoardPlanId => boardPlanId(parentId, key);

function row(key: string, n: number, dependsOn: ReadonlyArray<string> = []): BoardPlanRow {
  return {
    planId: planIdOf(key),
    n,
    title: `Plan ${key}`,
    state: "live",
    key: `T3-${key}`,
    stage: null,
    stageLabel: null,
    done: false,
    tone: "idle",
    live: null,
    dependsOn: dependsOn.map(planIdOf),
    dependsOnNumbers: [],
    blockers: [],
  };
}

/** A chain deep enough that the chart is taller than any panel it sits in. */
const CHAIN: ReadonlyArray<BoardPlanRow> = ["a", "b", "c", "d"].map((key, index) =>
  row(key, index + 1),
);

/** The chart's own box — the outermost element's classes. */
function rootClasses(rows: ReadonlyArray<BoardPlanRow>): ReadonlyArray<string> {
  const html = renderToStaticMarkup(<BoardPlanGraph rows={rows} />);
  return (/^<div class="([^"]*)"/.exec(html)?.[1] ?? "").split(" ");
}

describe("BoardPlanGraph", () => {
  it("keeps its height inside a scrolling column", () => {
    // The Plans panel mounts the chart in an `overflow-y-auto` flex column
    // whose other children are all `shrink-0`. The chart's own
    // `overflow-x-auto` zeroes its automatic minimum height, so without
    // `shrink-0` of its own the browser hands it every pixel of the column's
    // negative free space and the chart collapses to an empty strip — which
    // is what a split with a double-figure plan count actually rendered.
    expect(rootClasses(CHAIN)).toContain("shrink-0");
  });

  it("draws nothing when there are no plans", () => {
    expect(renderToStaticMarkup(<BoardPlanGraph rows={[]} />)).toBe("");
  });
});
