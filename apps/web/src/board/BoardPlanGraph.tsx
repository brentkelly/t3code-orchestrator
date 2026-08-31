/**
 * The dependency chart (t3o-29, D6): a split's shape, drawn once and mounted
 * twice — inside the modal's Plans panel and above the sub-board's columns,
 * exactly where the prototype puts it.
 *
 * All the arithmetic is in `boardPlanGraphLayout`, so this file is only
 * placement and colour. Nodes are absolutely positioned over one SVG that
 * carries the edges; the SVG is `pointer-events-none` so a curve passing
 * under a node never steals its click.
 */
import { cn } from "../lib/utils";
import {
  boardPlanGraphLayout,
  type BoardPlanGraphNode,
  type BoardPlanRow,
  type BoardPlanRowTone,
} from "./boardPlanRows";

/** The node dot, matching the row dots so the two views read as one thing. */
const TONE_DOT: Record<BoardPlanRowTone, string> = {
  done: "bg-success",
  blocked: "bg-warning",
  active: "bg-info",
  idle: "bg-muted-foreground/30",
  gone: "bg-muted-foreground/20",
};

export function BoardPlanGraph({
  rows,
  onOpenChild,
  className,
}: {
  readonly rows: ReadonlyArray<BoardPlanRow>;
  /** Opens a node's card in the sub-board; absent leaves the chart to be read
      rather than clicked. */
  readonly onOpenChild?: ((childCardId: string) => void) | undefined;
  readonly className?: string | undefined;
}) {
  const layout = boardPlanGraphLayout(rows);
  if (layout === null) return null;
  return (
    <div
      className={cn(
        "flex overflow-x-auto rounded-xl border border-border bg-card p-3.5",
        className,
      )}
    >
      <div
        className="relative shrink-0"
        style={{ width: `${layout.width}px`, height: `${layout.height}px` }}
      >
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 overflow-visible"
          height={layout.height}
          width={layout.width}
        >
          {layout.edges.map((edge) => (
            <path
              className={edge.done ? "stroke-success/55" : "stroke-input"}
              d={edge.d}
              fill="none"
              key={edge.id}
              strokeWidth={1.5}
            />
          ))}
        </svg>
        {layout.nodes.map((node) => (
          <PlanGraphNode key={node.planId} node={node} onOpenChild={onOpenChild} />
        ))}
      </div>
    </div>
  );
}

function PlanGraphNode({
  node,
  onOpenChild,
}: {
  readonly node: BoardPlanGraphNode;
  readonly onOpenChild: ((childCardId: string) => void) | undefined;
}) {
  const openable = node.cardId !== null && onOpenChild !== undefined;
  return (
    <button
      className={cn(
        "absolute flex flex-col justify-center gap-[3px] rounded-[9px] border px-2.5 text-left shadow-xs",
        node.awaitingInput ? "border-info/55" : "border-border",
        node.tone === "done" ? "bg-foreground/4" : "bg-card",
        node.tone === "gone" && "opacity-60",
        openable ? "hover:border-foreground/20" : "cursor-default",
      )}
      disabled={!openable}
      onClick={openable ? () => onOpenChild(node.cardId as string) : undefined}
      style={{
        left: `${node.x}px`,
        top: `${node.y}px`,
        width: `${node.width}px`,
        height: `${node.height}px`,
      }}
      title={node.stageLabel === null ? node.title : `${node.title} — ${node.stageLabel}`}
      type="button"
    >
      <span className="flex items-center gap-1.5">
        <span className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[node.tone])} />
        <span className="text-[10.5px] font-semibold text-muted-foreground">#{node.n}</span>
        <span className="ml-auto truncate text-[10.5px] text-muted-foreground">
          {node.stageLabel ?? "No card"}
        </span>
      </span>
      <span className="line-clamp-2 text-[12px]/[1.3] font-medium text-foreground">
        {node.title}
      </span>
    </button>
  );
}
