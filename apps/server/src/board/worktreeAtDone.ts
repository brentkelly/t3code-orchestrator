// @effect-diagnostics nodeBuiltinImport:off - strip walks and deletes plain files, symlinks unfollowed.
/**
 * What a worker does to a finished card's worktree besides removing it (T3O-123): snapshot
 * uncommitted work into a private ref before a forced removal, strip the files git ignores
 * from a worktree that stays, prune old snapshot refs, and delete a deleted card's leftover
 * local branch. Each runs where the worktree is, behind the worker's own path guards.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  BOARD_DISCARDED_REF_PREFIX,
  BoardWorkerGitError,
  type BoardWorkspaceSnapshotResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  SETUP_DONE_MARKER,
  SETUP_FAILED_MARKER,
  STRIP_PENDING_MARKER,
  STRIPPED_MARKER,
} from "./capacity/cardSetup.ts";

/** Ignored entries a strip leaves: small, and often hand-made (secrets, editor settings). */
const KEPT_FOLDERS = new Set([".claude", ".vscode", ".idea"]);

const isKeptName = (name: string) => name.startsWith(".env") || KEPT_FOLDERS.has(name);

export const isKeptIgnoredEntry = (entry: string): boolean => {
  const segments = entry.split("/").filter((segment) => segment.length > 0);
  const base = segments.at(-1) ?? "";
  return base.startsWith(".env") || segments.some((segment) => KEPT_FOLDERS.has(segment));
};

/** Whether anything under `path` must survive a strip: a kept name or a nested repository. */
const holdsKept = async (path: string): Promise<boolean> => {
  const entries = await NodeFSP.readdir(path, { withFileTypes: true }).catch(() => null);
  if (entries === null) return false;
  for (const entry of entries) {
    if (entry.name === ".git" || isKeptName(entry.name)) return true;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && (await holdsKept(NodePath.join(path, entry.name)))) return true;
  }
  return false;
};

/**
 * Delete one ignored entry. `ls-files --directory` collapses a wholly ignored directory into
 * one entry, so a directory holding a kept file or a nested repository is walked instead:
 * a nested repository is left whole (its own commits may exist nowhere else), and the rest
 * is deleted around what is kept.
 */
const stripEntry = async (path: string): Promise<{ freed: number; failed: number }> => {
  const stat = await NodeFSP.lstat(path).catch(() => null);
  if (stat === null) return { freed: 0, failed: 0 };
  if (stat.isDirectory() && (await holdsKept(path))) {
    const children = await NodeFSP.readdir(path).catch(() => null);
    if (children === null) return { freed: 0, failed: 1 };
    if (children.includes(".git")) return { freed: 0, failed: 0 };
    let freed = 0;
    let failed = 0;
    for (const child of children) {
      if (isKeptName(child)) continue;
      const result = await stripEntry(NodePath.join(path, child));
      freed += result.freed;
      failed += result.failed;
    }
    return { freed, failed };
  }
  const bytes = await diskBytes(path);
  return NodeFSP.rm(path, { recursive: true, force: true }).then(
    () => ({ freed: bytes, failed: 0 }),
    () => ({ freed: 0, failed: 1 }),
  );
};

/** Bytes for activity text: GB from one up, else MB. */
export const formatBoardBytes = (bytes: number): string => {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
};

/** Bytes under `path`, not following symlinks. Unreadable entries count as zero. */
const diskBytes = async (path: string): Promise<number> => {
  let stat: Awaited<ReturnType<typeof NodeFSP.lstat>>;
  try {
    stat = await NodeFSP.lstat(path);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.isFile() ? stat.size : 0;
  let entries: ReadonlyArray<string>;
  try {
    entries = await NodeFSP.readdir(path);
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) total += await diskBytes(NodePath.join(path, entry));
  return total;
};

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const run = (
  git: GitVcsDriver.GitVcsDriver["Service"],
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
) =>
  git
    .execute({
      operation: `boardWorktreeAtDone.${operation}`,
      cwd,
      args,
      allowNonZeroExit: true,
      timeoutMs: 120_000,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      ...(env === undefined ? {} : { env }),
    })
    .pipe(
      // A cut-off listing must not be acted on (a truncated path can name a tracked directory),
      // so it reads as a failed command, which every caller already refuses.
      Effect.map((result) =>
        result.stdoutTruncated
          ? {
              ...result,
              exitCode: ChildProcessSpawner.ExitCode(1),
              stderr: `git ${args[0] ?? ""} output exceeded ${formatBoardBytes(MAX_OUTPUT_BYTES)}`,
            }
          : result,
      ),
    );

/** `yyyymmddThhmmss` in UTC, for a snapshot ref's name. */
export const snapshotStamp = (nowMs: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(nowMs))
    .replace(/(\.\d+)?Z$/, "")
    .replaceAll("-", "")
    .replaceAll(":", "");

/** Paths `status --porcelain -z` names, the second of a rename pair skipped. */
const statusPaths = (stdout: string): ReadonlyArray<{ code: string; path: string }> => {
  const fields = stdout.split("\0");
  const paths: Array<{ code: string; path: string }> = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    paths.push({ code, path: field.slice(3) });
    if (code.includes("R") || code.includes("C")) index += 1;
  }
  return paths;
};

const SNAPSHOT_STAMP = /^\d{8}T\d{6}$/;

/** The card's newest snapshot ref, with its tree and (single) parent; null when it has none. */
const newestSnapshotRef = Effect.fn("newestSnapshotRef")(function* (
  git: GitVcsDriver.GitVcsDriver["Service"],
  cwd: string,
  cardKey: string,
) {
  const listed = yield* run(git, "listSnapshots", cwd, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(tree)%00%(parent)",
    BOARD_DISCARDED_REF_PREFIX,
  ]);
  if (listed.exitCode !== 0) return null;
  const prefix = `${BOARD_DISCARDED_REF_PREFIX}${cardKey}-`;
  let newest: { ref: string; sha: string; tree: string; parent: string } | null = null;
  for (const line of listed.stdout.split("\n")) {
    const [ref, sha, tree, parent] = line.split("\0");
    if (ref === undefined || sha === undefined || tree === undefined || parent === undefined) {
      continue;
    }
    if (!ref.startsWith(prefix) || !SNAPSHOT_STAMP.test(ref.slice(prefix.length))) continue;
    if (newest === null || ref > newest.ref) newest = { ref, sha, tree, parent };
  }
  return newest;
});

/**
 * Save the worktree's uncommitted and untracked (not ignored) work as a commit on top of HEAD,
 * under `refs/t3o/discarded/<key>-<stamp>`, without touching the worktree or its index. Over
 * `capBytes` of changed files it saves nothing. Fails on any git error, and on changes in a
 * nested repository or submodule: the caller must then not force the removal.
 */
export const snapshotBoardWorktree = Effect.fn("snapshotBoardWorktree")(function* (input: {
  readonly worktreePath: string;
  readonly cardKey: string;
  readonly capBytes: number;
  readonly nowMs: number;
}) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fail = (step: string, result: { readonly stderr: string }) =>
    Effect.fail(
      new BoardWorkerGitError({
        operation: "snapshotWorktree",
        detail: `git ${step} failed: ${result.stderr.trim().split("\n").at(-1) ?? ""}`,
      }),
    );
  const status = yield* run(git, "status", input.worktreePath, [
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=all",
  ]);
  if (status.exitCode !== 0) return yield* fail("status", status);
  const changed = statusPaths(status.stdout);
  if (changed.length === 0) return { outcome: "nothing" } satisfies BoardWorkspaceSnapshotResult;

  let bytes = 0;
  for (const entry of changed) {
    bytes += yield* Effect.promise(() => diskBytes(NodePath.join(input.worktreePath, entry.path)));
  }
  if (bytes > input.capBytes) {
    return { outcome: "over-cap", bytes } satisfies BoardWorkspaceSnapshotResult;
  }
  // `add -A` records a nested repository or submodule as a bare commit pointer, so its own
  // uncommitted or unpushed work would not be in the snapshot.
  for (const entry of changed) {
    const nested = NodePath.join(input.worktreePath, entry.path, ".git");
    if (
      yield* Effect.promise(() =>
        NodeFSP.lstat(nested).then(
          () => true,
          () => false,
        ),
      )
    ) {
      return yield* new BoardWorkerGitError({
        operation: "snapshotWorktree",
        detail: `${entry.path.replace(/\/$/, "")} is a nested repository or submodule with changes, which a snapshot can't hold`,
      });
    }
  }

  const gitDir = yield* run(git, "gitDir", input.worktreePath, ["rev-parse", "--absolute-git-dir"]);
  if (gitDir.exitCode !== 0) return yield* fail("rev-parse", gitDir);
  const index = NodePath.join(
    gitDir.stdout.trim(),
    `t3o-snapshot-index-${process.pid}-${input.nowMs}`,
  );
  const env = { GIT_INDEX_FILE: index };
  return yield* Effect.gen(function* () {
    // Seeded from the worktree's own index: its stat data spares rehashing every tracked file,
    // and its skip-worktree bits keep a sparse checkout's absent files from reading as deleted.
    const copied = yield* Effect.promise(() =>
      NodeFSP.copyFile(NodePath.join(gitDir.stdout.trim(), "index"), index).then(
        () => true,
        () => false,
      ),
    );
    if (!copied) {
      const read = yield* run(git, "readTree", input.worktreePath, ["read-tree", "HEAD"], env);
      if (read.exitCode !== 0) return yield* fail("read-tree", read);
    }
    const add = yield* run(git, "add", input.worktreePath, ["add", "-A"], env);
    if (add.exitCode !== 0) return yield* fail("add", add);
    const tree = yield* run(git, "writeTree", input.worktreePath, ["write-tree"], env);
    if (tree.exitCode !== 0) return yield* fail("write-tree", tree);
    const headTree = yield* run(git, "headTree", input.worktreePath, ["rev-parse", "HEAD^{tree}"]);
    if (headTree.exitCode !== 0) return yield* fail("rev-parse", headTree);
    if (tree.stdout.trim() === headTree.stdout.trim()) {
      return { outcome: "nothing" } satisfies BoardWorkspaceSnapshotResult;
    }
    const head = yield* run(git, "head", input.worktreePath, ["rev-parse", "HEAD"]);
    if (head.exitCode !== 0) return yield* fail("rev-parse", head);
    // A removal that failed after an earlier snapshot retries: the same work keeps its one ref.
    const earlier = yield* newestSnapshotRef(git, input.worktreePath, input.cardKey);
    if (
      earlier !== null &&
      earlier.tree === tree.stdout.trim() &&
      earlier.parent === head.stdout.trim()
    ) {
      return {
        outcome: "snapshotted",
        ref: earlier.ref,
        sha: earlier.sha,
        reused: true,
      } satisfies BoardWorkspaceSnapshotResult;
    }
    const ident = yield* run(git, "ident", input.worktreePath, ["var", "GIT_COMMITTER_IDENT"]);
    const identityEnv =
      ident.exitCode === 0
        ? undefined
        : {
            GIT_AUTHOR_NAME: "t3o",
            GIT_AUTHOR_EMAIL: "t3o@localhost",
            GIT_COMMITTER_NAME: "t3o",
            GIT_COMMITTER_EMAIL: "t3o@localhost",
          };
    const commit = yield* run(
      git,
      "commitTree",
      input.worktreePath,
      [
        "commit-tree",
        tree.stdout.trim(),
        "-p",
        "HEAD",
        "-m",
        `t3o: uncommitted work of ${input.cardKey} before its worktree was removed`,
      ],
      identityEnv,
    );
    if (commit.exitCode !== 0) return yield* fail("commit-tree", commit);
    const sha = commit.stdout.trim();
    const ref = `${BOARD_DISCARDED_REF_PREFIX}${input.cardKey}-${snapshotStamp(input.nowMs)}`;
    const updated = yield* run(git, "updateRef", input.worktreePath, ["update-ref", ref, sha]);
    if (updated.exitCode !== 0) return yield* fail("update-ref", updated);
    return { outcome: "snapshotted", ref, sha } satisfies BoardWorkspaceSnapshotResult;
  }).pipe(Effect.ensuring(Effect.promise(() => NodeFSP.rm(index, { force: true }))));
});

export const writeStripPendingMarker = (gitDir: string, reason: string) =>
  Effect.promise(() =>
    NodeFSP.writeFile(NodePath.join(gitDir, STRIP_PENDING_MARKER), `${reason}\n`).catch(
      () => undefined,
    ),
  );

/**
 * Delete what git ignores in the worktree, except `.env*` files, `.claude/`, `.vscode/`,
 * `.idea/` and nested repositories; tracked files are never listed, so never touched. Clears the setup markers so a
 * reused worktree sets up again, and marks it stripped. Answers the bytes freed.
 */
export const stripBoardWorktree = Effect.fn("stripBoardWorktree")(function* (input: {
  readonly worktreePath: string;
  readonly gitDir: string;
}) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const listed = yield* run(git, "listIgnored", input.worktreePath, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "-z",
  ]);
  if (listed.exitCode !== 0) {
    return yield* new BoardWorkerGitError({
      operation: "stripWorktree",
      detail: `git ls-files failed: ${listed.stderr.trim()}`,
    });
  }
  const entries = listed.stdout
    .split("\0")
    .filter((entry) => entry.length > 0 && !isKeptIgnoredEntry(entry));
  const { freedBytes, undeleted } = yield* Effect.promise(async () => {
    let freed = 0;
    let failed = 0;
    for (const entry of entries) {
      const target = NodePath.join(input.worktreePath, entry);
      // `ls-files` names paths inside the worktree; refuse anything that resolves outside it.
      const relative = NodePath.relative(input.worktreePath, target);
      if (relative === "" || relative.startsWith("..") || NodePath.isAbsolute(relative)) continue;
      const result = await stripEntry(target);
      freed += result.freed;
      failed += result.failed;
    }
    return { freedBytes: freed, undeleted: failed };
  });
  yield* Effect.promise(async () => {
    for (const marker of [SETUP_DONE_MARKER, SETUP_FAILED_MARKER, STRIP_PENDING_MARKER]) {
      await NodeFSP.rm(NodePath.join(input.gitDir, marker), { force: true }).catch(() => undefined);
    }
  });
  // Anything left behind stays owed, so the sweep retries it rather than calling it stripped.
  if (undeleted > 0) {
    yield* writeStripPendingMarker(
      input.gitDir,
      `${undeleted} ignored entries could not be deleted`,
    );
  } else {
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(input.gitDir, STRIPPED_MARKER), "stripped\n").catch(
        () => undefined,
      ),
    );
  }
  return { freedBytes };
});

export const hasMarker = (gitDir: string, marker: string) =>
  Effect.promise(() =>
    NodeFSP.access(NodePath.join(gitDir, marker)).then(
      () => true,
      () => false,
    ),
  );

/** Delete `refs/t3o/discarded/*` whose commit is older than `maxAgeDays`. */
export const pruneDiscardedRefs = Effect.fn("pruneDiscardedRefs")(function* (input: {
  readonly cwd: string;
  readonly nowMs: number;
  readonly maxAgeDays: number;
}) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const listed = yield* run(git, "listDiscarded", input.cwd, [
    "for-each-ref",
    "--format=%(refname)%00%(committerdate:unix)",
    BOARD_DISCARDED_REF_PREFIX,
  ]);
  if (listed.exitCode !== 0) return { deleted: 0 };
  const cutoff = input.nowMs / 1000 - input.maxAgeDays * 24 * 60 * 60;
  let deleted = 0;
  for (const line of listed.stdout.split("\n")) {
    const [ref, seconds] = line.split("\0");
    if (ref === undefined || !ref.startsWith(BOARD_DISCARDED_REF_PREFIX)) continue;
    const committed = Number(seconds);
    if (!Number.isFinite(committed) || committed >= cutoff) continue;
    const dropped = yield* run(git, "dropDiscarded", input.cwd, ["update-ref", "-d", ref]);
    if (dropped.exitCode === 0) deleted += 1;
  }
  return { deleted };
});

/**
 * Delete a deleted card's local branch, unless a worktree has it checked out. Never the remote:
 * that delete already ran on the card's normal path, and a person may have reused the name.
 */
export const deleteLeftoverBranch = Effect.fn("deleteLeftoverBranch")(function* (input: {
  readonly cwd: string;
  readonly branch: string;
}) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const exists = yield* run(git, "branchExists", input.cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${input.branch}`,
  ]);
  if (exists.exitCode !== 0) return { deleted: false, skippedReason: "no such branch" };
  const listed = yield* run(git, "worktrees", input.cwd, ["worktree", "list", "--porcelain"]);
  if (listed.exitCode !== 0) return { deleted: false, skippedReason: "worktrees unreadable" };
  if (listed.stdout.split("\n").some((line) => line === `branch refs/heads/${input.branch}`)) {
    return { deleted: false, skippedReason: "a worktree has it checked out" };
  }
  const removed = yield* run(git, "deleteBranch", input.cwd, ["branch", "-D", input.branch]);
  return removed.exitCode === 0
    ? { deleted: true, skippedReason: null }
    : { deleted: false, skippedReason: removed.stderr.trim() || "git branch -D failed" };
});
