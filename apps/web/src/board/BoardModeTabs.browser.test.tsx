/**
 * The sidebar header takes the mode tabs only when it has `MODE_TABS_MIN_WIDTH`
 * of room (T3O-34). That threshold is built on the control's rendered width,
 * so the control as rendered must fit inside the number it is sized by.
 */
import "~/index.css";

import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { BoardModeTabs } from "./BoardModeTabs";
import { MODE_TABS_WIDTH } from "./modeTabsSlot";

describe("BoardModeTabs", () => {
  it("renders all three labelled tabs within MODE_TABS_WIDTH", async () => {
    // Wide enough that the labels show (they collapse to icons below `sm`).
    await page.viewport(1280, 800);
    // Mounted in a flex row, as both headers mount it, so it sizes to content.
    await using screen = await render(
      <div style={{ display: "flex" }}>
        <BoardModeTabs mode="list" placement="sidebar" />
      </div>,
    );
    const control = screen.getByRole("group", { name: "Workspace mode" });
    await expect.element(control).toHaveTextContent("BoardListThreads");
    const width = control.element().getBoundingClientRect().width;
    expect(width).toBeLessThanOrEqual(MODE_TABS_WIDTH);
  });
});
