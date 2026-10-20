/**
 * Test fixtures for the board decider (T3O-56).
 *
 * The decider used to read projects and threads straight off upstream's
 * command read model. It now takes them as a loaded `BoardDecisionContext`,
 * which the engine reads from upstream's tables. Suites that hold a whole
 * `BoardOrchestrationReadModel` derive the same context from it here, so a fixture
 * still says "this project exists" by putting the project in the model.
 */
import type { ThreadId } from "@t3tools/contracts";

import {
  boardCommandNeedsProjects,
  boardCommandNeedsThread,
  decideBoardCommand,
  type BoardCommand,
  type BoardDecisionContext,
} from "./decider.ts";
import type { BoardOrchestrationReadModel } from "./projector.ts";

/** The context the engine would load for `command`, read off a full model. */
export function boardDecisionContextFromModel(
  command: BoardCommand,
  model: Pick<BoardOrchestrationReadModel, "projects" | "threads">,
  extra?: { readonly brief?: string | null },
): BoardDecisionContext {
  const projects = boardCommandNeedsProjects(command)
    ? {
        projects: model.projects.map((project) => ({
          id: project.id,
          title: project.title,
          deleted: project.deletedAt !== null,
        })),
      }
    : {};
  const thread = boardCommandNeedsThread(command)
    ? { thread: findThread(model, command.threadId) }
    : {};
  return { ...extra, ...projects, ...thread };
}

const findThread = (model: Pick<BoardOrchestrationReadModel, "threads">, threadId: ThreadId) => {
  const thread = model.threads.find((candidate) => candidate.id === threadId);
  return thread === undefined ? null : { deleted: thread.deletedAt !== null };
};

/** `decideBoardCommand` against a full model, the context derived from it. */
export const decideBoardCommandOnModel = (input: {
  readonly command: BoardCommand;
  readonly readModel: BoardOrchestrationReadModel;
  readonly context?: { readonly brief?: string | null };
}) =>
  decideBoardCommand({
    command: input.command,
    readModel: input.readModel,
    context: boardDecisionContextFromModel(input.command, input.readModel, input.context),
  });
