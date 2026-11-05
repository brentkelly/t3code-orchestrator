/**
 * T3o /list route (T3O-30): the List view, the whole card tree as an outline.
 * Lazy, like `/board`, so neither bundle rides the thread path. It shares the
 * board's search grammar: `?project` scopes it and `?card` opens a card.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Suspense, lazy } from "react";

import { validateBoardSearch } from "./board";

const BoardListPage = lazy(() => import("../board/BoardListPage"));

function ListRoute() {
  return (
    <Suspense fallback={null}>
      <BoardListPage />
    </Suspense>
  );
}

export const Route = createFileRoute("/list")({
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
  component: ListRoute,
});
