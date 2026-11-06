import { createFileRoute } from "@tanstack/react-router";

import { BoardProjectSettingsPage } from "../board/settings/BoardProjectSettingsPage";

export const Route = createFileRoute("/_chat/settings/board/projects/$projectId/$tab")({
  component: BoardProjectSettingsRoute,
});

function BoardProjectSettingsRoute() {
  const { projectId, tab } = Route.useParams();
  return <BoardProjectSettingsPage projectId={projectId} tab={tab} />;
}
