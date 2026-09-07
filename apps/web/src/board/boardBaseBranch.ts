/**
 * Pure helpers behind the card's base-branch picker (T3O-5, D11/D12).
 *
 * Split out of the component so the two decisions that actually matter — what a
 * click on a ref STORES, and which ref the picker shows as current — are unit
 * tested without a repository, a websocket or a DOM. The component is then the
 * plumbing it looks like.
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
 * The picker's rows. `listRefs` returns local branches plus remote-only refs
 * deduped against them, so a branch that exists only on the remote arrives as
 * `origin/develop`; it is shown under that name (it is what the user would type)
 * and stored under `develop` (D12), because every reader of a recorded base
 * re-qualifies it as `refs/heads/<name>` and breaks silently on the other form.
 *
 * Refs whose local name is not a usable base — the shapes
 * `isBoardCardBaseBranchShape` rejects — are dropped rather than offered and
 * then refused by the decider.
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
 * What selecting `option` writes to `board.card.update` (D12).
 *
 * Choosing the project's CURRENT default stores `null`, not the branch's name.
 * That is what keeps the nullable override meaningful: a project that later
 * renames or moves its default carries every card that never expressed an
 * opinion along with it, instead of stranding a fleet pinned to a dead branch.
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
