/**
 * Board worktree and branch mechanics: provision, set up, probe and reclaim, as standalone
 * effects. When they run is the reactor's job, and the decider records their outcome
 * through the server-internal worktree commands. Reclaim never deletes undurable work.
 */
import { resolveBoardCardEffectiveBase } from "@t3tools/contracts";
import type { BoardCard, BoardCardWorktreeReclaimOutcome } from "@t3tools/contracts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { BoardSetupScriptRunner } from "./ports/BoardSetupScriptRunner.ts";
import { WorktreeRetirer } from "./worktreeRetire.ts";

/**
 * The card's branch name, derived from its key so it is human-legible and
 * stable across retries. `board/` namespaces T3o's branches away from a
 * user's own; the key is sanitised into a valid ref fragment.
 */
export function boardCardWorktreeBranchName(card: Pick<BoardCard, "key">): string {
  return `board/${sanitizeBranchFragment(card.key)}`;
}

/**
 * The base ref a card's branch is cut from: its pinned `baseBranch` or the project default,
 * or for a sub-board plan card its parent's integration branch. Null when that parent has no
 * branch yet, which the caller surfaces rather than cutting from the wrong base.
 */
export function resolveBoardCardBaseRef(input: {
  readonly card: Pick<BoardCard, "parentCardId" | "baseBranch">;
  readonly cards: ReadonlyArray<
    Pick<BoardCard, "id" | "worktree" | "pullRequest" | "pullRequestHistory">
  >;
  readonly defaultBranch: string;
}): string | null {
  return resolveBoardCardEffectiveBase(input);
}

export interface BoardCardWorktreeProvisionResult {
  readonly path: string;
  readonly branch: string;
  readonly baseRefName: string;
}

/**
 * The worktree path checked out for `branch` in `git worktree list --porcelain` output
 * (blank-line separated `worktree <path>` / `branch refs/heads/<name>` blocks), or null.
 */
export function parseWorktreePathForBranch(porcelain: string, branch: string): string | null {
  const wanted = `branch refs/heads/${branch}`;
  let currentPath: string | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
    } else if (line.trim() === wanted && currentPath !== null) {
      return currentPath;
    } else if (line.trim() === "") {
      currentPath = null;
    }
  }
  return null;
}

/**
 * Create the card's branch and worktree from `baseRefName` with one `git worktree add -b`,
 * as the thread bootstrap does. Retry-safe without deleting work: a worktree already on the
 * branch is returned as-is, an existing branch gets one attached, and only a clean slate
 * cuts a new branch.
 */
export const provisionBoardCardWorktree = Effect.fn("provisionBoardCardWorktree")(
  function* (input: {
    readonly projectCwd: string;
    readonly branch: string;
    readonly baseRefName: string;
  }) {
    const git = yield* GitVcsDriver.GitVcsDriver;

    const worktrees = yield* git.execute({
      operation: "boardCardWorktree.list",
      cwd: input.projectCwd,
      args: ["worktree", "list", "--porcelain"],
      timeoutMs: 10_000,
    });
    const existingPath = parseWorktreePathForBranch(worktrees.stdout, input.branch);
    if (existingPath !== null) {
      // A prior attempt already checked the branch out — reuse it, don't fail.
      yield* pinBoardWorktreeGhDefault(existingPath);
      return {
        path: existingPath,
        branch: input.branch,
        baseRefName: input.baseRefName,
      } satisfies BoardCardWorktreeProvisionResult;
    }

    // The branch may exist from a partial attempt with no worktree; attach one
    // to it rather than trying (and failing) to re-create it with `-b`.
    const branchExists = (yield* git.listLocalBranchNames(input.projectCwd)).includes(input.branch);
    const created = yield* git.createWorktree({
      cwd: input.projectCwd,
      refName: branchExists ? input.branch : input.baseRefName,
      ...(branchExists ? {} : { newRefName: input.branch }),
      baseRefName: input.baseRefName,
      path: null,
    });
    yield* pinBoardWorktreeGhDefault(created.worktree.path);
    return {
      path: created.worktree.path,
      branch: created.worktree.refName,
      baseRefName: input.baseRefName,
    } satisfies BoardCardWorktreeProvisionResult;
  },
);

/**
 * `gh` prefers a remote named `upstream`, so in a fork agents' pull requests would target
 * upstream. Pin to `origin` only with several remotes, no chosen default, and no shared
 * `core.bare`/`core.worktree`. `extensions.worktreeConfig` is only newly enabled at
 * `core.repositoryformatversion` 0, since at 1 tools that don't know it refuse the repo.
 */
export function boardWorktreeGhDefaultDecision(input: {
  readonly remotes: ReadonlyArray<string>;
  readonly ghResolvedConfigured: boolean;
  readonly worktreeConfigEnabled: boolean;
  readonly sharedCoreBare: boolean;
  readonly sharedCoreWorktree: boolean;
  readonly repositoryFormatV0: boolean;
}): "pin" | "skip" {
  if (!input.remotes.includes("origin") || input.remotes.length < 2) return "skip";
  if (input.ghResolvedConfigured) return "skip";
  if (
    !input.worktreeConfigEnabled &&
    (input.sharedCoreBare || input.sharedCoreWorktree || !input.repositoryFormatV0)
  ) {
    return "skip";
  }
  return "pin";
}

/**
 * Pin `gh`'s default repository to `origin` in one board worktree via `git config
 * --worktree`, so the main checkout and other threads are untouched. Never fails the
 * provisioning: errors are logged.
 */
export const pinBoardWorktreeGhDefault = Effect.fn("pinBoardWorktreeGhDefault")(
  function* (worktreePath: string) {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const run = (operation: string, args: ReadonlyArray<string>) =>
      git.execute({
        operation: `boardCardWorktree.ghDefault.${operation}`,
        cwd: worktreePath,
        args,
        allowNonZeroExit: true,
        timeoutMs: 10_000,
      });
    const configured = (result: { readonly exitCode: number; readonly stdout: string }) =>
      result.exitCode === 0 && result.stdout.trim().length > 0;
    // Never the main checkout: its worktree config is the user's own.
    const dirs = yield* run("gitDirs", [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
    ]);
    const [gitDir, commonDir] = dirs.stdout.split("\n").map((line) => line.trim());
    if (dirs.exitCode !== 0 || !gitDir || gitDir === commonDir) return;
    const remotes = yield* run("remotes", ["remote"]);
    const ghResolved = yield* run("ghResolved", [
      "config",
      "--get-regexp",
      "^remote\\..*\\.gh-resolved$",
    ]);
    const worktreeConfig = yield* run("worktreeConfig", [
      "config",
      "--bool",
      "--get",
      "extensions.worktreeConfig",
    ]);
    const coreBare = yield* run("coreBare", ["config", "--local", "--bool", "--get", "core.bare"]);
    const coreWorktree = yield* run("coreWorktree", [
      "config",
      "--local",
      "--get",
      "core.worktree",
    ]);
    const formatVersion = yield* run("formatVersion", [
      "config",
      "--local",
      "--get",
      "core.repositoryformatversion",
    ]);
    const decision = boardWorktreeGhDefaultDecision({
      remotes: remotes.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
      ghResolvedConfigured: configured(ghResolved),
      worktreeConfigEnabled: worktreeConfig.stdout.trim() === "true",
      sharedCoreBare: coreBare.stdout.trim() === "true",
      sharedCoreWorktree: configured(coreWorktree),
      // Unset reads as version 0, as it does to git.
      repositoryFormatV0: ["", "0"].includes(formatVersion.stdout.trim()),
    });
    if (decision === "skip") return;
    if (worktreeConfig.stdout.trim() !== "true") {
      yield* git.execute({
        operation: "boardCardWorktree.ghDefault.enableWorktreeConfig",
        cwd: worktreePath,
        args: ["config", "extensions.worktreeConfig", "true"],
        timeoutMs: 10_000,
      });
    }
    yield* git.execute({
      operation: "boardCardWorktree.ghDefault.pin",
      cwd: worktreePath,
      args: ["config", "--worktree", "remote.origin.gh-resolved", "base"],
      timeoutMs: 10_000,
    });
  },
  (effect, worktreePath) =>
    effect.pipe(
      Effect.catch((error) =>
        Effect.logWarning("board worktree: could not pin gh's default repository to origin", {
          worktreePath,
          detail: error.message,
        }),
      ),
    ),
);

/**
 * Run `runOnWorktreeCreate` in the card's worktree through the thread-scoped runner, so the
 * setup terminal is owned by the build thread.
 */
export const runBoardCardWorktreeSetup = Effect.fn("runBoardCardWorktreeSetup")(function* (input: {
  readonly threadId: string;
  readonly projectId: string;
  readonly worktreePath: string;
}) {
  const runner = yield* BoardSetupScriptRunner;
  return yield* runner.runForThread({
    threadId: input.threadId,
    projectId: input.projectId,
    worktreePath: input.worktreePath,
  });
});

/**
 * Safe to reclaim only when the tree is clean AND `HEAD` is durable (on the remote base, a
 * merged pull request's head, or any remote-tracking ref). `reason` is the card-facing
 * explanation when a reclaim is skipped, with its evidence.
 */
export function boardCardWorktreeReclaimDecision(input: {
  readonly hasWorkingTreeChanges: boolean;
  readonly changedPaths: ReadonlyArray<string>;
  readonly durable: boolean;
  /** Commits on `HEAD` that no remote-tracking ref contains. */
  readonly unmergedCount: number;
  /** The card's current pull request, when it is still open — the likeliest
      reason the work is not durable yet, so it is the reason given. */
  readonly openPullRequestNumber?: number | null | undefined;
}): { readonly safe: true } | { readonly safe: false; readonly reason: string } {
  if (input.hasWorkingTreeChanges) {
    const count = Math.max(input.changedPaths.length, 1);
    const plural = count === 1 ? "change" : "changes";
    const shown = input.changedPaths.slice(0, 3).join(", ");
    const more = input.changedPaths.length > 3 ? ", …" : "";
    return {
      safe: false,
      reason:
        shown.length === 0
          ? `${count} uncommitted ${plural}`
          : `${count} uncommitted ${plural} (${shown}${more})`,
    };
  }
  if (input.durable) return { safe: true };
  if (input.openPullRequestNumber != null) {
    return { safe: false, reason: `Pull request #${input.openPullRequestNumber} is still open` };
  }
  if (input.unmergedCount > 0) {
    const plural = input.unmergedCount === 1 ? "commit" : "commits";
    return {
      safe: false,
      reason: `${input.unmergedCount} ${plural} not in the base branch or a merged pull request`,
    };
  }
  return {
    safe: false,
    reason: "The branch could not be found in the base branch, a merged pull request or a remote",
  };
}

/** Paths from `git status --porcelain` (v1). A rename line reads
    `R  old -> new`; the new name is the one that exists on disk. */
export function parseStatusPorcelainPaths(porcelain: string): ReadonlyArray<string> {
  const paths: Array<string> = [];
  for (const line of porcelain.split("\n")) {
    if (line.length < 4) continue;
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    paths.push(arrow === -1 ? rest : rest.slice(arrow + " -> ".length));
  }
  return paths;
}

/** One registered worktree from `git worktree list --porcelain`. */
export interface BoardRegisteredWorktree {
  readonly path: string;
  /** Short branch name, or null for a detached checkout. */
  readonly branch: string | null;
  /** `git worktree prune` would drop it: its directory is already gone. */
  readonly prunable: boolean;
}

/** Every worktree block in `git worktree list --porcelain` output. */
export function parseRegisteredWorktrees(
  porcelain: string,
): ReadonlyArray<BoardRegisteredWorktree> {
  const result: Array<BoardRegisteredWorktree> = [];
  let current: { path: string; branch: string | null; prunable: boolean } | null = null;
  const flush = () => {
    if (current !== null) result.push(current);
    current = null;
  };
  for (const raw of porcelain.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length), branch: null, prunable: false };
    } else if (current !== null && line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (current !== null && line.startsWith("prunable")) {
      current.prunable = true;
    } else if (line === "") {
      flush();
    }
  }
  flush();
  return result;
}

/** The forge PR-head refs to try, in order: GitHub, Forgejo and Gitea publish
    `refs/pull/<n>/head`, GitLab `refs/merge-requests/<n>/head`. Forges with
    neither (Bitbucket, Azure) fall back to the base and remote-ref proofs. */
const pullRequestHeadRefs = (prNumber: number): ReadonlyArray<string> => [
  `refs/pull/${prNumber}/head`,
  `refs/merge-requests/${prNumber}/head`,
];

export interface BoardWorktreeDurabilityInput {
  readonly projectCwd: string;
  readonly worktreePath: string;
  /** The branch the card was cut from; its REMOTE copy is proof (1). */
  readonly baseRefName: string;
  /** The card's branch; its remote copy is fetched for proof (3). */
  readonly branch: string;
  /** Every MERGED pull request on the card, current or retired (proof 2).
      Empty for an orphan, which has no card to carry one. */
  readonly mergedPullRequestNumbers: ReadonlyArray<number>;
  readonly openPullRequestNumber?: number | null | undefined;
  /** Base branches a sweep pass has already fetched, keyed by project and
      base, so a pass fetches each base once rather than once per card. The
      probe adds to it. */
  readonly fetchedBases?: Set<string> | undefined;
}

/**
 * Every proof is a git fetch, never a forge API call, so the sweep costs no rate limit. A
 * failed fetch is "not proven", never an error: the worktree is kept, the safe direction.
 */
export const probeBoardWorktreeDurability = Effect.fn("probeBoardWorktreeDurability")(function* (
  input: BoardWorktreeDurabilityInput,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const run = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
    git
      .execute({
        operation: `boardCardWorktree.durable.${operation}`,
        cwd,
        args,
        allowNonZeroExit: true,
        timeoutMs: 60_000,
      })
      .pipe(Effect.orElseSucceed(() => null));
  const ok = (result: { readonly exitCode: number } | null) =>
    result !== null && result.exitCode === 0;

  // Untracked files count — they would be lost too. Ignored files (build
  // output such as `target/`) do not: they are exactly the disk being freed.
  const status = yield* git.execute({
    operation: "boardCardWorktree.durable.status",
    cwd: input.worktreePath,
    args: ["status", "--porcelain"],
    timeoutMs: 30_000,
  });
  const changedPaths = parseStatusPorcelainPaths(status.stdout);
  const facts = {
    hasWorkingTreeChanges: changedPaths.length > 0,
    changedPaths,
    openPullRequestNumber: input.openPullRequestNumber ?? null,
  };
  if (changedPaths.length > 0) return { ...facts, durable: false, unmergedCount: 0 };

  const isAncestorOf = (ref: string) =>
    run(input.worktreePath, "ancestor", ["merge-base", "--is-ancestor", "HEAD", ref]).pipe(
      Effect.map(ok),
    );

  const remote = yield* git
    .resolvePrimaryRemoteName(input.projectCwd)
    .pipe(Effect.orElseSucceed(() => null));

  if (remote !== null) {
    // (1) The remote base branch: merged without a PR, fast-forwarded, or no
    // new commits at all since the branch was cut.
    const base = input.baseRefName.startsWith(`${remote}/`)
      ? input.baseRefName.slice(remote.length + 1)
      : input.baseRefName;
    const fetchKey = `${input.projectCwd}\0${base}`;
    if (input.fetchedBases?.has(fetchKey) !== true) {
      const baseFetched = yield* run(input.projectCwd, "fetchBase", [
        "fetch",
        "--no-tags",
        remote,
        `+refs/heads/${base}:refs/remotes/${remote}/${base}`,
      ]);
      if (ok(baseFetched)) input.fetchedBases?.add(fetchKey);
    }
    if (yield* isAncestorOf(`refs/remotes/${remote}/${base}`)) {
      return { ...facts, durable: true, unmergedCount: 0 };
    }

    // (2) A merged pull request's head: a squash merge whose head branch the
    // forge deleted leaves no other trace of these commits on the remote.
    // Fetched into a private ref (FETCH_HEAD would race a concurrent fetch)
    // that is dropped again straight after.
    for (const prNumber of input.mergedPullRequestNumbers) {
      for (const ref of pullRequestHeadRefs(prNumber)) {
        const local = `refs/t3o/reclaim/${prNumber}`;
        const fetched = yield* run(input.projectCwd, "fetchPullRequest", [
          "fetch",
          "--no-tags",
          remote,
          `+${ref}:${local}`,
        ]);
        if (!ok(fetched)) continue;
        const proven = yield* isAncestorOf(local);
        yield* run(input.projectCwd, "dropPullRequestRef", ["update-ref", "-d", local]);
        if (proven) return { ...facts, durable: true, unmergedCount: 0 };
        break;
      }
    }

    // (3) Any remote-tracking ref, after fetching the card's own branch: a
    // branch pushed without `-u` has no upstream but is still on the remote.
    yield* run(input.projectCwd, "fetchBranch", [
      "fetch",
      "--no-tags",
      remote,
      `+refs/heads/${input.branch}:refs/remotes/${remote}/${input.branch}`,
    ]);
  }
  const containing = yield* run(input.worktreePath, "remoteContains", [
    "for-each-ref",
    "--contains",
    "HEAD",
    "--format=%(refname)",
    "refs/remotes",
  ]);
  if (containing !== null && containing.exitCode === 0 && containing.stdout.trim().length > 0) {
    return { ...facts, durable: true, unmergedCount: 0 };
  }
  const unmerged = yield* run(input.worktreePath, "unmergedCount", [
    "rev-list",
    "--count",
    "HEAD",
    "--not",
    "--remotes",
  ]);
  const unmergedCount =
    unmerged !== null && unmerged.exitCode === 0 ? Number(unmerged.stdout.trim()) || 0 : 0;
  return { ...facts, durable: false, unmergedCount };
});

export interface BoardCardWorktreeReclaimResult {
  readonly outcome: BoardCardWorktreeReclaimOutcome;
  readonly reason: string | null;
  /** T3O-23: a removal whose remove script failed or timed out. */
  readonly hookWarning?: string | null;
}

/**
 * The registered path of a card's checkout whose folder is gone (`prunable`, or unlisted and
 * absent from disk), else null, including when git's list cannot be read. Prunable entries
 * also match on branch since git may spell the path differently; the rest go to disk.
 */
export const goneBoardWorktreePath = Effect.fn("goneBoardWorktreePath")(function* (
  input: BoardWorktreeDurabilityInput,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const listed = yield* git
    .execute({
      operation: "boardCardWorktree.reclaim.list",
      cwd: input.projectCwd,
      args: ["worktree", "list", "--porcelain"],
      allowNonZeroExit: true,
    })
    .pipe(Effect.orElseSucceed(() => null));
  // git always lists the main checkout, so an empty list is no answer at all.
  const registered =
    listed === null || listed.exitCode !== 0 ? [] : parseRegisteredWorktrees(listed.stdout);
  if (registered.length === 0) return null;
  const exact = registered.find((entry) => entry.path === input.worktreePath);
  if (exact !== undefined) return exact.prunable ? exact.path : null;
  // A live branch match proves nothing about this path — the branch may be
  // checked out elsewhere — so only a prunable one answers; the rest go to disk.
  const prunableOnBranch = registered.find(
    (entry) => entry.branch === input.branch && entry.prunable,
  );
  if (prunableOnBranch !== undefined) return prunableOnBranch.path;
  const onDisk = yield* fileSystem
    .exists(input.worktreePath)
    .pipe(Effect.orElseSucceed(() => true));
  return onDisk ? null : input.worktreePath;
});

/**
 * Remove a card's worktree only when clean and durable, else report why. `stillWanted` is
 * asked after the slow probe and again before removal; false abandons (null, nothing
 * removed). A checkout whose folder is already gone only loses git's registration.
 */
export const reclaimBoardCardWorktree = Effect.fn("reclaimBoardCardWorktree")(function* (
  input: BoardWorktreeDurabilityInput,
  stillWanted?: Effect.Effect<boolean>,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gone = yield* goneBoardWorktreePath(input);
  if (gone !== null) {
    if (stillWanted !== undefined && !(yield* stillWanted)) return null;
    // Drops a lingering registration; the driver treats an unlisted one as done.
    yield* git.removeWorktree({ cwd: input.projectCwd, path: gone, force: true });
    return { outcome: "removed", reason: null } satisfies BoardCardWorktreeReclaimResult;
  }
  const facts = yield* probeBoardWorktreeDurability(input);
  const decision = boardCardWorktreeReclaimDecision(facts);
  if (!decision.safe) {
    return { outcome: "blocked", reason: decision.reason } satisfies BoardCardWorktreeReclaimResult;
  }
  const retirer = yield* WorktreeRetirer;
  const retired = yield* retirer.retire({
    projectCwd: input.projectCwd,
    worktreePath: input.worktreePath,
    kind: "reclaim",
    verifiedClean: true,
    stillWanted,
  });
  if (retired === null) return null;
  if (retired.outcome === "blocked") {
    return { outcome: "blocked", reason: retired.reason } satisfies BoardCardWorktreeReclaimResult;
  }
  return {
    outcome: "removed",
    reason: null,
    ...(retired.hookWarning === null ? {} : { hookWarning: retired.hookWarning }),
  } satisfies BoardCardWorktreeReclaimResult;
});

/**
 * Remove a worktree whatever it holds, bypassing the durability rule and git's dirty-tree
 * refusal, for a human-confirmed card delete or "Remove worktree". The branch is kept.
 */
export const forceRemoveBoardCardWorktree = Effect.fn("forceRemoveBoardCardWorktree")(
  function* (input: { readonly projectCwd: string; readonly worktreePath: string }) {
    const retirer = yield* WorktreeRetirer;
    // T3O-23: forced, so survivors are killed rather than holding it back,
    // and a retirement already in flight is waited out rather than skipped:
    // the result is always `removed`, carrying any remove-script failure.
    const retired = yield* retirer.retire({
      projectCwd: input.projectCwd,
      worktreePath: input.worktreePath,
      kind: "forced",
      verifiedClean: false,
    });
    return { hookWarning: retired?.outcome === "removed" ? retired.hookWarning : null };
  },
);

/**
 * More than one writer would hold a card's single worktree: two agents in one worktree
 * corrupt each other, so steps within a card are serialised.
 */
export class BoardWorktreeConcurrencyError extends Schema.TaggedError<BoardWorktreeConcurrencyError>()(
  "BoardWorktreeConcurrencyError",
  {
    cardId: Schema.String,
    writerThreadIds: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Card '${this.cardId}' would have ${this.writerThreadIds.length} writers holding its worktree at once; steps within a card are serialised (one writer at a time).`;
  }
}

/**
 * Assert that at most one writer holds the card's worktree. The reactor calls
 * this before spawning a writer step; here it makes the serialisation
 * invariant executable and testable. Duplicate ids count once — the same
 * thread is one writer.
 */
export const assertSingleBoardWorktreeWriter = Effect.fn("assertSingleBoardWorktreeWriter")(
  function* (input: {
    readonly cardId: string;
    readonly activeWriterThreadIds: ReadonlyArray<string>;
  }) {
    const distinct = [...new Set(input.activeWriterThreadIds)];
    if (distinct.length > 1) {
      return yield* new BoardWorktreeConcurrencyError({
        cardId: input.cardId,
        writerThreadIds: distinct,
      });
    }
  },
);
