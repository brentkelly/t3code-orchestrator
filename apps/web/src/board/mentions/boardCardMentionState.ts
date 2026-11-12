/**
 * T3o: board reads behind card mentions. Board pushes are frequent, so composers read the board
 * only while an `@` menu is open, and each chip reads one card's stable summary.
 */
import { useAtomValue } from "@effect/atom-react";
import type {
  BoardCardId,
  EnvironmentId,
  OrchestrationProjectShell,
  ProjectIconColor,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Option } from "effect";
import { Atom } from "effect/reactivity";
import { useContext } from "react";

import { boardEnvironment } from "~/state/board";
import { useThreadShell } from "~/state/entities";
import { environmentShell } from "~/state/shell";
import { projectIconColorOf } from "../projectAccent";
import { useBoardEnvironmentId } from "../useBoardEnvironmentId";
import { BoardCardMentionProjectContext } from "./boardCardMentionProject";
import {
  matchBoardCardMentions,
  type BoardCardMentionCandidate,
  type BoardCardMentionItem,
} from "./boardCardMentions";

export interface BoardCardMentionSummary {
  readonly key: string;
  readonly title: string;
  readonly projectId: ProjectId;
  readonly projectName: string | null;
  readonly accent: ProjectIconColor | null;
  readonly stageLabel: string | null;
}

interface MentionCandidate extends BoardCardMentionCandidate {
  readonly projectName: string;
  readonly accent: ProjectIconColor | null;
}

const EMPTY_CANDIDATES: ReadonlyArray<MentionCandidate> = [];
const emptyCandidatesAtom = Atom.make<ReadonlyArray<MentionCandidate>>(EMPTY_CANDIDATES);
const emptySummaryAtom = Atom.make<BoardCardMentionSummary | null>(null);

function projectsOf(
  get: Atom.AtomContext,
  environmentId: EnvironmentId,
): ReadonlyArray<OrchestrationProjectShell> {
  const shell = get(environmentShell.stateValueAtom(environmentId));
  return Option.match(shell.snapshot, {
    onNone: () => [],
    onSome: (snapshot) => snapshot.projects,
  });
}

const candidatesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<MentionCandidate> => {
    const board = get(boardEnvironment.boardAtom(environmentId));
    if (board === null) return EMPTY_CANDIDATES;
    const projects = new Map(projectsOf(get, environmentId).map((p) => [p.id, p] as const));
    return board.cards.map((card) => {
      const project = projects.get(card.projectId);
      return {
        cardId: card.cardId,
        key: card.key,
        title: card.title,
        projectId: card.projectId,
        projectName: project?.title ?? "",
        accent: projectIconColorOf(project),
      };
    });
  }).pipe(Atom.withLabel(`t3o-card-mention-candidates:${environmentId}`)),
);

function sameSummary(a: BoardCardMentionSummary | null, b: BoardCardMentionSummary | null) {
  if (a === null || b === null) return a === b;
  return (
    a.key === b.key &&
    a.title === b.title &&
    a.projectId === b.projectId &&
    a.projectName === b.projectName &&
    a.accent === b.accent &&
    a.stageLabel === b.stageLabel
  );
}

/** Keyed `${environmentId}\u0000${cardId}`; equal summaries do not notify, so chips skip board pushes. */
const cardSummaryAtom = Atom.family((key: string) => {
  const [environmentId, cardId] = key.split("\u0000") as [EnvironmentId, BoardCardId];
  return Atom.make((get): BoardCardMentionSummary | null => {
    const board = get(boardEnvironment.boardAtom(environmentId));
    const card = board?.cards.find((candidate) => candidate.cardId === cardId);
    if (!board || !card) return null;
    const project = projectsOf(get, environmentId).find((p) => p.id === card.projectId);
    return {
      key: card.key,
      title: card.title,
      projectId: card.projectId,
      projectName: project?.title ?? null,
      accent: projectIconColorOf(project),
      stageLabel: board.stages.find((stage) => stage.stageId === card.stage)?.label ?? null,
    };
  }).pipe(Atom.withEquality(sameSummary), Atom.withLabel(`t3o-card-mention:${cardId}`));
});

/** The live card a mention names, or null when it is not on this device's board. */
export function useBoardCardMentionSummary(cardId: BoardCardId | null) {
  const environmentId = useBoardEnvironmentId();
  return useAtomValue(
    environmentId === null || cardId === null
      ? emptySummaryAtom
      : cardSummaryAtom(`${environmentId}\u0000${cardId}`),
  );
}

/** Card items for an `@` query; reads nothing from the board while `active` is false. */
export function useBoardCardMentionItems(input: {
  readonly active: boolean;
  readonly query: string;
  readonly environmentId: EnvironmentId;
  readonly activeThreadId: ThreadId | null;
}): BoardCardMentionItem[] {
  const boardEnvironmentId = useBoardEnvironmentId();
  const scopeProjectId = useContext(BoardCardMentionProjectContext);
  const live = input.active && boardEnvironmentId !== null;
  const candidates = useAtomValue(live ? candidatesAtom(boardEnvironmentId) : emptyCandidatesAtom);
  // A worker's project ids differ from the board's, so only a board-server thread has a project here.
  const thread = useThreadShell(
    live && input.activeThreadId !== null && input.environmentId === boardEnvironmentId
      ? { environmentId: input.environmentId, threadId: input.activeThreadId }
      : null,
  );
  if (!live) return [];
  return matchBoardCardMentions({
    cards: candidates,
    currentProjectId: thread?.projectId ?? scopeProjectId,
    query: input.query,
  }).map((card) => ({
    id: `card:${card.cardId}`,
    type: "card" as const,
    cardId: card.cardId,
    key: card.key,
    projectId: card.projectId,
    accent: card.accent,
    label: card.title,
    description: card.projectName,
  }));
}
