import { createFileRoute } from "@tanstack/react-router";

import { BoardPipelinePage } from "../board/settings/BoardPipelinePage";

export const Route = createFileRoute("/_chat/settings/board/pipeline")({
  component: BoardPipelinePage,
});
