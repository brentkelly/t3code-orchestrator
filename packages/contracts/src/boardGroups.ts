/**
 * General grouping (T3O-27, D12): a card with children is a GROUP, a card
 * without is a LEAF, and only leaves run the pipeline. Groups nest to any
 * depth. A group's stage is derived from its children, never set by hand.
 *
 * Every rule the decider, the reactor and the clients share lives here, so a
 * refusal and the control that would trigger it can never disagree.
 */
import {
  BoardStageId,
  boardCardHasLiveBranch,
  boardCardIntegrationAncestor,
  boardCardMergesIntoIntegrationBranch,
  boardCardPlans,
  isBoardPlanPlanned,
  boardNextStageId,
  boardStageBeforeBuild,
  boardStageIndex,
  boardStagesInOrder,
  boardStageWithRole,
  isBoardStageAtOrAfterBuild,
  boardPlanId,
  type BoardCard,
  type BoardCardGroup,
  type BoardCardId,
  type BoardCardShell,
  type BoardPlan,
  type BoardSplitRecommendation,
  type BoardState,
  isBoardDeferredStage,
} from "./board.ts";

/**
 * A card's group settings, or null for a leaf. A card that has live children
 * but no settings is a split parent written before groups existed: it reads as
 * what migrations 051 and 055 backfill — its own integration branch,
 * auto-build and auto-merge on — so a legacy log and a migrated table agree.
 */
export function boardCardGroupOf(board: BoardState, card: BoardCard): BoardCardGroup | null {
  if (card.group !== null) return card.group;
  if (
    !board.cards.some(
      (candidate) => candidate.parentCardId === card.id && candidate.archivedAt === null,
    )
  ) {
    return null;
  }
  const done = boardStageWithRole(board, "done")?.stageId ?? null;
  return defaultBoardCardGroup(board, card, {
    target: "own",
    autoBuild: true,
    // Begun as migration 055 backfills it: the parent or a live child has
    // reached the build stage.
    started:
      isBoardStageAtOrAfterBuild(board, card.stage) ||
      board.cards.some(
        (candidate) =>
          candidate.parentCardId === card.id &&
          candidate.archivedAt === null &&
          isBoardStageAtOrAfterBuild(board, candidate.stage),
      ),
    prevStage: boardGroupPlacedStage(board, card.stage),
    integrated: card.stage === done,
  });
}

/** Whether a card is a group. */
function isBoardCardGroup(board: BoardState, card: BoardCard): boolean {
  return boardCardGroupOf(board, card) !== null;
}

/**
 * The plan row a split child owns (T3O-27): a copy of the plan it was cut
 * from, so it counts as planned on its own. Shared by both projections and
 * mirrored by migration 051, so replay equals rehydration.
 */
export function boardSplitChildPlanCopy(
  source: Pick<BoardPlan, "planId" | "cardId" | "title" | "summary">,
  child: { readonly id: BoardCardId; readonly createdAt: string },
): BoardPlan {
  const key = String(source.planId).slice(String(source.cardId).length + 2);
  return {
    planId: boardPlanId(child.id, key),
    cardId: child.id,
    title: source.title,
    summary: source.summary,
    dependsOn: [],
    ordinal: 0,
    locked: false,
    createdAt: child.createdAt,
    updatedAt: child.createdAt,
  };
}

/** Every live (non-archived) child of `cardId`, in board order. */
export function boardCardLiveChildren(
  board: BoardState,
  cardId: BoardCardId,
): ReadonlyArray<BoardCard> {
  return board.cards.filter((card) => card.parentCardId === cardId && card.archivedAt === null);
}

/**
 * Whether a childless group should revert to a plain card. A group whose
 * children were archived finished as a group and stays one; only a group
 * emptied by regrouping or deletion reverts.
 */
export function boardGroupRevertsToCard(
  board: BoardState,
  card: Pick<BoardCard, "id" | "group">,
  group: Pick<BoardCardGroup, "heading">,
): boolean {
  if (group.heading || card.group === null) return false;
  return !board.cards.some((candidate) => candidate.parentCardId === card.id);
}

/** The children that count toward a group's progress: live and not deferred. */
export function boardCardActiveChildren(
  board: BoardState,
  cardId: BoardCardId,
): ReadonlyArray<BoardCard> {
  return boardCardLiveChildren(board, cardId).filter((card) => !isBoardDeferredStage(card.stage));
}

/** The ancestor chain of a card, nearest first. Guards against a corrupt
    cycle rather than looping forever. */
export function boardCardAncestors(
  board: BoardState,
  card: Pick<BoardCard, "id" | "parentCardId">,
): ReadonlyArray<BoardCard> {
  const out: BoardCard[] = [];
  const seen = new Set<BoardCardId>([card.id]);
  let parentId = card.parentCardId;
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = board.cards.find((candidate) => candidate.id === parentId);
    if (parent === undefined) break;
    out.push(parent);
    parentId = parent.parentCardId;
  }
  return out;
}

/** Every live descendant of `cardId`, depth-first. */
export function boardCardLiveDescendants(
  board: BoardState,
  cardId: BoardCardId,
): ReadonlyArray<BoardCard> {
  const out: BoardCard[] = [];
  const seen = new Set<BoardCardId>([cardId]);
  const walk = (id: BoardCardId) => {
    for (const child of boardCardLiveChildren(board, id)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      walk(child.id);
    }
  };
  walk(cardId);
  return out;
}

/** Whether `ancestorId` is `card` itself or one of its ancestors. */
export function isBoardCardSelfOrAncestor(
  board: BoardState,
  card: Pick<BoardCard, "id" | "parentCardId">,
  ancestorId: BoardCardId,
): boolean {
  return card.id === ancestorId || boardCardAncestors(board, card).some((a) => a.id === ancestorId);
}

/**
 * Whether work has started on a leaf (D6): it reached the build stage, or it
 * still owns a branch from having been there. A group is never started — its
 * children are.
 */
export function isBoardCardStarted(board: BoardState, card: BoardCard): boolean {
  if (isBoardCardGroup(board, card)) return false;
  return isBoardStageAtOrAfterBuild(board, card.stage) || boardCardHasLiveBranch(card);
}

/**
 * Where a group may be placed by hand: anything before the build stage. A
 * stage at or past build (or Deferred, or an unknown id) clamps to the stage
 * immediately before build, so a placed group never claims to be running.
 */
function boardGroupPlacedStage(board: BoardState, stageId: BoardStageId): BoardStageId {
  if (boardStageIndex(board, stageId) >= 0 && !isBoardStageAtOrAfterBuild(board, stageId)) {
    return stageId;
  }
  return boardStageBeforeBuild(board)?.stageId ?? boardStagesInOrder(board)[0]!.stageId;
}

/** The settings a card takes when it first becomes a group. An own-branch
    group auto-merges its children into that branch unless told otherwise
    (T3O-38). */
export function defaultBoardCardGroup(
  board: BoardState,
  card: Pick<BoardCard, "stage">,
  overrides?: Partial<BoardCardGroup>,
): BoardCardGroup {
  return {
    target: "inherit",
    autoBuild: false,
    autoMerge: overrides?.target === "own",
    autoPlan: false,
    started: false,
    placed: boardGroupPlacedStage(board, card.stage),
    prevStage: card.stage,
    heading: false,
    integrated: false,
    ...overrides,
  };
}

/**
 * The stage an emptied group reverts to as an ordinary card: the stage it had
 * before it became a group, capped at Sprint (the stage before the plan
 * role) so a card that lost its children never claims a plan or a build it
 * no longer has. A deferred group stays deferred.
 */
export function boardGroupRevertStage(
  board: BoardState,
  card: Pick<BoardCard, "stage" | "group">,
): BoardStageId {
  if (isBoardDeferredStage(card.stage)) return card.stage;
  const ordered = boardStagesInOrder(board);
  const plan = boardStageWithRole(board, "plan");
  const planIndex = plan === null ? -1 : boardStageIndex(board, plan.stageId);
  const capIndex = planIndex > 0 ? planIndex - 1 : 0;
  const wanted = card.group?.prevStage ?? card.stage;
  const index = boardStageIndex(board, wanted);
  if (index < 0) return ordered[0]!.stageId;
  return ordered[Math.min(index, capIndex)]!.stageId;
}

/**
 * A group's derived stage (D12):
 *
 * - **Done** when every active child (not Deferred) is done. An `own` group
 *   first sits in its integration review — the stage after build — until
 *   `integrated` is set; once a human has walked it further along that lane
 *   it stays where they put it.
 * - **Building** while any active child is at the build stage or later, and
 *   while a started group still sits there.
 * - Otherwise `placed`.
 *
 * A child group contributes its own derived stage, so a whole subtree
 * resolves in one call regardless of what its stored stages say.
 */
export function deriveBoardGroupStage(board: BoardState, card: BoardCard): BoardStageId {
  return deriveWithMemo(board, card, new Map());
}

function deriveWithMemo(
  board: BoardState,
  card: BoardCard,
  memo: Map<BoardCardId, BoardStageId>,
): BoardStageId {
  const known = memo.get(card.id);
  if (known !== undefined) return known;
  memo.set(card.id, card.stage);
  const group = boardCardGroupOf(board, card);
  if (group === null || isBoardDeferredStage(card.stage)) return card.stage;
  const active = boardCardActiveChildren(board, card.id);
  const stages = active.map((child) => deriveWithMemo(board, child, memo));
  const done = boardStageWithRole(board, "done");
  const build = boardStageWithRole(board, "build");
  let derived: BoardStageId;
  if (done !== null && active.length > 0 && stages.every((stage) => stage === done.stageId)) {
    derived =
      group.target === "own" && !group.integrated
        ? integrationLaneStage(board, card, build?.stageId ?? null, done.stageId)
        : done.stageId;
  } else if (
    build !== null &&
    (stages.some((stage) => isBoardStageAtOrAfterBuild(board, stage)) ||
      (group.started && card.stage === build.stageId))
  ) {
    derived = build.stageId;
  } else {
    derived = group.placed;
  }
  memo.set(card.id, derived);
  return derived;
}

/** The integration review lane: the stage after build, or wherever a human
    has already walked the group along that lane short of Done. */
function integrationLaneStage(
  board: BoardState,
  card: BoardCard,
  buildStageId: BoardStageId | null,
  doneStageId: BoardStageId,
): BoardStageId {
  const lane = buildStageId === null ? null : boardNextStageId(board, buildStageId, card.projectId);
  if (lane === null) return doneStageId;
  const laneIndex = boardStageIndex(board, lane);
  const current = boardStageIndex(board, card.stage);
  const doneIndex = boardStageIndex(board, doneStageId);
  return current >= laneIndex && current < doneIndex ? card.stage : lane;
}

/**
 * Why a group's merge target cannot change, or null when it can: a target is
 * locked while any descendant leaf has started and not finished, because that
 * leaf's branch was cut from the old target.
 */
export function boardGroupTargetLockReason(board: BoardState, card: BoardCard): string | null {
  const done = boardStageWithRole(board, "done")?.stageId ?? null;
  const started = boardCardLiveDescendants(board, card.id).filter(
    (descendant) => isBoardCardStarted(board, descendant) && descendant.stage !== done,
  );
  if (started.length === 0) return null;
  return `Work has started on ${started
    .map((descendant) => descendant.key)
    .join(", ")} under '${card.key}'; its merge target is locked until that work finishes.`;
}

/**
 * Why cards can't arrive under `parent` (T3O-28): an integration branch lives
 * in one repository, so every card landing on one must share the project of
 * the group that owns it. `arriving` is every card that would sit there,
 * subtrees included. Null when they may, or when they land on trunk.
 */
export function boardGroupProjectRefusal(
  board: BoardState,
  parent: BoardCard,
  arriving: ReadonlyArray<Pick<BoardCard, "key" | "projectId">>,
): string | null {
  const group = boardCardGroupOf(board, parent) ?? defaultBoardCardGroup(board, parent);
  const owner = group.target === "own" ? parent : boardCardIntegrationAncestor(board, parent);
  if (owner === null) return null;
  const foreign = arriving.find((card) => card.projectId !== owner.projectId);
  if (foreign === undefined) return null;
  return `Can't put '${foreign.key}' under '${parent.key}': it's in another project, and the integration branch of '${owner.key}' lives in that card's repository.`;
}

/** Why a group can't take its own integration branch because its subtree
    spans projects (T3O-28), or null when it can. */
export function boardGroupOwnTargetProjectRefusal(
  board: BoardState,
  card: BoardCard,
): string | null {
  const foreign = boardCardLiveDescendants(board, card.id).find(
    (descendant) => descendant.projectId !== card.projectId,
  );
  if (foreign === undefined) return null;
  return `Can't give '${card.key}' its own branch: '${foreign.key}' is in another project, and an integration branch lives in one repository.`;
}

/**
 * Whether a card counts as PLANNED (T3O-27): it owns a plan row. A split child
 * owns a copy of the plan it was cut from, so this needs no parent special case.
 */
export function isBoardCardPlanned(board: BoardState, cardId: BoardCardId): boolean {
  return boardCardPlans(board, cardId).length > 0;
}

/**
 * The split recommendation's fallback rules (T3O-31), for a field the agent
 * omitted: every child planned → auto-build on with its own branch (today's
 * sub-board); otherwise an epic breakdown → auto-build off, inherit. A card
 * that already merges into an ancestor's integration branch prefers inherit,
 * so a nested split does not stack a second integration review.
 */
export function boardSplitRecommendationFallback(input: {
  readonly plans: ReadonlyArray<Pick<BoardPlan, "planned">>;
  readonly underIntegrationBranch: boolean;
}): BoardSplitRecommendation {
  const allPlanned = input.plans.every(isBoardPlanPlanned);
  return {
    autoBuild: allPlanned,
    mergeTarget: allPlanned && !input.underIntegrationBranch ? "own" : "inherit",
  };
}

/** `boardCardMergesIntoIntegrationBranch` read from the client's shells,
    which carry `cardId` and leave `parentCardId` / `group` absent for null. */
export function boardShellMergesIntoIntegrationBranch(
  shells: ReadonlyArray<Pick<BoardCardShell, "cardId" | "parentCardId" | "group">>,
  card: { readonly parentCardId?: BoardCardId | null | undefined },
): boolean {
  const cards = shells.map((shell) => ({
    id: shell.cardId,
    parentCardId: shell.parentCardId ?? null,
    group: shell.group ?? null,
  }));
  return (
    boardCardIntegrationAncestor({ cards }, { parentCardId: card.parentCardId ?? null }) !== null
  );
}

/** A card's split recommendation: the stored one, or the fallback for a
    proposal made before T3O-31 recorded one. */
export function boardSplitRecommendationOf(
  board: BoardState,
  card: BoardCard,
): BoardSplitRecommendation {
  return (
    card.splitRecommendation ??
    boardSplitRecommendationFallback({
      plans: boardCardPlans(board, card.id),
      underIntegrationBranch: boardCardMergesIntoIntegrationBranch(board, card),
    })
  );
}

/** Whether two group settings are the same, field for field. */
export function boardCardGroupsEqual(
  left: BoardCardGroup | null,
  right: BoardCardGroup | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.target === right.target &&
    left.autoBuild === right.autoBuild &&
    left.autoMerge === right.autoMerge &&
    left.autoPlan === right.autoPlan &&
    left.started === right.started &&
    left.placed === right.placed &&
    left.prevStage === right.prevStage &&
    left.heading === right.heading &&
    left.integrated === right.integrated
  );
}

/** A card shell's place in the tree, as clients hold it. */
type BoardShellTreeNode = { readonly cardId: string; readonly parentCardId?: string | undefined };

/** The ids of a card's ancestors, from its parent up, over client shells. */
export function boardShellAncestorIds(
  shells: ReadonlyArray<BoardShellTreeNode>,
  parentCardId: string | null | undefined,
): ReadonlySet<string> {
  const byId = new Map(shells.map((shell) => [String(shell.cardId), shell]));
  const out = new Set<string>();
  let current = parentCardId == null ? null : String(parentCardId);
  while (current !== null && !out.has(current)) {
    out.add(current);
    const parent = byId.get(current)?.parentCardId;
    current = parent == null ? null : String(parent);
  }
  return out;
}

/** The ids of every card below `cardId`, over client shells. */
export function boardShellDescendantIds(
  shells: ReadonlyArray<BoardShellTreeNode>,
  cardId: string,
): ReadonlySet<string> {
  const out = new Set<string>();
  const walk = (id: string) => {
    for (const shell of shells) {
      if (shell.parentCardId == null || String(shell.parentCardId) !== id) continue;
      const childId = String(shell.cardId);
      if (out.has(childId)) continue;
      out.add(childId);
      walk(childId);
    }
  };
  walk(String(cardId));
  return out;
}

/**
 * A new phase (T3O-29): a group's deferred cards move out to a fresh sibling
 * group, a heading created next to it, and land in that group's Backlog. One
 * rule set shared by the board's dialog and `board_new_phase`, which both
 * compose it from create, move-cards and move.
 */
export type BoardNewPhasePlan =
  | { readonly kind: "refused"; readonly reason: string }
  | {
      readonly kind: "ok";
      readonly group: BoardCard;
      /** Where the new heading sits: beside the group, under its parent. */
      readonly parentCardId: BoardCardId | null;
      /** The heading's stage: the first stage, or the floor under an `own`
          parent, whose children live from there onward. */
      readonly headingStage: BoardStageId;
      /** The deferred cards to move, in board order. */
      readonly cardIds: ReadonlyArray<BoardCardId>;
      /** Where the moved cards land inside the new heading. */
      readonly cardStage: BoardStageId;
    };

/** A new phase heading's stage: the first stage, or the floor under an `own`
    parent, whose children live from there onward. */
export function boardNewPhaseHeadingStage(board: BoardState, parentOwn: boolean): BoardStageId {
  const first = boardStagesInOrder(board)[0]!.stageId;
  return parentOwn ? (boardStageBeforeBuild(board)?.stageId ?? first) : first;
}

export function boardNewPhasePlan(
  board: BoardState,
  groupId: BoardCardId,
  cardIds: ReadonlyArray<BoardCardId>,
): BoardNewPhasePlan {
  const group = board.cards.find((card) => card.id === groupId && card.archivedAt === null);
  if (group === undefined || boardCardGroupOf(board, group) === null) {
    return { kind: "refused", reason: `Card '${groupId}' is not a group.` };
  }
  if (cardIds.length === 0) {
    return { kind: "refused", reason: "Pick at least one deferred card for the new phase." };
  }
  const deferred = boardCardLiveChildren(board, group.id).filter((card) =>
    isBoardDeferredStage(card.stage),
  );
  const wanted = new Set(cardIds);
  const stray = cardIds.find((id) => !deferred.some((card) => card.id === id));
  if (stray !== undefined) {
    const key = board.cards.find((card) => card.id === stray)?.key ?? stray;
    return {
      kind: "refused",
      reason: `'${key}' is not a deferred card of '${group.key}'; only deferred cards move to a new phase.`,
    };
  }
  const first = boardStagesInOrder(board)[0]!.stageId;
  const parent =
    group.parentCardId === null
      ? undefined
      : board.cards.find((card) => card.id === group.parentCardId);
  const parentOwn = parent !== undefined && boardCardGroupOf(board, parent)?.target === "own";
  return {
    kind: "ok",
    group,
    parentCardId: group.parentCardId,
    headingStage: boardNewPhaseHeadingStage(board, parentOwn),
    cardIds: deferred.filter((card) => wanted.has(card.id)).map((card) => card.id),
    cardStage: first,
  };
}

/** The new phase's default title: `‹Group›: Phase 2`, or `Phase n+1` when the
    group's title already ends `: Phase n`. */
export function boardNextPhaseTitle(title: string): string {
  const match = /^(.*): Phase (\d+)$/.exec(title.trim());
  if (match !== null) return `${match[1]}: Phase ${Number(match[2]) + 1}`;
  return `${title.trim()}: Phase 2`;
}

/** The brief a new phase's heading is created with. */
export function boardNewPhaseBrief(group: Pick<BoardCard, "key" | "title">): string {
  return `Next phase of ${group.key} · ${group.title}.`;
}
