/**
 * The sub-board's plan strip: dependency chart and final-review footer. Its own
 * component so the parent's card subscription exists only in sub-board scope.
 * The keyed atom shares `BoardSubBoardHeader`'s subscription.
 */
import type {
  BoardCardId,
  BoardCardShell,
  BoardStageDefinition,
  EnvironmentId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";

import { boardEnvironment } from "../state/board";
import { BoardPlanFinalReviewCard } from "./BoardPlanFinalReviewCard";
import { BoardPlanGraph } from "./BoardPlanGraph";
import { boardPlanFinalReview, deriveBoardPlanRows } from "./boardPlanRows";

export function BoardSubBoardPlanStrip({
  environmentId,
  parentCardId,
  cards,
  stages,
  chartOpen,
  onOpenChild,
  ownBranch,
}: {
  readonly environmentId: EnvironmentId;
  readonly parentCardId: BoardCardId;
  /** Every shell the client holds; the derivation picks this parent's
      children out of it. */
  readonly cards: ReadonlyArray<BoardCardShell>;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly chartOpen: boolean;
  readonly onOpenChild: (childCardId: string) => void;
  /** The final review banner describes an integration branch, so
      only an own-branch group shows it. */
  readonly ownBranch: boolean;
}) {
  const detail = useAtomValue(
    boardEnvironment.cardDetailValueAtom({ environmentId, cardId: parentCardId }),
  );
  const planRows =
    detail === null
      ? null
      : deriveBoardPlanRows({
          plans: detail.plans,
          children: detail.children,
          cards,
          stages,
        });
  if (detail === null || planRows === null || planRows.rows.length === 0) return null;
  const final = boardPlanFinalReview({
    branch: detail.card.worktree?.branch ?? null,
    liveTotal: planRows.liveTotal,
    liveDone: planRows.liveDone,
  });
  return (
    <div className="flex shrink-0 flex-col gap-2.5 px-3 pb-3 sm:px-5">
      {chartOpen ? <BoardPlanGraph onOpenChild={onOpenChild} rows={planRows.rows} /> : null}
      {ownBranch ? <BoardPlanFinalReviewCard branch={final.branch} note={final.note} /> : null}
    </div>
  );
}
