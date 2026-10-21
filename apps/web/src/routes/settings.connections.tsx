import { createFileRoute } from "@tanstack/react-router";

import { ConnectionsSettings } from "../components/settings/ConnectionsSettings";
// T3o: a board thread on a worker links here with the worker's address (T3O-63).
import { validateConnectionsSearch } from "../board/workers/connectionsPrefill";

export const Route = createFileRoute("/settings/connections")({
  // T3o: see above.
  validateSearch: validateConnectionsSearch,
  component: ConnectionsSettings,
});
