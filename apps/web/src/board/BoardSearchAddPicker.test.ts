/**
 * What the add-picker's popover actually builds (T3O-33 review, n1).
 *
 * Since the dependency picker was opened to cross-project cards its option list
 * grows with the WHOLE board, not with one project, so the two things worth
 * pinning are that the rendered list stays bounded and that the overflow is
 * still reachable by typing.
 */
import { describe, expect, it } from "vite-plus/test";

import { boardPickerVisibleOptions, type BoardPickerOption } from "./BoardSearchAddPicker";

const options = (count: number, prefix = "T3O"): ReadonlyArray<BoardPickerOption> =>
  Array.from({ length: count }, (_, index) => ({
    id: `card-${prefix}-${index}`,
    key: `${prefix}-${index}`,
    title: `Card ${index}`,
  }));

describe("boardPickerVisibleOptions", () => {
  it("renders every option when the set is under the cap", () => {
    const { visible, hidden } = boardPickerVisibleOptions(options(12), "");
    expect(visible).toHaveLength(12);
    expect(hidden).toBe(0);
  });

  it("caps the rendered rows and reports the remainder", () => {
    const { visible, hidden } = boardPickerVisibleOptions(options(400), "");
    expect(visible).toHaveLength(50);
    expect(hidden).toBe(350);
  });

  it("counts the overflow AFTER filtering, so typing reaches a capped-off card", () => {
    // The 300th card is far past the cap on an empty query; its key must still
    // find it, and once it is the only match nothing is left hidden.
    const { visible, hidden } = boardPickerVisibleOptions(options(400), "t3o-399");
    expect(visible.map((option) => option.key)).toEqual(["T3O-399"]);
    expect(hidden).toBe(0);
  });

  it("matches on title as well as key, case-insensitively and trimmed", () => {
    const set: ReadonlyArray<BoardPickerOption> = [
      { id: "a", key: "MW-1", title: "Rename the queue pill" },
      { id: "b", key: "T3O-2", title: "Unrelated" },
    ];
    expect(boardPickerVisibleOptions(set, "  QUEUE ").visible.map((o) => o.id)).toEqual(["a"]);
    expect(boardPickerVisibleOptions(set, "mw-1").visible.map((o) => o.id)).toEqual(["a"]);
  });

  it("reports no matches rather than falling back to the whole list", () => {
    const { visible, hidden } = boardPickerVisibleOptions(options(80), "nothing-matches-this");
    expect(visible).toEqual([]);
    expect(hidden).toBe(0);
  });
});
