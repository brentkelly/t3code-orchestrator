/**
 * T3o card thread spawn inputs (t3o-14) — pure builders for the two threads the
 * card pane's `+` menu can start.
 *
 * "Restart planning" produces the SAME thread the supervisor produces when a
 * card enters Planning: same prompt, title, link role and bootstrap. Every field
 * that decides what KIND of thread you get comes from `@t3tools/contracts` —
 * `composeBoardPlanningPrompt`, `boardPlanningThreadTitle`, and the
 * `BOARD_PLANNING_THREAD_*` modes — so the two entry points cannot drift into
 * spawning differently-configured threads. The remaining per-card fields
 * (`projectId`, `modelSelection`, and the null `branch` / `worktreePath` that
 * keep planning off a worktree) are stated in both places, so both places assert
 * them: `boardCardThreadSpawn.test.ts` covers this builder, and
 * `planningStageSpawn.test.ts` asserts the reactor's dispatched bootstrap
 * field-for-field against the same contracts composers.
 *
 * The step is always resolved from CURRENT settings (`resolveBoardPlanningStep`
 * over the live `ServerSettings.board`), never from the card's `recipeSnapshot`.
 * Planning does not snapshot a recipe at all (D1), so a restart always picks up
 * the prompt as it is edited in Settings → Board → Pipeline right now.
 */
import {
  BOARD_PLANNING_THREAD_INTERACTION_MODE,
  BOARD_PLANNING_THREAD_RUNTIME_MODE,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  boardPlanningThreadTitle,
  composeBoardPlanningPrompt,
  type BoardCard,
  type BoardStage,
  type BoardStep,
  type MessageId,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";
import type { CreateThreadInput, StartThreadTurnInput } from "@t3tools/client-runtime/operations";

/**
 * Whether the `+` menu offers "New thread — restart planning".
 *
 * Planning only, and only while the planning recipe still has a step. Never in
 * Building: the supervisor owns build threads, and one spawned through this path
 * would carry the build prompt with no step state, no worktree and no governor
 * slot — a thread that looks like a build and that the supervisor does not know
 * exists. Restarting a build stays a supervisor concern (drag out and back).
 */
export function canRestartBoardPlanning(
  stage: BoardStage,
  planningStep: BoardStep | null,
): boolean {
  return stage === "planning" && planningStep !== null;
}

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
    runtimeMode: BOARD_PLANNING_THREAD_RUNTIME_MODE,
    interactionMode: BOARD_PLANNING_THREAD_INTERACTION_MODE,
    bootstrap: {
      createThread: {
        projectId: card.projectId,
        title,
        modelSelection: { instanceId: step.providerInstanceId, model: step.model },
        runtimeMode: BOARD_PLANNING_THREAD_RUNTIME_MODE,
        interactionMode: BOARD_PLANNING_THREAD_INTERACTION_MODE,
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
    project's workspace with no worktree, and takes the app's own defaults —
    read from contracts, not restated — so "like a thread started from the
    Threads view" stays true if those defaults ever move. The planning modes
    above are deliberately NOT imposed on it: you asked for a blank thread. */
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
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    createdAt,
  };
}
