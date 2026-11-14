/**
 * T3o: a card's size and setup, in a collapsed Resources section of its detail's rail
 * (T3O-86, T3O-100): an S/M/L/XL control per dimension with the reservation it makes, the
 * planner's reason and Reset, the Too-big note, and the setup's stages with Retry, Cancel and
 * its log. The lines come from `boardCardCapacity.ts`.
 */
import {
  boardCardEffectiveWorkerId,
  BOARD_CARD_SIZE_LETTERS,
  BOARD_RESOURCE_DIMENSIONS,
  type BoardCard,
  type BoardCardSize,
  type BoardCardSizeLetter,
  type BoardProjectResources,
  type BoardWorkersState,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { cn } from "../lib/utils";
import { boardEnvironment } from "../state/board";
import { useAtomCommand } from "../state/use-atom-command";
import {
  boardCardCapacityView,
  boardCardResourcesSummary,
  boardCardSetupView,
  type BoardCardCapacityView,
  type BoardCardSetupView,
} from "./boardCardCapacity";
import { BoardCollapsibleSection } from "./BoardCardFields";
import { boardWorkerLabel } from "./workers/cardWorker";

const DIMENSION_LABELS = { cpu: "CPU", ram: "RAM", disk: "Disk" } as const;

function SetupStages({ setup }: { readonly setup: BoardCardSetupView }) {
  return (
    <ol className="flex flex-col gap-1">
      {setup.stages.map((stage) => (
        <li key={stage.label} className="flex items-center gap-2 text-board-12">
          <span
            aria-hidden
            className={cn(
              "size-2 shrink-0 rounded-full border",
              stage.status === "done" && "border-muted-foreground bg-muted-foreground",
              stage.status === "running" && "border-info bg-info",
              stage.status === "failed" && "border-warning bg-warning",
              (stage.status === "pending" || stage.status === "skipped") &&
                "border-muted-foreground",
            )}
          />
          <span
            className={cn(
              stage.status === "running" ? "text-info-foreground" : "text-muted-foreground",
            )}
          >
            {stage.label}
            {stage.status === "skipped" ? " · skipped" : ""}
          </span>
        </li>
      ))}
    </ol>
  );
}

function BoardCardCapacityPanel(props: {
  readonly capacity: BoardCardCapacityView;
  readonly setup: BoardCardSetupView;
  readonly projectId: string;
  readonly onSetSize: (size: BoardCardSize | null) => void;
  readonly onSetupAction: (action: "retry" | "cancel") => void;
  readonly setupOpen: boolean;
  readonly onToggleSetup: () => void;
  /** The fetched log's text, or null until "Open full log" is pressed. */
  readonly log: string | null;
  readonly onOpenLog: () => void;
}) {
  const { capacity, setup, log } = props;
  const showSetupDetail = setup.collapsed === null || props.setupOpen;
  return (
    <div className="flex flex-col gap-2.5 text-board-12">
      <div className="flex flex-col gap-0.5 text-muted-foreground">
        <span>Reserves {capacity.reservation}</span>
        <span>
          Baseline {capacity.baseline} ·{" "}
          <Link
            className="underline"
            params={{ projectId: props.projectId, tab: "resources" }}
            to="/settings/board/projects/$projectId/$tab"
          >
            Edit in project
          </Link>
        </span>
      </div>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5">
        {BOARD_RESOURCE_DIMENSIONS.map((dimension) => (
          <div key={dimension} className="contents">
            <span className="text-muted-foreground">{DIMENSION_LABELS[dimension]}</span>
            <ToggleGroup
              aria-label={`${DIMENSION_LABELS[dimension]} size`}
              className="w-full *:flex-1"
              onValueChange={(next) => {
                const letter = next[0] as BoardCardSizeLetter | undefined;
                if (letter === undefined || letter === capacity.size[dimension]) return;
                props.onSetSize({ ...capacity.size, [dimension]: letter });
              }}
              value={[capacity.size[dimension]]}
            >
              {BOARD_CARD_SIZE_LETTERS.map((letter) => (
                <Toggle key={letter} value={letter}>
                  {letter}
                </Toggle>
              ))}
            </ToggleGroup>
          </div>
        ))}
      </div>
      {capacity.provenance === null && !capacity.canReset ? null : (
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
          {capacity.provenance === null ? null : <span>{capacity.provenance}</span>}
          {capacity.canReset ? (
            <Button onClick={() => props.onSetSize(null)} size="xs" variant="ghost-muted">
              Reset to planner
            </Button>
          ) : null}
        </div>
      )}
      {capacity.tooBig === null ? null : (
        <p className="rounded-md bg-warning-surface px-2 py-1 text-warning-foreground">
          Too big. {capacity.tooBig}
        </p>
      )}
      {capacity.granted === null ? null : (
        <p className="text-muted-foreground">{capacity.granted}</p>
      )}
      {setup.stages.length === 0 ? null : (
        <div className="flex flex-col gap-1.5">
          {setup.collapsed === null ? (
            <span className="font-medium text-foreground">Setup</span>
          ) : (
            <button
              className="self-start text-muted-foreground hover:text-foreground"
              onClick={props.onToggleSetup}
              type="button"
            >
              {setup.collapsed}
            </button>
          )}
          {showSetupDetail ? (
            <>
              <SetupStages setup={setup} />
              {setup.failure === null ? null : (
                <p className="text-warning-foreground">{setup.failure}</p>
              )}
              <div className="flex flex-wrap gap-1.5">
                {setup.canRetry ? (
                  <Button onClick={() => props.onSetupAction("retry")} size="xs" variant="outline">
                    Retry
                  </Button>
                ) : null}
                {setup.canCancel ? (
                  <Button onClick={() => props.onSetupAction("cancel")} size="xs" variant="outline">
                    Cancel setup
                  </Button>
                ) : null}
                <Button onClick={props.onOpenLog} size="xs" variant="ghost-muted">
                  Open full log
                </Button>
              </div>
              {log === null ? null : (
                <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-board-11 whitespace-pre-wrap">
                  {log.length === 0 ? "No output." : log}
                </pre>
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** The panel wired to the board: a card's commands, and its worker's capacity when the card
    has no worktree yet (the only time Too big applies). */
export function BoardCardCapacityPanelHost(props: {
  readonly environmentId: EnvironmentId;
  readonly card: BoardCard;
  readonly projectResources: BoardProjectResources | null;
  readonly workersState: BoardWorkersState;
  readonly stepFailed: boolean;
}) {
  const { card, environmentId } = props;
  const placed =
    card.worktree !== null &&
    (card.worktree.status === "ready" || card.worktree.status === "provisioning");
  // Where it holds a worktree, else its pin: never a stale placement.
  const workerId = boardCardEffectiveWorkerId(card);
  const capacityResult = useAtomValue(boardEnvironment.capacityAtom({ environmentId, input: {} }));
  const snapshot = AsyncResult.isSuccess(capacityResult)
    ? (capacityResult.value.get(workerId) ?? null)
    : null;
  const updateCard = useAtomCommand(boardEnvironment.updateCard);
  const setupAction = useAtomCommand(boardEnvironment.cardSetupAction);
  const capacityAction = useAtomCommand(boardEnvironment.capacityAction);
  const workerLabel = boardWorkerLabel(workerId, props.workersState);
  const capacity = boardCardCapacityView({
    resources: card.resources,
    projectResources: props.projectResources,
    placed,
    pinned: card.pinnedWorkerId !== null,
    worker: snapshot === null ? null : { label: workerLabel, declared: snapshot.declared },
  });
  const setup = boardCardSetupView({
    setup: card.resources?.setup ?? null,
    workerLabel,
    stepFailed: props.stepFailed,
  });
  const summary = boardCardResourcesSummary(capacity, setup);
  // Held here, not in the panel: collapsing Resources unmounts the panel.
  const [setupOpen, setSetupOpen] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  return (
    <BoardCollapsibleSection
      className="border-t border-border p-3.5"
      summary={
        <span
          className={cn(
            summary.tone === "blocked" && "text-warning-foreground",
            summary.tone === "running" && "text-info-foreground",
          )}
        >
          {summary.text}
        </span>
      }
      title="Resources"
    >
      <BoardCardCapacityPanel
        capacity={capacity}
        log={log}
        onOpenLog={() => {
          void capacityAction({
            environmentId,
            input: { action: "setupLog", cardId: card.id },
          }).then((result) =>
            setLog(
              result._tag === "Success"
                ? (result.value ?? "")
                : "Couldn't read the log from the worker.",
            ),
          );
        }}
        onSetSize={(size) => void updateCard({ environmentId, input: { cardId: card.id, size } })}
        onSetupAction={(action) =>
          void setupAction({ environmentId, input: { cardId: card.id, action } })
        }
        onToggleSetup={() => setSetupOpen((open) => !open)}
        projectId={card.projectId}
        setup={setup}
        setupOpen={setupOpen}
      />
    </BoardCollapsibleSection>
  );
}
