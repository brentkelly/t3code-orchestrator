/**
 * T3o: the proposed split, docked directly above the thread composer (T3O-105). Collapsed it is
 * one row; expanded it holds the split gate, capped at 45% of the thread column, and a grip
 * resizes it. A split approved after review shows as a green bar with Undo until it fires.
 */
import { CheckIcon, ChevronUpIcon, CircleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { observeResize } from "../lib/observeResize";
import { BoardHint } from "./BoardHint";
import { boardSplitDockHeight } from "./boardSplitDock";

export function BoardSplitDock(props: {
  readonly expanded: boolean;
  /** "Proposed split · N cards · K revised · Needs approval". */
  readonly summary: string;
  /** The green bar of a split approved after review, or null. */
  readonly approvedBar: string | null;
  readonly storedHeight: number | null;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onResize: (height: number) => void;
  readonly onUndo: () => void;
  /** The gate, drawn while expanded. */
  readonly children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [columnHeight, setColumnHeight] = useState<number | null>(null);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const drag = useRef<{ readonly startY: number; readonly startHeight: number } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the thread column's height, which caps the dock at 45% of it
  useEffect(() => {
    const column = rootRef.current?.closest("[data-board-thread-column]");
    if (column == null) return undefined;
    const measure = () => setColumnHeight(column.getBoundingClientRect().height);
    measure();
    return observeResize(column, measure);
  }, []);

  if (props.approvedBar !== null) {
    return (
      <div
        className="mb-2 flex items-center gap-2 rounded-xl border border-success/40 bg-success/10 px-3 py-2"
        ref={rootRef}
        role="status"
      >
        <CheckIcon className="size-3.5 shrink-0 text-success-foreground" />
        <span className="min-w-0 flex-1 truncate text-board-12 font-medium text-success-foreground">
          {props.approvedBar}
        </span>
        <Button onClick={props.onUndo} size="xs" variant="ghost">
          Undo
        </Button>
      </div>
    );
  }

  if (!props.expanded) {
    return (
      <div
        className="mb-2 flex items-center gap-2 rounded-xl border border-attention/50 bg-card px-3 py-1.5 shadow-xs"
        ref={rootRef}
      >
        <CircleAlertIcon className="size-3.5 shrink-0 text-attention-foreground" />
        <span className="min-w-0 flex-1 truncate text-board-12 font-medium text-foreground">
          {props.summary}
        </span>
        <Button onClick={() => props.onExpandedChange(true)} size="xs" variant="outline">
          Open
        </Button>
        <BoardHint label="Expand">
          <Button
            aria-label="Expand"
            onClick={() => props.onExpandedChange(true)}
            size="icon-xs"
            variant="ghost"
          >
            <ChevronUpIcon />
          </Button>
        </BoardHint>
      </div>
    );
  }

  const bounds = boardSplitDockHeight({
    stored: dragHeight ?? props.storedHeight,
    columnHeight,
  });
  return (
    <div
      className="mb-2 flex flex-col overflow-hidden rounded-xl border border-attention/50 bg-card shadow-xs"
      ref={rootRef}
      style={{
        ...(bounds.height === null ? {} : { height: bounds.height }),
        ...(bounds.max === null ? {} : { maxHeight: bounds.max }),
      }}
    >
      <div
        aria-label="Resize the proposed split"
        aria-orientation="horizontal"
        className="flex h-2.5 shrink-0 cursor-row-resize touch-none items-center justify-center hover:bg-accent"
        onPointerCancel={() => {
          drag.current = null;
          setDragHeight(null);
        }}
        onPointerDown={(event) => {
          const height = rootRef.current?.getBoundingClientRect().height;
          if (height === undefined) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { startY: event.clientY, startHeight: height };
          setDragHeight(height);
        }}
        onPointerMove={(event) => {
          if (drag.current === null) return;
          setDragHeight(drag.current.startHeight + drag.current.startY - event.clientY);
        }}
        onPointerUp={() => {
          if (drag.current === null) return;
          drag.current = null;
          if (bounds.height !== null) props.onResize(bounds.height);
          setDragHeight(null);
        }}
        role="separator"
      >
        <span className="h-1 w-8 rounded-full bg-border" />
      </div>
      {props.children}
    </div>
  );
}
