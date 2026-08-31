/**
 * T3o sub-board drill-in route (t3o-25): `/board/<parentCardId>` renders the
 * SAME board surface scoped to one parent's children (D1) — a place, so it
 * gets a path segment, unlike `?card`, which stays selection state over
 * whichever board is mounted. The `board_` file prefix keeps it a sibling of
 * `/board` rather than a child rendered inside it: the root board has no
 * outlet, and the two scopes replace each other whole.
 *
 * The childless / stale-link redirect (D3) lives in `BoardPage`, not here —
 * it needs the shell snapshot, which arrives after mount.
 */
import { BoardCardId } from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Suspense, lazy, useMemo } from "react";

import type { BoardScope } from "../board/boardScope";
import { validateBoardSearch } from "./board";

const BoardPage = lazy(() => import("../board/BoardPage"));

function SubBoardRoute() {
  const { parentCardId } = Route.useParams();
  // Memoised so the scope's identity is stable across re-renders — the page's
  // redirect effects key on it.
  const scope = useMemo<BoardScope>(
    () => ({ kind: "sub-board", parentCardId: BoardCardId.make(parentCardId) }),
    [parentCardId],
  );
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
