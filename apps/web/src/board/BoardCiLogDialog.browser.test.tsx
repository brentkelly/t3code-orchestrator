import {
  EMPTY_BOARD_CI_LOG_VIEW,
  applyBoardCiLogItem,
  utf8ByteLength,
  type BoardCiLogView,
} from "@t3tools/client-runtime/state/boardCiLog";
import { BoardCardId, type BoardCiPass } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import "../index.css";

import { BoardCiLogDialogView } from "./BoardCiLogDialog";

const pass: BoardCiPass = {
  runId: "run-1",
  cardId: BoardCardId.make("card-1"),
  entry: 1,
  ordinal: 2,
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: null,
  outcome: null,
  snapshot: null,
  configVersion: null,
  steps: [
    {
      name: "Test",
      command: "bun run test",
      timeoutMinutes: 30,
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: null,
      exitCode: null,
      tail: "",
    },
  ],
  logDir: ".t3/ci/run-1",
  fixThreadId: null,
};

const lines = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => `✓ test ${from + index}\n`).join("");

const append = (view: BoardCiLogView, text: string, maxBytes?: number) => {
  const offset = view.nextOffset ?? 0;
  return applyBoardCiLogItem(
    view,
    { _tag: "chunk", offset, end: offset + utf8ByteLength(text), text },
    maxBytes === undefined ? {} : { maxBytes },
  );
};

const first = append(
  EMPTY_BOARD_CI_LOG_VIEW,
  `${lines(0, 300)}::t3o-progress::{"message":"Running unit tests","done":128,"total":212}\n`,
);
const more = append(first, lines(300, 20));

const viewer = (view: typeof first) => (
  <BoardCiLogDialogView
    cardKey="T3-185"
    downloading={false}
    failed={false}
    live
    onClose={() => {}}
    onDownload={() => {}}
    pass={pass}
    stepIndex={0}
    view={view}
  />
);

const atBottom = (element: HTMLElement) =>
  element.scrollHeight - element.scrollTop - element.clientHeight <= 24;

describe("BoardCiLogDialog", () => {
  it("follows new output, pauses when scrolled up, and jumps back to the latest", async () => {
    await using screen = await render(viewer(first));
    const log = page.getByRole("log", { name: "Test log" });
    await expect.element(log).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Following" })).toBeVisible();
    await expect.element(page.getByText("301 lines · scroll up to pause following")).toBeVisible();
    // The latest progress line is read from the log itself.
    await expect.element(page.getByText("Running unit tests")).toBeVisible();
    await expect.element(page.getByText("128 / 212")).toBeVisible();
    const element = log.element() as HTMLElement;
    await vi.waitFor(() => expect(atBottom(element)).toBe(true));

    // Scrolling up stops following; new output then offers to jump.
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
    await expect.element(page.getByRole("button", { name: "Follow" })).toBeVisible();
    await expect.element(page.getByText("↓ New output · jump to latest")).not.toBeInTheDocument();
    await screen.rerender(viewer(more));
    await expect.element(page.getByText("↓ New output · jump to latest")).toBeVisible();
    expect(element.scrollTop).toBe(0);

    await userEvent.click(page.getByText("↓ New output · jump to latest"));
    await expect.element(page.getByRole("button", { name: "Following" })).toBeVisible();
    await expect.element(page.getByText("↓ New output · jump to latest")).not.toBeInTheDocument();
    await vi.waitFor(() => expect(atBottom(element)).toBe(true));
    await expect.element(page.getByText("321 lines · scroll up to pause following")).toBeVisible();
  });

  it("past the size limit, still offers new output and keeps a paused view still", async () => {
    const full = append(EMPTY_BOARD_CI_LOG_VIEW, lines(0, 400));
    const capped = append(full, lines(400, 200), full.bytes + 400);
    expect(capped.lineCount).toBe(full.lineCount);
    await using screen = await render(viewer(full));
    const log = page.getByRole("log", { name: "Test log" });
    await expect.element(log).toBeVisible();
    const element = log.element() as HTMLElement;
    const lineTop = (text: string) => {
      const line = [...element.querySelectorAll("span")].find(
        (span) => span.textContent === `${text}\n`,
      )!;
      return line.getBoundingClientRect().top - element.getBoundingClientRect().top;
    };

    element.scrollTop = element.scrollHeight / 2;
    element.dispatchEvent(new Event("scroll"));
    await expect.element(page.getByRole("button", { name: "Follow" })).toBeVisible();
    const before = lineTop("✓ test 300");

    // The oldest block is dropped above the view as new output arrives.
    await screen.rerender(viewer(capped));
    await expect.element(page.getByText("↓ New output · jump to latest")).toBeVisible();
    await expect.element(page.getByText("600 lines")).toBeVisible();
    // Browser scroll anchoring holds it, to within a sub-pixel.
    expect(Math.abs(lineTop("✓ test 300") - before)).toBeLessThan(1);
  });
});
