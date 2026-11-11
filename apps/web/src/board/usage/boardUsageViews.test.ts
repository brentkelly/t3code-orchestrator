import {
  BoardCardId,
  BoardStageId,
  ProjectId,
  makeBoardCardShell,
  type BoardCardShell,
  type BoardCardUsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardGroupUsage, boardUsageInView } from "./boardUsageViews";

const GROUP = {
  target: "inherit",
  autoBuild: false,
  autoMerge: false,
  autoPlan: false,
  started: true,
  placed: BoardStageId.make("backlog"),
  prevStage: BoardStageId.make("planning"),
  heading: false,
  integrated: false,
} as const;

const usage = (costUsd: number, extra: Partial<BoardCardUsageSummary> = {}) => ({
  tokens: 100,
  costUsd,
  costKnown: true,
  providers: [{ provider: "claudeAgent", tokens: 100, costUsd }],
  ...extra,
});

function shell(
  id: string,
  stage: string,
  extra: { parent?: string; group?: boolean; usage?: BoardCardUsageSummary } = {},
): BoardCardShell {
  return {
    ...makeBoardCardShell({
      cardId: BoardCardId.make(id),
      key: id.toUpperCase(),
      projectId: ProjectId.make("p1"),
      labelIds: [],
      stage: BoardStageId.make(stage),
      orderKey: "m",
      title: id,
      blocked: false,
      dependencyCount: 0,
      hasBrief: false,
      activeThreadId: null,
    }),
    ...(extra.parent === undefined ? {} : { parentCardId: BoardCardId.make(extra.parent) }),
    ...(extra.group === true ? { group: GROUP } : {}),
    ...(extra.usage === undefined ? {} : { usage: extra.usage }),
  };
}

const shells = [
  shell("outer", "done", { group: true }),
  shell("a", "done", { parent: "outer", usage: usage(1) }),
  shell("inner", "done", { parent: "outer", group: true }),
  shell("b", "done", { parent: "inner", usage: usage(3, { estimated: true }) }),
  shell("c", "done", { parent: "inner", usage: usage(0.5, { partial: true }) }),
  shell("d", "done", { parent: "outer" }),
  shell("loose", "building", { usage: usage(2) }),
];

describe("a group's spend", () => {
  it("sums every child, nested groups included, and carries their marks", () => {
    expect(boardGroupUsage(shells, "outer").total).toMatchObject({
      costUsd: 4.5,
      costKnown: true,
      estimated: true,
      partial: true,
    });
  });

  it("lists its direct children costliest first, a nested group as one row", () => {
    const children = boardGroupUsage(shells, "outer").children;
    expect(children.map((child) => [child.card.key, child.isGroup, child.usage?.costUsd])).toEqual([
      ["INNER", true, 3.5],
      ["A", false, 1],
      ["D", false, undefined],
    ]);
  });

  it("has no figure when nothing under it does", () => {
    expect(boardGroupUsage([shell("empty", "done", { group: true })], "empty").total).toBeNull();
  });
});

describe("the spend in view", () => {
  it("follows the columns shown, counting a group for everything under it", () => {
    const inView = boardUsageInView({
      shells,
      stages: [
        { stageId: "building", label: "Building" },
        { stageId: "done", label: "Done" },
      ],
      columns: { building: [shells[6]!], done: [shells[0]!] },
    });
    expect(inView.total).toMatchObject({ costUsd: 6.5, partial: true });
    expect(inView.cardCount).toBe(2);
    expect(inView.partialCount).toBe(1);
    expect(inView.byColumn.map((column) => [column.label, column.usage.costUsd])).toEqual([
      ["Building", 2],
      ["Done", 4.5],
    ]);
  });
});
