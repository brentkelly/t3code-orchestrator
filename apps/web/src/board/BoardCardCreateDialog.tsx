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
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { BoardBaseBranchSelect } from "./BoardBaseBranchSelect";
import { BoardCardSchedulePopover } from "./BoardCardSchedulePopover";
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
  // The card's base branch (T3O-5, D13): null follows the chosen project's
  // default, which is what the picker reads until someone changes it.
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  /** The card's scheduled start (T3O-19), null until the clock is touched. */
  const [scheduledStartAt, setScheduledStartAt] = useState<string | null>(null);
  const [stage, setStage] = useState<BoardStageId>(defaultStage);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [labelIds, setLabelIds] = useState<ReadonlyArray<BoardLabelId>>([]);
  const [dependsOn, setDependsOn] = useState<ReadonlyArray<BoardCardId>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Dependencies may cross projects (T3O-33, D3): `dependsOn` stores card ids
  // and the decider has never enforced a same-project rule, so a card that
  // changes project inherits cross-project edges — a state the picker should be
  // able to create too. Foreign options carry their project's dot. A child's
  // picker is narrower still (t3o-25): siblings only — the decider refuses
  // anything else — while a top-level card's options badge any child with its
  // parent's key.
  const dependencyOptions = useMemo(() => {
    const keyById = new Map(allCards.map((card) => [String(card.cardId), card.key]));
    const projectTitleById = new Map(
      projects.map((project) => [String(project.id), project.title]),
    );
    return allCards
      .filter(
        (card) =>
          !dependsOn.includes(card.cardId as BoardCardId) &&
          (subBoardParentId === null || card.parentCardId === subBoardParentId),
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
                accent: resolveBoardProjectAccent(boardSettings, card.projectId),
              },
            }),
        ...(subBoardParentId === null && card.parentCardId !== undefined
          ? { parentKey: keyById.get(String(card.parentCardId)) }
          : {}),
      }));
  }, [allCards, boardSettings, dependsOn, projectId, projects, subBoardParentId]);

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
  // The chosen project's checkout — where the base branch's refs live (D11).
  // Null when the project is not on this server, which disables the picker
  // rather than querying refs of nothing.
  const workspaceRoot =
    snapshot?.projects.find((project) => project.id === projectId)?.workspaceRoot ?? null;

  const stageOptions = useMemo(() => {
    const stageState = stageStateOf(stages);
    const ordered = boardStagesInOrder(stageState);
    return subBoardParentId === null
      ? ordered
      : ordered.filter((definition) =>
          isBoardStageAtOrAfterSubBoardFloor(stageState, definition.stageId),
        );
  }, [stages, subBoardParentId]);

  // ── Draft persistence (T3O-26) ──────────────────────────────────────
  // One draft per board scope, autosaved while the dialog is open and offered
  // back the next time it opens. The dialog writes through the store's plain
  // functions rather than a hook: it saves on every keystroke and must not
  // re-render itself for its own writes.
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
  const resetFields = useCallback(() => {
    setProjectId(defaultProjectId ?? projects[0]?.id ?? null);
    setBaseBranch(null);
    setScheduledStartAt(null);
    setStage(defaultStage);
    setTitle("");
    setBrief("");
    setLabelIds([]);
    setDependsOn([]);
  }, [defaultProjectId, defaultStage, projects]);

  /** The staged rows that are safe to persist: an upload that has landed is a
      server-side pending attachment the next session can claim. Rows still in
      flight are this session's only. */
  const attachmentRefs = useMemo<ReadonlyArray<BoardCardDraftAttachment>>(
    () =>
      briefAttachments.staged.flatMap((row) =>
        row.status === "uploaded" && row.upload !== null && row.uploadedAt !== null
          ? [{ ...row.upload, uploadedAt: row.uploadedAt }]
          : [],
      ),
    [briefAttachments.staged],
  );

  const draftFields = useMemo<BoardCardDraft>(
    () => ({
      title,
      brief,
      stage,
      projectId,
      baseBranch,
      labelIds,
      dependsOn,
      scheduledStartAt,
      attachments: attachmentRefs,
    }),
    [
      attachmentRefs,
      baseBranch,
      brief,
      dependsOn,
      labelIds,
      projectId,
      scheduledStartAt,
      stage,
      title,
    ],
  );
  const draftHasContent = boardCardDraftHasContent(draftFields);

  // Restore or reset ONLY on the closed→open transition, honouring the
  // caller's prefilled stage/project (the column button opens onto its own
  // stage). A plain `open`-guarded effect would re-run — and wipe in-progress
  // input — every time a background shell delta gives `projects` a new
  // identity while the dialog is open; the ref pins this to the open edge.
  const wasOpen = useRef(false);
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
        setScheduledStartAt(fields.scheduledStartAt);
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
  }, [open]);

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

  const submit = () => {
    if (projectId === null) return;
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) return;
    const trimmedBrief = brief.trim();
    setSubmitting(true);
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
        // Absent when the picker was never moved off the project default
        // (T3O-5, D12/D16): "no opinion" and "pinned to whatever main is
        // called today" must not collapse into the same stored value.
        ...(baseBranch === null ? {} : { baseBranch }),
        // The scheduled start (T3O-19, D14). Absent when the clock was never
        // touched, which is nearly every card — and the reason the field is
        // key-optional on the command rather than a nullable one.
        ...(scheduledStartAt === null ? {} : { scheduledStartAt }),
        // The child preset (t3o-25): a card created inside a drill-in is that
        // parent's child, exactly as if a plan had materialised it.
        ...(subBoardParentId === null ? {} : { parentCardId: subBoardParentId }),
        keyPrefix: prefix,
        // No `orderKey`: the server places the card at the bottom of the
        // stage's column (T3O-27). This dialog only ever saw the column its
        // board scope renders, so its idea of "bottom" was the bottom of one
        // project — which put a new card above older cards of every other.
      },
    }).then(async (result) => {
      if (result._tag === "Failure") {
        setSubmitting(false);
        if (!isAtomCommandInterrupted(result)) setFeedback(describeBoardCommandFailure(result));
        return;
      }
      // The card exists, so the draft has served its purpose (T3O-26). Drop
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
          {/* Restored-draft banner (T3O-26). Neutral, never blue: the status
              vocabulary reserves `--info` for "running"
              (docs/t3o/status-colours.md), and a draft is not work in
              progress. */}
          {restored !== null ? (
            <div className="flex items-center gap-3 rounded-md bg-accent px-2.5 py-2">
              <p className="min-w-0 flex-1 text-[12px] text-muted-foreground">
                Unsaved draft restored.
                {restored.droppedAttachments ? " Some attachments expired and were removed." : null}
              </p>
              <Button onClick={startFresh} size="xs" variant="outline">
                Start fresh
              </Button>
            </div>
          ) : null}

          {feedback !== null ? (
            <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-[12px] text-destructive-foreground">
              {feedback}
            </p>
          ) : null}

          {/* Project and Base branch share a row (T3O-5, D13): the base is a
              property of the project's checkout, so the two read as one
              decision. A sub-board child never gets here — the drill-in's
              create dialog presets a parent, and a child inherits that
              parent's integration branch (D4). */}
          <div className="flex min-w-0 items-start gap-3">
            <div className="min-w-0 flex-1">
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
                  // Chosen dependencies are KEPT (T3O-33, D3): a cross-project
                  // edge is legal, so switching project no longer silently
                  // discards work the user has already done in this dialog.
                  //
                  // The base branch still resets (T3O-5, D13): a branch named in
                  // the old project's checkout says nothing about the new one,
                  // so it goes back to that project's default.
                  setBaseBranch(null);
                }}
                value={projectId ?? ""}
              >
                <SelectTrigger aria-label="Project" size="sm">
                  {projectId === null ? null : (
                    <span
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        projectAccent(
                          projectId,
                          resolveBoardProjectAccent(boardSettings, projectId),
                        ).dot,
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

            {subBoardParentId === null ? (
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
            ) : null}
          </div>

          {/* Title and Label share a row (T3O-31). Title comes FIRST and holds
              autofocus: the label control used to be the dialog's first text
              box, so a typed title landed in a label search that matched
              nothing and threw the text away. */}
          <div className="flex min-w-0 items-start gap-2.5">
            <div className="min-w-0 flex-[1.5]">
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
          {/* The footer holds the ONLY destructive path (T3O-26): X, Esc and
              the backdrop all keep the draft, so say what closing does and
              make discarding read as the deliberate act it is. Once the draft
              is gone — the card was created and only its files failed to
              attach, so the dialog stays open on the words it was made from —
              there is nothing left to keep or discard, and this goes back to a
              plain Cancel rather than promising to keep a draft that no longer
              exists. */}
          {draftHasContent && !draftSuppressed ? (
            <>
              <span className="text-[12px] text-muted-foreground max-sm:sr-only">
                Closing keeps this draft
              </span>
              <Button
                className="hover:border-destructive hover:text-destructive-foreground"
                onClick={discardDraft}
                size="sm"
                variant="outline"
              >
                Discard draft
              </Button>
            </>
          ) : (
            <Button onClick={() => handleOpenChange(false)} size="sm" variant="ghost">
              Cancel
            </Button>
          )}
          <Button disabled={!canSubmit} onClick={submit} size="sm">
            Create card
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
