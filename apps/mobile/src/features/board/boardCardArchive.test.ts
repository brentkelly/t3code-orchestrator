import { describe, expect, it, vi } from "vite-plus/test";

import { requestBoardCardArchive } from "./boardCardArchive";

describe("requestBoardCardArchive", () => {
  it("asks before archiving a card that still has dependents", () => {
    const confirm = vi.fn();
    const go = vi.fn();
    requestBoardCardArchive({ needsConfirmation: true, confirm, go });
    expect(go).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Archive this card?",
        confirmText: "Archive",
      }),
    );
    confirm.mock.calls[0]![0].onConfirm();
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("archives immediately when nothing depends on the card", () => {
    const confirm = vi.fn();
    const go = vi.fn();
    requestBoardCardArchive({ needsConfirmation: false, confirm, go });
    expect(confirm).not.toHaveBeenCalled();
    expect(go).toHaveBeenCalledTimes(1);
  });
});
