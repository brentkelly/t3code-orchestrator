/**
 * What a failed CI step says failed and why (T3O-61). Pure: the runner feeds
 * every output line of a step to `BoardCiFailureFacts` as it runs, and once a
 * step has failed or timed out asks it for the headline, with the step's exit
 * and result file. Only the failed step's own log is read.
 *
 * The order the reason is picked in, first match wins:
 * 1. The script's `::t3o-failure::` line, or a result-file failure it flagged
 *    `machine: true` (a script's flag always wins over a pattern).
 * 2. A strong machine pattern: a missing shared library, no space left, a
 *    read-only filesystem.
 * 3. A weak machine pattern the exit agrees with: exit 127, a kill with 137 or
 *    SIGKILL and no timeout, a bare ENOSPC on a disk that is low now.
 * 4. The result file's first failure.
 * 5. A tool that stopped the step outright ("No files matching the pattern").
 * 6. The first anchored error line in the end window (the last 500 lines).
 * 7. The last meaningful line.
 * 8. The exit code, or the time limit.
 */
import {
  clampBoardCiHeadline,
  parseBoardCiFailureLine,
  type BoardCiHeadline,
  type BoardCiStepResult,
} from "@t3tools/contracts";

import type { BoardCiLine } from "./BoardCiRunner.ts";

/** The end window: generic patterns only count in the last lines of a log,
    so a passing test's early noise is never the reason. */
const END_WINDOW_LINES = 500;
const END_WINDOW_CHARS = 64 * 1024;
/** Longest line a fact keeps; the rest is never shown. */
const FACT_LINE_CHARS = 1_000;
/** A bare ENOSPC is a machine problem only when the disk is still this low. */
const LOW_DISK_BYTES = 2 * 1024 ** 3;

// oxlint-disable-next-line no-control-regex -- ANSI escapes are control bytes.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

const SHARED_LIBRARY =
  /error while loading shared libraries|cannot open shared object file/;
const LIBRARY_NAME = [
  /error while loading shared libraries:\s*([^\s:]+)/,
  /([\w.+-]+\.so(?:\.[\w.]+)?)\s*:\s*cannot open shared object file/,
];
const NO_SPACE = /No space left on device/;
const READ_ONLY = /Read-only file system/;
const BARE_ENOSPC = /\bENOSPC\b/;
const KILLED = /\bKilled\b|\b[Oo]ut of memory\b/;
const NOT_FOUND = /(?:^|[\s:])([\w./+@-]+): (?:command )?not found\b/;
const FATAL_ANYWHERE = [
  /No files matching the pattern/,
  /Cannot find module/,
  /ENOENT.*package\.json|package\.json.*ENOENT/,
];
const GENERIC = [
  /\berror:/,
  /\bError:/,
  /^\s*ERROR\b/,
  /^\s*FAIL\b/,
  /ERR!/,
  /panicked at/,
  /Traceback/,
  /exit status/,
];

interface Fact {
  readonly text: string;
  readonly lineNo: number;
  readonly byteOffset: number;
}

/** What one line of a log shows once its colours and redraws are gone. */
const visibleText = (line: string): string => {
  const plain = line.replace(ANSI, "");
  const redraw = plain.lastIndexOf("\r");
  return (redraw === -1 ? plain : plain.slice(redraw + 1)).trim().slice(0, FACT_LINE_CHARS);
};

const isBoardLine = (text: string) => text.startsWith("[board]");

/** The facts a step's log shows, collected line by line while it runs. */
export class BoardCiFailureFacts {
  failureLine: (Fact & ReturnType<typeof parseBoardCiFailureLine> & {}) | null = null;
  library: Fact | null = null;
  noSpace: Fact | null = null;
  readOnly: Fact | null = null;
  enospc: Fact | null = null;
  killed: Fact | null = null;
  notFound: (Fact & { readonly command: string }) | null = null;
  fatal: Fact | null = null;
  lastMeaningful: Fact | null = null;
  private window: Fact[] = [];
  private windowChars = 0;

  push(line: BoardCiLine): void {
    const text = visibleText(line.line);
    if (text.length === 0) return;
    const fact: Fact = { text, lineNo: line.lineNo, byteOffset: line.byteOffset };
    if (this.failureLine === null) {
      const parsed = parseBoardCiFailureLine(line.line);
      if (parsed !== null) {
        this.failureLine = { ...fact, ...parsed };
        return;
      }
    }
    if (isBoardLine(text)) return;
    if (this.library === null && SHARED_LIBRARY.test(text)) this.library = fact;
    if (this.noSpace === null && NO_SPACE.test(text)) this.noSpace = fact;
    if (this.readOnly === null && READ_ONLY.test(text)) this.readOnly = fact;
    if (this.enospc === null && BARE_ENOSPC.test(text)) this.enospc = fact;
    if (this.killed === null && KILLED.test(text)) this.killed = fact;
    if (this.notFound === null) {
      const command = NOT_FOUND.exec(text)?.[1];
      if (command !== undefined) this.notFound = { ...fact, command };
    }
    if (this.fatal === null && FATAL_ANYWHERE.some((pattern) => pattern.test(text))) {
      this.fatal = fact;
    }
    this.lastMeaningful = fact;
    this.window.push(fact);
    this.windowChars += text.length;
    while (
      this.window.length > END_WINDOW_LINES ||
      (this.windowChars > END_WINDOW_CHARS && this.window.length > 1)
    ) {
      this.windowChars -= this.window.shift()!.text.length;
    }
  }

  /** The first line of the end window, so a fact can say whether it is in it. */
  windowStart(): number {
    return this.window[0]?.lineNo ?? Number.POSITIVE_INFINITY;
  }

  /** The first line in the end window matching `patterns`. */
  firstInWindow(patterns: ReadonlyArray<RegExp>, after = 0): Fact | null {
    return (
      this.window.find(
        (fact) => fact.lineNo > after && patterns.some((pattern) => pattern.test(fact.text)),
      ) ?? null
    );
  }
}

export interface BoardCiHeadlineInput {
  readonly stepName: string;
  readonly status: "failed" | "timed-out";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timeoutMinutes: number;
  readonly result: BoardCiStepResult | null;
  /** The step wrote its result file but left it empty. */
  readonly resultEmpty: boolean;
  /** The machine the step ran on, and its disk's free bytes now. */
  readonly host: string;
  readonly freeBytes: number | null;
}

interface Verdict {
  readonly why: string;
  readonly fact: Fact | null;
  readonly source: BoardCiHeadline["source"];
  readonly machine: boolean;
  readonly hint?: string;
  /** The sub-step this reason names, if any. */
  readonly subStep?: string | null;
}

const libraryName = (text: string): string | null => {
  for (const pattern of LIBRARY_NAME) {
    const name = pattern.exec(text)?.[1];
    if (name !== undefined) return name;
  }
  return null;
};

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

const firstDetailLine = (detail: string | undefined): string | null => {
  const line = detail
    ?.split("\n")
    .map((part) => visibleText(part))
    .find((part) => part.length > 0);
  return line === undefined ? null : line;
};

/** A machine pattern's verdict: strong ones first, then weak ones the exit
    agrees with. Null when the log shows no machine problem. */
function machineVerdict(facts: BoardCiFailureFacts, input: BoardCiHeadlineInput): Verdict | null {
  const timedOut = input.status === "timed-out";
  const diskWhy = () =>
    `Ran out of disk space on ${input.host}${input.freeBytes === null ? "" : ` (${gib(input.freeBytes)} free now)`}`;
  if (facts.noSpace !== null) {
    return {
      why: diskWhy(),
      fact: facts.noSpace,
      source: "machine",
      machine: true,
      hint: `Free disk space on ${input.host}.`,
    };
  }
  if (facts.readOnly !== null) {
    return {
      why: `Read-only file system on ${input.host}: ${facts.readOnly.text}`,
      fact: facts.readOnly,
      source: "machine",
      machine: true,
      hint: `Make the filesystem writable on ${input.host}.`,
    };
  }
  // Optional native modules print a missing library and recover, so it only
  // counts in the end window, or when nothing later or reported explains it.
  const library = facts.firstInWindow([SHARED_LIBRARY]) ?? facts.library;
  if (library !== null) {
    const inWindow = library.lineNo >= facts.windowStart();
    const laterGeneric = facts.firstInWindow(GENERIC, library.lineNo);
    const codeFailureReported =
      input.result?.failures.some((failure) => failure.machine !== true) ?? false;
    if (inWindow || (laterGeneric === null && !codeFailureReported)) {
      const lib = libraryName(library.text);
      return {
        why: `Missing system library: ${lib ?? library.text}`,
        fact: library,
        source: "machine",
        machine: true,
        hint:
          lib === null
            ? `Install the missing system library on ${input.host}.`
            : `Install the package that provides ${lib} on ${input.host}.`,
      };
    }
  }
  if (input.exitCode === 127) {
    const command = facts.notFound?.command ?? null;
    return {
      why:
        command === null
          ? "A tool the script needs isn't installed"
          : `A tool the script needs isn't installed: ${command}`,
      fact: facts.notFound,
      source: "machine",
      machine: true,
      hint:
        command === null
          ? `Install the missing tool on ${input.host}.`
          : `Install ${command} on ${input.host}.`,
    };
  }
  if (!timedOut && (input.exitCode === 137 || input.signal === "SIGKILL")) {
    return {
      why: "Killed (out of memory?)",
      fact: facts.killed,
      source: "machine",
      machine: true,
      hint: `Free memory on ${input.host}, or run fewer steps at once.`,
    };
  }
  if (facts.enospc !== null && input.freeBytes !== null && input.freeBytes < LOW_DISK_BYTES) {
    return {
      why: diskWhy(),
      fact: facts.enospc,
      source: "machine",
      machine: true,
      hint: `Free disk space on ${input.host}.`,
    };
  }
  return null;
}

/** The step's verdict before it is shaped into a headline. */
function pickVerdict(facts: BoardCiFailureFacts, input: BoardCiHeadlineInput): Verdict {
  const failures = input.result?.failures ?? [];
  const firstFailure = failures[0] ?? null;
  const flagged = failures.find((failure) => failure.machine === true) ?? null;
  const line = facts.failureLine;
  // The script's own word on whether this is the machine: its failure line,
  // else its result file. Absent leaves it to the patterns.
  const scriptMachine: boolean | null =
    line?.machine ?? (flagged !== null ? true : firstFailure?.machine === false ? false : null);
  const machine = scriptMachine === false ? null : machineVerdict(facts, input);

  if (line !== null) {
    const isMachine = scriptMachine ?? machine !== null;
    return {
      why: line.reason,
      fact: line,
      source: "failure-line",
      machine: isMachine,
      subStep: line.step ?? firstFailure?.title ?? null,
      ...(isMachine
        ? { hint: machine?.hint ?? `Fix it on ${input.host}.` }
        : {}),
    };
  }
  if (flagged !== null) {
    const detail = firstDetailLine(flagged.detail);
    return {
      why: detail === null ? flagged.title : `${flagged.title}: ${detail}`,
      fact: null,
      source: "result-file",
      machine: true,
      subStep: flagged.title,
      hint: machine?.hint ?? `Fix it on ${input.host}.`,
    };
  }
  if (machine !== null) return machine;
  if (firstFailure !== null) {
    const detail = firstDetailLine(firstFailure.detail);
    return {
      why: detail === null ? firstFailure.title : `${firstFailure.title}: ${detail}`,
      fact: null,
      source: "result-file",
      machine: false,
      subStep: firstFailure.title,
    };
  }
  if (facts.fatal !== null) {
    return { why: facts.fatal.text, fact: facts.fatal, source: "pattern", machine: false };
  }
  const generic = facts.firstInWindow(GENERIC);
  if (generic !== null) {
    return { why: generic.text, fact: generic, source: "pattern", machine: false };
  }
  // A hung step's last line is rarely why it hung: the limit is.
  if (input.status !== "timed-out" && facts.lastMeaningful !== null) {
    return {
      why: facts.lastMeaningful.text,
      fact: facts.lastMeaningful,
      source: "last-line",
      machine: false,
    };
  }
  return {
    why:
      input.status === "timed-out"
        ? `Timed out after ${input.timeoutMinutes} min`
        : input.exitCode === null
          ? input.signal === null
            ? "Ended without an exit code"
            : `Killed by ${input.signal}`
          : `Exited with code ${input.exitCode}`,
    fact: null,
    source: "exit",
    machine: false,
  };
}

/** The headline of a failed or timed-out step. */
export function boardCiFailureHeadline(
  facts: BoardCiFailureFacts,
  input: BoardCiHeadlineInput,
): BoardCiHeadline {
  const verdict = pickVerdict(facts, input);
  const subStep = verdict.subStep ?? null;
  const why = input.resultEmpty ? `${verdict.why} (its result file was empty)` : verdict.why;
  return (
    clampBoardCiHeadline({
      what: subStep === null ? input.stepName : `${input.stepName} → ${subStep}`,
      why,
      machine: verdict.machine,
      logLine: verdict.fact?.lineNo ?? null,
      logOffset: verdict.fact?.byteOffset ?? null,
      source: verdict.source,
      hint: verdict.hint,
    }) ?? {
      what: input.stepName.slice(0, 80) || "CI",
      why: "Failed",
      machine: false,
      logLine: null,
      logOffset: null,
      source: "exit",
    }
  );
}

/** A step that passed but whose group left tracked changes behind. */
export function boardCiDirtyHeadline(stepName: string, dirty: string): BoardCiHeadline | null {
  const first = dirty.split("\n")[0]?.slice(3).trim() ?? "";
  return clampBoardCiHeadline({
    what: stepName,
    why: `Left tracked changes in the worktree${first.length === 0 ? "" : `: ${first}`}`,
    machine: false,
    logLine: null,
    logOffset: null,
    source: "board",
  });
}

/** The hold reason a machine headline gives the card. */
export function boardCiMachineHoldReason(headline: BoardCiHeadline, where: string): string {
  const why = headline.why.replace(/[.\s]+$/, "");
  return `Machine problem on ${where}: ${why}. ${headline.hint ?? "Fix it on the machine."} Then Retry CI.`;
}
