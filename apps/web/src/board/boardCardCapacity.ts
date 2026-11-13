/**
 * T3o: what a card's detail says about its size, reservation and setup (T3O-86). Pure, so
 * every line the panel shows is tested here.
 */
import {
  BOARD_CARD_SETUP_STAGES,
  BOARD_RESOURCE_DIMENSIONS,
  boardCardEffectiveSize,
  boardCardRequestedProfile,
  boardResourceProfileValue,
  resolveBoardProjectBaseline,
  type BoardCardResources,
  type BoardCardSetupResult,
  type BoardCardSize,
  type BoardProjectResources,
  type BoardResourceDimension,
  type BoardResourceProfile,
} from "@t3tools/contracts";

const UNITS = { cpu: "cores", ram: "GiB", disk: "GB" } as const;
const NAMES = { cpu: "CPU", ram: "RAM", disk: "Disk" } as const;

const round = (value: number) => Math.round(value * 10) / 10;

/** "4.5 cores · 12 GiB · 56 GB". */
export function boardProfileLine(profile: BoardResourceProfile): string {
  return BOARD_RESOURCE_DIMENSIONS.map(
    (dimension) => `${round(boardResourceProfileValue(profile, dimension))} ${UNITS[dimension]}`,
  ).join(" · ");
}

const sizeLine = (size: BoardCardSize) => `${size.cpu} · ${size.ram} · ${size.disk}`;

export interface BoardCardCapacityView {
  readonly size: BoardCardSize;
  readonly reservation: string;
  readonly baseline: string;
  /** "Edited by you · planner suggested M · M · M", or the planner's reason. */
  readonly provenance: string | null;
  readonly canReset: boolean;
  /** Amber: the size can't be placed on the card's worker. */
  readonly tooBig: string | null;
  /** Grey: a placed card keeps the size it was granted. */
  readonly granted: string | null;
}

/**
 * The size panel's lines. Too big applies only to a card with no worktree, against the
 * declared capacity of the worker it would run on; a placed card keeps what it was granted.
 */
export function boardCardCapacityView(input: {
  readonly resources: BoardCardResources | null;
  readonly projectResources: BoardProjectResources | null;
  readonly placed: boolean;
  readonly pinned: boolean;
  readonly worker: { readonly label: string; readonly declared: BoardResourceProfile } | null;
}): BoardCardCapacityView {
  const sizing = input.resources?.sizing ?? null;
  const size = boardCardEffectiveSize(sizing);
  const requested = boardCardRequestedProfile(input.resources, input.projectResources);
  const planner = sizing?.planner ?? null;
  const edit = sizing?.edit ?? null;
  const provenance =
    edit !== null
      ? `Edited by ${edit.by === "human" ? "you" : "an agent"}${
          planner === null ? "" : ` · planner suggested ${sizeLine(planner.size)}`
        }`
      : (planner?.reason ?? null);
  let tooBig: string | null = null;
  if (!input.placed && input.worker !== null) {
    const dimension = BOARD_RESOURCE_DIMENSIONS.find(
      (candidate) =>
        boardResourceProfileValue(requested, candidate) >
        boardResourceProfileValue(input.worker!.declared, candidate),
    );
    if (dimension !== undefined) tooBig = tooBigMessage(dimension, size, requested, input);
  }
  const grant = input.resources?.grant ?? null;
  const granted =
    input.placed &&
    grant !== null &&
    BOARD_RESOURCE_DIMENSIONS.some(
      (dimension) =>
        boardResourceProfileValue(grant.profile, dimension) !==
        boardResourceProfileValue(requested, dimension),
    )
      ? `Running at the size it was granted (${boardProfileLine(grant.profile)}). The new size applies if the card is placed again.`
      : null;
  return {
    size,
    reservation: boardProfileLine(requested),
    baseline: boardProfileLine(resolveBoardProjectBaseline(input.projectResources)),
    provenance,
    canReset: edit !== null && planner !== null,
    tooBig,
    granted,
  };
}

function tooBigMessage(
  dimension: BoardResourceDimension,
  size: BoardCardSize,
  requested: BoardResourceProfile,
  input: {
    readonly pinned: boolean;
    readonly worker: { readonly label: string; readonly declared: BoardResourceProfile } | null;
  },
): string {
  const worker = input.worker!;
  const need = round(boardResourceProfileValue(requested, dimension));
  const has = round(boardResourceProfileValue(worker.declared, dimension));
  // The card's own size at M still too big means the baseline is the cause.
  const cause =
    size[dimension] === "M" || size[dimension] === "S"
      ? "Lower the project's baseline"
      : "Lower the size";
  return `${NAMES[dimension]} ${size[dimension]} needs ${need} ${UNITS[dimension]}; ${worker.label} has ${has}. ${cause}${
    input.pinned ? ", or unpin" : ""
  }.`;
}

/** "6m 12s", "48s". */
export function boardDurationLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds % 60}s`;
}

const STAGE_LABELS = {
  fetch: "Fetch",
  checkout: "Checkout",
  submodules: "Submodules",
  "setup-script": "Setup script",
} as const;

export interface BoardCardSetupView {
  /** "Preparing · 3/4", "Setup failed · 3/4", or null when there is nothing to show. */
  readonly face: string | null;
  readonly faceTone: "running" | "blocked" | null;
  /** 0 to 4 stages done, for the face's stepped bar. */
  readonly done: number;
  /** "Setup · build-01 · 6m 12s", once it succeeded. */
  readonly collapsed: string | null;
  readonly stages: ReadonlyArray<{
    readonly label: string;
    readonly status: "done" | "running" | "pending" | "failed" | "skipped";
  }>;
  readonly canRetry: boolean;
  readonly canCancel: boolean;
  readonly failure: string | null;
}

/**
 * A card's setup as the face and detail show it. A failure turns the card amber only when the
 * setup holds the agent, or when the step it ran beside has ended without success.
 */
export function boardCardSetupView(input: {
  readonly setup: BoardCardSetupResult | null;
  readonly workerLabel: string;
  readonly stepRunning: boolean;
}): BoardCardSetupView {
  const setup = input.setup;
  if (setup === null) {
    return {
      face: null,
      faceTone: null,
      done: 0,
      collapsed: null,
      stages: [],
      canRetry: false,
      canCancel: false,
      failure: null,
    };
  }
  const at = BOARD_CARD_SETUP_STAGES.indexOf(setup.stage);
  const done = setup.status === "succeeded" ? BOARD_CARD_SETUP_STAGES.length : Math.max(0, at);
  const stages = BOARD_CARD_SETUP_STAGES.map((stage, index) => ({
    label: STAGE_LABELS[stage],
    status:
      setup.status === "succeeded" || index < at
        ? ("done" as const)
        : index === at
          ? setup.status === "running"
            ? ("running" as const)
            : ("failed" as const)
          : setup.status === "running"
            ? ("pending" as const)
            : ("skipped" as const),
  }));
  const failed = setup.status === "failed" || setup.status === "cancelled";
  const amber = failed && (setup.blocking || !input.stepRunning);
  return {
    face:
      setup.status === "running"
        ? `Preparing · ${done}/4`
        : amber
          ? `Setup failed · ${done}/4`
          : null,
    faceTone: setup.status === "running" ? "running" : amber ? "blocked" : null,
    done,
    collapsed:
      setup.status === "succeeded"
        ? `Setup · ${input.workerLabel}${
            setup.durationMs === null ? "" : ` · ${boardDurationLabel(setup.durationMs)}`
          }`
        : null,
    stages,
    canRetry: failed,
    canCancel: setup.status === "running",
    failure: failed
      ? setup.status === "cancelled"
        ? "Setup was cancelled."
        : `${STAGE_LABELS[setup.stage]} failed${
            setup.exitCode === null ? "" : ` (exit ${setup.exitCode})`
          }${setup.detail === null ? "." : `: ${setup.detail}`}`
      : null,
  };
}

/** A card face's setup line: Preparing n/4 (blue) or Setup failed n/4 (amber), or nothing. */
export function boardCardSetupFace(
  setup: Pick<BoardCardSetupResult, "status" | "stage" | "blocking"> | undefined,
  stepRunning: boolean,
): { readonly label: string; readonly tone: "running" | "blocked"; readonly done: number } | null {
  if (setup === undefined) return null;
  const view = boardCardSetupView({
    setup: {
      ...setup,
      exitCode: null,
      startedAt: "",
      durationMs: null,
      workerId: "",
      detail: null,
    },
    workerLabel: "",
    stepRunning,
  });
  return view.face === null || view.faceTone === null
    ? null
    : { label: view.face, tone: view.faceTone, done: view.done };
}
