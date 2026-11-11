/**
 * The card face's CI rows. Nothing animates; elapsed minutes repaint on the shared
 * minute tick.
 */
import type { BoardCardCi, BoardCardCiLastOutcome } from "@t3tools/contracts";
import { ChevronsRightIcon, Undo2Icon } from "lucide-react";

import { useNowMinute } from "../hooks/useNowMinute";
import { cn } from "../lib/utils";
import {
  boardCiFace,
  boardCiLastOutcomeFace,
  type BoardCiChipTone,
  type BoardCiFixSegmentState,
  type BoardStepBadgeState,
} from "./boardCi";
import { BoardHint } from "./BoardHint";

const SEGMENT_CLASS: Record<BoardStepBadgeState, string> = {
  passed: "bg-success",
  running: "bg-info",
  fixing: "bg-info/45",
  failed: "bg-warning",
  cancelled: "bg-muted-foreground/40",
  pending: "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--foreground)_14%,transparent)]",
};

const FIX_SEGMENT_CLASS: Record<BoardCiFixSegmentState, string> = {
  pending: SEGMENT_CLASS.pending,
  fixing: "bg-info",
  stopped: "bg-attention",
};

const FIX_SEGMENT_LABEL: Record<BoardCiFixSegmentState, string> = {
  pending: "Fix · after the pass",
  fixing: "Fix · running",
  stopped: "Fix · needs you",
};

export const BOARD_CI_CHIP_CLASS: Record<BoardCiChipTone, string> = {
  info: "bg-info/13 text-info-foreground",
  success: "bg-success/15 text-success-foreground",
  neutral: "bg-muted text-muted-foreground",
  warning: "bg-warning/12 text-warning-foreground",
  // Violet: waiting on a human ("Stopped for you").
  attention: "bg-attention/13 text-attention-foreground",
};

function BoardCardCiProgress({ ci }: { readonly ci: BoardCardCi }) {
  const nowMinute = useNowMinute();
  const face = boardCiFace(ci, Date.parse(`${nowMinute}Z`));
  return (
    <BoardHint label={face.tooltip}>
      <div className="flex flex-col gap-1.5 border-t border-border pt-2" data-board-card-ci="">
        <div className="flex items-center gap-1.5">
          <span className="text-[10.5px] font-medium text-foreground">CI</span>
          <span className="flex-1" />
          <span
            className={cn(
              "inline-flex h-4 shrink-0 items-center rounded-[5px] px-1.5 text-[10px] font-medium tracking-[.03em] uppercase",
              BOARD_CI_CHIP_CLASS[face.chip.tone],
            )}
          >
            {face.chip.label}
          </span>
        </div>
        <div className="flex gap-[3px]">
          {face.segments.map((segment, index) => (
            <span
              // oxlint-disable-next-line react/no-array-index-key -- a segment is its step's position in the pipeline; step names can repeat
              key={`${index}:${segment.name}`}
              aria-label={segment.tooltip}
              className={cn("h-[5px] flex-1 rounded-[2px]", SEGMENT_CLASS[segment.state])}
              data-ci-segment={segment.state}
              role="img"
            />
          ))}
          {face.fixSegment === null ? null : (
            <span
              aria-label={FIX_SEGMENT_LABEL[face.fixSegment]}
              className={cn(
                "ml-[2px] h-[5px] w-3 shrink-0 rounded-[2px]",
                FIX_SEGMENT_CLASS[face.fixSegment],
              )}
              data-ci-fix-segment={face.fixSegment}
              role="img"
            />
          )}
        </div>
        <div className="flex min-w-0 items-center gap-[7px]">
          <span className="shrink-0 font-mono text-[10.5px] font-medium text-foreground">
            {face.count}
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[10.5px]",
              face.detailTone === "warning" ? "text-warning-foreground" : "text-muted-foreground",
            )}
          >
            {face.detail}
          </span>
        </div>
      </div>
    </BoardHint>
  );
}

export function BoardCardCiFace({
  ci,
  inCi,
  lastOutcome,
}: {
  readonly ci: BoardCardCi | undefined;
  readonly inCi: boolean;
  readonly lastOutcome: BoardCardCiLastOutcome | undefined;
}) {
  if (ci !== undefined && inCi) return <BoardCardCiProgress ci={ci} />;
  const outcome = boardCiLastOutcomeFace({ inCi, outcome: lastOutcome });
  if (outcome === null) return null;
  if (outcome.kind === "skipped") {
    return (
      <BoardHint label={outcome.tooltip}>
        <div className="flex items-center gap-[5px] text-[10.5px] font-medium text-muted-foreground">
          <ChevronsRightIcon className="size-[11px] shrink-0" />
          {outcome.label}
        </div>
      </BoardHint>
    );
  }
  return (
    <BoardHint label={outcome.tooltip}>
      <div className="flex items-start gap-[7px] rounded-[7px] bg-warning/8 px-2 py-[7px]">
        <Undo2Icon className="mt-px size-3 shrink-0 text-warning-foreground" />
        <div className="flex min-w-0 flex-col gap-px">
          <span className="text-[10.5px] font-medium text-foreground">Sent back from CI</span>
          <span className="text-[10.5px]/[1.4] text-muted-foreground">{outcome.line}</span>
        </div>
      </div>
    </BoardHint>
  );
}
