/**
 * The card view's CI tab (T3O-44/57): the current pass's steps with their
 * commands, durations and a failed step's output tail; a failed pass's fix as
 * its last step, one row per issue; earlier passes, collapsed; how the card
 * last left CI; and Skip CI.
 *
 * Lazy, like the review pane — a card that never reaches CI pays nothing. The
 * only per-second element is the running step's timer, its own component.
 */
import { Link } from "@tanstack/react-router";
import {
  BOARD_CI_STOPPED_BY_YOU_REASON,
  isBoardCiStepFailure,
  type BoardCardId,
  type EnvironmentId,
  type BoardCardCi,
  type BoardCardCiLastOutcome,
  type BoardCiHeadline,
  type BoardCiPass,
  type BoardCiPassStep,
  type BoardStepCompletion,
  type ThreadId,
  type ProjectId,
} from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronsRightIcon,
  CopyIcon,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useNowSecond } from "../hooks/useNowSecond";
import { cn } from "../lib/utils";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  boardCiPaneHeadline,
  boardCiPaneStatus,
  boardCiPassOutcomeChip,
  boardCiPassSummary,
  boardCiProgressFraction,
  boardCiProgressLabel,
  boardCiSilenceLabel,
  boardCiStepBadgeState,
  boardCiFixRow,
  boardCiStepLimit,
  boardCiTailMeta,
  formatBoardCiDuration,
  formatBoardCiTimer,
  type BoardCiChipTone,
  type BoardCiFixRow,
} from "./boardCi";
import { BOARD_CI_CHIP_CLASS } from "./BoardCardCiFace";
import { BoardSectionHeading as SectionHeading } from "./BoardCardFields";
import { BoardShimmerText, BoardStepBadge } from "./BoardStepBadge";
import type { BoardCiLogTarget } from "./BoardCiLogDialog";

// Lazy: the viewer and its log model load only when a log is opened.
const BoardCiLogDialog = lazy(() =>
  import("./BoardCiLogDialog").then((module) => ({ default: module.BoardCiLogDialog })),
);

const BUTTON_CLASS =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-input bg-popover px-2.5 text-[11.5px] font-medium text-foreground shadow-xs hover:bg-accent";

function Chip({ label, tone }: { readonly label: string; readonly tone: BoardCiChipTone }) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center rounded-[5px] px-[7px] text-[10.5px] font-medium whitespace-nowrap",
        BOARD_CI_CHIP_CLASS[tone],
      )}
    >
      {label}
    </span>
  );
}

/** What failed and why (T3O-61), at the top of a failed, fixing or held
    pass, with the line it came from one click away. */
function HeadlineBox({
  headline,
  held,
  onShowInLog,
}: {
  readonly headline: BoardCiHeadline;
  readonly held: boolean;
  readonly onShowInLog: (() => void) | undefined;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col gap-1 rounded-xl border px-3.5 py-3",
        // Amber is held or blocked only (docs/t3o/status-colours.md).
        held || headline.machine ? "border-warning/40 bg-warning/5" : "border-border bg-card",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-[12.5px] font-semibold text-foreground">
          {headline.what}
        </span>
        {headline.machine ? <Chip label="Machine problem" tone="warning" /> : null}
        <span className="flex-1" />
        {onShowInLog === undefined ? null : (
          <button
            className="shrink-0 text-[11.5px] text-muted-foreground hover:text-foreground"
            onClick={onShowInLog}
            type="button"
          >
            Show in log
          </button>
        )}
      </div>
      <span className="text-[11.5px]/[1.55] text-pretty break-words text-muted-foreground">
        {headline.why}
      </span>
    </div>
  );
}

function RunningTimer({ startedAt }: { readonly startedAt: string }) {
  const nowMs = useNowSecond();
  return <>{formatBoardCiTimer(nowMs - Date.parse(startedAt))}</>;
}

/** "Running 12 / 60 min", the over-limit minutes in the warning tone, and
    "No output for N min" on a silent step (T3O-60). */
function RunningMeta({ step }: { readonly step: BoardCiPassStep }) {
  const nowMs = useNowSecond();
  const { elapsed, limit, over } = boardCiStepLimit(step, nowMs);
  const silence = boardCiSilenceLabel(step.silentSince, nowMs);
  return (
    <span className="text-[11px] text-muted-foreground tabular-nums">
      Running <span className={cn(over && "font-medium text-warning-foreground")}>{elapsed}</span> /{" "}
      {limit} min
      {silence === null ? null : <span className="text-warning-foreground">{` · ${silence}`}</span>}
    </span>
  );
}

/** A script's progress: its message, `128 / 212` and a bar. */
function StepProgress({
  progress,
}: {
  readonly progress: NonNullable<BoardCiPassStep["progress"]>;
}) {
  const fraction = boardCiProgressFraction(progress);
  const label = boardCiProgressLabel(progress);
  return (
    <div className="flex flex-col gap-1 pt-0.5">
      <div className="flex min-w-0 items-center gap-2 text-[11px]">
        <span className="min-w-0 truncate text-foreground">{progress.message ?? ""}</span>
        <span className="flex-1" />
        {progress.done === null || label === null ? null : (
          <span className="shrink-0 font-mono text-muted-foreground tabular-nums">{label}</span>
        )}
      </div>
      {fraction === null ? null : (
        <span className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <span
            className="block h-full rounded-full bg-info"
            style={{ width: `${Math.round(fraction * 100)}%` }}
          />
        </span>
      )}
    </div>
  );
}

/** The pass's log folder, copyable for a terminal (T3O-60). */
function LogDirRow({ logDir }: { readonly logDir: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "log folder" });
  return (
    <div className="flex min-w-0 items-center gap-2 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
      <span className="shrink-0">Logs</span>
      <span className="min-w-0 flex-1 font-mono break-all">{logDir}</span>
      <button
        aria-label="Copy the log folder"
        className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-md border border-border bg-popover px-[7px] font-medium hover:bg-accent hover:text-foreground"
        onClick={() => copyToClipboard(logDir, undefined)}
        type="button"
      >
        {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        {isCopied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

const STATUS_WORD: Record<BoardCiPassStep["status"], string> = {
  pending: "Pending",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  "timed-out": "Timed out",
  cancelled: "Cancelled",
};

function statusClass(status: BoardCiPassStep["status"], fixing: boolean): string {
  if (status === "passed") return "text-success-foreground";
  if (status === "running") return "text-info-foreground";
  if (isBoardCiStepFailure(status))
    return fixing ? "text-info-foreground" : "text-warning-foreground";
  return "text-muted-foreground";
}

function StepRow({
  step,
  index,
  live,
  fixing,
  tailOpen,
  onToggleTail,
  onOpenThread,
  onOpenLog,
}: {
  readonly step: BoardCiPassStep;
  /** Opens the step's log; absent when it has none to show. */
  readonly onOpenLog?: (() => void) | undefined;
  readonly onOpenThread?: ((threadId: ThreadId) => void) | undefined;
  readonly index: number;
  /** The pass is the one running now, so a running step ticks and shimmers. */
  readonly live: boolean;
  readonly fixing: boolean;
  readonly tailOpen: boolean;
  readonly onToggleTail: () => void;
}) {
  const failed = isBoardCiStepFailure(step.status);
  const stepFixing = failed && fixing;
  const running = step.status === "running" && live;
  const hasTail = failed && step.tail.length > 0;
  const duration =
    step.startedAt !== null && step.finishedAt !== null
      ? formatBoardCiDuration(Date.parse(step.finishedAt) - Date.parse(step.startedAt))
      : null;
  return (
    <div className={cn(index > 0 && "border-t border-border")}>
      <div
        className={cn(
          "flex items-center gap-2.5 px-3 py-[9px]",
          (running || stepFixing) && "bg-info/5",
        )}
      >
        <BoardStepBadge index={index + 1} state={boardCiStepBadgeState(step.status, fixing)} />
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <BoardShimmerText
            active={running}
            className="w-fit text-[12.5px] font-medium text-foreground"
            text={step.name}
          />
          <span
            className={cn(
              "truncate text-[11px] text-muted-foreground",
              (step.kind ?? "script") === "script" && "font-mono",
            )}
          >
            {step.kind === "agent"
              ? "Agent · own thread"
              : step.kind === "forge-checks"
                ? step.checks === undefined
                  ? "Forge checks"
                  : `Forge checks · ${step.checks.passed}/${step.checks.total} passed`
                : step.command}
            {step.parallel === true ? " · in parallel" : ""}
          </span>
          {step.note === undefined ? null : (
            <span className="text-[11px] text-muted-foreground">{step.note}</span>
          )}
          {running ? <RunningMeta step={step} /> : null}
          {step.progress === undefined || step.status === "passed" ? null : (
            <StepProgress progress={step.progress} />
          )}
          {onOpenLog === undefined ? null : (
            <button
              className="w-fit font-mono text-[11px] text-info-foreground hover:underline"
              onClick={onOpenLog}
              type="button"
            >
              ›_ {running ? "View live log" : "View log"}
            </button>
          )}
          {step.threadId === undefined || onOpenThread === undefined ? null : (
            <button
              className="w-fit text-[11px] text-info-foreground hover:underline"
              onClick={() => onOpenThread(step.threadId!)}
              type="button"
            >
              Open {step.name} thread
            </button>
          )}
        </div>
        {hasTail ? (
          <button
            aria-expanded={tailOpen}
            className="h-[22px] shrink-0 rounded-md border border-border bg-popover px-[7px] text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onToggleTail}
            type="button"
          >
            {tailOpen ? "Hide output" : "Show output"}
          </button>
        ) : null}
        <span
          className={cn(
            "w-16 shrink-0 text-right font-mono text-[11.5px] font-medium tabular-nums",
            running ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {running && step.startedAt !== null ? (
            <RunningTimer startedAt={step.startedAt} />
          ) : (
            duration
          )}
        </span>
        <span
          className={cn(
            "w-[92px] shrink-0 text-right text-[11.5px] font-medium",
            statusClass(step.status, fixing),
          )}
        >
          {stepFixing ? "Failed · fixing" : STATUS_WORD[step.status]}
          {step.exitCode !== null && failed && !stepFixing ? (
            <span className="sr-only">{` (exit ${step.exitCode})`}</span>
          ) : null}
        </span>
      </div>
      {step.result !== undefined &&
      (step.result.summary !== null || step.result.failures.length > 0) ? (
        <div className="flex flex-col gap-1 border-t border-border py-1.5 pr-3 pl-[42px] text-[11.5px]">
          {step.result.summary === null ? null : (
            <span className="text-muted-foreground">{step.result.summary}</span>
          )}
          {step.result.failures.map((failure, index) => (
            <div
              className="flex flex-col border-l-2 border-warning pl-2"
              key={`${failure.title}:${index}`}
            >
              <span className="text-foreground">{failure.title}</span>
              {failure.file === undefined ? null : (
                <span className="font-mono text-[10.5px] text-muted-foreground">
                  {failure.file}
                  {failure.line === undefined ? "" : `:${failure.line}`}
                </span>
              )}
              {failure.detail === undefined ? null : (
                <span className="text-muted-foreground">{failure.detail}</span>
              )}
            </div>
          ))}
        </div>
      ) : null}
      {hasTail && tailOpen ? (
        <div className="flex flex-col border-t border-border bg-muted">
          <span className="py-1.5 pr-3 pl-[42px] text-[10.5px] font-medium tracking-[.04em] text-muted-foreground uppercase">
            {boardCiTailMeta(step.tail)}
          </span>
          <pre
            aria-label={`${step.name} output`}
            className="m-0 max-h-[280px] overflow-auto pt-1 pr-3 pb-3 pl-[42px] font-mono text-[11px]/[1.6] whitespace-pre text-foreground"
          >
            {step.tail}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

const ISSUE_STATUS: Record<BoardCiFixRow["issues"][number]["status"], string> = {
  open: "Open",
  resolved: "Resolved",
  "cannot-fix": "Can't fix",
};

const ISSUE_STATUS_CLASS: Record<BoardCiFixRow["issues"][number]["status"], string> = {
  open: "text-muted-foreground",
  resolved: "text-success-foreground",
  "cannot-fix": "text-attention-foreground",
};

/** A failed pass's fix, shown as the pass's last step (T3O-57). */
const FIX_ROW_LABEL: Record<BoardCiFixRow["state"], string> = {
  running: "Fixing",
  "after-pass": "Waiting",
  "not-run": "Not run",
  reported: "Reported",
};

function FixFailuresRow({
  row,
  index,
  threadId,
  onOpenThread,
}: {
  readonly row: BoardCiFixRow;
  readonly index: number;
  readonly threadId: ThreadId | null;
  readonly onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  return (
    <div className="border-t border-border" data-ci-fix-row={row.state}>
      <div
        className={cn(
          "flex items-center gap-2.5 px-3 py-[9px]",
          row.state === "running" && "bg-info/5",
        )}
      >
        <BoardStepBadge index={index + 1} state={row.badge} />
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="text-[12.5px] font-medium text-foreground">Fix failures</span>
          <span className="truncate text-[11px] text-muted-foreground">
            {row.headline}
            {row.fixedSha === null ? "" : ` · pushed ${row.fixedSha.slice(0, 7)}`}
          </span>
          {threadId === null || onOpenThread === undefined ? null : (
            <button
              className="w-fit text-[11px] text-info-foreground hover:underline"
              onClick={() => onOpenThread(threadId)}
              type="button"
            >
              Open the fix thread
            </button>
          )}
        </div>
        <span
          className={cn(
            "w-[92px] shrink-0 text-right text-[11.5px] font-medium",
            row.state === "running"
              ? "text-info-foreground"
              : row.badge === "passed"
                ? "text-success-foreground"
                : "text-muted-foreground",
          )}
        >
          {FIX_ROW_LABEL[row.state]}
        </span>
      </div>
      <div className="flex flex-col gap-1 border-t border-border py-1.5 pr-3 pl-[42px] text-[11.5px]">
        {row.issues.map((issue) => (
          <div className="flex items-start gap-2" key={issue.id}>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-foreground">
                <span className="text-muted-foreground">{issue.stepName} · </span>
                {issue.title}
              </span>
              {issue.where === null ? null : (
                <span className="font-mono text-[10.5px] text-muted-foreground">{issue.where}</span>
              )}
              {issue.note === null ? null : (
                <span className="text-muted-foreground">{issue.note}</span>
              )}
            </div>
            <span className={cn("shrink-0 font-medium", ISSUE_STATUS_CLASS[issue.status])}>
              {ISSUE_STATUS[issue.status]}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PassSteps({
  pass,
  live,
  fixing,
  defaultTailOpen,
  onOpenThread,
  fixRow,
  fixThreadId,
  onOpenLog,
}: {
  readonly pass: BoardCiPass;
  readonly live: boolean;
  readonly fixing: boolean;
  readonly defaultTailOpen: boolean;
  readonly onOpenThread?: ((threadId: ThreadId) => void) | undefined;
  readonly fixRow?: BoardCiFixRow | null | undefined;
  readonly fixThreadId?: ThreadId | null | undefined;
  readonly onOpenLog: (target: BoardCiLogTarget) => void;
}) {
  // Null follows the default: open on the current pass, closed on earlier ones.
  const [tailOpen, setTailOpen] = useState<Readonly<Record<number, boolean>>>({});
  return (
    <>
      {pass.steps.map((step, index) => {
        const open = tailOpen[index] ?? defaultTailOpen;
        return (
          <StepRow
            fixing={fixing}
            index={index}
            key={`${index}:${step.name}`}
            live={live}
            onOpenThread={onOpenThread}
            onOpenLog={
              // Only a script that started writes a log.
              (step.kind ?? "script") === "script" &&
              step.startedAt !== null &&
              pass.logDir !== null
                ? () => onOpenLog({ pass, index, live: live && step.status === "running" })
                : undefined
            }
            onToggleTail={() => setTailOpen((current) => ({ ...current, [index]: !open }))}
            step={step}
            tailOpen={open}
          />
        );
      })}
      {fixRow == null ? null : (
        <FixFailuresRow
          index={pass.steps.length}
          onOpenThread={onOpenThread}
          row={fixRow}
          threadId={fixThreadId ?? null}
        />
      )}
    </>
  );
}

function EarlierPass({
  pass,
  ci,
  completions,
  onOpenLog,
}: {
  readonly pass: BoardCiPass;
  readonly ci: BoardCardCi | null | undefined;
  readonly completions: ReadonlyArray<BoardStepCompletion>;
  readonly onOpenLog: (target: BoardCiLogTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  const chip = boardCiPassOutcomeChip(pass, ci);
  const fixRow = boardCiFixRow({ pass, completions, ci: null });
  const failedNames = pass.steps
    .filter((step) => isBoardCiStepFailure(step.status))
    .map((step) => step.name);
  const summary = [
    boardCiPassSummary(pass),
    failedNames.length > 1 ? failedNames.join(", ") : null,
    fixRow === null
      ? null
      : `fix: ${fixRow.headline}${fixRow.fixedSha === null ? "" : ` · ${fixRow.fixedSha.slice(0, 7)}`}`,
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" · ");
  return (
    <div className="flex shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
      <button
        aria-expanded={open}
        className="flex items-center gap-2 px-3 py-2.5 text-left hover:bg-foreground/3"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="shrink-0 text-[12.5px] font-semibold text-foreground">
          Pass {pass.ordinal}
        </span>
        <Chip label={chip.label} tone={chip.tone} />
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">{summary}</span>
        <span className="flex-1" />
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {formatRelativeTimeLabel(pass.finishedAt ?? pass.startedAt)}
        </span>
        <ChevronDownIcon
          className={cn("size-3.5 shrink-0 text-muted-foreground", open && "rotate-180")}
        />
      </button>
      {open ? (
        <div className="flex flex-col border-t border-border">
          <PassSteps
            defaultTailOpen={false}
            fixing={false}
            fixRow={fixRow}
            live={false}
            onOpenLog={onOpenLog}
            pass={pass}
          />
          {pass.logDir === null ? null : <LogDirRow logDir={pass.logDir} />}
        </div>
      ) : null}
    </div>
  );
}

export function BoardCardCiPane({
  environmentId,
  cardId,
  cardKey,
  inCi,
  ci,
  lastOutcome,
  passes,
  activeThreadId,
  onOpenThread,
  onSkipCi,
  skipPending = false,
  skipToLabel = "Ready for merge",
  onBackToThread,
  projectId,
  onRetryCi,
  onStopCi,
  onSendBack,
  completions = [],
}: {
  /** T3O-60: where the card lives, for its step logs. */
  readonly environmentId: EnvironmentId;
  readonly cardId: BoardCardId;
  readonly cardKey: string;
  /** The card's step completions, for each pass's fix report (T3O-57). */
  readonly completions?: ReadonlyArray<BoardStepCompletion> | undefined;
  /** T3O-49: Retry CI on a stopped or held pass, and "Send back to review
      anyway" on a stopped one. Human-only. */
  readonly onRetryCi?: (() => void) | undefined;
  /** T3O-59: Stop CI on a queued, running or fixing pass. Human-only. */
  readonly onStopCi?: (() => void) | undefined;
  readonly onSendBack?: (() => void) | undefined;
  /** T3O-49: the card's project, for the "CI settings" link. */
  readonly projectId?: ProjectId | undefined;
  /** The card sits in the CI stage: Skip CI and the fix box apply. */
  readonly inCi: boolean;
  readonly ci: BoardCardCi | null | undefined;
  readonly lastOutcome: BoardCardCiLastOutcome | null | undefined;
  /** Every pass, oldest first. */
  readonly passes: ReadonlyArray<BoardCiPass>;
  /** The card's active step thread, the fix agent's when no pass names one. */
  readonly activeThreadId: ThreadId | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onSkipCi?: (() => void) | undefined;
  readonly skipPending?: boolean | undefined;
  /** The stage after CI in the card's pipeline, where Skip CI moves it. */
  readonly skipToLabel?: string | undefined;
  readonly onBackToThread: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [logTarget, setLogTarget] = useState<BoardCiLogTarget | null>(null);
  const current = passes.at(-1);
  const earlier = passes.slice(0, -1).reverse();
  const live = current !== undefined && ci != null && ci.runId === current.runId && inCi;
  const fixing = live && ci?.phase === "fixing";
  const status = boardCiPaneStatus({ ci: inCi ? ci : null, lastOutcome, lastPass: current });
  const fixThreadId = current?.fixThreadId ?? (fixing ? activeThreadId : null);
  const currentFixRow =
    current === undefined
      ? null
      : boardCiFixRow({ pass: current, completions, ci: inCi ? (ci ?? null) : null });
  const currentSummary = current === undefined ? "" : boardCiPassSummary(current);
  const showConfirm = inCi && confirming && onSkipCi !== undefined;
  const usedFixes = lastOutcome?.fixAttemptsUsed ?? 0;
  const paneHeadline = boardCiPaneHeadline({ pass: current, ci, live });
  const headlineOffset = paneHeadline?.headline.logOffset ?? null;
  const headlineIndex = paneHeadline?.index ?? null;
  return (
    <section className="flex min-h-0 min-w-0 flex-col border-r border-border bg-muted/55">
      {logTarget === null ? null : (
        <Suspense fallback={null}>
          <BoardCiLogDialog
            cardId={cardId}
            cardKey={cardKey}
            environmentId={environmentId}
            onClose={() => setLogTarget(null)}
            target={(() => {
              // The pass's latest row, so the header follows the step settling.
              const pass =
                passes.find((candidate) => candidate.runId === logTarget.pass.runId) ??
                logTarget.pass;
              return {
                ...logTarget,
                pass,
                live: logTarget.live && pass.steps[logTarget.index]?.status === "running",
              };
            })()}
          />
        </Suspense>
      )}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pr-3 pl-3.5">
        <SectionHeading>Continuous integration</SectionHeading>
        {current === undefined ? null : (
          <span className="truncate text-[11.5px] text-muted-foreground">
            Pass {current.ordinal}
            {ci == null ? "" : ` · fix ${ci.fixAttempts} of ${ci.maxFixAttempts}`}
            {ci == null ? "" : ` · stop on failure ${ci.continueOnFailure === true ? "No" : "Yes"}`}
          </span>
        )}
        <span className="flex-1" />
        {status === null ? null : (
          <span
            className={cn(
              "inline-flex h-[22px] shrink-0 items-center rounded-[7px] px-2 text-[11.5px] font-medium",
              BOARD_CI_CHIP_CLASS[status.tone],
            )}
          >
            {status.label}
          </span>
        )}
        {inCi &&
        onStopCi !== undefined &&
        ci != null &&
        (ci.phase === "queued" || ci.phase === "running" || ci.phase === "fixing") ? (
          <button
            className="inline-flex h-6 shrink-0 items-center rounded-[7px] border border-input bg-popover px-2.5 text-[11.5px] font-medium text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground"
            onClick={onStopCi}
            type="button"
          >
            Stop CI
          </button>
        ) : null}
        <button
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[7px] border border-input bg-popover pr-2.5 pl-1.5 text-[11.5px] font-medium text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground"
          onClick={onBackToThread}
          type="button"
        >
          <ChevronLeftIcon className="size-3" />
          Back to thread
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pt-3.5 pb-5">
        {paneHeadline === null ? null : (
          <HeadlineBox
            headline={paneHeadline.headline}
            held={live && ci?.phase === "held"}
            onShowInLog={
              current === undefined ||
              current.logDir === null ||
              headlineOffset === null ||
              headlineIndex === null
                ? undefined
                : () =>
                    setLogTarget({
                      pass: current,
                      index: headlineIndex,
                      live: false,
                      openAt: { offset: headlineOffset },
                    })
            }
          />
        )}
        {!inCi && lastOutcome != null ? (
          <div className="flex shrink-0 flex-col gap-[5px] rounded-xl border border-border bg-card px-3.5 py-3">
            <span className="text-[12.5px] font-semibold text-foreground">
              {lastOutcome.kind === "sent-back"
                ? "Sent back to Code review"
                : `Skipped by ${lastOutcome.actor ?? "someone"}`}
            </span>
            <span className="text-[11.5px]/[1.55] text-pretty text-muted-foreground">
              {lastOutcome.kind === "sent-back"
                ? (lastOutcome.finding ?? "")
                : "Moved on without a passing run. Steps still running were cancelled."}
            </span>
            {lastOutcome.kind === "sent-back" ? (
              <span className="text-[11px] text-muted-foreground">
                {lastOutcome.stepName === undefined ? "" : `${lastOutcome.stepName} · `}
                {usedFixes} fix {usedFixes === 1 ? "attempt" : "attempts"} used · the failure went
                with the card
              </span>
            ) : null}
          </div>
        ) : null}
        {inCi && ci != null && (ci.phase === "stopped" || ci.phase === "held") ? (
          <div
            className={cn(
              "flex shrink-0 flex-col gap-2 rounded-xl border px-3.5 py-3",
              ci.phase === "stopped"
                ? "border-attention/40 bg-attention/6"
                : "border-warning/40 bg-warning/5",
            )}
          >
            <span className="text-[12.5px] font-semibold text-foreground">
              {ci.phase === "stopped"
                ? "Stopped for you"
                : ci.machine === true
                  ? "Machine problem"
                  : ci.stopReason === BOARD_CI_STOPPED_BY_YOU_REASON
                    ? "CI stopped"
                    : "CI can't run this pass"}
            </span>
            <span className="text-[11.5px]/[1.55] text-pretty text-muted-foreground">
              {ci.phase === "stopped"
                ? (ci.stopReason ?? "CI stopped for a human.")
                : (ci.stopReason ??
                  "The pass couldn't finish (the runner or the worktree wasn't available). Fix what's in the way, then retry.")}
            </span>
            {ci.phase === "stopped" ? (
              <span className="text-[11px] text-muted-foreground">
                {ci.fixAttempts} of {ci.maxFixAttempts} fix{" "}
                {ci.maxFixAttempts === 1 ? "attempt" : "attempts"} used
              </span>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              {onRetryCi === undefined ? null : (
                <button
                  className={cn(BUTTON_CLASS, "h-[30px] px-3 text-[12.5px]")}
                  onClick={onRetryCi}
                  type="button"
                >
                  Retry CI
                </button>
              )}
              {ci.phase === "stopped" && onSendBack !== undefined ? (
                <button
                  className={cn(BUTTON_CLASS, "h-[30px] px-3 text-[12.5px]")}
                  onClick={onSendBack}
                  type="button"
                >
                  Send back to review anyway
                </button>
              ) : null}
              {projectId === undefined ? null : (
                <Link
                  className="text-[11.5px] text-muted-foreground hover:text-foreground"
                  params={{ projectId, tab: "ci" }}
                  to="/settings/board/projects/$projectId/$tab"
                >
                  ⚙ CI settings
                </Link>
              )}
            </div>
          </div>
        ) : null}
        {current === undefined ? (
          <div className="rounded-xl border border-border bg-card px-3.5 py-3 text-[11.5px] text-muted-foreground">
            {inCi ? "Waiting for the first pass to start." : "CI has not run on this card."}
          </div>
        ) : (
          <div className="flex shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
              <span className="text-[12.5px] font-semibold text-foreground">
                Pass {current.ordinal}
              </span>
              {(() => {
                const chip = boardCiPassOutcomeChip(current, inCi ? ci : null);
                return <Chip label={chip.label} tone={chip.tone} />;
              })()}
              <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                {currentSummary}
              </span>
              <span className="flex-1" />
              <span className="text-[11px] text-muted-foreground">
                {formatRelativeTimeLabel(current.startedAt)}
              </span>
            </div>
            <PassSteps
              // A new pass starts with its tails at their default.
              key={current.runId}
              defaultTailOpen
              fixing={fixing}
              fixRow={currentFixRow}
              fixThreadId={fixThreadId}
              live={live}
              onOpenLog={setLogTarget}
              onOpenThread={onOpenThread}
              pass={current}
            />
            <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
              {current.steps.length} {current.steps.length === 1 ? "step" : "steps"} from the
              project&apos;s CI settings · run in order,{" "}
              {inCi && ci?.continueOnFailure === true
                ? "every step runs even after a failure"
                : "stop at the first failure"}
            </div>
            {current.logDir === null ? null : <LogDirRow logDir={current.logDir} />}
            {projectId === undefined ? null : (
              <Link
                className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground hover:text-foreground"
                params={{ projectId, tab: "ci" }}
                to="/settings/board/projects/$projectId/$tab"
              >
                ⚙ CI settings for this project
              </Link>
            )}
          </div>
        )}
        {earlier.length === 0 ? null : (
          <div className="flex flex-col gap-1.5">
            <span className="px-0.5 pt-0.5 text-[11px] font-semibold tracking-[.07em] text-muted-foreground uppercase">
              Earlier passes
            </span>
            {earlier.map((pass) => (
              <EarlierPass
                ci={ci}
                completions={completions}
                key={pass.runId}
                onOpenLog={setLogTarget}
                pass={pass}
              />
            ))}
          </div>
        )}
        {inCi && onSkipCi !== undefined && !showConfirm ? (
          <div className="mt-1 flex shrink-0 items-center gap-3 rounded-xl border border-dashed border-input bg-foreground/3 px-3.5 py-3">
            <span className="min-w-0 text-[11.5px]/[1.5] text-pretty text-muted-foreground">
              Moves the card to {skipToLabel} without a passing CI run. The skip is recorded on the
              card under your name.
            </span>
            <span className="flex-1" />
            <button
              className={cn(
                BUTTON_CLASS,
                "h-[30px] px-3 text-[12.5px] whitespace-nowrap disabled:opacity-60",
              )}
              disabled={skipPending}
              onClick={() => setConfirming(true)}
              type="button"
            >
              <ChevronsRightIcon className="size-[13px]" />
              Skip CI…
            </button>
          </div>
        ) : null}
        {showConfirm ? (
          <div
            aria-label={`Skip CI for ${cardKey}?`}
            className="mt-1 flex shrink-0 flex-col gap-2.5 rounded-xl border border-warning/40 bg-warning/5 px-3.5 py-[13px]"
            role="group"
          >
            <span className="text-[12.5px] font-semibold text-foreground">
              Skip CI for {cardKey}?
            </span>
            <span className="text-[11.5px]/[1.55] text-pretty text-muted-foreground">
              {fixing
                ? "The fix agent stops and "
                : live
                  ? "The running step is cancelled and "
                  : ""}
              the card moves to {skipToLabel}. Anyone opening it will see that you skipped CI.
            </span>
            <div className="flex items-center justify-end gap-2">
              <button
                className={cn(BUTTON_CLASS, "h-[30px] px-3 text-[12.5px]")}
                onClick={() => setConfirming(false)}
                type="button"
              >
                Keep running
              </button>
              <button
                className="inline-flex h-[30px] items-center rounded-lg bg-destructive px-3 text-[12.5px] font-medium text-white shadow-xs hover:brightness-95"
                onClick={() => {
                  setConfirming(false);
                  onSkipCi?.();
                }}
                type="button"
              >
                Skip CI and move to {skipToLabel}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
