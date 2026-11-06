/**
 * Naming a pull request to link to a card (T3O-18).
 *
 * Pure: turns what an agent passed (a URL, or repository and number) or what
 * a person typed into the card's "Link one" input (`#312`, `312`,
 * `owner/repo#312`, a URL) into the one thing the board can act on — a number
 * on the card's own project repository. The board's forge gateway addresses
 * only that repository, so a pull request anywhere else is refused here with
 * a message that says so, before any forge call.
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

/**
 * The pull request number to link, or why it cannot be linked.
 *
 * `repository` is the board's — the project's `origin` (T3O-24), which in a
 * fork is not the project identity's upstream.
 *
 * The repository is compared by its path below the host, not by host: a
 * Forgejo URL carries a port the project's portless identity does not, and
 * two hosts serving the same `owner/repo` to one project is not a case worth
 * a false refusal.
 */
export function resolveCardPullRequestTarget(
  target: BoardCardPullRequestTarget,
  boardRepository: BoardRepository | null | undefined,
): { readonly number: number } | { readonly refused: string } {
  let repository: string | undefined;
  let number: number | undefined;
  if (target.url !== undefined) {
    const parsed = sourceControlDefinitions.parseChangeRequestUrl(target.url)?.link ?? null;
    if (parsed === null) {
      return {
        refused: `'${target.url}' is not a recognised pull request URL. Pass the pull request's URL, its number, or its repository and number.`,
      };
    }
    repository = sourceControlDefinitions
      .canonicalRepositoryKey(`${parsed.host}/${parsed.repository}`)
      .split("/")
      .slice(1)
      .join("/");
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
  if (repository !== undefined && repository !== own && !repository.endsWith(`/${own}`)) {
    return {
      refused: `Pull request ${repository}#${number} is not in this card's repository (${own}); only a pull request on the card's own repository can be linked.`,
    };
  }
  return { number };
}
