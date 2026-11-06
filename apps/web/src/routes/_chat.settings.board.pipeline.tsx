import { createFileRoute, redirect } from "@tanstack/react-router";

// The global pipeline moved back onto Settings → Board; old links land on it there.
export const Route = createFileRoute("/_chat/settings/board/pipeline")({
  beforeLoad: ({ location }) => {
    const anchor = location.hash.replace(/^#/, "");
    throw redirect({ to: "/settings/board", hash: anchor === "" ? "board-pipeline" : anchor });
  },
});
