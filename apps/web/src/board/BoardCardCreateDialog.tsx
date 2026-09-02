/**
 * T3o create-card dialog (t3o-06). Title, brief, labels, project, target stage
 * and initial dependencies — everything a card needs to land in one atomic
 * `board.card.create` (the command carries brief and dependsOn, t3o-06). The
 * key is allocated server-side; the UI never invents one.
 *
 * The sheet is the card modal's, one column wide: the same identity row, the
 * same uppercase section headings, the same label field and the same
 * dependency rows (`BoardCardFields`) — a card being created should look like
 * the card it is about to become, not like a form.
 *
 * A card may be created into ANY stage (t3o-15, D10): Mode governs the
 * worktree/slot on entry, so creation and dragging follow an identical path.
 * The picker offers every stage in read-model order, and a warning appears when
 * the chosen stage auto-executes ("creating here starts an agent"). The decider
 * enforces existence + the dependency gate; this is a convenience, not the guard.
 */
import {
  BOARD_CARD_ATTACHMENTS_MAX,
  BOARD_SEED_STAGES,
  BoardCardId,
  BoardLabelId,
  assignBoardKeyPrefix,
  boardStagesInOrder,
  isBoardStageAtOrAfterSubBoardFloor,
  resolveBoardProjectAccent,
  resolveBoardStageExecution,
  type BoardStageDefinition,
  type BoardStageId,
  type BoardState,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { boardColumnAppendOrderKey } from "@t3tools/client-runtime/state/shell";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import { Dialog, DialogFooter, DialogPopup, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { cn, randomUUID } from "../lib/utils";
import { boardEnvironment } from "../state/board";
import { useEnvironment } from "../state/environments";
import { environmentShell } from "../state/shell";
import { usePrimarySettings, useUpdatePrimarySettings } from "../hooks/useSettings";
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
import { BoardLabelField } from "./BoardLabelField";
import { boardStageLabel } from "./boardStages";
import { describeBoardCommandFailure } from "./boardCommandFeedback";
import { projectAccent } from "./projectAccent";

/** A `BoardState` view over a bare stage list, so the read-model stage helpers
    apply. */
function stageStateOf(stages: ReadonlyArray<BoardStageDefinition>): BoardState {
  return { cards: [], stages, nextCardNumberByProject: {} };
}

export interface BoardCreateProject {
  readonly id: ProjectId;
  readonly title: string;
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
  /** Create a child of this parent (t3o-25): the sub-board's dialog presets
      it, which narrows the stage picker to the floor-onward stages a child
      may occupy and the dependency picker to siblings. Null creates an
      ordinary top-level card. */
  readonly subBoardParentId?: BoardCardId | null;
}) {
  const catalogue = useAtomValue(boardEnvironment.labelCatalogueAtom(environmentId));
  const stageList = useAtomValue(boardEnvironment.stageListAtom(environmentId));
  const stages = stageList.length > 0 ? stageList : BOARD_SEED_STAGES;
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const boardSettings = usePrimarySettings((settings) => settings.board);
  const updateSettings = useUpdatePrimarySettings();
  const createCard = useAtomCommand(boardEnvironment.createCard);
  // Attach failures after a successful create are reported in the dialog's
  // own feedback line, not the global toast.
  const attachCardFile = useAtomCommand(boardEnvironment.attachCardFile, { reportFailure: false });
  const createLabel = useAtomCommand(boardEnvironment.createLabel);
  const updateLabel = useAtomCommand(boardEnvironment.updateLabel);
  const deleteLabel = useAtomCommand(boardEnvironment.deleteLabel);
  const undeleteLabel = useAtomCommand(boardEnvironment.undeleteLabel);

  const snapshot = useMemo(() => Option.getOrNull(shellState.snapshot), [shellState.snapshot]);
  const allCards = snapshot?.cards ?? [];

  // Brief attachments (t3o-32, K6): staged as pending uploads while the user
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
  const [stage, setStage] = useState<BoardStageId>(defaultStage);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [labelIds, setLabelIds] = useState<ReadonlyArray<BoardLabelId>>([]);
  const [dependsOn, setDependsOn] = useState<ReadonlyArray<BoardCardId>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Reset the form ONLY on the closed→open transition, honouring the caller's
  // prefilled stage/project (the column button opens onto its own stage). A
  // plain `open`-guarded effect would re-run — and wipe in-progress input —
  // every time a background shell delta gives `projects` a new identity while
  // the dialog is open; the ref pins the reset to the actual open edge.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setProjectId(defaultProjectId ?? projects[0]?.id ?? null);
      setStage(defaultStage);
      setTitle("");
      setBrief("");
      setLabelIds([]);
      setDependsOn([]);
      setFeedback(null);
      setSubmitting(false);
      clearBriefAttachments();
    }
    wasOpen.current = open;
  }, [open, defaultProjectId, defaultStage, projects, clearBriefAttachments]);

  // Dependencies stay inside one project, so the picker only offers cards from
  // the project this card is being created in. A child's picker is narrower
  // still (t3o-25): siblings only — the decider refuses anything else — while
  // a top-level card's options badge any child with its parent's key.
  const dependencyOptions = useMemo(() => {
    const keyById = new Map(allCards.map((card) => [String(card.cardId), card.key]));
    return allCards
      .filter(
        (card) =>
          card.projectId === projectId &&
          !dependsOn.includes(card.cardId as BoardCardId) &&
          (subBoardParentId === null || card.parentCardId === subBoardParentId),
      )
      .map((card) => ({
        id: card.cardId,
        key: card.key,
        title: card.title,
        ...(subBoardParentId === null && card.parentCardId !== undefined
          ? { parentKey: keyById.get(String(card.parentCardId)) }
          : {}),
      }));
  }, [allCards, dependsOn, projectId, subBoardParentId]);

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

  // The stages a card may be created into: every stage (D10) for a top-level
  // card, the materialisation floor onward for a sub-board child (t3o-25) —
  // the same subset the decider lets a child occupy.
  const stageOptions = useMemo(() => {
    const stageState = stageStateOf(stages);
    const ordered = boardStagesInOrder(stageState);
    return subBoardParentId === null
      ? ordered
      : ordered.filter((definition) =>
          isBoardStageAtOrAfterSubBoardFloor(stageState, definition.stageId),
        );
  }, [stages, subBoardParentId]);

  // Like the composer's send button: every upload must have landed, and a
  // failed one must be retried or removed, before the card can be created.
  const canSubmit =
    title.trim().length > 0 &&
    projectId !== null &&
    !submitting &&
    !briefAttachments.busy &&
    !briefAttachments.failed;

  const submit = () => {
    if (projectId === null) return;
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) return;
    const trimmedBrief = brief.trim();
    setSubmitting(true);
    const targetColumn = allCards.filter(
      (card) => card.projectId === projectId && card.stage === stage,
    );
    // Card keys carry the project's prefix. A project that has never been given
    // one is assigned an acronym from its name here, on its first card, and the
    // choice is persisted immediately — every later card reads the stored
    // prefix, so a rename (or a differently-derived acronym) can never split a
    // project's keys across two namespaces.
    const { prefix, assigned } = assignBoardKeyPrefix({
      board: boardSettings,
      projectId,
      projectTitle: projects.find((project) => project.id === projectId)?.title ?? "",
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
    const uploads = briefAttachments.staged.flatMap((row) =>
      row.status === "uploaded" && row.upload !== null ? [row.upload] : [],
    );
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
        // The child preset (t3o-25): a card created inside a drill-in is that
        // parent's child, exactly as if a plan had materialised it.
        ...(subBoardParentId === null ? {} : { parentCardId: subBoardParentId }),
        keyPrefix: prefix,
        orderKey: boardColumnAppendOrderKey(targetColumn),
      },
    }).then(async (result) => {
      if (result._tag === "Failure") {
        setSubmitting(false);
        if (!isAtomCommandInterrupted(result)) setFeedback(describeBoardCommandFailure(result));
        return;
      }
      // The card exists; claim each staged upload onto it (K6). A claim that
      // fails leaves a card without that file — say so rather than pretend.
      const failures: string[] = [];
      for (const upload of uploads) {
        const attached = await attachCardFile({ environmentId, input: { cardId, ...upload } });
        if (attached._tag === "Failure") failures.push(upload.name);
      }
      if (failures.length > 0) {
        setSubmitting(false);
        setFeedback(
          `Card created, but ${failures.join(", ")} could not be attached. Open the card to attach ${
            failures.length === 1 ? "it" : "them"
          } again.`,
        );
        briefAttachments.clear();
        return;
      }
      onOpenChange(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-h-[86vh] w-[min(600px,100%)] max-w-[600px] overflow-hidden p-0">
        {/* Identity row — the card modal's, with the stage the card will land
            in standing where the open card shows the stage it is in. */}
        <div className="flex shrink-0 items-center gap-[9px] px-4 pt-4 pr-11">
          <DialogTitle className="text-[17px]/[1.25] tracking-[-0.01em]">New card</DialogTitle>
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
        {/* A card may be created into any stage (D10); warn when the chosen
            stage auto-executes, since creating there starts an agent. */}
        {resolveBoardStageExecution(boardSettings, stage).autoExecute ? (
          <p className="mx-4 mt-2 rounded-md bg-warning/10 px-2.5 py-1.5 text-[12px] text-warning-foreground">
            {boardStageLabel(stages, stage)} runs automatically — creating here starts an agent.
          </p>
        ) : null}

        <div className="mt-3 flex min-h-0 flex-[0_1_auto] flex-col gap-[18px] overflow-y-auto border-t border-border px-5 pt-4 pb-5">
          {feedback !== null ? (
            <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-[12px] text-destructive-foreground">
              {feedback}
            </p>
          ) : null}

          <div className="min-w-0">
            <BoardSectionHeading className="mb-[7px]">Project</BoardSectionHeading>
            <Select
              items={projects.map((project) => ({
                value: project.id as string,
                label: project.title,
              }))}
              modal={false}
              onValueChange={(value: string | null) => {
                if (value === null || value === projectId) return;
                setProjectId(value as ProjectId);
                // Chosen dependencies belong to the old project, so they can no
                // longer be depended on — drop them rather than submit an
                // out-of-project edge.
                setDependsOn([]);
              }}
              value={projectId ?? ""}
            >
              <SelectTrigger aria-label="Project" size="sm">
                {projectId === null ? null : (
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      projectAccent(projectId, resolveBoardProjectAccent(boardSettings, projectId))
                        .dot,
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
                          projectAccent(
                            project.id,
                            resolveBoardProjectAccent(boardSettings, project.id),
                          ).dot,
                        )}
                      />
                      {project.title}
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>

          {/* Labels — pills for what is chosen, one autocomplete to change it. */}
          <div className="min-w-0">
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
                  prev.includes(labelId) ? prev.filter((id) => id !== labelId) : [...prev, labelId],
                )
              }
              onUndelete={(labelId) => void undeleteLabel({ environmentId, input: { labelId } })}
              selectedLabelIds={labelIds}
            />
          </div>

          <div className="min-w-0">
            <BoardSectionHeading className="mb-[7px]">Title</BoardSectionHeading>
            <Input
              autoFocus
              className="text-[13.5px]"
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSubmit)
                  submit();
              }}
              placeholder="What needs building?"
              value={title}
            />
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
              <Textarea
                className="min-h-24 text-[13.5px]/[1.6]"
                onChange={(event) => setBrief(event.target.value)}
                onPaste={briefAttachments.handlers.onPaste}
                placeholder="What's the context? Paste screenshots (⌘V) or drop files in here."
                unstyled
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
            <BoardDependencySection
              dependencies={dependencies}
              onAdd={(cardId) => setDependsOn((prev) => [...prev, cardId])}
              onRemove={(cardId) => setDependsOn((prev) => prev.filter((id) => id !== cardId))}
              options={dependencyOptions}
              stages={stages}
            />
          </div>
        </div>

        <DialogFooter className="shrink-0 px-5">
          <Button onClick={() => onOpenChange(false)} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={submit} size="sm">
            Create card
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
