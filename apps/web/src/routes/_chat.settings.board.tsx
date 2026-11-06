import { createFileRoute } from "@tanstack/react-router";

import { BoardSettingsPanel } from "../components/settings/BoardSettingsPanel";

export const Route = createFileRoute("/_chat/settings/board")({
  component: BoardSettingsPanel,
});
