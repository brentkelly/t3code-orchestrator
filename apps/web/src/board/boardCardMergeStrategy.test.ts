import { describe, expect, it } from "vite-plus/test";

import { boardCardMergeStrategyView } from "./boardCardMergeStrategy";

describe("boardCardMergeStrategyView (T3O-80)", () => {
  it("a card with no override follows the board, with no pill", () => {
    const view = boardCardMergeStrategyView({
      card: { mergeStrategy: null },
      parent: null,
      boardStrategy: "squash",
    });
    expect(view.effective).toBe("squash");
    expect(view.menuValue).toBe("squash · default");
    expect(view.pill).toBeNull();
    expect(view.options.map((option) => [option.value, option.label])).toEqual([
      [null, "Use board default (squash)"],
      ["squash", "Squash"],
      ["merge", "Merge commit"],
      ["rebase", "Rebase"],
    ]);
  });

  it("a card's own value drops the source suffix and shows the pill", () => {
    const view = boardCardMergeStrategyView({
      card: { mergeStrategy: "merge" },
      parent: null,
      boardStrategy: "squash",
    });
    expect(view.menuValue).toBe("merge");
    expect(view.pill).toEqual({
      label: "Merge commit",
      tooltip: "Merges with a merge commit instead of the board default (squash)",
    });
  });

  it("pins with a pill even when the card's value equals the board default", () => {
    const view = boardCardMergeStrategyView({
      card: { mergeStrategy: "squash" },
      parent: null,
      boardStrategy: "squash",
    });
    expect(view.pill?.label).toBe("Squash");
  });

  it("a child inheriting from its parent names the parent, with no pill", () => {
    const view = boardCardMergeStrategyView({
      card: { mergeStrategy: null },
      parent: { key: "T3O-79", mergeStrategy: "merge" },
      boardStrategy: "squash",
    });
    expect(view.effective).toBe("merge");
    expect(view.menuValue).toBe("merge · parent");
    expect(view.pill).toBeNull();
    expect(view.options[0]?.label).toBe("Use parent (merge · T3O-79)");
  });

  it("a child whose parent has no override offers the board default", () => {
    const view = boardCardMergeStrategyView({
      card: { mergeStrategy: "rebase" },
      parent: { key: "T3O-79", mergeStrategy: null },
      boardStrategy: "merge",
    });
    expect(view.options[0]?.label).toBe("Use board default (merge)");
    expect(view.pill?.tooltip).toBe("Rebases onto the base instead of the board default (merge)");
  });
});
