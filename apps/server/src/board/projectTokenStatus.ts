import { BoardSnapshotError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { SourceControlDriverEntry } from "../sourceControl/builtInDrivers.ts";
import type { ThreadGatewayShape } from "./ThreadGateway.ts";

/**
 * T3O-58: Settings → Source Control's project tokens, for this environment's live projects.
 * The GitHub driver does the work (`t3oProjectTokens`); a build without it answers empty.
 */
export const boardProjectTokenStatus = Effect.fn("Board.projectTokenStatus")(function* (
  threads: Pick<ThreadGatewayShape, "projects">,
  drivers: ReadonlyArray<SourceControlDriverEntry>,
) {
  const projects = yield* threads
    .projects()
    .pipe(
      Effect.mapError(
        (cause) => new BoardSnapshotError({ message: "Failed to list projects.", cause }),
      ),
    );
  const status = drivers.find((entry) => entry.instance.t3oProjectTokens)?.instance
    .t3oProjectTokens;
  if (status === undefined) return [];
  return yield* status(
    projects
      .filter((project) => !project.deleted)
      .map((project) => ({
        projectId: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
      })),
  );
});
