/** T3o: the chip for a card mention, and the card row in the `@` menu. */
import type { BoardCardId, ProjectIconColor, ProjectId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { ContextChip, ContextChipLabel } from "~/components/ContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { projectAccent } from "../projectAccent";
import {
  boardCardKeyFromMentionLabel,
  cardIdFromMentionContextId,
  cutBoardCardTitle,
  type BoardCardMentionItem,
} from "./boardCardMentions";
import { useBoardCardMentionSummary } from "./boardCardMentionState";

const CHIP_TITLE_MAX_CHARS = 40;

function BoardCardKeyPill(props: {
  cardKey: string;
  projectId: ProjectId | null;
  accent: ProjectIconColor | null;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center self-center rounded-sm px-1 text-board-10 font-semibold tracking-wide",
        props.projectId === null
          ? "bg-muted text-muted-foreground"
          : projectAccent(props.projectId, props.accent).pill,
      )}
    >
      {props.cardKey}
    </span>
  );
}

export function BoardCardMentionChip(props: {
  cardId: BoardCardId;
  label: string;
  copyMarkdown?: string | undefined;
}) {
  const card = useBoardCardMentionSummary(props.cardId);
  const key = card?.key ?? boardCardKeyFromMentionLabel(props.label);
  const tooltip = card
    ? [card.title, card.stageLabel, card.projectName].filter(Boolean).join(" · ")
    : `${props.label} · not on this board`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="thread"
            {...(card ? {} : { state: "unresolved" as const })}
            render={<Link to="/board" search={{ card: props.cardId }} />}
            aria-label={`Card, ${card ? `${key} ${card.title}` : props.label}`}
            data-markdown-copy={props.copyMarkdown}
            data-board-card-mention={props.cardId}
            className="gap-1 no-underline"
          >
            <BoardCardKeyPill
              cardKey={key}
              projectId={card?.projectId ?? null}
              accent={card?.accent ?? null}
            />
            {card ? (
              <ContextChipLabel>
                {cutBoardCardTitle(card.title, CHIP_TITLE_MAX_CHARS)}
              </ContextChipLabel>
            ) : null}
          </ContextChip>
        }
      />
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/** The card chip for a record-less token, or null for every other kind. */
export function t3oRecordlessChip(props: {
  kind: string;
  contextId: string;
  label: string;
  copyMarkdown?: string | undefined;
}): ReactElement | null {
  if (props.kind !== "card") return null;
  const cardId = cardIdFromMentionContextId(props.contextId);
  if (cardId === null) return null;
  return (
    <BoardCardMentionChip cardId={cardId} label={props.label} copyMarkdown={props.copyMarkdown} />
  );
}

/** The leading pill of a card row in the `@` menu; the title and project ride the row's label slots. */
export function BoardCardMentionMenuRow(props: { item: BoardCardMentionItem }) {
  return (
    <BoardCardKeyPill
      cardKey={props.item.key}
      projectId={props.item.projectId}
      accent={props.item.accent}
    />
  );
}
