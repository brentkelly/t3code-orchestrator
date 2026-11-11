/**
 * Usage summed over the board (T3O-77): a group's children, recursively, and the cards
 * in view for the header chip. Summed on the client from the shells it already holds,
 * the same way `boardGroupStats` folds a group's progress.
 */
import {
  sumBoardCardUsageSummaries,
  type BoardCardShell,
  type BoardCardUsageSummary,
} from "@t3tools/contracts";

import { boardShellChildren, isBoardGroupShell } from "../boardGroups";

type Shells = ReadonlyArray<BoardCardShell>;

export interface BoardGroupUsageChild {
  readonly card: BoardCardShell;
  readonly isGroup: boolean;
  /** A nested group's own roll-up, a leaf's own figure. */
  readonly usage: BoardCardUsageSummary | null;
}

export interface BoardGroupUsage {
  readonly total: BoardCardUsageSummary | null;
  /** Direct children, costliest first; a figure-less child sorts last. */
  readonly children: ReadonlyArray<BoardGroupUsageChild>;
}

// One memo per shells array: a page render folds every group from the same array.
const groupMemos = new WeakMap<Shells, Map<string, BoardGroupUsage>>();

export function boardGroupUsage(shells: Shells, cardId: string): BoardGroupUsage {
  let memo = groupMemos.get(shells);
  if (memo === undefined) {
    memo = new Map();
    groupMemos.set(shells, memo);
  }
  return groupUsageWithMemo(shells, cardId, memo, new Set());
}

function groupUsageWithMemo(
  shells: Shells,
  cardId: string,
  memo: Map<string, BoardGroupUsage>,
  visiting: Set<string>,
): BoardGroupUsage {
  const known = memo.get(cardId);
  if (known !== undefined) return known;
  visiting.add(cardId);
  const children = boardShellChildren(shells, cardId).map((card): BoardGroupUsageChild => {
    const childId = String(card.cardId);
    const isGroup = isBoardGroupShell(shells, card);
    if (!isGroup || visiting.has(childId)) {
      return { card, isGroup, usage: card.usage ?? null };
    }
    const inner = groupUsageWithMemo(shells, childId, memo, visiting);
    return { card, isGroup, usage: sumBoardCardUsageSummaries([card.usage, inner.total]) };
  });
  const self = shells.find((card) => String(card.cardId) === cardId);
  const usage: BoardGroupUsage = {
    total: sumBoardCardUsageSummaries([self?.usage, ...children.map((child) => child.usage)]),
    children: children.toSorted(compareByCost),
  };
  visiting.delete(cardId);
  memo.set(cardId, usage);
  return usage;
}

function compareByCost(a: BoardGroupUsageChild, b: BoardGroupUsageChild): number {
  const cost = (child: BoardGroupUsageChild) =>
    child.usage?.costKnown === true ? child.usage.costUsd : -1;
  return cost(b) - cost(a);
}

/** A card's figure as the board counts it: a group stands for everything under it. */
export function boardCardUsageInScope(
  shells: Shells,
  card: BoardCardShell,
): BoardCardUsageSummary | null {
  return isBoardGroupShell(shells, card)
    ? boardGroupUsage(shells, String(card.cardId)).total
    : (card.usage ?? null);
}

export interface BoardUsageInView {
  readonly total: BoardCardUsageSummary | null;
  readonly cardCount: number;
  /** Cards whose figure is a lower bound. */
  readonly partialCount: number;
  readonly byColumn: ReadonlyArray<{
    readonly stageId: string;
    readonly label: string;
    readonly usage: BoardCardUsageSummary;
  }>;
}

/** The spend of the cards in view, following the filter, by column and provider. */
export function boardUsageInView(input: {
  readonly shells: Shells;
  readonly stages: ReadonlyArray<{ readonly stageId: string; readonly label: string }>;
  readonly columns: Readonly<Record<string, ReadonlyArray<BoardCardShell> | undefined>>;
}): BoardUsageInView {
  const byColumn: Array<BoardUsageInView["byColumn"][number]> = [];
  const all: Array<BoardCardUsageSummary | null> = [];
  let cardCount = 0;
  for (const stage of input.stages) {
    const cards = input.columns[stage.stageId] ?? [];
    cardCount += cards.length;
    const usages = cards.map((card) => boardCardUsageInScope(input.shells, card));
    all.push(...usages);
    const usage = sumBoardCardUsageSummaries(usages);
    if (usage !== null) byColumn.push({ stageId: stage.stageId, label: stage.label, usage });
  }
  return {
    total: sumBoardCardUsageSummaries(all),
    cardCount,
    partialCount: all.filter((usage) => usage?.partial === true).length,
    byColumn,
  };
}
