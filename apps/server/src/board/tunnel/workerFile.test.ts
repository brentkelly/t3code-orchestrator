// @effect-diagnostics nodeBuiltinImport:off - reads and writes a real worker home.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  boardUrlRefusal,
  findWorkerBoard,
  localTunnelTarget,
  readWorkerFile,
  WorkerFileInvalidError,
  removeWorkerBoard,
  upsertWorkerBoard,
  workerFilePath,
  writeWorkerFile,
} from "./workerFile.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) NodeFS.rmSync(home, { recursive: true, force: true });
});
const makeHome = () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-worker-file-"));
  homes.push(home);
  return home;
};

const entry = (id: string, url: string) => ({
  boardEnvironmentId: id,
  boardUrl: url,
  boardLabel: `board-${id}`,
  joinedAt: "2026-11-12T10:00:00.000Z",
});

describe("worker.json", () => {
  it("round-trips atomically, reads a missing file as empty and refuses a broken one", () => {
    const home = makeHome();
    expect(readWorkerFile(home)).toEqual({ boards: [], config: {} });
    const file = upsertWorkerBoard(readWorkerFile(home), entry("a", "https://a.example"));
    writeWorkerFile(home, upsertWorkerBoard(file, entry("b", "https://b.example")));
    expect(readWorkerFile(home).boards.map((board) => board.boardEnvironmentId)).toEqual([
      "a",
      "b",
    ]);
    // No temporary file is left beside it.
    expect(NodeFS.readdirSync(home)).toEqual(["worker.json"]);
    expect(NodeFS.statSync(workerFilePath(home)).mode & 0o777).toBe(0o600);
    NodeFS.writeFileSync(workerFilePath(home), "{ broken");
    expect(() => readWorkerFile(home)).toThrow(WorkerFileInvalidError);
    NodeFS.writeFileSync(workerFilePath(home), JSON.stringify({ boards: "nope" }));
    expect(() => readWorkerFile(home)).toThrow(WorkerFileInvalidError);
  });

  it("finds a board by id, label or address, and removes it", () => {
    const file = upsertWorkerBoard(
      upsertWorkerBoard({ boards: [], config: {} }, entry("a", "https://a.example")),
      entry("a", "https://a2.example"),
    );
    expect(file.boards).toHaveLength(1);
    expect(findWorkerBoard(file, "a")?.boardUrl).toBe("https://a2.example");
    expect(findWorkerBoard(file, "board-a")?.boardEnvironmentId).toBe("a");
    expect(findWorkerBoard(file, "https://a2.example/")?.boardEnvironmentId).toBe("a");
    expect(findWorkerBoard(file, "nope")).toBeNull();
    expect(removeWorkerBoard(file, "a").boards).toEqual([]);
  });
});

describe("board addresses", () => {
  it("refuses plain http except on loopback and Tailscale, unless --insecure", () => {
    expect(boardUrlRefusal("https://board.example", false)).toBeNull();
    expect(boardUrlRefusal("http://127.0.0.1:3773", false)).toBeNull();
    expect(boardUrlRefusal("http://localhost:3773", false)).toBeNull();
    expect(boardUrlRefusal("http://100.101.102.103:3773", false)).toBeNull();
    expect(boardUrlRefusal("http://studio.tail1234.ts.net", false)).toBeNull();
    expect(boardUrlRefusal("http://100.128.0.1", false)).toMatch(/unencrypted/);
    expect(boardUrlRefusal("http://192.168.1.20:3773", false)).toMatch(/unencrypted/);
    expect(boardUrlRefusal("http://127.example.com", false)).toMatch(/unencrypted/);
    expect(boardUrlRefusal("http://192.168.1.20:3773", true)).toBeNull();
    expect(boardUrlRefusal("ftp://board.example", true)).toMatch(/https/);
    expect(boardUrlRefusal("board.example", false)).toMatch(/isn't a URL/);
  });

  it("streams go to the loopback form of the server's own bind host", () => {
    expect(localTunnelTarget(undefined, 3773)).toEqual({ host: "127.0.0.1", port: 3773 });
    expect(localTunnelTarget("0.0.0.0", 3773)).toEqual({ host: "127.0.0.1", port: 3773 });
    expect(localTunnelTarget("::", 3773)).toEqual({ host: "::1", port: 3773 });
    expect(localTunnelTarget("127.0.0.1", 3773)).toEqual({ host: "127.0.0.1", port: 3773 });
  });
});
