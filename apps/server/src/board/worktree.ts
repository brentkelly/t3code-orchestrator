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
import { boardCardDisplayPullRequest } from "@t3tools/contracts";
import type { BoardCard, BoardCardWorktreeReclaimOutcome } from "@t3tools/contracts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { GitStatusDetails } from "../vcs/GitVcsDriver.ts";
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
 * The base ref a card's branch is cut from (D6/D12): the project's default
 * branch for a top-level card, or the parent card's integration branch for a
 * sub-board plan card. Returns null when a plan card's parent has no branch
 * yet — the caller turns that into a visible failure rather than cutting from
 * the wrong base. Pure, so it is decided in the read model, never by querying
 * git.
 *
 * Precedence (t3o-23): a LIVE parent branch always wins. `branch-only`,
 * `provisioning` and `ready` are the statuses under which the branch ref
 * exists (or is being created right now), and for a split parent that branch
 * IS the integration base its children were approved onto — including a
 * SECOND-ROUND split, where a previously merged parent was dragged back and
 * re-approved: its fresh `branch-only` slice must beat the retired round's
 * merged pull request, or every child would silently cut from (and PR into)
 * the old round's base, bypassing the integration branch and the final
 * integration review. `failed` and `reclaimed` are NOT live — a failed
 * provision may never have created the ref, and a reclaimed slice's branch
 * was (or is about to be) deleted — so they fall through rather than name a
 * ref that may not exist; the caller's null-path re-runs the integration
 * branch machinery for exactly those states.
 *
 * With no live branch, a parent whose pull request has MERGED yields the pull
 * request's own `baseRef` — the branch the parent's work actually merged
 * INTO, not the project default: on a nested sub-board the parent may have
 * merged into an integration branch, and cutting the child from the default
 * would silently drop every sibling already integrated there. Read through
 * `boardCardDisplayPullRequest`, not `parent.pullRequest`, because a parent
 * dragged back out of Done has had its merged pull request RETIRED into the
 * history — `pullRequest` is null from that moment until the new round opens
 * one.
 *
 * A parent that reached Done without a merged pull request keeps its branch
 * (nothing deleted it) and keeps being the base, unchanged.
 */
export function resolveBoardCardBaseRef(input: {
  readonly card: Pick<BoardCard, "parentCardId">;
  readonly cards: ReadonlyArray<
    Pick<BoardCard, "id" | "worktree" | "pullRequest" | "pullRequestHistory">
  >;
  readonly defaultBranch: string;
}): string | null {
  if (input.card.parentCardId === null) return input.defaultBranch;
  const parent = input.cards.find((candidate) => candidate.id === input.card.parentCardId);
  const worktree = parent?.worktree ?? null;
  const liveBranch =
    worktree !== null &&
    (worktree.status === "ready" ||
      worktree.status === "provisioning" ||
      worktree.status === "branch-only")
      ? worktree.branch
      : null;
  if (liveBranch !== null) return liveBranch;
  const finished = parent === undefined ? null : boardCardDisplayPullRequest(parent);
  if (finished?.state === "merged") return finished.baseRef;
  return null;
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
 * Whether a worktree is safe to reclaim: clean working tree AND every commit
 * pushed to an upstream. Never delete uncommitted work, and never delete a
 * branch that exists only locally — both would lose work to save disk (D6).
 * The `reason` is the card-facing "says why" when a reclaim is skipped. Pure,
 * so it is unit-tested without a git repo.
 */
export function boardCardWorktreeReclaimDecision(
  status: Pick<GitStatusDetails, "hasWorkingTreeChanges" | "hasUpstream" | "aheadCount">,
): { readonly safe: true } | { readonly safe: false; readonly reason: string } {
  if (status.hasWorkingTreeChanges) {
    return { safe: false, reason: "Worktree has uncommitted changes." };
  }
  if (!status.hasUpstream) {
    return { safe: false, reason: "Branch has not been pushed to a remote." };
  }
  if (status.aheadCount > 0) {
    const plural = status.aheadCount === 1 ? "commit" : "commits";
    return { safe: false, reason: `${status.aheadCount} ${plural} not pushed to the remote.` };
  }
  return { safe: true };
}

export interface BoardCardWorktreeReclaimResult {
  readonly outcome: BoardCardWorktreeReclaimOutcome;
  readonly reason: string | null;
}

/**
 * Reclaim a card's worktree at archive (D6/D15): remove it only when it is
 * clean and pushed, otherwise leave it and report why so the card can flag it.
 * The caller records the outcome through `board.card.reclaim-worktree`.
 *
 * `force` bypasses BOTH the safety decision and git's own refusal to remove a
 * dirty checkout, and exists for exactly one caller: card delete, where a human
 * has confirmed at a dialog that the card and everything under it is going. The
 * refusal this skips is the whole point of the normal path — it never destroys
 * uncommitted work to save disk — so a forced reclaim always returns `removed`
 * or fails; it can never come back `blocked`.
 */
export const reclaimBoardCardWorktree = Effect.fn("reclaimBoardCardWorktree")(function* (input: {
  readonly projectCwd: string;
  readonly worktreePath: string;
  readonly force?: boolean | undefined;
}) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  if (input.force === true) {
    yield* git.removeWorktree({ cwd: input.projectCwd, path: input.worktreePath, force: true });
    return { outcome: "removed", reason: null } satisfies BoardCardWorktreeReclaimResult;
  }
  const status = yield* git.statusDetails(input.worktreePath);
  const decision = boardCardWorktreeReclaimDecision(status);
  if (!decision.safe) {
    return { outcome: "blocked", reason: decision.reason } satisfies BoardCardWorktreeReclaimResult;
  }
  yield* git.removeWorktree({ cwd: input.projectCwd, path: input.worktreePath });
  return { outcome: "removed", reason: null } satisfies BoardCardWorktreeReclaimResult;
});

/**
 * Raised when more than one writer would hold a card's single worktree at
 * once. All threads on a card share one worktree and steps within a card are
 * serialised — two agents in one worktree corrupt each other. The supervisor
 * (t3o-10) enforces the invariant; t3o-09 states it as this guard so the
 * reactor has one place to call and the invariant lives in code, not prose.
 */
export class BoardWorktreeConcurrencyError extends Schema.TaggedErrorClass<BoardWorktreeConcurrencyError>()(
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
