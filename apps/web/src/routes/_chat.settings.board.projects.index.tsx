import { createFileRoute } from "@tanstack/react-router";

import { BoardProjectsPage } from "../board/settings/BoardProjectsPage";

export const Route = createFileRoute("/_chat/settings/board/projects/")({
  component: BoardProjectsPage,
});
