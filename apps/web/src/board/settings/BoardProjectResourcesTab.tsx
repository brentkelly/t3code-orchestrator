/**
 * T3o: a project's Resources tab (T3O-86): the baseline one M card reserves, the setup
 * timeout, the readiness script and its timeout, and the project's readiness on each worker.
 * The settings save whole, against the version they were loaded at.
 */
import {
  boardRepositoryGroupingKey,
  DEFAULT_BOARD_READINESS_SCRIPT_PATH,
  normalizeBoardReadinessPath,
  resolveBoardProjectResourceSettings,
  type BoardProjectResources,
  type BoardWorkerCapacitySnapshot,
  type BoardWorkerId,
  type BoardWorkerReadinessState,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { cn } from "../../lib/utils";
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { describeBoardCommandFailure } from "../boardCommandFeedback";
import { boardToast } from "../boardToast";
import { boardWorkerLabel } from "../workers/cardWorker";
import {
  BOARD_BASELINE_FIELDS,
  boardProjectWorkerRows,
  parseBoardBaselineField,
} from "./boardProjectResources.logic";
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

type Draft = Readonly<Record<string, string>>;

const draftOf = (resources: BoardProjectResources | null): Draft => {
  const resolved = resolveBoardProjectResourceSettings(resources);
  return {
    cpuCores: String(resolved.baseline.cpuCores),
    ramGiB: String(resolved.baseline.ramGiB),
    diskGB: String(resolved.baseline.diskGB),
    setupTimeoutMinutes: String(resolved.setupTimeoutMinutes),
    readinessPath: resources?.readinessPath ?? "",
    readinessTimeoutSeconds: String(resolved.readinessTimeoutSeconds),
  };
};

/** The draft as settings, or the first field that doesn't parse. */
function resourcesOf(
  draft: Draft,
): { readonly ok: BoardProjectResources } | { readonly error: string } {
  const baseline: Record<string, number> = {};
  for (const field of BOARD_BASELINE_FIELDS) {
    const value = parseBoardBaselineField(draft[field.key] ?? "");
    if (value === null) return { error: `${field.label} must be a positive number.` };
    baseline[field.key] = value;
  }
  const setupTimeoutMinutes = parseBoardBaselineField(draft.setupTimeoutMinutes ?? "");
  if (setupTimeoutMinutes === null) return { error: "The setup timeout must be positive." };
  const readinessTimeoutSeconds = parseBoardBaselineField(draft.readinessTimeoutSeconds ?? "");
  if (readinessTimeoutSeconds === null) return { error: "The readiness timeout must be positive." };
  const rawPath = (draft.readinessPath ?? "").trim();
  const readinessPath = rawPath === "" ? null : normalizeBoardReadinessPath(rawPath);
  if (rawPath !== "" && readinessPath === null) {
    return { error: "The readiness script must be a path inside the repository." };
  }
  return {
    ok: {
      baseline: {
        cpuCores: baseline.cpuCores!,
        ramGiB: baseline.ramGiB!,
        diskGB: baseline.diskGB!,
        setAtUpgrade: false,
      },
      setupTimeoutMinutes,
      readinessPath,
      readinessTimeoutSeconds,
    },
  };
}

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
  const setResources = useAtomCommand(boardEnvironment.setProjectResources, {
    reportFailure: false,
  });
  const capacityAction = useAtomCommand(boardEnvironment.capacityAction);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [output, setOutput] = useState<{ workerId: BoardWorkerId; text: string } | null>(null);
  const shown = draft ?? draftOf(resources);
  const parsed = resourcesOf(shown);
  const settings = resolveBoardProjectResourceSettings(resources);
  const snapshots = AsyncResult.isSuccess(capacityResult)
    ? capacityResult.value
    : NO_SNAPSHOTS;
  const rows = boardProjectWorkerRows({
    workers: [...snapshots.keys()].map((key) => {
      const workerId = key as BoardWorkerId;
      return { workerId, label: boardWorkerLabel(workerId, workersState) };
    }),
    snapshots,
    repositoryKey: boardRepositoryGroupingKey(project?.repositoryIdentity),
    readinessPath: settings.readinessPath,
    baseline: settings.baseline,
  });

  const save = () => {
    if (!("ok" in parsed)) return;
    void setResources({
      environmentId,
      input: {
        projectId: props.projectId,
        resources: parsed.ok,
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
      setDraft(null);
    });
  };

  const field = (key: string, label: string, unit: string, placeholder?: string) => (
    <label className="flex flex-col gap-1 text-board-12">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5">
        <Input
          aria-label={label}
          className="w-28"
          disabled={!canWrite}
          onChange={(event) => setDraft({ ...shown, [key]: event.target.value })}
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
          {resources?.baseline?.setAtUpgrade === true ? " Declared · set at upgrade." : ""}
        </p>
        <div className="flex flex-wrap gap-3">
          {BOARD_BASELINE_FIELDS.map((entry) => (
            <div key={entry.key}>{field(entry.key, entry.label, entry.unit)}</div>
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-board-13 font-medium">Setup and readiness</h3>
        <div className="flex flex-wrap gap-3">
          {field("setupTimeoutMinutes", "Setup timeout", "minutes")}
          {field(
            "readinessPath",
            "Readiness script",
            "",
            DEFAULT_BOARD_READINESS_SCRIPT_PATH,
          )}
          {field("readinessTimeoutSeconds", "Readiness timeout", "seconds")}
        </div>
        <p className="text-board-12 text-muted-foreground">
          The readiness script runs from the default branch on each worker before cards are
          placed there. Make it check the machine (tools, services, credentials), not files in
          the repository. With no script, a checkout counts as ready.
        </p>
      </section>
      {canWrite ? (
        <div className="flex items-center gap-2">
          <Button disabled={draft === null || !("ok" in parsed)} onClick={save} size="sm">
            Save
          </Button>
          {draft === null ? null : (
            <Button onClick={() => setDraft(null)} size="sm" variant="ghost-muted">
              Discard
            </Button>
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
                    {row.state === "not-ready" ? (
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
                              text: result._tag === "Success" ? (result.value ?? "") : "",
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
                {row.hardToPlace === null ? null : (
                  <p className="text-warning-foreground">Hard to place. {row.hardToPlace}</p>
                )}
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
