import { createFileRoute } from "@tanstack/react-router";

import { BoardWorkersSettingsPage } from "../board/workers/BoardWorkerSettings";

export const Route = createFileRoute("/_chat/settings/board/workers")({
  component: BoardWorkersSettingsPage,
});
