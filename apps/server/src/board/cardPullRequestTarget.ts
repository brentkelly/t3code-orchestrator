/**
 * Pure: turns an agent's or a person's PR reference into a number on the card's
 * own repository. The forge gateway addresses only that repository, so anything
 * else is refused here, before any forge call.
 */
import type { BoardCardPullRequestTarget } from "@t3tools/contracts";

import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import type { BoardRepository } from "./boardRepository.ts";

const positiveNumber = (digits: string): number | null => {
  const value = Number(digits);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
};

/** Read the card detail's input. Null for anything that names no pull request. */
export function parseCardPullRequestText(text: string): BoardCardPullRequestTarget | null {
  const value = text.trim();
  const bare = /^#?(\d+)$/u.exec(value);
  if (bare !== null) {
    const number = positiveNumber(bare[1]!);
    return number === null ? null : { number };
  }
  const short = /^([^\s#]+\/[^\s#]+)#(\d+)$/u.exec(value);
  if (short !== null) {
    const number = positiveNumber(short[2]!);
    return number === null ? null : { repository: short[1]!, number };
  }
  if (/^https?:\/\//iu.test(value)) return { url: value };
  return null;
}

/**
 * A repository as an agent might write it — `owner/repo`, `owner/repo.git`,
 * `github.com/owner/repo` or its URL — lower case, without scheme, `.git` or
 * trailing slash. A host-qualified form keeps its host; the comparison below
 * matches it by suffix.
 */
function repositoryPath(repository: string): string {
  return repository
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//u, "")
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "");
}

/** The repository path of a pull request URL, as the board compares it. Null when unrecognised. */
function pullRequestUrlTarget(url: string): { repository: string; number: number } | null {
  const parsed = sourceControlDefinitions.parseChangeRequestUrl(url)?.link ?? null;
  if (parsed === null) return null;
  const repository = sourceControlDefinitions
    .canonicalRepositoryKey(`${parsed.host}/${parsed.repository}`)
    .split("/")
    .slice(1)
    .join("/");
  return { repository, number: parsed.number };
}

function sameRepository(named: string, own: string): boolean {
  return named === own || named.endsWith(`/${own}`);
}

/** A refusal the forge may overturn: a repository renamed since `origin` was set. */
export interface OtherRepositoryRefusal {
  readonly refused: string;
  readonly reason: "other-repository";
  readonly repository: string;
  readonly number: number;
}

/**
 * T3o (T3O-119): whether the pull request the forge returned for an other-repository
 * refusal is the one the target named, because the board's repository was renamed.
 */
export function confirmsRenamedRepositoryTarget(
  refusal: OtherRepositoryRefusal,
  pullRequestUrl: string,
): boolean {
  const confirmed = pullRequestUrlTarget(pullRequestUrl);
  return (
    confirmed !== null &&
    confirmed.number === refusal.number &&
    sameRepository(refusal.repository, confirmed.repository)
  );
}

/**
 * The pull request number to link, or why it cannot be linked. `repository` is
 * the board's (`origin`). Compared by path, not host: a Forgejo URL carries a
 * port the project's identity does not.
 */
export function resolveCardPullRequestTarget(
  target: BoardCardPullRequestTarget,
  boardRepository: BoardRepository | null | undefined,
):
  | { readonly number: number }
  | { readonly refused: string; readonly reason?: undefined }
  | OtherRepositoryRefusal {
  let repository: string | undefined;
  let number: number | undefined;
  if (target.url !== undefined) {
    const parsed = pullRequestUrlTarget(target.url);
    if (parsed === null) {
      return {
        refused: `'${target.url}' is not a recognised pull request URL. Pass the pull request's URL, its number, or its repository and number.`,
      };
    }
    repository = parsed.repository;
    number = parsed.number;
  } else {
    repository = target.repository === undefined ? undefined : repositoryPath(target.repository);
    number = target.number;
  }
  if (number === undefined) {
    return { refused: "Name the pull request: pass its url, or its number (with its repository)." };
  }
  const own = boardRepository?.path ?? null;
  if (own === null) {
    return { refused: "This card's project has no recognised source-control remote to link from." };
  }
  if (repository !== undefined && !sameRepository(repository, own)) {
    return {
      reason: "other-repository",
      repository,
      number,
      refused: `Pull request ${repository}#${number} is not in this card's repository (${own}); only a pull request on the card's own repository can be linked.`,
    };
  }
  return { number };
}
