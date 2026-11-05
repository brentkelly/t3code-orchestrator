/**
 * The card view's CI tab (T3O-44): the current pass's steps with their
 * commands, durations and a failed step's output tail; the fix agent at work;
 * earlier passes, collapsed; how the card last left CI; and Skip CI.
 *
 * Lazy, like the review pane — a card that never reaches CI pays nothing. The
 * only per-second element is the running step's timer, its own component.
 */
import {
  isBoardCiStepFailure,
  type BoardCardCi,
  type BoardCardCiLastOutcome,
  type BoardCiPass,
  type BoardCiPassStep,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronsRightIcon,
  MessageSquareIcon,
} from "lucide-react";
import { useState } from "react";

import { useNowSecond } from "../hooks/useNowSecond";
import { cn } from "../lib/utils";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  boardCiPaneStatus,
  boardCiPassOutcomeChip,
  boardCiPassSummary,
  boardCiStepBadgeState,
  boardCiTailMeta,
  formatBoardCiDuration,
  formatBoardCiTimer,
  type BoardCiChipTone,
} from "./boardCi";
import { BOARD_CI_CHIP_CLASS } from "./BoardCardCiFace";
import { BoardSectionHeading as SectionHeading } from "./BoardCardFields";
import { BoardShimmerText, BoardStepBadge } from "./BoardStepBadge";

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

function RunningTimer({ startedAt }: { readonly startedAt: string }) {
  const nowMs = useNowSecond();
  return <>{formatBoardCiTimer(nowMs - Date.parse(startedAt))}</>;
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
}: {
  readonly step: BoardCiPassStep;
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
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {step.command}
          </span>
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

function PassSteps({
  pass,
  live,
  fixing,
  defaultTailOpen,
}: {
  readonly pass: BoardCiPass;
  readonly live: boolean;
  readonly fixing: boolean;
  readonly defaultTailOpen: boolean;
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
            onToggleTail={() => setTailOpen((current) => ({ ...current, [index]: !open }))}
            step={step}
            tailOpen={open}
          />
        );
      })}
    </>
  );
}

function EarlierPass({
  pass,
  ci,
}: {
  readonly pass: BoardCiPass;
  readonly ci: BoardCardCi | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  const chip = boardCiPassOutcomeChip(pass, ci);
  const summary = boardCiPassSummary(pass);
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
          <PassSteps defaultTailOpen={false} fixing={false} live={false} pass={pass} />
        </div>
      ) : null}
    </div>
  );
}

export function BoardCardCiPane({
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
}: {
  readonly cardKey: string;
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
  const current = passes.at(-1);
  const earlier = passes.slice(0, -1).reverse();
  const live = current !== undefined && ci != null && ci.runId === current.runId && inCi;
  const fixing = live && ci?.phase === "fixing";
  const status = boardCiPaneStatus({ ci: inCi ? ci : null, lastOutcome, lastPass: current });
  const failedStep = current?.steps.find((step) => isBoardCiStepFailure(step.status));
  const fixThreadId = current?.fixThreadId ?? activeThreadId;
  const attempt = ci == null ? 0 : Math.max(1, ci.fixAttempts);
  const lastAttempt = ci != null && attempt >= ci.maxFixAttempts;
  const showConfirm = inCi && confirming && onSkipCi !== undefined;
  const usedFixes = lastOutcome?.fixAttemptsUsed ?? 0;
  return (
    <section className="flex min-h-0 min-w-0 flex-col border-r border-border bg-muted/55">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pr-3 pl-3.5">
        <SectionHeading>Continuous integration</SectionHeading>
        {current === undefined ? null : (
          <span className="truncate text-[11.5px] text-muted-foreground">
            Pass {current.ordinal}
            {ci == null ? "" : ` · fix attempts ${ci.fixAttempts} of ${ci.maxFixAttempts}`}
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
        {fixing ? (
          <div className="flex shrink-0 items-center gap-3 rounded-xl border border-info/35 bg-info/6 py-[11px] pr-3 pl-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <span className="text-[12.5px] font-semibold text-foreground">
                Fix agent is working on {failedStep?.name ?? "the failed step"}
              </span>
              <span className="text-[11.5px]/[1.5] text-pretty text-muted-foreground">
                Attempt {attempt} of {ci?.maxFixAttempts}. When it commits, every step re-runs from
                the top.
                {lastAttempt
                  ? " This is the last attempt; if the step still fails, the card goes back to Code review."
                  : ""}
              </span>
            </div>
            {fixThreadId === null ? null : (
              <button
                className={BUTTON_CLASS}
                onClick={() => onOpenThread(fixThreadId)}
                type="button"
              >
                <MessageSquareIcon className="size-3" />
                View thread
              </button>
            )}
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
              live={live}
              pass={current}
            />
            <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
              {current.steps.length} {current.steps.length === 1 ? "step" : "steps"} from t3o.json ·
              run in order, stop at the first failure
              {current.logDir === null ? "" : ` · full logs in ${current.logDir}`}
            </div>
          </div>
        )}
        {earlier.length === 0 ? null : (
          <div className="flex flex-col gap-1.5">
            <span className="px-0.5 pt-0.5 text-[11px] font-semibold tracking-[.07em] text-muted-foreground uppercase">
              Earlier passes
            </span>
            {earlier.map((pass) => (
              <EarlierPass ci={ci} key={pass.runId} pass={pass} />
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
