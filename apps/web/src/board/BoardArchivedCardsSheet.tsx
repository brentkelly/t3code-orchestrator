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
import {
  type BoardCardId,
  type BoardCardShell,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ArchiveRestoreIcon } from "lucide-react";
import { useEffect, useMemo } from "react";
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
import { BOARD_STAGE_LABELS } from "./boardStages";

function archivedSnapshotAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.archivedShellSnapshot({ environmentId, input: {} });
}

/** Re-read the archive, so a card that just left it (restore) or just joined
    it (archive) is reflected on the next render. */
export function refreshBoardArchivedCards(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
}

/**
 * The archived cards this sheet should show: the board's own project scope
 * applied to the archive snapshot, nothing else. The server already returns
 * them newest-archived first — the card you just archived by mistake is the
 * one you came to restore — so this must not reorder them.
 *
 * Pure and exported so the rule is testable without mounting a portal.
 */
export function boardArchivedCardsInScope(
  cards: ReadonlyArray<BoardCardShell>,
  scopeProjectId: ProjectId | null,
): ReadonlyArray<BoardCardShell> {
  if (scopeProjectId === null) return cards;
  return cards.filter((card) => card.projectId === scopeProjectId);
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
  onRestore,
  onSelectCard,
  scopeProjectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly onRestore: (cardId: BoardCardId) => void;
  readonly onSelectCard: (cardId: BoardCardId) => void;
  readonly scopeProjectId: ProjectId | null;
}) {
  useEffect(() => {
    refreshBoardArchivedCards(environmentId);
  }, [environmentId]);

  const result = useAtomValue(archivedSnapshotAtom(environmentId));
  const snapshot = Option.getOrNull(AsyncResult.value(result));

  const cards = useMemo(
    () => boardArchivedCardsInScope(snapshot?.cards ?? [], scopeProjectId),
    [snapshot, scopeProjectId],
  );

  if (result.waiting && snapshot === null) {
    return <p className="text-[13px] text-muted-foreground">Loading…</p>;
  }
  if (cards.length === 0) {
    return <p className="text-[13px] text-muted-foreground">No archived cards.</p>;
  }
  return (
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
            <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
              {card.title}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {BOARD_STAGE_LABELS[card.stage]}
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
        </li>
      ))}
    </ul>
  );
}

export function BoardArchivedCardsSheet({
  environmentId,
  onOpenChange,
  onRestore,
  onSelectCard,
  open,
  scopeProjectId,
}: {
  readonly environmentId: EnvironmentId;
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
            are blocked again if it is not done.
          </SheetDescription>
        </SheetHeader>
        <SheetPanel>
          {/* Gated on `open`, not just on the portal's own mounting, so the
              query cannot start before there is a reader for it. */}
          {open ? (
            <ArchivedCardList
              environmentId={environmentId}
              onRestore={onRestore}
              onSelectCard={onSelectCard}
              scopeProjectId={scopeProjectId}
            />
          ) : null}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
