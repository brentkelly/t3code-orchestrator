/**
 * T3o: pure helpers for Settings → Board → Projects → <project> —
 * the CI step editor's edits and their parallel rules, the switch states the
 * Pipeline tab shows, and the import summary chips.
 */
import {
  BOARD_SCHEDULE_AMBER_RESULTS,
  describeScheduleWhen,
  type BoardScheduleImportKind,
  type BoardScheduleImportOutcome,
  type BoardScheduleImportRow,
  type BoardScheduleLastResult,
  type BoardScheduleRow,
  type BoardScheduleWhen,
  type EnvironmentId,
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
  type BoardProjectStageConfig,
  type BoardStageDefinition,
  type BoardStageExecutionPatch,
  type BoardState,
} from "@t3tools/contracts";

/** The tabs of a project's settings page, in order. */
export const BOARD_PROJECT_SETTINGS_TABS = [
  "pipeline",
  "ci",
  "schedules",
  "resources",
  "import",
] as const;
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

/** The step at `index` moved to position `target` (drag or up/down). */
export function moveBoardCiStep(
  steps: ReadonlyArray<BoardCiStep>,
  index: number,
  target: number,
): BoardCiStep[] {
  if (target === index || target < 0 || target >= steps.length) return [...steps];
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

/**
 * The set-stage-override input for one field's edit. The patch replaces the
 * stage's whole override, so it is built from the full delta (the shell has
 * no prompts) and checked against that delta's version; null until it loads.
 */
export function boardProjectOverrideEdit(
  full: BoardProjectStageConfig | null,
  stageId: string,
  key: string,
  value: unknown,
): {
  readonly patch: BoardStageExecutionPatch | null;
  readonly expectedConfigVersion: string;
} | null {
  if (full === null) return null;
  const next: Record<string, unknown> = { ...full.overrides[stageId] };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return {
    patch: Object.keys(next).length === 0 ? null : (next as BoardStageExecutionPatch),
    expectedConfigVersion: full.version,
  };
}

/** The new-card plan review keys a project may override on its planning stage. */
export type BoardPlanReviewOverrideKey = "enabled" | "rounds" | "unattended";

/** One new-card plan review override set (a value) or reset (undefined), keeping the other
    `planReview` keys; an emptied level drops out, so a full reset leaves no override. */
export function boardProjectPlanReviewOverrideEdit(
  full: BoardProjectStageConfig | null,
  stageId: string,
  key: BoardPlanReviewOverrideKey,
  value: boolean | number | undefined,
): ReturnType<typeof boardProjectOverrideEdit> {
  const current = full?.overrides[stageId]?.planReview;
  const newCards: Record<string, unknown> = { ...current?.newCards };
  if (value === undefined) delete newCards[key];
  else newCards[key] = value;
  const { newCards: _newCards, ...rest } = current ?? {};
  const planReview = Object.keys(newCards).length === 0 ? rest : { ...rest, newCards };
  return boardProjectOverrideEdit(
    full,
    stageId,
    "planReview",
    Object.keys(planReview).length === 0 ? undefined : planReview,
  );
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

// ── T3o: t3o.json schedules (T3O-117) ───────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "UTC", "UTC+1", "UTC-5:30". */
export function formatBoardUtcOffset(minutes: number): string {
  if (minutes === 0) return "UTC";
  const sign = minutes > 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  return `UTC${sign}${hours}${rest === 0 ? "" : `:${String(rest).padStart(2, "0")}`}`;
}

/** The readable "when". Every timer fires on the board server's clock, so a
    time of day always says so; an interval needs no zone. */
export function boardScheduleWhenText(
  schedule: BoardScheduleWhen,
  serverUtcOffsetMinutes: number | null,
): string {
  const when = describeScheduleWhen(schedule);
  return schedule.type === "interval" || serverUtcOffsetMinutes === null
    ? when
    : `${when}, server time (${formatBoardUtcOffset(serverUtcOffsetMinutes)})`;
}

/** A machine's name: "This server" for the board server. Child B names workers. */
export function boardScheduleMachineLabel(
  environmentId: EnvironmentId | null,
  serverEnvironmentId: EnvironmentId | null,
): string | null {
  if (environmentId === null) return null;
  return environmentId === serverEnvironmentId ? "This server" : environmentId;
}

const IMPORT_KIND_ORDER: Readonly<Record<BoardScheduleImportKind, number>> = {
  update: 0,
  adopt: 1,
  create: 2,
  delete: 3,
};

/** Updates, Adopts existing, Creates, Will be deleted. */
export function orderBoardImportSchedules(
  rows: ReadonlyArray<BoardScheduleImportRow>,
): ReadonlyArray<BoardScheduleImportRow> {
  return [...rows].sort((a, b) => IMPORT_KIND_ORDER[a.kind] - IMPORT_KIND_ORDER[b.kind]);
}

export const BOARD_IMPORT_SCHEDULE_KIND_LABELS: Readonly<Record<BoardScheduleImportKind, string>> =
  {
    create: "Creates",
    update: "Updates",
    adopt: "Adopts existing",
    delete: "Will be deleted",
  };

export const boardImportScheduleMark = (kind: BoardScheduleImportKind) =>
  kind === "create" ? "+" : kind === "delete" ? "\u2212" : "\u00b1";

export type BoardSchedulePlacements = Readonly<Record<string, EnvironmentId | null>>;

/** Own keys only: an id like `constructor` must not read the prototype. */
export const boardSchedulePlacement = (
  placements: BoardSchedulePlacements,
  fileId: string,
): EnvironmentId | null =>
  Object.hasOwn(placements, fileId) ? (placements[fileId] ?? null) : null;

/** What an import does to its schedules given the machines picked so far. */
export interface BoardImportScheduleSummary {
  /** Rows that will run, with their machine. */
  readonly scheduled: ReadonlyArray<BoardScheduleImportRow>;
  /** Updates and adoptions running somewhere today that stop with no machine. */
  readonly stops: ReadonlyArray<BoardScheduleImportRow>;
  readonly deletes: ReadonlyArray<BoardScheduleImportRow>;
  /** Rows a machine can be picked for (not deletions). */
  readonly placeable: number;
}

export function boardImportScheduleSummary(
  rows: ReadonlyArray<BoardScheduleImportRow>,
  placements: BoardSchedulePlacements,
): BoardImportScheduleSummary {
  const placeable = rows.filter((row) => row.kind !== "delete");
  const placed = (row: BoardScheduleImportRow) =>
    boardSchedulePlacement(placements, row.fileId) !== null;
  return {
    scheduled: placeable.filter(placed),
    stops: placeable.filter(
      (row) =>
        (row.kind === "update" || row.kind === "adopt") &&
        (row.currentEnvironmentId ?? null) !== null &&
        !placed(row),
    ),
    deletes: rows.filter((row) => row.kind === "delete"),
    placeable: placeable.length,
  };
}

/** "Replace and import", "Import and schedule 2", "Import and stop 1",
    "Import and schedule 2, stop 1". */
export function boardImportPrimaryLabel(summary: BoardImportScheduleSummary): string {
  const scheduled = summary.scheduled.length;
  const stops = summary.stops.length;
  if (scheduled > 0 && stops > 0) return `Import and schedule ${scheduled}, stop ${stops}`;
  if (scheduled > 0) return `Import and schedule ${scheduled}`;
  if (stops > 0) return `Import and stop ${stops}`;
  return "Replace and import";
}

/** The footer's grey count. */
export function boardImportFooterText(summary: BoardImportScheduleSummary): string | null {
  if (summary.placeable === 0) return null;
  const scheduled = summary.scheduled.length;
  const base =
    scheduled === 0
      ? "No schedules will run"
      : `${scheduled} of ${plural(summary.placeable, "schedule")} will run`;
  return summary.stops.length === 0 ? base : `${base} · ${summary.stops.length} will stop`;
}

/** The schedule chips: "3 schedules", "1 removed", then the live chip. */
export function boardImportScheduleChips(summary: BoardImportScheduleSummary): {
  readonly counts: ReadonlyArray<string>;
  readonly live: string | null;
} {
  if (summary.placeable === 0 && summary.deletes.length === 0) return { counts: [], live: null };
  const counts: string[] = [];
  if (summary.placeable > 0) counts.push(plural(summary.placeable, "schedule"));
  if (summary.deletes.length > 0) counts.push(`${summary.deletes.length} removed`);
  return {
    counts,
    live:
      summary.placeable === 0
        ? null
        : summary.scheduled.length === 0
          ? "None scheduled"
          : `${summary.scheduled.length} will run`,
  };
}

/** The verdict box under the Schedules header. */
export function boardImportScheduleVerdict(input: {
  readonly summary: BoardImportScheduleSummary;
  readonly placements: BoardSchedulePlacements;
  readonly projectTitle: string;
  readonly machineLabel: (environmentId: EnvironmentId | null) => string;
}): {
  readonly tone: "neutral" | "warning";
  readonly text: string;
  readonly stops: ReadonlyArray<string>;
  readonly deletes: ReadonlyArray<string>;
} {
  const { summary } = input;
  const scheduled = summary.scheduled;
  const text =
    scheduled.length === 0
      ? `Nothing will be scheduled. The file's ${plural(summary.placeable, "schedule")} ${summary.placeable === 1 ? "is" : "are"} listed under ${input.projectTitle} › Schedules as Not scheduled; pick a machine below, or there later.`
      : `${plural(scheduled.length, "schedule")} will run unattended, with full access to the machine: ${scheduled
          .map(
            (row) =>
              `'${row.title}' on ${input.machineLabel(boardSchedulePlacement(input.placements, row.fileId))}`,
          )
          .join(", ")}.`;
  return {
    tone: scheduled.length === 0 ? "neutral" : "warning",
    text,
    stops: summary.stops.map(
      (row) =>
        `'${row.title}' runs on ${input.machineLabel(row.currentEnvironmentId ?? null)} today. With no machine picked, it stops running there.`,
    ),
    deletes: summary.deletes.map(
      (row) =>
        `'${row.title}' is deleted${(row.currentEnvironmentId ?? null) === null ? "" : ` from ${input.machineLabel(row.currentEnvironmentId ?? null)}`}.`,
    ),
  };
}

/** The grey explanation line under a schedule row in the import dialog. */
export function boardImportScheduleExplanation(
  row: BoardScheduleImportRow,
  machineLabel: (environmentId: EnvironmentId | null) => string,
): string {
  const current = row.currentEnvironmentId ?? null;
  const where = current === null ? "isn't scheduled anywhere" : `runs on ${machineLabel(current)}`;
  switch (row.kind) {
    case "create":
      return "New task from the file. Imported as Not scheduled unless you pick a machine.";
    case "update":
      return `Set up by an earlier import · ${current === null ? "not scheduled today" : `runs on ${machineLabel(current)} today`}.`;
    case "adopt":
      return `A hand-made task with this title ${where}. After import, t3o.json manages it. Board tools limited to this schedule's own cards.`;
    case "delete":
      return `'${row.fileId}' is no longer in the file. Set up by an earlier import${current === null ? "" : ` on ${machineLabel(current)}`}.`;
  }
}

/** The Import tab's one-line reason per schedule, when only schedules differ. */
export function boardImportScheduleReason(row: BoardScheduleImportRow): string {
  switch (row.kind) {
    case "create":
      return `'${row.title}': new`;
    case "adopt":
      return `'${row.title}': takes over the hand-made task with this title`;
    case "delete":
      return `'${row.title}': no longer in the file, so it's deleted`;
    case "update": {
      const parts = row.changes
        .filter((change) => change.label !== "Machine")
        .map((change) =>
          change.label === "Prompt"
            ? "prompt changed"
            : `${change.label.toLowerCase()}: ${change.from} → ${change.to}`,
        );
      return `'${row.title}': ${parts.length === 0 ? "updated" : parts.join("; ")}`;
    }
  }
}

export interface BoardPromptDiffLine {
  readonly kind: "same" | "add" | "remove";
  readonly text: string;
}

/** A line diff (longest common subsequence) of an old prompt against a new one. */
export function boardPromptLineDiff(
  before: string,
  after: string,
): ReadonlyArray<BoardPromptDiffLine> {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: BoardPromptDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: "remove", text: a[i++]! });
    } else {
      out.push({ kind: "add", text: b[j++]! });
    }
  }
  while (i < a.length) out.push({ kind: "remove", text: a[i++]! });
  while (j < b.length) out.push({ kind: "add", text: b[j++]! });
  return out;
}

/** "52 words → 89 words · 3 lines added, 1 removed". */
export function boardPromptChangeSummary(before: string, after: string): string {
  const words = (text: string) => text.split(/\s+/).filter((word) => word.length > 0).length;
  const diff = boardPromptLineDiff(before, after);
  const added = diff.filter((line) => line.kind === "add").length;
  const removed = diff.filter((line) => line.kind === "remove").length;
  return `${plural(words(before), "word")} → ${plural(words(after), "word")} · ${plural(added, "line")} added, ${removed} removed`;
}

// Zero-width, joiner, bidi embedding/override/isolate marks, and the BOM: invisible, yet they
// change what an agent reads, so a prompt shows each one as its code point.
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

export function revealBoardPromptInvisibles(text: string): string {
  return text.replace(
    INVISIBLE_CHARS,
    (char) => `\u27e8U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}\u27e9`,
  );
}

export type BoardScheduleResultTone = "running" | "attention" | "warning" | "neutral" | "muted";

const shortTime = (iso: string, now: number) => {
  const date = new Date(iso);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `${time} today` : `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
};

/** A schedule's Last result: its dot tone and text. Green is never used: a
    finished turn can't be told apart as a success. */
export function boardScheduleLastResultView(
  row: Pick<BoardScheduleRow, "lastResult" | "missing" | "lastError" | "environmentId">,
  machineLabel: string | null,
  now: number,
): { readonly tone: BoardScheduleResultTone; readonly text: string } {
  if (row.missing) return { tone: "warning", text: "Stopped: its task was deleted by hand" };
  const result: BoardScheduleLastResult = row.lastResult;
  const at = result.at === null ? "" : ` · ${shortTime(result.at, now)}`;
  switch (result.kind) {
    case "never":
      return { tone: "muted", text: row.environmentId === null ? "Never run" : "Not run yet" };
    case "running":
      return {
        tone: "running",
        text: `Running${machineLabel === null ? "" : ` on ${machineLabel}`}${result.at === null ? "" : ` · started ${shortTime(result.at, now)}`}`,
      };
    case "waiting":
      return { tone: "attention", text: `Waiting on you${at}` };
    case "ran":
      return { tone: "neutral", text: `Ran${at}` };
    case "unknown":
      return { tone: "muted", text: `Unknown${at}` };
    case "failed-to-start":
      return {
        tone: "warning",
        text: `Failed to start${at}${result.detail ? ` · ${result.detail}` : ""}`,
      };
    case "missed":
      return {
        tone: "warning",
        text: `Missed${result.at === null ? "" : ` ${shortTime(result.at, now)}`} (server was off)`,
      };
    case "skipped":
      return { tone: "warning", text: `${result.detail ?? "Skipped"}${at}` };
    case "schedule-failed":
      return {
        tone: "warning",
        text: `Couldn't be scheduled${machineLabel === null ? "" : ` on ${machineLabel}`}${result.detail ? `: ${result.detail}` : ""}`,
      };
  }
}

/** Whether a row's last result is amber, for the tab badge and the projects chip. */
export function boardScheduleNeedsAttention(
  row: Pick<BoardScheduleRow, "lastResult" | "missing" | "lastError">,
): boolean {
  return (
    row.missing || row.lastError !== null || BOARD_SCHEDULE_AMBER_RESULTS.has(row.lastResult.kind)
  );
}

/** "in 7 h 18 min", "in 3 min", "now". Read at most once a minute. */
export function boardScheduleRelative(iso: string, now: number): string {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours} h${minutes % 60 === 0 ? "" : ` ${minutes % 60} min`}`;
  return `in ${Math.round(hours / 24)} days`;
}

/** The import result toast: main line, second line, and whether it stays. */
export function boardImportResultToast(input: {
  readonly projectTitle: string;
  readonly outcome: BoardScheduleImportOutcome | undefined;
  readonly machineLabel: (environmentId: EnvironmentId | null) => string;
}): { readonly title: string; readonly description: string | null; readonly failed: boolean } {
  const outcome = input.outcome;
  if (outcome === undefined) {
    return {
      title: `Imported ${input.projectTitle}'s t3o.json.`,
      description: null,
      failed: false,
    };
  }
  const tail = [
    outcome.setUp > 0 ? `${plural(outcome.setUp, "schedule")} set up` : null,
    outcome.stopped > 0 ? `${plural(outcome.stopped, "schedule")} stopped` : null,
    outcome.deleted > 0 ? `${plural(outcome.deleted, "schedule")} deleted` : null,
  ].filter((part) => part !== null);
  const failures = outcome.failures;
  if (failures.length === 0) {
    return {
      title: `Imported ${input.projectTitle}'s t3o.json.`,
      description: tail.length === 0 ? "No schedules set up." : `${tail.join(" · ")}.`,
      failed: false,
    };
  }
  if (failures.length === 1) {
    const failure = failures[0]!;
    return {
      title: `Imported; 1 schedule failed on ${input.machineLabel(failure.environmentId)}: ${failure.reason}`,
      description: `'${failure.title}' is listed as Not scheduled. Everything else was imported${tail.length === 0 ? "" : ` · ${tail.join(" · ")}`}.`,
      failed: true,
    };
  }
  return {
    title: `Imported; ${failures.length} schedules failed.`,
    description: failures
      .map(
        (failure) =>
          `'${failure.title}' on ${input.machineLabel(failure.environmentId)}: ${failure.reason}.`,
      )
      .join(" "),
    failed: true,
  };
}
