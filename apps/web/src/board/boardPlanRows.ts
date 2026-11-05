/**
 * T3o group rows and the dependency chart's layout (t3o-29, T3O-34). Pure
 * functions, no React — the Cards pane and the sub-board both render from
 * these, and they are unit-tested without a DOM.
 *
 * Rows are CARDS first: every child of the group gets one, whether it was cut
 * from a plan or made by hand and grouped, and the plans no child claims are
 * listed after them as "No card". Every live per-child fact — stage,
 * `blocked`, PR number, whether an agent is working, whether a human is being
 * asked something — comes from the child's `BoardCardShell`, which rides the
 * unscoped shell snapshot the root board already reads.
 *
 * The edges between card rows come from each child's own `dependsOn`, carried
 * on the detail-only `BoardCardChildRef` (the shell's D7 budget only has room
 * for `dependencyCount`). A card-less plan's edges come from `plan.dependsOn`,
 * resolved to the card cut from each plan where there is one.
 */
import {
  effectiveBoardStageRole,
  isBoardCardAwaitingPermission,
  isBoardCardWorking,
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
      dot's own rule (`isBoardCardWorking`), so a review loop's between-thread
      gaps stay lit here exactly as they do on the board — and a child whose
      threads have all died goes dark here exactly as it does there. */
  readonly working: boolean;
  readonly awaitingInput: boolean;
  /** A thread is blocked on a permission prompt (T3O-16) — the card face's
      `permission` reason, read the same way. */
  readonly awaitingPermission: boolean;
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
  /** `card:<cardId>` or `plan:<planId>` — stable across renders, and the id
      edges and React keys use. */
  readonly rowId: string;
  /** The plan behind the row, null for a child made by hand. */
  readonly planId: BoardPlanId | null;
  /** 1-based position in dependency order — the `#N` the whole pane counts in. */
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
  /** Row ids of the siblings this row comes after, for the chart's edges. */
  readonly dependsOn: ReadonlyArray<string>;
  /** `#N`s of everything this row comes after, whatever their state — the
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
 * The rows a group's children and its unclaimed plans make, in dependency
 * order: a topological sort over the row edges, ties broken by input order
 * (children in `card_number` order, then plans in `ordinal` order). Hand-made
 * children have no ordinal to sort by, so the order has to be derived here.
 * Cycle-safe: whatever a cycle leaves unplaced follows in input order.
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
  if (input.plans.length === 0 && input.children.length === 0) return EMPTY_ROWS;

  const doneStageId =
    input.stages.find((stage) => effectiveBoardStageRole(stage) === "done")?.stageId ?? null;
  const buildStageId =
    input.stages.find((stage) => effectiveBoardStageRole(stage) === "build")?.stageId ?? null;
  const stageIndex = new Map(input.stages.map((stage, index) => [stage.stageId, index]));
  const buildIndex = buildStageId === null ? null : (stageIndex.get(buildStageId) ?? null);
  const labelOf = (stageId: BoardStageId): string =>
    input.stages.find((stage) => stage.stageId === stageId)?.label ?? stageId;

  const plans = [...input.plans].sort((left, right) => left.ordinal - right.ordinal);
  const planById = new Map(plans.map((plan) => [plan.planId, plan]));
  const cardRowId = (cardId: string) => `card:${cardId}`;
  const planRowId = (planId: BoardPlanId) => `plan:${planId}`;
  const siblingIds = new Set(input.children.map((child) => child.cardId as string));
  // The row a plan resolves to: the card cut from it where one exists, else
  // the plan's own "No card" row.
  const rowIdByPlan = new Map<BoardPlanId, string>(
    plans.map((plan) => [plan.planId, planRowId(plan.planId)]),
  );
  for (const child of input.children) {
    if (child.sourcePlanId !== null && planById.has(child.sourcePlanId)) {
      rowIdByPlan.set(child.sourcePlanId, cardRowId(child.cardId));
    }
  }
  const claimed = new Set(
    input.children.flatMap((child) => (child.sourcePlanId === null ? [] : [child.sourcePlanId])),
  );
  const shellByCard = new Map(input.cards.map((card) => [card.cardId as string, card]));

  interface Seed {
    readonly rowId: string;
    readonly planId: BoardPlanId | null;
    readonly title: string;
    readonly child: BoardCardChildRef | null;
    readonly dependsOn: ReadonlyArray<string>;
  }
  const unique = (ids: ReadonlyArray<string>, self: string) =>
    [...new Set(ids)].filter((id) => id !== self);
  const seeds: ReadonlyArray<Seed> = [
    ...input.children.map((child): Seed => {
      const rowId = cardRowId(child.cardId);
      return {
        rowId,
        planId: child.sourcePlanId,
        title: child.title,
        child,
        dependsOn: unique(
          child.dependsOn.filter((id) => siblingIds.has(id)).map((id) => cardRowId(id)),
          rowId,
        ),
      };
    }),
    ...plans
      .filter((plan) => !claimed.has(plan.planId))
      .map((plan): Seed => {
        const rowId = planRowId(plan.planId);
        return {
          rowId,
          planId: plan.planId,
          title: plan.title,
          child: null,
          dependsOn: unique(
            plan.dependsOn.flatMap((dependency) => {
              const target = rowIdByPlan.get(dependency);
              return target === undefined ? [] : [target];
            }),
            rowId,
          ),
        };
      }),
  ];

  const ordered = topologicalOrder(seeds);
  const numberByRow = new Map(ordered.map((seed, index) => [seed.rowId, index + 1]));

  const rows = ordered.map((seed, index): DraftPlanRow => {
    const child = seed.child;
    const shell = child === null ? undefined : shellByCard.get(child.cardId as string);
    const state: BoardPlanRowState =
      child === null ? "missing" : child.archivedAt !== null ? "archived" : "live";
    // The child ref's stage is the last one the projection saw, which for an
    // archived card is the last one it will ever have; a live child's shell is
    // fresher, so it wins where both exist.
    const stage = shell?.stage ?? child?.stage ?? null;
    const done = state === "live" && doneStageId !== null && stage === doneStageId;
    const started =
      buildIndex !== null && stage !== null && (stageIndex.get(stage) ?? -1) >= buildIndex;

    const dependsOnNumbers = seed.dependsOn
      .map((dependency) => numberByRow.get(dependency))
      .filter((n): n is number => n !== undefined)
      .toSorted((left, right) => left - right);

    return {
      rowId: seed.rowId,
      planId: seed.planId,
      n: index + 1,
      title: seed.title,
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
              working: isBoardCardWorking(shell),
              awaitingInput: shell.awaitingInput,
              awaitingPermission: isBoardCardAwaitingPermission(shell),
              queued: shell.queued,
              stalled: shell.stalled,
            },
      dependsOn: seed.dependsOn,
      dependsOnNumbers,
    };
  });

  const rowById = new Map(rows.map((row) => [row.rowId, row]));
  const settled = rows.map((row): BoardPlanRow => {
    // Only a LIVE, unfinished sibling holds a row up. An archived dependency
    // no longer gates (t3o-13, D1) and a deleted one has nothing left to
    // wait for, so neither is a blocker — same rule the decider applies, so
    // the panel never shows a card as waiting on something the board would
    // happily let it past.
    const blockers = row.dependsOn
      .map((dependency) => rowById.get(dependency))
      .filter(
        (dependency): dependency is DraftPlanRow =>
          dependency !== undefined && dependency.state === "live" && !dependency.done,
      )
      .toSorted((left, right) => left.n - right.n)
      .map((dependency): BoardPlanRowBlocker => ({
        n: dependency.n,
        key: dependency.key,
        stageLabel: (dependency.stageLabel ?? "").toLowerCase(),
      }));
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

/** Each pass places the earliest-input row whose dependencies are all placed;
    when a cycle leaves none placeable, the earliest remaining row goes next. */
function topologicalOrder<
  T extends { readonly rowId: string; readonly dependsOn: ReadonlyArray<string> },
>(seeds: ReadonlyArray<T>): ReadonlyArray<T> {
  const known = new Set(seeds.map((seed) => seed.rowId));
  const placed = new Set<string>();
  const remaining = [...seeds];
  const ordered: Array<T> = [];
  while (remaining.length > 0) {
    const ready = remaining.findIndex((seed) =>
      seed.dependsOn.every((dependency) => !known.has(dependency) || placed.has(dependency)),
    );
    const [next] = remaining.splice(ready === -1 ? 0 : ready, 1);
    if (next === undefined) break;
    placed.add(next.rowId);
    ordered.push(next);
  }
  return ordered;
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
  readonly rowId: string;
  readonly n: number;
  readonly title: string;
  readonly stageLabel: string | null;
  readonly tone: BoardPlanRowTone;
  /** Null when the row has no live card to open — a plan never materialised,
      or a child deleted or archived. */
  readonly cardId: string | null;
  /** A thread on the child asked a question or wants permission — the same
      violet the row list gives either. */
  readonly needsHuman: boolean;
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
  const rowById = new Map(rows.map((row) => [row.rowId, row]));

  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (rowId: string): number => {
    const memo = depth.get(rowId);
    if (memo !== undefined) return memo;
    // A back edge: stop rather than recur. The node keeps whatever depth its
    // other edges give it, so a cycle degrades to a flat layout instead of a
    // stack overflow.
    if (visiting.has(rowId)) return 0;
    const row = rowById.get(rowId);
    if (row === undefined) return 0;
    visiting.add(rowId);
    let result = 0;
    for (const dependency of row.dependsOn) {
      if (!rowById.has(dependency)) continue;
      result = Math.max(result, depthOf(dependency) + 1);
    }
    visiting.delete(rowId);
    depth.set(rowId, result);
    return result;
  };

  const waves: Array<Array<BoardPlanRow>> = [];
  for (const row of rows) {
    const column = depthOf(row.rowId);
    (waves[column] ??= []).push(row);
  }
  // `Array.from`, not `.map`: a cycle-guarded depth walk can skip a column,
  // and `.map` preserves holes rather than filling them.
  const filled = Array.from(waves, (wave) => wave ?? []);

  const position = new Map<string, { readonly x: number; readonly y: number }>();
  filled.forEach((wave, column) => {
    wave.forEach((row, index) => {
      position.set(row.rowId, {
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
    const to = position.get(row.rowId);
    if (to === undefined) continue;
    for (const dependency of row.dependsOn) {
      const from = position.get(dependency);
      const source = rowById.get(dependency);
      if (from === undefined || source === undefined) continue;
      const x1 = from.x + NODE_WIDTH;
      const y1 = from.y + NODE_HEIGHT / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_HEIGHT / 2;
      edges.push({
        id: `${dependency}->${row.rowId}`,
        d: `M${x1} ${y1}C${x1 + GAP_X * 0.65} ${y1},${x2 - GAP_X * 0.65} ${y2},${x2} ${y2}`,
        done: source.done,
      });
    }
  }

  const nodes = rows.flatMap((row): ReadonlyArray<BoardPlanGraphNode> => {
    const at = position.get(row.rowId);
    if (at === undefined) return [];
    return [
      {
        rowId: row.rowId,
        n: row.n,
        title: row.title,
        stageLabel: row.stageLabel,
        tone: row.tone,
        cardId: row.live?.cardId ?? null,
        needsHuman: row.live?.awaitingInput === true || row.live?.awaitingPermission === true,
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
  const plural = liveTotal === 1 ? "card" : "cards";
  const note =
    liveTotal === 0
      ? "No cards are left in this group."
      : liveDone === liveTotal
        ? `All ${liveTotal} ${plural} done. The final review runs on the integration branch.`
        : `${liveDone} of ${liveTotal} ${plural} done. The final review starts on its own when the last one lands.`;
  return { branch: input.branch, note };
}
