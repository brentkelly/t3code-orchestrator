/**
 * T3o label field (t3o-06a). The control shows what the card carries — its
 * labels as pills — and one autocomplete to change it. It does NOT render the
 * catalogue as a row of toggle buttons: a board with twenty labels would blow
 * the 244px rail apart, and the resting control should read as the card's
 * labels, not as every label that exists.
 */
import { BoardLabelId, type BoardLabel } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BoardLabelField } from "./BoardLabelField";

const NOW = "2026-01-01T00:00:00.000Z";

function label(name: string, colour: string, deletedAt: string | null = null): BoardLabel {
  return {
    labelId: BoardLabelId.make(`label-${name}`),
    name,
    colour,
    deletedAt,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const noop = () => {};
const catalogue = [label("Feature", "#3b82f6"), label("Bug", "#ef4444"), label("Chore", "#f59e0b")];

describe("BoardLabelField", () => {
  it("renders the selected labels as pills and nothing for the rest of the catalogue", () => {
    const html = renderToStaticMarkup(
      <BoardLabelField
        catalogue={catalogue}
        onCreate={noop}
        onDelete={noop}
        onRecolour={noop}
        onToggle={noop}
        onUndelete={noop}
        selectedLabelIds={[BoardLabelId.make("label-Feature")]}
      />,
    );
    expect(html).toContain("Feature");
    // Closed field: the unselected catalogue is behind the autocomplete.
    expect(html).not.toContain("Bug");
    expect(html).not.toContain("Chore");
    expect(html).toContain("Search or create a label");
  });

  it("renders no pill row for a card with no labels", () => {
    const html = renderToStaticMarkup(
      <BoardLabelField
        catalogue={catalogue}
        onCreate={noop}
        onDelete={noop}
        onRecolour={noop}
        onToggle={noop}
        onUndelete={noop}
        selectedLabelIds={[]}
      />,
    );
    expect(html).not.toContain("Feature");
    expect(html).toContain("Search or create a label");
  });
});
