/**
 * Pure helpers behind the card's base-branch picker: what a click stores and
 * which ref shows as current.
 */
import { isBoardCardBaseBranchShape } from "@t3tools/contracts";
import type { VcsRef } from "@t3tools/contracts";
import { deriveLocalBranchNameFromRemoteRef } from "@t3tools/shared/git";

/** One row of the picker: the ref's own name (what `listRefs` returned), the
    LOCAL name selecting it would store, and whether it is the repo default. */
export interface BoardBaseBranchOption {
  readonly name: string;
  readonly localName: string;
  readonly isDefault: boolean;
}

/**
 * The picker's rows. A remote-only ref shows as `origin/develop` but stores as
 * `develop`, because readers re-qualify a base as `refs/heads/<name>`. Shapes
 * `isBoardCardBaseBranchShape` rejects are dropped.
 */
export function boardBaseBranchOptions(
  refs: ReadonlyArray<VcsRef>,
): ReadonlyArray<BoardBaseBranchOption> {
  const seen = new Set<string>();
  const options: BoardBaseBranchOption[] = [];
  for (const ref of refs) {
    const localName = ref.isRemote ? deriveLocalBranchNameFromRemoteRef(ref.name) : ref.name;
    if (!isBoardCardBaseBranchShape(localName)) continue;
    if (seen.has(localName)) continue;
    seen.add(localName);
    options.push({ name: ref.name, localName, isDefault: ref.isDefault === true });
  }
  return options;
}

/**
 * What selecting `option` writes. The project's current default stores `null`,
 * so cards follow the project if its default branch later changes.
 */
export function boardBaseBranchSelectionValue(
  option: Pick<BoardBaseBranchOption, "localName" | "isDefault">,
): string | null {
  return option.isDefault ? null : option.localName;
}

/**
 * The row the picker marks as chosen: the card's pin, or the repo default when
 * it has none. Null while the refs are still loading and the card has no pin —
 * there is nothing honest to point at yet.
 */
export function boardBaseBranchSelectedName(input: {
  readonly baseBranch: string | null;
  readonly options: ReadonlyArray<BoardBaseBranchOption>;
}): string | null {
  if (input.baseBranch !== null) return input.baseBranch;
  return input.options.find((option) => option.isDefault)?.localName ?? null;
}

const NEXT_PAGE_DISTANCE_PX = 96;

/** Whether a scroll should fetch the next branch page: only a downward scroll that reaches the
    end, never mount or layout. Upstream dropped its copy with its move to Legend List. */
export function shouldLoadNextBranchPageAfterScroll(input: {
  readonly previousScrollTop: number | null;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}): boolean {
  if (input.previousScrollTop === null || input.scrollTop <= input.previousScrollTop) {
    return false;
  }
  return input.scrollHeight - input.scrollTop - input.clientHeight <= NEXT_PAGE_DISTANCE_PX;
}
