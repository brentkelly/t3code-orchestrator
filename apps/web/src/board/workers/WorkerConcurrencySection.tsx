/**
 * T3o (T3O-65, D11; prototype 3.1): Settings → Board → Concurrency on a board
 * with workers. The board limit first, then one block per worker — its own
 * limit on the header line, its provider instances indented below. Each
 * worker's providers are the ones it reports (this server's come from its own
 * config); an offline worker shows the last it reported, and a revoked or
 * incompatible one says why there is nothing to configure.
 *
 * A local-only board never renders this: its Concurrency section is exactly
 * what it was.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION,
  clampBoardInstanceCap,
  resolveBoardWorkerConcurrency,
  type BoardConcurrencySettings,
  type BoardConcurrencySettingsPatch,
  type BoardWorkerId,
  type BoardWorkersState,
  type BoardWorkerView,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "../../components/ui/badge";
import { NumberStepper } from "../../components/settings/BoardPipelineSection";
import { BoardHint } from "../BoardHint";
import {
  BOARD_CONCURRENCY_COLLAPSE_AT,
  boardLimitPatch,
  boardWorkerCapSummary,
  boardWorkerInstanceCapPatch,
  boardWorkerLimitPatch,
  boardWorkerLimitsWarning,
} from "./workerConcurrency";
import { workerStatusPresentation, type WorkerTone } from "./workerCopy";

const TONE_BADGE: Record<WorkerTone, "outline" | "info" | "warning" | "success"> = {
  neutral: "outline",
  running: "info",
  warning: "warning",
  done: "success",
};

interface WorkerBlock {
  readonly workerId: BoardWorkerId;
  readonly label: string;
  readonly worker: BoardWorkerView | null;
  readonly instanceIds: ReadonlyArray<string>;
}

export function WorkerConcurrencySection(props: {
  readonly concurrency: BoardConcurrencySettings;
  readonly workers: BoardWorkersState;
  /** This server's provider instances, from its own config. */
  readonly localInstanceIds: ReadonlyArray<string>;
  readonly onChange: (patch: BoardConcurrencySettingsPatch) => void;
}) {
  const { concurrency, workers } = props;
  const blocks: ReadonlyArray<WorkerBlock> = [
    {
      workerId: BOARD_LOCAL_WORKER_ID,
      label: "This server (local)",
      worker: null,
      instanceIds: props.localInstanceIds,
    },
    ...workers.workers.map((worker) => ({
      workerId: worker.id,
      label: worker.label,
      worker,
      instanceIds: (worker.snapshot?.providers ?? []).map((provider) =>
        String(provider.instanceId),
      ),
    })),
  ];
  const collapsible = blocks.length >= BOARD_CONCURRENCY_COLLAPSE_AT;
  const warning = boardWorkerLimitsWarning(
    concurrency,
    blocks.map((block) => block.workerId),
  );
  return (
    <div className="mx-3 flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3 shadow-xs sm:mx-4">
      <p className="text-xs text-muted-foreground">
        Cards wait in the queue when any limit that applies to them is reached.
      </p>
      <div className="flex items-center justify-between gap-4 py-1.5">
        <div className="flex min-w-0 flex-col">
          <span className="text-[13.5px] text-foreground">Board limit</span>
          <span className="text-xs text-muted-foreground">
            Most agents running at once across all workers
          </span>
        </div>
        <NumberStepper
          ariaLabel="Board concurrency limit"
          max={99}
          min={1}
          onChange={(value) => {
            if (value !== concurrency.globalMaxConcurrent) {
              props.onChange(boardLimitPatch(concurrency, value));
            }
          }}
          value={concurrency.globalMaxConcurrent}
        />
      </div>
      <div className="h-px bg-border" />
      <div className="flex items-baseline justify-between gap-2 pt-1">
        <span className="text-[12px] font-medium text-muted-foreground">Per worker</span>
        {warning === null ? null : (
          <span className="text-[11.5px] text-warning-foreground">{warning}</span>
        )}
      </div>
      {blocks.map((block) => (
        <WorkerConcurrencyBlock
          block={block}
          collapsible={collapsible}
          concurrency={concurrency}
          key={block.workerId}
          onChange={props.onChange}
        />
      ))}
    </div>
  );
}

function WorkerConcurrencyBlock(props: {
  readonly block: WorkerBlock;
  readonly collapsible: boolean;
  readonly concurrency: BoardConcurrencySettings;
  readonly onChange: (patch: BoardConcurrencySettingsPatch) => void;
}) {
  const { block, concurrency } = props;
  const [expanded, setExpanded] = useState(!props.collapsible);
  const resolved = resolveBoardWorkerConcurrency(concurrency, block.workerId);
  const workerLimit = resolved.maxConcurrent;
  const status =
    block.worker === null
      ? { label: "Online", tone: "neutral" as const }
      : workerStatusPresentation(block.worker, "this board");
  const state = block.worker?.status.state ?? "online";
  const configurable = state !== "unauthorized" && state !== "incompatible";
  const open = expanded || !props.collapsible;

  return (
    <div className="flex flex-col gap-1 border-t border-border/60 pt-2">
      <div className="flex items-center gap-2">
        {props.collapsible ? (
          <button
            aria-label={open ? `Collapse ${block.label}` : `Expand ${block.label}`}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded(!open)}
            type="button"
          >
            {open ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronRightIcon className="size-3.5" />
            )}
          </button>
        ) : null}
        <span className="min-w-0 truncate text-[13.5px] font-medium text-foreground">
          {block.label}
        </span>
        <Badge variant={TONE_BADGE[status.tone]}>{status.label}</Badge>
        <span className="flex-1" />
        {configurable ? (
          <>
            <span className="text-xs text-muted-foreground">Worker limit</span>
            <NumberStepper
              ariaLabel={`Worker limit for ${block.label}`}
              max={99}
              min={1}
              nullable
              onChange={(value) => props.onChange(boardWorkerLimitPatch(block.workerId, value))}
              placeholder="No limit"
              stepFrom={concurrency.globalMaxConcurrent}
              value={workerLimit}
            />
          </>
        ) : null}
      </div>
      {!configurable ? (
        <p className="pl-1 text-xs text-muted-foreground">
          {state === "unauthorized"
            ? "Re-pair to see its providers"
            : `Update T3o to ${BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION} to configure`}
        </p>
      ) : !open ? (
        <p className="truncate pl-6 text-xs text-muted-foreground">
          {boardWorkerCapSummary(concurrency, block.workerId, block.instanceIds)}
        </p>
      ) : (
        <>
          {state === "offline" || state === "connecting" ? (
            <p className="pl-4 text-xs text-muted-foreground">
              Offline. Showing the last providers {block.label} reported; changes apply when it
              reconnects.
            </p>
          ) : null}
          {block.instanceIds.map((instanceId) => {
            const cap = clampBoardInstanceCap(
              resolved.perInstance[instanceId] ?? null,
              workerLimit,
            );
            const atLimit = workerLimit !== null && cap === workerLimit;
            return (
              <div className="flex items-center justify-between gap-4 py-1 pl-4" key={instanceId}>
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                  {instanceId}
                </span>
                <BoardHint
                  label={
                    atLimit
                      ? `Can't be higher than ${block.label}'s worker limit (${workerLimit}).`
                      : null
                  }
                >
                  <span>
                    <NumberStepper
                      ariaLabel={`Concurrency limit for ${instanceId} on ${block.label}`}
                      max={workerLimit ?? 99}
                      min={1}
                      nullable
                      onChange={(value) =>
                        props.onChange(
                          boardWorkerInstanceCapPatch(block.workerId, instanceId, value),
                        )
                      }
                      placeholder="No cap"
                      stepFrom={workerLimit ?? concurrency.globalMaxConcurrent}
                      value={cap}
                    />
                  </span>
                </BoardHint>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
