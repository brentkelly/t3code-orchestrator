/**
 * T3o: the Resources tab's learned baseline (T3O-87). Per dimension: what a human declared
 * (or the placeholder), what the board learned from measured cards, what new placements use
 * now, and Pin declared. A learned decrease is only offered (Use learned writes it as the
 * declared value); an increase no ready worker could place is shown as a warning, not used.
 */
import {
  BOARD_LEARNED_MIN_SAMPLES,
  BOARD_LEARNED_WINDOW_DAYS,
  BOARD_RESOURCE_DIMENSIONS,
  boardPlannerUse,
  type BoardDeclaredSource,
  type BoardLearnedDimension,
  type BoardProjectResources,
  type BoardResourceDimension,
} from "@t3tools/contracts";

import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { cn } from "../../lib/utils";
import { BoardHint } from "../BoardHint";

const NAMES = { cpu: "CPU", ram: "RAM", disk: "Disk" } as const;
const UNITS = { cpu: "cores", ram: "GiB", disk: "GB" } as const;
const SOURCE: Record<BoardDeclaredSource | "learned", string> = {
  declared: "declared",
  placeholder: "placeholder",
  upgrade: "set at upgrade",
  learned: "learned",
};

const fmt = (value: number) => String(Math.round(value * 100) / 100);

/** A static sparkline of the card samples, oldest first. */
function Sparkline({ values }: { readonly values: ReadonlyArray<number> }) {
  if (values.length < 2) return <span className="text-board-11">Too few samples to draw.</span>;
  const max = Math.max(...values, 0.0001);
  const points = values
    .map((value, index) => `${(index / (values.length - 1)) * 120},${30 - (value / max) * 28}`)
    .join(" ");
  return (
    <svg
      aria-label="Card samples, oldest first"
      className="text-foreground"
      height="32"
      width="120"
    >
      <polyline fill="none" points={points} stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}

function learnedText(learned: BoardLearnedDimension | null, unit: string): string {
  if (learned === null || learned.value === null) {
    return `${learned?.samples ?? 0} of ${BOARD_LEARNED_MIN_SAMPLES} cards`;
  }
  return `${fmt(learned.value)} ${unit}`;
}

export function BoardProjectLearnedTable(props: {
  readonly resources: BoardProjectResources | null;
  readonly canWrite: boolean;
  readonly onUseLearned: (dimension: BoardResourceDimension, value: number) => void;
  readonly onPin: (dimension: BoardResourceDimension, pinned: boolean) => void;
}) {
  const rows = BOARD_RESOURCE_DIMENSIONS.map((dimension) => ({
    dimension,
    use: boardPlannerUse(props.resources, dimension),
    learned: props.resources?.learned?.[dimension] ?? null,
  }));
  const held = rows.filter((row) => row.use.heldIncrease !== null);
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-board-12">
          <thead className="bg-muted text-left text-board-11 text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 font-medium">Dimension</th>
              <th className="px-3 py-1.5 font-medium">Declared</th>
              <th className="px-3 py-1.5 font-medium">Learned</th>
              <th className="px-3 py-1.5 font-medium">Planner uses</th>
              <th className="px-3 py-1.5 font-medium">Pin declared</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map(({ dimension, use, learned }) => (
              <tr key={dimension}>
                <td className="px-3 py-2 font-medium">{NAMES[dimension]}</td>
                <td className="px-3 py-2">
                  <span className="font-mono">{fmt(use.declared)}</span>{" "}
                  <span className="text-muted-foreground">· {SOURCE[use.declaredSource]}</span>
                </td>
                <td className={cn("px-3 py-2", use.pinned && "text-muted-foreground opacity-60")}>
                  <BoardHint
                    label={
                      <span className="flex flex-col gap-1">
                        <span>
                          p90 across cards, rounded up · {learned?.samples ?? 0} cards, last{" "}
                          {BOARD_LEARNED_WINDOW_DAYS} days
                        </span>
                        <Sparkline values={learned?.history ?? []} />
                      </span>
                    }
                  >
                    <span className="font-mono">{learnedText(learned, UNITS[dimension])}</span>
                  </BoardHint>
                  {use.pinned ? (
                    <span className="ml-1.5 text-board-11">ignored while pinned</span>
                  ) : null}
                  {use.offeredDecrease !== null && props.canWrite ? (
                    <Button
                      className="ml-2"
                      onClick={() => props.onUseLearned(dimension, use.offeredDecrease!)}
                      size="xs"
                      variant="outline"
                    >
                      Use learned ({fmt(use.offeredDecrease)})
                    </Button>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <span className="font-mono">{fmt(use.value)}</span>{" "}
                  <span className="text-muted-foreground">· {SOURCE[use.source]}</span>
                </td>
                <td className="px-3 py-2">
                  <Switch
                    aria-label={`Pin declared ${NAMES[dimension]}`}
                    checked={use.pinned}
                    disabled={!props.canWrite}
                    onCheckedChange={(checked) => props.onPin(dimension, checked)}
                    size="sm"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {held.map(({ dimension, use }) => (
        <div
          className="rounded-md bg-warning-surface px-3 py-2 text-board-12 text-warning-foreground"
          key={dimension}
        >
          Learned {NAMES[dimension]} of {fmt(use.heldIncrease!)} {UNITS[dimension]} would leave an M
          card unplaceable on every ready worker, so the planner keeps {fmt(use.declared)}. Source:
          learned.
        </div>
      ))}
      <p className="text-board-12 text-muted-foreground">
        Learned values need at least {BOARD_LEARNED_MIN_SAMPLES} cards with a measured CI pass or
        setup in the last {BOARD_LEARNED_WINDOW_DAYS} days. An increase applies to new placements
        and grows placed cards in the background; a decrease is only offered.
      </p>
    </div>
  );
}
