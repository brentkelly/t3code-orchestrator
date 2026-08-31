/**
 * T3o plan rows and the dependency chart's layout (t3o-29). Pure functions,
 * no React — the Plans panel and the sub-board both render from these, and
 * they are unit-tested without a DOM.
 *
 * Everything here is DERIVED from state the client already holds (D1). The
 * plans and the plan↔child pairing come from the parent's card detail; every
 * live per-child fact — stage, `blocked`, PR number, whether an agent is
 * working, whether a human is being asked something — comes from the child's
 * `BoardCardShell`, which rides the same unscoped shell snapshot the root
 * board already reads to compute a parent's plan pips. Nothing on the wire
 * changed for this to work, and nothing should: `BoardCardShell` is the D7
 * byte budget, and a second copy of these fields on `BoardCardChildRef` would
 * be a second thing to keep true.
 *
 * The one fact the shells cannot supply is the dependency EDGES: the shell
 * carries `dependencyCount`, a number, because D7 is explicit that "the ids
 * themselves never ride the shell". So edges come from `plans[].dependsOn`,
 * mapped through `sourcePlanId` (D3). A dependency added to a child by hand
 * after materialisation therefore shows in the row's blocked state — that is
 * a shell field — but draws no edge in the chart.
 */
import {
  effectiveBoardStageRole,
  type BoardCardChildRef,
  type BoardCardShell,
  type BoardPlanId,
  type BoardPlanWithBody,
  type BoardStageDefinition,
  type BoardStageId,
} from "@t3tools/contracts";

/** The plan metadata a row needs — the body is the markdown pane's business,
    not this one's. */
export type BoardPlanRowPlan = Pick<
  BoardPlanWithBody,
  "planId" | "title" | "dependsOn" | "ordinal"
>;

/** What a row's dot and its child's face are saying. `blocked` outranks
    `active` deliberately: a child the board has started but whose sibling has
    not landed is waiting, and reading it as running would be the same lie the
    card face's queue indicator exists to avoid. */
export type BoardPlanRowTone = "done" | "blocked" | "active" | "idle" | "gone";

/** The three states a row can be in (D4). A plan outlives the card cut from
    it: `missing` is a deleted child, `archived` one that was filed away. */
export type BoardPlanRowState = "live" | "archived" | "missing";

/** The live half of a row, absent unless the child is on the board. Archived
    cards leave the shell snapshot (D15), so an archived child has a
    `BoardCardChildRef` and no shell — which is exactly why this is null for
    both `archived` and `missing`. */
export interface BoardPlanRowLive {
  readonly cardId: string;
  readonly prNumber: number | undefined;
  /** The durable "being worked" signal, not a single thread's turn: the card
      dot's own rule (`stepRunning || threadState === "working"`), so a review
      loop's between-thread gaps stay lit here exactly as they do on the
      board. */
  readonly working: boolean;
  readonly awaitingInput: boolean;
  readonly queued: boolean;
  readonly stalled: boolean;
}

export interface BoardPlanRowBlocker {
  /** The blocking plan's `#N`. */
  readonly n: number;
  readonly key: string | null;
  /** Lower-cased for the inline note ("waiting on #3 · code review"). */
  readonly stageLabel: string;
}

export interface BoardPlanRow {
  readonly planId: BoardPlanId;
  /** 1-based position in the plan set — the `#N` the whole panel counts in. */
  readonly n: number;
  readonly title: string;
  readonly state: BoardPlanRowState;
  /** The child's key, retained for an archived child too, so the pairing
      survives the card (D4). */
  readonly key: string | null;
  readonly stage: BoardStageId | null;
  readonly stageLabel: string | null;
  readonly done: boolean;
  readonly tone: BoardPlanRowTone;
  readonly live: BoardPlanRowLive | null;
  /** Plan ids, for the chart's edges. */
  readonly dependsOn: ReadonlyArray<BoardPlanId>;
  /** `#N`s of everything this plan comes after, whatever their state — the
      row's "after #1, #2" line. */
  readonly dependsOnNumbers: ReadonlyArray<number>;
  /** The subset still unfinished, which is what actually holds this one up. */
  readonly blockers: ReadonlyArray<BoardPlanRowBlocker>;
}

export interface BoardPlanRows {
  readonly rows: ReadonlyArray<BoardPlanRow>;
  /** Live children only — the footer counts what can actually land on the
      integration branch, and an archived plan card never will. */
  readonly liveTotal: number;
  readonly liveDone: number;
}

const EMPTY_ROWS: BoardPlanRows = { rows: [], liveTotal: 0, liveDone: 0 };

/** A row mid-derivation: `blockers` and `tone` need every OTHER row's `done`
    to be known, so the first pass carries `started` forward and the second
    settles both. `started` never leaves this module. */
type DraftPlanRow = BoardPlanRow & { readonly started: boolean };

/**
 * The rows a parent's plan set makes, in ordinal order.
 *
 * Ordinal order IS dependency order: `board_propose_plans` validates the plan
 * graph acyclic on ingest and materialisation walks the same order, so the
 * panel does not re-topologise what the planner already sorted. The chart is
 * where the shape gets drawn.
 */
export function deriveBoardPlanRows(input: {
  readonly plans: ReadonlyArray<BoardPlanRowPlan>;
  readonly children: ReadonlyArray<BoardCardChildRef>;
  /** The unscoped shell list. Children are filtered out of the root board's
      columns, never out of the snapshot, so the parent's own modal can read
      them. */
  readonly cards: ReadonlyArray<BoardCardShell>;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
}): BoardPlanRows {
  if (input.plans.length === 0) return EMPTY_ROWS;

  const doneStageId =
    input.stages.find((stage) => effectiveBoardStageRole(stage) === "done")?.stageId ?? null;
  const buildStageId =
    input.stages.find((stage) => effectiveBoardStageRole(stage) === "build")?.stageId ?? null;
  const stageIndex = new Map(input.stages.map((stage, index) => [stage.stageId, index]));
  const buildIndex = buildStageId === null ? null : (stageIndex.get(buildStageId) ?? null);
  const labelOf = (stageId: BoardStageId): string =>
    input.stages.find((stage) => stage.stageId === stageId)?.label ?? stageId;

  const plans = [...input.plans].sort((left, right) => left.ordinal - right.ordinal);
  const numberByPlan = new Map(plans.map((plan, index) => [plan.planId, index + 1]));
  const childByPlan = new Map(
    input.children
      .filter((child) => child.sourcePlanId !== null)
      .map((child) => [child.sourcePlanId as BoardPlanId, child]),
  );
  const shellByCard = new Map(input.cards.map((card) => [card.cardId as string, card]));

  const rows = plans.map((plan, index): DraftPlanRow => {
    const child = childByPlan.get(plan.planId);
    const shell = child === undefined ? undefined : shellByCard.get(child.cardId as string);
    const state: BoardPlanRowState =
      child === undefined ? "missing" : child.archivedAt !== null ? "archived" : "live";
    // The child ref's stage is the last one the projection saw, which for an
    // archived card is the last one it will ever have; a live child's shell is
    // fresher, so it wins where both exist.
    const stage = shell?.stage ?? child?.stage ?? null;
    const done = state === "live" && doneStageId !== null && stage === doneStageId;
    const started =
      buildIndex !== null && stage !== null && (stageIndex.get(stage) ?? -1) >= buildIndex;

    const dependsOnNumbers = plan.dependsOn
      .map((dependency) => numberByPlan.get(dependency))
      .filter((n): n is number => n !== undefined)
      .toSorted((left, right) => left - right);

    return {
      planId: plan.planId,
      n: index + 1,
      title: plan.title,
      state,
      started,
      key: child?.key ?? null,
      stage,
      stageLabel: stage === null ? null : labelOf(stage),
      done,
      // Filled once every row's `done` is known — a blocker is a sibling, so
      // the pass below closes over the whole set.
      tone: "idle",
      blockers: [],
      live:
        state !== "live" || shell === undefined
          ? null
          : {
              cardId: shell.cardId as string,
              prNumber: shell.prNumber,
              working: shell.stepRunning || shell.threadState === "working",
              awaitingInput: shell.awaitingInput,
              queued: shell.queued,
              stalled: shell.stalled,
            },
      dependsOn: plan.dependsOn,
      dependsOnNumbers,
    };
  });

  const rowByPlan = new Map(rows.map((row) => [row.planId, row]));
  const settled = rows.map((row): BoardPlanRow => {
    // Only a LIVE, unfinished sibling holds a row up. An archived dependency
    // no longer gates (t3o-13, D1) and a deleted one has nothing left to
    // wait for, so neither is a blocker — same rule the decider applies, so
    // the panel never shows a card as waiting on something the board would
    // happily let it past.
    const blockers = row.dependsOn
      .map((dependency) => rowByPlan.get(dependency))
      .filter(
        (dependency): dependency is DraftPlanRow =>
          dependency !== undefined && dependency.state === "live" && !dependency.done,
      )
      .toSorted((left, right) => left.n - right.n)
      .map(
        (dependency): BoardPlanRowBlocker => ({
          n: dependency.n,
          key: dependency.key,
          stageLabel: (dependency.stageLabel ?? "").toLowerCase(),
        }),
      );
    const tone = toneOf({ ...row, blocked: blockers.length > 0 });
    const { started: _started, ...rest } = row;
    return { ...rest, blockers, tone };
  });

  const live = settled.filter((row) => row.state === "live");
  return {
    rows: settled,
    liveTotal: live.length,
    liveDone: live.filter((row) => row.done).length,
  };
}

/** A row's dot, in precedence order. `blocked` outranks `active` on purpose:
    a child the board has moved into build but whose sibling has not landed is
    waiting, and a running-coloured dot there would be the same lie the queue
    indicator exists to avoid. */
function toneOf(row: {
  readonly state: BoardPlanRowState;
  readonly done: boolean;
  readonly blocked: boolean;
  readonly started: boolean;
}): BoardPlanRowTone {
  if (row.state !== "live") return "gone";
  if (row.done) return "done";
  if (row.blocked) return "blocked";
  return row.started ? "active" : "idle";
}

// ── The dependency chart ───────────────────────────────────────────────

/** The prototype's geometry (`t3o.dc.html`, `graphVm`), kept to the pixel so
    the chart reads the way it was designed to. */
const NODE_WIDTH = 190;
const NODE_HEIGHT = 54;
const GAP_X = 62;
const GAP_Y = 14;

export interface BoardPlanGraphNode {
  readonly planId: BoardPlanId;
  readonly n: number;
  readonly title: string;
  readonly stageLabel: string | null;
  readonly tone: BoardPlanRowTone;
  /** Null when the plan has no card to open — deleted, or never materialised. */
  readonly cardId: string | null;
  readonly awaitingInput: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BoardPlanGraphEdge {
  readonly id: string;
  /** An SVG cubic path from the source's right edge to the target's left. */
  readonly d: string;
  /** Whether the SOURCE is done — a satisfied edge, tinted so a glance at the
      chart shows how far the wavefront has got. */
  readonly done: boolean;
}

export interface BoardPlanGraphLayout {
  readonly nodes: ReadonlyArray<BoardPlanGraphNode>;
  readonly edges: ReadonlyArray<BoardPlanGraphEdge>;
  readonly width: number;
  readonly height: number;
}

/**
 * Lay the rows out in dependency waves: column = longest path from a root, so
 * every edge points strictly rightward and a plan sits one column past its
 * last-landing prerequisite.
 *
 * The depth walk carries a cycle guard. The decider refuses to approve a
 * cyclic plan graph, so this should be unreachable — but a pure function that
 * can hang the render on bad data is a worse failure than the one it guards,
 * and "terminate on a cycle" costs a `Set`.
 */
export function boardPlanGraphLayout(
  rows: ReadonlyArray<BoardPlanRow>,
): BoardPlanGraphLayout | null {
  if (rows.length === 0) return null;
  const rowByPlan = new Map(rows.map((row) => [row.planId, row]));

  const depth = new Map<BoardPlanId, number>();
  const visiting = new Set<BoardPlanId>();
  const depthOf = (planId: BoardPlanId): number => {
    const memo = depth.get(planId);
    if (memo !== undefined) return memo;
    // A back edge: stop rather than recur. The node keeps whatever depth its
    // other edges give it, so a cycle degrades to a flat layout instead of a
    // stack overflow.
    if (visiting.has(planId)) return 0;
    const row = rowByPlan.get(planId);
    if (row === undefined) return 0;
    visiting.add(planId);
    let result = 0;
    for (const dependency of row.dependsOn) {
      if (!rowByPlan.has(dependency)) continue;
      result = Math.max(result, depthOf(dependency) + 1);
    }
    visiting.delete(planId);
    depth.set(planId, result);
    return result;
  };

  const waves: Array<Array<BoardPlanRow>> = [];
  for (const row of rows) {
    const column = depthOf(row.planId);
    (waves[column] ??= []).push(row);
  }
  // `Array.from`, not `.map`: a cycle-guarded depth walk can skip a column,
  // and `.map` preserves holes rather than filling them.
  const filled = Array.from(waves, (wave) => wave ?? []);

  const position = new Map<BoardPlanId, { readonly x: number; readonly y: number }>();
  filled.forEach((wave, column) => {
    wave.forEach((row, index) => {
      position.set(row.planId, {
        x: column * (NODE_WIDTH + GAP_X),
        y: index * (NODE_HEIGHT + GAP_Y),
      });
    });
  });

  const columns = filled.length;
  const tallest = filled.reduce((most, wave) => Math.max(most, wave.length), 0);
  const width = columns * NODE_WIDTH + (columns - 1) * GAP_X;
  const height = tallest * NODE_HEIGHT + (tallest - 1) * GAP_Y;

  const edges: Array<BoardPlanGraphEdge> = [];
  for (const row of rows) {
    const to = position.get(row.planId);
    if (to === undefined) continue;
    for (const dependency of row.dependsOn) {
      const from = position.get(dependency);
      const source = rowByPlan.get(dependency);
      if (from === undefined || source === undefined) continue;
      const x1 = from.x + NODE_WIDTH;
      const y1 = from.y + NODE_HEIGHT / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_HEIGHT / 2;
      edges.push({
        id: `${dependency}->${row.planId}`,
        d: `M${x1} ${y1}C${x1 + GAP_X * 0.65} ${y1},${x2 - GAP_X * 0.65} ${y2},${x2} ${y2}`,
        done: source.done,
      });
    }
  }

  const nodes = rows.flatMap((row): ReadonlyArray<BoardPlanGraphNode> => {
    const at = position.get(row.planId);
    if (at === undefined) return [];
    return [
      {
        planId: row.planId,
        n: row.n,
        title: row.title,
        stageLabel: row.stageLabel,
        tone: row.tone,
        cardId: row.live?.cardId ?? null,
        awaitingInput: row.live?.awaitingInput ?? false,
        x: at.x,
        y: at.y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      },
    ];
  });

  return { nodes, edges, width, height };
}

// ── The final-review footer ────────────────────────────────────────────

export interface BoardPlanFinalReview {
  /** The parent's integration branch; null before the reactor has cut it. */
  readonly branch: string | null;
  readonly note: string;
}

/**
 * The footer's copy (D5). It STATES; it does not act. The reactor already
 * owns this transition — `advanceParentIfChildrenDone` moves the parent out
 * of build the moment the last child lands, and `regressParentIfChildLeftDone`
 * puts it back if one leaves — so a button here would be a second path into
 * the same move, reachable only in a race the reactor normally wins.
 *
 * No "→ main": the default branch is resolved server-side when the
 * integration branch is cut and never rides the wire, so naming one here
 * would be the panel's only invention.
 */
export function boardPlanFinalReview(input: {
  readonly branch: string | null;
  readonly liveTotal: number;
  readonly liveDone: number;
}): BoardPlanFinalReview {
  const { liveTotal, liveDone } = input;
  const plural = liveTotal === 1 ? "plan" : "plans";
  const note =
    liveTotal === 0
      ? "No plan cards are left on this split."
      : liveDone === liveTotal
        ? `All ${liveTotal} ${plural} done. The final review runs on the integration branch.`
        : `${liveDone} of ${liveTotal} ${plural} done. The final review starts on its own when the last one lands.`;
  return { branch: input.branch, note };
}
