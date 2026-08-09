/**
 * T3o /board route — lazy so the board bundle stays out of the thread path.
 *
 * Board state is addressed with search params, not child routes: `?project`
 * scopes the board and `?card` deep-links one card. A card URL is selection
 * state over the same mounted surface — the detail pane t3o-06 adds opens
 * from the param without remounting the board, the two params compose
 * (`/board?project=p&card=c`), and D13's notification deep-links get their
 * stable card URL now, before t3o-06 builds against it. A child route would
 * model the card as a different *place* and force the pane/board split into
 * the route tree for no gain.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Suspense, lazy } from "react";

const BoardPage = lazy(() => import("../board/BoardPage"));

export interface BoardSearch {
  /** Project scope; absent means "All projects" (a view, not an entity). */
  readonly project?: string;
  /** Deep-linked card: selected and scrolled into view on open. */
  readonly card?: string;
}

function BoardRoute() {
  return (
    <Suspense fallback={null}>
      <BoardPage />
    </Suspense>
  );
}

export const Route = createFileRoute("/board")({
  validateSearch: (search: Record<string, unknown>): BoardSearch => {
    const nonEmpty = (value: unknown): string | undefined =>
      typeof value === "string" && value.length > 0 ? value : undefined;
    const project = nonEmpty(search.project);
    const card = nonEmpty(search.card);
    return {
      ...(project === undefined ? {} : { project }),
      ...(card === undefined ? {} : { card }),
    };
  },
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
