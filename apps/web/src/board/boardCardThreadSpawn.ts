/**
 * T3o card thread spawn inputs (t3o-14) — pure builders for the two threads the
 * card pane's `+` menu can start.
 *
 * "Restart planning" produces the SAME thread the supervisor produces when a
 * card enters Planning: same prompt (`composeBoardPlanningPrompt`), same title
 * (`boardPlanningThreadTitle`), same link role, same plan-mode/no-worktree
 * bootstrap. The prompt and title come from `@t3tools/contracts` precisely so
 * the two entry points cannot drift; only the six bootstrap literals below are
 * stated twice, and `spawnPlanningThread` in `apps/server/src/board/supervisorReactor.ts`
 * is the other copy — change one, change both.
 *
 * The step is always resolved from CURRENT settings (`resolveBoardPlanningStep`
 * over the live `ServerSettings.board`), never from the card's `recipeSnapshot`.
 * Planning does not snapshot a recipe at all (D1), so a restart always picks up
 * the prompt as it is edited in Settings → Board → Pipeline right now.
 */
import {
  boardPlanningThreadTitle,
  composeBoardPlanningPrompt,
  type BoardCard,
  type BoardStep,
  type MessageId,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";
import type { CreateThreadInput, StartThreadTurnInput } from "@t3tools/client-runtime/operations";

/** The turn-start (with create bootstrap) that spawns a planning thread. */
export function planningThreadTurnInput(input: {
  readonly card: Pick<BoardCard, "key" | "title" | "projectId">;
  readonly step: BoardStep;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly createdAt: string;
}): StartThreadTurnInput {
  const { card, step, threadId, messageId, createdAt } = input;
  const title = boardPlanningThreadTitle(card, step);
  return {
    threadId,
    message: {
      messageId,
      role: "user",
      text: composeBoardPlanningPrompt({ card, step }),
      attachments: [],
    },
    modelSelection: { instanceId: step.providerInstanceId, model: step.model },
    runtimeMode: "full-access",
    interactionMode: "plan",
    bootstrap: {
      createThread: {
        projectId: card.projectId,
        title,
        modelSelection: { instanceId: step.providerInstanceId, model: step.model },
        runtimeMode: "full-access",
        interactionMode: "plan",
        branch: null,
        worktreePath: null,
        createdAt,
      },
    },
    createdAt,
  };
}

/** The blank thread the `+` menu creates: a real server thread with no first
    turn, so it can be linked immediately and typed into. It opens on the
    project's workspace with no worktree, like a thread started from the
    Threads view. */
export function blankThreadCreateInput(input: {
  readonly card: Pick<BoardCard, "key" | "projectId">;
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly createdAt: string;
}): CreateThreadInput {
  const { card, threadId, modelSelection, createdAt } = input;
  return {
    threadId,
    projectId: card.projectId,
    title: `${card.key} · Thread`,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt,
  };
}
