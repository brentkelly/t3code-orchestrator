// @effect-diagnostics nodeBuiltinImport:off - scans plain files and folders the server itself left.
/**
 * The server's own leftovers (T3O-123): `worker-status.json` temporary files a failed write left
 * in the T3 home, and Chromium profiles a killed preview browser left in the temp folder. Only
 * this user's, and only once nothing can still be using them.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const STATUS_TEMP = /^worker-status\.json\..+\.tmp$/;
const PROFILE_PREFIX = "playwright_chromiumdev_profile-";
const STATUS_TEMP_MIN_AGE_MS = 60 * 60 * 1000;
const PROFILE_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export interface ServerLeftoversInput {
  readonly home: string;
  readonly tempDir: string;
  readonly nowMs: number;
  readonly uid: number;
  readonly hostname: string;
  /** Whether a process with this id runs on this host. */
  readonly isAlive: (pid: number) => boolean;
}

/** Whether Chromium's `SingletonLock` (a `host-pid` symlink) names a live process here. */
const profileInUse = async (profile: string, input: ServerLeftoversInput): Promise<boolean> => {
  let target: string;
  try {
    target = await NodeFSP.readlink(NodePath.join(profile, "SingletonLock"));
  } catch {
    return false;
  }
  const dash = target.lastIndexOf("-");
  const host = target.slice(0, dash);
  const pid = Number(target.slice(dash + 1));
  return dash > 0 && host === input.hostname && Number.isInteger(pid) && input.isAlive(pid);
};

const entries = async (dir: string) => {
  try {
    return await NodeFSP.readdir(dir);
  } catch {
    return [];
  }
};

/** Removes what is stale and answers the paths it removed. */
export const sweepServerLeftovers = async (
  input: ServerLeftoversInput,
): Promise<ReadonlyArray<string>> => {
  const removed: Array<string> = [];
  const staleOwn = async (path: string, minAgeMs: number) => {
    try {
      const stat = await NodeFSP.lstat(path);
      return stat.uid === input.uid && input.nowMs - stat.mtimeMs >= minAgeMs;
    } catch {
      return false;
    }
  };
  for (const name of await entries(input.home)) {
    if (!STATUS_TEMP.test(name)) continue;
    const path = NodePath.join(input.home, name);
    if (!(await staleOwn(path, STATUS_TEMP_MIN_AGE_MS))) continue;
    await NodeFSP.rm(path, { force: true }).then(
      () => removed.push(path),
      () => undefined,
    );
  }
  for (const name of await entries(input.tempDir)) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    const path = NodePath.join(input.tempDir, name);
    if (!(await staleOwn(path, PROFILE_MIN_AGE_MS))) continue;
    if (await profileInUse(path, input)) continue;
    await NodeFSP.rm(path, { recursive: true, force: true }).then(
      () => removed.push(path),
      () => undefined,
    );
  }
  return removed;
};

/** This server's leftovers, as this user on this host. Unowned on a platform with no uid. */
export const sweepThisServerLeftovers = (home: string, nowMs: number) =>
  process.getuid === undefined
    ? Promise.resolve([])
    : sweepServerLeftovers({
        home,
        tempDir: NodeOS.tmpdir(),
        nowMs,
        uid: process.getuid(),
        hostname: NodeOS.hostname(),
        isAlive: isProcessAlive,
      });

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { readonly code?: string }).code === "EPERM";
  }
};
