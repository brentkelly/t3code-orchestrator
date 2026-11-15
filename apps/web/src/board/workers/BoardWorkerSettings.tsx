/**
 * T3o: Settings → Board → Workers (Remote Workers prototype 2.1): the machines that take this
 * board's cards, each with the projects it has checked out. The address workers join on is
 * set where it is used, in the Add worker dialog.
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { searchableSetting } from "../../components/settings/settingsSearch";
import { SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { readPreparedConnection } from "../../state/session";
import { useBoardSettingsContext } from "../settings/BoardSettingsLayout";
import { useBoardSettings } from "../useBoardEnvironmentId";
import { useBoardWorkers, usePruneWorkerThreadEnvironments } from "./boardWorkersState";
import { AddWorkerButton, useAddWorker, WorkersSection } from "./WorkersSection";

/** Where workers reach this board when no address is set: the board connection's
    address (it can be another origin than this page's), else this page's origin. */
function fallbackBoardUrl(environmentId: EnvironmentId): string {
  const prepared = readPreparedConnection(environmentId);
  return prepared === null ? window.location.origin : new URL(prepared.httpBaseUrl).origin;
}

export function BoardWorkersSettingsPage() {
  const { environmentId, canWrite } = useBoardSettingsContext();
  const workers = useBoardWorkers(environmentId);
  // A worker removed here takes its proxied environment with it.
  usePruneWorkerThreadEnvironments(environmentId);
  const addWorker = useAddWorker({ environmentId, workers });
  const boardAddress = useBoardSettings((settings) => settings.board.workers.boardAddress);
  const workersAnchor = searchableSetting("board-workers");

  return (
    <SettingsSection
      id="board-workers"
      title={workersAnchor.title}
      variant="plain"
      headerAction={
        workers.loading || workers.failed || !canWrite ? null : (
          <AddWorkerButton onClick={addWorker.start} />
        )
      }
    >
      <p className="mb-3 max-w-2xl px-3 text-board-13 leading-board-1-55 text-muted-foreground/80 sm:px-4">
        Machines that take this board's cards. When a card's build starts, the board places it on a
        ready worker with room unless you pin the card to one. Planning always runs on this server.
      </p>
      {workers.loading || workers.failed ? (
        <div className="mx-3 flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3 shadow-xs sm:mx-4">
          {workers.failed ? (
            <div className="flex items-center justify-between gap-3 py-2">
              <div className="flex flex-col">
                <span className="text-board-13-5 font-medium">Couldn't load workers</span>
                <span className="text-xs text-muted-foreground">
                  The board server didn't answer. Your workers and cards are unchanged.
                </span>
              </div>
              <Button size="sm" variant="outline" onClick={workers.retry}>
                Retry
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2 py-2 text-board-13 text-muted-foreground">
              <Spinner className="size-3.5" /> Checking…
            </div>
          )}
        </div>
      ) : (
        <WorkersSection
          environmentId={environmentId}
          workers={workers}
          addWorker={addWorker}
          boardUrl={boardAddress ?? fallbackBoardUrl(environmentId)}
          boardUrlIsFallback={boardAddress === null}
        />
      )}
    </SettingsSection>
  );
}
