import { createFileRoute } from "@tanstack/react-router";

import { BoardProjectSettingsPage } from "../board/settings/BoardProjectSettingsPage";

export const Route = createFileRoute("/_chat/settings/board/projects/$projectId/$tab")({
  component: BoardProjectSettingsRoute,
});

function BoardProjectSettingsRoute() {
  const { projectId, tab } = Route.useParams();
  // A new project is a new page: no draft or open row carries over to it.
  return <BoardProjectSettingsPage key={projectId} projectId={projectId} tab={tab} />;
}
