import { describe, expect, it } from "vite-plus/test";

import { joinStatusVerdict, parseJoinTarget } from "./worker.ts";

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

  it("judges a join only from a status a live server wrote after it", () => {
    const since = Date.parse("2026-01-01T00:00:10.000Z");
    const status = (updatedAt: string, state: "connected" | "revoked" | "offline") => ({
      updatedAt,
      pid: 42,
      boards: [
        {
          boardEnvironmentId: "board-1",
          boardLabel: "Board",
          boardUrl: "https://b",
          state,
          lastConnectedAt: null,
          lastError: null,
        },
      ],
    });
    const alive = () => true;
    // A re-join after Remove: the file still says revoked from before.
    expect(
      joinStatusVerdict(status("2026-01-01T00:00:09.000Z", "revoked"), "board-1", since, alive),
    ).toBe("pending");
    // The old credential's tunnel is still up: it says nothing about the new one.
    expect(
      joinStatusVerdict(status("2026-01-01T00:00:09.000Z", "connected"), "board-1", since, alive),
    ).toBe("pending");
    expect(
      joinStatusVerdict(status("2026-01-01T00:00:11.000Z", "connected"), "board-1", since, alive),
    ).toBe("connected");
    expect(
      joinStatusVerdict(status("2026-01-01T00:00:11.000Z", "revoked"), "board-1", since, alive),
    ).toBe("refused");
    expect(
      joinStatusVerdict(
        status("2026-01-01T00:00:11.000Z", "connected"),
        "board-1",
        since,
        () => false,
      ),
    ).toBe("no-server");
    expect(joinStatusVerdict(null, "board-1", since, alive)).toBe("no-server");
  });
});
