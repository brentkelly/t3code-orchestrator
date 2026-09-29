#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- A CI step that hashes release archives.
/**
 * T3o: writes SHA256SUMS for the CLI archives a T3o release attaches
 * (card T3O-1). Names come from CLI_ARCHIVE_PLATFORM_KEYS via
 * cliArchiveFileName, so an upstream sync that adds or drops a platform
 * key fails this step with the missing or extra file names instead of a
 * hardcoded count.
 *
 *   node scripts/t3o-write-cli-checksums.ts --dir release-assets --version 0.0.42-t3o.1
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  CLI_ARCHIVE_PLATFORM_KEYS,
  CLI_RELEASE_CHECKSUMS_FILE,
  cliArchiveFileName,
} from "@t3tools/shared/cliRelease";

const CLI_ARCHIVE_FILE_NAME = /^t3-.+\.(?:tar\.gz|zip)$/;

export function expectedCliArchiveFileNames(version: string): string[] {
  return CLI_ARCHIVE_PLATFORM_KEYS.map((key) => cliArchiveFileName(version, key));
}

function listedCliArchiveFileNames(dir: string): string[] {
  return NodeFS.readdirSync(dir).filter((name) => CLI_ARCHIVE_FILE_NAME.test(name));
}

export function writeCliArchiveChecksums(input: {
  readonly dir: string;
  readonly version: string;
}): string {
  const expected = expectedCliArchiveFileNames(input.version);
  const present = listedCliArchiveFileNames(input.dir);
  const expectedSet = new Set(expected);
  const missing = expected.filter((name) => !present.includes(name));
  const extra = present.filter((name) => !expectedSet.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `CLI archives must match CLI_ARCHIVE_PLATFORM_KEYS (${String(expected.length)}): missing [${missing.join(", ")}]; extra [${extra.join(", ")}].`,
    );
  }

  const lines = expected.map((name) => {
    const hash = NodeCrypto.createHash("sha256")
      .update(NodeFS.readFileSync(NodePath.join(input.dir, name)))
      .digest("hex");
    return `${hash}  ${name}`;
  });
  const body = `${lines.join("\n")}\n`;
  NodeFS.writeFileSync(NodePath.join(input.dir, CLI_RELEASE_CHECKSUMS_FILE), body);
  return body;
}

function flag(argv: ReadonlyArray<string>, name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dir = flag(argv, "--dir");
  const version = flag(argv, "--version");
  if (dir === undefined || dir === "" || version === undefined || version === "") {
    throw new Error(
      "Usage: node scripts/t3o-write-cli-checksums.ts --dir <dir> --version <version>",
    );
  }
  process.stdout.write(writeCliArchiveChecksums({ dir, version }));
}
