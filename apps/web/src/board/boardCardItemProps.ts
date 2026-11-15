/**
 * Whether a board card can skip a re-render. The page re-derives every card's view values
 * on each board change, so most arrive as fresh but equal objects; comparing them by value
 * keeps a card still unless something it draws changed.
 */
import { isValidElement } from "react";

import type { BoardCardTodoContext } from "./BoardCardItem";

/** Equal by identity, or the same plain data all the way down. React elements compare their
    type, key and props, so a slot rebuilt each render (a cost figure) stays equal. The values
    are small view models, never cyclic. */
function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (isValidElement(left) || isValidElement(right)) {
    return (
      isValidElement(left) &&
      isValidElement(right) &&
      left.type === right.type &&
      left.key === right.key &&
      sameValue(left.props, right.props)
    );
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => sameValue(entry, right[index]))
    );
  }
  if (Object.getPrototypeOf(left) !== Object.prototype) return false;
  if (Object.getPrototypeOf(right) !== Object.prototype) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every(
      (key) => Object.hasOwn(rightRecord, key) && sameValue(leftRecord[key], rightRecord[key]),
    )
  );
}

/**
 * Compared by what the strip draws: the thread list, the expansion, and each thread's
 * resolved state and title. `onToggleExpanded` is a fresh closure over a stable toggle, so
 * its identity carries nothing.
 */
function sameTodos(
  left: BoardCardTodoContext | undefined,
  right: BoardCardTodoContext | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (left.threads !== right.threads || left.expanded !== right.expanded) return false;
  if (left.stateOf === right.stateOf && left.titleOf === right.titleOf) return true;
  return left.threads.every(
    ({ threadId }) =>
      sameValue(left.stateOf(threadId), right.stateOf(threadId)) &&
      left.titleOf(threadId) === right.titleOf(threadId),
  );
}

/** Props compared by value. Every other prop (the card, handlers, primitives) by identity. */
const VALUE_PROPS = new Set(["queueSlot", "attention", "childAttention", "group", "costSlot"]);

export function sameBoardCardItemProps(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const before = left[key];
    const after = right[key];
    if (Object.is(before, after)) continue;
    if (key === "todos") {
      if (!sameTodos(before as BoardCardTodoContext, after as BoardCardTodoContext)) return false;
      continue;
    }
    if (VALUE_PROPS.has(key) && sameValue(before, after)) continue;
    return false;
  }
  return true;
}
