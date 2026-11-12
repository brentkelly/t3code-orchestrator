/**
 * T3o: Settings → Workers (prototype 3.1), its own page under Board. The
 * workers, the address they join on, and which projects each has checked out.
 */
import { BoardAddress, isLocalOnlyBoardWorkers, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { searchableSetting } from "../../components/settings/settingsSearch";
import { SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Spinner } from "../../components/ui/spinner";
import { readPreparedConnection } from "../../state/session";
import { BoardSettingsCard, BoardSettingsCardRow } from "../settings/boardSettingsCards";
import { useBoardSettingsContext } from "../settings/BoardSettingsLayout";
import { useBoardSettings, useUpdateBoardSettings } from "../useBoardEnvironmentId";
import { useBoardWorkers } from "./boardWorkersState";
import { ProjectCheckoutsSection } from "./ProjectCheckoutsSection";
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
  const addWorker = useAddWorker({ environmentId, workers });
  const boardAddress = useBoardSettings((settings) => settings.board.workers.boardAddress);
  const workersAnchor = searchableSetting("board-workers");
  const checkoutsAnchor = searchableSetting("board-project-checkouts");
  const showCheckouts = !workers.loading && !isLocalOnlyBoardWorkers(workers.state);
  const focusAddress = () => {
    const input = document.getElementById(BOARD_ADDRESS_INPUT_ID);
    input?.scrollIntoView({ behavior: "smooth", block: "center" });
    input?.focus();
  };

  return (
    <>
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
        <p className="mb-2 max-w-xl px-3 text-board-13 leading-board-1-55 text-muted-foreground/80 sm:px-4">
          Machines that run cards for this board. This server hosts the board and is always a
          worker; others join with a one-time code. Cards run on the default worker unless you pin
          them to another.
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
            onSetBoardAddress={focusAddress}
            onSetUpProjects={() =>
              document
                .getElementById("board-project-checkouts")
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          />
        )}
      </SettingsSection>
      <BoardAddressSection saved={boardAddress} disabled={!canWrite} />
      {showCheckouts ? (
        <SettingsSection id="board-project-checkouts" title={checkoutsAnchor.title} variant="plain">
          <p className="mb-2 max-w-xl px-3 text-board-13 leading-board-1-55 text-muted-foreground/80 sm:px-4">
            A worker can only run cards for projects it has a checkout of. Set up clones the repo
            from its git remote into the worker's projects folder, using that machine's git
            credentials.
          </p>
          <ProjectCheckoutsSection environmentId={environmentId} />
        </SettingsSection>
      ) : null}
    </>
  );
}

const BOARD_ADDRESS_INPUT_ID = "board-address-input";

const isBoardAddress = Schema.is(BoardAddress);

function BoardAddressSection(props: { readonly saved: string | null; readonly disabled: boolean }) {
  const update = useUpdateBoardSettings();
  const anchor = searchableSetting("board-address");
  // A draft only while editing; otherwise the field shows the saved address.
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const next = draft.trim();
    // An address the board would refuse stays in the field, marked, until it's fixed.
    if (next.length > 0 && !isBoardAddress(next)) return;
    setDraft(null);
    if (next === (props.saved ?? "")) return;
    update({ board: { workers: { boardAddress: next.length === 0 ? null : next } } });
  };
  return (
    <SettingsSection id="board-address" title={anchor.title} variant="plain">
      <BoardSettingsCard>
        <BoardSettingsCardRow
          label="Board address"
          description="The address workers join and connect to, shown in the join command. Leave empty to use the address this board is open on."
          control={
            <Input
              id={BOARD_ADDRESS_INPUT_ID}
              className="w-64"
              size="sm"
              disabled={props.disabled}
              placeholder="https://board.example"
              value={draft ?? props.saved ?? ""}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === "Enter") commit();
                if (event.key === "Escape") setDraft(null);
              }}
              aria-label="Board address"
              aria-invalid={
                draft !== null && draft.trim().length > 0 && !isBoardAddress(draft.trim())
              }
            />
          }
        />
      </BoardSettingsCard>
    </SettingsSection>
  );
}
