/**
 * T3o: a brief as prose, with its context tokens drawn as chips. Light on purpose: no editor
 * mounts until the brief is clicked.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import type { ReactNode } from "react";

import { EnvironmentContextChip } from "~/components/EnvironmentContextChip";
import { ThreadContextChip } from "~/components/ThreadContextChip";
import { boardBriefDisplayText } from "../boardBriefDisplay";
import { boardBriefContextRecords } from "./boardBriefEditor.logic";
import { BoardCardMentionChip } from "./BoardCardMentionChip";
import { cardIdFromMentionContextId } from "./boardCardMentions";

/** A chip's own click opens what it names, and never puts the brief into edit mode. */
function ChipSlot(props: { children: ReactNode }) {
  return (
    <span
      className="inline-flex max-w-full align-baseline"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {props.children}
    </span>
  );
}

export function BoardBriefView(props: { brief: string; environmentId: EnvironmentId }) {
  const text = boardBriefDisplayText(props.brief);
  const records = boardBriefContextRecords(text, props.environmentId);
  const parts: ReactNode[] = [];
  let at = 0;
  for (const reference of collectComposerContextReferences(text)) {
    parts.push(text.slice(at, reference.start));
    at = reference.end;
    const record = records.get(reference.contextId);
    const cardId =
      reference.kind === "card" ? cardIdFromMentionContextId(reference.contextId) : null;
    if (cardId !== null) {
      parts.push(
        <ChipSlot key={reference.start}>
          <BoardCardMentionChip cardId={cardId} label={reference.label} />
        </ChipSlot>,
      );
    } else if (record?.kind === "thread") {
      parts.push(
        <ChipSlot key={reference.start}>
          <ThreadContextChip record={record.record} />
        </ChipSlot>,
      );
    } else if (record?.kind === "environment") {
      parts.push(
        <ChipSlot key={reference.start}>
          <EnvironmentContextChip record={record.record} />
        </ChipSlot>,
      );
    } else {
      parts.push(reference.label);
    }
  }
  parts.push(text.slice(at));
  return <span className="whitespace-pre-wrap text-pretty text-foreground">{parts}</span>;
}
