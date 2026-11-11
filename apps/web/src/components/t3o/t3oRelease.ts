/**
 * T3o: the build stamp and the "newer release" check behind Settings → About. Tag parsing
 * mirrors scripts/lib/t3o-release.ts, which app source cannot import.
 */

/** Written by scripts/t3o-service.mjs; see scripts/lib/t3o-release.ts `ReleaseStamp`. */
export interface T3oReleaseStamp {
  readonly tag: string | null;
  readonly version: string;
  readonly base: string | null;
  readonly commit: string;
}

export interface T3oLatestRelease {
  readonly tag: string;
  readonly url: string;
}

export const T3O_LATEST_RELEASE_API =
  "https://api.github.com/repos/brentkelly/t3code-orchestrator/releases/latest";
export const T3O_UPDATE_GUIDE_URL =
  "https://github.com/brentkelly/t3code-orchestrator/blob/t3o/docs/t3o/install.md#update-to-a-new-release";

const RELEASE_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 15 * 60 * 1000;

function parseTag(tag: string): readonly number[] | null {
  const match = /^t3o(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return match ? match.slice(1).map(Number) : null;
}

/** Positive when `a` is newer; null when either is not a T3o tag. */
export function compareTags(a: string, b: string): number | null {
  const left = parseTag(a);
  const right = parseTag(b);
  if (!left || !right) return null;
  const index = left.findIndex((part, position) => part !== right[position]);
  return index === -1 ? 0 : left[index]! - right[index]!;
}

export function versionLine(stamp: T3oReleaseStamp | ""): string {
  if (stamp === "") return "T3o dev";
  return stamp.base ? `T3o ${stamp.version} · T3 Code ${stamp.base}` : `T3o ${stamp.version}`;
}

/** The release to offer, only when it is newer than the tag this build came from. */
export function newerRelease(
  stamp: T3oReleaseStamp | "",
  latest: T3oLatestRelease | null,
): T3oLatestRelease | null {
  if (stamp === "" || stamp.tag === null || latest === null) return null;
  return (compareTags(latest.tag, stamp.tag) ?? 0) > 0 ? latest : null;
}

export function parseLatestRelease(body: unknown): T3oLatestRelease | null {
  if (typeof body !== "object" || body === null) return null;
  const { tag_name: tag, html_url: url } = body as Record<string, unknown>;
  if (typeof tag !== "string" || typeof url !== "string" || parseTag(tag) === null) return null;
  return { tag, url };
}

interface CacheEntry {
  readonly at: number;
  readonly failed: boolean;
  readonly release: T3oLatestRelease | null;
}

/** The cached answer while it is fresh, else undefined. Failures are retried sooner. */
export function readCache(raw: string | null, now: number): T3oLatestRelease | null | undefined {
  if (raw === null) return undefined;
  try {
    const entry = JSON.parse(raw) as CacheEntry;
    const ttl = entry.failed ? FAILURE_TTL_MS : RELEASE_TTL_MS;
    if (typeof entry.at !== "number" || now - entry.at >= ttl || now < entry.at) return undefined;
    return entry.failed ? null : parseLatestRelease(toApiShape(entry.release));
  } catch {
    return undefined;
  }
}

export function writeCache(release: T3oLatestRelease | null, failed: boolean, now: number): string {
  return JSON.stringify({ at: now, failed, release } satisfies CacheEntry);
}

const toApiShape = (release: T3oLatestRelease | null) =>
  release === null ? null : { tag_name: release.tag, html_url: release.url };
