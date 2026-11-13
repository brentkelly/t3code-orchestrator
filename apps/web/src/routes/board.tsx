/**
 * The lazy /board route. Board state lives in search params (`?project`,
 * `?card`), not child routes: a card URL is selection over the same mounted
 * surface.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Suspense, lazy } from "react";

const BoardPage = lazy(() => import("../board/BoardPage"));

export interface BoardSearch {
  /** Project scope; absent means "All projects" (a view, not an entity). */
  readonly project?: string;
  /** Deep-linked card: selected and scrolled into view on open. */
  readonly card?: string;
  /** Show only stalled cards: the "find every stalled card"
      affordance. Absent / false means show everything. */
  readonly stalled?: boolean;
  /** T3o: the worker filter, by worker id or `unplaced`, comma-separated (T3O-87). */
  readonly worker?: string;
}

/** Shared with the sub-board route — the two scopes are the same
    surface, so their search params must stay one grammar. */
export function validateBoardSearch(search: Record<string, unknown>): BoardSearch {
  const nonEmpty = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  const project = nonEmpty(search.project);
  const card = nonEmpty(search.card);
  const stalled = search.stalled === true || search.stalled === "true";
  const worker = nonEmpty(search.worker);
  return {
    ...(project === undefined ? {} : { project }),
    ...(card === undefined ? {} : { card }),
    ...(stalled ? { stalled: true } : {}),
    ...(worker === undefined ? {} : { worker }),
  };
}

function BoardRoute() {
  return (
    <Suspense fallback={null}>
      <BoardPage />
    </Suspense>
  );
}

export const Route = createFileRoute("/board")({
  validateSearch: validateBoardSearch,
  beforeLoad: ({ context }) => {
    // Same gate as the threads surface (_chat.tsx): the board is workspace
    // chrome, not a public page.
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: BoardRoute,
});
