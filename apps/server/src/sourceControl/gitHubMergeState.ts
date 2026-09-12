/**
 * T3o: `gh pr view --json mergeStateStatus,statusCheckRollup,headRefOid`,
 * turned into the provider-neutral `ChangeRequestMergeState` (T3O-38, D6/D7).
 *
 * The whole reason this module exists is that the board must classify a
 * refused merge — "wait, this clears itself" versus "stop, a human is needed"
 * — WITHOUT matching the forge's error prose, which every provider rewrites.
 * A machine-readable merge state is the one honest input for that decision.
 *
 * Total and lenient by construction: anything it cannot read comes back as
 * `unknown` / zero counts, which the board's classifier degrades to a soft
 * refusal. A probe we cannot parse costs a few extra retries and never a
 * wrong verdict.
 */
import type {
  ChangeRequestMergeBlockReason,
  ChangeRequestMergeState,
  ChangeRequestMergeability,
} from "@t3tools/contracts";

/** How many failing/running check names a detail line will ever show. Bounded
    because this text is persisted on the card and rendered in a banner, and a
    repository with 200 checks must not put 200 names there. */
export const GITHUB_MERGE_STATE_MAX_NAMED_CHECKS = 4;

/** GitHub's `mergeStateStatus`, mapped onto the two facts the board acts on.

    `UNSTABLE` is deliberately mergeable: it means non-required checks are
    failing, and GitHub will merge it. Calling that blocked would stop a ladder
    the forge is perfectly willing to finish. */
const MERGE_STATE_STATUS: Record<
  string,
  {
    readonly mergeable: ChangeRequestMergeability;
    readonly blockedReason: ChangeRequestMergeBlockReason | null;
  }
> = {
  CLEAN: { mergeable: "mergeable", blockedReason: null },
  HAS_HOOKS: { mergeable: "mergeable", blockedReason: null },
  UNSTABLE: { mergeable: "mergeable", blockedReason: null },
  BEHIND: { mergeable: "blocked", blockedReason: "behind" },
  DIRTY: { mergeable: "blocked", blockedReason: "conflict" },
  DRAFT: { mergeable: "blocked", blockedReason: "draft" },
  BLOCKED: { mergeable: "blocked", blockedReason: "other" },
  // GitHub is still computing mergeability. "We do not know yet" is a real
  // answer and must not be read as "no".
  UNKNOWN: { mergeable: "unknown", blockedReason: null },
};

/** A check-run conclusion, or a commit-status state, that counts as failed. */
const FAILED_CONCLUSIONS = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
]);
/** …and the ones that count as still running. */
const PENDING_CONCLUSIONS = new Set([
  "PENDING",
  "EXPECTED",
  "QUEUED",
  "IN_PROGRESS",
  "WAITING",
  "REQUESTED",
]);

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * One rollup entry's verdict.
 *
 * A `CheckRun` reports `status` (lifecycle) plus `conclusion` (result); a
 * `StatusContext` reports a single `state`. Read both shapes, because a
 * repository can have either or both, and a rollup we half-read would
 * under-count exactly the failures the classification turns on.
 */
function verdictOf(entry: Record<string, unknown>): "passed" | "pending" | "failed" | "ignored" {
  const status = text(entry["status"]).toUpperCase();
  const conclusion = text(entry["conclusion"]).toUpperCase();
  const state = text(entry["state"]).toUpperCase();

  // A check run that has not completed is running, whatever its (usually
  // empty) conclusion says.
  if (status.length > 0 && status !== "COMPLETED") return "pending";
  const verdict = conclusion.length > 0 ? conclusion : state;
  if (verdict.length === 0) return "pending";
  if (FAILED_CONCLUSIONS.has(verdict)) return "failed";
  if (PENDING_CONCLUSIONS.has(verdict)) return "pending";
  // SUCCESS, and the two "did not run and that is fine" conclusions. NEUTRAL
  // and SKIPPED do not block a merge on GitHub, so they must not block the
  // ladder either.
  if (verdict === "SUCCESS" || verdict === "NEUTRAL" || verdict === "SKIPPED") return "passed";
  return "ignored";
}

const nameOf = (entry: Record<string, unknown>): string => {
  const name = text(entry["name"]) || text(entry["context"]);
  return name.length > 0 ? name : "a check";
};

/**
 * Parse `gh pr view`'s JSON. Never throws and never fails: a body this cannot
 * read yields the all-unknown state, which the classifier reads as soft.
 */
export function parseGitHubMergeState(raw: string): ChangeRequestMergeState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const body: Record<string, unknown> =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};

  const status = text(body["mergeStateStatus"]).toUpperCase();
  const mapped = MERGE_STATE_STATUS[status] ?? {
    mergeable: "unknown" as const,
    blockedReason: null,
  };

  const rollup = Array.isArray(body["statusCheckRollup"]) ? body["statusCheckRollup"] : [];
  let passed = 0;
  let pending = 0;
  let failed = 0;
  const failing: string[] = [];
  const running: string[] = [];
  for (const item of rollup) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    switch (verdictOf(entry)) {
      case "passed":
        passed += 1;
        break;
      case "pending":
        pending += 1;
        if (running.length < GITHUB_MERGE_STATE_MAX_NAMED_CHECKS) running.push(nameOf(entry));
        break;
      case "failed":
        failed += 1;
        if (failing.length < GITHUB_MERGE_STATE_MAX_NAMED_CHECKS) failing.push(nameOf(entry));
        break;
      default:
        break;
    }
  }

  const headSha = text(body["headRefOid"]);
  return {
    mergeable: mapped.mergeable,
    blockedReason: mapped.blockedReason,
    checks: { total: passed + pending + failed, passed, pending, failed, failing, running },
    headSha: headSha.length > 0 ? headSha : null,
  };
}
