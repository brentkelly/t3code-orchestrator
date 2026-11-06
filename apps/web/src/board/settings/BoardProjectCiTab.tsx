/**
 * T3o: a project's CI tab (T3O-49): the "Run CI for this project" switch,
 * the step list behind the built-in Sync with base, and how a script
 * reports. Steps save together, against the version they were loaded at.
 * Turning CI off with cards in CI asks first: those cards move on with
 * auto-merge disarmed.
 */
import {
  BOARD_CI_AGENT_PAYLOAD_SHAPE,
  BOARD_CI_COMMAND_MAX,
  BOARD_CI_PROMPT_MAX,
  BOARD_CONFIG_VERSION_MISMATCH,
  BOARD_SEED_STAGE_IDS,
  type BoardCiStep,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ArrowDownIcon, ArrowUpIcon, LockIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { describeBoardCommandFailure } from "../boardCommandFeedback";
import { boardToast } from "../boardToast";
import { BoardHint } from "../BoardHint";
import { boardCiStepShapeLine } from "../boardProjectPipelines";
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
import { useBoardSettingsContext } from "./BoardSettingsLayout";
import type { BoardProjectConfigState } from "./useBoardProjectConfig";

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
  const ciOn = shell.stageSwitches[BOARD_SEED_STAGE_IDS.ci] === true;
  const [confirmOff, setConfirmOff] = useState(false);
  // A draft saves against the version it was started from, so another
  // client's newer edit is a conflict rather than silently overwritten.
  const [draft, setDraft] = useState<{
    readonly steps: ReadonlyArray<BoardCiStep>;
    readonly baseVersion: string;
  } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [askTurnOn, setAskTurnOn] = useState(false);
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
  const update = (index: number, patch: Partial<BoardCiStep>) =>
    edit(
      steps.map((step, position) =>
        position === index ? ({ ...step, ...patch } as BoardCiStep) : step,
      ),
    );

  return (
    <div className="mx-3 flex flex-col gap-3 sm:mx-4">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-xs">
        <div className="flex flex-col">
          <span className="text-[13.5px] font-medium text-foreground">Run CI for this project</span>
          <span className="text-xs text-muted-foreground">
            {ciOn
              ? shell.ciSteps.length === 0
                ? "On, but there are no steps: cards skip CI until one is added."
                : `Cards leaving Code review run: Sync with base → ${boardCiStepShapeLine(shell.ciSteps)}`
              : "Off. Cards go from Code review straight to Ready for merge. Off keeps the steps for later."}
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

      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-2.5">
          <LockIcon className="size-3.5 text-muted-foreground" />
          <div className="flex flex-col">
            <span className="text-[13px] font-medium text-foreground">Sync with base</span>
            <span className="text-xs text-muted-foreground">
              Always first, always alone: rebases the branch onto its base and pushes it.
            </span>
          </div>
          <span className="flex-1" />
          <span className="rounded-md bg-accent px-1.5 py-px text-[11px] text-muted-foreground">
            Built in
          </span>
        </div>
        {saved === null ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">Loading steps…</p>
        ) : steps.length === 0 ? (
          <div className="flex flex-col gap-2 px-4 py-3 text-xs text-muted-foreground">
            <p>
              {props.projectTitle} has no CI steps yet. Without CI, cards go from Code review
              straight to Ready for merge. Add a step, then turn CI on.
            </p>
            {canWrite ? (
              <Button
                className="self-start"
                onClick={() => edit([boardCiStarterStep([])])}
                size="xs"
                variant="outline"
              >
                Add an agent step that runs this project&apos;s checks
              </Button>
            ) : null}
          </div>
        ) : (
          steps.map((step, index) => (
            <StepRow
              canWrite={canWrite}
              index={index}
              key={step.id}
              onChange={(patch) => update(index, patch)}
              onMove={(delta) => edit(moveBoardCiStep(steps, index, delta))}
              onRemove={() => edit(removeBoardCiStep(steps, index))}
              parallelBlock={boardCiParallelBlock(steps, index)}
              step={step}
              total={steps.length}
            />
          ))
        )}
        {boardCiSharedWorktreeWarnings(steps).map((warning) => (
          <p
            className="border-t border-border px-4 py-2 text-xs text-warning-foreground"
            key={warning.firstIndex}
          >
            ⚠ {warning.names.join(" and ")} share one worktree. Scripts running at once can collide
            on build output, caches or lockfiles.
          </p>
        ))}
        {canWrite ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
            <Button
              disabled={saved === null || !canAddBoardCiStep(steps)}
              onClick={() => edit([...steps, newBoardCiScriptStep(steps)])}
              size="xs"
              variant="outline"
            >
              <PlusIcon className="size-3" /> Script
            </Button>
            <Button
              disabled={saved === null || !canAddBoardCiStep(steps)}
              onClick={() => edit([...steps, newBoardCiAgentStep(steps)])}
              size="xs"
              variant="outline"
            >
              <PlusIcon className="size-3" /> Agent
            </Button>
            <Button
              disabled={saved === null || !canAddBoardCiStep(steps)}
              onClick={() => edit([...steps, newBoardCiForgeStep(steps)])}
              size="xs"
              variant="outline"
            >
              <PlusIcon className="size-3" /> Forge checks
            </Button>
            <span className="flex-1" />
            {conflict ? (
              <span className="text-xs text-warning-foreground">Changed elsewhere, reload.</span>
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
      <ScriptContractHelp />
    </div>
  );
}

function StepRow(props: {
  readonly step: BoardCiStep;
  readonly index: number;
  readonly total: number;
  readonly parallelBlock: string | null;
  readonly canWrite: boolean;
  readonly onChange: (patch: Partial<BoardCiStep>) => void;
  readonly onMove: (delta: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  const { step } = props;
  return (
    <div
      className={cn(
        "flex flex-col gap-2 border-b border-border px-4 py-2.5 last:border-b-0",
        step.parallel && "border-l-2 border-l-border",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">{props.index + 1}</span>
        <Input
          aria-label="Step name"
          className="h-7 max-w-56 text-[13px]"
          disabled={!props.canWrite}
          onChange={(event) => props.onChange({ name: event.target.value })}
          value={step.name}
        />
        <span className="rounded-md bg-accent px-1.5 py-px text-[11px] text-muted-foreground">
          {step.kind === "script" ? "Script" : step.kind === "agent" ? "Agent" : "Forge checks"}
        </span>
        <span className="flex-1" />
        <BoardHint label={props.parallelBlock ?? "Starts together with the step above"}>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Switch
              aria-label="Parallel with previous"
              checked={step.parallel}
              disabled={!props.canWrite || props.parallelBlock !== null}
              onCheckedChange={(checked) => props.onChange({ parallel: checked })}
            />
            ∥ Parallel with previous
          </label>
        </BoardHint>
        {props.canWrite ? (
          <>
            <Button
              aria-label="Move up"
              disabled={props.index === 0}
              onClick={() => props.onMove(-1)}
              size="icon-xs"
              variant="ghost"
            >
              <ArrowUpIcon />
            </Button>
            <Button
              aria-label="Move down"
              disabled={props.index === props.total - 1}
              onClick={() => props.onMove(1)}
              size="icon-xs"
              variant="ghost"
            >
              <ArrowDownIcon />
            </Button>
            <Button
              aria-label="Remove step"
              onClick={props.onRemove}
              size="icon-xs"
              variant="ghost"
            >
              <Trash2Icon />
            </Button>
          </>
        ) : null}
      </div>
      {step.kind === "agent" ? (
        <div className="flex flex-col gap-1.5 pl-5 text-xs">
          <span className="rounded-md bg-muted px-2 py-1 text-muted-foreground">
            Added by the board: the card, its branch and pull request, where it is in CI and what
            earlier steps found. Runs in its own thread.
          </span>
          <Textarea
            aria-label="Agent prompt"
            className="min-h-20 font-mono text-xs"
            disabled={!props.canWrite}
            maxLength={BOARD_CI_PROMPT_MAX}
            onChange={(event) => props.onChange({ prompt: event.target.value })}
            value={step.prompt}
          />
          <span className="rounded-md bg-muted px-2 py-1 text-muted-foreground">
            Added by the board: report with board_complete_step and a payload shaped{" "}
            <code>{BOARD_CI_AGENT_PAYLOAD_SHAPE}</code>.
          </span>
          <TimeoutField
            canWrite={props.canWrite}
            onChange={(timeoutMinutes) => props.onChange({ timeoutMinutes })}
            value={step.timeoutMinutes}
          />
        </div>
      ) : null}
      {step.kind === "forge-checks" ? (
        <div className="flex flex-col gap-1.5 pl-5 text-xs text-muted-foreground">
          <span>
            Waits for the pull request&apos;s checks on its forge (GitHub, GitLab, Bitbucket,
            Forgejo). A draft pull request is marked ready first. Forges without a checks API (Azure
            DevOps, GitCafe) hold the card instead.
          </span>
          <label className="flex items-center gap-2">
            Only these checks
            <Input
              aria-label="Only these checks"
              className="h-7 text-xs"
              disabled={!props.canWrite}
              onChange={(event) =>
                props.onChange({
                  only: event.target.value
                    .split(",")
                    .map((name) => name.trim())
                    .filter((name) => name.length > 0),
                })
              }
              placeholder="All checks, or names (comma-separated; * matches anything)"
              value={step.only.join(", ")}
            />
          </label>
          <label className="flex items-center gap-2">
            If no checks appear within
            <Input
              aria-label="Minutes to wait for checks to appear"
              className="h-7 w-16 text-xs"
              disabled={!props.canWrite}
              max={120}
              min={1}
              onChange={(event) => {
                const minutes = Number.parseInt(event.target.value, 10);
                if (Number.isFinite(minutes)) {
                  props.onChange({ appearTimeoutMinutes: Math.max(1, Math.min(120, minutes)) });
                }
              }}
              type="number"
              value={step.appearTimeoutMinutes}
            />
            min,
            <select
              aria-label="When no checks appear"
              className="h-7 rounded-md border border-input bg-background px-2 text-xs"
              disabled={!props.canWrite}
              onChange={(event) =>
                props.onChange({ whenNoChecks: event.target.value === "fail" ? "fail" : "pass" })
              }
              value={step.whenNoChecks}
            >
              <option value="pass">pass the step</option>
              <option value="fail">fail the step</option>
            </select>
          </label>
          <TimeoutField
            canWrite={props.canWrite}
            onChange={(timeoutMinutes) => props.onChange({ timeoutMinutes })}
            value={step.timeoutMinutes}
          />
        </div>
      ) : null}
      {step.kind === "script" ? (
        <div className="flex flex-col gap-1.5 pl-5">
          <Textarea
            aria-label="Command"
            className="min-h-14 font-mono text-xs"
            disabled={!props.canWrite}
            maxLength={BOARD_CI_COMMAND_MAX}
            onChange={(event) => props.onChange({ command: event.target.value })}
            value={step.command}
          />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Timeout
            <Input
              aria-label="Timeout in minutes"
              className="h-7 w-20 text-xs"
              disabled={!props.canWrite}
              max={1440}
              min={1}
              onChange={(event) => {
                const minutes = Number.parseInt(event.target.value, 10);
                if (Number.isFinite(minutes)) {
                  props.onChange({ timeoutMinutes: Math.max(1, Math.min(1440, minutes)) });
                }
              }}
              type="number"
              value={step.timeoutMinutes}
            />
            minutes
          </label>
        </div>
      ) : null}
    </div>
  );
}

function TimeoutField(props: {
  readonly value: number;
  readonly canWrite: boolean;
  readonly onChange: (minutes: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      Timeout
      <Input
        aria-label="Timeout in minutes"
        className="h-7 w-20 text-xs"
        disabled={!props.canWrite}
        max={1440}
        min={1}
        onChange={(event) => {
          const minutes = Number.parseInt(event.target.value, 10);
          if (Number.isFinite(minutes)) props.onChange(Math.max(1, Math.min(1440, minutes)));
        }}
        type="number"
        value={props.value}
      />
      minutes
    </label>
  );
}

const PROGRESS_EXAMPLE = `echo '::t3o-progress::{"message":"Running unit tests","done":128,"total":212}'`;
const RESULT_EXAMPLE = `cat > "$T3O_CI_RESULT" <<'JSON'
{ "summary": "3 of 212 tests failed",
  "failures": [{ "title": "slow_consumer_drops_oldest",
    "detail": "dropped frames (0 vs 12)",
    "file": "src/fanout.rs", "line": 311 }] }
JSON`;

/** How a script reports: the exit code decides; progress lines and a result
    file are optional detail. */
function ScriptContractHelp() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3 text-xs shadow-xs">
      <button
        className="font-medium text-foreground"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        ‹/› Report progress and results from a script · optional {open ? "▴" : "▾"}
      </button>
      {open ? (
        <div className="mt-2 flex flex-col gap-2 text-muted-foreground">
          <p>
            The exit code alone decides pass or fail. Scripts run in the card&apos;s worktree, so
            install what they need in the command itself (for example, prefix it with your install
            step).
          </p>
          <p>Progress · print any time (the latest line wins):</p>
          <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px]">
            {PROGRESS_EXAMPLE}
          </pre>
          <p>
            Result · write once before exiting; it adds detail and never overrides the exit code:
          </p>
          <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px]">
            {RESULT_EXAMPLE}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
