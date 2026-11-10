import { describe, expect, it } from "@effect/vitest";

import type { BoardCiStepResult } from "@t3tools/contracts";

import { BoardCiLineReader } from "./BoardCiRunner.ts";
import {
  BoardCiFailureFacts,
  boardCiFailureHeadline,
  boardCiMachineHoldReason,
  type BoardCiHeadlineInput,
} from "./ciFailureHeadline.ts";

const GIB = 1024 ** 3;

const feed = (log: string) => {
  const facts = new BoardCiFailureFacts();
  const reader = new BoardCiLineReader();
  for (const line of reader.push(log)) facts.push(line);
  for (const line of reader.flush()) facts.push(line);
  return facts;
};

const passing = (count: number) =>
  Array.from({ length: count }, (_, index) => `  ✓ test ${index} passes\n`).join("");

const headlineOf = (log: string, input: Partial<BoardCiHeadlineInput> = {}) =>
  boardCiFailureHeadline(feed(log), {
    stepName: "panel",
    status: "failed",
    exitCode: 1,
    signal: null,
    timeoutMinutes: 60,
    result: null,
    resultEmpty: false,
    host: "box",
    freeBytes: 50 * GIB,
    ...input,
  });

const result = (failures: BoardCiStepResult["failures"]): BoardCiStepResult => ({
  summary: null,
  failures,
});

const LIBNSPR =
  "/home/u/.cache/chrome/chrome: error while loading shared libraries: libnspr4.so: cannot open shared object file: No such file or directory\n";

describe("boardCiFailureHeadline", () => {
  it.each<{
    readonly name: string;
    readonly log: string;
    readonly input?: Partial<BoardCiHeadlineInput>;
    readonly what?: string;
    readonly why: RegExp | string;
    readonly machine: boolean;
    readonly source?: string;
  }>([
    {
      name: "a missing shared library",
      log: `${passing(3)}${LIBNSPR}`,
      why: "Missing system library: libnspr4.so",
      machine: true,
      source: "machine",
    },
    {
      name: "no space left on device",
      log: `${passing(3)}write /tmp/x: No space left on device\n${passing(3)}`,
      input: { freeBytes: 0.5 * GIB },
      why: "Ran out of disk space on box (0.5 GB free now)",
      machine: true,
    },
    {
      name: "a panel-shaped log: an early lint stop, 2,000 passing lines, then a failed exit",
      log: `\nOops! Something went wrong! :(\nNo files matching the pattern "src/**" were found.\n${passing(2_000)}done\n`,
      why: 'No files matching the pattern "src/**" were found.',
      machine: false,
      source: "pattern",
    },
    {
      name: "exit 127 names the missing command",
      log: "sh: 1: playwright: not found\n",
      input: { exitCode: 127 },
      why: "A tool the script needs isn't installed: playwright",
      machine: true,
    },
    {
      name: "command not found with exit 1 is not a machine problem",
      log: "bash: jq: command not found\n",
      input: { exitCode: 1 },
      why: "bash: jq: command not found",
      machine: false,
      source: "last-line",
    },
    {
      name: "Killed with exit 1 is not a machine problem",
      log: "Killed\n",
      input: { exitCode: 1 },
      why: "Killed",
      machine: false,
    },
    {
      name: "exit 137 is a kill, likely out of memory",
      log: "running tests\nKilled\n",
      input: { exitCode: 137 },
      why: "Killed (out of memory?)",
      machine: true,
    },
    {
      name: "SIGKILL without a timeout",
      log: "running\nOut of memory: Killed process 4242 (node)\n",
      input: { exitCode: null, signal: "SIGKILL" },
      why: "Killed (out of memory?)",
      machine: true,
    },
    {
      name: "exit 137 without Killed or Out of memory is not a machine problem",
      log: "running\nsleep 5; timeout -s KILL 1 ./slow\n",
      input: { exitCode: 137 },
      why: "sleep 5; timeout -s KILL 1 ./slow",
      machine: false,
      source: "last-line",
    },
    {
      name: "SIGKILL from the time limit is a timeout",
      log: "running\n[board] Step timed out after 60 min; killed.\n",
      input: { exitCode: null, signal: "SIGKILL", status: "timed-out" },
      why: "Timed out after 60 min",
      machine: false,
      source: "exit",
    },
    {
      name: "a refused connection is the code's",
      log: "Error: connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap\n",
      why: "Error: connect ECONNREFUSED 127.0.0.1:5432",
      machine: false,
    },
    {
      name: "a bare ENOSPC on a healthy disk is not a machine problem",
      log: "Error: ENOSPC: System limit for number of file watchers reached\n",
      why: "Error: ENOSPC: System limit for number of file watchers reached",
      machine: false,
    },
    {
      name: "a bare ENOSPC on a low disk is",
      log: "Error: ENOSPC: write failed\n",
      input: { freeBytes: 1 * GIB },
      why: /^Ran out of disk space on box/,
      machine: true,
    },
    {
      name: "a failure line with machine:false beats a strong pattern",
      log: `${LIBNSPR}::t3o-failure::{"step":"e2e","reason":"3 snapshots differ","machine":false}\n`,
      what: "panel → e2e",
      why: "3 snapshots differ",
      machine: false,
      source: "failure-line",
    },
    {
      name: "a failure line without a flag leaves it to the patterns",
      log: `::t3o-failure::{"reason":"Chrome would not start"}\n${LIBNSPR}`,
      why: "Chrome would not start",
      machine: true,
      source: "failure-line",
    },
    {
      name: "a result-file failure",
      log: "lots of output\nError: boom\n",
      input: {
        result: result([{ title: "lint", detail: "src/a.ts:3 no-unused-vars\nmore" }]),
      },
      what: "panel → lint",
      why: "lint: src/a.ts:3 no-unused-vars",
      machine: false,
      source: "result-file",
    },
    {
      name: "a machine-flagged result-file failure",
      log: "output\n",
      input: {
        result: result([
          { title: "unit", detail: "1 failed" },
          { title: "browser", detail: "[env] Chrome could not start", machine: true },
        ]),
      },
      what: "panel → browser",
      why: "browser: [env] Chrome could not start",
      machine: true,
      source: "result-file",
    },
    {
      name: "an early libnspr4 warning, then a real assertion at the end",
      log: `${LIBNSPR}${passing(600)}  FAIL src/a.test.ts > adds\nAssertionError: expected 2 to be 3\n`,
      why: "FAIL src/a.test.ts > adds",
      machine: false,
      source: "pattern",
    },
    {
      name: "a short log: a recovered library warning, then a real assertion",
      log: `${LIBNSPR}${passing(20)}  FAIL src/a.test.ts > adds\nAssertionError: expected 2 to be 3\n`,
      input: { result: result([{ title: "a.test.ts", detail: "expected 2 to be 3" }]) },
      what: "panel → a.test.ts",
      why: "a.test.ts: expected 2 to be 3",
      machine: false,
      source: "result-file",
    },
    {
      name: "a short mocha log: a recovered library warning, then an AssertionError",
      log: `${LIBNSPR}${passing(20)}  1) adds:\n     AssertionError [ERR_ASSERTION]: expected 2 to be 3\n  1 failing\n`,
      why: "AssertionError [ERR_ASSERTION]: expected 2 to be 3",
      machine: false,
      source: "pattern",
    },
    {
      name: "a short Playwright log: the launch error around a missing library is a machine problem",
      log: `${passing(5)}  1) [chromium] › a.spec.ts:3:5 › opens\n    Error: browserType.launch: Target page, context or browser has been closed\n    Browser logs:\n${LIBNSPR}  Retry #1\n    Error: browserType.launch: Target page, context or browser has been closed\n    Browser logs:\n${LIBNSPR}  1 failed\n`,
      why: "Missing system library: libnspr4.so",
      machine: true,
      source: "machine",
    },
    {
      name: "a short Playwright log: a repeated launch error after the library line",
      log: `    Error: browserType.launch: Target page, context or browser has been closed\n${LIBNSPR}    Error: browserType.launch: Target page, context or browser has been closed\n  1 failed\n`,
      why: "Missing system library: libnspr4.so",
      machine: true,
      source: "machine",
    },
    {
      name: "a missing library at the end of a long log counts",
      log: `${passing(600)}${LIBNSPR}  FAIL src/browser.test.ts\n`,
      why: "Missing system library: libnspr4.so",
      machine: true,
      source: "machine",
    },
    {
      name: "an early Error: outside the end window is ignored",
      log: `Error: transient warning at boot\n${passing(600)}tests failed\n`,
      why: "tests failed",
      machine: false,
      source: "last-line",
    },
    {
      name: "a passing FAIL test name or an ERROR_CODES identifier is not picked",
      log: "  ✓ shows FAIL badge when FAIL\n  ✓ ERROR_CODES covers every case\nsomething broke\n",
      why: "something broke",
      machine: false,
      source: "last-line",
    },
    {
      name: "an empty result file is said",
      log: "",
      input: { resultEmpty: true, exitCode: 2 },
      why: "Exited with code 2 (its result file was empty)",
      machine: false,
      source: "exit",
    },
    {
      name: "colours and redraws are stripped before matching",
      log: "\u001b[31merror:\u001b[0m type mismatch\n",
      why: "error: type mismatch",
      machine: false,
    },
  ])("$name", ({ log, input, what, why, machine, source }) => {
    const headline = headlineOf(log, input);
    if (typeof why === "string") expect(headline.why).toBe(why);
    else expect(headline.why).toMatch(why);
    expect(headline.machine).toBe(machine);
    expect(headline.what).toBe(what ?? "panel");
    if (source !== undefined) expect(headline.source).toBe(source);
  });

  it("points at the line and byte offset the reason came from", () => {
    const headline = headlineOf("first\nsécond\nerror: here\n");
    expect(headline).toMatchObject({ logLine: 3, logOffset: "first\nsécond\n".length + 1 });
  });

  it("keeps the first failure line of a step", () => {
    const headline = headlineOf(
      '::t3o-failure::{"reason":"first"}\n::t3o-failure::{"reason":"second"}\n',
    );
    expect(headline).toMatchObject({ why: "first", logLine: 1, logOffset: 0 });
  });

  it("holds a z5-shaped 7 MB log with an [env] result-file failure", () => {
    const filler = "x".repeat(120);
    const lines = Array.from({ length: 56_000 }, (_, index) => `[${index}] ${filler}\n`).join("");
    const headline = headlineOf(`${LIBNSPR}${lines}Error: browser suite failed\n`, {
      result: result([
        { title: "panel-browser", detail: "[env] libnspr4.so missing", machine: true },
      ]),
    });
    expect(lines.length).toBeGreaterThan(7_000_000);
    expect(headline).toMatchObject({
      what: "panel → panel-browser",
      machine: true,
      source: "result-file",
    });
  });

  it("clamps what and why to the card's limits", () => {
    const headline = headlineOf(`error: ${"y".repeat(400)}\n`, { stepName: "s".repeat(120) });
    expect(headline.what.length).toBeLessThanOrEqual(80);
    expect(headline.why.length).toBeLessThanOrEqual(160);
  });
});

describe("boardCiMachineHoldReason", () => {
  it("names the machine, the problem and what to do", () => {
    const headline = headlineOf(LIBNSPR);
    expect(boardCiMachineHoldReason(headline, "linux-box")).toBe(
      "Machine problem on linux-box: Missing system library: libnspr4.so. Install the package that provides libnspr4.so. Then Retry CI.",
    );
  });

  it("keeps the fix and Retry CI within the card's 400 chars", () => {
    const headline = { ...headlineOf(LIBNSPR), why: "w".repeat(160), hint: "h".repeat(160) };
    const reason = boardCiMachineHoldReason(headline, "worker ".repeat(20));
    expect(reason.length).toBeLessThanOrEqual(400);
    expect(reason.endsWith(`${"h".repeat(160)} Then Retry CI.`)).toBe(true);
  });
});
