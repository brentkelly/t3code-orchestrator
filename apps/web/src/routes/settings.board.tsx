import { createFileRoute } from "@tanstack/react-router";

import { BoardSettingsPanel } from "../components/settings/BoardSettingsPanel";

export const Route = createFileRoute("/settings/board")({
  component: BoardSettingsPanel,
});
