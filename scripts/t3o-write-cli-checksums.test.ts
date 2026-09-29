// @effect-diagnostics nodeBuiltinImport:off -- Writes disposable archive files for checksum tests.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CLI_ARCHIVE_PLATFORM_KEYS,
  CLI_RELEASE_CHECKSUMS_FILE,
  cliArchiveFileName,
  parseChecksums,
} from "@t3tools/shared/cliRelease";
import { describe, expect, it } from "vite-plus/test";

import {
  expectedCliArchiveFileNames,
  writeCliArchiveChecksums,
} from "./t3o-write-cli-checksums.ts";

const VERSION = "0.0.42-t3o.1";

function withReleaseDir(populate: (dir: string) => void, run: (dir: string) => void): void {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-cli-checksums-"));
  try {
    populate(dir);
    run(dir);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

function writeArchive(dir: string, name: string, contents: string): void {
  NodeFS.writeFileSync(NodePath.join(dir, name), contents);
}

describe("expectedCliArchiveFileNames", () => {
  it("names one archive per CLI_ARCHIVE_PLATFORM_KEYS entry", () => {
    const names = expectedCliArchiveFileNames(VERSION);
    expect(names).toEqual(CLI_ARCHIVE_PLATFORM_KEYS.map((key) => cliArchiveFileName(VERSION, key)));
    expect(names).toHaveLength(CLI_ARCHIVE_PLATFORM_KEYS.length);
  });
});

describe("writeCliArchiveChecksums", () => {
  it("writes SHA256SUMS for every CLI_ARCHIVE_PLATFORM_KEYS archive", () => {
    withReleaseDir(
      (dir) => {
        for (const name of expectedCliArchiveFileNames(VERSION)) {
          writeArchive(dir, name, `${name}-bytes`);
        }
        writeArchive(dir, "latest-linux.yml", "not-an-archive");
      },
      (dir) => {
        const body = writeCliArchiveChecksums({ dir, version: VERSION });
        const checksums = parseChecksums(body);
        expect([...checksums.keys()]).toEqual(expectedCliArchiveFileNames(VERSION));
        for (const name of expectedCliArchiveFileNames(VERSION)) {
          const expectedHash = NodeCrypto.createHash("sha256")
            .update(`${name}-bytes`)
            .digest("hex");
          expect(checksums.get(name)).toBe(expectedHash);
        }
        expect(NodeFS.readFileSync(NodePath.join(dir, CLI_RELEASE_CHECKSUMS_FILE), "utf8")).toBe(
          body,
        );
      },
    );
  });

  it("fails when a CLI_ARCHIVE_PLATFORM_KEYS archive is missing", () => {
    const names = expectedCliArchiveFileNames(VERSION);
    withReleaseDir(
      (dir) => {
        for (const name of names.slice(1)) {
          writeArchive(dir, name, name);
        }
      },
      (dir) => {
        expect(() => writeCliArchiveChecksums({ dir, version: VERSION })).toThrow(
          names[0] ?? "missing",
        );
      },
    );
  });

  it("fails when an extra CLI archive is present", () => {
    withReleaseDir(
      (dir) => {
        for (const name of expectedCliArchiveFileNames(VERSION)) {
          writeArchive(dir, name, name);
        }
        writeArchive(dir, `t3-${VERSION}-darwin-x64.tar.gz`, "unexpected");
      },
      (dir) => {
        expect(() => writeCliArchiveChecksums({ dir, version: VERSION })).toThrow(
          `t3-${VERSION}-darwin-x64.tar.gz`,
        );
      },
    );
  });
});
