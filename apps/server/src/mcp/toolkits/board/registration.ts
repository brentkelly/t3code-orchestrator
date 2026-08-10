/**
 * T3o board toolkit registration (t3o-08, D3).
 *
 * The board-owned layer the one-line seam in `McpHttpServer.ts` merges. Keeping
 * the `McpServer.toolkit` wiring here (not inline at the seam) is the seam
 * grammar: the upstream file gains only a merge, and every board detail —
 * tools, handlers, the services they require — grows in board-owned files. The
 * layer's requirements (`OrchestrationEngineService`, `ProjectionSnapshotQuery`,
 * `Crypto`, and the per-request `McpInvocationContext`) propagate outward and
 * are satisfied by the same runtime that already backs the ws board RPCs — no
 * new provision at the seam, exactly as the preview toolkit needs none for its
 * broker.
 */
import * as Layer from "effect/Layer";
import { McpServer } from "effect/unstable/ai";

import { BoardToolkitHandlersLive } from "./handlers.ts";
import { BoardToolkit } from "./tools.ts";

export const BoardToolkitRegistrationLive = McpServer.toolkit(BoardToolkit).pipe(
  Layer.provide(BoardToolkitHandlersLive),
);
