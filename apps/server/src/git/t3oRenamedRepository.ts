// T3o (T3O-119): a renamed or transferred forge repository keeps working through the old remote
// URL, but its pull requests name the new repository, so the strict head match rejects them.
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import type { SourceControlProviderError } from "@t3tools/contracts";

const CURRENT_NAME_CACHE_CAPACITY = 256;
const CURRENT_NAME_CACHE_TTL = Duration.minutes(15);
const KEY_SEPARATOR = "\u0000";

interface RenameCandidatePullRequest {
  readonly headRefName: string;
  readonly isCrossRepository?: boolean | undefined;
  readonly headRepositoryNameWithOwner?: string | null | undefined;
}

interface RenameCandidateHeadContext {
  readonly headBranch: string;
  readonly headRepositoryNameWithOwner: string | null;
  readonly isCrossRepository: boolean;
}

function normalizeName(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/** Same branch, same-repository on both sides, and only the repository name differs. */
export function isRenameCandidate(
  pr: RenameCandidatePullRequest,
  headContext: RenameCandidateHeadContext,
): boolean {
  if (pr.headRefName !== headContext.headBranch) return false;
  if (pr.isCrossRepository !== false || headContext.isCrossRepository !== false) return false;
  const prName = normalizeName(pr.headRepositoryNameWithOwner);
  const expectedName = normalizeName(headContext.headRepositoryNameWithOwner);
  return prName !== null && expectedName !== null && prName !== expectedName;
}

/**
 * Accepts a rename candidate only once the forge confirms the expected repository's current
 * name is the pull request's. Only near-misses reach the forge; failures read as "no match".
 */
export const makeRenamedRepositoryMatcher = Effect.fn("makeRenamedRepositoryMatcher")(function* (
  resolveProvider: (
    cwd: string,
  ) => Effect.Effect<
    SourceControlProvider.SourceControlProvider["Service"],
    SourceControlProviderError
  >,
) {
  const currentNames = yield* Cache.makeWith(
    Effect.fnUntraced(function* (key: string) {
      const separatorIndex = key.lastIndexOf(KEY_SEPARATOR);
      const cwd = key.slice(0, separatorIndex);
      const repository = key.slice(separatorIndex + 1);
      const provider = yield* resolveProvider(cwd);
      const cloneUrls = yield* provider.getRepositoryCloneUrls({ cwd, repository });
      return normalizeName(cloneUrls.nameWithOwner);
    }),
    {
      capacity: CURRENT_NAME_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? CURRENT_NAME_CACHE_TTL : Duration.zero),
    },
  );

  const matches = Effect.fn("RenamedRepositoryMatcher.matches")(function* (
    cwd: string,
    pr: RenameCandidatePullRequest,
    headContext: RenameCandidateHeadContext,
  ) {
    if (!isRenameCandidate(pr, headContext)) return false;
    const expected = normalizeName(headContext.headRepositoryNameWithOwner)!;
    const currentName = yield* Cache.get(currentNames, `${cwd}${KEY_SEPARATOR}${expected}`).pipe(
      Effect.orElseSucceed(() => null),
    );
    return currentName !== null && currentName === normalizeName(pr.headRepositoryNameWithOwner);
  });

  return { matches };
});
