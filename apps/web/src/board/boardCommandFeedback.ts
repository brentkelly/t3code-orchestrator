/**
 * T3o board command feedback (t3o-06). One place that turns a rejected board
 * command into a human sentence — the decider's invariant rejections carry a
 * `detail` string (the unmet dependency, the cycle-closing edge, the label
 * cap), and that is what the user needs to see, not a generic failure.
 */
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

/** The invariant `detail` when the failure carries one, else the error
    message, else a generic fallback. */
export function describeBoardCommandFailure(result: unknown): string {
  const error: unknown = squashAtomCommandFailure(
    result as Parameters<typeof squashAtomCommandFailure>[0],
  );
  if (
    typeof error === "object" &&
    error !== null &&
    "detail" in error &&
    typeof error.detail === "string"
  ) {
    return error.detail;
  }
  return error instanceof Error ? error.message : "The server rejected the command.";
}
