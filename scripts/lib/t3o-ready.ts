/**
 * T3o: the pure half of `scripts/t3o-ready.ts`, the board worker readiness check.
 * Erasable TypeScript and no imports: the check runs before `pnpm install`.
 */

export type Status = "pass" | "warn" | "fail" | "skip";

export interface CheckResult {
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
  readonly fix?: string;
}

export type Version = readonly [number, number, number];

/** `26.12.1`, `v26.12.1`, `pnpm@12.14.0+sha512...`; null for ranges and garbage. */
export function parseVersion(text: string | undefined | null): Version | null {
  const match = /^(?:[\w-]+@)?v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec((text ?? "").trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export const formatVersion = (version: Version) => version.join(".");

/**
 * A tool against the repo's exact pin: another major fails, any other difference warns.
 * A pin that is not one exact version is not ours to judge, so it skips.
 */
export function checkPinnedVersion(input: {
  readonly name: string;
  readonly actual: string | null;
  readonly pin: string | undefined;
  readonly pinSource: string;
  readonly fix: string;
}): CheckResult {
  const { name, fix } = input;
  const pin = parseVersion(input.pin);
  if (pin === null) {
    return {
      name,
      status: "skip",
      detail: `${input.pinSource} is not one exact version (${input.pin ?? "missing"})`,
    };
  }
  const wanted = formatVersion(pin);
  if (input.actual === null) return { name, status: "fail", detail: "not found on PATH", fix };
  const actual = parseVersion(input.actual);
  if (actual === null) {
    return { name, status: "fail", detail: `unreadable version "${input.actual}"`, fix };
  }
  const got = formatVersion(actual);
  if (actual[0] !== pin[0]) {
    return { name, status: "fail", detail: `${got}, but ${input.pinSource} pins ${wanted}`, fix };
  }
  if (got !== wanted) {
    return { name, status: "warn", detail: `${got}, ${input.pinSource} pins ${wanted}`, fix };
  }
  return { name, status: "pass", detail: got };
}

/** Drops credentials from every URL in `text` (`https://user:token@host/...`). */
export function redactCredentials(text: string): string {
  return text.replace(/\b([a-z][\w+.-]*:\/\/)[^/@\s]+@/gi, "$1***@");
}

/** Playwright's install directory names for the browsers vitest's chromium instance may launch. */
export function chromiumInstallDirs(browsersJson: unknown): Array<string> {
  const browsers = (browsersJson as { browsers?: ReadonlyArray<unknown> } | null)?.browsers ?? [];
  const dirs: Array<string> = [];
  for (const entry of browsers) {
    const { name, revision } = (entry ?? {}) as { name?: unknown; revision?: unknown };
    if (typeof name !== "string" || typeof revision !== "string") continue;
    if (name !== "chromium" && name !== "chromium-headless-shell") continue;
    dirs.push(`${name.replace(/-/g, "_")}-${revision}`);
  }
  return dirs;
}

/** The one-line summary the board shows: ready unless anything failed. */
export function verdict(results: ReadonlyArray<CheckResult>): {
  readonly ready: boolean;
  readonly line: string;
} {
  const count = (status: Status) => results.filter((result) => result.status === status);
  const failed = count("fail");
  const warned = count("warn");
  const tally = `${count("pass").length} pass, ${warned.length} warn, ${failed.length} fail, ${count("skip").length} skip`;
  if (failed.length > 0) {
    return {
      ready: false,
      line: `NOT READY: ${failed.map((result) => result.name).join(", ")} failed (${tally})`,
    };
  }
  const warnings = warned.length > 0 ? `; warnings: ${warned.map((r) => r.name).join(", ")}` : "";
  return { ready: true, line: `READY (${tally})${warnings}` };
}

const COLOURS: Record<Status, string> = {
  pass: "\x1b[32m",
  warn: "\x1b[33m",
  fail: "\x1b[31m",
  skip: "\x1b[2m",
};

/** One check as aligned text; colour only when the caller says stdout is a terminal. */
export function formatResult(result: CheckResult, colour: boolean): string {
  const label = result.status.padEnd(4);
  const status = colour ? `${COLOURS[result.status]}${label}\x1b[0m` : label;
  const head = `  ${status}  ${result.name.padEnd(16)} ${result.detail}`;
  return result.fix && result.status !== "pass"
    ? `${head}\n${" ".repeat(25)}fix: ${result.fix}`
    : head;
}
