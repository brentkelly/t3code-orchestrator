/**
 * T3o /board route — lazy so the board bundle stays out of the thread path.
 */
import { createFileRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";

const BoardPage = lazy(() => import("../board/BoardPage"));

function BoardRoute() {
  return (
    <Suspense fallback={null}>
      <BoardPage />
    </Suspense>
  );
}

export const Route = createFileRoute("/board")({
  component: BoardRoute,
});
