import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_CI_LOG_BLOCK_LINES,
  EMPTY_BOARD_CI_LOG_VIEW,
  applyBoardCiLogItem,
  boardCiLogLineAt,
  boardCiLogText,
  utf8ByteLength,
  type BoardCiLogView,
} from "./boardCiLog.ts";

const chunk = (offset: number, text: string, end = offset + utf8ByteLength(text)) => ({
  _tag: "chunk" as const,
  offset,
  end,
  text,
});

const fold = (
  items: ReadonlyArray<Parameters<typeof applyBoardCiLogItem>[1]>,
  options?: Parameters<typeof applyBoardCiLogItem>[2],
): BoardCiLogView =>
  items.reduce((view, item) => applyBoardCiLogItem(view, item, options), EMPTY_BOARD_CI_LOG_VIEW);

describe("the CI log viewer's model (T3O-60)", () => {
  it("joins a line split across chunks and keeps each line's byte offset", () => {
    const view = fold([chunk(10, "héllo\nwor"), chunk(20, "ld\r\nlast")]);
    expect(view.blocks.flatMap((block) => block.lines)).toEqual(["héllo", "world"]);
    expect(view.blocks[0]!.offsets).toEqual([10, 17]);
    expect(view.partial).toBe("last");
    expect(view.lineCount).toBe(3);
    expect(view.nextOffset).toBe(10 + utf8ByteLength("héllo\nworld\r\nlast"));
    expect(boardCiLogText(view)).toBe("héllo\nworld\nlast");
    expect(boardCiLogLineAt(view, 19)).toEqual({ blockId: view.blocks[0]!.id, line: 1 });
  });

  it("groups lines into blocks and drops the oldest past its limit", () => {
    const line = "x".repeat(99);
    const text = `${line}\n`.repeat(BOARD_CI_LOG_BLOCK_LINES * 3);
    const view = fold([chunk(0, text)], { maxBytes: 100 * BOARD_CI_LOG_BLOCK_LINES * 2 });
    expect(view.blocks).toHaveLength(2);
    expect(view.truncated).toBe(true);
    expect(view.blocks[0]!.offsets[0]).toBe(100 * BOARD_CI_LOG_BLOCK_LINES);
    expect(view.bytes).toBe(100 * BOARD_CI_LOG_BLOCK_LINES * 2);
    expect(view.droppedLines).toBe(BOARD_CI_LOG_BLOCK_LINES);

    // An append fills the last block in place, keeping earlier blocks as they were.
    const before = fold([chunk(0, "a\nb\n")]);
    const after = applyBoardCiLogItem(before, chunk(4, "c\n"));
    expect(after.blocks).toHaveLength(1);
    expect(after.blocks[0]!.id).toBe(before.blocks[0]!.id);
    expect(after.blocks[0]!.lines).toEqual(["a", "b", "c"]);
  });

  it("starts on a whole line when opened at an offset mid-line", () => {
    const view = fold([chunk(50, "tail of a line\nfirst\nsecond\n")], { alignStart: true });
    expect(view.blocks[0]!.lines).toEqual(["first", "second"]);
    expect(view.blocks[0]!.offsets[0]).toBe(50 + "tail of a line\n".length);
  });

  it("takes where the next read starts from the file's bytes, not the decoded text", () => {
    // One invalid byte in the file decoded to U+FFFD, three bytes as UTF-8.
    const view = fold([chunk(0, "a\ufffd\nb", 4)]);
    expect(view.nextOffset).toBe(4);
    expect(view.partialOffset).toBe(3);
    expect(applyBoardCiLogItem(view, chunk(4, "c\n")).blocks[0]!.lines).toEqual(["a\ufffd", "bc"]);
  });

  it("ends, or says the log is missing", () => {
    expect(fold([chunk(0, "a\n"), { _tag: "end", size: 2 }]).status).toBe("ended");
    const missing = fold([{ _tag: "missing", reason: "The log no longer exists." }]);
    expect(missing.status).toBe("missing");
    expect(missing.missingReason).toBe("The log no longer exists.");
  });
});
