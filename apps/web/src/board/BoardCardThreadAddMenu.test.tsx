/**
 * t3o-14 — the card thread pane's `+` menu.
 *
 * The load-bearing invariant is the restart gate: "New thread — restart <stage>"
 * appears ONLY when the card's current stage auto-executes (t3o-15 generalised
 * auto-kickoff to any stage), and is DISABLED while a supervised run is in
 * flight — restarting then would leave two threads owning the same step (D1).
 *
 * The gate is computed in `BoardCardDetail` (auto-execute + in-flight proxy) and
 * threaded through `BoardCardDetailView` → `BoardCardThreadPane` → the menu, so
 * the rows it produces are pinned here. The popover itself portals, and a portal
 * renders nothing on the server, so the body is exported separately rather than
 * reached through the trigger.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BoardCardThreadAddMenuBody, type BoardThreadStageRestart } from "./BoardCardThreadAddMenu";

const noop = () => {};

const body = (stageRestart: BoardThreadStageRestart | null, mode: "menu" | "adopt" = "menu") =>
  renderToStaticMarkup(
    <BoardCardThreadAddMenuBody
      adoptableThreads={[{ id: "thread-1", key: "", title: "An existing thread" }]}
      mode={mode}
      onAdoptThread={noop}
      onCreateBlankThread={noop}
      onEnterAdoptMode={noop}
      onRestartStage={noop}
      stageRestart={stageRestart}
    />,
  );

describe("BoardCardThreadAddMenuBody", () => {
  it("offers all three actions on an auto-executing stage", () => {
    const html = body({ label: "Planning", disabledReason: null });
    expect(html).toContain("New thread — restart planning");
    expect(html).toContain("New blank thread");
    expect(html).toContain("Adopt an existing thread");
    // Enabled: no rendered `disabled` attribute (the className carries Tailwind
    // `disabled:` variants, so match the attribute React emits, not the substring).
    expect(html).not.toContain('disabled=""');
  });

  it("drops the restart row when the stage does not auto-execute, and the blank item becomes plain New thread", () => {
    const html = body(null);
    expect(html).not.toContain("restart");
    expect(html).toContain("New thread");
    expect(html).not.toContain("New blank thread");
    expect(html).toContain("Adopt an existing thread");
  });

  it("disables the restart row, with its reason, while a run is in flight", () => {
    const reason = "A run is already in flight for this card — drag it out and back to restart.";
    const html = body({ label: "Planning", disabledReason: reason });
    // The row is still offered (named after the stage) but disabled...
    expect(html).toContain("New thread — restart planning");
    expect(html).toContain('disabled=""');
    // ...and the reason is shown.
    expect(html).toContain(reason);
    // The other two actions remain available.
    expect(html).toContain("New blank thread");
    expect(html).toContain("Adopt an existing thread");
  });

  it("swaps the whole body for the thread search in adopt mode", () => {
    const html = body({ label: "Planning", disabledReason: null }, "adopt");
    expect(html).toContain("An existing thread");
    expect(html).not.toContain("restart");
  });
});
