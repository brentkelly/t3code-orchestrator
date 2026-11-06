import { gitenvToken } from "@t3tools/shared/gitenv";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * T3o (t3o-34, T3O-67): the directory the current GitHub API call acts on, set from each
 * provider call's `cwd`. `GitHubRequestPolicy.credential` resolves pinned credential, then this
 * project's gitenv token, then the ambient sources. See docs/t3o/gitenv.md.
 */
export const T3oGitenvProject = Context.Reference<string | null>(
  "@t3tools/source-control-github/server/t3oGitenvCredential/T3oGitenvProject",
  { defaultValue: () => null },
);

/** gitenv is github.com-only: an entry never authenticates a request to another host. */
const GITENV_HOST = "github.com";

/**
 * The project's gitenv credential for `host`, or null when no project is in scope, the host is
 * not github.com, or the project has no entry. The fingerprint is `host:sha256(token)`, the
 * shape `GitHubCredentials` uses, so read caches and rate-limit scopes keep the two identities
 * apart.
 */
export const t3oGitenvCredential = Effect.fnUntraced(function* (host: string) {
  const project = yield* T3oGitenvProject;
  if (project === null || host !== GITENV_HOST) return null;
  const match = gitenvToken(project);
  if (match === undefined) return null;
  return { token: Redacted.make(match.token), fingerprint: `${host}:${match.digest}` };
});

/**
 * Runs `invalidate` (the ambient credential cache's reset) unless the refused request carried
 * the project's gitenv token: that token never came from the cache, so dropping the cache would
 * only force a needless re-read.
 */
export const t3oInvalidateAmbientUnlessGitenv = <E, R>(
  host: string,
  refusedFingerprint: string,
  invalidate: Effect.Effect<void, E, R>,
) =>
  t3oGitenvCredential(host).pipe(
    Effect.flatMap((gitenv) =>
      gitenv?.fingerprint === refusedFingerprint ? Effect.void : invalidate,
    ),
  );

/**
 * The gitenv project a batched read was asked under: the matched main checkout, or "" when no
 * entry applies. Lookups grouped into one request share one token, so this belongs in every
 * batch key (`GitHubGraphQlClient.batchKey`, which all aliased GitHub reads use).
 */
export const t3oGitenvBatchKey = <S>(context: Context.Context<S>): string => {
  const project = Context.getOrElse(context, T3oGitenvProject, () => null);
  return project === null ? "" : (gitenvToken(project)?.root ?? "");
};

/**
 * Runs every Effect-returning method of a provider under its call's `cwd`, so each GitHub API
 * request it makes resolves that project's gitenv credential. A method without a string `cwd`
 * on its first argument, or one that does not return an Effect, passes through untouched.
 */
export const t3oWithGitenvProject = <T extends object>(service: T): T =>
  Object.fromEntries(
    Object.entries(service).map(([name, member]) => [
      name,
      typeof member === "function"
        ? (...args: ReadonlyArray<unknown>) => {
            const result: unknown = member(...args);
            const first = args[0];
            const cwd =
              typeof first === "object" && first !== null && "cwd" in first ? first.cwd : undefined;
            if (!Effect.isEffect(result) || typeof cwd !== "string") return result;
            // Generic over every method; each keeps its own channels through the `as T` below.
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off
            return Effect.provideService(result, T3oGitenvProject, cwd);
          }
        : member,
    ]),
  ) as T;
