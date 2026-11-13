import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../../test/render";
import { Dialog, DialogPopup } from "../ui/dialog";
import { ComposerCommandMenuLayer } from "./ComposerCommandMenuLayer";

function ComposerInDialog(props: { readonly onPick: () => void; readonly onClose: () => void }) {
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup>
        <div className="h-64" />
        <form
          data-chat-composer-form="true"
          style={{ "--chat-composer-drawer-inset": "0" } as never}
        >
          <div className="h-16" ref={setAnchor} />
        </form>
        <ComposerCommandMenuLayer anchor={anchor}>
          <button onClick={props.onPick} type="button">
            src/index.ts
          </button>
        </ComposerCommandMenuLayer>
      </DialogPopup>
    </Dialog>
  );
}

describe("ComposerCommandMenuLayer inside a dialog (T3O-96)", () => {
  it("sits above the dialog, and a pick keeps the dialog open", async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    await using _screen = await render(<ComposerInDialog onClose={onClose} onPick={onPick} />);
    // A real pointer click: it fails when the dialog covers the menu.
    await userEvent.click(page.getByRole("button", { name: "src/index.ts" }));
    expect(onPick).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    await expect.element(page.getByRole("dialog")).toBeInTheDocument();
  });
});
