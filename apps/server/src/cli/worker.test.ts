import { describe, expect, it } from "vite-plus/test";

import { parseJoinTarget } from "./worker.ts";

describe("t3 worker join", () => {
  it("takes the board's address and code, or a pasted join link", () => {
    expect(parseJoinTarget("https://board.example/", "ABCD-EFGH")).toEqual({
      boardUrl: "https://board.example",
      code: "ABCD-EFGH",
    });
    expect(parseJoinTarget("https://board.example/t3/?code=ABCD-EFGH", undefined)).toEqual({
      boardUrl: "https://board.example/t3",
      code: "ABCD-EFGH",
    });
    expect(parseJoinTarget("https://board.example/#code=WXYZ-1234", undefined)).toEqual({
      boardUrl: "https://board.example",
      code: "WXYZ-1234",
    });
    expect(parseJoinTarget("https://board.example", undefined)).toMatch(/Missing --code/);
    expect(parseJoinTarget("board.example", "X")).toMatch(/isn't a URL/);
  });
});
