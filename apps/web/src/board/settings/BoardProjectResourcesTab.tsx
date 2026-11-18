/**
 * T3o: a project's Resources tab (T3O-86): the baseline one M card reserves, the setup
 * timeout, the readiness script and its timeout, and the project's readiness on each worker.
 * The settings save whole, against the version they were loaded at.
 */
import {
  boardReadinessRequest,
  boardRepositoryGroupingKey,
  DEFAULT_BOARD_READINESS_SCRIPT_PATH,
  boardBaselineWithLearned,
  EMPTY_BOARD_PROJECT_RESOURCES,
  boardProjectResourcesWithoutLearned,
  resolveBoardProjectBaseline,
  resolveBoardProjectDeclared,
  resolveBoardProjectResourceSettings,
  type BoardProjectResources,
  type BoardResourceDimension,
  type BoardWorkerCapacitySnapshot,
  type BoardWorkerId,
  type BoardWorkerReadinessState,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

import { setBoardProjectSetting } from "../../components/settings/BoardSettingsPanel.logic";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { Input } from "../../components/ui/input";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { describeBoardCommandFailure } from "../boardCommandFeedback";
import { boardToast } from "../boardToast";
import { useBoardSettings, useUpdateBoardSettings } from "../useBoardEnvironmentId";
import { boardWorkerLabel } from "../workers/cardWorker";
import {
  BOARD_BASELINE_FIELDS,
  BOARD_READINESS_STARTER_SCRIPT,
  boardBaselineSaveNotice,
  boardProjectHardToPlace,
  boardProjectWorkerRows,
  boardResourcesDraftOf,
  boardResourcesOf,
  type BoardResourcesDraft,
} from "./boardProjectResources.logic";
import { BoardProjectLearnedTable } from "./BoardProjectLearnedTable";
import { useBoardSettingsContext, useBoardSettingsProjects } from "./BoardSettingsLayout";
import type { BoardProjectConfigState } from "./useBoardProjectConfig";

const STATE_LABELS: Readonly<Record<BoardWorkerReadinessState, string>> = {
  "not-set-up": "Not set up",
  cloning: "Cloning",
  checking: "Checking",
  ready: "Ready",
  "not-ready": "Not ready",
};

const NO_SNAPSHOTS: ReadonlyMap<string, BoardWorkerCapacitySnapshot> = new Map();

export function BoardProjectResourcesTab(props: {
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly config: BoardProjectConfigState;
}) {
  const { environmentId, canWrite } = useBoardSettingsContext();
  const { shell } = props.config;
  const resources = shell.resources ?? null;
  const project = useBoardSettingsProjects(environmentId).find(
    (candidate) => candidate.id === props.projectId,
  );
  const workersState = useAtomValue(boardEnvironment.workersAtom(environmentId));
  const capacityResult = useAtomValue(boardEnvironment.capacityAtom({ environmentId, input: {} }));
  const columns = useAtomValue(boardEnvironment.cardsByProjectAtom(environmentId)).get(
    props.projectId,
  );
  const placedCards =
    columns === undefined
      ? 0
      : Object.values(columns)
          .flat()
          .filter((card) => card.archivedAt === null && card.worktreeReady === true).length;
  const boardSettings = useBoardSettings((settings) => settings.board);
  const updateBoardSettings = useUpdateBoardSettings();
  const trusted = boardSettings.projects[props.projectId]?.trustReadinessScript ?? false;
  const [confirming, setConfirming] = useState<string | null>(null);
  const starter = useCopyToClipboard({ target: "starter script" });
  const setResources = useAtomCommand(boardEnvironment.setProjectResources, {
    reportFailure: false,
  });
  const capacityAction = useAtomCommand(boardEnvironment.capacityAction);
  const [draft, setDraft] = useState<BoardResourcesDraft | null>(null);
  const [output, setOutput] = useState<{ workerId: BoardWorkerId; text: string } | null>(null);
  const shown = draft ?? boardResourcesDraftOf(resources);
  const parsed = boardResourcesOf(shown, resources);
  const settings = resolveBoardProjectResourceSettings(resources);
  const snapshots = AsyncResult.isSuccess(capacityResult) ? capacityResult.value : NO_SNAPSHOTS;
  const readinessRequest = boardReadinessRequest(resources, trusted);
  const rows = boardProjectWorkerRows({
    workers: [...snapshots.keys()].map((key) => {
      const workerId = key as BoardWorkerId;
      return { workerId, label: boardWorkerLabel(workerId, workersState) };
    }),
    snapshots,
    repositoryKey: boardRepositoryGroupingKey(project?.repositoryIdentity),
    projectId: props.projectId,
    readinessPath: settings.readinessPath,
    readinessConfigKey: readinessRequest.configKey,
    readinessConfigured: readinessRequest.configured,
  });
  // T3o (T3O-87): the form edits the declared baseline; placements use it with learning.
  const declaredBaseline = resolveBoardProjectDeclared(resources);
  const withLearning = (next: BoardProjectResources): BoardProjectResources => ({
    ...next,
    ...(resources?.pinDeclared === undefined ? {} : { pinDeclared: resources.pinDeclared }),
    ...(resources?.learned === undefined ? {} : { learned: resources.learned }),
  });
  const hardToPlace = boardProjectHardToPlace(
    "ok" in parsed ? resolveBoardProjectBaseline(withLearning(parsed.ok)) : settings.baseline,
    rows,
  );

  const send = (next: BoardProjectResources, onSaved?: () => void) =>
    void setResources({
      environmentId,
      input: {
        projectId: props.projectId,
        resources: boardProjectResourcesWithoutLearned(next),
        expectedConfigVersion: shell.version,
      },
    }).then((result) => {
      if (result._tag === "Failure") {
        boardToast({
          title: "Couldn't save Resources",
          description: describeBoardCommandFailure(result),
          tone: "error",
        });
        return;
      }
      onSaved?.();
    });
  const current = resources ?? EMPTY_BOARD_PROJECT_RESOURCES;
  const pin = (dimension: BoardResourceDimension, pinned: boolean) => {
    const others = (current.pinDeclared ?? []).filter((entry) => entry !== dimension);
    send({ ...current, pinDeclared: pinned ? [...others, dimension] : others });
  };
  // Use learned writes the decrease as the declared value, editable back by hand.
  const applyLearned = (dimension: BoardResourceDimension, value: number) =>
    send({ ...current, baseline: boardBaselineWithLearned(current, dimension, value) });

  const save = (confirmed: boolean) => {
    if (!("ok" in parsed)) return;
    const notice = boardBaselineSaveNotice(
      placedCards,
      declaredBaseline,
      resolveBoardProjectDeclared(parsed.ok),
    );
    if (notice !== null && !confirmed) {
      setConfirming(notice);
      return;
    }
    setConfirming(null);
    send(parsed.ok, () => setDraft(null));
  };

  const field = (key: string, label: string, unit: string, placeholder?: string) => (
    <label className="flex flex-col gap-1 text-board-12">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5">
        <Input
          aria-label={label}
          className="w-28"
          disabled={!canWrite}
          onChange={(event) => {
            setDraft({ ...shown, [key]: event.target.value });
            setConfirming(null);
          }}
          placeholder={placeholder}
          value={shown[key] ?? ""}
        />
        <span className="text-muted-foreground">{unit}</span>
      </span>
    </label>
  );

  return (
    <div className="flex flex-col gap-5 px-3 pb-6 sm:px-4">
      <section className="flex flex-col gap-2">
        <h3 className="text-board-13 font-medium">Baseline</h3>
        <p className="text-board-12 text-muted-foreground">
          What one M card of {props.projectTitle} reserves on its worker. S, L and XL scale it.
          {resources?.baseline?.setAtUpgrade === true
            ? " Declared · set at upgrade: check it against your workers."
            : ""}
        </p>
        <div className="flex flex-wrap gap-3">
          {BOARD_BASELINE_FIELDS.map((entry) => (
            <div key={entry.key}>
              {field(entry.key, entry.label, entry.unit, String(declaredBaseline[entry.key]))}
            </div>
          ))}
        </div>
        <BoardProjectLearnedTable
          canWrite={canWrite}
          onPin={pin}
          onUseLearned={applyLearned}
          resources={resources}
        />
        {hardToPlace.length === 0 ? null : (
          <div className="flex flex-col gap-0.5 rounded-md bg-warning-surface px-3 py-2 text-board-12 text-warning-foreground">
            <span className="font-medium">Hard to place</span>
            {hardToPlace.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </div>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-board-13 font-medium">Setup and readiness</h3>
        <div className="flex flex-wrap gap-3">
          {field(
            "setupTimeoutMinutes",
            "Setup timeout",
            "minutes",
            String(settings.setupTimeoutMinutes),
          )}
          {field("readinessPath", "Readiness script", "", DEFAULT_BOARD_READINESS_SCRIPT_PATH)}
          {field(
            "readinessTimeoutSeconds",
            "Readiness timeout",
            "seconds",
            String(settings.readinessTimeoutSeconds),
          )}
        </div>
        <p className="text-board-12 text-muted-foreground">
          Each worker checks a project before cards are placed there, then hourly. The checks in
          t3o.json (resources.readiness.checks) are run by T3o itself:{" "}
          {settings.readinessChecks.length === 0
            ? "this project has none."
            : `this project has ${settings.readinessChecks.length}.`}{" "}
          A readiness script runs only if you trust the project. With neither, a checkout counts as
          ready.
        </p>
        <label className="flex items-start gap-2 text-board-12">
          <Switch
            aria-label="Run this project's readiness script"
            checked={trusted}
            className="mt-0.5 shrink-0"
            disabled={!canWrite}
            onCheckedChange={(next) =>
              updateBoardSettings({
                board: {
                  projects: setBoardProjectSetting(boardSettings.projects, props.projectId, {
                    trustReadinessScript: next,
                  }),
                },
              })
            }
            size="sm"
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium">Run this project's readiness script</span>
            <span className="text-muted-foreground">
              Runs <span className="font-mono">{settings.readinessPath}</span> from the project's
              default branch on every worker, every hour, as you. Only for projects whose code you
              trust: whatever lands on that branch runs next.
            </span>
          </span>
        </label>
        <details className="text-board-12">
          <summary className="cursor-pointer text-muted-foreground">Starter script</summary>
          <div className="mt-2 flex flex-col items-start gap-2">
            <pre className="w-full overflow-auto rounded-md bg-muted p-2 font-mono text-board-11 whitespace-pre">
              {BOARD_READINESS_STARTER_SCRIPT}
            </pre>
            <Button
              onClick={() => starter.copyToClipboard(BOARD_READINESS_STARTER_SCRIPT)}
              size="xs"
              variant="outline"
            >
              {starter.isCopied ? <CheckIcon /> : <CopyIcon />}
              {starter.isCopied ? "Copied" : "Copy"}
            </Button>
          </div>
        </details>
      </section>
      {canWrite ? (
        <div className="flex items-center gap-2">
          <Button
            disabled={draft === null || !("ok" in parsed)}
            onClick={() => save(confirming !== null)}
            size="sm"
          >
            {confirming === null ? "Save" : "Save anyway"}
          </Button>
          {draft === null ? null : (
            <Button
              onClick={() => {
                setDraft(null);
                setConfirming(null);
              }}
              size="sm"
              variant="ghost-muted"
            >
              Discard
            </Button>
          )}
          {confirming === null ? null : (
            <span className="text-board-12 text-muted-foreground">{confirming}</span>
          )}
          {"error" in parsed ? (
            <span className="text-board-12 text-warning-foreground">{parsed.error}</span>
          ) : null}
        </div>
      ) : null}
      <section className="flex flex-col gap-2">
        <h3 className="text-board-13 font-medium">On each worker</h3>
        {rows.length === 0 ? (
          <p className="text-board-12 text-muted-foreground">No worker has reported yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {rows.map((row) => (
              <li key={row.workerId} className="flex flex-col gap-1 px-3 py-2 text-board-12-5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{row.label}</span>
                  <span
                    className={cn(
                      "rounded-full px-1.5 text-board-11",
                      row.state === "not-ready"
                        ? "bg-warning-surface text-warning-foreground"
                        : row.state === "checking" || row.state === "cloning"
                          ? "bg-info/10 text-info-foreground"
                          : "bg-accent text-muted-foreground",
                    )}
                  >
                    {row.state === null ? "Not checked" : STATE_LABELS[row.state]}
                  </span>
                  {row.detail === null ? null : (
                    <span className="text-muted-foreground">{row.detail}</span>
                  )}
                  <span className="ml-auto flex gap-1">
                    <Button
                      onClick={() =>
                        void capacityAction({
                          environmentId,
                          input: {
                            action: "recheck",
                            workerId: row.workerId,
                            projectId: props.projectId,
                          },
                        })
                      }
                      size="xs"
                      variant="outline"
                    >
                      Re-check
                    </Button>
                    {row.state === "not-ready" || row.hasNotice ? (
                      <Button
                        onClick={() =>
                          void capacityAction({
                            environmentId,
                            input: {
                              action: "readinessOutput",
                              workerId: row.workerId,
                              projectId: props.projectId,
                            },
                          }).then((result) =>
                            setOutput({
                              workerId: row.workerId,
                              text:
                                result._tag === "Success"
                                  ? (result.value ?? "")
                                  : "Couldn't read the output from the worker.",
                            }),
                          )
                        }
                        size="xs"
                        variant="ghost-muted"
                      >
                        Output
                      </Button>
                    ) : null}
                  </span>
                </div>
                {output?.workerId === row.workerId ? (
                  <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-board-11 whitespace-pre-wrap">
                    {output.text.length === 0 ? "No output." : output.text}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
