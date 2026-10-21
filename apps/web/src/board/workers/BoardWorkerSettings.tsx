/**
 * T3o (T3O-62): the Workers and Project checkouts sections of Settings →
 * Board. Project checkouts appears only once the board has a worker besides
 * this server: a local-only board's settings read exactly as before.
 */
import { isLocalOnlyBoardWorkers, type EnvironmentId } from "@t3tools/contracts";

import { searchableSetting } from "../../components/settings/settingsSearch";
import { SettingsSection } from "../../components/settings/settingsLayout";
import { useBoardWorkers } from "./boardWorkersState";
import { ProjectCheckoutsSection } from "./ProjectCheckoutsSection";
import { WorkersSection } from "./WorkersSection";

export function BoardWorkerSettings(props: { readonly environmentId: EnvironmentId }) {
  const workers = useBoardWorkers(props.environmentId);
  const workersAnchor = searchableSetting("board-workers");
  const checkoutsAnchor = searchableSetting("board-project-checkouts");
  const showCheckouts = !workers.loading && !isLocalOnlyBoardWorkers(workers.state);
  return (
    <>
      <SettingsSection id="board-workers" title={workersAnchor.title} variant="plain">
        <p className="mb-2 max-w-xl px-3 text-[13px] leading-[1.55] text-muted-foreground/80 sm:px-4">
          Machines that run cards for this board. This server hosts the board and is always a
          worker. Cards run on the default worker unless you pin them to another.
        </p>
        <WorkersSection
          environmentId={props.environmentId}
          onSetUpProjects={() =>
            document
              .getElementById("board-project-checkouts")
              ?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
        />
      </SettingsSection>
      {showCheckouts ? (
        <SettingsSection id="board-project-checkouts" title={checkoutsAnchor.title} variant="plain">
          <p className="mb-2 max-w-xl px-3 text-[13px] leading-[1.55] text-muted-foreground/80 sm:px-4">
            A worker can only run cards for projects it has a checkout of. Set up clones the repo
            from its git remote into the worker's projects folder, using that machine's git
            credentials.
          </p>
          <ProjectCheckoutsSection environmentId={props.environmentId} />
        </SettingsSection>
      ) : null}
    </>
  );
}
