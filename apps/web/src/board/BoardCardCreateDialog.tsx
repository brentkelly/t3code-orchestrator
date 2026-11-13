/**
 * The card key is allocated server-side; the UI never invents one. The stage
 * picker's auto-execute warning is a convenience — the decider is the guard.
 */
import {
  BOARD_CARD_ATTACHMENTS_MAX,
  BOARD_SEED_STAGES,
  BoardCardId,
  BoardLabelId,
  assignBoardKeyPrefix,
  boardStagesInOrder,
  resolveBoardStageExecution,
  type BoardCardPriority,
  type BoardCardShell,
  type BoardStageDefinition,
  type BoardStageId,
  type BoardState,
  type BoardWorkerId,
  type EnvironmentId,
  type ProjectIconOverride,
  type ProjectId,
  boardShellAncestorIds,
} from "@t3tools/contracts";
import { boardCardPipelineStages } from "./boardProjectPipelines";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { LayersIcon } from "lucide-react";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import { Dialog, DialogPopup } from "../components/ui/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { cn, randomUUID } from "../lib/utils";
import { boardEnvironment, environmentBoard } from "../state/board";
import { BoardHint } from "./BoardHint";
import { useEnvironment } from "../state/environments";
import { environmentShell } from "../state/shell";
import { setBoardProjectSetting } from "../components/settings/BoardSettingsPanel.logic";
import { useAtomCommand } from "../state/use-atom-command";
import {
  BoardDependencySection,
  BoardSectionHeading,
  type BoardDependencyEntry,
} from "./BoardCardFields";
import {
  BoardBriefAttachRow,
  BoardBriefThumbnailStrip,
  boardBriefDropClass,
  useBoardBriefAttachments,
} from "./BoardBriefAttachments";
import { boardAttachmentLimits } from "./boardAttachmentUpload";
import {
  boardCardDraftHasContent,
  boardCardDraftKey,
  restoreBoardCardDraft,
  type BoardCardDraft,
  type BoardCardDraftAttachment,
} from "./boardCardDraft";
import {
  clearBoardCardDraft,
  flushBoardCardDrafts,
  readBoardCardDraft,
  saveBoardCardDraft,
} from "./boardCardDraftStore";
import { boardCardCreateShortcutLabel, isBoardCardCreateShortcut } from "./boardCardCreateShortcut";
import { BoardBaseBranchSelect } from "./BoardBaseBranchSelect";
import { BoardWorkerPicker } from "./workers/BoardWorkerPicker";
import {
  boardWorkerCheckoutWarning,
  boardWorkerFieldLabel,
  boardWorkerLabel,
} from "./workers/cardWorker";
import { useBoardWorkerChoices } from "./workers/useBoardWorkerChoices";
import { BoardCardSchedulePopover } from "./BoardCardSchedulePopover";
import { BoardLabelField } from "./BoardLabelField";
import { boardStageLabel } from "./boardStages";
import { describeBoardCommandFailure } from "./boardCommandFeedback";
import { projectAccent, projectIconColorOf } from "./projectAccent";
import { useBoardSettings, useUpdateBoardSettings } from "./useBoardEnvironmentId";
import { BoardInput } from "./ui/BoardInput";
import { BoardBriefEditor } from "./mentions/BoardBriefEditor";
import { BoardCardPrioritySegmented } from "./BoardCardPriority";
import { boardCardPriorityDialogRule, boardCardPriorityFromShortcut } from "./boardCardPriority";
import { isEditableFocused } from "../lib/editableFocus";
import { BoardButton } from "./ui/BoardButton";
import { BoardDialogFooter, BoardDialogTitle } from "./ui/BoardDialog";
import { BoardKbd } from "./ui/BoardKbd";
import { useTabCreatingCard } from "./tabIdentity/creatingCard";

/** A `BoardState` view over a bare stage list, so the read-model stage helpers
    apply. */
const EMPTY_CARDS: ReadonlyArray<BoardCardShell> = [];

function stageStateOf(stages: ReadonlyArray<BoardStageDefinition>): BoardState {
  return { cards: [], stages, nextCardNumberByProject: {} };
}

export interface BoardCreateProject {
  readonly id: ProjectId;
  readonly title: string;
  /** For the project's Board colour (its icon colour). Required so a caller
      cannot drop it and silently fall back to the hash colour. */
  readonly projectIcon: ProjectIconOverride | null | undefined;
}

export function BoardCardCreateDialog({
  environmentId,
  open,
  onOpenChange,
  projects,
  defaultProjectId,
  defaultStage,
  subBoardParentId = null,
}: {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projects: ReadonlyArray<BoardCreateProject>;
  readonly defaultProjectId: ProjectId | null;
  readonly defaultStage: BoardStageId;
  /** Create a child of this parent: the sub-board's dialog presets
      it, which narrows the dependency picker to siblings. Null creates an
      ordinary top-level card. */
  readonly subBoardParentId?: BoardCardId | null;
}) {
  const catalogue = useAtomValue(boardEnvironment.labelCatalogueAtom(environmentId));
  const stageList = useAtomValue(boardEnvironment.stageListAtom(environmentId));
  const allStages = stageList.length > 0 ? stageList : BOARD_SEED_STAGES;
  // The picker offers the chosen project's own pipeline.
  const projectStageConfigs = useAtomValue(boardEnvironment.projectStageConfigsAtom(environmentId));
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const boardSettings = useBoardSettings((settings) => settings.board);
  const updateSettings = useUpdateBoardSettings();
  const createCard = useAtomCommand(boardEnvironment.createCard);
  // Attach failures after a successful create are reported in the dialog's
  // own feedback line, not the global toast.
  const attachCardFile = useAtomCommand(boardEnvironment.attachCardFile, { reportFailure: false });
  const createLabel = useAtomCommand(boardEnvironment.createLabel);
  const updateLabel = useAtomCommand(boardEnvironment.updateLabel);
  const deleteLabel = useAtomCommand(boardEnvironment.deleteLabel);
  const undeleteLabel = useAtomCommand(boardEnvironment.undeleteLabel);

  const snapshot = Option.getOrNull(shellState.snapshot);
  const board = useAtomValue(environmentBoard.snapshotValueAtom(environmentId));
  const allCards = board?.cards ?? EMPTY_CARDS;
  const isChild = subBoardParentId !== null;
  const parentShell =
    subBoardParentId === null
      ? null
      : (allCards.find((card) => card.cardId === subBoardParentId) ?? null);

  // Brief attachments (K6): staged as pending uploads while the user
  // types, claimed onto the card right after `board.card.create` returns.
  const environment = useEnvironment(environmentId);
  const attachmentLimits = boardAttachmentLimits(
    environment?.serverConfig?.environment.capabilities ?? null,
  );
  const briefAttachments = useBoardBriefAttachments({
    environmentId,
    limits: attachmentLimits,
    persistedCount: 0,
    maxAttachments: BOARD_CARD_ATTACHMENTS_MAX,
    onUploaded: () => Promise.resolve("keep" as const),
  });
  const clearBriefAttachments = briefAttachments.clear;

  const initialProjectId = defaultProjectId ?? projects[0]?.id ?? null;
  const [projectId, setProjectId] = useState<ProjectId | null>(initialProjectId);
  const stages =
    projectId === null
      ? allStages
      : boardCardPipelineStages(
          { stages: allStages, projectStageConfigs },
          { stage: "", projectId },
        );
  const projectExecutionConfig =
    projectId === null ? null : (projectStageConfigs[projectId] ?? null);
  // The card's base branch: null follows the chosen project's
  // default, which is what the picker reads until someone changes it.
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  // The worker the card is pinned to; null follows the default.
  // Not part of the stored draft: a pin is a choice about the board as it is
  // now, and a worker can be gone by the time a draft is reopened.
  const [pinnedWorkerId, setPinnedWorkerId] = useState<BoardWorkerId | null>(null);
  const workerField = useBoardWorkerChoices(environmentId, projectId);
  /** The card's scheduled start, null until the clock is touched. */
  const [scheduledStartAt, setScheduledStartAt] = useState<string | null>(null);
  const [priority, setPriority] = useState<BoardCardPriority>("normal");
  const [stage, setStage] = useState<BoardStageId>(defaultStage);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [labelIds, setLabelIds] = useState<ReadonlyArray<BoardLabelId>>([]);
  const [dependsOn, setDependsOn] = useState<ReadonlyArray<BoardCardId>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  useTabCreatingCard(open ? { environmentId, projectId, title } : null);

  // Dependencies may cross projects: `dependsOn` stores card ids
  // and the decider has never enforced a same-project rule, so a card that
  // changes project inherits cross-project edges — a state the picker should be
  // able to create too. Foreign options carry their project's dot.
  const projectTitleById = new Map(projects.map((project) => [String(project.id), project.title]));
  // Every project, hidden ones included, so a foreign card keeps its colour.
  const projectById = new Map(
    (snapshot?.projects ?? []).map((project) => [String(project.id), project]),
  );
  // Dependencies cross groups; only the new card's own ancestry is
  // refused, so its group and that group's ancestors are not offered.
  const ancestors = boardShellAncestorIds(allCards, subBoardParentId ?? null);
  const dependencyOptions = allCards
    .filter(
      (card) =>
        !dependsOn.includes(card.cardId as BoardCardId) && !ancestors.has(String(card.cardId)),
    )
    .map((card) => ({
      id: card.cardId,
      key: card.key,
      title: card.title,
      ...(card.projectId === projectId
        ? {}
        : {
            project: {
              id: card.projectId,
              title: projectTitleById.get(String(card.projectId)) ?? "Another project",
              accent: projectIconColorOf(projectById.get(String(card.projectId))),
            },
          }),
    }));

  /** The chosen dependencies as the card modal's rows — same shape, same
      renderer, so an unresolvable id reads the same in both sheets. */
  const dependencies: ReadonlyArray<BoardDependencyEntry> = dependsOn.map((id) => {
    const card = allCards.find((candidate) => candidate.cardId === id);
    return {
      cardId: id,
      key: card?.key ?? id,
      title: card?.title ?? null,
      stage: card?.stage ?? stages[0]!.stageId,
      known: card !== undefined,
      // The picker only ever offers live cards, so a dependency chosen here
      // cannot be archived.
      archived: false,
    };
  });

  // The chosen project's checkout — where the base branch's refs live.
  // Null when the project is not on this server, which disables the picker
  // rather than querying refs of nothing.
  const workspaceRoot =
    snapshot?.projects.find((project) => project.id === projectId)?.workspaceRoot ?? null;

  const selectedProject = projects.find((project) => project.id === projectId);

  // Every stage, top-level or sub-board.
  const stageOptions = boardStagesInOrder(stageStateOf(stages));

  // Writes through the store's plain functions rather than a hook: it saves on
  // every keystroke and must not re-render itself for its own writes.
  const draftKey = boardCardDraftKey(environmentId, subBoardParentId);
  const [restored, setRestored] = useState<{ readonly droppedAttachments: boolean } | null>(null);
  // Set once the stored draft is gone for good — a card was created from
  // these fields, or they were discarded. The autosave must not write them
  // back as a fresh draft, and the footer must stop offering to keep one.
  // State, not a ref: the footer renders from it.
  const [draftSuppressed, setDraftSuppressed] = useState(false);
  // The autosave runs one commit behind the open edge, when the restored (or
  // reset) fields have not landed yet. Saving there would write the previous
  // dialog's state under this key; skip exactly that pass.
  const skipNextSave = useRef(false);
  // Which scope the staged rows were attached for. The dialog stays mounted
  // while the board navigates in and out of a sub-board, so without this the
  // files staged on a child card would follow you to the root board's next
  // card.
  const stagedScopeKey = useRef<string | null>(null);
  const hydrateBriefAttachments = briefAttachments.hydrate;

  /** Every field back to what the dialog opens with. */
  const resetFields = () => {
    setProjectId(defaultProjectId ?? projects[0]?.id ?? null);
    setBaseBranch(null);
    setPinnedWorkerId(null);
    setScheduledStartAt(null);
    setPriority("normal");
    setStage(defaultStage);
    setTitle("");
    setBrief("");
    setLabelIds([]);
    setDependsOn([]);
  };

  /** The staged rows that are safe to persist: an upload that has landed is a
      server-side pending attachment the next session can claim. Rows still in
      flight are this session's only. */
  const attachmentRefs: ReadonlyArray<BoardCardDraftAttachment> = briefAttachments.staged.flatMap(
    (row) =>
      row.status === "uploaded" && row.upload !== null && row.uploadedAt !== null
        ? [{ ...row.upload, uploadedAt: row.uploadedAt }]
        : [],
  );

  const draftFields: BoardCardDraft = {
    title,
    brief,
    stage,
    projectId,
    baseBranch,
    labelIds,
    dependsOn,
    scheduledStartAt,
    priority,
    attachments: attachmentRefs,
  };
  const draftHasContent = boardCardDraftHasContent(draftFields);

  // Restore or reset ONLY on the closed→open edge: a plain `open`-guarded effect
  // would re-run, wiping in-progress input, whenever `projects` gets a new identity.
  const wasOpen = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores the localStorage draft and the staged uploads' blob URLs on the dialog's open edge
  useEffect(() => {
    if (open && !wasOpen.current) {
      setFeedback(null);
      setSubmitting(false);
      setDraftSuppressed(false);
      skipNextSave.current = true;
      if (stagedScopeKey.current !== null && stagedScopeKey.current !== draftKey) {
        // `release: false`: those pending ids are still referenced by the
        // other scope's stored draft, which will offer them back.
        clearBriefAttachments({ release: false });
      }
      stagedScopeKey.current = draftKey;
      const draft = readBoardCardDraft(draftKey);
      if (draft === null) {
        // oxlint-disable-next-line react/set-state-in-effect -- opening the dialog with no stored draft clears the previous session's fields.
        resetFields();
        setRestored(null);
      } else {
        const restoration = restoreBoardCardDraft({
          draft,
          now: Date.now(),
          cards: allCards,
          projectIds: projects.map((project) => project.id),
          labels: catalogue,
          stageOptions,
          subBoardParentId,
          fallbackProjectId: defaultProjectId ?? projects[0]?.id ?? null,
          openedStage: defaultStage,
          maxAttachments: BOARD_CARD_ATTACHMENTS_MAX,
        });
        const fields = restoration.fields;
        setProjectId(fields.projectId);
        setBaseBranch(fields.baseBranch);
        setPinnedWorkerId(null);
        setScheduledStartAt(fields.scheduledStartAt);
        setPriority(fields.priority);
        setStage(fields.stage);
        setTitle(fields.title);
        setBrief(fields.brief);
        setLabelIds(fields.labelIds);
        setDependsOn(fields.dependsOn);
        setRestored({ droppedAttachments: restoration.droppedAttachments });
        // Two tiers: rows still in memory are this session's and keep their
        // real bytes, live previews and in-flight uploads — `hydrate` leaves
        // them alone. Across a reload there are none, and the draft's
        // references become uploaded rows with no local bytes.
        hydrateBriefAttachments(fields.attachments);
      }
    }
    wasOpen.current = open;
    // `open` alone on purpose: everything the branch reads (the snapshot's
    // cards, the projects, the catalogue, the stored draft) is read ONCE, as
    // the dialog opens. Listing them would re-run the restore mid-edit every
    // time a background delta gave one a new identity.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- restores once per open edge; deltas must not re-run it mid-edit.
  }, [open]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- autosaves the open dialog's fields to the localStorage draft store
  useEffect(() => {
    if (!open) return;
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }
    if (draftSuppressed) return;
    saveBoardCardDraft(draftKey, draftFields);
  }, [draftFields, draftKey, draftSuppressed, open]);

  // Closing, or going away entirely, is a save point: land the debounced
  // write rather than trust the page to still be here in 0.7s.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- flushes the debounced localStorage draft write on unmount
  useEffect(
    () => () => {
      flushBoardCardDrafts();
    },
    [],
  );

  const handleOpenChange = (next: boolean) => {
    if (!next) flushBoardCardDrafts();
    onOpenChange(next);
  };

  /** The one destructive path: drop the stored draft and everything staged,
      then close. X, Esc and the backdrop all keep the draft instead. */
  const discardDraft = () => {
    setDraftSuppressed(true);
    clearBoardCardDraft(draftKey);
    clearBriefAttachments();
    setRestored(null);
    onOpenChange(false);
  };

  /** The restore banner's escape: same clearing, but the dialog stays open on
      an empty form. */
  const startFresh = () => {
    clearBoardCardDraft(draftKey);
    clearBriefAttachments();
    resetFields();
    setRestored(null);
  };

  // Like the composer's send button: every upload must have landed, and a
  // failed one must be retried or removed, before the card can be created.
  const canSubmit =
    title.trim().length > 0 &&
    projectId !== null &&
    !submitting &&
    !briefAttachments.busy &&
    !briefAttachments.failed;

  const submitShortcutLabel = boardCardCreateShortcutLabel();

  const submit = () => {
    if (projectId === null) return;
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) return;
    const trimmedBrief = brief.trim();
    setSubmitting(true);
    // A project's key prefix is persisted on its first card, so a later rename can
    // never split its keys across two namespaces.
    const { prefix, assigned } = assignBoardKeyPrefix({
      board: boardSettings,
      projectId,
      projectTitle: selectedProject?.title ?? "",
    });
    if (assigned) {
      updateSettings({
        board: {
          projects: setBoardProjectSetting(boardSettings.projects, projectId, {
            keyPrefix: prefix,
          }),
        },
      });
    }
    const cardId = BoardCardId.make(randomUUID());
    const uploads = attachmentRefs;
    void createCard({
      environmentId,
      input: {
        cardId,
        projectId,
        title: trimmedTitle,
        stage,
        labels: labelIds,
        dependsOn,
        ...(trimmedBrief.length === 0 ? {} : { brief: trimmedBrief }),
        // Absent when the picker was never moved off the project default:
        // "no opinion" and "pinned to whatever main is
        // called today" must not collapse into the same stored value.
        ...(baseBranch === null ? {} : { baseBranch }),
        // The worker pin: absent follows the default — and a child
        // created here then copies its parent's pin.
        ...(pinnedWorkerId === null ? {} : { pinnedWorkerId }),
        // The scheduled start. Absent when the clock was never
        // touched, which is nearly every card — and the reason the field is
        // key-optional on the command rather than a nullable one.
        ...(scheduledStartAt === null ? {} : { scheduledStartAt }),
        ...(priority === "normal" ? {} : { priority }),
        // The child preset: a card created inside a drill-in is that
        // parent's child, exactly as if a plan had materialised it.
        ...(subBoardParentId === null ? {} : { parentCardId: subBoardParentId }),
        keyPrefix: prefix,
        // No `orderKey`: the server places the card at the bottom of the
        // stage's column. This dialog only ever saw the column its
        // board scope renders, so its idea of "bottom" was the bottom of one
        // project — which put a new card above older cards of every other.
      },
    }).then(async (result) => {
      if (result._tag === "Failure") {
        setSubmitting(false);
        if (!isAtomCommandInterrupted(result)) setFeedback(describeBoardCommandFailure(result));
        return;
      }
      // The card exists, so the draft has served its purpose. Drop
      // it before the claims below, which can only fail per-file — a retry of
      // Create is not on the table once the card is there.
      setDraftSuppressed(true);
      clearBoardCardDraft(draftKey);
      setRestored(null);
      // The card exists; claim each staged upload onto it (K6). A claim that
      // fails leaves a card without that file — say so rather than pretend.
      const failures: string[] = [];
      // `uploadedAt` is the draft's own bookkeeping: the claim takes the
      // server's fields and nothing else.
      for (const { uploadedAt: _uploadedAt, ...upload } of uploads) {
        const attached = await attachCardFile({ environmentId, input: { cardId, ...upload } });
        if (attached._tag === "Failure") failures.push(upload.name);
      }
      if (failures.length > 0) {
        // The card exists, so Create must not re-arm — a second click would
        // make a duplicate. `submitting` stays true (Create disabled); the
        // message says what to do and Cancel closes the dialog.
        setFeedback(
          `Card created, but ${failures.join(", ")} could not be attached. Open the card to attach ${
            failures.length === 1 ? "it" : "them"
          } again.`,
        );
        // `release: false`: these ids belong to the card now, and releasing
        // them would delete the files it just claimed.
        briefAttachments.clear({ release: false });
        return;
      }
      briefAttachments.clear({ release: false });
      onOpenChange(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* Nested popups (stage, project, schedule) portal out of this subtree, so
          their own Enter handling is untouched by Mod+Enter here. */}
      <DialogPopup
        className="max-h-[86vh] w-[min(600px,100%)] max-w-[600px] overflow-hidden"
        onKeyDown={(event) => {
          const pickedPriority = boardCardPriorityFromShortcut({
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            code: event.code,
            key: event.key,
            editable: isEditableFocused(event.target),
          });
          if (pickedPriority !== null) {
            event.preventDefault();
            setPriority(pickedPriority);
            return;
          }
          if (
            !isBoardCardCreateShortcut({
              altKey: event.altKey,
              ctrlKey: event.ctrlKey,
              isComposing: event.nativeEvent.isComposing,
              key: event.key,
              metaKey: event.metaKey,
              shiftKey: event.shiftKey,
            })
          )
            return;
          if (!canSubmit) return;
          event.preventDefault();
          submit();
        }}
      >
        {/* Identity row — the card modal's, with the stage the card will land
            in standing where the open card shows the stage it is in. */}
        <div className="flex shrink-0 items-center gap-2.25 px-4 pt-4 pr-11">
          <BoardDialogTitle className="shrink-0" look="create">
            {isChild ? "New child card" : "New card"}
          </BoardDialogTitle>
          {parentShell === null ? null : (
            // The card modal's "Part of" chip, inert here: the dialog sits on
            // the parent's sub-board already.
            <BoardHint label={`Created on ${parentShell.key}'s sub-board`}>
              <span
                // Focusable so the hint is reachable by keyboard, not hover only.
                tabIndex={0}
                className="inline-flex h-[18px] min-w-0 items-center gap-1 rounded-md bg-muted-foreground/14 px-1.75 text-board-11 font-medium text-foreground"
              >
                <LayersIcon className="size-2.5 shrink-0" />
                <span className="shrink-0">{parentShell.key}</span>
                <span className="shrink-0 text-muted-foreground">·</span>
                <span className="max-w-[220px] truncate">{parentShell.title}</span>
              </span>
            </BoardHint>
          )}
          <Select
            items={stageOptions.map((definition) => ({
              value: definition.stageId as string,
              label: definition.label,
            }))}
            modal={false}
            onValueChange={(value: string | null) => {
              if (value !== null) setStage(value as BoardStageId);
            }}
            value={stage}
          >
            <SelectTrigger aria-label="Target stage" className="w-auto min-w-0" size="xs">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {stageOptions.map((definition) => (
                <SelectItem key={definition.stageId} value={definition.stageId}>
                  {definition.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <span className="flex-1" />
        </div>
        {/* A card may be created into any stage; warn when the chosen
            stage auto-executes, since creating there starts an agent. */}
        {resolveBoardStageExecution(boardSettings, stage, projectExecutionConfig).autoExecute ? (
          <p className="mx-4 mt-2 rounded-md bg-warning/10 px-2.5 py-1.5 text-board-12 text-warning-foreground">
            {boardStageLabel(stages, stage)} runs automatically: creating here starts an agent.
          </p>
        ) : null}

        <div className="mt-3 flex min-h-0 flex-[0_1_auto] flex-col gap-4.5 overflow-y-auto border-t border-border px-5 pt-4 pb-5">
          {/* Restored-draft banner. Neutral, never blue: the status
              vocabulary reserves `--info` for "running"
              (docs/t3o/status-colours.md), and a draft is not work in
              progress. */}
          {restored !== null ? (
            <div className="flex items-center gap-3 rounded-md bg-accent px-2.5 py-2">
              <p className="min-w-0 flex-1 text-board-12 text-muted-foreground">
                Unsaved draft restored.
                {restored.droppedAttachments ? " Some attachments expired and were removed." : null}
              </p>
              <Button onClick={startFresh} size="xs" variant="outline">
                Start fresh
              </Button>
            </div>
          ) : null}

          {feedback !== null ? (
            <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-board-12 text-destructive-foreground">
              {feedback}
            </p>
          ) : null}

          {/* A sub-board child shows both read-only: it inherits the parent's
              project and integration branch. */}
          <div className="flex min-w-0 items-start gap-3">
            <div className="min-w-0 flex-1">
              <BoardSectionHeading className="mb-[7px]">Project</BoardSectionHeading>
              {isChild ? (
                <div className="flex h-8 min-w-0 items-center gap-1.5 text-board-13 text-foreground">
                  {projectId === null ? null : (
                    <span
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        projectAccent(projectId, projectIconColorOf(selectedProject)).dot,
                      )}
                    />
                  )}
                  <span className="truncate">{selectedProject?.title ?? "Project"}</span>
                </div>
              ) : (
                <Select
                  items={projects.map((project) => ({
                    value: project.id as string,
                    label: project.title,
                  }))}
                  modal={false}
                  onValueChange={(value: string | null) => {
                    if (value === null || value === projectId) return;
                    setProjectId(value as ProjectId);
                    // Dependencies are kept (cross-project edges are legal), but a
                    // base branch from the old project's checkout means nothing here.
                    setBaseBranch(null);
                    // So does the worker pin: a worker chosen for the
                    // old project may have no checkout of the new one.
                    setPinnedWorkerId(null);
                  }}
                  value={projectId ?? ""}
                >
                  <SelectTrigger aria-label="Project" size="sm">
                    {projectId === null ? null : (
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          projectAccent(projectId, projectIconColorOf(selectedProject)).dot,
                        )}
                      />
                    )}
                    <SelectValue placeholder="Project" />
                  </SelectTrigger>
                  <SelectPopup>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className={cn(
                              "size-2 rounded-full",
                              projectAccent(project.id, projectIconColorOf(project)).dot,
                            )}
                          />
                          {project.title}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              )}
            </div>

            {isChild ? (
              <div className="min-w-0 flex-1">
                <BoardSectionHeading className="mb-[7px]">Base branch</BoardSectionHeading>
                <p className="flex h-8 items-center text-board-13 text-muted-foreground">
                  {parentShell === null ? "From its parent" : `From ${parentShell.key}`}
                </p>
              </div>
            ) : (
              <div className="min-w-0 flex-1">
                <BoardSectionHeading className="mb-[7px]">
                  Base branch{" "}
                  <span className="font-normal text-muted-foreground normal-case">
                    work branches off this
                  </span>
                </BoardSectionHeading>
                <BoardBaseBranchSelect
                  baseBranch={baseBranch}
                  className="h-8 w-full"
                  environmentId={environmentId}
                  onSelect={(next) => setBaseBranch(next)}
                  workspaceRoot={workspaceRoot}
                />
              </div>
            )}

            {workerField.shown ? (
              // Where the card runs (prototype 4.1). Only once a second
              // worker exists.
              <div className="min-w-0 flex-1">
                <BoardSectionHeading className="mb-[7px]">
                  Worker{" "}
                  <span className="font-normal text-muted-foreground normal-case">
                    where this card runs
                  </span>
                </BoardSectionHeading>
                <BoardWorkerPicker
                  choices={workerField.choices}
                  className="h-8 w-full"
                  followLabel={`Follow default (${boardWorkerLabel(workerField.workers.defaultWorkerId, workerField.workers)})`}
                  onSelect={setPinnedWorkerId}
                  onSetUp={workerField.setUp}
                  pinnedWorkerId={pinnedWorkerId}
                  value={boardWorkerFieldLabel(pinnedWorkerId, workerField.workers)}
                />
              </div>
            ) : null}
          </div>
          {workerField.shown
            ? (() => {
                const warning = boardWorkerCheckoutWarning({
                  state: workerField.workers,
                  pinnedWorkerId,
                  projectRepositoryKey: workerField.projectRepositoryKey,
                  projectName: workerField.projectName,
                });
                return warning === null ? null : (
                  <p className="-mt-2 text-board-12 text-warning-foreground">{warning}</p>
                );
              })()
            : null}

          {/* Title and Label share a row. Title comes FIRST and holds
              autofocus: the label control used to be the dialog's first text
              box, so a typed title landed in a label search that matched
              nothing and threw the text away. */}
          <div className="flex min-w-0 items-start gap-2.5">
            <div className="min-w-0 flex-[1.5]">
              <BoardSectionHeading className="mb-[7px]">Title</BoardSectionHeading>
              <BoardInput
                autoFocus
                look="title"
                onChange={(event) => setTitle(event.target.value)}
                placeholder="What needs building?"
                value={title}
              />
            </div>

            <div className="min-w-0 flex-1">
              <BoardSectionHeading className="mb-[7px]">Label</BoardSectionHeading>
              <BoardLabelField
                catalogue={catalogue}
                onCreate={(name) => {
                  const labelId = BoardLabelId.make(randomUUID());
                  void createLabel({ environmentId, input: { labelId, name } });
                  setLabelIds((prev) => [...prev, labelId]);
                }}
                onDelete={(labelId) => void deleteLabel({ environmentId, input: { labelId } })}
                onRecolour={(labelId, colour) =>
                  void updateLabel({ environmentId, input: { labelId, colour } })
                }
                onToggle={(labelId) =>
                  setLabelIds((prev) =>
                    prev.includes(labelId)
                      ? prev.filter((id) => id !== labelId)
                      : [...prev, labelId],
                  )
                }
                onUndelete={(labelId) => void undeleteLabel({ environmentId, input: { labelId } })}
                selectedLabelIds={labelIds}
              />
            </div>
          </div>

          <div className="min-w-0">
            <BoardSectionHeading className="mb-[7px]">Brief</BoardSectionHeading>
            {/* The brief is a container (K9): pasted screenshots land as
                thumbnails on top, the text below; files drop here or on the
                attach row underneath. Same control the card modal's brief
                opens into, so the text reads identically once the card exists. */}
            <div
              className={cn(
                "flex flex-col overflow-hidden rounded-lg border border-input bg-background shadow-xs/5 transition-colors",
                briefAttachments.dropZone === "brief" && boardBriefDropClass(true),
              )}
              onDragLeave={briefAttachments.handlers.onDragLeave}
              onDragOver={briefAttachments.handlers.onBriefDragOver}
              onDrop={briefAttachments.handlers.onDrop}
            >
              <BoardBriefThumbnailStrip
                attachments={[]}
                cardId={null}
                className="px-3 pt-2.5"
                editable
                environmentId={environmentId}
                onDetach={null}
                state={briefAttachments}
              />
              <BoardBriefEditor
                ariaLabel="Brief"
                className="px-3 py-2 text-board-13-5 leading-board-1-6"
                environmentId={environmentId}
                onChange={setBrief}
                onEscape={() => false}
                onModEnter={() => {
                  if (canSubmit) submit();
                }}
                onPaste={briefAttachments.handlers.onPaste}
                placeholder="What's the context? Paste screenshots (⌘V) or drop files in here."
                projectId={projectId}
                value={brief}
              />
            </div>
            <BoardBriefAttachRow
              attachments={[]}
              cardId={null}
              editable
              environmentId={environmentId}
              onDetach={null}
              state={briefAttachments}
            />
          </div>

          <div className="min-w-0">
            <BoardSectionHeading className="mb-2">Priority</BoardSectionHeading>
            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
              <BoardCardPrioritySegmented onChange={setPriority} value={priority} />
              <span className="min-w-40 flex-1 text-board-11-5 leading-normal text-pretty text-muted-foreground">
                {boardCardPriorityDialogRule(priority)}
              </span>
            </div>
          </div>

          <div className="min-w-0">
            <BoardDependencySection
              dependencies={dependencies}
              onAdd={(cardId) => setDependsOn((prev) => [...prev, cardId])}
              onRemove={(cardId) => setDependsOn((prev) => prev.filter((id) => id !== cardId))}
              options={dependencyOptions}
              stages={stages}
            />
          </div>
        </div>

        <BoardDialogFooter className="shrink-0">
          {/* Left of Cancel, and a bare clock until a time is set: the brief
              asks for this to be largely hidden, and it is one of the few
              things on a new card that almost nobody sets. */}
          <BoardCardSchedulePopover
            className="sm:mr-auto"
            kind="before-build"
            onChange={setScheduledStartAt}
            scheduledStartAt={scheduledStartAt}
            stageLabel="the build"
          />
          {/* X, Esc and the backdrop all keep the draft; this footer is the only
              discard path. With no draft left (card created, only attachments
              failed) it reverts to a plain Cancel. */}
          {draftHasContent && !draftSuppressed ? (
            <>
              <span className="text-board-12 text-muted-foreground max-sm:sr-only">
                Closing keeps this draft
              </span>
              <BoardButton look="discard" onClick={discardDraft} size="sm" variant="outline">
                Discard draft
              </BoardButton>
            </>
          ) : (
            <Button onClick={() => handleOpenChange(false)} size="sm" variant="ghost">
              Cancel
            </Button>
          )}
          {/* The shortcut rides the button rather than a tooltip: it is the
              one place a user is already looking when they wonder how to
              submit without reaching for the mouse. */}
          <Button
            aria-keyshortcuts="Meta+Enter Control+Enter"
            disabled={!canSubmit}
            onClick={submit}
            size="sm"
          >
            Create card
            {/* Nothing to press on a phone, where this dialog is a sheet. */}
            <BoardKbd className="max-sm:hidden">{submitShortcutLabel}</BoardKbd>
          </Button>
        </BoardDialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
