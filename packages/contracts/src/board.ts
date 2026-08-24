/**
 * T3o board schema — the full card domain model (t3o-03) on the generalised
 * seams (t3o-02a).
 *
 * Everything board-shaped lives here, in a T3o-owned file, so upstream merges
 * never touch it. This file deliberately imports only from `baseSchemas.ts`
 * and `auth.ts` (which itself imports only `baseSchemas.ts`):
 * `orchestration.ts` imports this module to append board members to its
 * unions, so an import in the other direction would be a module cycle.
 *
 * The upstream seams in `orchestration.ts` are spreads of the registries at
 * the bottom of this file (`BOARD_CLIENT_COMMANDS`, `BOARD_EVENT_TYPES`,
 * `BOARD_SHELL_STREAM_EVENTS`) plus one injected-factory call
 * (`makeBoardOrchestrationEvents`). Adding a board command or event grows
 * those registries here and touches no upstream-owned file.
 *
 * The `board.` prefix rule is load-bearing: every board command and event
 * `type` starts with `board.`, and every board shell delta `kind` starts with
 * `card-`. The type guards below key on those prefixes, and a board command
 * named without the prefix falls outside `Extract<..., { type:
 * \`board.${string}\` }>`, reaches upstream's `satisfies never`, and fails
 * the build.
 *
 * Event payload shape: `board.card-created` is flat (its walking-skeleton
 * form is already persisted in real event logs, so new fields carry decoding
 * defaults). Every later event carries the full post-change `card` alongside
 * its semantic fields — the shell delta mapping in ws.ts is a pure function
 * of the event with no projection re-read, so the event must contain
 * everything the shell needs, and the projectors get replay determinism for
 * free by upserting exactly what the decider computed.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { AuthOrchestrationReadScope, EnvironmentAuthorizationError } from "./auth.ts";
import { DEFAULT_RUNTIME_MODE, ProviderOptionSelections, RuntimeMode } from "./model.ts";
import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const BoardCardId = TrimmedNonEmptyString.pipe(Schema.brand("BoardCardId"));
export type BoardCardId = typeof BoardCardId.Type;

export const BoardLabelId = TrimmedNonEmptyString.pipe(Schema.brand("BoardLabelId"));
export type BoardLabelId = typeof BoardLabelId.Type;

// ── Labels (t3o-06a) ───────────────────────────────────────────────────
// The user-managed vocabulary that replaces the closed `BoardCardType`
// union: a catalogue of named, coloured labels (its own aggregate, D9-class)
// and a per-card `labels: BoardLabelId[]`. Labels are a SECOND board
// aggregate kind — `"label"` joins `"card"` in `OrchestrationAggregateKind`
// and `BoardLabelId` joins the aggregate-id unions (the once-only widenings
// recorded in the seam inventory). Every other part of labels grows the
// board-owned registries at the bottom of this file, touching no upstream
// file.

/** Colour is a 6-digit hex, validated against a bounded pattern — the 24
    swatches below are all 6-digit, and free choice is allowed as long as it
    matches. Not branded: it stays a plain string so seed constants and test
    fixtures need no `.make`. */
export const BOARD_LABEL_COLOUR_PATTERN = /^#[0-9a-fA-F]{6}$/;
export const BoardLabelColour = TrimmedNonEmptyString.check(
  Schema.isPattern(BOARD_LABEL_COLOUR_PATTERN),
);
export type BoardLabelColour = typeof BoardLabelColour.Type;

/**
 * Label names are length-bounded (D7 payload discipline): the catalogue rides
 * every shell snapshot, so an unbounded name would let one label bloat the
 * payload every client pulls on reconnect — the same discipline the card
 * title's byte cap enforces. Validated on the command (rejected at decode) and
 * on the stored `BoardLabel`, so no path introduces an over-long name. 64 is
 * generous for a chip label; the prototype's are single words.
 */
export const BOARD_LABEL_NAME_MAX_LENGTH = 64;
export const BoardLabelName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(BOARD_LABEL_NAME_MAX_LENGTH),
);
export type BoardLabelName = typeof BoardLabelName.Type;

/**
 * The prototype's 24-entry swatch (`LABEL_SWATCHES`): the default colour
 * path for a new label. Free hex is still allowed, but the swatch is what
 * `pickNextBoardLabelColour` walks so back-to-back creations do not collide.
 */
export const BOARD_LABEL_SWATCHES = [
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#eab308",
  "#84cc16",
  "#22c55e",
  "#10b981",
  "#14b8a6",
  "#06b6d4",
  "#0ea5e9",
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#a855f7",
  "#d946ef",
  "#ec4899",
  "#f43f5e",
  "#78716c",
  "#a1a1aa",
  "#64748b",
  "#0f766e",
  "#7c2d12",
  "#1e40af",
  "#4c1d95",
] as const;

/**
 * New-label colour assignment, ported from the prototype's `addLabel`: walk
 * the swatch from `catalogueSize * stride` (stride 7 is coprime with 24, so
 * each pick lands ~105° away on the wheel) and skip colours already in use,
 * so two labels created back to back get different swatch colours. Falls
 * back to the strided entry when every swatch is in use. Fed the live label
 * colours by the decider (D8: the decider branches on the catalogue, so the
 * catalogue lives in the read model).
 */
export function pickNextBoardLabelColour(usedColours: ReadonlyArray<string>): BoardLabelColour {
  const stride = 7;
  const size = usedColours.length;
  const base = BOARD_LABEL_SWATCHES[(size * stride) % BOARD_LABEL_SWATCHES.length]!;
  for (let offset = 0; offset < BOARD_LABEL_SWATCHES.length; offset += 1) {
    const candidate = BOARD_LABEL_SWATCHES[(size * stride + offset) % BOARD_LABEL_SWATCHES.length]!;
    if (!usedColours.includes(candidate)) return candidate;
  }
  return base;
}

/**
 * The label catalogue entry. Deleting is a tombstone (`deletedAt` set), not
 * a removal — the same choice t3o-03 made for thread links: a card carrying
 * a retired label keeps rendering it (muted) rather than silently losing
 * information (referential integrity, option 3 in the spec). `deletedAt` set
 * hides the label from the picker; undelete clears it (reverse states).
 */
export const BoardLabel = Schema.Struct({
  labelId: BoardLabelId,
  name: BoardLabelName,
  colour: BoardLabelColour,
  deletedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BoardLabel = typeof BoardLabel.Type;

/** Max labels a single card may carry (enforced in the decider). Uncapped,
    the shell's `labelIds` array is unbounded and the card design has no
    worst case to lay out for. */
export const BOARD_CARD_LABELS_MAX = 5;

/**
 * Canonical label order — (createdAt, labelId) by code units, the same
 * comparator family as `compareBoardCards`. Applied on BOTH sides of the
 * replay-equals-rehydration invariant: the projector keeps the read model's
 * labels sorted with it, and `loadBoardState` re-sorts rows read back from
 * `board_labels` with it, so replay and table rehydration cannot diverge on
 * catalogue order. The seed labels below carry staggered genesis timestamps
 * precisely so this comparator reproduces their feature/bug/chore order.
 */
export function compareBoardLabels(left: BoardLabel, right: BoardLabel): number {
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return compare(left.createdAt, right.createdAt) || compare(left.labelId, right.labelId);
}

// ── Seed labels ────────────────────────────────────────────────────────
// The three prototype values (`SEED_LABELS`) at their prototype colours.
// They are COMPILED into `EMPTY_BOARD_STATE` (below) and inserted verbatim
// by the 906 data migration, so both the from-empty event replay and the
// table rehydration start from an identical catalogue — a migration writes
// tables but emits no event, so the only way replay can reproduce the seeds
// is to start from them. Ids and timestamps are therefore FIXED and must
// never change. The staggered millisecond timestamps make `compareBoardLabels`
// reproduce the feature → bug → chore order deterministically.

export const BOARD_SEED_LABEL_IDS = {
  feature: BoardLabelId.make("label-feature"),
  bug: BoardLabelId.make("label-bug"),
  chore: BoardLabelId.make("label-chore"),
} as const;

const BOARD_SEED_LABEL_AT = {
  feature: "1970-01-01T00:00:00.000Z",
  bug: "1970-01-01T00:00:00.001Z",
  chore: "1970-01-01T00:00:00.002Z",
} as const;

export const BOARD_SEED_LABELS: ReadonlyArray<BoardLabel> = [
  {
    labelId: BOARD_SEED_LABEL_IDS.feature,
    name: "feature",
    colour: "#3b82f6",
    deletedAt: null,
    createdAt: BOARD_SEED_LABEL_AT.feature,
    updatedAt: BOARD_SEED_LABEL_AT.feature,
  },
  {
    labelId: BOARD_SEED_LABEL_IDS.bug,
    name: "bug",
    colour: "#ef4444",
    deletedAt: null,
    createdAt: BOARD_SEED_LABEL_AT.bug,
    updatedAt: BOARD_SEED_LABEL_AT.bug,
  },
  {
    labelId: BOARD_SEED_LABEL_IDS.chore,
    name: "chore",
    colour: "#f59e0b",
    deletedAt: null,
    createdAt: BOARD_SEED_LABEL_AT.chore,
    updatedAt: BOARD_SEED_LABEL_AT.chore,
  },
];

/**
 * Whether a catalogue is exactly the compiled seed set, untouched — no label
 * created, renamed, recoloured or deleted. `loadBoardState` uses it to decide
 * a no-card board is still "empty" and report the board slice as absent (the
 * decider falls back to `EMPTY_BOARD_STATE`, which carries the same seeds), so
 * a migrated-but-unused board rehydrates to the same read model a from-empty
 * replay produces — a migration seeds tables but emits no event. Assumes the
 * input is in canonical `compareBoardLabels` order (both `loadBoardState` and
 * `BOARD_SEED_LABELS` are).
 */
export function boardLabelsAreSeedOnly(labels: ReadonlyArray<BoardLabel>): boolean {
  if (labels.length !== BOARD_SEED_LABELS.length) return false;
  return labels.every((label, index) => {
    const seed = BOARD_SEED_LABELS[index]!;
    return (
      label.labelId === seed.labelId &&
      label.name === seed.name &&
      label.colour === seed.colour &&
      label.deletedAt === seed.deletedAt &&
      label.createdAt === seed.createdAt &&
      label.updatedAt === seed.updatedAt
    );
  });
}

/**
 * The closed type union that labels replace, kept ONLY to decode
 * walking-skeleton / pre-t3o-06a `board.card-created` events and pre-migration
 * rows, which still carry a `cardType`. New events carry `labels`; no live
 * command or card field references this. A legacy card's single type maps to
 * exactly one seed label, so the 906 migration is a rename in disguise.
 */
export const LegacyBoardCardType = Schema.Literals(["feature", "bug", "chore"]);
export type LegacyBoardCardType = typeof LegacyBoardCardType.Type;

export function legacyBoardCardTypeLabelId(type: LegacyBoardCardType): BoardLabelId {
  return BOARD_SEED_LABEL_IDS[type];
}

// ── Stages (t3o-15) ────────────────────────────────────────────────────
// Stages are a user-editable board read-model aggregate (D2): created,
// renamed, reordered and deleted through decider-gated commands. `build`,
// `review` and `done` are the product spine (D3) — exactly one stage holds
// each role, and nothing keys on a stage's NAME any more. What a stage IS
// (id, label, role, order) lives here; what a stage DOES (prompt, model,
// mode, execution) lives in settings keyed by stage id (D4).

/**
 * A stage's stable identity — an open branded string (D3), not a closed
 * literal: a user-invented stage is a first-class id, and a persisted event
 * naming a since-deleted stage still decodes. Card `stage` fields and the
 * `card-created` / `card-moved` payloads carry this.
 */
export const BoardStageId = TrimmedNonEmptyString.pipe(Schema.brand("BoardStageId"));
export type BoardStageId = typeof BoardStageId.Type;

/**
 * The four product roles (D3). Exactly one stage holds each; every other
 * stage carries a null role. Plan-mode forcing and the plan deliverable
 * contract (`plan`), dependency blocking (`build`), the review loop
 * (`review`) and archival / dependency satisfaction (`done`) key on the role,
 * never on a stage name.
 */
export const BoardStageRole = Schema.Literals(["plan", "build", "review", "done"]);
export type BoardStageRole = typeof BoardStageRole.Type;

/**
 * A stage definition in the read model (D2). `orderKey` is a fractional
 * ordering key (the same client-computed / server-stored scheme cards use),
 * so a reorder rewrites one stage rather than the whole column; stages sort by
 * `compareBoardStages` (orderKey, then stageId). Embedded in persisted event
 * payloads, so the id must decode even after the stage is deleted.
 */
export const BoardStageDefinition = Schema.Struct({
  stageId: BoardStageId,
  label: TrimmedNonEmptyString,
  role: Schema.NullOr(BoardStageRole),
  orderKey: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BoardStageDefinition = typeof BoardStageDefinition.Type;

/** The eight compiled-in seed stages ship with fixed ids matching the legacy
    stage names, so persisted card `stage` values keep resolving. Roles anchor
    Building / Code review / Done; the rest are ordinary movable stages. */
export const BOARD_SEED_STAGE_IDS = {
  backlog: BoardStageId.make("backlog"),
  sprint: BoardStageId.make("sprint"),
  planning: BoardStageId.make("planning"),
  ready: BoardStageId.make("ready"),
  building: BoardStageId.make("building"),
  review: BoardStageId.make("review"),
  merge: BoardStageId.make("merge"),
  done: BoardStageId.make("done"),
} as const;

// Staggered genesis timestamps, mirroring `BOARD_SEED_LABEL_AT`: a canonical
// (orderKey, stageId) sort makes a from-empty replay and a table rehydration
// produce an identical stage list, and the createdAt values are stable seeds.
const BOARD_SEED_STAGE_AT = {
  backlog: "1970-01-01T00:00:00.000Z",
  sprint: "1970-01-01T00:00:00.001Z",
  planning: "1970-01-01T00:00:00.002Z",
  ready: "1970-01-01T00:00:00.003Z",
  building: "1970-01-01T00:00:00.004Z",
  review: "1970-01-01T00:00:00.005Z",
  merge: "1970-01-01T00:00:00.006Z",
  done: "1970-01-01T00:00:00.007Z",
} as const;

// Spaced single-character order keys, leaving room for `pinOrderKeyBetween`
// to bisect between any two neighbours when a stage is created or reordered.
const BOARD_SEED_STAGE_SHAPES: ReadonlyArray<{
  readonly stageId: BoardStageId;
  readonly label: string;
  readonly role: BoardStageRole | null;
  readonly orderKey: string;
}> = [
  { stageId: BOARD_SEED_STAGE_IDS.backlog, label: "Backlog", role: null, orderKey: "b" },
  { stageId: BOARD_SEED_STAGE_IDS.sprint, label: "Sprint", role: null, orderKey: "d" },
  { stageId: BOARD_SEED_STAGE_IDS.planning, label: "Planning", role: "plan", orderKey: "f" },
  { stageId: BOARD_SEED_STAGE_IDS.ready, label: "Ready", role: null, orderKey: "h" },
  { stageId: BOARD_SEED_STAGE_IDS.building, label: "Building", role: "build", orderKey: "j" },
  { stageId: BOARD_SEED_STAGE_IDS.review, label: "Code review", role: "review", orderKey: "l" },
  { stageId: BOARD_SEED_STAGE_IDS.merge, label: "Ready for merge", role: null, orderKey: "n" },
  { stageId: BOARD_SEED_STAGE_IDS.done, label: "Done", role: "done", orderKey: "p" },
];

export const BOARD_SEED_STAGES: ReadonlyArray<BoardStageDefinition> = BOARD_SEED_STAGE_SHAPES.map(
  (seed): BoardStageDefinition => {
    const at = BOARD_SEED_STAGE_AT[seed.stageId as keyof typeof BOARD_SEED_STAGE_AT];
    return { ...seed, createdAt: at, updatedAt: at };
  },
);

/** Canonical stage order: (orderKey, stageId) by code units — total and
    deterministic, applied on both the replay and rehydration paths so SQL
    collation can never make the two disagree. */
export function compareBoardStages(a: BoardStageDefinition, b: BoardStageDefinition): number {
  const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  return compare(a.orderKey, b.orderKey) || compare(a.stageId, b.stageId);
}

/** Whether a stage list is exactly the compiled seed set, untouched — the
    stage analogue of `boardLabelsAreSeedOnly`, used by `loadBoardState` to
    report an unused board's slice as absent so rehydration equals a from-empty
    replay. Assumes canonical `compareBoardStages` order (both inputs are). */
export function boardStagesAreSeedOnly(stages: ReadonlyArray<BoardStageDefinition>): boolean {
  if (stages.length !== BOARD_SEED_STAGES.length) return false;
  return stages.every((stage, index) => {
    const seed = BOARD_SEED_STAGES[index]!;
    return (
      stage.stageId === seed.stageId &&
      stage.label === seed.label &&
      // A table seeded before the `plan` role existed carries Planning with a
      // null role; treat it as untouched so rehydration falls back to the
      // compiled seeds (which now carry the role) instead of pinning the
      // legacy shape forever.
      (stage.role === seed.role ||
        (stage.stageId === BOARD_SEED_STAGE_IDS.planning && stage.role === null)) &&
      stage.orderKey === seed.orderKey &&
      stage.createdAt === seed.createdAt &&
      stage.updatedAt === seed.updatedAt
    );
  });
}

/** The role a seeded stage id implies. Roles are seeded, never created (the
    decider rejects a second holder), so a stage id ↔ role mapping is exact:
    custom stages get UUID ids and a null role. */
export function boardSeedStageRole(stageId: string): BoardStageRole | null {
  switch (stageId) {
    case BOARD_SEED_STAGE_IDS.planning:
      return "plan";
    case BOARD_SEED_STAGE_IDS.building:
      return "build";
    case BOARD_SEED_STAGE_IDS.review:
      return "review";
    case BOARD_SEED_STAGE_IDS.done:
      return "done";
    default:
      return null;
  }
}

/**
 * A stage's effective role. The `plan` role postdates persisted stage lists
 * and event payloads that carry Planning with a null role, so every reader
 * that keys behavior on a role — delete guards, role uniqueness, envelope
 * segments, the settings card — resolves through this helper rather than the
 * raw field.
 */
export function effectiveBoardStageRole(
  stage: Pick<BoardStageDefinition, "stageId" | "role">,
): BoardStageRole | null {
  return stage.role ?? boardSeedStageRole(stage.stageId);
}

// ── Card pieces ────────────────────────────────────────────────────────

/**
 * Thread link (D9). `role` is a free string discriminator (`planning`,
 * `build`, `review:r1:triage`, …) so the review pipeline can extend it
 * without a schema change. A deleted thread's link is never removed, only
 * tombstoned — recorded when the link is next touched: unlinking a deleted
 * thread sets `tombstonedAt` instead of removing the link. (Nothing reacts
 * to `thread.deleted` itself in t3o-03; eager tombstoning needs the Phase-2
 * reactor seam, t3o-10.)
 */
export const BoardCardThreadLink = Schema.Struct({
  threadId: ThreadId,
  role: TrimmedNonEmptyString,
  linkedAt: IsoDateTime,
  tombstonedAt: Schema.NullOr(IsoDateTime),
});
export type BoardCardThreadLink = typeof BoardCardThreadLink.Type;

/**
 * Canonical thread-link order: (linkedAt, threadId), needed because linkedAt
 * is client-supplied, so link order ≠ linkedAt order in general. Compared by
 * code units (not localeCompare, which is locale-sensitive) and applied on
 * BOTH sides of the replay-equals-rehydration invariant: the decider sorts
 * links into event payloads with it, and the board projection re-sorts rows
 * read back from `board_card_thread_links` with it — never trusting SQL
 * collation to agree with JS.
 */
export function sortBoardCardThreadLinks(
  links: ReadonlyArray<BoardCardThreadLink>,
): ReadonlyArray<BoardCardThreadLink> {
  const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  return [...links].sort(
    (left, right) =>
      compare(left.linkedAt, right.linkedAt) || compare(left.threadId, right.threadId),
  );
}

/** External tracker escape hatch (D14): exists from day one so import from,
    and later sync to, GitHub Issues / Linear / Jira is a field, not a
    migration. */
export const BoardCardExternalRef = Schema.Struct({
  system: TrimmedNonEmptyString,
  id: TrimmedNonEmptyString,
  url: Schema.NullOr(TrimmedNonEmptyString),
});
export type BoardCardExternalRef = typeof BoardCardExternalRef.Type;

// ── Stage execution primitives (D4/D5, t3o-15) ─────────────────────────
// Every stage runs exactly one step, seeded from code (D1); the step's shape
// is no longer user data. What the step does — prompt, model, mode, timeout,
// attempts, human-in-the-loop — is the stage's execution config in settings
// (`BoardStageExecution`, at the bottom of this file), resolved and FROZEN onto
// the card's step-state row at stage entry (D12). These two small primitives —
// the model selection and the mode — are the pieces both the settings config
// and the frozen run-row share, defined here because `BoardCardStepState`
// (below) references them.

/**
 * A provider instance + model pair (D4), the board-local mirror of upstream's
 * `ModelSelection`. Defined here rather than imported because `orchestration.ts`
 * imports this module (importing back would be a cycle). A stage config's
 * `model` is `BoardModelSelection | null`; `null` means "run on the global
 * text-generation model", resolved to a concrete pair at stage entry (D12).
 */
export const BoardModelSelection = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  /** Reasoning/effort and other per-model option selections (t3o-21), mirroring
      `ModelSelection.options` so `createModelSelection(instanceId, model,
      options)` round-trips. Optional: a stage that never set an effort has no
      key, and the option vocabulary is per-model (resolved in the picker). */
  options: Schema.optional(ProviderOptionSelections),
});
export type BoardModelSelection = typeof BoardModelSelection.Type;

/**
 * Mode governs resources (D5): `plan` runs read-only with no worktree, no
 * branch and no concurrency slot; `build` provisions a worktree, writes, and
 * holds a slot. Orthogonal to human-in-the-loop, which governs the
 * conversation.
 */
export const BoardStageMode = Schema.Literals(["plan", "build"]);
export type BoardStageMode = typeof BoardStageMode.Type;

/** The `kind` under which a card's brief body is stored in
    `board_card_bodies`; `BoardCard.briefRef` holds it when a brief exists. */
export const BOARD_CARD_BRIEF_BODY_KIND = "brief";

// ── Worktree / branch lifecycle (t3o-09, D6) ───────────────────────────

/**
 * Provisioning state of a card's worktree — the "step with its own state,
 * retries and visible failure" the lazy-worktree design (D6) demands.
 * Worktree creation runs `runOnWorktreeCreate` (minutes and gigabytes), so
 * it is a real step, never a silent precondition: a card stuck installing
 * dependencies must be able to say so, and a failed `git worktree add` must
 * surface as a retryable step rather than a wedged card.
 *
 * - `provisioning` — the step is in flight (branch + `git worktree add` +
 *   setup script). `path` is still null.
 * - `ready` — the worktree exists on disk at `path`; every subsequent thread
 *   on the card is created against it.
 * - `failed` — provisioning failed; `lastError` says why, and a retry re-runs
 *   the step (`attempts` counts them).
 * - `reclaimed` — the worktree was removed (D6/D15: reclaimed at archive);
 *   `path` returns to null. This is the reverse state worktree creation owes.
 */
export const BoardCardWorktreeStatus = Schema.Literals([
  "provisioning",
  "ready",
  "failed",
  "reclaimed",
]);
export type BoardCardWorktreeStatus = typeof BoardCardWorktreeStatus.Type;

/** Outcome of a reclaim attempt (D6): the worktree was `removed`, or the
    reclaim was `blocked` because the tree was not clean-and-pushed and
    deleting it would lose work. */
export const BoardCardWorktreeReclaimOutcome = Schema.Literals(["removed", "blocked"]);
export type BoardCardWorktreeReclaimOutcome = typeof BoardCardWorktreeReclaimOutcome.Type;

/**
 * The branch + worktree a card owns once it enters Building (D6). Absent
 * (`BoardCard.worktree === null`) for every card that has not entered
 * Building — a planned card left for a week has no branch and no worktree,
 * which is the entire point of laziness. Created on entry to Building and
 * reclaimed at archive; the reverse state (D6/D15) is `status: "reclaimed"`
 * with a null `path`.
 */
export const BoardCardWorktree = Schema.Struct({
  /** The card's branch, created from `baseRefName`. */
  branch: TrimmedNonEmptyString,
  /** Default branch for a top-level card, or the parent card's integration
      branch for a sub-board plan card (D12). */
  baseRefName: TrimmedNonEmptyString,
  /** Filesystem path of the worktree; null while provisioning and again once
      reclaimed. */
  path: Schema.NullOr(TrimmedNonEmptyString),
  status: BoardCardWorktreeStatus,
  /** Provisioning attempts, so a retried step is visible rather than silent. */
  attempts: PositiveInt,
  /** Failure detail when `status` is `failed`; null otherwise. */
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  /** Why the most recent reclaim was skipped (dirty tree, unpushed commits) —
      reclaim never deletes uncommitted work to save disk, it flags the card
      and skips (D6). Null when no reclaim has been blocked. */
  reclaimBlockedReason: Schema.NullOr(TrimmedNonEmptyString),
});
export type BoardCardWorktree = typeof BoardCardWorktree.Type;

// ── Card aggregate ─────────────────────────────────────────────────────

export const BoardCard = Schema.Struct({
  id: BoardCardId,
  /** Generated `<prefix>-<cardNumber>`, e.g. "T3-195" (D14). */
  key: TrimmedNonEmptyString,
  /** The per-project counter value `key` was allocated from; kept so the
      counter can be rebuilt exactly on rehydration and replay. */
  cardNumber: NonNegativeInt,
  projectId: ProjectId,
  /** User-managed label vocabulary (t3o-06a), replacing the closed
      `BoardCardType`. Mirrors `dependsOn`: an ordered id array, the names and
      colours never denormalised onto the card (they ride the catalogue once).
      Capped at `BOARD_CARD_LABELS_MAX` by the decider. May reference a
      tombstoned label (rendered muted) — deleting a label never rewrites the
      cards that carry it. */
  labels: Schema.Array(BoardLabelId),
  stage: BoardStageId,
  /** Fractional ordering key within the stage column, following the
      `pinOrderKey` precedent: the client computes it (threadSort.ts helpers)
      and the server stores it. */
  orderKey: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  /** Body kind in `board_card_bodies` when a brief exists (D8: bodies never
      ride the read model); null when the card has no brief. */
  briefRef: Schema.NullOr(TrimmedNonEmptyString),
  dependsOn: Schema.Array(BoardCardId),
  /** Null for top-level cards; set for sub-board plan cards. Schema only in
      MVP — no t3o-03 command writes it (D12 materialisation is post-MVP). */
  parentCardId: Schema.NullOr(BoardCardId),
  threadLinks: Schema.Array(BoardCardThreadLink),
  externalRef: Schema.NullOr(BoardCardExternalRef),
  /** Per-card human-in-the-loop override on the Build stage (D6). `null` means
      untouched — the effective value is computed from the build stage's
      `humanInLoopWithPlan` / `humanInLoopWithoutPlan` settings and whether the
      card has a plan, so writing a plan moves the default with it. Flipping the
      toggle writes an explicit boolean that survives. Decodes to null on legacy
      payloads. Only the build role reads it. */
  humanInLoop: Schema.NullOr(Schema.Boolean).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Branch + worktree the card owns once it enters Building (D6, t3o-09);
      null for every card that has not — planning is worktree-free. Decodes
      to null on the legacy `card`-carrying event payloads written before
      t3o-09, so a from-empty replay of a pre-t3o-09 log matches the
      table-rehydrated model (migration 904's `worktree` column defaults to
      NULL to the same end). */
  worktree: Schema.NullOr(BoardCardWorktree).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Derived from unmet dependencies at Ready and beyond (D18), recorded by
      the decider at each move / dependency edit / unarchive. */
  blocked: Schema.Boolean,
  archivedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BoardCard = typeof BoardCard.Type;

/**
 * The unmet subset of a card's dependencies. A dependency is met when its
 * card is in `done`, and it stops gating entirely once its card is archived
 * (t3o-13, D1): archiving means the work is not happening, so a gate waiting
 * on it is a deadlock, not a gate. An unknown id still counts as unmet —
 * nothing can prove it finished. The single definition of "unmet" —
 * `deriveBoardCardBlocked` and the decider's past-Ready move gate both build
 * on it, so the blocked flag and the rejection message can never disagree
 * about which dependencies are outstanding.
 *
 * The edge itself survives archiving, so unarchiving the dependency puts the
 * gate straight back with no restoration bookkeeping.
 */
export function unmetBoardCardDependencies(input: {
  /** The board, read for the `done`-role stage id (D3): satisfaction keys on
      the role, not on a stage literally named "done". */
  readonly board: BoardState;
  readonly dependsOn: ReadonlyArray<BoardCardId>;
  readonly cards: ReadonlyArray<Pick<BoardCard, "id" | "stage" | "archivedAt">>;
}): ReadonlyArray<BoardCardId> {
  const doneStageId = boardStageWithRole(input.board, "done")?.stageId ?? null;
  return input.dependsOn.filter((dependencyId) => {
    const dependency = input.cards.find((card) => card.id === dependencyId);
    if (dependency === undefined) return true;
    if (dependency.archivedAt !== null) return false;
    // No done role (never in practice — the role is undeletable) means nothing
    // can be proven done, so every dependency stays unmet.
    return doneStageId === null ? true : dependency.stage !== doneStageId;
  });
}

/**
 * Blocked derivation (D11): unmet dependencies block a card from the `build`
 * role onward and never earlier — no Ready anchor, whatever the stages are
 * called. Shared by the decider and any client that wants a live view.
 */
export function deriveBoardCardBlocked(input: {
  readonly board: BoardState;
  readonly stage: BoardStageId;
  readonly dependsOn: ReadonlyArray<BoardCardId>;
  readonly cards: ReadonlyArray<Pick<BoardCard, "id" | "stage" | "archivedAt">>;
}): boolean {
  if (!isBoardStageAtOrAfterBuild(input.board, input.stage)) return false;
  return unmetBoardCardDependencies(input).length > 0;
}

// ── Agent write-path value types (t3o-08) ──────────────────────────────
// The records the agent-write-path events carry and `BoardState` holds. Their
// commands and event payloads are further down (with the other commands /
// payloads); these are up here because `BoardState` references them.

export const BoardActivityId = TrimmedNonEmptyString.pipe(Schema.brand("BoardActivityId"));
export type BoardActivityId = typeof BoardActivityId.Type;

/** A step's terminal outcome (D4 completion contract). */
export const BOARD_STEP_OUTCOMES = ["succeeded", "blocked", "failed"] as const;
export const BoardStepOutcome = Schema.Literals(BOARD_STEP_OUTCOMES);
export type BoardStepOutcome = typeof BoardStepOutcome.Type;

/**
 * A recorded step completion (D4). A step is complete ONLY when the agent
 * calls `board_complete_step`; this is the durable record of that call. It
 * lives in the read model because a stage transition branches on it (D8: the
 * Building → Review advance the reactor makes, t3o-10 / t3o-12, keys on the
 * build step's success) and because the decider itself branches on it to stay
 * idempotent — a retried completion re-emits the first outcome rather than
 * recording a second, so a double call is never a double transition.
 */
export const BoardStepCompletion = Schema.Struct({
  cardId: BoardCardId,
  /** Stable step id from the recipe (`BoardStep.id`), supplied by the agent's
      envelope. The (cardId, stepId) pair keys idempotency. */
  stepId: TrimmedNonEmptyString,
  outcome: BoardStepOutcome,
  summary: TrimmedNonEmptyString,
  /** Optional structured payload, carried verbatim as a JSON string so the
      replay-equals-rehydration invariant is a trivial string round-trip with
      no re-serialisation to drift. Null when the agent sent none. */
  payload: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  completedAt: IsoDateTime,
});
export type BoardStepCompletion = typeof BoardStepCompletion.Type;

/**
 * A card's live step status (t3o-10, D4/D8). One record per card — a card
 * runs exactly one step at a time (D4: one thread per step) — recording where
 * that step is in its lifecycle so the supervisor reactor and the decider can
 * branch on it (D8: transitions branch on it, so it lives in the read model,
 * rebuilt from `board_card_step_state` on rehydration).
 *
 * `completing` is a reserved status from the plan's step vocabulary for the
 * window between a successful `board_complete_step` and the board-driven stage
 * advance (D18). The MVP reactor collapses that window into a single turn
 * (settle → advance), so it is not yet emitted; it is kept in the union so a
 * future reactor that persists it needs no migration, and boot reconciliation
 * already treats any non-`running`/`awaiting-input`/`stalled` non-terminal
 * status as a re-drive. `stalled` (t3o-17, D3) is where recovery gives up: an
 * unattended step that stops making progress lands here — distinct from
 * `awaiting-input`, which is a healthy agent question. It is non-terminal (a
 * human still has to act) but supervision does not drive it, so boot
 * reconciliation re-reads and leaves it alone. Every way in has a way out:
 * `queued` → `running` on admission, `awaiting-input` → `running` on the
 * answer, `stalled` → `queued`/`running` when a human retries, and the three
 * terminals (`succeeded`, `failed`, `abandoned`) are the reverse states a
 * running step owes.
 */
export const BOARD_STEP_STATUSES = [
  "pending",
  "queued",
  "running",
  "awaiting-input",
  "stalled",
  "completing",
  "succeeded",
  "failed",
  "abandoned",
] as const;
export const BoardStepStatus = Schema.Literals(BOARD_STEP_STATUSES);
export type BoardStepStatus = typeof BoardStepStatus.Type;

/** The terminal step statuses — a settled step, past which no recovery runs.
    A card whose step is in one of these is not being supervised. */
export const BOARD_TERMINAL_STEP_STATUSES = ["succeeded", "failed", "abandoned"] as const;

/** Whether a step status is terminal (settled). The single reader boot
    reconciliation and the reactor both use, so "still supervised" is one
    definition. */
export function isBoardTerminalStepStatus(status: BoardStepStatus): boolean {
  return (BOARD_TERMINAL_STEP_STATUSES as ReadonlyArray<string>).includes(status);
}

export const BoardCardStepState = Schema.Struct({
  cardId: BoardCardId,
  /** The stage's single step id (D1). Equal to the stage id, so a completion
      keyed `(cardId, stepId)` records that this card has run this stage's step
      — the first-entry-vs-re-entry signal (D7). */
  stepId: TrimmedNonEmptyString,
  /** The step's human label, or NULL when this stage has no steps (t3o-19,
      D4) — which is every stage but the review loop, where the single step's
      label was just the stage label and rendering it produced
      `Stage: planning. Step: Planning.`. The presence of this label IS the
      "does this stage have steps" signal; there is no separate flag, so a
      future sequence executor gets correct prompts by construction.
      Carried so a card can render "which step" without re-resolving the stage
      config; readers fall back to `stageLabel`. */
  stepLabel: Schema.NullOr(TrimmedNonEmptyString),
  /** The stage's human label, frozen at stage entry (t3o-19, D5) so the
      preamble and every `stepLabel` reader resolve a name without a board
      read. NULL on a row written before the freeze — history is never
      rewritten (D7), so legacy rows keep their non-null `stepLabel` and read
      exactly as they did.

      A DECODING DEFAULT, not a plain nullable: this struct is the payload of
      `board.card-step-selected`, and the event log is replayed through
      `Schema.decodeUnknownEffect` on read. An event written before t3o-19 has
      no `stageLabel` KEY, which a required-but-nullable field rejects — so
      without this, D7's "replay equals rehydration" would hold for the table
      and break for the log. */
  stageLabel: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Cumulative invocation count of this step this stage entry, 1-based;
      recovery increments it and it never resets within the entry (t3o-17, D1).
      Kept for display ("attempt 7") and for the per-stage-entry invocation
      ceiling (D5) — the runaway detector that stops a stage whose steps have,
      in total, been invoked more than `maxInvocationsPerStageEntry` times, even
      when no single step exhausted `maxAttempts`. Resets to 1 on stage entry
      (a fresh `select-step` row). */
  attempt: PositiveInt,
  /** CONSECUTIVE stalls with no progress between them (t3o-17, D1). Distinct
      from `attempt`: this is what recovery gates on — it is compared against
      `maxAttempts`, and it RESETS to zero whenever progress is observed since
      the last nudge (t3o-17 D2, re-pointed by t3o-18 D16: the step thread's
      TODO LIST advanced, or a new commit landed on the card's branch — the
      `board_report_progress` note this used to read was deleted with the tool).
      A step that keeps inching forward never
      escalates on stall grounds however many times it is nudged; only a
      genuinely wedged agent — `maxAttempts` unproductive stops in a row —
      does. Starts at zero on a fresh step. */
  stallCount: NonNegativeInt,
  /** When recovery last nudged this step (t3o-17, D2), or null before the first
      nudge. The boundary "since the last nudge" the reactor resolves the
      progress signal against — a progress note or commit after this instant
      resets `stallCount`. */
  lastNudgeAt: Schema.NullOr(IsoDateTime),
  // ── Frozen execution config (D12) ────────────────────────────────────
  // Resolved from the stage's settings ONCE at stage entry and stamped here,
  // so editing settings mid-flight cannot corrupt a running card. The reactor
  // reads these fields instead of re-resolving the stage config.
  /** The resolved step prompt. Empty on a re-entry (D7: a clean conversational
      thread with no prompt injected). */
  prompt: Schema.String,
  /** The resolved provider instance the step runs on (D12). */
  providerInstanceId: ProviderInstanceId,
  /** The resolved model, concrete — a null stage `model` was resolved to the
      global default here, so a later default change never moves a running card. */
  model: TrimmedNonEmptyString,
  /** The resolved model option selections (reasoning/effort), frozen at stage
      entry (t3o-21). Optional: a stage that set no effort has no key. Passed
      into the spawned thread's `modelSelection.options`. */
  modelOptions: Schema.optional(ProviderOptionSelections),
  /** Mode governs resources (D5): `plan` holds no worktree and no slot; `build`
      provisions a worktree and holds a slot. */
  mode: BoardStageMode,
  /** The resolved agent authority posture, frozen at stage entry (t3o-21) so a
      settings edit mid-flight cannot change a live agent's authority. The
      reactor reads this instead of deriving the posture from `mode`. A DECODING
      DEFAULT because this struct is a replayed event payload: rows written
      before t3o-21 have no key and must rehydrate — they resolve to the old
      behaviour (`full-access` for a `build` run, `approval-required` otherwise)
      via `boardStepRuntimeMode`, applied by the reactor, not here. The stored
      default is the safe least-authority value. */
  runtimeMode: RuntimeMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("approval-required" as const)),
  ),
  /** Whether this run is human-in-the-loop (D5/D6): the frozen resolution of
      the stage's / card's human-in-the-loop setting. Governs the prompt
      postamble, drop monitoring and auto-advance eligibility. */
  humanInLoop: Schema.Boolean,
  /** The escalation ceiling, frozen from the stage config. Enforced only on an
      unattended run. */
  maxAttempts: PositiveInt,
  /** The step timeout in ms, frozen from the stage config. Enforced only on an
      unattended run. */
  timeoutMs: PositiveInt,
  /** The step's thread; null before spawn and while `queued`. */
  threadId: Schema.NullOr(ThreadId),
  status: BoardStepStatus,
  /** Whether the step currently holds a concurrency slot (t3o-11). Tracked so
      release happens exactly once at every terminal outcome, including a crash
      — a leaked slot silently halves throughput. */
  slotHeld: Schema.Boolean,
  /** When the step began running; null while pending/queued. */
  startedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type BoardCardStepState = typeof BoardCardStepState.Type;

export const BoardPlanId = TrimmedNonEmptyString.pipe(Schema.brand("BoardPlanId"));
export type BoardPlanId = typeof BoardPlanId.Type;

/**
 * Plan metadata in the read model (D8: plan status, `dependsOn`, `locked` and
 * order gate approval / blocking / parent auto-advance, so they live here; the
 * plan body — markdown — lives only in `board_plans`). `locked` is set when a
 * plan is materialised to `.plans/` at Building entry (t3o-12); nothing locks a
 * plan in t3o-08, but `board_write_plan`'s decider already refuses a locked
 * plan, so the one-source-of-truth handover exists the moment locking does.
 */
export const BoardPlan = Schema.Struct({
  planId: BoardPlanId,
  cardId: BoardCardId,
  title: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  /** Other plans of the same card this one depends on. Validated acyclic on
      ingest (`board_propose_plans`). */
  dependsOn: Schema.Array(BoardPlanId),
  /** Position within the card's ordered plan set. */
  ordinal: NonNegativeInt,
  /** True once materialised to `.plans/` at Building entry (t3o-12); a locked
      plan rejects `board_write_plan`, pointing the agent at the file. */
  locked: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BoardPlan = typeof BoardPlan.Type;

/** A plan plus its body — the event-carried and table-stored shape. The read
    model keeps only the `BoardPlan` metadata; the body rides `board_plans`. */
export const BoardPlanWithBody = Schema.Struct({
  ...BoardPlan.fields,
  body: Schema.String,
});
export type BoardPlanWithBody = typeof BoardPlanWithBody.Type;

/** The plan id for a card's plan key: deterministic (`cardId::key`) so a
    re-proposal is a clean replace and `dependsOn` references resolve without
    a round trip. The `::` separator never appears in a `BoardCardId` (a
    trimmed non-empty string with no such delimiter convention). */
export function boardPlanId(cardId: BoardCardId, key: string): BoardPlanId {
  return BoardPlanId.make(`${cardId}::${key}`);
}

/**
 * The card Activity rail (t3o-18, D10/D12). Activity is a **projection of the
 * board's own event log**, not something an agent narrates: the board already
 * emits the exact moments the rail wants to show, so the projector writes a row
 * for a curated subset of them in the same transaction. Single source of truth,
 * so the rail can never drift from what actually happened; materialised, so
 * reads stay cheap with stable ids and ordering.
 *
 * Rows are STRUCTURED — a kind, a small typed payload, and an actor. The server
 * never writes English: the client renders the sentence and its links.
 * Otherwise the log is unqueryable, unrelabelable, and "who approved it" ends
 * up buried in prose.
 *
 * Nine curated kinds (D12) — "major stages being completed, or the card moving
 * from one stage to the next". Everything else stays out (`card-reordered`,
 * `card-updated`, thread link/unlink, the step lifecycle, the three non-failure
 * worktree events): the full lifecycle would put ~20 rows on a card that ran
 * three steps, which is the same unreadability that motivated removing
 * agent-written progress notes. Each excluded kind is a one-line addition later
 * if it earns its place.
 *
 * `progress` and `input-requested` (t3o-08's agent-written kinds) are GONE
 * (D13): `board_report_progress` and `board_request_input` are deleted, the
 * agent's narration is already durable in its transcript, and its intent is now
 * on the card as the todo strip. `card-input-requested` survives as a kind, but
 * it is now sourced from the runtime `user-input.requested` event rather than
 * from a tool an agent had to remember to call.
 */
export const BOARD_CARD_ACTIVITY_KINDS = [
  "card-created",
  "card-moved",
  "plans-proposed",
  "plan-written",
  "card-step-completed",
  "card-input-requested",
  "card-archived",
  "card-unarchived",
  "card-worktree-failed",
] as const;
export const BoardCardActivityKind = Schema.Literals(BOARD_CARD_ACTIVITY_KINDS);
export type BoardCardActivityKind = typeof BoardCardActivityKind.Type;

/**
 * Who caused an activity row (t3o-18, D11). `board.ts` carries no provenance on
 * any command — a stage move may originate from a human drag, an agent's MCP
 * tool call, or the supervisor reactor — so the actor is stamped at the
 * DISPATCH BOUNDARY, where the transport already knows who called. No command
 * schema changes, and no caller can misreport itself.
 *
 * - **human** — a board RPC from the web client. `name` is the card's project
 *   git `user.name`, resolved once and STORED ON THE ROW so it stays correct
 *   after the git config changes; `"You"` when git has no identity. There is no
 *   user identity anywhere in t3code (it is a single-user local server), and for
 *   a dev tool the git identity is the right one — it is already what lands on
 *   every commit the agent makes.
 * - **agent** — the MCP board toolkit. The display name and accent are resolved
 *   client-side from `providerInstanceId`, exactly where "Claude Opus 4.8" and
 *   its accent already come from, so a renamed provider instance relabels its
 *   history.
 * - **system** — the supervisor reactor and every other internal command.
 */
export const BoardActivityActor = Schema.Struct({
  kind: Schema.Literals(["human", "agent", "system"]),
  /** The resolved human name, frozen at write time. Null for agent/system. */
  name: Schema.NullOr(TrimmedNonEmptyString),
  /** The agent's provider instance, for the client-side name + accent lookup.
      Null for human/system. */
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  /** The agent's thread, so the rail can link back to the conversation. */
  threadId: Schema.NullOr(ThreadId),
});
export type BoardActivityActor = typeof BoardActivityActor.Type;

/** The system actor — the resting value for every internally-dispatched
    command, and the fallback when no dispatch boundary stamped one. */
export const BOARD_SYSTEM_ACTOR: BoardActivityActor = {
  kind: "system",
  name: null,
  providerInstanceId: null,
  threadId: null,
};

/**
 * The small typed payload an activity row carries (D10). Every field is
 * key-optional: a row carries only what its kind needs, and the client renders
 * the sentence. Deliberately narrow — ids and enums, never prose — so the rail
 * stays queryable and relabelable.
 */
export const BoardCardActivityPayload = Schema.Struct({
  /** card-moved: the stage it left and the stage it entered. */
  fromStage: Schema.optionalKey(BoardStageId),
  toStage: Schema.optionalKey(BoardStageId),
  /** plans-proposed: how many plans landed. plan-written: which plan. */
  planCount: Schema.optionalKey(NonNegativeInt),
  planId: Schema.optionalKey(BoardPlanId),
  planTitle: Schema.optionalKey(TrimmedNonEmptyString),
  /** card-step-completed: which step, and how it ended. */
  stepId: Schema.optionalKey(TrimmedNonEmptyString),
  stepLabel: Schema.optionalKey(TrimmedNonEmptyString),
  outcome: Schema.optionalKey(BoardStepOutcome),
  /** card-worktree-failed: the failure detail, already agent-facing text. */
  detail: Schema.optionalKey(TrimmedNonEmptyString),
});
export type BoardCardActivityPayload = typeof BoardCardActivityPayload.Type;

export const BoardCardActivityEntry = Schema.Struct({
  activityId: BoardActivityId,
  cardId: BoardCardId,
  kind: BoardCardActivityKind,
  payload: BoardCardActivityPayload,
  actor: BoardActivityActor,
  /** The thread the row is about (the agent's), or null. Kept so context can
      attribute activity to a step's thread. */
  threadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
});
export type BoardCardActivityEntry = typeof BoardCardActivityEntry.Type;

/**
 * Board slice of the in-memory orchestration read model (D8: everything a
 * transition branches on lives here). Archived cards STAY in `cards` with
 * `archivedAt` set — they leave the shell snapshot, but dropping them from
 * the read model would make `board.card-unarchived` unprojectable on a
 * from-empty replay (the card's data would be gone) and break the
 * replay-equals-rehydration invariant. Attached to `OrchestrationReadModel`
 * as an optional field so read models built by pre-board code — upstream
 * tests included — decode and compile unchanged.
 */
export const BoardState = Schema.Struct({
  cards: Schema.Array(BoardCard),
  /** The label catalogue (t3o-06a). In the read model because the decider
      branches on it (D8): name-uniqueness and label-existence gates read it.
      Includes tombstoned labels (`deletedAt` set). Kept in canonical
      `compareBoardLabels` order. Optional and read through
      `boardLabelCatalogue` (absent means the compiled seeds), mirroring the
      `board ?? EMPTY_BOARD_STATE` fallback: a board that has never touched a
      label still resolves feature/bug/chore, and a persisted pre-label read
      model decodes unchanged. */
  labels: Schema.optional(Schema.Array(BoardLabel)),
  /** Recorded step completions (t3o-08, D4/D8). In the read model because the
      decider branches on them to stay idempotent and the reactor branches on
      them to advance Building → Review (t3o-10/12). Optional and absent until
      the first `board_complete_step` — a board with no completions decodes
      unchanged; rebuilt from `board_card_steps` on rehydration. */
  stepCompletions: Schema.optional(Schema.Array(BoardStepCompletion)),
  /** Live per-card step status (t3o-10, D4/D8). In the read model because the
      supervisor reactor and the decider branch on it — death detection,
      recovery escalation and boot reconciliation all key on a card's current
      step status. One entry per card. Optional and absent until the first
      step selection; rebuilt from `board_card_step_state` on rehydration, so a
      board with no running steps decodes unchanged. */
  stepStates: Schema.optional(Schema.Array(BoardCardStepState)),
  /** Proposed plan metadata (t3o-08, D8): status, `dependsOn`, `locked`, order.
      In the read model because `board_write_plan`'s decider branches on
      `locked` and the approve gate / parent auto-advance branch on the graph.
      Bodies live only in `board_plans`. Optional and absent until the first
      `board_propose_plans`; rebuilt from `board_plans` on rehydration. */
  plans: Schema.optional(Schema.Array(BoardPlan)),
  /** User-defined stage list (t3o-15, D2). In the read model because the
      decider branches on it: stage adjacency, the `build`/`review`/`done`
      role positions and the ordering invariant are all validated off this
      slice, and stage mutation is transactional with card moves. Includes the
      eight compiled seeds until edited. Kept in canonical `compareBoardStages`
      order. Optional and read through `boardStages`, mirroring the
      `labels` fallback: absent means the compiled seeds, and a persisted
      pre-stage read model decodes unchanged. */
  stages: Schema.optional(Schema.Array(BoardStageDefinition)),
  /** Next key number per project (D14). Lives in the read model so
      allocation is exact and race-free under the engine's total command
      ordering; rebuilt from `MAX(card_number)` on rehydration. */
  nextCardNumberByProject: Schema.Record(ProjectId, PositiveInt),
});
export type BoardState = typeof BoardState.Type;

/** A card's recorded step completions (t3o-08), in completion order. Absent
    slice means none. */
export function boardCardStepCompletions(
  board: BoardState,
  cardId: BoardCardId,
): ReadonlyArray<BoardStepCompletion> {
  return (board.stepCompletions ?? []).filter((completion) => completion.cardId === cardId);
}

/**
 * What to call a card's current run in the UI and in operator-facing text
 * (t3o-19, D4/D5): its step's label when the stage HAS steps, the stage's label
 * otherwise, and null on a legacy row that froze neither.
 *
 * Named once because three readers share the rule — the run thread's title, the
 * activity rail's input-requested row, and the settings/detail views — and a
 * reader that resolved it differently would show a card two different names for
 * the same run.
 */
export function boardRunLabel(
  state: Pick<BoardCardStepState, "stepLabel" | "stageLabel">,
): string | null {
  return state.stepLabel ?? state.stageLabel;
}

/** A card's live step state (t3o-10), or null when the card has no step
    running or settled. One record per card (D4: one step at a time). */
export function boardCardStepState(
  board: BoardState,
  cardId: BoardCardId,
): BoardCardStepState | null {
  return (board.stepStates ?? []).find((state) => state.cardId === cardId) ?? null;
}

/** Every card with a non-terminal step (t3o-10): the set boot reconciliation
    re-reads to ask whether each thread is still alive. Terminal steps are
    settled and no longer supervised. */
export function boardNonTerminalStepStates(board: BoardState): ReadonlyArray<BoardCardStepState> {
  return (board.stepStates ?? []).filter((state) => !isBoardTerminalStepStatus(state.status));
}

/**
 * A card's total step invocations this stage entry (t3o-17, D5): the number the
 * reactor feeds the per-stage-entry ceiling in `recoveryDecision`. Computed as
 * the sum of `attempt` across the card's step-state rows.
 *
 * Today the read model keeps exactly ONE step-state row per card (D4: one step
 * at a time), and the review loop advances that row step to step — so the
 * running total is carried on `attempt` itself: an intra-stage `select-step`
 * passes `priorInvocations` (this count at selection time) and the decider
 * stamps `attempt = priorInvocations + 1`, while a genuine stage entry omits it
 * and resets (D1). It is still written as a sum, not a single-row read, so it
 * stays correct if a future model tracks more than one step-state row per card
 * at once. Either way the ceiling is enforced by `recoveryDecision` on whatever
 * total it is handed, which is the generic, unit-tested guarantee.
 */
export function boardStageEntryInvocationCount(board: BoardState, cardId: BoardCardId): number {
  return (board.stepStates ?? [])
    .filter((state) => state.cardId === cardId)
    .reduce((total, state) => total + state.attempt, 0);
}

/** Every card whose live step has given up (t3o-17, D3): the `stalled` set the
    board surfaces so a human can find every card that needs rescuing without
    opening each. */
export function boardStalledStepStates(board: BoardState): ReadonlyArray<BoardCardStepState> {
  return (board.stepStates ?? []).filter((state) => state.status === "stalled");
}

/** A card's proposed plans (t3o-08), in `ordinal` order. Absent slice means
    none. */
export function boardCardPlans(board: BoardState, cardId: BoardCardId): ReadonlyArray<BoardPlan> {
  return (board.plans ?? [])
    .filter((plan) => plan.cardId === cardId)
    .toSorted((left, right) => left.ordinal - right.ordinal);
}

/**
 * The card a live (non-tombstoned) thread link owns, or null when the thread
 * is unlinked (D9: one thread, one card). The card-resolution primitive the
 * MCP board toolkit authorizes card-scoped tools against — an agent never
 * supplies its own card id; the server resolves it from the calling
 * `threadId`. Archived cards resolve too: an agent finishing work on a card
 * that was just archived still gets an actionable answer.
 */
export function resolveBoardCardForThread(board: BoardState, threadId: ThreadId): BoardCard | null {
  return (
    board.cards.find((card) =>
      card.threadLinks.some((link) => link.threadId === threadId && link.tombstonedAt === null),
    ) ?? null
  );
}

export const EMPTY_BOARD_STATE: BoardState = {
  cards: [],
  labels: BOARD_SEED_LABELS,
  stages: BOARD_SEED_STAGES,
  nextCardNumberByProject: {},
};

/** The label catalogue for a board slice: its `labels`, or the compiled seeds
    when absent (a board that has never touched a label). The single reader
    every decider/projector path goes through, so "absent" and "the three
    seeds" are always the same catalogue. */
export function boardLabelCatalogue(board: BoardState): ReadonlyArray<BoardLabel> {
  return board.labels ?? BOARD_SEED_LABELS;
}

// ── Stage read-model helpers (D2/D3, t3o-15) ───────────────────────────

/** A board's stage list: its `stages`, or the compiled seeds when absent (a
    board that has never touched a stage). The single reader every
    decider/projector/UI path goes through, so "absent" and "the eight seeds"
    are always the same list. */
export function boardStages(board: BoardState): ReadonlyArray<BoardStageDefinition> {
  return board.stages ?? BOARD_SEED_STAGES;
}

/** The stage list in canonical (orderKey, stageId) order. */
export function boardStagesInOrder(board: BoardState): ReadonlyArray<BoardStageDefinition> {
  return [...boardStages(board)].sort(compareBoardStages);
}

/** The stage with the given id, or null. */
export function boardStageById(
  board: BoardState,
  stageId: BoardStageId,
): BoardStageDefinition | null {
  return boardStages(board).find((stage) => stage.stageId === stageId) ?? null;
}

/** A stage's position in board order, or -1 when the id is unknown (a
    since-deleted stage named by a legacy event). */
export function boardStageIndex(board: BoardState, stageId: BoardStageId): number {
  return boardStagesInOrder(board).findIndex((stage) => stage.stageId === stageId);
}

/** Whether two stages are neighbours in board order. Unknown ids are never
    adjacent. */
export function areBoardStagesAdjacent(
  board: BoardState,
  a: BoardStageId,
  b: BoardStageId,
): boolean {
  const indexA = boardStageIndex(board, a);
  const indexB = boardStageIndex(board, b);
  if (indexA < 0 || indexB < 0) return false;
  return Math.abs(indexA - indexB) === 1;
}

/** The single stage holding a product role (D3), or null. Matches on the
    EFFECTIVE role so a legacy stage list (Planning seeded before the `plan`
    role existed, role null) still reports its holder. */
export function boardStageWithRole(
  board: BoardState,
  role: BoardStageRole,
): BoardStageDefinition | null {
  return boardStages(board).find((stage) => effectiveBoardStageRole(stage) === role) ?? null;
}

/** The stage immediately after `stageId` in board order, or null when it is
    last or unknown (D8: auto-advance moves to the next stage in order). */
export function boardNextStageId(board: BoardState, stageId: BoardStageId): BoardStageId | null {
  const ordered = boardStagesInOrder(board);
  const index = ordered.findIndex((stage) => stage.stageId === stageId);
  if (index < 0 || index + 1 >= ordered.length) return null;
  return ordered[index + 1]!.stageId;
}

/** Whether a stage sits at or after the `build` role in board order (D11):
    dependency blocking is unconditional from here onward, and sub-board plan
    cards are restricted to this subset. A board with no build role (never in
    practice — the role is undeletable) treats nothing as at-or-after. */
export function isBoardStageAtOrAfterBuild(board: BoardState, stageId: BoardStageId): boolean {
  const build = boardStageWithRole(board, "build");
  if (build === null) return false;
  const buildIndex = boardStageIndex(board, build.stageId);
  const stageIndex = boardStageIndex(board, stageId);
  return stageIndex >= 0 && buildIndex >= 0 && stageIndex >= buildIndex;
}

// ── Key allocation ─────────────────────────────────────────────────────

/**
 * Key prefix used when `board.card.create` carries none. The spec makes the
 * per-project prefix a setting, but the settings surface does not exist
 * until t3o-07 — so the command carries an optional `keyPrefix` and t3o-07
 * wires the real settings source with no schema change here.
 */
export const DEFAULT_BOARD_KEY_PREFIX = "CARD";

/**
 * Values walking-skeleton (t3o-02) `board.card-created` events and
 * `board_cards` rows decode to for fields that did not exist yet. The
 * decoding defaults on `BoardCardCreatedPayload` and the column defaults in
 * migration `903_BoardCardsColumns` MUST both use these, or a from-empty
 * replay of a pre-t3o-03 log would diverge from table rehydration.
 */
export const LEGACY_BOARD_CARD_NUMBER = 0;
export const LEGACY_BOARD_CARD_KEY = `${DEFAULT_BOARD_KEY_PREFIX}-${LEGACY_BOARD_CARD_NUMBER}`;
export const LEGACY_BOARD_CARD_ORDER_KEY = "m";

/**
 * Order key for a card appended at the bottom of a stage column, computed
 * server-side (t3o-08). The web client places cards with its fractional pin-
 * order helper (`pinOrderKeyBetween`), but that lives in `client-runtime` and
 * the MCP toolkit is server-side, so an agent-created card gets a bottom key
 * from this self-contained scheme: append a mid digit (`m`) to the column's
 * current max so the new card sorts strictly after every existing one, and
 * `"m"` for an empty column (matching `LEGACY_BOARD_CARD_ORDER_KEY`). Keys are
 * opaque comparable strings; the client's drag reorder rewrites a column whose
 * keys it cannot bisect, so a non-fractional key here is at worst one extra
 * reorder, never a wrong order. `existingOrderKeys` is the target column's
 * keys, in any order.
 */
export function boardAppendOrderKey(existingOrderKeys: ReadonlyArray<string>): string {
  let max: string | null = null;
  for (const key of existingOrderKeys) {
    if (max === null || key > max) max = key;
  }
  return max === null ? LEGACY_BOARD_CARD_ORDER_KEY : `${max}m`;
}

// ── Commands ───────────────────────────────────────────────────────────
// Card-shape fields on commands/payloads are named `cardType` (not `type`)
// because `type` is the command/event discriminant.

export const BoardCardCreateCommand = Schema.Struct({
  type: Schema.Literal("board.card.create"),
  commandId: CommandId,
  cardId: BoardCardId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  /** Brief body captured at creation (t3o-06). Stored in `board_card_bodies`,
      never the read model (D8); absent creates no body. The create dialog's
      brief field wires here, so a card lands with its write-up in one atomic
      event rather than a create-then-update flash. */
  brief: Schema.optional(TrimmedNonEmptyString),
  /** Initial dependencies (t3o-06). Validated for existence by the decider;
      cycles are impossible at create (a brand-new card has no dependents), so
      the cycle gate stays a `board.card.update` concern. A creation-stage card
      is always before Ready, so these never block it until it crosses the
      Ready gate (D18). Absent is an empty set. */
  dependsOn: Schema.optional(Schema.Array(BoardCardId)),
  /** Labels to tag the new card with (t3o-06a). Absent is an empty set. The
      decider rejects the create when it exceeds `BOARD_CARD_LABELS_MAX` or
      references an unknown / tombstoned label. */
  labels: Schema.optional(Schema.Array(BoardLabelId)),
  /** Target stage (D10). Absent lands in the first stage. A card may be
      created into ANY existing stage — creation and dragging follow one path;
      Mode governs worktree/slot on entry, and the build-onward dependency
      gate still applies. t3o-06 wires the create dialog's stage picker to
      this. */
  stage: Schema.optional(BoardStageId),
  /** Client-computed fractional position in the target column. */
  orderKey: TrimmedNonEmptyString,
  /** Overrides DEFAULT_BOARD_KEY_PREFIX; the t3o-07 settings surface will
      supply the per-project value. */
  keyPrefix: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type BoardCardCreateCommand = typeof BoardCardCreateCommand.Type;

export const BoardCardMoveCommand = Schema.Struct({
  type: Schema.Literal("board.card.move"),
  commandId: CommandId,
  cardId: BoardCardId,
  toStage: BoardStageId,
  /** Fractional position in the target column; absent keeps the current key. */
  orderKey: Schema.optional(TrimmedNonEmptyString),
  /** Permits non-adjacent stage moves. A drag is an override — a rigid
      board still has to let you drag a card backwards. */
  override: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
});
export type BoardCardMoveCommand = typeof BoardCardMoveCommand.Type;

export const BoardCardReorderCommand = Schema.Struct({
  type: Schema.Literal("board.card.reorder"),
  commandId: CommandId,
  cardId: BoardCardId,
  orderKey: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type BoardCardReorderCommand = typeof BoardCardReorderCommand.Type;

/** Partial update: absent fields are unchanged. `brief` and `externalRef`
    accept null to clear. One command with partial semantics rather than five
    near-identical commands. */
export const BoardCardUpdateCommand = Schema.Struct({
  type: Schema.Literal("board.card.update"),
  commandId: CommandId,
  cardId: BoardCardId,
  title: Schema.optional(TrimmedNonEmptyString),
  /** Brief body text, stored in `board_card_bodies` — never in the read
      model (D8). */
  brief: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  /** New full label set for the card (t3o-06a); absent leaves labels
      unchanged. The decider caps it and requires each id to be either already
      on the card (grandfathering a tombstoned reference) or a live label. */
  labels: Schema.optional(Schema.Array(BoardLabelId)),
  dependsOn: Schema.optional(Schema.Array(BoardCardId)),
  externalRef: Schema.optional(Schema.NullOr(BoardCardExternalRef)),
  /** Per-card human-in-the-loop override on the Build stage (D6). Absent leaves
      it unchanged; `null` clears it back to the computed default; a boolean
      writes an explicit value. Flipping it mid-run sends a turn into the live
      thread (D5), handled by the supervisor reactor. */
  humanInLoop: Schema.optional(Schema.NullOr(Schema.Boolean)),
  createdAt: IsoDateTime,
});
export type BoardCardUpdateCommand = typeof BoardCardUpdateCommand.Type;

export const BoardCardLinkThreadCommand = Schema.Struct({
  type: Schema.Literal("board.card.link-thread"),
  commandId: CommandId,
  cardId: BoardCardId,
  threadId: ThreadId,
  role: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type BoardCardLinkThreadCommand = typeof BoardCardLinkThreadCommand.Type;

export const BoardCardUnlinkThreadCommand = Schema.Struct({
  type: Schema.Literal("board.card.unlink-thread"),
  commandId: CommandId,
  cardId: BoardCardId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
export type BoardCardUnlinkThreadCommand = typeof BoardCardUnlinkThreadCommand.Type;

export const BoardCardArchiveCommand = Schema.Struct({
  type: Schema.Literal("board.card.archive"),
  commandId: CommandId,
  cardId: BoardCardId,
  createdAt: IsoDateTime,
});
export type BoardCardArchiveCommand = typeof BoardCardArchiveCommand.Type;

export const BoardCardUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("board.card.unarchive"),
  commandId: CommandId,
  cardId: BoardCardId,
  createdAt: IsoDateTime,
});
export type BoardCardUnarchiveCommand = typeof BoardCardUnarchiveCommand.Type;

// ── Label commands (t3o-06a) ───────────────────────────────────────────
// A second board aggregate: label commands carry `labelId` (client-generated,
// like `cardId`, so an inline create-then-tag needs no round trip) and
// aggregate on the label. Labels get commands and events like everything the
// board writes (D8) rather than riding settings — creating a label while
// tagging a card must not race the settings map.

export const BoardLabelCreateCommand = Schema.Struct({
  type: Schema.Literal("board.label.create"),
  commandId: CommandId,
  labelId: BoardLabelId,
  name: BoardLabelName,
  /** Absent: the decider assigns a swatch colour via `pickNextBoardLabelColour`
      (guaranteeing back-to-back creates differ). Present: an explicit hex,
      validated against `BOARD_LABEL_COLOUR_PATTERN`. */
  colour: Schema.optional(BoardLabelColour),
  createdAt: IsoDateTime,
});
export type BoardLabelCreateCommand = typeof BoardLabelCreateCommand.Type;

/** Rename and/or recolour; absent fields are unchanged. A recolour repaints
    every card carrying the label through the normal catalogue delta path — no
    per-card write. */
export const BoardLabelUpdateCommand = Schema.Struct({
  type: Schema.Literal("board.label.update"),
  commandId: CommandId,
  labelId: BoardLabelId,
  name: Schema.optional(BoardLabelName),
  colour: Schema.optional(BoardLabelColour),
  createdAt: IsoDateTime,
});
export type BoardLabelUpdateCommand = typeof BoardLabelUpdateCommand.Type;

/** Tombstone the label (referential integrity, option 3): it leaves the
    picker, cards keep the reference and render it muted. */
export const BoardLabelDeleteCommand = Schema.Struct({
  type: Schema.Literal("board.label.delete"),
  commandId: CommandId,
  labelId: BoardLabelId,
  createdAt: IsoDateTime,
});
export type BoardLabelDeleteCommand = typeof BoardLabelDeleteCommand.Type;

/** Undelete — a one-way door is a bug (reverse states). Rejected if the
    name now collides with a live label. */
export const BoardLabelUndeleteCommand = Schema.Struct({
  type: Schema.Literal("board.label.undelete"),
  commandId: CommandId,
  labelId: BoardLabelId,
  createdAt: IsoDateTime,
});
export type BoardLabelUndeleteCommand = typeof BoardLabelUndeleteCommand.Type;

// ── Stage aggregate commands (t3o-15, D2/D9) ───────────────────────────
// Stage definitions are a board read-model aggregate, mutated by these
// decider-gated commands. The decider enforces the D3 ordering invariant
// (`build` before `review`, `done` last), refuses deleting a stage that holds
// any card or a role-holder (D9), and refuses reordering across the `build`
// boundary while the stage holds cards (D9). Being `board.` commands they ride
// the same generalised seams as every other board write.

export const BoardStageCreateCommand = Schema.Struct({
  type: Schema.Literal("board.stage.create"),
  commandId: CommandId,
  stageId: BoardStageId,
  label: TrimmedNonEmptyString,
  /** Client-computed fractional key placing the stage; the decider validates
      the resulting order against the role invariant (D3/D9). */
  orderKey: TrimmedNonEmptyString,
  /** Optional role for the new stage — always null in practice (the three
      role-holders are seeded and undeletable); present for completeness. */
  role: Schema.optional(Schema.NullOr(BoardStageRole)),
  createdAt: IsoDateTime,
});
export type BoardStageCreateCommand = typeof BoardStageCreateCommand.Type;

/** Rename — label only, id immutable, always allowed, no side effects (D9). */
export const BoardStageRenameCommand = Schema.Struct({
  type: Schema.Literal("board.stage.rename"),
  commandId: CommandId,
  stageId: BoardStageId,
  label: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type BoardStageRenameCommand = typeof BoardStageRenameCommand.Type;

/** Reorder — move a stage to a new fractional key, subject to the ordering
    invariant and the build-boundary-while-occupied refusal (D9). */
export const BoardStageReorderCommand = Schema.Struct({
  type: Schema.Literal("board.stage.reorder"),
  commandId: CommandId,
  stageId: BoardStageId,
  orderKey: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type BoardStageReorderCommand = typeof BoardStageReorderCommand.Type;

/** Delete — refused if the stage holds any card (archived included) or is a
    role-holder (D9). The error names the count. */
export const BoardStageDeleteCommand = Schema.Struct({
  type: Schema.Literal("board.stage.delete"),
  commandId: CommandId,
  stageId: BoardStageId,
  createdAt: IsoDateTime,
});
export type BoardStageDeleteCommand = typeof BoardStageDeleteCommand.Type;

/**
 * Start a thread for the card's CURRENT stage on demand (D7), the on-demand
 * counterpart of auto-kickoff — consumed by t3o-14's `+` menu. The decider
 * validates the card exists and emits `board.card-stage-thread-requested`; the
 * supervisor reactor reacts by beginning a stage run (first entry runs the
 * stage prompt; a re-entry opens a clean human-in-the-loop thread).
 */
export const BoardCardStartStageThreadCommand = Schema.Struct({
  type: Schema.Literal("board.card.start-stage-thread"),
  commandId: CommandId,
  cardId: BoardCardId,
  createdAt: IsoDateTime,
});
export type BoardCardStartStageThreadCommand = typeof BoardCardStartStageThreadCommand.Type;

// ── Agent write path (t3o-08) ──────────────────────────────────────────
// The MCP board toolkit (apps/server/src/mcp/toolkits/board/) is the agent
// write path (D3). These commands are dispatched by the tool handlers after
// they authorize the calling thread against its card; they land events and
// project to tables like every other board write (D8). The reactor that
// spawns the threads and reacts to these events is t3o-10 — out of scope
// here; t3o-08 builds the toolkit and its command / authorization /
// persistence path only. Being board (`board.` prefix) commands, they route
// through the same generalised seams (t3o-02a) as every other board write,
// so adding them grows the board-owned registries at the bottom of this file
// and touches zero upstream-owned files. The value types these commands and
// events carry (`BoardCardActivityEntry`, `BoardStepCompletion`, `BoardPlan`)
// are defined up with the other card pieces, since `BoardState` references
// them.

// `board.card.report-progress` and `board.card.request-input` (t3o-08) were
// DELETED here by t3o-18 (D13), together with their payloads and events. The
// agent's narration was already durable in its transcript and nothing rendered
// it; its intent now rides the card as the todo strip. The input-request tool
// admitted its own gap in its description ("you should still ask the same
// question through your normal question mechanism"), so an agent that asked
// normally and skipped the tool left the board blind — today's actual failure
// mode. The reactor now sources input-requested from the runtime
// `user-input.requested` event instead, which fires for EVERY input request.

export const BoardCardCompleteStepCommand = Schema.Struct({
  type: Schema.Literal("board.card.complete-step"),
  commandId: CommandId,
  cardId: BoardCardId,
  stepId: TrimmedNonEmptyString,
  outcome: BoardStepOutcome,
  summary: TrimmedNonEmptyString,
  /** Structured payload as a JSON string; the tool handler serialises the
      agent's object into it. Null when absent. */
  payload: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
});
export type BoardCardCompleteStepCommand = typeof BoardCardCompleteStepCommand.Type;

/** One proposed plan on `board_propose_plans`. `key` is an agent-chosen slug,
    unique within the proposal, that `dependsOn` entries reference — validated
    for existence and acyclicity on ingest (the offending edge is named on
    rejection). */
export const BoardProposedPlanInput = Schema.Struct({
  key: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  dependsOn: Schema.Array(TrimmedNonEmptyString),
  body: Schema.String,
});
export type BoardProposedPlanInput = typeof BoardProposedPlanInput.Type;

export const BoardPlansProposeCommand = Schema.Struct({
  type: Schema.Literal("board.plans.propose"),
  commandId: CommandId,
  cardId: BoardCardId,
  /** Ordered; replaces the card's whole plan set. An empty array clears it. */
  plans: Schema.Array(BoardProposedPlanInput),
  createdAt: IsoDateTime,
});
export type BoardPlansProposeCommand = typeof BoardPlansProposeCommand.Type;

export const BoardPlanWriteCommand = Schema.Struct({
  type: Schema.Literal("board.plan.write"),
  commandId: CommandId,
  cardId: BoardCardId,
  planId: BoardPlanId,
  body: Schema.String,
  createdAt: IsoDateTime,
});
export type BoardPlanWriteCommand = typeof BoardPlanWriteCommand.Type;
// ── Worktree lifecycle commands (t3o-09, D6) ───────────────────────────
// Server-INTERNAL commands (BOARD_INTERNAL_COMMANDS, never
// BOARD_CLIENT_COMMANDS): the worktree lifecycle service dispatches them
// after the effectful git work has actually happened. A client cannot create
// a worktree on the server's filesystem, so letting a client record one would
// desync card state from disk — and worktree provisioning is downstream of
// the human "Begin build" gate (D18), not a thing a client pokes directly.

export const BoardCardProvisionWorktreeCommand = Schema.Struct({
  type: Schema.Literal("board.card.provision-worktree"),
  commandId: CommandId,
  cardId: BoardCardId,
  /** The branch the worktree service is creating for this card. */
  branch: TrimmedNonEmptyString,
  /** Base ref the branch was cut from (default branch, or parent integration
      branch for a sub-board plan card). */
  baseRefName: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type BoardCardProvisionWorktreeCommand = typeof BoardCardProvisionWorktreeCommand.Type;

export const BoardCardRecordWorktreeCommand = Schema.Struct({
  type: Schema.Literal("board.card.record-worktree"),
  commandId: CommandId,
  cardId: BoardCardId,
  /** Filesystem path of the worktree that now exists on disk. */
  path: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type BoardCardRecordWorktreeCommand = typeof BoardCardRecordWorktreeCommand.Type;

export const BoardCardFailWorktreeCommand = Schema.Struct({
  type: Schema.Literal("board.card.fail-worktree"),
  commandId: CommandId,
  cardId: BoardCardId,
  /** Why provisioning failed; surfaced on the card so the step is visibly
      failed and retryable, never a silent wedge. */
  error: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type BoardCardFailWorktreeCommand = typeof BoardCardFailWorktreeCommand.Type;

export const BoardCardReclaimWorktreeCommand = Schema.Struct({
  type: Schema.Literal("board.card.reclaim-worktree"),
  commandId: CommandId,
  cardId: BoardCardId,
  /** `removed` when the worktree service deleted a clean-and-pushed tree;
      `blocked` when it refused because deleting would lose work. */
  outcome: BoardCardWorktreeReclaimOutcome,
  /** Present when `outcome` is `blocked`: why the worktree was kept. */
  reason: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type BoardCardReclaimWorktreeCommand = typeof BoardCardReclaimWorktreeCommand.Type;

// Server-INTERNAL step-lifecycle commands (t3o-10, BOARD_INTERNAL_COMMANDS):
// the supervisor reactor dispatches them as it drives a card's step through
// its lifecycle. They are never client-dispatchable — a step advances only by
// the reactor's own observation of the world (a slot acquired, a thread
// spawned, a thread settled, a completion contract fulfilled), never by a
// client poking the machine. The decider stays pure (D8): each command carries
// the minimal facts the reactor observed, and the decider builds the recorded
// `BoardCardStepState` from them.

export const BoardCardSelectStepCommand = Schema.Struct({
  type: Schema.Literal("board.card.select-step"),
  commandId: CommandId,
  cardId: BoardCardId,
  /** The stage's single step id (D1), equal to the stage id. */
  stepId: TrimmedNonEmptyString,
  /** Null when the stage has no steps (t3o-19, D4). */
  stepLabel: Schema.NullOr(TrimmedNonEmptyString),
  /** The stage's label, frozen for the run (t3o-19, D5). Decoding-defaulted
      for the same replay reason as `BoardCardStepState.stageLabel`. */
  stageLabel: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // ── Frozen execution config resolved on stage entry (D12) ────────────
  // The reactor resolves these server-side (the pure decider cannot read
  // settings, D8) and the decider stamps them onto the step-state row, so
  // editing settings mid-flight cannot corrupt a running card.
  prompt: Schema.String,
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  /** The resolved agent authority for the run (t3o-21). Decoding-defaulted for
      replay of pre-t3o-21 select-step events, which carry no key. */
  runtimeMode: RuntimeMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("approval-required" as const)),
  ),
  /** The resolved model option selections (reasoning/effort), frozen for the
      run (t3o-21). Optional. */
  modelOptions: Schema.optional(ProviderOptionSelections),
  mode: BoardStageMode,
  humanInLoop: Schema.Boolean,
  maxAttempts: PositiveInt,
  timeoutMs: PositiveInt,
  /** The stage entry's step invocations BEFORE this selection (t3o-17, D5).
      An intra-stage continuation (t3o-16's next review phase) carries the
      running total forward so the per-stage-entry ceiling survives step
      replacement; a genuine stage entry omits it (resets, D1). The decider
      stamps `attempt = priorInvocations + 1` onto the fresh run row. */
  priorInvocations: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type BoardCardSelectStepCommand = typeof BoardCardSelectStepCommand.Type;

export const BoardCardAdmitStepCommand = Schema.Struct({
  type: Schema.Literal("board.card.admit-step"),
  commandId: CommandId,
  cardId: BoardCardId,
  stepId: TrimmedNonEmptyString,
  /** True when a concurrency slot was acquired and the step's thread spawned;
      false when no slot was available and the step sits `queued` in Building
      (D11) — visible on the card, never lying about its state. */
  admitted: Schema.Boolean,
  /** The spawned step thread; null when `admitted` is false (queued). */
  threadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
});
export type BoardCardAdmitStepCommand = typeof BoardCardAdmitStepCommand.Type;

export const BoardCardAwaitStepInputCommand = Schema.Struct({
  type: Schema.Literal("board.card.await-step-input"),
  commandId: CommandId,
  cardId: BoardCardId,
  stepId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type BoardCardAwaitStepInputCommand = typeof BoardCardAwaitStepInputCommand.Type;

export const BoardCardRecoverStepCommand = Schema.Struct({
  type: Schema.Literal("board.card.recover-step"),
  commandId: CommandId,
  cardId: BoardCardId,
  stepId: TrimmedNonEmptyString,
  /** The thread the reactor resumed or respawned for the recovery attempt; may
      be the same thread (resume) or a fresh one (respawn). */
  threadId: Schema.NullOr(ThreadId),
  /** True when recovery gives up (t3o-17, D3): consecutive stalls exhausted
      `maxAttempts`, or the stage-entry invocation ceiling was crossed (D5). The
      step goes to the distinct `stalled` status (not `awaiting-input`), still
      asks its question, and RELEASES its concurrency slot (D4) — nobody is
      working and nobody will until a human acts. False for an ordinary retry,
      which returns the step to `running` and keeps its slot. */
  escalateToHuman: Schema.Boolean,
  /** Whether progress was observed since the last nudge (t3o-17, D2): the
      reactor resolves it (a `board_report_progress` activity entry or a new
      commit on the card's branch) and the decider resets `stallCount` to zero
      when true, or increments it when false. Kept out of the pure
      `recoveryDecision` — git and SQL stay in the reactor. */
  progressed: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type BoardCardRecoverStepCommand = typeof BoardCardRecoverStepCommand.Type;

export const BoardCardSettleStepCommand = Schema.Struct({
  type: Schema.Literal("board.card.settle-step"),
  commandId: CommandId,
  cardId: BoardCardId,
  stepId: TrimmedNonEmptyString,
  /** The step's terminal outcome. `succeeded` follows a successful
      `board_complete_step`; `failed` a recovery that gave up on a failing
      step; `abandoned` a preemption or archive that stopped the step. The slot
      is released at every one of them (D4 Release). */
  outcome: Schema.Literals(["succeeded", "failed", "abandoned"]),
  createdAt: IsoDateTime,
});
export type BoardCardSettleStepCommand = typeof BoardCardSettleStepCommand.Type;

/**
 * Retune the live step's human-in-the-loop stance (D5/D6): flipping the
 * per-card toggle mid-run updates the frozen run-row so drop-monitoring and
 * auto-advance honour the new stance, while slot, worktree and thread are
 * untouched (the reactor also sends a turn into the live thread). Internal —
 * dispatched by the reactor when it observes the toggle change on a running
 * card.
 */
export const BoardCardRetuneStepCommand = Schema.Struct({
  type: Schema.Literal("board.card.retune-step"),
  commandId: CommandId,
  cardId: BoardCardId,
  stepId: TrimmedNonEmptyString,
  humanInLoop: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type BoardCardRetuneStepCommand = typeof BoardCardRetuneStepCommand.Type;

// ── Event payloads ─────────────────────────────────────────────────────

/**
 * Flat (not `{ card }`-shaped) because walking-skeleton events with the
 * original five fields are persisted in real dev event logs. Fields added
 * by t3o-03 carry decoding defaults mirroring migration 903's column
 * defaults, so legacy events replay to exactly the card their legacy table
 * rows rehydrate to.
 */
export const BoardCardCreatedPayload = Schema.Struct({
  cardId: BoardCardId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  key: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed(LEGACY_BOARD_CARD_KEY)),
  ),
  cardNumber: NonNegativeInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(LEGACY_BOARD_CARD_NUMBER)),
  ),
  /** Legacy only (t3o-06a): walking-skeleton and pre-label `card-created`
      events carry a `cardType`; new events carry `labels` instead. When both
      are absent the projector maps the missing type to the `feature` seed
      label, mirroring migration 903's `card_type DEFAULT 'feature'`. */
  cardType: Schema.optionalKey(LegacyBoardCardType),
  /** New events (t3o-06a): the card's labels at creation. Absent on legacy
      events, where the projector derives a one-element set from `cardType`. */
  labels: Schema.optionalKey(Schema.Array(BoardLabelId)),
  /** Brief body captured at creation (t3o-06). Absent on legacy events and
      whenever the card was created without one; when present the projector
      writes it to `board_card_bodies` and sets `briefRef`. Mirrors the
      `board.card-updated` brief-set path. */
  brief: Schema.optionalKey(TrimmedNonEmptyString),
  /** Initial dependencies (t3o-06). Key-optional, resolved through
      `boardCardCreatedDependsOn` — absent (legacy events, deps-free creates)
      means the empty set, matching migration 903's `depends_on DEFAULT '[]'`,
      so a from-empty replay of a pre-t3o-06 log equals table rehydration. */
  dependsOn: Schema.optionalKey(Schema.Array(BoardCardId)),
  stage: BoardStageId.pipe(
    Schema.withDecodingDefault(Effect.succeed(BOARD_SEED_STAGE_IDS.backlog)),
  ),
  orderKey: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed(LEGACY_BOARD_CARD_ORDER_KEY)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BoardCardCreatedPayload = typeof BoardCardCreatedPayload.Type;

/**
 * The card's labels as of a `card-created` event: the new-event `labels`
 * field, or a one-element set derived from the legacy `cardType` (defaulting
 * to `feature`) — the migration-in-replay that keeps a from-empty replay of a
 * pre-t3o-06a log equal to the post-906-migration table rehydration.
 */
export function boardCardCreatedLabels(
  payload: BoardCardCreatedPayload,
): ReadonlyArray<BoardLabelId> {
  return payload.labels ?? [legacyBoardCardTypeLabelId(payload.cardType ?? "feature")];
}

/**
 * The card's dependencies as of a `card-created` event: the key-optional
 * `dependsOn` field, or the empty set when absent (legacy events and
 * deps-free creates). The single reader both projectors go through, so
 * "absent" and "no dependencies" are always the same set — the
 * migration-903-default-in-replay that keeps a from-empty replay equal to
 * table rehydration.
 */
export function boardCardCreatedDependsOn(
  payload: BoardCardCreatedPayload,
): ReadonlyArray<BoardCardId> {
  return payload.dependsOn ?? [];
}

export const BoardCardMovedPayload = Schema.Struct({
  cardId: BoardCardId,
  fromStage: BoardStageId,
  toStage: BoardStageId,
  card: BoardCard,
});
export type BoardCardMovedPayload = typeof BoardCardMovedPayload.Type;

export const BoardCardReorderedPayload = Schema.Struct({
  cardId: BoardCardId,
  orderKey: TrimmedNonEmptyString,
  card: BoardCard,
});
export type BoardCardReorderedPayload = typeof BoardCardReorderedPayload.Type;

export const BoardCardUpdatedPayload = Schema.Struct({
  cardId: BoardCardId,
  /** Absent: brief unchanged. Null: brief cleared. String: new body text for
      `board_card_bodies` (the body deliberately never enters the read
      model — D8). */
  brief: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  card: BoardCard,
});
export type BoardCardUpdatedPayload = typeof BoardCardUpdatedPayload.Type;

export const BoardCardThreadLinkedPayload = Schema.Struct({
  cardId: BoardCardId,
  threadId: ThreadId,
  role: TrimmedNonEmptyString,
  card: BoardCard,
});
export type BoardCardThreadLinkedPayload = typeof BoardCardThreadLinkedPayload.Type;

export const BoardCardThreadUnlinkedPayload = Schema.Struct({
  cardId: BoardCardId,
  threadId: ThreadId,
  /** Null: the thread was live and the link was removed. Set: the thread was
      deleted, so the link stays on the card as a tombstone (D9). */
  tombstonedAt: Schema.NullOr(IsoDateTime),
  card: BoardCard,
});
export type BoardCardThreadUnlinkedPayload = typeof BoardCardThreadUnlinkedPayload.Type;

export const BoardCardArchivedPayload = Schema.Struct({
  cardId: BoardCardId,
  archivedAt: IsoDateTime,
  card: BoardCard,
});
export type BoardCardArchivedPayload = typeof BoardCardArchivedPayload.Type;

export const BoardCardUnarchivedPayload = Schema.Struct({
  cardId: BoardCardId,
  card: BoardCard,
});
export type BoardCardUnarchivedPayload = typeof BoardCardUnarchivedPayload.Type;

// ── Label event payloads (t3o-06a) ─────────────────────────────────────
// Every label event carries the full post-change `label`, exactly as card
// events carry the full `card`: the catalogue shell delta is a pure function
// of the event (no projection re-read in ws.ts), and the projector gets
// replay determinism for free by upserting exactly what the decider computed.
// Delete/undelete are `label` upserts with `deletedAt` set/cleared (tombstone,
// not removal), so a single `label-upserted` delta covers all four verbs.

export const BoardLabelCreatedPayload = Schema.Struct({
  labelId: BoardLabelId,
  label: BoardLabel,
});
export type BoardLabelCreatedPayload = typeof BoardLabelCreatedPayload.Type;

export const BoardLabelUpdatedPayload = Schema.Struct({
  labelId: BoardLabelId,
  label: BoardLabel,
});
export type BoardLabelUpdatedPayload = typeof BoardLabelUpdatedPayload.Type;

export const BoardLabelDeletedPayload = Schema.Struct({
  labelId: BoardLabelId,
  deletedAt: IsoDateTime,
  label: BoardLabel,
});
export type BoardLabelDeletedPayload = typeof BoardLabelDeletedPayload.Type;

export const BoardLabelUndeletedPayload = Schema.Struct({
  labelId: BoardLabelId,
  label: BoardLabel,
});
export type BoardLabelUndeletedPayload = typeof BoardLabelUndeletedPayload.Type;

// ── Stage aggregate event payloads (t3o-15) ────────────────────────────
// Create / rename / reorder each carry the full post-change stage the
// projector writes verbatim (replay equals rehydration); delete carries just
// the id it removes.

export const BoardStageCreatedPayload = Schema.Struct({
  stageId: BoardStageId,
  stage: BoardStageDefinition,
});
export type BoardStageCreatedPayload = typeof BoardStageCreatedPayload.Type;

export const BoardStageRenamedPayload = Schema.Struct({
  stageId: BoardStageId,
  stage: BoardStageDefinition,
});
export type BoardStageRenamedPayload = typeof BoardStageRenamedPayload.Type;

export const BoardStageReorderedPayload = Schema.Struct({
  stageId: BoardStageId,
  stage: BoardStageDefinition,
});
export type BoardStageReorderedPayload = typeof BoardStageReorderedPayload.Type;

export const BoardStageDeletedPayload = Schema.Struct({
  stageId: BoardStageId,
});
export type BoardStageDeletedPayload = typeof BoardStageDeletedPayload.Type;

/** On-demand kickoff request (D7): the reactor reacts by beginning a stage run
    for the card's current stage. Carries the stage so the reactor need not
    re-read the card. */
export const BoardCardStageThreadRequestedPayload = Schema.Struct({
  cardId: BoardCardId,
  stageId: BoardStageId,
});
export type BoardCardStageThreadRequestedPayload = typeof BoardCardStageThreadRequestedPayload.Type;

// ── Agent write-path event payloads (t3o-08) ───────────────────────────
// Each carries the full post-change record its projector writes verbatim
// (activity entry / step completion / plan set), so replay and rehydration
// stay identical and the shell mapping needs no projection re-read. None of
// these changes the bounded card shell, so their shell-delta mapping is
// `Option.none()` — an agent's progress note or step completion is card
// DETAIL (board.subscribeCard / the MCP context tool), never a column-card
// field (D7 payload discipline).

export const BoardCardStepCompletedPayload = Schema.Struct({
  cardId: BoardCardId,
  completion: BoardStepCompletion,
});
export type BoardCardStepCompletedPayload = typeof BoardCardStepCompletedPayload.Type;

export const BoardPlansProposedPayload = Schema.Struct({
  cardId: BoardCardId,
  /** The resolved plan set (metadata + body) — replaces the card's plans. */
  plans: Schema.Array(BoardPlanWithBody),
});
export type BoardPlansProposedPayload = typeof BoardPlansProposedPayload.Type;

export const BoardPlanWrittenPayload = Schema.Struct({
  cardId: BoardCardId,
  planId: BoardPlanId,
  body: Schema.String,
  /** The post-write plan metadata (only `updatedAt` moves). */
  plan: BoardPlan,
});
export type BoardPlanWrittenPayload = typeof BoardPlanWrittenPayload.Type;
// Worktree lifecycle payloads (t3o-09). Each carries the whole post-change
// card, like every other non-created board event, so the shell-delta mapping
// stays a pure function of the event and the projectors upsert exactly what
// the decider computed.

export const BoardCardWorktreeProvisioningPayload = Schema.Struct({
  cardId: BoardCardId,
  branch: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  card: BoardCard,
});
export type BoardCardWorktreeProvisioningPayload = typeof BoardCardWorktreeProvisioningPayload.Type;

export const BoardCardWorktreeReadyPayload = Schema.Struct({
  cardId: BoardCardId,
  path: TrimmedNonEmptyString,
  card: BoardCard,
});
export type BoardCardWorktreeReadyPayload = typeof BoardCardWorktreeReadyPayload.Type;

export const BoardCardWorktreeFailedPayload = Schema.Struct({
  cardId: BoardCardId,
  error: TrimmedNonEmptyString,
  card: BoardCard,
});
export type BoardCardWorktreeFailedPayload = typeof BoardCardWorktreeFailedPayload.Type;

export const BoardCardWorktreeReclaimedPayload = Schema.Struct({
  cardId: BoardCardId,
  outcome: BoardCardWorktreeReclaimOutcome,
  reason: Schema.NullOr(TrimmedNonEmptyString),
  card: BoardCard,
});
export type BoardCardWorktreeReclaimedPayload = typeof BoardCardWorktreeReclaimedPayload.Type;

// Step-lifecycle event payloads (t3o-10). The recipe-snapshot event carries
// the full post-change `card` (like every worktree event), so the projector
// upserts it and the shell delta stays a pure function of the event. The step
// events carry the whole `BoardCardStepState` the decider computed, so the
// projector upserts exactly that and replay equals rehydration.

export const BoardCardStepSelectedPayload = Schema.Struct({
  cardId: BoardCardId,
  state: BoardCardStepState,
});
export type BoardCardStepSelectedPayload = typeof BoardCardStepSelectedPayload.Type;

export const BoardCardStepAdmittedPayload = Schema.Struct({
  cardId: BoardCardId,
  state: BoardCardStepState,
});
export type BoardCardStepAdmittedPayload = typeof BoardCardStepAdmittedPayload.Type;

export const BoardCardStepAwaitingInputPayload = Schema.Struct({
  cardId: BoardCardId,
  state: BoardCardStepState,
});
export type BoardCardStepAwaitingInputPayload = typeof BoardCardStepAwaitingInputPayload.Type;

export const BoardCardStepRecoveredPayload = Schema.Struct({
  cardId: BoardCardId,
  state: BoardCardStepState,
});
export type BoardCardStepRecoveredPayload = typeof BoardCardStepRecoveredPayload.Type;

export const BoardCardStepSettledPayload = Schema.Struct({
  cardId: BoardCardId,
  state: BoardCardStepState,
});
export type BoardCardStepSettledPayload = typeof BoardCardStepSettledPayload.Type;

export const BoardCardStepRetunedPayload = Schema.Struct({
  cardId: BoardCardId,
  state: BoardCardStepState,
});
export type BoardCardStepRetunedPayload = typeof BoardCardStepRetunedPayload.Type;

// ── Thread todo lists (t3o-18, D1/D3/D4) ───────────────────────────────

/**
 * Every provider the fork drives already emits a task list — Claude's
 * `TodoWrite`, Codex's `update_plan`, Cursor's `cursor/update_todos` — and
 * t3code already normalises all of them into one `turn.plan.updated` runtime
 * event. It is the single best answer to "what is this agent actually doing",
 * it costs nothing to obtain, and until t3o-18 the board threw it away.
 *
 * Naming discipline is part of the feature (t3o-18): `planTotal` / `planDone` /
 * `PlanPips` stay reserved for D12 sub-board plan cards, and
 * `projection_thread_proposed_plans` stays plan-mode. Four meanings of "plan"
 * already coexist in this codebase — this one is called **todos**, everywhere,
 * and never adds a fifth.
 *
 * A todo list belongs to a THREAD, not a card; a card may have several threads
 * and therefore several lists. The board keeps its own copy in
 * `board_thread_todos` as a projection-only side table — never a board domain
 * command or event (D1). That is licensed by the board's own D8 rule: nothing
 * branches on a todo. No stage transition, no step outcome, no gate, no
 * concurrency decision reads one. It is display state, and an event per revision
 * (10–18 per thread-turn) would dwarf every other board event in the log inside
 * a week, for state nothing decides on.
 *
 * The table is a CACHE, not a source of truth: the authoritative record already
 * exists upstream and durably, as a `turn.plan.updated` thread activity carrying
 * the full plan. That is the property that makes a non-event-sourced board table
 * safe to own here, and it is what must not be quietly lost.
 */

/** One character per todo item: `d` done, `i` in progress, `p` pending (D4).
    A capped status STRING, not derived counts — deriving pips from
    `(done, total, hasDoing)` renders a tidy `[done…][doing][pending…]` fiction
    that is wrong the moment an agent completes an item out of order, which they
    do. Still a scalar, ~30 bytes at the cap. */
export const BOARD_THREAD_TODO_STATUS_DONE = "d";
export const BOARD_THREAD_TODO_STATUS_IN_PROGRESS = "i";
export const BOARD_THREAD_TODO_STATUS_PENDING = "p";

/** Items beyond this are not STORED; the counts stay true, so a 47-item list
    stores 30 status characters and still reports `n/47` (D4). */
export const BOARD_THREAD_TODO_ITEMS_MAX = 30;

/** The in-progress item's text cap, truncated on code-point boundaries — the
    same treatment `BOARD_CARD_SHELL_TITLE_MAX_BYTES` gets, and for the same
    reason (the budget it protects is a wire-byte budget). */
export const BOARD_THREAD_TODO_CURRENT_MAX_BYTES = 120;

const todoTextEncoder = new TextEncoder();

/** Truncate on code-point boundaries (never splitting a surrogate pair),
    reserving room for the ellipsis, and trim before it so the result still
    decodes as a trimmed string on the receiving client. */
export function boundBoardTodoText(text: string, maxBytes: number): string {
  if (todoTextEncoder.encode(text).length <= maxBytes) return text;
  let kept = "";
  let keptBytes = 0;
  for (const codePoint of text) {
    const codePointBytes = todoTextEncoder.encode(codePoint).length;
    if (keptBytes + codePointBytes > maxBytes - 3) break;
    kept += codePoint;
    keptBytes += codePointBytes;
  }
  return `${kept.trimEnd()}…`;
}

/** The runtime plan-step shape, structurally: this file cannot import
    `providerRuntime.ts` (it is the contracts leaf every board module reads), and
    any `RuntimePlanStep` satisfies this. */
export interface BoardTodoSourceStep {
  readonly step: string;
  readonly status: "pending" | "inProgress" | "completed";
}

/** The board's cached summary of one thread's todo list. */
export interface BoardThreadTodoSummary {
  /** One status char per STORED item, capped at `BOARD_THREAD_TODO_ITEMS_MAX`. */
  readonly statuses: string;
  /** The in-progress item's text (capped), or null when nothing is in progress. */
  readonly currentText: string | null;
  /** TRUE counts, before capping — so `2/47` stays honest even when only 30
      pips are stored. */
  readonly doneCount: number;
  readonly totalCount: number;
}

/**
 * Summarise a `turn.plan.updated` plan into the board's cached shape. Pure, so
 * the projector that writes the cache and the tests that assert the caps share
 * one definition.
 */
export function boardThreadTodoSummary(
  plan: ReadonlyArray<BoardTodoSourceStep>,
): BoardThreadTodoSummary {
  let doneCount = 0;
  let currentText: string | null = null;
  let statuses = "";
  for (const [index, item] of plan.entries()) {
    if (item.status === "completed") doneCount += 1;
    if (item.status === "inProgress" && currentText === null) {
      currentText = boundBoardTodoText(item.step, BOARD_THREAD_TODO_CURRENT_MAX_BYTES);
    }
    if (index < BOARD_THREAD_TODO_ITEMS_MAX) {
      statuses +=
        item.status === "completed"
          ? BOARD_THREAD_TODO_STATUS_DONE
          : item.status === "inProgress"
            ? BOARD_THREAD_TODO_STATUS_IN_PROGRESS
            : BOARD_THREAD_TODO_STATUS_PENDING;
    }
  }
  return { statuses, currentText, doneCount, totalCount: plan.length };
}

/**
 * One live card↔thread link, with that thread's cached todo summary (D3).
 *
 * `BoardCardShell` gains NOTHING here. It is under a fixed byte budget asserted
 * at 1,000 cards and under a structural test that every field serialises to a
 * scalar apart from the single bounded `labelIds` array — and, more decisively,
 * card deltas "are a pure function of the card event and cannot carry live
 * thread state", which is precisely what a todo summary and a thread-priority
 * rule are. Denormalising onto the card shell would fight the architecture head
 * on.
 *
 * So the data rides the shell snapshot as its OWN array, following the
 * `boardLabels` precedent (it rides the shell once, never denormalised per
 * card). One entry per live (non-tombstoned) link on a non-archived card. The
 * todo fields are KEY-optional and absent when the thread has no list, so a bare
 * link entry is ~90 bytes and a populated one ~150 — and the common case
 * (threads without lists) costs almost nothing.
 *
 * `todoStatuses` is a string, so this entry is scalars-only too.
 */
export const BoardCardThreadShell = Schema.Struct({
  cardId: BoardCardId,
  threadId: ThreadId,
  /** One char per stored item: `d` | `i` | `p`. Absent when the thread has no
      list at all — never an empty string. */
  todoStatuses: Schema.optionalKey(TrimmedNonEmptyString),
  /** The in-progress item's text, absent when nothing is in progress. */
  todoCurrent: Schema.optionalKey(TrimmedNonEmptyString),
  todoDone: Schema.optionalKey(NonNegativeInt),
  todoTotal: Schema.optionalKey(NonNegativeInt),
  /** When the CURRENT item's text last changed (D6) — the anchor for "how long
      has it been on this item". `RuntimePlanStep` is `{ step, status }`: there is
      no item id and no timestamp anywhere upstream, so elapsed time has to be
      derived. Resetting on in-progress-TEXT change survives reordering and
      insertion, needs nothing new from any provider, and costs one column; it
      resets incorrectly only when an agent rewords a todo mid-flight — wrong,
      harmless, and rare. Index-based matching was rejected: agents insert and
      remove items routinely, so it either resets constantly or, worse, carries
      an elapsed time onto a different task. */
  todoStartedAt: Schema.optionalKey(IsoDateTime),
  todoUpdatedAt: Schema.optionalKey(IsoDateTime),
});
export type BoardCardThreadShell = typeof BoardCardThreadShell.Type;

/** Whether a cached list is complete — every stored item done, and at least one
    item. The card STRIP hides on this AND a stopped thread (D5): retention is a
    storage rule, visibility is a render rule, which is what lets a card show
    `5/5` at the moment the agent succeeds and lets a stale card fall back to its
    plain meta row without two different retention policies. */
export function boardThreadTodosComplete(
  entry: Pick<BoardCardThreadShell, "todoDone" | "todoTotal">,
): boolean {
  const total = entry.todoTotal ?? 0;
  return total > 0 && (entry.todoDone ?? 0) >= total;
}

// ── Card shell (t3o-04, D7) ────────────────────────────────────────────

/**
 * Activity state of the card's active linked thread, for the column-card
 * status indicator. Derived — never stored: `deriveBoardCardThreadState`
 * computes it from the linked thread's shell fields wherever current thread
 * shells are at hand (the server at snapshot time, the client continuously).
 */
export const BoardCardThreadState = Schema.Literals(["working", "waiting", "stopped", "none"]);
export type BoardCardThreadState = typeof BoardCardThreadState.Type;

/**
 * The bounded per-card summary that rides `OrchestrationShellSnapshot` and
 * the `card-upserted` shell delta (D7): exactly what a column card renders,
 * and nothing more. Scalars only — no id arrays, no bodies, no snapshots.
 * The full aggregate (`BoardCard`) stays server-side and reaches a client
 * only through `board.subscribeCard` for the one open card.
 *
 * Several fields have no data source yet; they are part of the shape now so
 * `t3o-06` renders against a stable contract, with the owning spec noted
 * beside each. A hardcoded `false` / `0` / absent key on one of those
 * fields is deliberate, not a bug.
 *
 * `BoardCardShell` payload discipline is enforced by tests
 * (`board.test.ts` in this package): a serialized shell stays under a fixed
 * byte budget, and the shell snapshot grows linearly with card count.
 */
export const BoardCardShell = Schema.Struct({
  // Identity — projected from `board_cards` (t3o-03).
  cardId: BoardCardId,
  key: TrimmedNonEmptyString,
  projectId: ProjectId,
  /** Label ids only (t3o-06a) — never `{name, colour}` per card. Names and
      colours ride the catalogue once (`OrchestrationShellSnapshot.boardLabels`);
      a client renders chips by looking each id up there. Bounded by
      `BOARD_CARD_LABELS_MAX`, so the shell stays scalar-plus-one-small-array
      and grows linearly with card count (asserted in `board.test.ts`). */
  labelIds: Schema.Array(BoardLabelId),
  stage: BoardStageId,
  orderKey: TrimmedNonEmptyString,
  /** Capped at `BOARD_CARD_SHELL_TITLE_MAX_BYTES` (UTF-8) by
      `makeBoardCardShell` (the aggregate's title is unbounded; the
      shell's is not). */
  title: TrimmedNonEmptyString,
  // Flags — projected from `board_cards` (t3o-03).
  blocked: Schema.Boolean,
  /** `dependsOn.length`; the ids themselves never ride the shell. */
  dependencyCount: NonNegativeInt,
  /** `briefRef !== null`. Named `hasBrief`, not the spec draft's `hasPlan`:
      the brief is the card's write-up, while "plan" is the sub-board plan
      concept that owns `planTotal`/`planDone` below — a `hasPlan` derived
      from briefs would collide with it the day real plans land. */
  hasBrief: Schema.Boolean,
  /** Null on every shell riding the live snapshot and the delta stream —
      archived cards leave both (D15). Populated only on the archive-page
      snapshot (t3o-13, D7), which reuses this same bounded shell so the
      archive view needs no second card type. */
  archivedAt: Schema.NullOr(IsoDateTime),
  /** Always false until t3o-11 wires PR detection. */
  hasPr: Schema.Boolean,
  /** Always 0 until t3o-11 wires attachments. */
  attachmentCount: NonNegativeInt,
  /** Whether the card is holding in the Building queue: it has been committed
      to Building (D18 "Begin build") but the governor has no free slot for its
      step yet, so the step sits `queued` rather than running (D11). A queued
      card is visible and reprioritisable — never a lying spinner. The client
      derives queue *position* from the order of the `queued` cards in the
      Building column (`boardBuildingQueueInfo`); the shell carries only this
      one boolean, so the D7 byte budget is unchanged.

      Like `threadState`, this is derived from state that is NOT on the card
      aggregate (the step-state read-model slice), so it cannot ride a
      card-carrying delta. The authoritative live source is the snapshot (set
      from step state) and the dedicated `card-queued` delta; card-carrying
      deltas rest it at false and the client preserves its last known value
      (`applyBoardShellStreamEvent`). */
  queued: Schema.Boolean,
  /** Whether the card's live step has given up (t3o-17, D3): recovery exhausted
      its consecutive-stall budget or crossed the per-stage-entry invocation
      ceiling, so nobody is working and nobody will until a human acts. Rendered
      distinctly from `awaitingInput` (a healthy agent question) — the "loud"
      half of stall detection — and the board offers a way to find every stalled
      card. Like `queued`, it is derived from the step-state read-model slice the
      card aggregate does not carry, so it rides its own `card-stalled` delta and
      the snapshot; card-carrying deltas rest it at false and the client
      preserves the last known value (`applyBoardShellStreamEvent`). */
  stalled: Schema.Boolean,
  // Thread-derived — joined from `board_card_thread_links` (902) and the
  // linked thread's shell; no new plumbing (t3o-04).
  threadState: BoardCardThreadState,
  /** The active linked thread's `hasPendingUserInput`. */
  awaitingInput: Schema.Boolean,
  /** The most recently linked live (non-tombstoned) thread, so clients can
      re-derive `threadState` / `awaitingInput` from the thread shells they
      already hold as those threads change — card deltas are a pure function
      of the card event and cannot carry live thread state (see
      `boardCardShellFromCard`). */
  activeThreadId: Schema.NullOr(ThreadId),
  // The summary fields below are KEY-optional, not nullable: an absent key
  // costs zero wire bytes, and with ~13 of them a `"field":null` per card
  // would rebuild a third of the payload the shell split just removed.
  // Absent means "no data" — today always, later "not a parent" / "not in
  // review".
  // Sub-board summary — absent until post-MVP sub-boards (D12
  // materialisation).
  planTotal: Schema.optionalKey(NonNegativeInt),
  planDone: Schema.optionalKey(NonNegativeInt),
  // Review summary — counts, never bodies; absent until the post-MVP
  // review pipeline lands, then populated only in the review stage.
  prNumber: Schema.optionalKey(NonNegativeInt),
  roundCurrent: Schema.optionalKey(NonNegativeInt),
  roundMax: Schema.optionalKey(NonNegativeInt),
  stepLabel: Schema.optionalKey(TrimmedNonEmptyString),
  severityCritical: Schema.optionalKey(NonNegativeInt),
  severityImprovement: Schema.optionalKey(NonNegativeInt),
  severityNitpick: Schema.optionalKey(NonNegativeInt),
  issuesFixed: Schema.optionalKey(NonNegativeInt),
  issuesRejected: Schema.optionalKey(NonNegativeInt),
  issuesOpen: Schema.optionalKey(NonNegativeInt),
  issuesDisputed: Schema.optionalKey(NonNegativeInt),
});
export type BoardCardShell = typeof BoardCardShell.Type;

/**
 * The thread-shell fields the card shell derives its thread state from.
 * Structural (not `Pick<OrchestrationThreadShell, …>`) because this file
 * cannot import `orchestration.ts` — any `OrchestrationThreadShell`
 * satisfies it.
 */
export interface BoardThreadStateSource {
  readonly hasPendingUserInput: boolean;
  readonly hasPendingApprovals: boolean;
  readonly session?: { readonly status: string } | null | undefined;
  readonly backgroundLiveness?: "working" | "monitoring" | null | undefined;
}

/**
 * Thread-derived card fields, shared by the server (snapshot enrichment)
 * and the client (live re-derivation as thread shells change). "Waiting"
 * outranks "working": a blocked agent needs the human, which is the signal
 * the board exists to surface.
 *
 * Aggregated across EVERY live-linked thread (t3o-18, D7), not just the card's
 * `activeThreadId`. Taking only the most recently *linked* live link meant a
 * card whose OLDER thread was awaiting input showed no "Input needed" badge at
 * all, and a card with work running in a non-active thread looked dead. Both
 * were shipped bugs. The precedence is the one this function already documented,
 * lifted from one thread to N: `waiting` if any thread waits, else `working` if
 * any runs, else `stopped`; `awaitingInput` is an OR.
 *
 * The badge and the card's todo STRIP are allowed to reflect different threads,
 * and that is correct: the badge answers "does this card need me", a question
 * about *any* thread; the strip answers "what is being worked on", a question
 * about *one*.
 *
 * Accepts a single thread, an array, or nothing, so every existing caller keeps
 * working and the shared server/client shape stays one function — the snapshot
 * and the client's live re-derivation can never disagree.
 */
export function deriveBoardCardThreadState(
  threads:
    | BoardThreadStateSource
    | ReadonlyArray<BoardThreadStateSource | null | undefined>
    | null
    | undefined,
): {
  readonly threadState: BoardCardThreadState;
  readonly awaitingInput: boolean;
} {
  const live = (Array.isArray(threads) ? threads : [threads]).filter(
    (thread): thread is BoardThreadStateSource => thread !== null && thread !== undefined,
  );
  if (live.length === 0) return { threadState: "none", awaitingInput: false };
  const awaitingInput = live.some((thread) => thread.hasPendingUserInput);
  if (awaitingInput || live.some((thread) => thread.hasPendingApprovals)) {
    return { threadState: "waiting", awaitingInput };
  }
  const working = live.some((thread) => {
    const sessionStatus = thread.session?.status;
    return (
      sessionStatus === "starting" ||
      sessionStatus === "running" ||
      thread.backgroundLiveness === "working"
    );
  });
  return { threadState: working ? "working" : "stopped", awaitingInput };
}

/** The card's active thread: the most recently linked live link, by the
    same canonical (linkedAt, threadId) order the aggregate uses. */
export function activeBoardCardThreadId(
  links: ReadonlyArray<BoardCardThreadLink>,
): ThreadId | null {
  const live = sortBoardCardThreadLinks(links.filter((link) => link.tombstonedAt === null));
  return live.at(-1)?.threadId ?? null;
}

/**
 * The one unbounded scalar on the card aggregate is the user-entered
 * title; the shell caps it here so the serialized shell has a real upper
 * bound (the byte-budget test saturates this cap). A column card renders
 * at most a couple of lines; the full title rides `board.subscribeCard`
 * with the rest of the detail.
 *
 * The cap is measured in UTF-8 **bytes**, not string length — the budget
 * it protects is a wire-byte budget, and a 200-code-unit CJK title would
 * serialize to ~3× the bytes of an ASCII one. Truncation walks code points
 * (never splitting a surrogate pair) and reserves room for the ellipsis.
 */
export const BOARD_CARD_SHELL_TITLE_MAX_BYTES = 200;

const shellTitleEncoder = new TextEncoder();
const ELLIPSIS_UTF8_BYTES = 3;

function boundShellTitle(title: string): string {
  if (shellTitleEncoder.encode(title).length <= BOARD_CARD_SHELL_TITLE_MAX_BYTES) return title;
  let kept = "";
  let keptBytes = 0;
  for (const codePoint of title) {
    const codePointBytes = shellTitleEncoder.encode(codePoint).length;
    if (keptBytes + codePointBytes > BOARD_CARD_SHELL_TITLE_MAX_BYTES - ELLIPSIS_UTF8_BYTES) break;
    kept += codePoint;
    keptBytes += codePointBytes;
  }
  // trimEnd before the ellipsis: a trailing space would fail the schema's
  // trimmed-string decode on the receiving client.
  return `${kept.trimEnd()}…`;
}

/**
 * Shell assembly shared by every producer (SQL snapshot rows, event-carried
 * cards, tests), so the not-yet-sourced fields are hardcoded in exactly one
 * place with their owning specs documented on the schema above.
 */
export function makeBoardCardShell(input: {
  readonly cardId: BoardCardId;
  readonly key: string;
  readonly projectId: ProjectId;
  readonly labelIds: ReadonlyArray<BoardLabelId>;
  readonly stage: BoardStageId;
  readonly orderKey: string;
  readonly title: string;
  readonly blocked: boolean;
  readonly dependencyCount: number;
  readonly hasBrief: boolean;
  /** Omitted by every live producer — the archive page is the only caller
      that has an archived card to describe (t3o-13, D7). */
  readonly archivedAt?: IsoDateTime | null | undefined;
  readonly activeThreadId: ThreadId | null;
  /** Whether the card's live step is holding in the queue (t3o-11, D11).
      The snapshot builder passes the real value (derived from step state);
      card-carrying delta producers omit it, resting it at false — the client
      preserves its last known queued value across those deltas. */
  readonly queued?: boolean | undefined;
  /** Whether the card's live step has stalled (t3o-17, D3). The snapshot builder
      passes the real value (derived from step state); card-carrying delta
      producers omit it, resting it at false — the client preserves its last
      known stalled value across those deltas. */
  readonly stalled?: boolean | undefined;
  /** Every LIVE-linked thread's shell (t3o-18, D7) — the badge aggregates
      across all of them. A single thread is still accepted (delta producers and
      tests pass one, or none). */
  readonly thread?:
    | BoardThreadStateSource
    | ReadonlyArray<BoardThreadStateSource | null | undefined>
    | null
    | undefined;
}): BoardCardShell {
  const { threadState, awaitingInput } = deriveBoardCardThreadState(input.thread);
  return {
    cardId: input.cardId,
    key: input.key,
    projectId: input.projectId,
    labelIds: input.labelIds,
    stage: input.stage,
    orderKey: input.orderKey,
    title: boundShellTitle(input.title),
    blocked: input.blocked,
    dependencyCount: input.dependencyCount,
    hasBrief: input.hasBrief,
    archivedAt: input.archivedAt ?? null,
    hasPr: false, // t3o-11
    attachmentCount: 0, // t3o-11
    queued: input.queued ?? false, // t3o-11 (D11): real on the snapshot, rests false on card deltas
    stalled: input.stalled ?? false, // t3o-17 (D3): real on the snapshot, rests false on card deltas
    threadState,
    awaitingInput,
    activeThreadId: input.activeThreadId,
    // planTotal / planDone (post-MVP sub-boards), prNumber / round* /
    // stepLabel / severity* / issues* (post-MVP review pipeline): key-
    // optional and deliberately absent until their producing specs land.
  };
}

/**
 * Shell from a full card. The `thread` source is optional because the shell
 * delta mapping in the projector is a pure function of the board event — it
 * has the card but no thread shells, so delta-carried shells leave the
 * thread-derived fields at their "none" resting state and the client
 * reducer immediately re-derives them via `activeThreadId` against the
 * thread shells it already holds (`applyBoardShellStreamEvent`). Snapshot
 * producers pass the joined thread and emit the real values directly.
 */
export function boardCardShellFromCard(
  card: BoardCard,
  thread?: BoardThreadStateSource | ReadonlyArray<BoardThreadStateSource | null | undefined> | null,
): BoardCardShell {
  return makeBoardCardShell({
    cardId: card.id,
    key: card.key,
    projectId: card.projectId,
    labelIds: card.labels,
    stage: card.stage,
    orderKey: card.orderKey,
    title: card.title,
    blocked: card.blocked,
    dependencyCount: card.dependsOn.length,
    hasBrief: card.briefRef !== null,
    archivedAt: card.archivedAt,
    activeThreadId: activeBoardCardThreadId(card.threadLinks),
    thread,
  });
}

// ── Shell deltas ───────────────────────────────────────────────────────

/**
 * Card deltas on the shell stream, mirroring `thread-upserted` /
 * `thread-removed`. Archiving emits `card-removed` (the card leaves the
 * live board every client renders); unarchiving emits `card-upserted`.
 * Deltas carry the bounded `BoardCardShell`, never the full aggregate —
 * the same payload discipline as the snapshot (D7).
 */
export const BoardCardUpsertedShellEvent = Schema.Struct({
  kind: Schema.Literal("card-upserted"),
  sequence: NonNegativeInt,
  card: BoardCardShell,
});
export type BoardCardUpsertedShellEvent = typeof BoardCardUpsertedShellEvent.Type;

export const BoardCardRemovedShellEvent = Schema.Struct({
  kind: Schema.Literal("card-removed"),
  sequence: NonNegativeInt,
  cardId: BoardCardId,
});
export type BoardCardRemovedShellEvent = typeof BoardCardRemovedShellEvent.Type;

/**
 * Queue-flag delta (t3o-11, D11): the card's `queued` flag flipped as the
 * governor admitted its step (→ running, `queued=false`) or held it for a slot
 * (→ `queued=true`). A dedicated one-boolean delta rather than a `card-upserted`
 * because `queued` is derived from the step-state read-model slice, which a
 * card-carrying event cannot see (the step events carry `state`, not the card,
 * and `BoardCard` has no step-state field). This is the exact analogue of how
 * `threadState` is a resting field on `card-upserted` re-derived by the client:
 * card-carrying deltas leave `queued` at its false rest value, this delta and
 * the snapshot are its authoritative source, and the client preserves the last
 * known value across card upserts. Its `kind` keeps the `card-` prefix, so it
 * routes through `isBoardShellStreamEvent` with zero core-seam change.
 */
export const BoardCardQueuedShellEvent = Schema.Struct({
  kind: Schema.Literal("card-queued"),
  sequence: NonNegativeInt,
  cardId: BoardCardId,
  queued: Schema.Boolean,
});
export type BoardCardQueuedShellEvent = typeof BoardCardQueuedShellEvent.Type;

/**
 * Stall-flag delta (t3o-17, D3): the card's `stalled` flag flipped as recovery
 * gave up on its step (→ `stalled=true`) or a retry / human answer put the step
 * back to work (→ `stalled=false`). A dedicated one-boolean delta, the exact
 * analogue of `card-queued`: `stalled` is derived from the step-state
 * read-model slice a card-carrying event cannot see (the step events carry
 * `state`, not the card), so this delta and the snapshot are its authoritative
 * source and the client preserves the last known value across card upserts. Its
 * `kind` keeps the `card-` prefix, so it routes through `isBoardShellStreamEvent`
 * with zero core-seam change.
 */
export const BoardCardStalledShellEvent = Schema.Struct({
  kind: Schema.Literal("card-stalled"),
  sequence: NonNegativeInt,
  cardId: BoardCardId,
  stalled: Schema.Boolean,
});
export type BoardCardStalledShellEvent = typeof BoardCardStalledShellEvent.Type;

/**
 * Card-thread delta (t3o-18, D3): the live card↔thread links of ONE card, with
 * their todo summaries — the whole set for that card, replaced wholesale.
 *
 * Wholesale rather than per-entry because the set changes for three different
 * reasons (a todo revision, a link, an unlink) and a replace is idempotent under
 * all three; a card carries a handful of threads, so the payload stays tiny.
 * `boardCardThreads` on the shell snapshot is the same data at connect time.
 *
 * Its `kind` keeps the `card-` prefix, so it routes through
 * `isBoardShellStreamEvent` with zero core-seam change — and, like every other
 * shell delta, it is emitted with the sequence of the domain event that caused
 * it, so resume-by-sequence stays exact.
 */
export const BoardCardThreadsShellEvent = Schema.Struct({
  kind: Schema.Literal("card-threads"),
  sequence: NonNegativeInt,
  cardId: BoardCardId,
  threads: Schema.Array(BoardCardThreadShell),
});
export type BoardCardThreadsShellEvent = typeof BoardCardThreadsShellEvent.Type;

/**
 * Catalogue delta (t3o-06a): a label created, renamed, recoloured, tombstoned
 * or restored. Carries the whole `BoardLabel` (including `deletedAt`), so a
 * recolour repaints every card that references it with no card deltas and no
 * snapshot refetch — the cards hold ids; the colour lives here. There is no
 * `label-removed`: a delete is a tombstone, so the label stays in the
 * catalogue with `deletedAt` set and rides as an upsert.
 *
 * This is the non-card board delta t3o-02a's `card-`-prefix rule flagged
 * ("revisit if non-card board deltas ever appear"). Its `kind` starts with
 * `label-`, and `isBoardShellStreamEvent` is widened to admit that prefix; the
 * rule is updated in docs/t3o/seams.md.
 */
export const BoardLabelUpsertedShellEvent = Schema.Struct({
  kind: Schema.Literal("label-upserted"),
  sequence: NonNegativeInt,
  label: BoardLabel,
});
export type BoardLabelUpsertedShellEvent = typeof BoardLabelUpsertedShellEvent.Type;

/**
 * Stage aggregate delta (t3o-15): a stage created, renamed or reordered. Carries
 * the whole `BoardStageDefinition`, so the board reads column order and labels
 * from the read model (D13) with no card deltas. Its `kind` starts with
 * `stage-`; `isBoardShellStreamEvent` admits that prefix too.
 */
export const BoardStageUpsertedShellEvent = Schema.Struct({
  kind: Schema.Literal("stage-upserted"),
  sequence: NonNegativeInt,
  stage: BoardStageDefinition,
});
export type BoardStageUpsertedShellEvent = typeof BoardStageUpsertedShellEvent.Type;

/** A stage removed (t3o-15): a delete is a real removal (not a tombstone), so
    unlike labels there is a `stage-removed` delta. */
export const BoardStageRemovedShellEvent = Schema.Struct({
  kind: Schema.Literal("stage-removed"),
  sequence: NonNegativeInt,
  stageId: BoardStageId,
});
export type BoardStageRemovedShellEvent = typeof BoardStageRemovedShellEvent.Type;

/**
 * Type guards for the `board.` / `card-` prefix rule. Generic over the input
 * union (rather than typed against `OrchestrationCommand` etc.) because this
 * file cannot import `orchestration.ts` — narrowing still resolves to the
 * board members of whatever union the caller holds, and the else-branch
 * excludes them, which is what keeps upstream's `satisfies never`
 * exhaustiveness checks intact after a board branch returns.
 */
export function isBoardCommand<Command extends { readonly type: string }>(
  command: Command,
): command is Extract<Command, { type: `board.${string}` }> {
  return command.type.startsWith("board.");
}

export function isBoardEvent<Event extends { readonly type: string }>(
  event: Event,
): event is Extract<Event, { type: `board.${string}` }> {
  return event.type.startsWith("board.");
}

export function isBoardShellStreamEvent<Event extends { readonly kind: string }>(
  event: Event,
): event is Extract<Event, { kind: `card-${string}` | `label-${string}` | `stage-${string}` }> {
  // t3o-06a widened this beyond the original `card-` prefix: label catalogue
  // deltas (`label-upserted`) are board shell deltas too; t3o-15 adds `stage-`
  // for the stage aggregate. All three prefixes route to the board reducer /
  // mapper; see docs/t3o/seams.md's prefix rule.
  return (
    event.kind.startsWith("card-") ||
    event.kind.startsWith("label-") ||
    event.kind.startsWith("stage-")
  );
}

/**
 * Registries spread into upstream unions by `orchestration.ts`. These are the
 * only places a new board command/event/delta needs registering on the
 * contracts side.
 */
export const BOARD_CLIENT_COMMANDS = [
  BoardCardCreateCommand,
  BoardCardMoveCommand,
  BoardCardReorderCommand,
  BoardCardUpdateCommand,
  BoardCardLinkThreadCommand,
  BoardCardUnlinkThreadCommand,
  BoardCardArchiveCommand,
  BoardCardUnarchiveCommand,
  BoardLabelCreateCommand,
  BoardLabelUpdateCommand,
  BoardLabelDeleteCommand,
  BoardLabelUndeleteCommand,
  BoardStageCreateCommand,
  BoardStageRenameCommand,
  BoardStageReorderCommand,
  BoardStageDeleteCommand,
  BoardCardStartStageThreadCommand,
  BoardCardCompleteStepCommand,
  BoardPlansProposeCommand,
  BoardPlanWriteCommand,
] as const;

/**
 * Server-internal board commands (t3o-09), spread into upstream's
 * `InternalOrchestrationCommand` — NOT `DispatchableClientOrchestrationCommand`
 * — so they join `OrchestrationCommand` (and thus `BoardCommand` and the
 * board decider) without ever becoming client-dispatchable. This is the
 * internal-command analogue of the client-command registry above; t3o-09 is
 * the first board spec to need it, exactly as t3o-04 was the first to open
 * the RPC seam layer. Adding another internal board command grows this
 * registry and touches no upstream-owned file.
 */
export const BOARD_INTERNAL_COMMANDS = [
  BoardCardProvisionWorktreeCommand,
  BoardCardRecordWorktreeCommand,
  BoardCardFailWorktreeCommand,
  BoardCardReclaimWorktreeCommand,
  BoardCardSelectStepCommand,
  BoardCardAdmitStepCommand,
  BoardCardAwaitStepInputCommand,
  BoardCardRecoverStepCommand,
  BoardCardSettleStepCommand,
  BoardCardRetuneStepCommand,
] as const;

export const BOARD_EVENT_TYPES = [
  "board.card-created",
  "board.card-moved",
  "board.card-reordered",
  "board.card-updated",
  "board.card-thread-linked",
  "board.card-thread-unlinked",
  "board.card-archived",
  "board.card-unarchived",
  "board.label-created",
  "board.label-updated",
  "board.label-deleted",
  "board.label-undeleted",
  "board.stage-created",
  "board.stage-renamed",
  "board.stage-reordered",
  "board.stage-deleted",
  "board.card-stage-thread-requested",
  "board.card-step-completed",
  "board.plans-proposed",
  "board.plan-written",
  "board.card-worktree-provisioning",
  "board.card-worktree-ready",
  "board.card-worktree-failed",
  "board.card-worktree-reclaimed",
  "board.card-step-selected",
  "board.card-step-admitted",
  "board.card-step-awaiting-input",
  "board.card-step-recovered",
  "board.card-step-settled",
  "board.card-step-retuned",
] as const;

export const BOARD_SHELL_STREAM_EVENTS = [
  BoardCardUpsertedShellEvent,
  BoardCardRemovedShellEvent,
  BoardCardQueuedShellEvent,
  BoardCardStalledShellEvent,
  BoardCardThreadsShellEvent,
  BoardLabelUpsertedShellEvent,
  BoardStageUpsertedShellEvent,
  BoardStageRemovedShellEvent,
] as const;

/**
 * Board members of the `OrchestrationEvent` union. The event base fields are
 * *injected* by `orchestration.ts` rather than imported here (the import
 * would be a module cycle — orchestration.ts imports this file — with a TDZ
 * failure at load), so upstream base-field changes flow into board events
 * automatically.
 */
export function makeBoardOrchestrationEvents<const Base extends Schema.Struct.Fields>(base: Base) {
  return [
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-created"),
      payload: BoardCardCreatedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-moved"),
      payload: BoardCardMovedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-reordered"),
      payload: BoardCardReorderedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-updated"),
      payload: BoardCardUpdatedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-thread-linked"),
      payload: BoardCardThreadLinkedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-thread-unlinked"),
      payload: BoardCardThreadUnlinkedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-archived"),
      payload: BoardCardArchivedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-unarchived"),
      payload: BoardCardUnarchivedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.label-created"),
      payload: BoardLabelCreatedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.label-updated"),
      payload: BoardLabelUpdatedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.label-deleted"),
      payload: BoardLabelDeletedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.label-undeleted"),
      payload: BoardLabelUndeletedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.stage-created"),
      payload: BoardStageCreatedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.stage-renamed"),
      payload: BoardStageRenamedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.stage-reordered"),
      payload: BoardStageReorderedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.stage-deleted"),
      payload: BoardStageDeletedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-stage-thread-requested"),
      payload: BoardCardStageThreadRequestedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-step-completed"),
      payload: BoardCardStepCompletedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.plans-proposed"),
      payload: BoardPlansProposedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.plan-written"),
      payload: BoardPlanWrittenPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-worktree-provisioning"),
      payload: BoardCardWorktreeProvisioningPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-worktree-ready"),
      payload: BoardCardWorktreeReadyPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-worktree-failed"),
      payload: BoardCardWorktreeFailedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-worktree-reclaimed"),
      payload: BoardCardWorktreeReclaimedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-step-selected"),
      payload: BoardCardStepSelectedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-step-admitted"),
      payload: BoardCardStepAdmittedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-step-awaiting-input"),
      payload: BoardCardStepAwaitingInputPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-step-recovered"),
      payload: BoardCardStepRecoveredPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-step-settled"),
      payload: BoardCardStepSettledPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-step-retuned"),
      payload: BoardCardStepRetunedPayload,
    }),
  ] as const;
}

/**
 * Compile-time drift guard: the `type` literals produced by
 * `makeBoardOrchestrationEvents` and the `BOARD_EVENT_TYPES` registry must
 * stay in lockstep — a member added to one but not the other would otherwise
 * surface only as a runtime decode failure. Both directions are asserted; if
 * either alias errors, a registry and the factory have drifted.
 */
type BoardEventTypeFromRegistry = (typeof BOARD_EVENT_TYPES)[number];
type BoardEventTypeFromFactory = ReturnType<
  typeof makeBoardOrchestrationEvents<Record<never, never>>
>[number]["Type"]["type"];
type _AssertExtends<A extends B, B> = A;
type _RegistryCoversFactory = _AssertExtends<BoardEventTypeFromFactory, BoardEventTypeFromRegistry>;
type _FactoryCoversRegistry = _AssertExtends<BoardEventTypeFromRegistry, BoardEventTypeFromFactory>;

// ── Board RPC surface (t3o-04) ─────────────────────────────────────────
// Board RPCs register through the registries below, spread into upstream's
// `WS_METHODS` / `WsRpcGroup` (rpc.ts) and `RPC_REQUIRED_SCOPES`
// (RpcAuthorization.ts). Adding a board RPC grows these registries and the
// server-side `boardRpcHandlers` factory — zero upstream files.

export const BOARD_WS_METHODS = {
  subscribeCard: "board.subscribeCard",
} as const;

/**
 * The streaming subset of `BOARD_WS_METHODS`, spread as one member into
 * client-runtime's `EnvironmentSubscriptionRpcTag` union. Grows here when a
 * future board RPC streams; a future *unary* board RPC needs nothing — the
 * upstream union derives unary tags by exclusion.
 */
export type BoardSubscriptionRpcTag = (typeof BOARD_WS_METHODS)["subscribeCard"];

export const BoardSubscribeCardInput = Schema.Struct({
  cardId: BoardCardId,
});
export type BoardSubscribeCardInput = typeof BoardSubscribeCardInput.Type;

/**
 * Heavy detail for the one open card (D7). Carries the full aggregate —
 * including `dependsOn`, `threadLinks` with tombstones (902), `externalRef`
 * and `recipeSnapshot` — plus the brief body from `board_card_bodies`
 * (901). One card's worth of detail is cheap; ALL cards' worth is what the
 * shell split exists to keep off the wire.
 *
 * Deliberately absent, added as optional fields by the spec that creates
 * their data (t3o-03's no-speculative-tables rule):
 * - plan bodies — post-MVP sub-boards
 * - review issue ledger — post-MVP review pipeline
 * - activity log — t3o-08 (`board_report_progress`)
 */
/**
 * One end of a dependency edge, resolved (t3o-13, D4). The shell snapshot
 * drops archived cards (D15) and carries only `dependencyCount`, never the
 * ids, so a client holding it can resolve neither an archived dependency's
 * title nor the set of cards depending on the open one. Both ride the
 * per-card detail instead, where the projection table — which keeps archived
 * rows — can resolve them.
 */
export const BoardCardDependencyRef = Schema.Struct({
  cardId: BoardCardId,
  key: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  stage: BoardStageId,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type BoardCardDependencyRef = typeof BoardCardDependencyRef.Type;

export const BoardCardDetail = Schema.Struct({
  card: BoardCard,
  /** Brief body text, or null when the card has no brief. */
  brief: Schema.NullOr(TrimmedNonEmptyString),
  /** Whether the card has any proposed plan (t3o-15, D6): the Build stage's
      per-card human-in-the-loop default flips on this — a card with a plan
      defaults to `humanInLoopWithPlan`, one without to `humanInLoopWithoutPlan`.
      Decodes to false on legacy detail payloads. */
  hasPlan: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** `card.dependsOn` resolved, in `dependsOn` order. Archived dependencies
      are included — they no longer gate, but they are still real cards and
      must read as such rather than as a dangling id. An id with no row left
      is simply absent. */
  dependencies: Schema.Array(BoardCardDependencyRef),
  /** Cards whose `dependsOn` names this one, archived included. Feeds the
      archive confirmation (t3o-13, D3), which counts only the live ones. */
  dependents: Schema.Array(BoardCardDependencyRef),
  /** The card's recorded step completions with their opaque payloads (t3o-16,
      D9). Carried on the detail so the modal can render a stage's structured
      output — the review loop's findings, dispositions and verdicts — from the
      same payloads the agents write, with no PR to anchor them to. Generic (any
      stage's completions), so the projector stays role-blind; only the view
      parses a review payload. Decodes to `[]` on legacy detail payloads. */
  stepCompletions: Schema.Array(BoardStepCompletion).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** The card's Activity rail (t3o-18, D10), newest last — a deterministic,
      actor-attributed projection of the board's own event log, NOT anything an
      agent narrated. Rides the detail because `board.subscribeCard` already
      re-emits on every board event for the open card, so the rail is live with
      no second subscription. Decodes to `[]` on legacy detail payloads. */
  activity: Schema.Array(BoardCardActivityEntry).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type BoardCardDetail = typeof BoardCardDetail.Type;

/**
 * The live dependents of a card — the ones an archive would affect (D3).
 * Archived dependents are invisible on the board and unaffected by the
 * archive, so they never justify a warning.
 */
export function liveBoardCardDependents(
  dependents: ReadonlyArray<BoardCardDependencyRef>,
): ReadonlyArray<BoardCardDependencyRef> {
  return dependents.filter((dependent) => dependent.archivedAt === null);
}

/**
 * Whether archiving this card warrants a confirmation (t3o-13, D3): only a
 * card that is not done and that live cards still depend on. Archiving a
 * done card cannot affect a dependent — done satisfies the gate before the
 * archive and the archive satisfies it after — and a card nothing depends on
 * has nothing to warn about.
 */
export function boardCardArchiveNeedsConfirmation(input: {
  readonly stage: BoardStageId;
  readonly dependents: ReadonlyArray<BoardCardDependencyRef>;
}): boolean {
  if (input.stage === "done") return false;
  return liveBoardCardDependents(input.dependents).length > 0;
}

/**
 * `board.subscribeCard` stream items. A single re-emitting frame: the
 * server sends the full detail on subscribe and again on every change to
 * the card (detail is one card — re-emitting whole beats event grammar).
 * A union so future item kinds are additive.
 */
export const BoardCardDetailStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("card-detail"),
    detail: BoardCardDetail,
  }),
]);
export type BoardCardDetailStreamItem = typeof BoardCardDetailStreamItem.Type;

export class BoardSubscribeCardError extends Schema.TaggedErrorClass<BoardSubscribeCardError>()(
  "BoardSubscribeCardError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** Spread into `WsRpcGroup` (`RpcGroup.make` is variadic). */
export const BOARD_RPCS = [
  Rpc.make(BOARD_WS_METHODS.subscribeCard, {
    payload: BoardSubscribeCardInput,
    success: BoardCardDetailStreamItem,
    error: Schema.Union([BoardSubscribeCardError, EnvironmentAuthorizationError]),
    stream: true,
  }),
] as const;

/**
 * Spread into `RPC_REQUIRED_SCOPES`. Board reads use the same scope class
 * as thread reads (D7 mirrors `subscribeThread`); board RPCs never invent a
 * scope tier — an authorization change is a security change and belongs to
 * a security-scoped spec.
 */
export const BOARD_RPC_SCOPES = {
  [BOARD_WS_METHODS.subscribeCard]: AuthOrchestrationReadScope,
} as const;

// ── Board settings (D10, t3o-07) ───────────────────────────────────────
// The typed configuration D10 promised would be data, not code. It lives in
// `ServerSettings.board`; the upstream seam in `contracts/settings.ts` is two
// one-line field appends (`board` on `ServerSettings` and `ServerSettingsPatch`)
// — the same frozen-single-field shape as `providerInstances`. Everything
// board-shaped grows here, never at the seam. Compiled-in defaults make an
// empty settings file a working pipeline.

/**
 * Per-project card identity (D14). The key prefix is stored, not computed at
 * read time: a project's FIRST card assigns an acronym derived from its name
 * (`boardProjectAcronym`) and persists it here, so renaming the project later
 * cannot re-derive a different prefix and split its keys in two. Settings can
 * override it at any point; the accent colours the project's cards. Keyed by
 * `ProjectId` because the board never owns project identity — it references
 * T3's registry.
 */
export const BoardProjectSettings = Schema.Struct({
  /** Null falls back to `DEFAULT_BOARD_KEY_PREFIX` — so a project entry can
      carry only a custom accent, or only a custom prefix, or both. */
  keyPrefix: Schema.NullOr(TrimmedNonEmptyString),
  /** Null means the deterministic hash accent (the `projectAccent` fallback). */
  accentColor: Schema.NullOr(TrimmedNonEmptyString),
});
export type BoardProjectSettings = typeof BoardProjectSettings.Type;

export const BoardProjectSettingsMap = Schema.Record(ProjectId, BoardProjectSettings);
export type BoardProjectSettingsMap = typeof BoardProjectSettingsMap.Type;

/** Concurrency governance (D11, consumed by t3o-11): a ceiling per provider
    instance plus a global ceiling. A per-instance value of `null` means "no
    cap for this instance, use the global limit" — clearing a cap is stored as
    null rather than by deleting the key, because settings patches merge through
    the stock `deepMerge`, which cannot delete a map key (see `BoardSettingsPatch`). */
export const BoardConcurrencySettings = Schema.Struct({
  perInstance: Schema.Record(ProviderInstanceId, Schema.NullOr(PositiveInt)),
  globalMaxConcurrent: PositiveInt,
});
export type BoardConcurrencySettings = typeof BoardConcurrencySettings.Type;

/**
 * Worktree reclaim policy. t3o-09 owns the worktree lifecycle and the exact
 * execution semantics, and may extend this set; t3o-07 provides the setting
 * the user edits and t3o-09 reads. Default matches D15 (archiving reclaims any
 * surviving worktree).
 */
export const BoardWorktreeRetention = Schema.Literals([
  "reclaim-on-archive",
  "reclaim-on-merge",
  "keep",
]);
export type BoardWorktreeRetention = typeof BoardWorktreeRetention.Type;

export const BoardLifecycleSettings = Schema.Struct({
  /** Days a card sits in Done before auto-archiving (D15, consumed by the
      Phase-2 archiver). */
  archiveAfterDays: PositiveInt,
  worktreeRetention: BoardWorktreeRetention,
});
export type BoardLifecycleSettings = typeof BoardLifecycleSettings.Type;

export const DEFAULT_BOARD_ARCHIVE_AFTER_DAYS = 7;
export const DEFAULT_BOARD_GLOBAL_MAX_CONCURRENT = 3;
export const DEFAULT_BOARD_STEP_TIMEOUT_MS = 30 * 60 * 1000;
/** Consecutive-stall ceiling per step (t3o-17, D1). Raised from 3 to 5: safe
    only because the counter now measures CONSECUTIVE unproductive stalls
    (`stallCount`, reset on progress), not cumulative nudges — five wedged stops
    in a row is a stuck agent, where five cumulative nudges was often a long
    healthy job. */
export const DEFAULT_BOARD_STEP_MAX_ATTEMPTS = 5;
/** Per-stage-entry invocation ceiling (t3o-17, D5): the runaway detector above
    the per-step ladder. When a stage entry's total `attempt` across all its
    steps crosses this, the stage stalls and escalates regardless of the
    per-step ladder — the backstop that makes t3o-16's rounds × phases ×
    attempts compound bound observable. Deliberately generous: a runaway
    detector, not a budget. */
export const DEFAULT_BOARD_MAX_INVOCATIONS_PER_STAGE_ENTRY = 20;

/**
 * A stage's execution config (D4), keyed by stage id in `BoardSettings.pipeline`
 * so renaming a stage never orphans its config. `autoExecute` alone by default;
 * every other field is progressive UI that appears once it is on. Every field
 * carries a decoding default so a partial `{ autoExecute, prompt }` entry — or
 * an empty settings file — decodes to a complete, runnable config.
 *
 * - `model` is a single `BoardModelSelection | null` (D4): `null` runs the stage
 *   on the global text-generation model, resolved to a concrete pair at stage
 *   entry (D12).
 * - `mode` governs resources (D5); `humanInLoop` governs the conversation for
 *   non-build stages; `humanInLoopWithPlan` / `humanInLoopWithoutPlan` are the
 *   build role's two per-card defaults (D6); `autoAdvance` moves the card to the
 *   next stage in order on a successful unattended run (D8).
 * - `timeoutMs` / `maxAttempts` are enforced only on an unattended run (D5).
 *
 * `kind` is the discriminant of a **discriminated union** (D4/D15): every stage
 * this spec ships is `{ kind: "simple", … }`, and t3o-16 widens this to
 * `Schema.Union(simple, review)` with `{ kind: "review", … }`. Because the
 * reactor never branches on `kind` — the executor registry (keyed by stage
 * role) is the single place that resolves an implementation — adding the review
 * member touches neither the reactor, decider, projector nor MCP. The literal
 * carries a decoding default so a partial `{ autoExecute, prompt }` entry still
 * decodes to a complete `simple` config.
 */
// ── Code review loop (t3o-16) ──────────────────────────────────────────
//
// The `review`-role stage is the one stage that is a LOOP, not a single
// prompt: review the worktree, triage the findings, adjudicate the fixes,
// repeat until a review round raises no blocking findings or a round cap
// stops it (D3). Its phases are compiled in — their order and existence are
// product decisions — while their prompts and models are per-phase settings,
// because the loop's economics depend on running a cheap reviewer against an
// expensive adjudicator (D2). None of this leaks past the `ReviewLoopExecutor`
// (registered against the `review` role) and the bespoke settings card; the
// reactor, decider, projector and MCP toolkit never learn the stage is special
// (D1). Findings ride the opaque completion payload — no new MCP tool, no new
// table, no new column (D4).

/** Finding severity, ported verbatim from the `pullrequest-review` skill (D5).
    `critical` and `improvement` block a review round; `nitpick` never does, so
    a round reporting only nitpicks converges. */
export const BOARD_REVIEW_SEVERITIES = ["critical", "improvement", "nitpick"] as const;
export const BoardReviewSeverity = Schema.Literals(BOARD_REVIEW_SEVERITIES);
export type BoardReviewSeverity = typeof BoardReviewSeverity.Type;

/** The convergence rule (D5), in one place: only these two severities block a
    round. A review round whose findings are all non-blocking converges. */
export function isBoardReviewBlockingSeverity(severity: BoardReviewSeverity): boolean {
  return severity !== "nitpick";
}

/** One finding raised by a review phase (D4). `file`/`line` are optional
    because a finding may be repo-wide; `id` keys the triage disposition and the
    adjudication verdict that ride the later phases' payloads. */
export const BoardReviewFinding = Schema.Struct({
  id: TrimmedNonEmptyString,
  severity: BoardReviewSeverity,
  file: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  line: Schema.NullOr(PositiveInt).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  title: TrimmedNonEmptyString,
  detail: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** The id of the inline PR review comment this finding was posted as (t3o-20
      D3), so `triage`/`adjudicate` can reply on the right thread. Optional: a
      finding raised before a PR existed, or a repo-wide finding with no line to
      anchor to, carries none — the phases then fall back to the
      `<!-- t3o-finding:<id> -->` marker in the comment body. */
  commentId: Schema.optional(TrimmedNonEmptyString),
});
export type BoardReviewFinding = typeof BoardReviewFinding.Type;

/** The `review` phase's completion payload (D4): the SHA it reviewed (D7) and
    the findings it raised. A malformed or absent payload fails the phase — it
    must NEVER be read as "no findings", which would converge the loop on a
    broken reviewer and pass unreviewed code (D4). */
export const BoardReviewPayload = Schema.Struct({
  reviewedSha: TrimmedNonEmptyString,
  findings: Schema.Array(BoardReviewFinding),
});
export type BoardReviewPayload = typeof BoardReviewPayload.Type;

/** A triage disposition (D4): for each blocking finding, either a fix or a
    reasoned rejection. */
export const BOARD_REVIEW_TRIAGE_ACTIONS = ["fixed", "rejected"] as const;
export const BoardReviewTriageAction = Schema.Literals(BOARD_REVIEW_TRIAGE_ACTIONS);
export type BoardReviewTriageAction = typeof BoardReviewTriageAction.Type;

export const BoardReviewDisposition = Schema.Struct({
  findingId: TrimmedNonEmptyString,
  action: BoardReviewTriageAction,
  note: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type BoardReviewDisposition = typeof BoardReviewDisposition.Type;

/** The `triage` phase's completion payload (D4/D7): the SHA it produced and one
    disposition per finding. */
export const BoardTriagePayload = Schema.Struct({
  fixedSha: TrimmedNonEmptyString,
  dispositions: Schema.Array(BoardReviewDisposition),
});
export type BoardTriagePayload = typeof BoardTriagePayload.Type;

/** An adjudication verdict (D4), the `pullrequest-rereview` vocabulary verbatim. */
export const BOARD_REVIEW_VERDICTS = [
  "fix-upheld",
  "fix-incomplete",
  "fix-absent",
  "rejection-justified",
  "rejection-unjustified",
] as const;
export const BoardReviewVerdict = Schema.Literals(BOARD_REVIEW_VERDICTS);
export type BoardReviewVerdict = typeof BoardReviewVerdict.Type;

export const BoardReviewAdjudication = Schema.Struct({
  findingId: TrimmedNonEmptyString,
  verdict: BoardReviewVerdict,
  note: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type BoardReviewAdjudication = typeof BoardReviewAdjudication.Type;

/** The `adjudicate` phase's completion payload (D4): one verdict per finding.
    Adjudicate never bounces back to triage — its verdicts ride into the next
    round's review as context and unresolved items resurface there (D3). */
export const BoardAdjudicatePayload = Schema.Struct({
  verdicts: Schema.Array(BoardReviewAdjudication),
});
export type BoardAdjudicatePayload = typeof BoardAdjudicatePayload.Type;

/** The three compiled-in review phases, in loop order (D2/D3). Phase `id` and
    `label` are code, not settings — no add, remove or reorder. */
export const BOARD_REVIEW_PHASE_IDS = ["review", "triage", "adjudicate"] as const;
export const BoardReviewPhaseId = Schema.Literals(BOARD_REVIEW_PHASE_IDS);
export type BoardReviewPhaseId = typeof BoardReviewPhaseId.Type;

export const BOARD_REVIEW_PHASE_LABELS: Record<BoardReviewPhaseId, string> = {
  review: "Review",
  triage: "Triage",
  adjudicate: "Adjudicate",
};

const BOARD_REVIEW_STEP_ID = /^(review|triage|adjudicate)@(\d+)$/;

/** The round-scoped step id scheme (D8): `<phase>@<round>` — `review@1`,
    `triage@1`, `review@2`. Minted and parsed in one place (shared by the
    server executor and the card-detail view) so the completion key and every
    reader's view of loop progress can never drift. */
export function reviewStepId(phase: BoardReviewPhaseId, round: number): string {
  return `${phase}@${round}`;
}

/** The step label `ReviewLoopExecutor` mints for a phase/round. Lives beside
    `reviewStepId` so the executor and the settings preview — which must show
    the user the same identity a real run carries — cannot drift. */
export function reviewStepLabel(phase: BoardReviewPhaseId, round: number): string {
  return `${BOARD_REVIEW_PHASE_LABELS[phase]} · round ${round}`;
}

export function parseReviewStepId(
  stepId: string,
): { readonly phase: BoardReviewPhaseId; readonly round: number } | null {
  const match = BOARD_REVIEW_STEP_ID.exec(stepId);
  if (match === null) return null;
  const round = Number.parseInt(match[2]!, 10);
  if (!Number.isInteger(round) || round < 1) return null;
  return { phase: match[1] as BoardReviewPhaseId, round };
}

export const DEFAULT_BOARD_REVIEW_ROUNDS = 5;

/** Default per-phase prompts (D2), ported from the `pullrequest-review` /
    `pullrequest-rereview` skills and slimmed to per-phase INTENT only: the
    `ReviewLoopExecutor` force-appends the loop protocol (round-scoped step
    ids, worktree diff, payload shape, severity vocabulary), so repeating the
    mechanics here would only drift from it. These carry the reviewer /
    triager / adjudicator persona a user then edits. */
export const DEFAULT_BOARD_REVIEW_PHASE_PROMPT =
  "Your job this round is to find every problem in this PR's changes and log each as a code review comment on the exact file and line it affects — a fresh-eyes senior engineer seeing the code for the first time, judging it as it stands. Read beyond the diff: pull in the validators, handlers, models, routes, config and existing tests the change touches or relies on, so each finding is grounded in how the code actually behaves. Weigh correctness and security first (injection, broken or missing auth, cross-tenant access, data loss, races, regressions of existing behaviour), then design, readability and test coverage. Rate each finding honestly — critical for anything that would cause an incident or break existing behaviour, improvement for code that works but is fragile or under-tested, nitpick for cosmetic — and never inflate a nit to force another round. Give every comment a concrete reason and a specific fix; if nothing blocks, say so.";
export const DEFAULT_BOARD_TRIAGE_PHASE_PROMPT =
  "Your job this round is to resolve every blocking finding the review raised — as the author, working the review comments one by one and answering each on its thread. Fix by preference; reject only when you have concrete evidence the finding is wrong (a test showing the current behaviour is correct, a spec or doc quote, or a counter-example from the codebase), and give that evidence in your reply. When you fix a behavioural or security defect, prove it with a test that fails before your change and passes after, and name that test in your reply so the adjudicator can check it. Fix the underlying cause, not the symptom, and when a finding admits several reasonable fixes pick the one most consistent with the surrounding code and say why.";
export const DEFAULT_BOARD_ADJUDICATE_PHASE_PROMPT =
  "Your job this round is to independently rule on how the author handled each finding — a skeptical adjudicator checking the work against the actual code, not taking the author's word for it. \"This is fixed\" is a hypothesis to test at the line, not a fact: for a claimed fix, read the real change and confirm it resolves the finding, and prefer proof from tests — where the author named a test that proves the fix, run or read it to confirm it actually exercises the finding and passes; for a behavioural or security fix, a passing test that would have caught the original problem is the strongest evidence and its absence is grounds for fix-incomplete. For a rejection, check whether its stated reason is genuinely true in the code, not merely plausible. Record a verdict on each finding and post it on its thread. Don't pad in either direction — a false upheld ships a real bug and a false absent burns a round.";

/** A single review phase's execution config (D2): its own prompt and its own
    model, so a thorough reviewer can pair with a cheap triager. `model` null
    runs the phase on the global text-generation model (resolved at run). */
export const BoardReviewPhaseExecution = Schema.Struct({
  prompt: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  model: Schema.NullOr(BoardModelSelection).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** The agent authority posture this review phase runs under (t3o-21). The user
      owns it; the board never forces it. UNSET (optional, no key) means "use
      the mode-based default" — `resolveBoardStageExecution` fills it: `auto`
      for a build-mode stage, `approval-required` otherwise. A value the user
      picked is honoured verbatim. */
  runtimeMode: Schema.optional(RuntimeMode),
  timeoutMs: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BOARD_STEP_TIMEOUT_MS)),
  ),
  maxAttempts: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BOARD_STEP_MAX_ATTEMPTS)),
  ),
});
export type BoardReviewPhaseExecution = typeof BoardReviewPhaseExecution.Type;

const makeDefaultReviewPhase = (prompt: string): BoardReviewPhaseExecution => ({
  prompt,
  model: null,
  timeoutMs: DEFAULT_BOARD_STEP_TIMEOUT_MS,
  maxAttempts: DEFAULT_BOARD_STEP_MAX_ATTEMPTS,
});

/** The compiled-in default for each phase — a per-phase default prompt, no
    per-phase model override (global default), stock timeout/attempts. */
export const DEFAULT_BOARD_REVIEW_PHASES = {
  review: makeDefaultReviewPhase(DEFAULT_BOARD_REVIEW_PHASE_PROMPT),
  triage: makeDefaultReviewPhase(DEFAULT_BOARD_TRIAGE_PHASE_PROMPT),
  adjudicate: makeDefaultReviewPhase(DEFAULT_BOARD_ADJUDICATE_PHASE_PROMPT),
} as const;

/**
 * The `{ kind: "simple" }` member (D4): every stage this spec-family ships save
 * the review stage. The reactor reads `prompt`, `model`, `mode`, `autoExecute`,
 * `autoAdvance`, `humanInLoop*`, `timeoutMs`, `maxAttempts` off it verbatim.
 */
export const BoardStageExecutionSimple = Schema.Struct({
  kind: Schema.Literal("simple").pipe(
    Schema.withDecodingDefault(Effect.succeed("simple" as const)),
  ),
  autoExecute: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  prompt: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  model: Schema.NullOr(BoardModelSelection).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** The agent authority posture this stage runs under (t3o-21). The user
      owns it; the board never forces it. UNSET (optional, no key) means "use
      the mode-based default" — `resolveBoardStageExecution` fills it: `auto`
      for a build-mode stage, `approval-required` otherwise. A value the user
      picked is honoured verbatim. */
  runtimeMode: Schema.optional(RuntimeMode),
  mode: BoardStageMode.pipe(Schema.withDecodingDefault(Effect.succeed("plan" as const))),
  humanInLoop: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  humanInLoopWithPlan: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  humanInLoopWithoutPlan: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  autoAdvance: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  timeoutMs: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BOARD_STEP_TIMEOUT_MS)),
  ),
  maxAttempts: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BOARD_STEP_MAX_ATTEMPTS)),
  ),
  /** Per-stage-entry invocation ceiling (t3o-17, D5), enforced only on an
      unattended run: when the stage entry's total `attempt` across its steps
      crosses it, the stage stalls regardless of the per-step ladder. */
  maxInvocationsPerStageEntry: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BOARD_MAX_INVOCATIONS_PER_STAGE_ENTRY)),
  ),
});
export type BoardStageExecutionSimple = typeof BoardStageExecutionSimple.Type;

/**
 * The `{ kind: "review" }` member (D2/D4) — the union widening t3o-15 designed
 * for. It carries EVERY field the simple member does (so the reactor keeps
 * reading `prompt`/`model`/`mode`/… uniformly and never learns this stage is a
 * loop), PLUS `rounds` and the three per-phase configs. `mode` defaults to
 * `build` (the loop needs the worktree, D6) and `humanInLoop` to off (an
 * unattended loop is the point, D2); the build-mode invariant is enforced by
 * `resolveBoardStageExecution`, which always resolves the review stage to a
 * review member, so a stored `mode` can never strand the loop without a
 * worktree. The top-level `prompt`/`model` are unused by the executor, which
 * composes each phase's run from `phases`.
 */
export const BoardStageExecutionReview = Schema.Struct({
  kind: Schema.Literal("review"),
  autoExecute: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  prompt: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  model: Schema.NullOr(BoardModelSelection).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** The agent authority posture this stage's top-level default runs under (t3o-21). The user
      owns it; the board never forces it. UNSET (optional, no key) means "use
      the mode-based default" — `resolveBoardStageExecution` fills it: `auto`
      for a build-mode stage, `approval-required` otherwise. A value the user
      picked is honoured verbatim. */
  runtimeMode: Schema.optional(RuntimeMode),
  mode: BoardStageMode.pipe(Schema.withDecodingDefault(Effect.succeed("build" as const))),
  humanInLoop: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  humanInLoopWithPlan: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  humanInLoopWithoutPlan: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  autoAdvance: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  timeoutMs: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BOARD_STEP_TIMEOUT_MS)),
  ),
  maxAttempts: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BOARD_STEP_MAX_ATTEMPTS)),
  ),
  /** Per-stage-entry invocation ceiling (t3o-17, D5), enforced only on an
      unattended run: when the stage entry's total `attempt` across its steps
      crosses it, the stage stalls regardless of the per-step ladder. Carried
      identically to the simple member so the reactor reads it uniformly. */
  maxInvocationsPerStageEntry: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BOARD_MAX_INVOCATIONS_PER_STAGE_ENTRY)),
  ),
  rounds: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_BOARD_REVIEW_ROUNDS))),
  phases: Schema.Struct({
    review: BoardReviewPhaseExecution.pipe(
      Schema.withDecodingDefault(Effect.succeed(DEFAULT_BOARD_REVIEW_PHASES.review)),
    ),
    triage: BoardReviewPhaseExecution.pipe(
      Schema.withDecodingDefault(Effect.succeed(DEFAULT_BOARD_REVIEW_PHASES.triage)),
    ),
    adjudicate: BoardReviewPhaseExecution.pipe(
      Schema.withDecodingDefault(Effect.succeed(DEFAULT_BOARD_REVIEW_PHASES.adjudicate)),
    ),
  }).pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_BOARD_REVIEW_PHASES))),
});
export type BoardStageExecutionReview = typeof BoardStageExecutionReview.Type;

/**
 * A stage's execution config (D4/D15) — a `kind`-discriminated union so the
 * codebase branches on stage kind in exactly two places (the executor registry
 * and the settings card). The simple member is tried first, and its `kind`
 * decoding default means a bare `{}` or a partial `{ autoExecute, prompt }`
 * still decodes to a complete simple config; a `{ kind: "review" }` entry falls
 * through to the review member.
 */
export const BoardStageExecution = Schema.Union([
  BoardStageExecutionSimple,
  BoardStageExecutionReview,
]);
export type BoardStageExecution = typeof BoardStageExecution.Type;

/** True when a resolved stage config is the review-loop member (D4). The one
    narrowing helper the executor registry and settings card share; nothing else
    branches on kind. */
export function isBoardReviewStageExecution(
  execution: BoardStageExecution,
): execution is BoardStageExecutionReview {
  return execution.kind === "review";
}

/**
 * Stage execution config keyed by stage id (D4). Keyed by stage id, not name,
 * so renaming a stage never orphans its config. A stage absent from the map
 * runs nothing (auto-execute off). Merged by the stock `deepMerge`, exactly as
 * the rest of settings.
 */
export const BoardPipeline = Schema.Record(Schema.String, BoardStageExecution);
export type BoardPipeline = typeof BoardPipeline.Type;

/** The all-defaults stage execution config (auto-execute off) — what a stage
    absent from the pipeline map resolves to, and the base a settings edit
    patches from. */
export const DEFAULT_BOARD_STAGE_EXECUTION: BoardStageExecution = Schema.decodeSync(
  BoardStageExecution,
)({});

/** The all-defaults review-loop config (D2): auto-execute on, build mode,
    unattended, the default round cap and the three default per-phase configs.
    The base a review settings edit patches from, and what the `review` stage
    resolves to when absent from the pipeline map. */
export const DEFAULT_BOARD_REVIEW_STAGE_EXECUTION: BoardStageExecutionReview = Schema.decodeSync(
  BoardStageExecution,
)({ kind: "review" }) as BoardStageExecutionReview;

/** The Building prompt (D4), intent only: completion / question mechanics are
    force-appended by the prompt envelope (`composeStepPrompt`), never carried
    in the editable body. */
export const DEFAULT_BOARD_BUILD_PROMPT =
  "Implement the card's brief on its branch, following its plan. Keep the work focused on what the card asks for — don't fold in unrelated changes. Prove your work with tests: write comprehensive tests for the behaviour you add. For any bug, first write a failing test that reproduces it, then fix the code until that test passes. Run the project's checks and fix what they catch until they pass. If the plan is wrong or missing something you need, say so instead of quietly working around it.";

/** The Planning prompt (D4), intent only: the `board_propose_plans`
    deliverable contract is force-appended by the envelope's `plan`-role
    postamble segment, so rewriting this prompt cannot break the plan
    pipeline. */
export const DEFAULT_BOARD_PLANNING_PROMPT = `Build a plan that allows us to implement the functionality requested on this card. Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time.

If a question can be answered by exploring the codebase, explore the codebase instead.`;

/**
 * Two stages ship with `Auto execute` on so an empty settings file is a working
 * pipeline (D4). Building runs unattended in `build` mode and auto-advances;
 * Planning runs human-in-the-loop in `plan` mode and stays. Every other stage
 * ships with `Auto execute` off (absent from the map).
 */
export const DEFAULT_BOARD_PIPELINE: BoardPipeline = {
  [BOARD_SEED_STAGE_IDS.building]: {
    kind: "simple",
    autoExecute: true,
    prompt: DEFAULT_BOARD_BUILD_PROMPT,
    model: null,
    mode: "build",
    humanInLoop: false,
    humanInLoopWithPlan: false,
    humanInLoopWithoutPlan: true,
    autoAdvance: true,
    timeoutMs: DEFAULT_BOARD_STEP_TIMEOUT_MS,
    maxAttempts: DEFAULT_BOARD_STEP_MAX_ATTEMPTS,
    maxInvocationsPerStageEntry: DEFAULT_BOARD_MAX_INVOCATIONS_PER_STAGE_ENTRY,
  },
  [BOARD_SEED_STAGE_IDS.planning]: {
    kind: "simple",
    autoExecute: true,
    prompt: DEFAULT_BOARD_PLANNING_PROMPT,
    model: null,
    mode: "plan",
    humanInLoop: true,
    humanInLoopWithPlan: false,
    humanInLoopWithoutPlan: true,
    autoAdvance: false,
    timeoutMs: DEFAULT_BOARD_STEP_TIMEOUT_MS,
    maxAttempts: DEFAULT_BOARD_STEP_MAX_ATTEMPTS,
    maxInvocationsPerStageEntry: DEFAULT_BOARD_MAX_INVOCATIONS_PER_STAGE_ENTRY,
  },
  // Code review ships as a working loop out of the box (t3o-16): auto-execute
  // on, build mode for the worktree, the default round cap and per-phase
  // prompts. The `ReviewLoopExecutor` reads this member; the reactor drives it
  // as any other stage.
  [BOARD_SEED_STAGE_IDS.review]: DEFAULT_BOARD_REVIEW_STAGE_EXECUTION,
};

export const BoardSettings = Schema.Struct({
  projects: BoardProjectSettingsMap.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  pipeline: BoardPipeline.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_BOARD_PIPELINE))),
  concurrency: BoardConcurrencySettings.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        perInstance: {},
        globalMaxConcurrent: DEFAULT_BOARD_GLOBAL_MAX_CONCURRENT,
      }),
    ),
  ),
  lifecycle: BoardLifecycleSettings.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        archiveAfterDays: DEFAULT_BOARD_ARCHIVE_AFTER_DAYS,
        worktreeRetention: "reclaim-on-archive" as const,
      }),
    ),
  ),
});
export type BoardSettings = typeof BoardSettings.Type;

/** Compiled-in defaults so zero configuration works (the empty-file case). */
export const DEFAULT_BOARD_SETTINGS: BoardSettings = Schema.decodeSync(BoardSettings)({});

// Patch mirrors `ServerSettingsPatch`'s optional-key style and is merged by the
// stock `applyServerSettingsPatch` `deepMerge` — no board-specific merge logic
// enters that upstream function. Two consequences drive the shapes here:
//
//   1. `deepMerge` replaces arrays wholesale, so a stage's step list is never
//      half-merged — editing or removing a step is a full-array replacement.
//   2. `deepMerge` key-unions objects and CANNOT delete a map key. So "revert a
//      project or instance to the default" is never expressed by omitting its
//      key (that would silently keep the old value); it is expressed by a
//      retained entry whose fields are null — `{ keyPrefix: null, accentColor:
//      null }` for a project, `null` for a per-instance cap. The resolvers treat
//      those nulls as "use the default", so a null entry and an absent key are
//      observationally identical, and clearing an override actually persists.

export const BoardConcurrencySettingsPatch = Schema.Struct({
  perInstance: Schema.optionalKey(Schema.Record(ProviderInstanceId, Schema.NullOr(PositiveInt))),
  globalMaxConcurrent: Schema.optionalKey(PositiveInt),
});
export type BoardConcurrencySettingsPatch = typeof BoardConcurrencySettingsPatch.Type;

export const BoardLifecycleSettingsPatch = Schema.Struct({
  archiveAfterDays: Schema.optionalKey(PositiveInt),
  worktreeRetention: Schema.optionalKey(BoardWorktreeRetention),
});
export type BoardLifecycleSettingsPatch = typeof BoardLifecycleSettingsPatch.Type;

export const BoardSettingsPatch = Schema.Struct({
  projects: Schema.optionalKey(BoardProjectSettingsMap),
  pipeline: Schema.optionalKey(BoardPipeline),
  concurrency: Schema.optionalKey(BoardConcurrencySettingsPatch),
  lifecycle: Schema.optionalKey(BoardLifecycleSettingsPatch),
});
export type BoardSettingsPatch = typeof BoardSettingsPatch.Type;

// ── Board settings resolution (pure; D4/D12) ───────────────────────────

/**
 * A stage's execution config (D4). A stage absent from the pipeline map runs
 * nothing — the all-defaults config (auto-execute off). Pure so it is callable
 * from the server (at stage entry, to freeze onto the run row), the client (to
 * render the settings card), and tests alike.
 *
 * The compiled-in review stage (t3o-16) always resolves to the review-loop
 * member: `mode: "build"` is a product invariant (the loop needs the worktree,
 * D6), so the resolver enforces it rather than trusting the stored config. An
 * absent `review` key (a partial pipeline that configured only Building) OR a
 * legacy/hand-edited `simple` entry at the review stage id both coerce to the
 * review default; only a genuine review member configured there (the settings
 * card's own writes) is passed through, preserving a user's rounds and per-phase
 * edits. This keys on the fixed compiled-in stage id, not on a role lookup — the
 * resolver has no stage definitions — so it is not a dispatch on `stage.role`.
 */
/**
 * The effective agent authority for a stage (t3o-21): honour a value the user
 * picked, otherwise default by mode — `auto` for a build-mode stage (writes in
 * its own worktree, approves routine actions, still asks for anything beyond),
 * `approval-required` for a plan-mode stage (runs in the SHARED project root,
 * so least authority). The board NEVER forces `full-access`; the old
 * `mode === "build" ? "full-access" : "approval-required"` in the reactor is
 * replaced by this. The same helper resolves each review phase (always
 * build-mode → defaults to `auto`).
 */
export function effectiveBoardRuntimeMode(
  runtimeMode: RuntimeMode | undefined,
  mode: BoardStageMode,
): RuntimeMode {
  return runtimeMode ?? (mode === "build" ? "auto" : "approval-required");
}

export function resolveBoardStageExecution(
  board: BoardSettings,
  stageId: BoardStageId,
): BoardStageExecution & { readonly runtimeMode: RuntimeMode } {
  const configured = board.pipeline[stageId];
  if (stageId === BOARD_SEED_STAGE_IDS.review) {
    // Coerce absent / legacy-simple entries to the review default, then FORCE
    // the build-mode + unattended invariants (D2/D6) even on a genuine review
    // member: a hand-edited `{ kind: "review", mode: "plan" }` would otherwise
    // pass through and strand the loop without a worktree. Enforced here, the
    // one resolution point, so the reactor keeps reading `mode`/`humanInLoop`
    // uniformly.
    const base =
      configured !== undefined && isBoardReviewStageExecution(configured)
        ? configured
        : DEFAULT_BOARD_REVIEW_STAGE_EXECUTION;
    return {
      ...base,
      mode: "build",
      humanInLoop: false,
      runtimeMode: effectiveBoardRuntimeMode(base.runtimeMode, "build"),
    };
  }
  // The plan / build role holders (seeded ids — roles are never created, so
  // the id ↔ role mapping is exact) get their invariants FORCED at the same
  // single resolution point: Planning always runs read-only and
  // human-in-the-loop, Building always runs in build mode, and the retired
  // "pause when a plan exists" stance is always off. A review member stored
  // under either key is ignored the same way a simple member under the review
  // key is.
  if (stageId === BOARD_SEED_STAGE_IDS.planning || stageId === BOARD_SEED_STAGE_IDS.building) {
    // An ABSENT entry resolves to that stage's SEEDED config, not the empty
    // all-defaults one: settings.json is written sparsely (every entry equal to
    // its compiled-in default is pruned), so "Planning is missing from the map"
    // is the normal state of a board whose Planning was never edited — and
    // resolving it to `autoExecute: false` with an empty prompt would silently
    // switch the seeded stage off. Mirrors the review branch above.
    const base =
      configured !== undefined && !isBoardReviewStageExecution(configured)
        ? configured
        : (DEFAULT_BOARD_PIPELINE[stageId] as BoardStageExecutionSimple);
    const forced =
      stageId === BOARD_SEED_STAGE_IDS.planning
        ? ({ mode: "plan", humanInLoop: true, humanInLoopWithPlan: false } as const)
        : ({ mode: "build", humanInLoopWithPlan: false } as const);
    return {
      ...base,
      ...forced,
      runtimeMode: effectiveBoardRuntimeMode(base.runtimeMode, forced.mode),
    };
  }
  const resolved = configured ?? DEFAULT_BOARD_STAGE_EXECUTION;
  return {
    ...resolved,
    runtimeMode: effectiveBoardRuntimeMode(resolved.runtimeMode, resolved.mode),
  };
}

/**
 * Resolve a stage config's `model` to the concrete provider-instance + model
 * pair a spawn runs on (D12), freezing it onto the run row so a running card
 * is unaffected by a later settings change.
 *
 * There is NO compiled-in board model: a stage the user has not pointed at a
 * model falls back to `fallback`, which the caller reads off the app's own
 * text-generation selection. A hardcoded pair (this used to be codex +
 * `DEFAULT_TEXT_GENERATION_MODEL`) is a pair the user may not have enabled at
 * all, so it spawned onto a model that could not run — and the settings card
 * advertised it as "Default".
 */
export function resolveBoardStageModelSelection(
  model: BoardModelSelection | null,
  fallback: BoardModelSelection,
): BoardModelSelection {
  return model ?? fallback;
}

/** The per-project key prefix as STORED, falling back to the compiled-in
    default when a project has no prefix yet (D14). Card-create dispatch goes
    through `assignBoardKeyPrefix` instead, which derives and persists an
    acronym rather than settling for the default. */
export function resolveBoardKeyPrefix(board: BoardSettings, projectId: ProjectId): string {
  return board.projects[projectId]?.keyPrefix ?? DEFAULT_BOARD_KEY_PREFIX;
}

/** Words a project name breaks into for acronym purposes: separators and
    camelCase humps both split, so `mesh.web`, `mesh-web` and `meshWeb` all
    read as two words. */
function boardProjectNameWords(title: string): ReadonlyArray<string> {
  return title
    .split(/[^A-Za-z0-9]+/u)
    .flatMap((word) => word.split(/(?<=[a-z0-9])(?=[A-Z])/u))
    .filter((word) => word.length > 0);
}

/**
 * A project's card-key acronym, derived from its name — `mesh.web -> MW`,
 * `core.agent.advisor -> CAA`, `backend -> BAC`. Multi-word names give their
 * initials (up to three), a single word its opening letters.
 *
 * `taken` is the set of prefixes other projects already hold; a collision
 * falls through to the shorter/longer shapes and finally to a numeric suffix,
 * so two similarly named projects never share a key namespace. Names with no
 * letters or digits at all fall back to `DEFAULT_BOARD_KEY_PREFIX`.
 *
 * Derivation only ever picks the FIRST prefix a project gets — the choice is
 * then persisted against the project id (`assignBoardKeyPrefix`), because a
 * prefix that moved with the project's name would orphan every key already
 * printed on a card.
 */
export function boardProjectAcronym(title: string, taken: ReadonlyArray<string> = []): string {
  const words = boardProjectNameWords(title);
  const used = new Set(taken.map((prefix) => prefix.toUpperCase()));
  const initials = words.map((word) => word[0]!.toUpperCase());
  const candidates = (
    words.length >= 2
      ? [initials.slice(0, 3).join(""), initials.slice(0, 2).join(""), words[0]!.slice(0, 3)]
      : words.length === 1
        ? [words[0]!.slice(0, 3), words[0]!.slice(0, 2)]
        : []
  )
    .map((candidate) => candidate.toUpperCase())
    .filter((candidate) => candidate.length > 0);
  const preferred = candidates.length > 0 ? candidates : [DEFAULT_BOARD_KEY_PREFIX];
  const free = preferred.find((candidate) => !used.has(candidate));
  if (free !== undefined) return free;
  // Every derived shape is spoken for — number the preferred one.
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${preferred[0]!}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return DEFAULT_BOARD_KEY_PREFIX;
}

/**
 * The prefix a project's next card key should carry, and whether that choice
 * is new (D14, amended): a project keeps whatever prefix it has been given —
 * from Settings or from an earlier assignment — and a project with none is
 * assigned an acronym derived from its name.
 *
 * `assigned: true` means the caller must PERSIST `prefix` against the project
 * before the keys go out, so the acronym survives a rename and never drifts
 * between cards. Callers that cannot persist should still use the prefix: a
 * derived key beats `CARD-1`, and the next writer settles it.
 */
export function assignBoardKeyPrefix(input: {
  readonly board: BoardSettings;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
}): { readonly prefix: string; readonly assigned: boolean } {
  const configured = input.board.projects[input.projectId]?.keyPrefix ?? null;
  if (configured !== null) return { prefix: configured, assigned: false };
  const taken = Object.entries(input.board.projects)
    .filter(([projectId]) => projectId !== input.projectId)
    .map(([, entry]) => entry.keyPrefix)
    .filter((prefix): prefix is string => prefix !== null);
  return { prefix: boardProjectAcronym(input.projectTitle, taken), assigned: true };
}

/** The per-project accent colour, or null when unset. */
export function resolveBoardProjectAccent(
  board: BoardSettings,
  projectId: ProjectId,
): string | null {
  return board.projects[projectId]?.accentColor ?? null;
}
