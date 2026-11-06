import { createFileRoute } from "@tanstack/react-router";

import { BoardPipelineSettingsPage } from "../board/settings/BoardPipelineSettingsPage";

export const Route = createFileRoute("/_chat/settings/board/pipeline")({
  component: BoardPipelineSettingsPage,
});
