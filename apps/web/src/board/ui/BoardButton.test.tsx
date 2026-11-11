import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BoardButton } from "./BoardButton";

describe("BoardButton", () => {
  it("renders type=button like upstream's Button, unless the caller sets a type", () => {
    expect(renderToStaticMarkup(<BoardButton look="muted">Reset</BoardButton>)).toContain(
      'type="button"',
    );
    expect(
      renderToStaticMarkup(
        <BoardButton look="muted" type="submit">
          Save
        </BoardButton>,
      ),
    ).toContain('type="submit"');
  });
});
