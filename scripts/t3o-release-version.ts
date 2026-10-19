#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- A CI step that writes GitHub outputs.
/**
 * T3o: resolves and validates the version a T3o release builds (card T3O-1).
 *
 * A T3o version is the upstream version it is built on plus a fork counter,
 * `0.0.42-t3o.1`, released under the tag `v0.0.42-t3o.1`. The `v` prefix is
 * not cosmetic: the runtime installers build download URLs and read the
 * release index as `v<version>` (packages/shared/src/cliRelease.ts).
 *
 *   node scripts/t3o-release-version.ts --event push --ref-name v0.0.42-t3o.1 --github-output
 *   node scripts/t3o-release-version.ts --event workflow_dispatch --version 0.0.42-t3o.1
 */
import * as NodeFS from "node:fs";

import { isT3oReleaseVersion, T3O_PRODUCT_NAME } from "@t3tools/shared/t3oIdentity";

export interface T3oReleaseVersion {
  readonly version: string;
  readonly tag: string;
  readonly name: string;
}

export function resolveT3oReleaseVersion(input: {
  readonly eventName: string;
  readonly refName: string | undefined;
  readonly dispatchVersion: string | undefined;
}): T3oReleaseVersion {
  let raw: string;
  if (input.eventName === "push") {
    raw = input.refName?.trim() ?? "";
    if (!raw.startsWith("v")) {
      throw new Error(`A T3o release tag must be v<version>, got "${raw}".`);
    }
  } else if (input.eventName === "workflow_dispatch") {
    raw = input.dispatchVersion?.trim() ?? "";
    if (raw === "") throw new Error("A dispatched T3o release needs a version input.");
  } else {
    throw new Error(`T3o releases run on a tag push or a dispatch, not "${input.eventName}".`);
  }

  const version = raw.replace(/^v/, "");
  if (!isT3oReleaseVersion(version)) {
    throw new Error(
      `"${raw}" is not a T3o version. Use <upstream version>-t3o.<n>, for example 0.0.42-t3o.1.`,
    );
  }
  return { version, tag: `v${version}`, name: `${T3O_PRODUCT_NAME} v${version}` };
}

function flag(argv: ReadonlyArray<string>, name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const resolved = resolveT3oReleaseVersion({
    eventName: flag(argv, "--event") ?? "",
    refName: flag(argv, "--ref-name"),
    dispatchVersion: flag(argv, "--version"),
  });
  const lines = Object.entries(resolved).map(([key, value]) => `${key}=${value}`);
  console.log(lines.join("\n"));
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (argv.includes("--github-output") && githubOutput) {
    NodeFS.appendFileSync(githubOutput, `${lines.join("\n")}\n`);
  }
}
