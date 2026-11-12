/**
 * T3o: a card brief edits in the composer editor, so `@` (cards, threads, machines, models,
 * files), `$` skills and `/` provider commands work there too. Plain mode only: rich mode
 * rewrote real briefs (underscores read as emphasis), and a brief must survive an edit byte
 * for byte. Mounted only while editing; view mode is `BoardBriefView`.
 */
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ProviderDriverKind, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { replaceTextRange } from "@t3tools/shared/composerTrigger";
import { type ClipboardEventHandler, useEffect, useId, useRef, useState } from "react";

import {
  ComposerCommandMenu,
  composerSuggestionOptionId,
  type ComposerCommandItem,
} from "~/components/chat/ComposerCommandMenu";
import { resolveComposerMenuActiveItemId } from "~/components/chat/composerMenuHighlight";
import { useComposerMenuItems } from "~/components/chat/useComposerMenuItems";
import {
  ComposerPromptEditorTiptap,
  type ComposerPromptEditorHandle,
} from "~/components/ComposerPromptEditorTiptap";
import {
  ComposerContextActionsContext,
  ComposerContextRecordsContext,
} from "~/components/composerContextPresentation";
import { Popover, PopoverPopup } from "~/components/ui/popover";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { getAppModelOptionsForInstance } from "~/modelSelection";
import { deriveProviderInstanceEntries } from "~/providerInstances";
import { useProject } from "~/state/entities";
import {
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  type ComposerTrigger,
} from "../../composer-logic";
import { useBoardServerProviders, useBoardSettings } from "../useBoardEnvironmentId";
import {
  boardBriefContextRecords,
  boardBriefMenuReplacement,
  mergeBoardBriefProviderCatalog,
  nudgeBoardBriefHighlight,
} from "./boardBriefEditor.logic";
import { BoardCardMentionProjectContext } from "./boardCardMentionProject";

const NO_LINKED_ENVIRONMENTS = new Map<EnvironmentId, string>();
const NOOP = () => {};
// Only names item ids; a brief merges every provider's skills and commands.
const NO_PROVIDER = ProviderDriverKind.make("codex");

export interface BoardBriefEditorProps {
  /** The board server: cards, threads and files are searched there. */
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Cmd/Ctrl+Enter: commit in the card detail, submit in the New card dialog. */
  readonly onModEnter: () => void;
  /** Escape with the menu closed; return true when handled, false to let it bubble. */
  readonly onEscape: () => boolean;
  /** Focus left the editor and its menu. */
  readonly onBlur?: (() => void) | undefined;
  readonly onPaste: ClipboardEventHandler<HTMLElement>;
  readonly placeholder: string;
  readonly ariaLabel: string;
  readonly autoFocus?: boolean | undefined;
  readonly className?: string | undefined;
}

export function BoardBriefEditor(props: BoardBriefEditorProps) {
  return (
    <BoardCardMentionProjectContext value={props.projectId}>
      <BriefEditor {...props} />
    </BoardCardMentionProjectContext>
  );
}

function BriefEditor(props: BoardBriefEditorProps) {
  const { environmentId, projectId, value } = props;
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const { resolvedTheme } = useTheme();
  const [cursor, setCursor] = useState(() => collapseExpandedComposerCursor(value, value.length));
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
  // An Escape or outside press closes the menu until this `@`, `$` or `/` ends or another starts.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [highlight, setHighlight] = useState<{ id: string | null; searchKey: string | null }>({
    id: null,
    searchKey: null,
  });

  const settings = useBoardSettings();
  const providers = useBoardServerProviders();
  const catalog = mergeBoardBriefProviderCatalog(providers);
  const instanceEntries = deriveProviderInstanceEntries(providers).filter((entry) => entry.enabled);
  const modelOptionsByInstance = new Map(
    instanceEntries.map((entry) => [
      entry.instanceId,
      getAppModelOptionsForInstance(settings, entry),
    ]),
  );
  const project = useProject(projectId ? scopeProjectRef(environmentId, projectId) : null);

  const activeTrigger = trigger !== null && trigger.rangeStart !== dismissedAt ? trigger : null;
  const menu = useComposerMenuItems({
    composerTrigger: activeTrigger,
    environmentId,
    linkedEnvironments: NO_LINKED_ENVIRONMENTS,
    gitCwd: project?.workspaceRoot ?? null,
    activeThreadId: null,
    pullRequestProjectId: null,
    pullRequestRepository: null,
    threadPullRequests: undefined,
    sideChatAvailable: false,
    sideChatDisabledReason: null,
    freshSessionAvailable: false,
    compactSlashCommandAvailable: false,
    selectedProvider: catalog.provider ?? NO_PROVIDER,
    selectedProviderSkills: catalog.skills,
    selectedProviderSlashCommands: catalog.slashCommands,
    showSkillsInSlashMenu: true,
    workspaceSkillsScanning: false,
    questionAttachmentTarget: null,
    modelMentions: { instanceEntries, modelOptionsByInstance },
  });
  // `/model` acts on a live thread; every other built-in is already off.
  const items = menu.items.filter(
    (item) => boardBriefMenuReplacement(item, environmentId) !== null,
  );
  const menuOpen = activeTrigger !== null && activeTrigger.kind !== "pull-request";
  const searchKey = activeTrigger
    ? `${activeTrigger.kind}:${activeTrigger.query.trim().toLowerCase()}`
    : null;
  const activeItemId = menuOpen
    ? resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: highlight.id,
        currentSearchKey: searchKey,
        highlightedSearchKey: highlight.searchKey,
      })
    : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the editor once Tiptap has mounted it
  useEffect(() => {
    if (!props.autoFocus) return;
    const frame = window.requestAnimationFrame(() => editorRef.current?.focusAtEnd());
    return () => window.cancelAnimationFrame(frame);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- focus once, on mount
  }, []);

  const select = (item: ComposerCommandItem) => {
    const snapshot = editorRef.current?.readSnapshot();
    if (!snapshot || !activeTrigger) return;
    const live = detectComposerTrigger(snapshot.value, snapshot.expandedCursor);
    if (!live || live.rangeStart !== activeTrigger.rangeStart) return;
    const replacement = boardBriefMenuReplacement(item, environmentId);
    if (replacement === null) return;
    const rangeEnd = snapshot.value[live.rangeEnd] === " " ? live.rangeEnd + 1 : live.rangeEnd;
    const next = replaceTextRange(snapshot.value, live.rangeStart, rangeEnd, replacement);
    const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
    props.onChange(next.text);
    setCursor(nextCursor);
    setTrigger(null);
    setHighlight({ id: null, searchKey: null });
    window.requestAnimationFrame(() => editorRef.current?.focusAt(nextCursor));
  };

  const onCommandKeyDown = (key: string, event: KeyboardEvent): boolean => {
    if (key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
      props.onModEnter();
      return true;
    }
    if (key === "Escape") {
      if (menuOpen) {
        setDismissedAt(activeTrigger.rangeStart);
        return true;
      }
      return props.onEscape();
    }
    if (!menuOpen || items.length === 0) return false;
    if (key === "ArrowDown" || key === "ArrowUp") {
      setHighlight({ id: nudgeBoardBriefHighlight(items, activeItemId, key), searchKey });
      return true;
    }
    const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
    if ((key === "Enter" || key === "Tab") && plain) {
      const item = items.find((candidate) => candidate.id === activeItemId);
      if (!item) return false;
      select(item);
      return true;
    }
    return false;
  };

  const records = boardBriefContextRecords(value, environmentId);
  return (
    <div
      ref={wrapperRef}
      className={cn("min-w-0", props.className)}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node) {
          if (wrapperRef.current?.contains(next) || popupRef.current?.contains(next)) return;
        }
        props.onBlur?.();
      }}
      // A chip is a link inside the wrapper, so its click never blurs; commit before it navigates.
      onClickCapture={(event) => {
        const target = event.target;
        if (!(target instanceof Element) || popupRef.current?.contains(target)) return;
        if (target.closest("a[href]")) props.onBlur?.();
      }}
    >
      <ComposerContextActionsContext
        value={{
          environmentId,
          cwd: project?.workspaceRoot,
          ...(projectId ? { projectId } : {}),
          expandImage: NOOP,
          expandVideo: NOOP,
          openFile: NOOP,
          openMention: NOOP,
          openPullRequest: NOOP,
        }}
      >
        <ComposerContextRecordsContext value={records}>
          <ComposerPromptEditorTiptap
            ariaLabel={props.ariaLabel}
            editorRef={editorRef}
            value={value}
            cursor={cursor}
            richTextEnabled={false}
            contextRecords={records}
            skills={catalog.skills}
            disabled={false}
            placeholder={props.placeholder}
            suggestionListId={menuOpen ? listId : undefined}
            activeSuggestionId={
              menuOpen && activeItemId
                ? composerSuggestionOptionId(listId, activeItemId)
                : undefined
            }
            className="max-h-none min-h-24"
            onChange={(nextValue, nextCursor, expandedCursor, cursorAdjacentToMention) => {
              props.onChange(nextValue);
              setCursor(nextCursor);
              const next = cursorAdjacentToMention
                ? null
                : detectComposerTrigger(nextValue, expandedCursor);
              setTrigger(next);
              if (next === null || next.rangeStart !== dismissedAt) setDismissedAt(null);
            }}
            onCommandKeyDown={onCommandKeyDown}
            onPaste={props.onPaste}
          />
        </ComposerContextRecordsContext>
      </ComposerContextActionsContext>
      <Popover
        open={menuOpen}
        modal={false}
        onOpenChange={(open, details) => {
          if (open || !activeTrigger) return;
          if (
            details.event?.target instanceof Node &&
            wrapperRef.current?.contains(details.event.target)
          ) {
            return;
          }
          setDismissedAt(activeTrigger.rangeStart);
        }}
      >
        <PopoverPopup
          ref={popupRef}
          anchor={wrapperRef}
          side="bottom"
          align="start"
          padding="none"
          className="w-(--anchor-width) min-w-72"
          initialFocus={false}
          finalFocus={false}
        >
          <ComposerCommandMenu
            listId={listId}
            items={items}
            resolvedTheme={resolvedTheme}
            isLoading={menu.isLoading}
            triggerKind={activeTrigger?.kind ?? null}
            emptyStateText={menu.emptyState}
            activeItemId={activeItemId}
            onHighlightedItemChange={(id) => setHighlight({ id, searchKey })}
            onSelect={select}
          />
        </PopoverPopup>
      </Popover>
    </div>
  );
}
