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
import type { BoardCardPullRequestTarget, RepositoryIdentity } from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { canonicalRepositoryKey } from "@t3tools/shared/sourceControl";

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

/** The project's repository path below its host, lower case — `owner/repo`. */
function projectRepositoryPath(identity: RepositoryIdentity | null | undefined): string | null {
  if (!identity) return null;
  const canonical = canonicalRepositoryKey(identity.canonicalKey.trim().toLowerCase());
  const separator = canonical.indexOf("/");
  return separator === -1 ? null : canonical.slice(separator + 1);
}

/**
 * The pull request number to link, or why it cannot be linked.
 *
 * The repository is compared by its path below the host, not by host: a
 * Forgejo URL carries a port the project's portless identity does not, and
 * two hosts serving the same `owner/repo` to one project is not a case worth
 * a false refusal.
 */
export function resolveCardPullRequestTarget(
  target: BoardCardPullRequestTarget,
  identity: RepositoryIdentity | null | undefined,
): { readonly number: number } | { readonly refused: string } {
  let repository: string | undefined;
  let number: number | undefined;
  if (target.url !== undefined) {
    const parsed = parseChangeRequestUrl(target.url);
    if (parsed === null) {
      return {
        refused: `'${target.url}' is not a recognised pull request URL. Pass the pull request's URL, its number, or its repository and number.`,
      };
    }
    repository = canonicalRepositoryKey(`${parsed.host}/${parsed.repository}`)
      .split("/")
      .slice(1)
      .join("/");
    number = parsed.number;
  } else {
    repository = target.repository?.trim().toLowerCase();
    number = target.number;
  }
  if (number === undefined) {
    return { refused: "Name the pull request: pass its url, or its number (with its repository)." };
  }
  const own = projectRepositoryPath(identity);
  if (own === null) {
    return { refused: "This card's project has no recognised source-control remote to link from." };
  }
  if (repository !== undefined && repository.toLowerCase() !== own) {
    return {
      refused: `Pull request ${repository}#${number} is not in this card's repository (${own}); only a pull request on the card's own repository can be linked.`,
    };
  }
  return { number };
}
