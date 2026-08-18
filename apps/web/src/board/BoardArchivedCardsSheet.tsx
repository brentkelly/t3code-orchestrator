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
import { BoardCardId, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ArchiveRestoreIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
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

/** Re-read the archive after a restore, so the card leaves the list the
    moment it rejoins the board. */
export function refreshBoardArchivedCards(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
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
  const result = useAtomValue(archivedSnapshotAtom(environmentId));
  const snapshot = Option.getOrNull(AsyncResult.value(result));

  // Already newest-archived first from the server; scoping is the only thing
  // left to do, and it is the board's scope, not a second control.
  const cards = useMemo(
    () =>
      (snapshot?.cards ?? []).filter(
        (card) => scopeProjectId === null || card.projectId === scopeProjectId,
      ),
    [snapshot, scopeProjectId],
  );

  const restore = useCallback(
    (cardId: BoardCardId) => {
      onRestore(cardId);
    },
    [onRestore],
  );

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
          {result.waiting && snapshot === null ? (
            <p className="text-[13px] text-muted-foreground">Loading…</p>
          ) : cards.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No archived cards.</p>
          ) : (
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
                    onClick={() => restore(BoardCardId.make(card.cardId))}
                    size="icon-xs"
                    title="Restore card"
                    variant="ghost"
                  >
                    <ArchiveRestoreIcon />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
