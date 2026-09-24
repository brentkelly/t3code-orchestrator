import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { runPublishScript } from "./publishScript.ts";

describe("runPublishScript", () => {
  it("succeeds on a zero-exit command", async () => {
    const result = await Effect.runPromise(
      runPublishScript({
        cwd: process.cwd(),
        command: "printf 'ok\\n'",
        timeoutMs: 5_000,
      }),
    );
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it("reports a non-zero exit", async () => {
    const result = await Effect.runPromise(
      runPublishScript({
        cwd: process.cwd(),
        command: "exit 7",
        timeoutMs: 5_000,
      }),
    );
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(7);
  });

  it("times out a command that does not finish", async () => {
    const result = await Effect.runPromise(
      runPublishScript({
        cwd: process.cwd(),
        command: "sleep 10",
        timeoutMs: 200,
      }),
    );
    expect(result.timedOut).toBe(true);
    expect(result.detail).toMatch(/timed out/);
  });
});
