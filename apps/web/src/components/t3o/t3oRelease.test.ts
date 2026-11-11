import { describe, expect, it } from "vite-plus/test";

import {
  compareTags,
  newerRelease,
  parseLatestRelease,
  readCache,
  versionLine,
  writeCache,
  type T3oReleaseStamp,
} from "./t3oRelease";

const stamp = (tag: string | null, version: string, base: string | null): T3oReleaseStamp => ({
  tag,
  version,
  base,
  commit: "abc1234def",
});

const release = (tag: string) => ({ tag, url: `https://github.com/x/releases/tag/${tag}` });

describe("t3oRelease", () => {
  it("compares tags numerically and rejects non-T3o tags", () => {
    expect(compareTags("t3o0.1.10.1", "t3o0.1.9.9")).toBeGreaterThan(0);
    expect(compareTags("t3o0.1.8.2", "t3o0.1.8.10")).toBeLessThan(0);
    expect(compareTags("t3o0.1.8.2", "t3o0.1.8.2")).toBe(0);
    expect(compareTags("v0.1.9", "t3o0.1.8.2")).toBeNull();
  });

  it.each([
    ["", "T3o dev"],
    [stamp("t3o0.1.8.1", "0.1.8.1", "0.1.8"), "T3o 0.1.8.1 · T3 Code 0.1.8"],
    [stamp("t3o0.1.8.1", "0.1.8.1+3.gabc1234", "0.1.8"), "T3o 0.1.8.1+3.gabc1234 · T3 Code 0.1.8"],
    [stamp(null, "dev (abc1234)", null), "T3o dev (abc1234)"],
  ] as const)("shows %j as %s", (input, expected) => {
    expect(versionLine(input)).toBe(expected);
  });

  it("offers a release only when it is newer than the build's tag", () => {
    const built = stamp("t3o0.1.8.1", "0.1.8.1+3.gabc1234", "0.1.8");
    expect(newerRelease(built, release("t3o0.1.8.2"))).toEqual(release("t3o0.1.8.2"));
    expect(newerRelease(built, release("t3o0.1.8.1"))).toBeNull();
    expect(newerRelease(built, release("t3o0.1.7.9"))).toBeNull();
    expect(newerRelease(built, null)).toBeNull();
    expect(newerRelease("", release("t3o9.0.0.1"))).toBeNull();
    expect(newerRelease(stamp(null, "dev (abc1234)", null), release("t3o9.0.0.1"))).toBeNull();
  });

  it("keeps only T3o tags from the GitHub response", () => {
    expect(parseLatestRelease({ tag_name: "t3o0.1.8.2", html_url: "https://x" })).toEqual({
      tag: "t3o0.1.8.2",
      url: "https://x",
    });
    expect(parseLatestRelease({ tag_name: "v0.1.9", html_url: "https://x" })).toBeNull();
    expect(parseLatestRelease({ message: "API rate limit exceeded" })).toBeNull();
    expect(parseLatestRelease(null)).toBeNull();
  });

  it("caches a release for 6h and a failure for 15m", () => {
    const hour = 60 * 60 * 1000;
    const found = writeCache(release("t3o0.1.8.2"), false, 0);
    expect(readCache(found, 5 * hour)).toEqual(release("t3o0.1.8.2"));
    expect(readCache(found, 6 * hour)).toBeUndefined();

    const failed = writeCache(null, true, 0);
    expect(readCache(failed, 14 * 60 * 1000)).toBeNull();
    expect(readCache(failed, 15 * 60 * 1000)).toBeUndefined();

    expect(readCache(writeCache(null, false, 0), hour)).toBeNull();
    expect(readCache(null, 0)).toBeUndefined();
    expect(readCache("{not json", 0)).toBeUndefined();
    expect(readCache(found, -1)).toBeUndefined();
  });
});
