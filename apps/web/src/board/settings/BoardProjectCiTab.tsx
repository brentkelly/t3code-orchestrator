/**
 * T3o: a project's CI tab (T3O-49): the "Run CI for this project" and "Stop
 * on failure" (T3O-57) switches,
 * the step list behind the built-in Sync with base, the fix agent and how a
 * script reports. Steps save together, against the version they were loaded
 * at. Turning CI off with cards in CI asks first: those cards move on with
 * auto-merge disarmed.
 */
import {
  BOARD_CI_AGENT_PAYLOAD_SHAPE,
  BOARD_CI_COMMAND_MAX,
  BOARD_CI_PROMPT_MAX,
  BOARD_CONFIG_VERSION_MISMATCH,
  BOARD_SEED_STAGE_IDS,
  boardCiStepGroups,
  type BoardCiStep,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BotIcon,
  ChevronDownIcon,
  CodeXmlIcon,
  CopyIcon,
  GitCompareArrowsIcon,
  GripVerticalIcon,
  LockIcon,
  PlusIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { PullRequestGlyph } from "../../components/pullRequest/pullRequestIcons";
import { NumberStepper } from "../../components/settings/BoardPipelineSection";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { cn } from "../../lib/utils";
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { describeBoardCommandFailure } from "../boardCommandFeedback";
import { boardToast } from "../boardToast";
import { BoardHint } from "../BoardHint";
import {
  boardCiParallelBlock,
  boardCiSharedWorktreeWarnings,
  canAddBoardCiStep,
  boardCiStarterStep,
  moveBoardCiStep,
  newBoardCiAgentStep,
  newBoardCiForgeStep,
  newBoardCiScriptStep,
  normalizeBoardCiParallel,
  removeBoardCiStep,
} from "./boardProjectSettings.logic";
import { BoardProjectCiFixAgent } from "./BoardProjectPipelineTab";
import { useBoardSettingsContext } from "./BoardSettingsLayout";
import type { BoardProjectConfigState } from "./useBoardProjectConfig";

const TYPE_LABEL: Readonly<Record<BoardCiStep["kind"], string>> = {
  script: "Script",
  agent: "Agent",
  "forge-checks": "Forge checks",
};

const TYPE_ICON: Readonly<Record<BoardCiStep["kind"], typeof TerminalIcon>> = {
  script: TerminalIcon,
  agent: BotIcon,
  "forge-checks": PullRequestGlyph.pullRequest,
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function BoardProjectCiTab(props: {
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly config: BoardProjectConfigState;
}) {
  const { environmentId, canWrite } = useBoardSettingsContext();
  const { shell, full } = props.config;
  const board = useAtomValue(boardEnvironment.boardAtom(environmentId));
  const cardsInCi = (board?.cards ?? []).filter(
    (card) => card.projectId === props.projectId && card.stage === BOARD_SEED_STAGE_IDS.ci,
  ).length;
  const setEnabled = useAtomCommand(boardEnvironment.setProjectCiEnabled, { reportFailure: false });
  const setSteps = useAtomCommand(boardEnvironment.setProjectCiSteps, { reportFailure: false });
  const setStopOnFailure = useAtomCommand(boardEnvironment.setProjectCiStopOnFailure, {
    reportFailure: false,
  });
  const ciOn = shell.stageSwitches[BOARD_SEED_STAGE_IDS.ci] === true;
  const stopOnFailure = shell.ciStopOnFailure !== false;
  const [confirmOff, setConfirmOff] = useState(false);
  // A draft saves against the version it was started from, so another
  // client's newer edit is a conflict rather than silently overwritten.
  const [draft, setDraft] = useState<{
    readonly steps: ReadonlyArray<BoardCiStep>;
    readonly baseVersion: string;
  } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [askTurnOn, setAskTurnOn] = useState(false);
  const [openStepId, setOpenStepId] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<{ readonly index: number; readonly after: boolean } | null>(
    null,
  );
  const saved = full?.ci.steps ?? null;
  const steps = draft?.steps ?? saved ?? [];

  const report = (title: string) => (result: { readonly _tag: string }) => {
    if (result._tag !== "Failure") return true;
    const description = describeBoardCommandFailure(result);
    if (description.includes(BOARD_CONFIG_VERSION_MISMATCH)) setConflict(true);
    boardToast({ title, description, tone: "error" });
    return false;
  };

  const switchCi = (on: boolean) => {
    setConfirmOff(false);
    void setEnabled({
      environmentId,
      input: { projectId: props.projectId, on, expectedConfigVersion: shell.version },
    }).then(report(on ? "Couldn't turn CI on" : "Couldn't turn CI off"));
  };

  const switchStopOnFailure = (on: boolean) => {
    void setStopOnFailure({
      environmentId,
      input: {
        projectId: props.projectId,
        stopOnFailure: on,
        expectedConfigVersion: shell.version,
      },
    }).then(report("Couldn't change Stop on failure"));
  };

  const save = (turnOn: boolean) => {
    if (draft === null) return;
    const next = normalizeBoardCiParallel(draft.steps);
    void setSteps({
      environmentId,
      input: {
        projectId: props.projectId,
        steps: next,
        expectedConfigVersion: draft.baseVersion,
      },
    }).then((result) => {
      if (!report("Couldn't save the CI steps")(result)) return;
      setDraft(null);
      setConflict(false);
      // CI is opt-in: the first steps saved on a project with CI off ask to turn it on.
      setAskTurnOn(turnOn);
    });
  };

  const edit = (next: ReadonlyArray<BoardCiStep>) => {
    const baseVersion = draft?.baseVersion ?? full?.version;
    // Until the steps load there is nothing to edit from.
    if (baseVersion === undefined) return;
    setDraft({ steps: next, baseVersion });
  };
  const add = (step: BoardCiStep) => {
    edit([...steps, step]);
    setOpenStepId(step.id);
  };
  const update = (index: number, patch: Partial<BoardCiStep>) =>
    edit(
      steps.map((step, position) =>
        position === index ? ({ ...step, ...patch } as BoardCiStep) : step,
      ),
    );
  const drop = () => {
    if (dragIndex !== null && dropAt !== null) {
      const slot = dropAt.index + (dropAt.after ? 1 : 0);
      edit(moveBoardCiStep(steps, dragIndex, dragIndex < slot ? slot - 1 : slot));
    }
    setDragIndex(null);
    setDropAt(null);
  };

  const groups = boardCiStepGroups(
    steps.map((step, index) => ({ kind: step.kind, parallel: step.parallel, step, index })),
  );
  const parallelGroups = groups.filter((group) => group.length > 1).length;
  const warnings = boardCiSharedWorktreeWarnings(steps);
  const canAdd = canWrite && saved !== null && canAddBoardCiStep(steps);
  const addButtons = [
    { label: "Script", add: () => add(newBoardCiScriptStep(steps)) },
    { label: "Agent", add: () => add(newBoardCiAgentStep(steps)) },
    { label: "Forge checks", add: () => add(newBoardCiForgeStep(steps)) },
  ];

  return (
    <div className="mx-3 flex flex-col gap-5 sm:mx-4">
      {ciOn || steps.length > 0 ? (
        <div className="flex items-center gap-4 rounded-xl border border-border bg-card px-4 py-3 shadow-xs">
          <div className="flex min-w-0 flex-1 flex-col gap-px">
            <span className="text-[13.5px] font-medium text-foreground">
              Run CI for this project
            </span>
            <span className="text-xs text-pretty text-muted-foreground">
              {!ciOn
                ? "Off. Cards skip CI; the steps below are kept for when you switch it back on."
                : steps.length === 0
                  ? "On, but there are no steps: cards skip CI until one is added."
                  : "Cards leaving Code review run these steps before Ready for merge."}
            </span>
          </div>
          <Switch
            aria-label={`Run CI for ${props.projectTitle}`}
            checked={ciOn}
            disabled={!canWrite}
            onCheckedChange={(checked) => {
              if (!checked && cardsInCi > 0) setConfirmOff(true);
              else switchCi(checked);
            }}
          />
        </div>
      ) : null}
      {ciOn || steps.length > 0 ? (
        <div
          className={cn(
            "flex items-center gap-4 rounded-xl border border-border bg-card px-4 py-3 shadow-xs",
            !ciOn && "opacity-60",
          )}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-px">
            <span className="text-[13.5px] font-medium text-foreground">Stop on failure</span>
            <span className="text-xs text-pretty text-muted-foreground">
              {draft !== null
                ? "Save or discard your step changes before changing this."
                : stopOnFailure
                  ? "A failed step stops the steps after it. Faster, but a pass may show only the first failure."
                  : "Every step runs even after one fails, so one pass shows every failure. Passes take longer."}
            </span>
          </div>
          <span className="text-xs font-medium text-foreground">
            {stopOnFailure ? "Yes" : "No"}
          </span>
          <Switch
            aria-label={`Stop CI on the first failure for ${props.projectTitle}`}
            checked={stopOnFailure}
            // It saves straight away and moves the config version, which would
            // refuse an open steps draft's save as a version mismatch.
            disabled={!canWrite || !ciOn || draft !== null}
            onCheckedChange={switchStopOnFailure}
          />
        </div>
      ) : null}
      {askTurnOn && !ciOn ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-attention/40 bg-attention/8 px-3 py-2 text-xs">
          <span className="text-foreground">Turn CI on for this project?</span>
          <span className="flex-1" />
          <Button
            size="xs"
            onClick={() => {
              setAskTurnOn(false);
              switchCi(true);
            }}
          >
            Turn CI on
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setAskTurnOn(false)}>
            Not now
          </Button>
        </div>
      ) : null}
      {confirmOff ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-attention/40 bg-attention/8 px-3 py-2 text-xs">
          <span className="text-foreground">
            {cardsInCi} {cardsInCi === 1 ? "card is" : "cards are"} in CI. Turning CI off moves them
            to Ready for merge; auto-merge won&apos;t run for them.
          </span>
          <span className="flex-1" />
          <Button size="xs" variant="destructive" onClick={() => switchCi(false)}>
            Turn CI off
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setConfirmOff(false)}>
            Cancel
          </Button>
        </div>
      ) : null}

      {saved === null ? (
        <p className="text-xs text-muted-foreground">Loading steps…</p>
      ) : steps.length === 0 ? (
        <div className="flex flex-col items-start gap-3.5 rounded-xl border border-dashed border-input bg-card px-6.5 pt-6.5 pb-6">
          <div className="flex max-w-[60ch] flex-col gap-1">
            <span className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">
              {props.projectTitle} has no CI yet
            </span>
            <span className="text-[13px] leading-[1.6] text-pretty text-muted-foreground">
              Without CI, cards go from Code review straight to Ready for merge. Add steps here,
              save them, then turn CI on for this project; cards already past Code review
              aren&apos;t affected.
            </span>
          </div>
          {canWrite ? (
            <>
              <button
                className="flex w-full max-w-[560px] cursor-pointer items-center gap-3 rounded-xl border border-primary/40 bg-primary/5 px-4 py-3.5 text-left shadow-xs hover:bg-primary/9"
                onClick={() => add(boardCiStarterStep(steps))}
                type="button"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-primary text-primary-foreground">
                  <BotIcon className="size-4" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[13px] font-semibold text-foreground">
                    Add an agent step that runs this project&apos;s checks
                  </span>
                  <span className="text-xs leading-normal text-pretty text-muted-foreground">
                    The agent reads AGENTS.md, runs the checks it lists, and reports passed or
                    failed with the failures. One click; edit it afterwards.
                  </span>
                </span>
                <span className="shrink-0 text-xs font-medium text-primary">Add step</span>
              </button>
              <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
                <span>Or start from</span>
                {addButtons.map((button) => (
                  <Button key={button.label} onClick={button.add} size="xs" variant="outline">
                    {button.label}
                  </Button>
                ))}
                <span>· or</span>
                <Link
                  className="font-medium text-info-foreground hover:underline"
                  params={{ projectId: props.projectId, tab: "import" }}
                  to="/settings/board/projects/$projectId/$tab"
                >
                  import a t3o.json
                </Link>
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <section className="flex flex-col gap-2">
          <SectionHeading
            note={`Sync, then ${plural(groups.length, "group", "groups")} in order${
              parallelGroups > 0
                ? ` (${plural(parallelGroups, "parallel group", "parallel groups")})`
                : ""
            } · ${
              stopOnFailure
                ? "a failure stops later groups once its own group finishes"
                : "every step runs, even after a failure"
            }`}
          >
            Steps
          </SectionHeading>
          <div className="flex flex-col">
            <div className="flex items-center gap-2.5 rounded-xl border border-border bg-muted px-3.5 py-2.5">
              <LockIcon className="size-3 shrink-0 text-muted-foreground" />
              <span className="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-accent text-foreground">
                <GitCompareArrowsIcon className="size-3.5" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="text-[13px] font-medium text-foreground">Sync with base</span>
                <span className="text-xs text-pretty text-muted-foreground">
                  Always first, always alone. Passes at once when the branch is up to date; a
                  conflict starts a fix agent inside CI.
                </span>
              </div>
              <span className="shrink-0 rounded-full border border-border px-[7px] py-px text-[11px] font-medium text-muted-foreground">
                Built in
              </span>
            </div>

            {groups.map((group, groupIndex) => {
              const first = group[0]!;
              const warning = warnings.find((candidate) => candidate.firstIndex === first.index);
              const multi = group.length > 1;
              return (
                <div className="flex flex-col" key={first.step.id}>
                  <div className="flex h-[22px] items-center gap-2 pl-[22px]">
                    <span className="h-full w-px bg-input" />
                    <span className="text-[10.5px] font-medium tracking-[.06em] text-muted-foreground uppercase">
                      {groupIndex === 0 ? "then" : "then, once the group above passes"}
                    </span>
                  </div>
                  <div
                    className={cn(
                      "flex flex-col overflow-hidden rounded-xl border bg-card shadow-xs",
                      multi ? "border-primary/30 border-l-[3px] border-l-primary" : "border-border",
                    )}
                  >
                    {multi ? (
                      <div className="flex items-center gap-[7px] border-b border-primary/18 px-3 pt-[7px] pb-1.5">
                        <ParallelGlyph />
                        <span className="text-[11.5px] font-semibold text-primary">Parallel</span>
                        <span className="text-[11.5px] text-muted-foreground">
                          {group.length} steps start together; the group passes when all of them
                          pass
                        </span>
                      </div>
                    ) : null}
                    {group.map(({ step, index }, position) => (
                      <StepRow
                        canWrite={canWrite}
                        dragging={dragIndex === index}
                        dropEdge={
                          dragIndex !== null && dragIndex !== index && dropAt?.index === index
                            ? dropAt.after
                              ? "after"
                              : "before"
                            : null
                        }
                        index={index}
                        key={step.id}
                        onChange={(patch) => update(index, patch)}
                        onDragEnd={() => {
                          setDragIndex(null);
                          setDropAt(null);
                        }}
                        onDragOver={(after) => {
                          if (dropAt?.index !== index || dropAt.after !== after) {
                            setDropAt({ index, after });
                          }
                        }}
                        onDragStart={() => setDragIndex(index)}
                        onDrop={drop}
                        onMove={(target) => edit(moveBoardCiStep(steps, index, target))}
                        onRemove={() => {
                          edit(removeBoardCiStep(steps, index));
                          setOpenStepId(null);
                        }}
                        onToggle={() =>
                          setOpenStepId((current) => (current === step.id ? null : step.id))
                        }
                        open={openStepId === step.id}
                        parallelBlock={boardCiParallelBlock(steps, index)}
                        separated={position > 0}
                        step={step}
                        total={steps.length}
                      />
                    ))}
                    {warning !== undefined ? (
                      <div className="flex gap-2 border-t border-warning/35 bg-warning/7 px-3 py-[9px] text-xs leading-normal text-pretty text-foreground">
                        <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-warning-foreground" />
                        <span>
                          {warning.names.join(" and ")} share one worktree. Scripts running at once
                          can collide on build output, caches or lockfiles; keep them parallel only
                          if they don&apos;t write the same files.
                        </span>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}

            {canWrite ? (
              <div className="flex flex-wrap items-center gap-2 pt-3.5 pl-0.5">
                <span className="text-[12.5px] font-medium text-muted-foreground">Add step</span>
                {addButtons.map((button) => (
                  <Button
                    disabled={!canAdd}
                    key={button.label}
                    onClick={button.add}
                    size="xs"
                    variant="outline"
                  >
                    <PlusIcon /> {button.label}
                  </Button>
                ))}
                <span className="flex-1" />
                {conflict ? (
                  <span className="text-xs text-warning-foreground">
                    Changed elsewhere, reload.
                  </span>
                ) : null}
                {draft !== null ? (
                  <>
                    <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
                      Discard
                    </Button>
                    <Button size="xs" onClick={() => save(!ciOn && draft.steps.length > 0)}>
                      Save steps
                    </Button>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>
      )}

      {/* A draft emptied of steps still needs its save bar. */}
      {saved !== null && steps.length === 0 && draft !== null && canWrite ? (
        <div className="-mt-3 flex items-center justify-end gap-2">
          <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
            Discard
          </Button>
          <Button size="xs" onClick={() => save(false)}>
            Save steps
          </Button>
        </div>
      ) : null}

      <section className="flex flex-col gap-2">
        <SectionHeading note="Runs when a step fails, then every step re-runs from the top.">
          Fix agent
        </SectionHeading>
        <BoardProjectCiFixAgent config={props.config} projectId={props.projectId} />
      </section>

      <ScriptContractHelp />
    </div>
  );
}

function SectionHeading(props: { readonly children: ReactNode; readonly note: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <h2 className="text-sm font-semibold text-foreground">{props.children}</h2>
      <span className="text-xs text-muted-foreground">{props.note}</span>
    </div>
  );
}

function ParallelGlyph() {
  return (
    <svg
      aria-hidden="true"
      className="size-[13px] shrink-0 text-primary"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
    >
      <path d="M8 3v18" />
      <path d="M16 3v18" />
    </svg>
  );
}

function stepSummary(step: BoardCiStep): string {
  if (step.kind === "script") {
    return `${step.command.trim() || "No command yet"} · ${step.timeoutMinutes} min`;
  }
  if (step.kind === "agent") {
    const prompt = step.prompt.trim();
    const shown = prompt.length > 90 ? `${prompt.slice(0, 90)}…` : prompt || "No prompt yet";
    return `${shown} · ${step.model?.model ?? "default model"}`;
  }
  return `${step.only.length > 0 ? `Only ${step.only.join(", ")}` : "Every check on the PR head"} · gives up after ${step.appearTimeoutMinutes} min`;
}

function StepRow(props: {
  readonly step: BoardCiStep;
  readonly index: number;
  readonly total: number;
  readonly open: boolean;
  readonly separated: boolean;
  readonly parallelBlock: string | null;
  readonly canWrite: boolean;
  readonly dragging: boolean;
  readonly dropEdge: "before" | "after" | null;
  readonly onToggle: () => void;
  readonly onChange: (patch: Partial<BoardCiStep>) => void;
  readonly onMove: (target: number) => void;
  readonly onRemove: () => void;
  readonly onDragStart: () => void;
  readonly onDragOver: (after: boolean) => void;
  readonly onDragEnd: () => void;
  readonly onDrop: () => void;
}) {
  const { step } = props;
  const Icon = TYPE_ICON[step.kind];
  const parallelOn = step.parallel && props.parallelBlock === null;
  return (
    <div
      className={cn(
        props.separated && "border-t border-border",
        props.dragging && "opacity-45",
        props.dropEdge === "before" && "shadow-[inset_0_2px_0_var(--color-primary)]",
        props.dropEdge === "after" && "shadow-[inset_0_-2px_0_var(--color-primary)]",
      )}
      onDragOver={(event) => {
        if (!props.canWrite) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        props.onDragOver(event.clientY > rect.top + rect.height / 2);
      }}
      onDrop={(event) => {
        event.preventDefault();
        props.onDrop();
      }}
    >
      <div
        aria-expanded={props.open}
        className="flex cursor-pointer items-center gap-2.5 py-2.5 pr-3 pl-2.5 hover:bg-muted/50"
        draggable={props.canWrite}
        onClick={props.onToggle}
        onDragEnd={props.onDragEnd}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", step.id);
          props.onDragStart();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            props.onToggle();
          }
        }}
        role="button"
        tabIndex={0}
      >
        <GripVerticalIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/70",
            props.canWrite ? "cursor-grab" : "invisible",
          )}
        />
        <span className="flex size-[26px] shrink-0 items-center justify-center rounded-[7px] bg-accent text-foreground">
          <Icon className="size-3.5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <div className="flex min-w-0 items-center gap-[7px]">
            <span className="truncate text-[13px] font-medium text-foreground">{step.name}</span>
            <span className="shrink-0 text-[10.5px] font-medium tracking-[.04em] text-muted-foreground uppercase">
              {TYPE_LABEL[step.kind]}
            </span>
          </div>
          <span
            className={cn(
              "truncate text-xs text-muted-foreground",
              step.kind === "script" && "font-mono",
            )}
          >
            {stepSummary(step)}
          </span>
        </div>
        <BoardHint
          label={
            props.parallelBlock ??
            (parallelOn ? "Starts together with the step above" : "Waits for the step above")
          }
        >
          <label
            className={cn(
              "inline-flex shrink-0 items-center gap-[7px] text-[11.5px] font-medium",
              parallelOn ? "text-foreground" : "text-muted-foreground",
              props.parallelBlock !== null && "opacity-45",
            )}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <Switch
              aria-label={`Run ${step.name} in parallel with the previous step`}
              checked={parallelOn}
              disabled={!props.canWrite || props.parallelBlock !== null}
              onCheckedChange={(checked) => props.onChange({ parallel: checked })}
              size="sm"
            />
            Parallel with previous
          </label>
        </BoardHint>
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
            props.open && "rotate-180",
          )}
        />
      </div>

      {props.open ? (
        <div className="flex flex-col gap-3 pt-1 pr-3.5 pb-3.5 pl-[58px]">
          <Field label="Name">
            <Input
              aria-label="Step name"
              className="flex-1"
              disabled={!props.canWrite}
              onChange={(event) => props.onChange({ name: event.target.value })}
              value={step.name}
            />
          </Field>

          {step.kind === "script" ? (
            <Field label="Command">
              {/* Grows with the command, which may span lines. */}
              <textarea
                aria-label="Command"
                className="field-sizing-content min-h-8 min-w-0 flex-1 resize-none rounded-lg border border-input bg-popover px-2.5 py-1.5 font-mono text-[12.5px] leading-[1.5] font-medium text-foreground shadow-xs outline-none focus-visible:border-ring disabled:opacity-64"
                disabled={!props.canWrite}
                maxLength={BOARD_CI_COMMAND_MAX}
                onChange={(event) => props.onChange({ command: event.target.value })}
                rows={1}
                spellCheck={false}
                value={step.command}
              />
            </Field>
          ) : null}

          {step.kind === "agent" ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] text-muted-foreground">
                Prompt · runs in its own thread
              </span>
              <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xs">
                <BoardAddedNote edge="top">
                  The card, its branch and pull request, where it is in CI and what earlier steps
                  found.
                </BoardAddedNote>
                <textarea
                  aria-label="Agent prompt"
                  className="block min-h-28 w-full resize-y border-none bg-card px-3.5 py-3 text-[13px] leading-[1.6] text-foreground outline-none disabled:opacity-64"
                  disabled={!props.canWrite}
                  maxLength={BOARD_CI_PROMPT_MAX}
                  onChange={(event) => props.onChange({ prompt: event.target.value })}
                  rows={5}
                  value={step.prompt}
                />
                <BoardAddedNote edge="bottom">
                  Report with board_complete_step and a payload shaped{" "}
                  {BOARD_CI_AGENT_PAYLOAD_SHAPE}.
                </BoardAddedNote>
              </div>
            </div>
          ) : null}

          {step.kind === "forge-checks" ? (
            <>
              <p className="max-w-[66ch] text-xs leading-normal text-pretty text-muted-foreground">
                Waits for the pull request&apos;s checks on its forge (GitHub, GitLab, Bitbucket,
                Forgejo). A draft pull request is marked ready first. Forges without a checks API
                (Azure DevOps, GitCafe) hold the card instead.
              </p>
              <Field align="start" label="Only these">
                <CheckNamesInput
                  disabled={!props.canWrite}
                  names={step.only}
                  onChange={(only) => props.onChange({ only })}
                />
              </Field>
              <Field label="Give up after">
                <NumberStepper
                  ariaLabel="Minutes to wait for checks to appear"
                  disabled={!props.canWrite}
                  max={120}
                  min={1}
                  onChange={(appearTimeoutMinutes) => props.onChange({ appearTimeoutMinutes })}
                  unit="min"
                  value={step.appearTimeoutMinutes}
                />
                <span className="text-xs text-muted-foreground">
                  if no checks appear on the PR head, then
                </span>
                <select
                  aria-label="When no checks appear"
                  className="h-8 rounded-lg border border-input bg-popover px-2 text-[13px] font-medium shadow-xs"
                  disabled={!props.canWrite}
                  onChange={(event) =>
                    props.onChange({
                      whenNoChecks: event.target.value === "fail" ? "fail" : "pass",
                    })
                  }
                  value={step.whenNoChecks}
                >
                  <option value="pass">pass the step</option>
                  <option value="fail">fail the step</option>
                </select>
              </Field>
            </>
          ) : null}

          <Field label="Timeout">
            <NumberStepper
              ariaLabel="Timeout in minutes"
              disabled={!props.canWrite}
              max={1440}
              min={1}
              onChange={(timeoutMinutes) => props.onChange({ timeoutMinutes })}
              unit="min"
              value={step.timeoutMinutes}
            />
            <span className="text-xs text-muted-foreground">Marked failed after this.</span>
          </Field>

          {props.canWrite ? (
            <div className="flex items-center gap-1.5 pt-1">
              <Button onClick={props.onRemove} size="xs" variant="destructive-outline">
                Remove step
              </Button>
              <span className="flex-1" />
              <Button
                aria-label="Move up"
                disabled={props.index === 0}
                onClick={() => props.onMove(props.index - 1)}
                size="icon-xs"
                variant="ghost"
              >
                <ArrowUpIcon />
              </Button>
              <Button
                aria-label="Move down"
                disabled={props.index === props.total - 1}
                onClick={() => props.onMove(props.index + 1)}
                size="icon-xs"
                variant="ghost"
              >
                <ArrowDownIcon />
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Field(props: {
  readonly label: string;
  readonly align?: "center" | "start";
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap gap-2.5",
        props.align === "start" ? "items-start" : "items-center",
      )}
    >
      <span
        className={cn(
          "w-24 shrink-0 text-[13px] text-muted-foreground",
          props.align === "start" && "pt-1.5",
        )}
      >
        {props.label}
      </span>
      {props.children}
    </div>
  );
}

/** The muted, monospaced text the board wraps around an agent step's prompt. */
function BoardAddedNote(props: { readonly edge: "top" | "bottom"; readonly children: ReactNode }) {
  return (
    <div
      className={cn(
        "relative bg-muted py-2.5 pr-[120px] pl-3.5 font-mono text-xs leading-[1.6] whitespace-pre-wrap text-muted-foreground",
        props.edge === "top" ? "border-b border-border" : "border-t border-border",
      )}
    >
      <span className="absolute top-2 right-2.5 rounded-full border border-border bg-card px-[7px] py-px font-sans text-[10.5px] font-medium">
        Added by the board
      </span>
      {props.children}
    </div>
  );
}

/** Check names as chips; Enter adds one, Backspace on an empty field removes the last. */
function CheckNamesInput(props: {
  readonly names: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onChange: (names: ReadonlyArray<string>) => void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex min-h-8 flex-wrap items-center gap-[5px] rounded-lg border border-input bg-popover px-1.5 py-[3px] shadow-xs">
        {props.names.map((name) => (
          <span
            className="inline-flex h-[22px] items-center gap-1 rounded-md bg-accent pr-1 pl-2 font-mono text-xs font-medium"
            key={name}
          >
            {name}
            {props.disabled ? null : (
              <button
                aria-label={`Remove ${name}`}
                className="flex size-4 cursor-pointer items-center justify-center rounded text-muted-foreground hover:text-foreground"
                onClick={() =>
                  props.onChange(props.names.filter((candidate) => candidate !== name))
                }
                type="button"
              >
                ×
              </button>
            )}
          </span>
        ))}
        <input
          aria-label="Add a check name"
          className="h-6 min-w-[120px] flex-1 border-none bg-transparent font-mono text-xs font-medium text-foreground outline-none"
          disabled={props.disabled}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            const name = text.trim();
            if (event.key === "Enter" && name.length > 0) {
              event.preventDefault();
              if (!props.names.includes(name)) props.onChange([...props.names, name]);
              setText("");
            } else if (event.key === "Backspace" && text.length === 0 && props.names.length > 0) {
              props.onChange(props.names.slice(0, -1));
            }
          }}
          placeholder={props.names.length > 0 ? "Add another" : "e.g. ci/build"}
          spellCheck={false}
          value={text}
        />
      </div>
      <span className="text-xs text-muted-foreground">
        Check names, Enter to add; * matches anything. Empty means every check on the PR head.
      </span>
    </div>
  );
}

const PROGRESS_EXAMPLE = `echo '::t3o-progress::{"message":"Running unit tests","done":128,"total":212}'`;
const RESULT_EXAMPLE = `cat > "$T3O_CI_RESULT" <<'JSON'
{ "summary": "3 of 212 tests failed",
  "failures": [{ "title": "slow_consumer_drops_oldest",
    "detail": "dropped frames (0 vs 12)",
    "file": "src/fanout.rs", "line": 311 }] }
JSON`;

const SNIPPETS = [
  { title: "Progress · print any time, the latest line wins", code: PROGRESS_EXAMPLE },
  {
    title: "Result · write once before exiting; adds detail, never overrides the exit code",
    code: RESULT_EXAMPLE,
  },
] as const;

/** How a script reports: the exit code decides; progress lines and a result
    file are optional detail. */
function ScriptContractHelp() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xs">
      <button
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-[9px] px-4 py-3 text-left hover:bg-muted"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <CodeXmlIcon className="size-[15px] shrink-0 text-muted-foreground" />
        <span className="flex-1 text-[13px] font-medium text-foreground">
          Report progress and results from a script
        </span>
        <span className="text-xs text-muted-foreground">Optional</span>
        <ChevronDownIcon
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <div className="flex flex-col gap-3 pt-0.5 pr-4 pb-4 pl-10">
          <p className="max-w-[66ch] text-[12.5px] leading-[1.55] text-pretty text-muted-foreground">
            Print progress lines and the card shows a live fraction instead of a timer. Write a
            result file and failures show up as a list with file and line, and go to the fix agent
            as structured input instead of a log tail. Both are optional; the exit code alone
            decides pass or fail. Scripts run in the card&apos;s worktree, so install what they need
            in the command itself.
          </p>
          {SNIPPETS.map((snippet) => (
            <Snippet code={snippet.code} key={snippet.title} title={snippet.title} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Snippet(props: { readonly title: string; readonly code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-muted py-1.5 pr-2 pl-3">
        <span className="flex-1 text-[11.5px] font-medium text-muted-foreground">
          {props.title}
        </span>
        <Button
          onClick={() => {
            void navigator.clipboard.writeText(props.code).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            });
          }}
          size="xs"
          variant="outline"
        >
          <CopyIcon /> {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-x-auto bg-card px-3 py-2.5 font-mono text-xs leading-[1.6] text-foreground">
        {props.code}
      </pre>
    </div>
  );
}
