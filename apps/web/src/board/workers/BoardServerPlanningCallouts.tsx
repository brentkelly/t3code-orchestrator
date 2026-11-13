/**
 * T3o: planning runs on the board server (T3O-87). One callout per project whose cards wait on
 * it: its folder there isn't a checkout (amber, with Clone here when the folder is missing or
 * empty), or a provider isn't signed in there (violet). Nothing shows when no card waits.
 */
import type { BoardCardShell, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { toastManager } from "../../components/ui/toast";
import { boardEnvironment } from "../../state/board";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { describeBoardCommandFailure } from "../boardCommandFeedback";

export interface BoardServerPlanningCallout {
  readonly projectId: ProjectId;
  readonly kind: "server-checkout" | "server-sign-in";
  /** Clone here helps: the folder is missing or empty. */
  readonly missing: boolean;
  readonly provider: string | null;
  readonly waiting: number;
}

/** The callouts for the cards held on the board server, one per project and problem. */
export function boardServerPlanningCallouts(
  cards: ReadonlyArray<Pick<BoardCardShell, "projectId" | "queuedBy" | "queuedDetail">>,
): ReadonlyArray<BoardServerPlanningCallout> {
  const byKey = new Map<string, BoardServerPlanningCallout>();
  for (const card of cards) {
    if (card.queuedBy !== "server-checkout" && card.queuedBy !== "server-sign-in") continue;
    const provider = card.queuedDetail?.providerInstanceId ?? null;
    const key = `${card.projectId}\0${card.queuedBy}\0${provider ?? ""}`;
    const existing = byKey.get(key);
    byKey.set(key, {
      projectId: card.projectId,
      kind: card.queuedBy,
      missing: (existing?.missing ?? false) || card.queuedDetail?.serverCheckout === "missing",
      provider,
      waiting: (existing?.waiting ?? 0) + 1,
    });
  }
  return [...byKey.values()];
}

export function BoardServerPlanningCallouts(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const cardsByProject = useAtomValue(boardEnvironment.cardsByProjectAtom(environmentId));
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const projects = Option.getOrNull(shellState.snapshot)?.projects ?? [];
  const cloneHere = useAtomCommand(boardEnvironment.cloneProjectHere, { reportFailure: false });
  const [cloning, setCloning] = useState<ProjectId | null>(null);
  const cards = [...cardsByProject.values()].flatMap((columns) => Object.values(columns).flat());
  const callouts = boardServerPlanningCallouts(cards);
  if (callouts.length === 0) return null;
  const titleOf = (projectId: ProjectId) =>
    projects.find((project) => project.id === projectId)?.title ?? "This project";
  const runClone = async (projectId: ProjectId) => {
    setCloning(projectId);
    const result = await cloneHere({ environmentId, input: { projectId } });
    setCloning(null);
    if (result._tag !== "Success") {
      toastManager.add({ type: "error", title: describeBoardCommandFailure(result) });
      return;
    }
    toastManager.add({ type: "success", title: `${titleOf(projectId)} was cloned here` });
  };
  return (
    <div className="mx-3 mt-2 flex flex-col gap-2 sm:mx-4">
      {callouts.map((callout) => {
        const project = titleOf(callout.projectId);
        const waiting = `${callout.waiting} card${callout.waiting === 1 ? "" : "s"} waiting`;
        const amber = callout.kind === "server-checkout";
        return (
          <div
            key={`${callout.projectId}:${callout.kind}:${callout.provider ?? ""}`}
            className={
              amber
                ? "flex items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning/8 px-4 py-2.5"
                : "flex items-center justify-between gap-3 rounded-xl border border-attention/30 bg-attention/6 px-4 py-2.5"
            }
          >
            <div className="flex min-w-0 flex-col">
              <span
                className={
                  amber
                    ? "text-board-13 font-medium text-board-amber-text"
                    : "text-board-13 font-medium text-attention-foreground"
                }
              >
                {amber
                  ? `${project}'s folder on the board server isn't a checkout`
                  : `Sign in to ${callout.provider ?? "the provider"} on the board server`}
              </span>
              <span className="text-xs text-muted-foreground">
                {amber
                  ? callout.missing
                    ? `Planning runs here. ${waiting}.`
                    : `Planning runs here, and the folder exists but isn't a checkout. Fix it on the board server. ${waiting}.`
                  : `Planning runs here. Run \`${/claude/i.test(callout.provider ?? "") ? "claude" : "codex"} login\` on the board server. ${waiting}.`}
              </span>
            </div>
            {amber && callout.missing ? (
              <Button
                size="xs"
                variant="outline"
                disabled={cloning !== null}
                onClick={() => void runClone(callout.projectId)}
              >
                {cloning === callout.projectId ? "Cloning…" : "Clone here"}
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
