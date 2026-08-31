/**
 * The sub-board's plan strip (t3o-29): the dependency chart and the
 * final-review footer, above the columns — where the prototype puts them on
 * the drill-in, and in that order.
 *
 * Its own component rather than markup inside `BoardPage` for one reason: it
 * needs the parent's `board.subscribeCard` detail (the plan graph's edges and
 * the integration branch), and the root board must not open one. Mounted only
 * in sub-board scope, the subscription can never exist on the root board —
 * which a `useAtomValue` call in `BoardPage` could not promise, hooks being
 * unconditional.
 *
 * The atom is keyed, so this shares `BoardSubBoardHeader`'s subscription to
 * the same parent rather than opening a second one.
 */
import type {
  BoardCardId,
  BoardCardShell,
  BoardStageDefinition,
  EnvironmentId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";

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
}: {
  readonly environmentId: EnvironmentId;
  readonly parentCardId: BoardCardId;
  /** Every shell the client holds; the derivation picks this parent's
      children out of it. */
  readonly cards: ReadonlyArray<BoardCardShell>;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly chartOpen: boolean;
  readonly onOpenChild: (childCardId: string) => void;
}) {
  const detail = useAtomValue(
    boardEnvironment.cardDetailValueAtom({ environmentId, cardId: parentCardId }),
  );
  const planRows = useMemo(
    () =>
      detail === null
        ? null
        : deriveBoardPlanRows({
            plans: detail.plans,
            children: detail.children,
            cards,
            stages,
          }),
    [detail, cards, stages],
  );
  if (detail === null || planRows === null || planRows.rows.length === 0) return null;
  const final = boardPlanFinalReview({
    branch: detail.card.worktree?.branch ?? null,
    liveTotal: planRows.liveTotal,
    liveDone: planRows.liveDone,
  });
  return (
    <div className="flex shrink-0 flex-col gap-2.5 px-3 pb-3 sm:px-5">
      {chartOpen ? <BoardPlanGraph onOpenChild={onOpenChild} rows={planRows.rows} /> : null}
      <BoardPlanFinalReviewCard branch={final.branch} note={final.note} />
    </div>
  );
}
