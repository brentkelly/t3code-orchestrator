/**
 * T3o: a brief as prose, with its context tokens drawn as chips. Light on purpose: no editor
 * mounts until the brief is clicked.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { FileTagChipContent } from "~/components/chat/FileTagChip";
import { ModelMentionChip } from "~/components/chat/ModelMentionChip";
import { splitPromptIntoComposerSegments } from "~/composer-editor-mentions";
import { ContextChip } from "~/components/ContextChip";
import { EnvironmentContextChip } from "~/components/EnvironmentContextChip";
import { ThreadContextChip } from "~/components/ThreadContextChip";
import { useTheme } from "~/hooks/useTheme";
import { basenameOfPath, documentChipKindForFileName } from "~/pierre-icons";
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

/** Each segment with its offset in the brief, which keys its chip. */
function segmentsWithOffsets(text: string) {
  let offset = 0;
  return splitPromptIntoComposerSegments(text).map((segment) => {
    const index = offset;
    offset += segment.type === "text" ? segment.text.length : segment.source.length;
    return { segment, index };
  });
}

export function BoardBriefView(props: { brief: string; environmentId: EnvironmentId }) {
  const { resolvedTheme } = useTheme();
  const text = boardBriefDisplayText(props.brief);
  const records = boardBriefContextRecords(text, props.environmentId);
  const parts = segmentsWithOffsets(text).map(({ segment, index }): ReactNode => {
    switch (segment.type) {
      case "text":
        return segment.text;
      case "mention":
        return (
          <ChipSlot key={index}>
            <ContextChip
              kind={documentChipKindForFileName(segment.path) ?? "mention"}
              dir="ltr"
              title={segment.path}
            >
              <FileTagChipContent
                path={segment.path}
                environmentId={props.environmentId}
                label={basenameOfPath(segment.path)}
                theme={resolvedTheme}
              />
            </ContextChip>
          </ChipSlot>
        );
      case "model":
        return (
          <ChipSlot key={index}>
            <ModelMentionChip
              environmentId={props.environmentId}
              instanceId={segment.instanceId}
              model={segment.model}
              source={segment.source}
            />
          </ChipSlot>
        );
      case "context-reference": {
        const cardId =
          segment.kind === "card" ? cardIdFromMentionContextId(segment.contextId) : null;
        const record = records.get(segment.contextId);
        if (cardId !== null) {
          return (
            <ChipSlot key={index}>
              <BoardCardMentionChip cardId={cardId} label={segment.label} />
            </ChipSlot>
          );
        }
        if (record?.kind === "thread") {
          return (
            <ChipSlot key={index}>
              <ThreadContextChip record={record.record} />
            </ChipSlot>
          );
        }
        if (record?.kind === "environment") {
          return (
            <ChipSlot key={index}>
              <EnvironmentContextChip record={record.record} />
            </ChipSlot>
          );
        }
        return segment.label;
      }
      default:
        return segment.source;
    }
  });
  return <span className="whitespace-pre-wrap text-pretty text-foreground">{parts}</span>;
}
