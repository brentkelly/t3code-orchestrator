/**
 * `/board/<parentCardId>`: the board scoped to one parent's children. The `board_`
 * prefix makes it a sibling of `/board`, not a child: the root board has no outlet.
 * The childless and stale-link redirect lives in `BoardPage`, which has the shell.
 */
import { BoardCardId } from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Suspense, lazy } from "react";

import type { BoardScope } from "../board/boardScope";
import { validateBoardSearch } from "./board";

const BoardPage = lazy(() => import("../board/BoardPage"));

function SubBoardRoute() {
  const { parentCardId } = Route.useParams();
  const scope: BoardScope = { kind: "sub-board", parentCardId: BoardCardId.make(parentCardId) };
  return (
    <Suspense fallback={null}>
      <BoardPage scope={scope} />
    </Suspense>
  );
}

export const Route = createFileRoute("/board_/$parentCardId")({
  validateSearch: validateBoardSearch,
  beforeLoad: ({ context }) => {
    // Same gate as `/board`: workspace chrome, not a public page.
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: SubBoardRoute,
});
