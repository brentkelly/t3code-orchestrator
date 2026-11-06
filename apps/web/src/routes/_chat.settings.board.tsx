import { createFileRoute } from "@tanstack/react-router";

import { BoardSettingsLayout } from "../board/settings/BoardSettingsLayout";

export const Route = createFileRoute("/_chat/settings/board")({
  component: BoardSettingsLayout,
});
