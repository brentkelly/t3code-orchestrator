import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  boardStageWithRole,
  boardSubBoardFloorStage,
  isBoardStageAtOrAfterBuild,
  type BoardStageDefinition,
  type BoardStageId,
  type BoardState,
} from "@t3tools/contracts";

const APPLIED_OUTCOMES = new Set([
  "merged",
  "started",
  "linked",
  "unlinked",
  "none",
  "removed",
  "no-worktree",
  "conflict",
  "checks-fix",
]);

export function describeBoardCommandFailure(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}): string {
  const error: unknown = squashAtomCommandFailure(result);
  if (typeof error === "object" && error !== null) {
    if ("detail" in error && typeof error.detail === "string" && error.detail.length > 0) {
      return error.detail;
    }
    if ("message" in error && typeof error.message === "string" && error.message.length > 0) {
      return error.message;
    }
  }
  return error instanceof Error ? error.message : "The server rejected the command.";
}

function describeSuccessOutcome(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("outcome" in value)) {
    return null;
  }
  const outcome = (value as { readonly outcome: unknown }).outcome;
  if (typeof outcome !== "string") return null;
  const detail =
    "detail" in value && typeof value.detail === "string" && value.detail.length > 0
      ? value.detail
      : null;
  switch (outcome) {
    case "merged":
    case "started":
    case "linked":
    case "unlinked":
    case "none":
    case "removed":
    case "no-worktree":
      return null;
    case "refused":
      return detail ?? "The server refused this action.";
    case "conflict":
      return "The branch conflicts with its base. Resolving the conflicts, then merging.";
    case "checks-fix":
      return "The pull request's checks failed. Fixing them, then merging once CI passes.";
    case "unknown-card":
      return "This card no longer exists.";
    case "wrong-stage":
      return "This card is not in a stage that can do that.";
    case "no-pull-request":
      return "This card has no pull request to merge.";
    case "no-workspace":
      return "This card has no workspace to merge from.";
    case "not-open":
      return "This pull request is closed.";
    case "step-running":
      return "Something is already running on this card. Wait for it to finish, then try again.";
    case "no-branch":
      return "This card has no branch to push.";
    case "blocked":
      return "This card is blocked by unmet dependencies.";
    case "failed":
      return "The action could not be started. See the server log for details.";
    default:
      return detail;
  }
}

/** Human sentence for a board command, or null when the click can stay silent. */
export function describeBoardCommandResult(
  result: AtomCommandResult<unknown, unknown>,
): string | null {
  if (result._tag === "Failure") {
    if (isAtomCommandInterrupted(result)) return null;
    return describeBoardCommandFailure(result);
  }
  return describeSuccessOutcome(result.value);
}

/**
 * Alert copy for a board command. Applied follow-ups (`conflict`,
 * `checks-fix`) keep their sentence but are titled as work that started.
 * Failures and refusals stay under "Could not complete".
 */
export function boardCommandAlert(
  result: AtomCommandResult<unknown, unknown>,
): { readonly title: string; readonly message: string } | null {
  const message = describeBoardCommandResult(result);
  if (message === null) return null;
  return {
    title: boardCommandDidApply(result) ? "Started follow-up" : "Could not complete",
    message,
  };
}

/**
 * Whether the command changed the card the way the click asked. A Success
 * `{ sequence }` from `board.dispatchCommand` counts. A Success `{ outcome:
 * "refused" }` from merge/submit does not — the card is still there.
 */
export function boardCommandDidApply(result: AtomCommandResult<unknown, unknown>): boolean {
  if (result._tag !== "Success") return false;
  const value = result.value;
  if (typeof value === "object" && value !== null && "outcome" in value) {
    const outcome = (value as { readonly outcome: unknown }).outcome;
    return typeof outcome === "string" && APPLIED_OUTCOMES.has(outcome);
  }
  return true;
}

function stageState(stages: ReadonlyArray<BoardStageDefinition>): BoardState {
  return { cards: [], stages, nextCardNumberByProject: {} };
}

export function boardCanShowApprovePlans(input: {
  readonly planCount: number;
  readonly children: ReadonlyArray<{ readonly archivedAt: string | null }>;
  readonly parentCardId: string | null;
  readonly archivedAt: string | null;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly stage: BoardStageId;
}): boolean {
  const board = stageState(input.stages);
  const buildStage = boardStageWithRole(board, "build");
  const floorStage = boardSubBoardFloorStage(board);
  return (
    input.planCount >= 2 &&
    input.children.every((child) => child.archivedAt !== null) &&
    input.parentCardId === null &&
    input.archivedAt === null &&
    floorStage !== null &&
    buildStage !== null &&
    (!isBoardStageAtOrAfterBuild(board, input.stage) || input.stage === buildStage.stageId)
  );
}
