import { createFileRoute, redirect } from "@tanstack/react-router";

import { isBoardPipelinePageAnchor } from "../board/boardSettingsSearch";
import { BoardSettingsPanel } from "../components/settings/BoardSettingsPanel";

export const Route = createFileRoute("/_chat/settings/board/")({
  beforeLoad: ({ location }) => {
    if (isBoardPipelinePageAnchor(location.hash)) {
      throw redirect({ to: "/settings/board/pipeline", hash: location.hash.replace(/^#/, "") });
    }
  },
  component: BoardSettingsPanel,
});
