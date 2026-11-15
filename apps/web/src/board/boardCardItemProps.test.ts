import { createElement } from "react";
import { describe, expect, it } from "vite-plus/test";

import type { BoardCardTodoContext } from "./BoardCardItem";
import { sameBoardCardItemProps } from "./boardCardItemProps";

const card = { cardId: "card-1" };
const onSelect = () => undefined;
const threads = [
  { cardId: "card-1", threadId: "thread-1" },
] as unknown as BoardCardTodoContext["threads"];

const todos = (state: { running: boolean }, title = "Thread"): BoardCardTodoContext => ({
  threads,
  stateOf: () => ({ awaitingInput: false, running: state.running, stopped: !state.running }),
  titleOf: () => title,
  expanded: false,
  onToggleExpanded: () => undefined,
});

const Figure = (_props: { readonly usage: unknown }) => null;
const usage = { tokens: 3 };

const props = (overrides: Record<string, unknown> = {}) => ({
  card,
  selected: false,
  onSelect,
  attention: { reason: "stalled", tone: "warning", label: "Stalled", detail: "No progress" },
  queueSlot: undefined,
  group: { pips: [{ state: "done", tooltip: "A" }], doneLabel: "1/1", meta: "" },
  costSlot: createElement(Figure, { usage }),
  todos: todos({ running: true }),
  ...overrides,
});

describe("sameBoardCardItemProps", () => {
  it("treats a card's freshly derived but equal view values as unchanged", () => {
    expect(sameBoardCardItemProps(props(), props())).toBe(true);
  });

  it("re-renders a card whose drawn values changed", () => {
    const changed = [
      { attention: { reason: "stalled", tone: "warning", label: "Stalled", detail: "Other" } },
      { group: { pips: [{ state: "running", tooltip: "A" }], doneLabel: "1/1", meta: "" } },
      { costSlot: createElement(Figure, { usage: { tokens: 4 } }) },
      { todos: todos({ running: false }) },
      { todos: todos({ running: true }, "Renamed") },
      { selected: true },
      { card: { cardId: "card-1" } },
      // A handler is compared by identity: the page passes stable ones.
      { onSelect: () => undefined },
    ];
    for (const overrides of changed) {
      expect(sameBoardCardItemProps(props(), props(overrides))).toBe(false);
    }
  });
});
