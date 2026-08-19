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
import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { DEFAULT_TEXT_GENERATION_MODEL } from "./model.ts";
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

// ── Stages ─────────────────────────────────────────────────────────────

/**
 * The fixed, closed stage set (D12), in board order. The decider derives
 * adjacency from this array and the stage UIs derive column order and
 * labels from it — it is the single source of stage ordering.
 */
export const BOARD_STAGES = [
  "backlog",
  "sprint",
  "planning",
  "ready",
  "building",
  "review",
  "merge",
  "done",
] as const;

export const BoardStage = Schema.Literals(BOARD_STAGES);
export type BoardStage = typeof BoardStage.Type;

export function boardStageIndex(stage: BoardStage): number {
  return BOARD_STAGES.indexOf(stage);
}

export function areBoardStagesAdjacent(a: BoardStage, b: BoardStage): boolean {
  return Math.abs(boardStageIndex(a) - boardStageIndex(b)) === 1;
}

/** Dependency gating starts at Ready (D18): a card may reach Ready with
    unmet dependencies and is blocked from Ready onward, never earlier. */
export function isBoardStageReadyOrBeyond(stage: BoardStage): boolean {
  return boardStageIndex(stage) >= boardStageIndex("ready");
}

/** Sub-board plan cards (D12) use the Ready-onward stage subset; a card with
    a parent can never enter these stages, override or not. */
export function isBoardStageBeforeReady(stage: BoardStage): boolean {
  return boardStageIndex(stage) < boardStageIndex("ready");
}

/**
 * Cards may be created only into these stages (t3o-06a): later stages
 * describe work the board has already started shepherding, so a card cannot
 * appear mid-pipeline. A card still REACHES later stages the only way it
 * ever could — by being moved, under D18's human gate. The decider rejects a
 * create targeting any other stage; the web add button appears only on these
 * columns. Generalises t3o-03's "no create path may land a card in Building".
 */
export const BOARD_CREATABLE_STAGES = ["backlog", "sprint", "planning"] as const;

export function isBoardCreatableStage(stage: BoardStage): boolean {
  return (BOARD_CREATABLE_STAGES as ReadonlyArray<BoardStage>).includes(stage);
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

// ── Pipeline recipe (D10, t3o-07) ──────────────────────────────────────
// Stages are fixed (D12); the steps within a stage are configurable data in
// `ServerSettings.board` (`BoardSettings`, at the bottom of this file). A
// step is one short-lived thread with one job (D4): a prompt wrapped by the
// provider-neutral envelope (D5), pinned to a provider instance and model
// (D11 governs concurrency per instance), with a timeout and attempt cap. For
// the MVP only Building's recipe is executed (t3o-12); the rest are stored and
// displayed until later stages automate.

export const BoardStep = Schema.Struct({
  /** Stable within its stage; identifies the step across settings edits and
      through recovery/escalation (D13). */
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  /** The step prompt, wrapped by the envelope at execution (D5). A reference
      to a user skill instead of an inline template is post-MVP (t3o-10). */
  promptTemplate: Schema.String,
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  timeoutMs: PositiveInt,
  maxAttempts: PositiveInt,
});
export type BoardStep = typeof BoardStep.Type;

/**
 * The resolved recipe for one stage: exactly the ordered steps that stage
 * runs, resolved from `BoardSettings.pipeline` by `resolveBoardRecipeForStage`.
 * This is the value snapshotted onto a card on stage entry (D10).
 */
export const BoardResolvedRecipe = Schema.Struct({
  stage: Schema.Literals(BOARD_STAGES),
  steps: Schema.Array(BoardStep),
});
export type BoardResolvedRecipe = typeof BoardResolvedRecipe.Type;

/**
 * The resolved recipe captured on stage entry (D10). t3o-03 shipped this as an
 * opaque `Record` placeholder; t3o-07 tightens it to the real resolved-recipe
 * shape with no seam change — the `BoardCard.recipeSnapshot` field, its
 * `NullOr` wrapper, and the `board_cards.recipe_snapshot` JSON column are all
 * unchanged, and every existing writer stores `null`.
 *
 * Nothing in t3o-07 writes a non-null snapshot: the stage-entry reactor that
 * stamps the resolved recipe onto the card (calling `resolveBoardRecipeForStage`
 * against current settings, server-side where settings are in hand — the pure
 * decider cannot read settings, D8) lands with step execution (t3o-10), and
 * the Building automation consumes it (t3o-12). t3o-07 ships the resolver and
 * the divergence check (`boardRecipeSnapshotDiffersFromCurrent`) those specs
 * and the card UI build on, so "this card is running an older recipe than
 * current settings" is a one-call comparison the moment snapshots exist.
 */
export const BoardCardRecipeSnapshot = BoardResolvedRecipe;
export type BoardCardRecipeSnapshot = typeof BoardCardRecipeSnapshot.Type;

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
  stage: BoardStage,
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
  recipeSnapshot: Schema.NullOr(BoardCardRecipeSnapshot),
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
  readonly dependsOn: ReadonlyArray<BoardCardId>;
  readonly cards: ReadonlyArray<Pick<BoardCard, "id" | "stage" | "archivedAt">>;
}): ReadonlyArray<BoardCardId> {
  return input.dependsOn.filter((dependencyId) => {
    const dependency = input.cards.find((card) => card.id === dependencyId);
    if (dependency === undefined) return true;
    if (dependency.archivedAt !== null) return false;
    return dependency.stage !== "done";
  });
}

/**
 * Blocked derivation (D18): unmet dependencies block a card from Ready
 * onward and never earlier. Shared by the decider and any client that wants
 * a live view.
 */
export function deriveBoardCardBlocked(input: {
  readonly stage: BoardStage;
  readonly dependsOn: ReadonlyArray<BoardCardId>;
  readonly cards: ReadonlyArray<Pick<BoardCard, "id" | "stage" | "archivedAt">>;
}): boolean {
  if (!isBoardStageReadyOrBeyond(input.stage)) return false;
  return unmetBoardCardDependencies(input).length > 0;
}

// ── Agent write-path value types (t3o-08) ──────────────────────────────
// The records the agent-write-path events carry and `BoardState` holds. Their
// commands and event payloads are further down (with the other commands /
// payloads); these are up here because `BoardState` references them.

export const BoardActivityId = TrimmedNonEmptyString.pipe(Schema.brand("BoardActivityId"));
export type BoardActivityId = typeof BoardActivityId.Type;

/**
 * Progress notes and human-input requests share one card activity log: both
 * are human-readable, card-scoped, append-only facts an agent emits. `kind`
 * discriminates them. `input-requested` is the explicit gate hand-off (D13);
 * its thread-pending + APNs-notification wiring is the reactor's job (t3o-10),
 * so t3o-08 records it as a first-class, auditable board fact and the reactor
 * later reacts to `board.card-input-requested`. Activity bodies never enter
 * the read model (D8: nothing branches on them) — they live only in
 * `board_card_activity` and are read on demand by `board_get_card_context`.
 */
export const BOARD_CARD_ACTIVITY_KINDS = ["progress", "input-requested"] as const;
export const BoardCardActivityKind = Schema.Literals(BOARD_CARD_ACTIVITY_KINDS);
export type BoardCardActivityKind = typeof BoardCardActivityKind.Type;

export const BoardCardActivityEntry = Schema.Struct({
  activityId: BoardActivityId,
  cardId: BoardCardId,
  kind: BoardCardActivityKind,
  /** The progress note, or the question handed to the human. */
  body: TrimmedNonEmptyString,
  /** The thread that emitted it (the agent's), or null for a human/system
      note — kept so context can attribute activity to a step's thread. */
  threadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
});
export type BoardCardActivityEntry = typeof BoardCardActivityEntry.Type;

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
 * already treats any non-`running`/`awaiting-input` non-terminal status as a
 * re-drive. Every way in has a way out: `queued` → `running` on admission,
 * `awaiting-input` → `running` on the answer, and the three terminals
 * (`succeeded`, `failed`, `abandoned`) are the reverse states a running step
 * owes.
 */
export const BOARD_STEP_STATUSES = [
  "pending",
  "queued",
  "running",
  "awaiting-input",
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
  /** Stable step id from the card's `recipeSnapshot` (`BoardStep.id`). */
  stepId: TrimmedNonEmptyString,
  /** The step's human label, carried so a card can render "which step" without
      re-resolving the recipe. */
  stepLabel: TrimmedNonEmptyString,
  /** Attempt number, 1-based; recovery increments it. Capped at `maxAttempts`,
      past which recovery escalates to the human gate (D13). */
  attempt: PositiveInt,
  /** `BoardStep.maxAttempts` from the snapshot, carried so the card and the
      reactor read the escalation ceiling without re-resolving the recipe. */
  maxAttempts: PositiveInt,
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
  nextCardNumberByProject: {},
};

/** The label catalogue for a board slice: its `labels`, or the compiled seeds
    when absent (a board that has never touched a label). The single reader
    every decider/projector path goes through, so "absent" and "the three
    seeds" are always the same catalogue. */
export function boardLabelCatalogue(board: BoardState): ReadonlyArray<BoardLabel> {
  return board.labels ?? BOARD_SEED_LABELS;
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
  /** Target stage (t3o-06a). Absent lands in Backlog. The decider rejects any
      stage outside `BOARD_CREATABLE_STAGES` — a card cannot appear
      mid-pipeline. t3o-06 wires the create dialog's stage picker to this. */
  stage: Schema.optional(BoardStage),
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
  toStage: BoardStage,
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

export const BoardCardReportProgressCommand = Schema.Struct({
  type: Schema.Literal("board.card.report-progress"),
  commandId: CommandId,
  cardId: BoardCardId,
  /** A fresh unique id per entry (the tool handler mints one per call). It is
      NOT a retry-idempotency key — an MCP tool call carries no client-supplied
      one, so a retried `board_report_progress` appends a second note. That is
      acceptable for an append-only activity log (progress notes are cheap and
      called often); the one call whose retries must NOT double-count — the
      completion contract — is made idempotent in the decider (re-emit the
      first outcome by (cardId, stepId)), not by receipt dedup. */
  activityId: BoardActivityId,
  note: TrimmedNonEmptyString,
  threadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
});
export type BoardCardReportProgressCommand = typeof BoardCardReportProgressCommand.Type;

export const BoardCardRequestInputCommand = Schema.Struct({
  type: Schema.Literal("board.card.request-input"),
  commandId: CommandId,
  cardId: BoardCardId,
  activityId: BoardActivityId,
  question: TrimmedNonEmptyString,
  threadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
});
export type BoardCardRequestInputCommand = typeof BoardCardRequestInputCommand.Type;

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

export const BoardCardSnapshotRecipeCommand = Schema.Struct({
  type: Schema.Literal("board.card.snapshot-recipe"),
  commandId: CommandId,
  cardId: BoardCardId,
  /** The recipe resolved from current settings on stage entry (D10). Captured
      on the card so editing settings mid-flight cannot corrupt a running
      pipeline. The reactor resolves it server-side (the pure decider cannot
      read settings, D8). */
  recipe: BoardResolvedRecipe,
  createdAt: IsoDateTime,
});
export type BoardCardSnapshotRecipeCommand = typeof BoardCardSnapshotRecipeCommand.Type;

export const BoardCardSelectStepCommand = Schema.Struct({
  type: Schema.Literal("board.card.select-step"),
  commandId: CommandId,
  cardId: BoardCardId,
  /** The step resolved as next from the card's `recipeSnapshot`. */
  stepId: TrimmedNonEmptyString,
  stepLabel: TrimmedNonEmptyString,
  maxAttempts: PositiveInt,
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
  /** True when recovery has exhausted `maxAttempts` and escalates to the human
      gate (D13): the step goes to `awaiting-input` and never loops unbounded.
      False for an ordinary retry, which returns the step to `running`. */
  escalateToHuman: Schema.Boolean,
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
  stage: BoardStage.pipe(Schema.withDecodingDefault(Effect.succeed("backlog" as const))),
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
  fromStage: BoardStage,
  toStage: BoardStage,
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

// ── Agent write-path event payloads (t3o-08) ───────────────────────────
// Each carries the full post-change record its projector writes verbatim
// (activity entry / step completion / plan set), so replay and rehydration
// stay identical and the shell mapping needs no projection re-read. None of
// these changes the bounded card shell, so their shell-delta mapping is
// `Option.none()` — an agent's progress note or step completion is card
// DETAIL (board.subscribeCard / the MCP context tool), never a column-card
// field (D7 payload discipline).

export const BoardCardProgressReportedPayload = Schema.Struct({
  cardId: BoardCardId,
  entry: BoardCardActivityEntry,
});
export type BoardCardProgressReportedPayload = typeof BoardCardProgressReportedPayload.Type;

export const BoardCardInputRequestedPayload = Schema.Struct({
  cardId: BoardCardId,
  entry: BoardCardActivityEntry,
});
export type BoardCardInputRequestedPayload = typeof BoardCardInputRequestedPayload.Type;

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

export const BoardCardRecipeSnapshottedPayload = Schema.Struct({
  cardId: BoardCardId,
  recipe: BoardResolvedRecipe,
  card: BoardCard,
});
export type BoardCardRecipeSnapshottedPayload = typeof BoardCardRecipeSnapshottedPayload.Type;

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
  stage: BoardStage,
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
 */
export function deriveBoardCardThreadState(thread: BoardThreadStateSource | null | undefined): {
  readonly threadState: BoardCardThreadState;
  readonly awaitingInput: boolean;
} {
  if (thread === null || thread === undefined) {
    return { threadState: "none", awaitingInput: false };
  }
  const awaitingInput = thread.hasPendingUserInput;
  if (thread.hasPendingUserInput || thread.hasPendingApprovals) {
    return { threadState: "waiting", awaitingInput };
  }
  const sessionStatus = thread.session?.status;
  if (
    sessionStatus === "starting" ||
    sessionStatus === "running" ||
    thread.backgroundLiveness === "working"
  ) {
    return { threadState: "working", awaitingInput };
  }
  return { threadState: "stopped", awaitingInput };
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
  readonly stage: BoardStage;
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
  readonly thread?: BoardThreadStateSource | null | undefined;
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
  thread?: BoardThreadStateSource | null,
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
): event is Extract<Event, { kind: `card-${string}` | `label-${string}` }> {
  // t3o-06a widened this beyond the original `card-` prefix: label catalogue
  // deltas (`label-upserted`) are board shell deltas too. Both prefixes route
  // to the board reducer / mapper; see docs/t3o/seams.md's prefix rule.
  return event.kind.startsWith("card-") || event.kind.startsWith("label-");
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
  BoardCardReportProgressCommand,
  BoardCardRequestInputCommand,
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
  BoardCardSnapshotRecipeCommand,
  BoardCardSelectStepCommand,
  BoardCardAdmitStepCommand,
  BoardCardAwaitStepInputCommand,
  BoardCardRecoverStepCommand,
  BoardCardSettleStepCommand,
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
  "board.card-progress-reported",
  "board.card-input-requested",
  "board.card-step-completed",
  "board.plans-proposed",
  "board.plan-written",
  "board.card-worktree-provisioning",
  "board.card-worktree-ready",
  "board.card-worktree-failed",
  "board.card-worktree-reclaimed",
  "board.card-recipe-snapshotted",
  "board.card-step-selected",
  "board.card-step-admitted",
  "board.card-step-awaiting-input",
  "board.card-step-recovered",
  "board.card-step-settled",
] as const;

export const BOARD_SHELL_STREAM_EVENTS = [
  BoardCardUpsertedShellEvent,
  BoardCardRemovedShellEvent,
  BoardCardQueuedShellEvent,
  BoardLabelUpsertedShellEvent,
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
      type: Schema.Literal("board.card-progress-reported"),
      payload: BoardCardProgressReportedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("board.card-input-requested"),
      payload: BoardCardInputRequestedPayload,
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
      type: Schema.Literal("board.card-recipe-snapshotted"),
      payload: BoardCardRecipeSnapshottedPayload,
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
  stage: BoardStage,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type BoardCardDependencyRef = typeof BoardCardDependencyRef.Type;

export const BoardCardDetail = Schema.Struct({
  card: BoardCard,
  /** Brief body text, or null when the card has no brief. */
  brief: Schema.NullOr(TrimmedNonEmptyString),
  /** `card.dependsOn` resolved, in `dependsOn` order. Archived dependencies
      are included — they no longer gate, but they are still real cards and
      must read as such rather than as a dangling id. An id with no row left
      is simply absent. */
  dependencies: Schema.Array(BoardCardDependencyRef),
  /** Cards whose `dependsOn` names this one, archived included. Feeds the
      archive confirmation (t3o-13, D3), which counts only the live ones. */
  dependents: Schema.Array(BoardCardDependencyRef),
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
  readonly stage: BoardStage;
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

/**
 * The pipeline recipe: per stage, an ordered list of steps. Keyed by stage
 * name (a `BoardStage` string; the resolver reads `pipeline[stage] ?? []`), so
 * a settings edit that rewrites a stage's steps replaces that stage's whole
 * array — `deepMerge` in `applyServerSettingsPatch` replaces arrays wholesale,
 * so a step list is never half-merged. That is the same whole-map discipline
 * `providerInstances` documents, achieved without a merge seam. A stage absent
 * from the map runs no steps.
 */
export const BoardPipeline = Schema.Record(Schema.String, Schema.Array(BoardStep));
export type BoardPipeline = typeof BoardPipeline.Type;

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
export const DEFAULT_BOARD_STEP_MAX_ATTEMPTS = 3;
export const DEFAULT_BOARD_PROVIDER_INSTANCE_ID = ProviderInstanceId.make("codex");

/**
 * The one stage the MVP executes (t3o-12). A compiled-in Building step makes
 * the default pipeline a working pipeline with an empty settings file (the
 * spec's third verification). Provider instance and model mirror the stock
 * text-generation default so the default step is runnable, not a placeholder.
 */
export const DEFAULT_BOARD_BUILD_STEP: BoardStep = {
  id: "build",
  label: "Build",
  promptTemplate:
    "Implement the card's brief on its branch. Run the project's checks until they pass, then report completion through your completion tool. Ask any blocking question through your question tool rather than in prose.",
  providerInstanceId: DEFAULT_BOARD_PROVIDER_INSTANCE_ID,
  model: DEFAULT_TEXT_GENERATION_MODEL,
  timeoutMs: DEFAULT_BOARD_STEP_TIMEOUT_MS,
  maxAttempts: DEFAULT_BOARD_STEP_MAX_ATTEMPTS,
};

export const BoardSettings = Schema.Struct({
  projects: BoardProjectSettingsMap.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  pipeline: BoardPipeline.pipe(
    Schema.withDecodingDefault(Effect.succeed({ building: [DEFAULT_BOARD_BUILD_STEP] })),
  ),
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

// ── Board settings resolution (pure; D10) ──────────────────────────────

/**
 * The resolved recipe for a stage — what the stage-entry reactor (t3o-10)
 * snapshots onto a card and the Building automation (t3o-12) executes. Pure so
 * it is callable from the server (at stage entry), the client (to compute
 * divergence), and tests alike.
 */
export function resolveBoardRecipeForStage(
  board: BoardSettings,
  stage: BoardStage,
): BoardResolvedRecipe {
  return { stage, steps: board.pipeline[stage] ?? [] };
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

function boardStepsEqual(a: BoardStep, b: BoardStep): boolean {
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.promptTemplate === b.promptTemplate &&
    a.providerInstanceId === b.providerInstanceId &&
    a.model === b.model &&
    a.timeoutMs === b.timeoutMs &&
    a.maxAttempts === b.maxAttempts
  );
}

/**
 * Whether a card's captured recipe snapshot has diverged from what current
 * settings would resolve for the same stage (D10). A null snapshot has not
 * diverged — the card is not running a recipe. This is the "this card is on an
 * older recipe than settings" signal the card UI surfaces once t3o-10 stamps
 * snapshots; editing settings mid-stage changes what `resolveBoardRecipeForStage`
 * returns but never the stored snapshot, so the divergence is exactly the
 * visible consequence of the snapshot-on-entry rule.
 */
export function boardRecipeSnapshotDiffersFromCurrent(
  snapshot: BoardCardRecipeSnapshot | null,
  current: BoardResolvedRecipe,
): boolean {
  if (snapshot === null) return false;
  if (snapshot.stage !== current.stage) return true;
  if (snapshot.steps.length !== current.steps.length) return true;
  return snapshot.steps.some((step, index) => !boardStepsEqual(step, current.steps[index]!));
}
