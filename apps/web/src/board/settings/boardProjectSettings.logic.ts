/**
 * T3o: pure helpers for Settings → Board → Projects → <project> (T3O-49) —
 * the CI step editor's edits and their parallel rules, the switch states the
 * Pipeline tab shows, and the import summary chips.
 */
import {
  BOARD_CI_MAX_STEPS,
  BOARD_SEED_STAGE_IDS,
  DEFAULT_BOARD_CI_FORGE_APPEAR_TIMEOUT_MINUTES,
  DEFAULT_BOARD_CI_FORGE_TIMEOUT_MINUTES,
  DEFAULT_BOARD_CI_STEP_TIMEOUT_MINUTES,
  boardStageDefaultForProjects,
  effectiveBoardStageRole,
  isBoardStageSwitchable,
  type BoardCiStep,
  type BoardProjectImportCandidate,
  type BoardStageDefinition,
  type BoardState,
} from "@t3tools/contracts";

/** The tabs of a project's settings page, in order. */
export const BOARD_PROJECT_SETTINGS_TABS = ["pipeline", "ci", "import"] as const;
export type BoardProjectSettingsTab = (typeof BOARD_PROJECT_SETTINGS_TABS)[number];

export function parseBoardProjectSettingsTab(value: string): BoardProjectSettingsTab {
  return (BOARD_PROJECT_SETTINGS_TABS as ReadonlyArray<string>).includes(value)
    ? (value as BoardProjectSettingsTab)
    : "pipeline";
}

/** Why a step can't run in parallel with the one before it, or null. */
export function boardCiParallelBlock(
  steps: ReadonlyArray<Pick<BoardCiStep, "kind">>,
  index: number,
): string | null {
  const step = steps[index];
  if (step === undefined) return null;
  if (index === 0) return "The first step runs on its own, after Sync with base.";
  if (step.kind !== "script" || steps[index - 1]?.kind !== "script") {
    return "Agent and forge-check steps run on their own.";
  }
  return null;
}

/** Steps with every `parallel` flag the parallel rules no longer allow cleared. */
export function normalizeBoardCiParallel(steps: ReadonlyArray<BoardCiStep>): BoardCiStep[] {
  return steps.map((step, index) =>
    step.parallel && boardCiParallelBlock(steps, index) !== null
      ? { ...step, parallel: false }
      : step,
  );
}

export function moveBoardCiStep(
  steps: ReadonlyArray<BoardCiStep>,
  index: number,
  delta: -1 | 1,
): BoardCiStep[] {
  const target = index + delta;
  if (target < 0 || target >= steps.length) return [...steps];
  const next = [...steps];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  return normalizeBoardCiParallel(next);
}

export function removeBoardCiStep(steps: ReadonlyArray<BoardCiStep>, index: number): BoardCiStep[] {
  return normalizeBoardCiParallel(steps.filter((_, position) => position !== index));
}

/** A fresh id no step in the list uses. */
function nextBoardCiStepId(steps: ReadonlyArray<Pick<BoardCiStep, "id">>): string {
  const used = new Set(steps.map((step) => step.id));
  for (let n = steps.length + 1; ; n++) {
    const id = `step-${n}`;
    if (!used.has(id)) return id;
  }
}

export function newBoardCiScriptStep(steps: ReadonlyArray<BoardCiStep>): BoardCiStep {
  return {
    kind: "script",
    id: nextBoardCiStepId(steps),
    name: "New step",
    parallel: false,
    command: "echo 'replace me' && exit 1",
    timeoutMinutes: DEFAULT_BOARD_CI_STEP_TIMEOUT_MINUTES,
  };
}

export function newBoardCiAgentStep(
  steps: ReadonlyArray<BoardCiStep>,
  prompt = "Describe what this step checks, and when it should fail.",
  name = "Agent check",
): BoardCiStep {
  return {
    kind: "agent",
    id: nextBoardCiStepId(steps),
    name,
    parallel: false,
    prompt,
    model: null,
    timeoutMinutes: DEFAULT_BOARD_CI_STEP_TIMEOUT_MINUTES,
  };
}

/** The one-click starter: an agent step that runs what AGENTS.md lists. */
export function boardCiStarterStep(steps: ReadonlyArray<BoardCiStep>): BoardCiStep {
  return newBoardCiAgentStep(
    steps,
    "Read the project's AGENTS.md (or README) and run the checks it lists for changes like this branch's: typecheck, lint and the relevant tests. Report passed when they all pass; otherwise failed, with each failure.",
    "Project checks",
  );
}

export function newBoardCiForgeStep(steps: ReadonlyArray<BoardCiStep>): BoardCiStep {
  return {
    kind: "forge-checks",
    id: nextBoardCiStepId(steps),
    name: "Forge checks",
    parallel: false,
    only: [],
    appearTimeoutMinutes: DEFAULT_BOARD_CI_FORGE_APPEAR_TIMEOUT_MINUTES,
    whenNoChecks: "pass",
    timeoutMinutes: DEFAULT_BOARD_CI_FORGE_TIMEOUT_MINUTES,
  };
}

export function canAddBoardCiStep(steps: ReadonlyArray<BoardCiStep>): boolean {
  return steps.length < BOARD_CI_MAX_STEPS;
}

/** Groups of two or more scripts running together share one worktree. */
export function boardCiSharedWorktreeWarnings(
  steps: ReadonlyArray<BoardCiStep>,
): ReadonlyArray<{ readonly firstIndex: number; readonly names: ReadonlyArray<string> }> {
  const warnings: Array<{ firstIndex: number; names: string[] }> = [];
  steps.forEach((step, index) => {
    if (!step.parallel) return;
    const open = warnings.at(-1);
    if (open !== undefined && open.firstIndex + open.names.length === index) {
      open.names.push(step.name);
    } else {
      warnings.push({ firstIndex: index - 1, names: [steps[index - 1]!.name, step.name] });
    }
  });
  return warnings;
}

/** How a stage reads on a project's Pipeline tab. */
export type BoardProjectStageState =
  | { readonly kind: "always-on"; readonly reason: string }
  | {
      readonly kind: "switchable";
      readonly on: boolean;
      /** The stage's default for projects. */
      readonly defaultOn: boolean;
      /** The project switched it against the default. */
      readonly switched: boolean;
    };

export const BOARD_ROLE_STAGE_NOTE =
  "Every project uses this stage: the board's own steps run here. Its settings can still be overridden per project.";
const BEFORE_BUILD_NOTE =
  "Every project uses this stage: approved work waits here for Auto-build, and split cards land here.";

export function boardProjectStageState(
  board: Pick<BoardState, "stages">,
  stage: BoardStageDefinition,
  stageSwitches: Readonly<Record<string, boolean>>,
): BoardProjectStageState {
  if (!isBoardStageSwitchable(board, stage)) {
    return {
      kind: "always-on",
      reason: effectiveBoardStageRole(stage) === null ? BEFORE_BUILD_NOTE : BOARD_ROLE_STAGE_NOTE,
    };
  }
  const defaultOn = boardStageDefaultForProjects(stage);
  const switched = stageSwitches[stage.stageId];
  return {
    kind: "switchable",
    on: switched ?? defaultOn,
    defaultOn,
    switched: switched !== undefined && switched !== defaultOn,
  };
}

/** Whether a stage is CI, which the CI tab switches. */
export const isBoardCiStage = (stage: Pick<BoardStageDefinition, "stageId">) =>
  stage.stageId === BOARD_SEED_STAGE_IDS.ci;

/** The import confirmation's summary chips: "+1 stage", "CI · 3 steps",
    "2 overrides", "1 ignored entry". */
export function boardImportSummaryChips(
  preview: NonNullable<BoardProjectImportCandidate["preview"]>,
): ReadonlyArray<string> {
  const chips: string[] = [];
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (preview.createStages.length > 0)
    chips.push(`+${plural(preview.createStages.length, "stage")}`);
  const switches = Object.keys(preview.delta.stageSwitches).filter(
    (stageId) => stageId !== BOARD_SEED_STAGE_IDS.ci,
  ).length;
  if (switches > 0) chips.push(plural(switches, "stage switch").replace("switchs", "switches"));
  const steps = preview.delta.ci.steps.length;
  if (steps > 0) chips.push(`CI · ${plural(steps, "step")}`);
  const overrides = Object.keys(preview.delta.overrides).length;
  if (overrides > 0) chips.push(plural(overrides, "override"));
  const ignored = preview.delta.warnings.length;
  if (ignored > 0) chips.push(plural(ignored, "ignored entry").replace("entrys", "entries"));
  return chips;
}
