/**
 * T3o create-card dialog (t3o-06). Title, brief, labels, project, target stage
 * and initial dependencies — everything a card needs to land in one atomic
 * `board.card.create` (the command carries brief and dependsOn, t3o-06). The
 * key is allocated server-side; the UI never invents one.
 *
 * Target stage offers Backlog, Sprint and Planning ONLY (t3o-06a): later
 * stages describe work the board has already started shepherding, so a card
 * cannot appear mid-pipeline — it reaches them by being moved under D18's
 * human gate. The decider enforces the same restriction, so this is a
 * convenience, not the guard.
 */
import {
  BOARD_CREATABLE_STAGES,
  BoardCardId,
  BoardLabelId,
  resolveBoardKeyPrefix,
  type BoardStage,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { boardColumnAppendOrderKey } from "@t3tools/client-runtime/state/shell";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { randomUUID } from "../lib/utils";
import { boardEnvironment } from "../state/board";
import { environmentShell } from "../state/shell";
import { usePrimarySettings } from "../hooks/useSettings";
import { useAtomCommand } from "../state/use-atom-command";
import { BoardLabelField } from "./BoardLabelField";
import { BoardSearchAddPicker } from "./BoardSearchAddPicker";
import { BOARD_STAGE_LABELS } from "./boardStages";
import { describeBoardCommandFailure } from "./boardCommandFeedback";

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
}: {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projects: ReadonlyArray<BoardCreateProject>;
  readonly defaultProjectId: ProjectId | null;
  readonly defaultStage: BoardStage;
}) {
  const catalogue = useAtomValue(boardEnvironment.labelCatalogueAtom(environmentId));
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const boardSettings = usePrimarySettings((settings) => settings.board);
  const createCard = useAtomCommand(boardEnvironment.createCard);
  const createLabel = useAtomCommand(boardEnvironment.createLabel);
  const updateLabel = useAtomCommand(boardEnvironment.updateLabel);
  const deleteLabel = useAtomCommand(boardEnvironment.deleteLabel);
  const undeleteLabel = useAtomCommand(boardEnvironment.undeleteLabel);

  const snapshot = useMemo(() => Option.getOrNull(shellState.snapshot), [shellState.snapshot]);
  const allCards = snapshot?.cards ?? [];

  const initialProjectId = defaultProjectId ?? projects[0]?.id ?? null;
  const [projectId, setProjectId] = useState<ProjectId | null>(initialProjectId);
  const [stage, setStage] = useState<BoardStage>(defaultStage);
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
    }
    wasOpen.current = open;
  }, [open, defaultProjectId, defaultStage, projects]);

  const dependencyOptions = useMemo(
    () =>
      allCards
        .filter((card) => !dependsOn.includes(card.cardId as BoardCardId))
        .map((card) => ({ id: card.cardId, key: card.key, title: card.title })),
    [allCards, dependsOn],
  );

  const dependencyChips = dependsOn.map((id) => {
    const card = allCards.find((candidate) => candidate.cardId === id);
    return { id, key: card?.key ?? id };
  });

  const canSubmit = title.trim().length > 0 && projectId !== null && !submitting;

  const submit = () => {
    if (projectId === null) return;
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) return;
    const trimmedBrief = brief.trim();
    setSubmitting(true);
    const targetColumn = allCards.filter(
      (card) => card.projectId === projectId && card.stage === stage,
    );
    void createCard({
      environmentId,
      input: {
        cardId: BoardCardId.make(randomUUID()),
        projectId,
        title: trimmedTitle,
        stage,
        labels: labelIds,
        dependsOn,
        ...(trimmedBrief.length === 0 ? {} : { brief: trimmedBrief }),
        keyPrefix: resolveBoardKeyPrefix(boardSettings, projectId),
        orderKey: boardColumnAppendOrderKey(targetColumn),
      },
    }).then((result) => {
      if (result._tag === "Failure") {
        setSubmitting(false);
        if (!isAtomCommandInterrupted(result)) setFeedback(describeBoardCommandFailure(result));
        return;
      }
      onOpenChange(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New card</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            autoFocus
            className="text-sm"
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSubmit) submit();
            }}
            placeholder="Card title"
            value={title}
          />
          <Textarea
            className="min-h-20 text-sm"
            onChange={(event) => setBrief(event.target.value)}
            placeholder="Brief (optional)"
            value={brief}
          />

          <div className="flex flex-wrap items-center gap-2">
            {/* Project */}
            <Select
              items={projects.map((project) => ({
                value: project.id as string,
                label: project.title,
              }))}
              modal={false}
              onValueChange={(value: string | null) => {
                if (value !== null) setProjectId(value as ProjectId);
              }}
              value={projectId ?? ""}
            >
              <SelectTrigger aria-label="Project" size="xs" variant="default">
                <SelectValue placeholder="Project" />
              </SelectTrigger>
              <SelectPopup>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>

            {/* Target stage — creatable stages only (t3o-06a). */}
            <Select
              items={BOARD_CREATABLE_STAGES.map((creatable) => ({
                value: creatable as string,
                label: BOARD_STAGE_LABELS[creatable],
              }))}
              modal={false}
              onValueChange={(value: string | null) => {
                if (value !== null) setStage(value as BoardStage);
              }}
              value={stage}
            >
              <SelectTrigger aria-label="Target stage" size="xs" variant="default">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {BOARD_CREATABLE_STAGES.map((creatable) => (
                  <SelectItem key={creatable} value={creatable}>
                    {BOARD_STAGE_LABELS[creatable]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>

          {/* Labels — pills for what is chosen, one autocomplete to change it. */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[12px] font-medium text-foreground">Label</label>
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
              size="field"
            />
          </div>

          {/* Initial dependencies */}
          <div className="flex flex-wrap items-center gap-1.5">
            {dependencyChips.length === 0 ? (
              <span className="text-[12.5px] text-muted-foreground">No dependencies</span>
            ) : (
              dependencyChips.map((chip) => (
                <button
                  className="inline-flex items-center gap-1 rounded bg-muted px-1.5 text-[11px] font-medium hover:bg-muted/70"
                  key={chip.id}
                  onClick={() => setDependsOn((prev) => prev.filter((id) => id !== chip.id))}
                  title="Remove dependency"
                  type="button"
                >
                  {chip.key}
                  <span aria-hidden>×</span>
                </button>
              ))
            )}
            <BoardSearchAddPicker
              label="Depends on"
              onPick={(id) => setDependsOn((prev) => [...prev, id as BoardCardId])}
              options={dependencyOptions}
              placeholder="Search cards…"
            />
          </div>

          {feedback !== null ? (
            <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-[12px] text-destructive-foreground">
              {feedback}
            </p>
          ) : null}
        </div>
        <DialogFooter>
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
