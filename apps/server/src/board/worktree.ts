/**
 * T3o board worktree & branch lifecycle mechanics (t3o-09, D6).
 *
 * The *mechanics* only: create a card's branch + worktree on entry to
 * Building, run the project's worktree setup script, and reclaim the worktree
 * at archive. The board is a supervisor, so WHEN these run — reacting to a
 * card entering Building, spawning the build thread, enforcing one-writer
 * serialisation across concurrent steps — belongs to the reactor (t3o-10) and
 * the governor (t3o-11). This module deliberately builds none of that: it is a
 * set of standalone effects whose git dependency is a requirement, exercised
 * directly by tests and wired into the reactor later. No layer is provided
 * here, so nothing runs behind the human "Begin build" gate on its own (D18).
 *
 * D8 stays intact: the pure decider (decider.ts) records the branch/worktree
 * state these effects report, through the server-internal worktree commands.
 * These effects do the I/O and hand the outcome back to a caller that
 * dispatches `board.card.record-worktree` / `.fail-worktree` /
 * `.reclaim-worktree`.
 *
 * Reuse over reinvention (per the spec): branch + worktree creation goes
 * through the same `GitVcsDriver.createWorktree` the thread bootstrap uses
 * (ws.ts), the setup script through the existing `ProjectSetupScriptRunner`,
 * and reclamation through `GitVcsDriver.removeWorktree` — gated by a
 * clean-and-pushed check so uncommitted work is never deleted to save disk.
 */
import { resolveBoardCardEffectiveBase } from "@t3tools/contracts";
import type { BoardCard, BoardCardWorktreeReclaimOutcome } from "@t3tools/contracts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";

/**
 * The card's branch name, derived from its key so it is human-legible and
 * stable across retries. `board/` namespaces T3o's branches away from a
 * user's own; the key is sanitised into a valid ref fragment.
 */
export function boardCardWorktreeBranchName(card: Pick<BoardCard, "key">): string {
  return `board/${sanitizeBranchFragment(card.key)}`;
}

/**
 * The base ref a card's branch is cut from (D6/D12, T3O-5 D2): the card's own
 * pinned `baseBranch` — or the project's default branch when it has none — for
 * a top-level card, and the parent card's integration branch for a sub-board
 * plan card. Returns null when a plan card's parent has no branch yet: the
 * caller turns that into a visible failure rather than cutting from the wrong
 * base.
 *
 * A one-line delegate to `resolveBoardCardEffectiveBase`, which holds the whole
 * precedence ladder and its rationale. Shared with the web (T3O-5, D3) so "what
 * is this card's base?" is answered once: the card detail, the picker's value,
 * the amber divergence line and this resolver all read the same function.
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
 * The worktree path already checked out for `branch`, parsed from
 * `git worktree list --porcelain`, or null if the branch has no worktree.
 * Pure so it is unit-tested without a repo. Porcelain output is blank-line
 * separated blocks; a block's `branch refs/heads/<name>` line names the ref,
 * and `worktree <path>` its checkout.
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
 * Create the card's branch and worktree from `baseRefName` (D6). One
 * `git worktree add -b <branch> <path> <baseRefName>`, exactly as the thread
 * bootstrap does — the branch is created as part of the worktree add, and
 * `baseRefName` records the merge base. Slow and fallible by nature (it
 * triggers `runOnWorktreeCreate`), so the caller wraps it as the "provisioning"
 * step: dispatch `provision-worktree` first, run this, then `record-worktree`
 * on success or `fail-worktree` on error.
 *
 * Retry-safe (D6 — "a failed step with a retry, not a wedged card"): a prior
 * attempt may already have created the branch, or the whole worktree, before
 * failing (e.g. the setup script died). Recover by reusing that state rather
 * than failing on "already exists", and never delete work to do so — a
 * worktree already on the branch is returned as-is; a branch that exists
 * without a worktree gets one attached; only a clean slate cuts a new branch.
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
    return {
      path: created.worktree.path,
      branch: created.worktree.refName,
      baseRefName: input.baseRefName,
    } satisfies BoardCardWorktreeProvisionResult;
  },
);

/**
 * Run the project's worktree setup script (`runOnWorktreeCreate`) in the
 * card's worktree, reusing the thread-scoped runner: the setup command runs in
 * a terminal owned by the build thread, which is why this takes the build
 * thread's id. A thin pass-through so the board never reinvents terminal
 * ownership.
 */
export const runBoardCardWorktreeSetup = Effect.fn("runBoardCardWorktreeSetup")(function* (input: {
  readonly threadId: string;
  readonly projectId: string;
  readonly worktreePath: string;
}) {
  const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  return yield* runner.runForThread({
    threadId: input.threadId,
    projectId: input.projectId,
    worktreePath: input.worktreePath,
  });
});

/**
 * Whether a worktree is safe to reclaim (T3O-52, D1): a clean working tree AND
 * work that is DURABLE — local `HEAD` already lives somewhere other than this
 * checkout (the remote base branch, a merged pull request's head, or any
 * remote-tracking ref). Never delete uncommitted work, and never delete a
 * checkout whose commits exist nowhere else — both would lose work to save
 * disk (D6).
 *
 * The `reason` is the card-facing "says why" when a reclaim is skipped, and
 * carries its evidence. Pure, so it is table-tested without a git repo; the
 * git probing that produces `durable` is `probeBoardWorktreeDurability`.
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
 * Gather the facts `boardCardWorktreeReclaimDecision` rules on (T3O-52, D1).
 *
 * Every proof is a git fetch, never a forge API call, so the sweep costs
 * nothing against a rate limit. A fetch that fails (no remote, no PR refs on
 * this forge, offline) is "not proven", never an error: the worktree is then
 * flagged rather than deleted, which is the safe direction to be wrong in.
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
      .pipe(Effect.catch(() => Effect.succeed(null)));
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
    .pipe(Effect.catch(() => Effect.succeed(null)));

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
}

/**
 * Reclaim a card's worktree (D6/D15, T3O-52): remove it only when it is clean
 * and its work is durable, otherwise leave it and report why so the card can
 * flag it. The caller records the outcome through `board.card.reclaim-worktree`.
 *
 * `stillWanted` is asked AFTER the probe and immediately before the removal.
 * The probe fetches from the remote and can take minutes, and the caller's
 * reason to remove — the card is finished, the checkout has no owner — was
 * read before it started; a card restarted or provisioned in the meantime
 * owns a checkout that is clean and durable and must still not go. Answering
 * false abandons the reclaim: the result is null and nothing is removed.
 */
export const reclaimBoardCardWorktree = Effect.fn("reclaimBoardCardWorktree")(function* (
  input: BoardWorktreeDurabilityInput,
  stillWanted?: Effect.Effect<boolean>,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const facts = yield* probeBoardWorktreeDurability(input);
  const decision = boardCardWorktreeReclaimDecision(facts);
  if (!decision.safe) {
    return { outcome: "blocked", reason: decision.reason } satisfies BoardCardWorktreeReclaimResult;
  }
  if (stillWanted !== undefined && !(yield* stillWanted)) return null;
  yield* git.removeWorktree({ cwd: input.projectCwd, path: input.worktreePath });
  return { outcome: "removed", reason: null } satisfies BoardCardWorktreeReclaimResult;
});

/**
 * Remove a worktree whatever it holds, bypassing BOTH the durability decision
 * and git's own refusal to remove a dirty checkout. For the two callers where
 * a human has confirmed at a dialog that the work goes: card delete, and the
 * card's "Remove worktree" action. Neither deletes the BRANCH here, so
 * committed work survives on it at no disk cost.
 */
export const forceRemoveBoardCardWorktree = Effect.fn("forceRemoveBoardCardWorktree")(
  function* (input: { readonly projectCwd: string; readonly worktreePath: string }) {
    const git = yield* GitVcsDriver.GitVcsDriver;
    yield* git.removeWorktree({ cwd: input.projectCwd, path: input.worktreePath, force: true });
  },
);

/**
 * Raised when more than one writer would hold a card's single worktree at
 * once. All threads on a card share one worktree and steps within a card are
 * serialised — two agents in one worktree corrupt each other. The supervisor
 * (t3o-10) enforces the invariant; t3o-09 states it as this guard so the
 * reactor has one place to call and the invariant lives in code, not prose.
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
