/**
 * T3o archived cards (t3o-13, D7) — the way back out of the archive.
 *
 * Archiving was a one-way door: `board.card.unarchive` and the detail modal's
 * Restore action both existed, but nothing listed an archived card, so neither
 * was reachable. This sheet is that list.
 *
 * It reads the archive-page snapshot the archived-threads panel already uses,
 * which the board enriches with archived cards server-side — the archive is a
 * page you open, never state every client carries, so archived cards stay off
 * the live shell and the delta stream (D15).
 */
import { type BoardCardId, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ArchiveRestoreIcon, LayersIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

import { Button } from "../components/ui/button";
import {
  Sheet,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
  SheetDescription,
} from "../components/ui/sheet";
import { orchestrationEnvironment } from "../state/orchestration";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { boardArchivedCardsInScope } from "./boardArchivedCards";
import { BoardDeleteConfirmDialog } from "./BoardDeleteConfirmDialog";
import { boardStageLabel } from "./boardStages";
import { BoardHint } from "./BoardHint";

function archivedSnapshotAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.archivedShellSnapshot({ environmentId, input: {} });
}

/** Re-read the archive, so a card that just left it (restore) or just joined
    it (archive) is reflected on the next render. */
export function refreshBoardArchivedCards(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
}

/**
 * The list itself, mounted ONLY while the sheet is open — that is what makes
 * the archive a page you open rather than a query every board mount pays for.
 *
 * The read is refreshed on open rather than left to the atom's own staleness
 * rule. `Atom.swr` skips revalidation entirely while the cached value is
 * younger than its 30s `staleTime`, and "archive a card, then go looking for
 * it" happens well inside that window — so without this the sheet would open
 * on a snapshot taken before the archive and show nothing. It also picks up
 * archives made from another device, which no local invalidation could.
 */
function ArchivedCardList({
  environmentId,
  liveCardKeyById,
  onDelete,
  onRestore,
  onSelectCard,
  scopeProjectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly liveCardKeyById: ReadonlyMap<string, string>;
  readonly onDelete: (cardId: BoardCardId) => void;
  readonly onRestore: (cardId: BoardCardId) => void;
  readonly onSelectCard: (cardId: BoardCardId) => void;
  readonly scopeProjectId: ProjectId | null;
}) {
  /** The card the confirmation is currently about; null when closed. Held as
      the card rather than a boolean so the dialog can name it, and cleared on
      close so a re-open cannot inherit the previous row. */
  const [pendingDelete, setPendingDelete] = useState<{
    readonly cardId: BoardCardId;
    readonly key: string;
  } | null>(null);
  useEffect(() => {
    refreshBoardArchivedCards(environmentId);
  }, [environmentId]);

  const result = useAtomValue(archivedSnapshotAtom(environmentId));
  const snapshot = Option.getOrNull(AsyncResult.value(result));

  const cards = useMemo(
    () => boardArchivedCardsInScope(snapshot?.cards ?? [], scopeProjectId),
    [snapshot, scopeProjectId],
  );

  // Resolves a card id to a key for the parent badge (t3o-25, AC6): live
  // parents come from the board's own key map, an archived parent from the
  // very list this sheet is rendering. An id neither can name (the parent was
  // purged) simply shows no badge.
  const parentKeyOf = useMemo(() => {
    const archivedKeyById = new Map(
      (snapshot?.cards ?? []).map((card) => [String(card.cardId), card.key]),
    );
    return (parentCardId: string): string | undefined =>
      liveCardKeyById.get(parentCardId) ?? archivedKeyById.get(parentCardId);
  }, [liveCardKeyById, snapshot]);

  if (result.waiting && snapshot === null) {
    return <p className="text-[13px] text-muted-foreground">Loading…</p>;
  }
  // A failed read must not read as an empty archive: "nothing was archived"
  // and "we could not find out" are opposite answers to the question the user
  // came here with, and this open-time read is the only one there is.
  if (result._tag === "Failure" && snapshot === null) {
    return <p className="text-[13px] text-muted-foreground">Could not load the archive.</p>;
  }
  if (cards.length === 0) {
    return <p className="text-[13px] text-muted-foreground">No archived cards.</p>;
  }
  return (
    <>
      <ul className="flex flex-col gap-1.5">
        {cards.map((card) => (
          <li
            className="flex items-center gap-[9px] rounded-lg border border-border bg-muted px-2.5 py-[7px]"
            key={card.cardId}
          >
            <button
              className="flex min-w-0 flex-1 items-center gap-[9px] text-left"
              onClick={() => onSelectCard(card.cardId)}
              type="button"
            >
              <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
                {card.key}
              </span>
              {(() => {
                const parentKey =
                  card.parentCardId === undefined
                    ? undefined
                    : parentKeyOf(String(card.parentCardId));
                return parentKey === undefined ? null : (
                  // A sub-board child names its parent (t3o-25, AC6) — the
                  // archive flattens every board into one list, so without
                  // this the child reads as a stray top-level card.
                  <BoardHint label={`Part of ${parentKey}'s sub-board`}>
                    <span className="inline-flex h-4 shrink-0 items-center rounded bg-muted-foreground/14 px-1.5 text-[10px] font-medium text-muted-foreground">
                      <LayersIcon className="mr-0.5 size-2.5" />
                      {parentKey}
                    </span>
                  </BoardHint>
                );
              })()}
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                {card.title}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {boardStageLabel(snapshot?.boardStages ?? [], card.stage)}
              </span>
              {card.archivedAt === null ? null : (
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {formatRelativeTimeLabel(card.archivedAt)}
                </span>
              )}
            </button>
            <Button
              onClick={() => onRestore(card.cardId)}
              size="icon-xs"
              title="Restore card"
              variant="ghost"
            >
              <ArchiveRestoreIcon />
            </Button>
            <Button
              onClick={() => setPendingDelete({ cardId: card.cardId, key: card.key })}
              size="icon-xs"
              title="Delete card permanently"
              variant="ghost"
            >
              <Trash2Icon />
            </Button>
          </li>
        ))}
      </ul>
      {/* The archive snapshot is the bounded card shell, which carries neither
          a thread count nor a branch, so the dialog is told nothing rather than
          told zero — its copy stays general in that case. */}
      <BoardDeleteConfirmDialog
        cardKey={pendingDelete?.key ?? ""}
        dependents={[]}
        onConfirm={() => {
          if (pendingDelete !== null) onDelete(pendingDelete.cardId);
        }}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        open={pendingDelete !== null}
      />
    </>
  );
}

export function BoardArchivedCardsSheet({
  environmentId,
  liveCardKeyById,
  onDelete,
  onOpenChange,
  onRestore,
  onSelectCard,
  open,
  scopeProjectId,
}: {
  readonly environmentId: EnvironmentId;
  /** Live card ids → keys, from the board (t3o-25): resolves an archived
      child's badge when its parent is still on the live board. */
  readonly liveCardKeyById: ReadonlyMap<string, string>;
  /** Purge the card outright — always behind this sheet's own confirmation. */
  readonly onDelete: (cardId: BoardCardId) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRestore: (cardId: BoardCardId) => void;
  readonly onSelectCard: (cardId: BoardCardId) => void;
  readonly open: boolean;
  /** Null means every project — the archive follows the board's own scope, so
      what you see here matches the board you opened it from. */
  readonly scopeProjectId: ProjectId | null;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup>
        <SheetHeader>
          <SheetTitle>Archived cards</SheetTitle>
          <SheetDescription>
            Restoring a card returns it to the stage it was archived from. Cards that depend on it
            are blocked again if it is not done. Deleting one erases it, its threads and its
            branches for good.
          </SheetDescription>
        </SheetHeader>
        {/* No `open` gate here: the portal renders while `mounted`, which is
            already false whenever the sheet is closed — so the query still
            cannot start before there is a reader — and stays true through the
            exit animation, which an `open` gate would render blank. */}
        <SheetPanel>
          <ArchivedCardList
            environmentId={environmentId}
            liveCardKeyById={liveCardKeyById}
            onDelete={onDelete}
            onRestore={onRestore}
            onSelectCard={onSelectCard}
            scopeProjectId={scopeProjectId}
          />
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
