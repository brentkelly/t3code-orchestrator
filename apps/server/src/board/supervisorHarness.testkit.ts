/**
 * Shared supervisor-reactor harness. `withGovernor` drives the live reactor against a
 * stateful engine double running the real decider and projector, with the in-memory
 * `ThreadGateway` fake. Inputs go through buffered queues and `reactor.drain` gates each
 * assertion. A `.testkit.ts` so the runner never collects it as an empty suite.
 */
import {
  BoardCardId,
  boardCardStepState,
  BOARD_SEED_STAGE_IDS,
  BoardStageId,
  DEFAULT_BOARD_AUTO_ARCHIVE_AFTER_DAYS,
  DEFAULT_BOARD_AUTO_ARCHIVE_DONE,
  DEFAULT_BOARD_AUTO_COLLAPSE_EMPTY_STAGES,
  DEFAULT_BOARD_BUILD_PROMPT,
  DEFAULT_BOARD_MAX_INVOCATIONS_PER_STAGE_ENTRY,
  DEFAULT_BOARD_STEP_MAX_ATTEMPTS,
  DEFAULT_BOARD_STEP_TIMEOUT_MS,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_TEXT_GENERATION_MODEL,
  ProjectId,
  type RepositoryIdentity,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardCommand,
  type BoardCardStepState,
  DEFAULT_BOARD_BUILD_STAGE_EXECUTION,
  DEFAULT_BOARD_MERGE_STAGE_EXECUTION,
  DEFAULT_BOARD_REVIEW_STAGE_EXECUTION,
  type BoardStepExecution,
  type BoardCardPullRequest,
  type BoardStageExecutionMerge,
  type BoardStageExecutionReview,
  type BoardCardWorktree,
  type BoardSettings,
  type BoardStageExecution,
  type BoardState,
  type BoardCiPass,
  type BoardEvent,
  type BoardConcurrencySettings,
  type ServerSettings,
  SourceControlProviderKind,
} from "@t3tools/contracts";

import type { BoardMergeState } from "./boardMergeState.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { BoardSetupScriptRunner } from "./ports/BoardSetupScriptRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { BoardStepSlots, BoardStepSlotsLive } from "./BoardStepSlots.ts";
import {
  BoardPullRequestGateway,
  BoardPullRequestGatewayError,
  type BoardFoundPullRequest,
  type BoardPullRequestRefusal,
} from "./BoardPullRequestGateway.ts";
import { boardDecidedEvents, decideBoardCommand, type PlannedBoardEvent } from "./decider.ts";
import { BoardEngine, loadDecisionContext } from "./BoardEngine.ts";
import { BoardQueries } from "./BoardQueries.ts";
import { boardRepositoryOf } from "./boardRepository.ts";
import { projectBoardEvent, type BoardReadModel } from "./projector.ts";
import { SupervisorReactor, SupervisorReactorLive } from "./supervisorReactor.ts";
import { BoardWorkspaces, type BoardWorkspacesShape } from "./workspace/BoardWorkspace.ts";
import type { LocalBoardWorkspaceDeps } from "./workspace/LocalBoardWorkspace.ts";
import { localBoardWorkspaceDeps, makeBoardWorkspaces } from "./workspace/workspaceLayer.ts";
import type { WorktreeRetirer } from "./worktreeRetire.ts";
import { worktreeRetirerTestLayer } from "./worktreeRetire.testkit.ts";
import {
  ThreadGateway,
  type BoardProject,
  type BoardThreadState,
  type LocalThreadGatewayShape,
  type ThreadGatewayShape,
  type ThreadSignal,
} from "./ThreadGateway.ts";
import { BoardPlacement, type BoardPlacementShape } from "./workers/BoardPlacement.ts";
import {
  aliveThread,
  failedThread,
  idleThread,
  makeFakeThreadGateway,
  type ThreadGatewayCall,
} from "./threadGateway.testkit.ts";

/** What the reactor hears — board events and thread signals — and what it
    sends: board commands and thread-gateway calls. */
export type HarnessEvent = BoardEvent | ThreadSignal;
export type HarnessCommand = BoardCommand | ThreadGatewayCall;

export const NOW = "2026-01-01T00:00:00.000Z";
export const projectId = ProjectId.make("project-1");
/** A SECOND project on the same server: a card changing project needs
    somewhere to go, and the reactor spawns the restarted thread against the
    card's new `projectId`. Inert for every other suite. */
export const otherProjectId = ProjectId.make("project-2");

/** The single build step a stage runs, in the stage-owned model: the
    provider instance the frozen run row spawns on, and the prompt the stage
    injects on first entry. `settingsWith` folds it into a Building stage's
    `BoardStageExecution`. */
export interface TestBuildStep {
  readonly providerInstanceId: ProviderInstanceId;
  readonly prompt: string;
}

export const codexStep: TestBuildStep = {
  providerInstanceId: ProviderInstanceId.make("codex"),
  prompt: DEFAULT_BOARD_BUILD_PROMPT,
};

/** A ready worktree — the state right after "Begin build" provisioned it. */
export const readyWorktree = (id: string): BoardCardWorktree => ({
  branch: `board/${id}`,
  baseRefName: "main",
  path: `/tmp/wt/${id}`,
  status: "ready",
  attempts: 1,
  lastError: null,
  reclaimBlockedReason: null,
});

/** A thread mid-turn: what boot reconcile must read as ALIVE. */
export const aliveThreadShell = (threadId: string): BoardThreadState => aliveThread(threadId);

/** A thread as a server restart leaves it: the session is marked
    `error` while the killed turn's ref LINGERS. The stale ref is the whole
    point of the fixture — it is what used to read as alive. */
export const failedThreadShell = (
  threadId: string,
  options?: { readonly staleActiveTurnId?: boolean },
): BoardThreadState =>
  failedThread(
    threadId,
    options?.staleActiveTurnId === undefined
      ? undefined
      : { staleActiveTurnRef: options.staleActiveTurnId },
  );

/** A thread between turns: the agent has stopped, nothing is pending. What a
    board thread looks like the moment its turn ends — and therefore the moment
    a release the decider refused mid-turn can finally land. */
export const idleThreadShell = (
  threadId: string,
  /** Which provider instance the thread runs on. */
  instanceId: ProviderInstanceId = codexStep.providerInstanceId,
): BoardThreadState => idleThread(threadId, instanceId);

/** A board card in an arbitrary stage. `worktree` defaults to null (no worktree
    before Building); pass one for a card the "Begin build" gate has
    already provisioned. */
export const makeBoardCard = (input: {
  readonly id: string;
  readonly stage: string;
  readonly orderKey: string;
  readonly worktree?: BoardCardWorktree | null;
  readonly pullRequest?: BoardCardPullRequest | null;
  readonly pullRequestHistory?: ReadonlyArray<BoardCardPullRequest>;
  readonly pullRequestFloor?: number | null;
  /** The card's scheduled start. Absent is unscheduled, which is what
      every fixture written before it reads as. */
  readonly scheduledStartAt?: string | null;
  /** The card's auto-start arm. Absent is unarmed. */
  readonly autoStart?: boolean;
  readonly autoPlanSetting?: boolean | null;
  readonly autoBuildSetting?: boolean | null;
  readonly autoMergeSetting?: boolean | null;
  /** The per-card auto-merge arm. */
  readonly autoMerge?: boolean;
  /** A recorded auto-merge hold — the state a refused armed
      merge leaves behind. */
  readonly autoMergeHold?: BoardCard["autoMergeHold"];
  /** Where the card is pinned and placed. Absent follows the default
      and has never run, as every fixture written before workers reads. */
  readonly pinnedWorkerId?: BoardCard["pinnedWorkerId"];
  readonly placedWorkerId?: BoardCard["placedWorkerId"];
  readonly workerMove?: BoardCard["workerMove"];
  readonly placementOrphaned?: BoardCard["placementOrphaned"];
  /** The card's CI entry and last CI outcome. */
  readonly ci?: BoardCard["ci"];
  readonly ciLastOutcome?: BoardCard["ciLastOutcome"];
  readonly ciRoundTrips?: number;
  /** The card's own merge strategy. Absent follows the default. */
  readonly mergeStrategy?: BoardCard["mergeStrategy"];
  /** The cards this one waits on. Absent is nothing. */
  readonly dependsOn?: ReadonlyArray<string>;
  /** The sub-board parent this card is a child of. Absent is
      top-level, which every fixture written before sub-boards reads as. */
  readonly parentCardId?: string | null;
  /** The card's human-in-the-loop OVERRIDE. Absent is `null` — no
      override, so the step takes its stage's stance. */
  readonly humanInLoop?: boolean | null;
}): BoardCard => ({
  id: BoardCardId.make(input.id),
  key: input.id.toUpperCase(),
  cardNumber: 1,
  projectId,
  labels: [],
  stage: BoardStageId.make(input.stage),
  orderKey: input.orderKey,
  title: `Card ${input.id}`,
  briefRef: null,
  dependsOn: (input.dependsOn ?? []).map((id) => BoardCardId.make(id)),
  parentCardId: input.parentCardId == null ? null : BoardCardId.make(input.parentCardId),
  sourcePlanId: null,
  group: null,
  threadLinks: [],
  attachments: [],
  externalRef: null,
  humanInLoop: input.humanInLoop ?? null,
  reviewOverrides: null,
  modelOverrides: null,
  mergeStrategy: input.mergeStrategy ?? null,
  splitRationale: null,
  baseBranch: null,
  scheduledStartAt: (input.scheduledStartAt ?? null) as BoardCard["scheduledStartAt"],
  // `autoStart` / `autoMerge` are the legacy spellings of an own
  // Auto-build / Auto-merge on.
  autoPlanSetting: input.autoPlanSetting ?? null,
  autoBuildSetting: input.autoBuildSetting ?? (input.autoStart === true ? true : null),
  autoMergeSetting: input.autoMergeSetting ?? (input.autoMerge === true ? true : null),
  autoMergeHold: input.autoMergeHold ?? null,
  pinnedWorkerId: input.pinnedWorkerId ?? null,
  placedWorkerId: input.placedWorkerId ?? null,
  workerMove: input.workerMove ?? null,
  placementOrphaned: input.placementOrphaned ?? null,
  ci: input.ci ?? null,
  ciLastOutcome: input.ciLastOutcome ?? null,
  ciRoundTrips: input.ciRoundTrips ?? 0,
  worktree: input.worktree ?? null,
  pullRequest: input.pullRequest ?? null,
  pullRequestHistory: input.pullRequestHistory ?? [],
  pullRequestFloor: (input.pullRequestFloor ?? null) as BoardCard["pullRequestFloor"],
  blocked: false,
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
});

/** A card sitting in Building with a ready worktree and no step yet — the state
    right after "Begin build" provisioned the worktree; the reactor selects and
    admits the step. */
export const buildingCard = (
  id: string,
  orderKey: string,
  humanInLoop: boolean | null = null,
): BoardCard =>
  makeBoardCard({ id, stage: "building", orderKey, worktree: readyWorktree(id), humanInLoop });

/** The two projects the harness server knows. */
const harnessProjects: ReadonlyArray<BoardProject> = [
  {
    id: projectId,
    title: "Project 1",
    workspaceRoot: "/tmp/project-1",
    deleted: false,
    scripts: [],
  },
  {
    id: otherProjectId,
    title: "Project 2",
    workspaceRoot: "/tmp/project-2",
    deleted: false,
    scripts: [],
  },
];

export const readModel = (board: BoardState): BoardReadModel => ({ board });

const THREAD_SIGNAL_TYPES: ReadonlySet<string> = new Set<ThreadSignal["type"]>([
  "turn-ended",
  "turn-start-failed",
  "turn-requested",
  "limit-resumed",
  "interrupt-requested",
  "approval-responded",
  "input-requested",
  "input-resolved",
  "session-started",
  "todos-changed",
  "thread-deleted",
]);

/**
 * A Building stage that auto-executes `step` unattended in build mode and auto-advances on
 * success. Human-in-the-loop is off, so a plan-less card runs unattended.
 */
const buildingStageExecution = (
  step: TestBuildStep,
  input: {
    readonly submit?: Partial<BoardStepExecution>;
    readonly buildAutoAdvance?: boolean;
  },
): BoardStageExecution => ({
  ...DEFAULT_BOARD_BUILD_STAGE_EXECUTION,
  prompt: step.prompt,
  model: { instanceId: step.providerInstanceId, model: DEFAULT_TEXT_GENERATION_MODEL },
  humanInLoopWithoutPlan: false,
  autoAdvance: input.buildAutoAdvance ?? true,
  submit: { ...DEFAULT_BOARD_BUILD_STAGE_EXECUTION.submit, ...input.submit },
});

/** The Planning stage configured to auto-execute: `plan` mode, so its
    run holds no concurrency slot and needs no worktree — the shape a card
    dropped into an auto-executing Planning column runs under. */
const planningStageExecution = (
  step: TestBuildStep,
  /** The planning interview's real stance: asking IS the job there, so
      the suites that drive a stopped planning agent need it on. */
  humanInLoop = false,
  autoAdvance = false,
): BoardStageExecution => ({
  kind: "simple",
  autoExecute: true,
  prompt: step.prompt,
  model: { instanceId: step.providerInstanceId, model: DEFAULT_TEXT_GENERATION_MODEL },
  mode: "plan",
  humanInLoop,
  humanInLoopWithPlan: false,
  humanInLoopWithoutPlan: false,
  autoAdvance,
  timeoutMs: DEFAULT_BOARD_STEP_TIMEOUT_MS,
  maxAttempts: DEFAULT_BOARD_STEP_MAX_ATTEMPTS,
  maxInvocationsPerStageEntry: DEFAULT_BOARD_MAX_INVOCATIONS_PER_STAGE_ENTRY,
});

/** `building` is the single build step the Building stage runs (a one-element
    array in every caller, mirroring the retired single-step recipe). It is
    folded into the Building stage's execution config keyed by the Building stage
    id, so the reactor resolves and freezes it exactly as in production. */
export const settingsWith = (input: {
  readonly building: ReadonlyArray<TestBuildStep>;
  readonly globalMaxConcurrent: number;
  readonly perInstance?: Record<string, number | null>;
  /** Per-worker limits. Absent is none: `local` inherits the two
      fields above, as a settings file written before workers does. */
  readonly workers?: BoardConcurrencySettings["workers"];
  /** Pass a step to make Planning auto-execute too — the plan-mode counterpart
      of `building`, for the suites that drive a card into Planning. */
  readonly planning?: TestBuildStep;
  /** Run the Planning step human-in-the-loop, as the real planning interview
      does. */
  readonly planningHumanInLoop?: boolean;
  /** Whether Planning auto-advances on a successful run. Defaults to off, what
      the stage ships with. */
  readonly planningAutoAdvance?: boolean;
  /** Overrides for the merge stage's config (strategy, branch cleanup, the
      conflict prompt). Absent leaves it at the compiled-in defaults, which is
      what a board nobody has configured actually resolves to. */
  readonly merge?: Partial<BoardStageExecutionMerge>;
  /** Overrides for the Code review stage's config (`draftPullRequests`).
      Absent leaves it at the compiled-in defaults. */
  readonly review?: Partial<BoardStageExecutionReview>;
  /** Whether a card reaching Done with a merged pull request has its worktree
      reclaimed there rather than at archive. Defaults to the shipped default
      (on), so a suite that says nothing exercises what users actually run. */
  readonly reclaimWorktreeOnDone?: boolean;
  /** Overrides for the Build stage's `submit` step: the prompt, model
      and limits behind "Submit for merge — no review". Absent leaves the
      compiled-in defaults. */
  readonly submit?: Partial<BoardStepExecution>;
  /** Whether the Build stage auto-advances on an ordinary successful run.
      Defaults to on (what the stage ships with); a suite proving the DIRECTED
      advance ignores it switches it off. */
  readonly buildAutoAdvance?: boolean;
  /** Auto-archive of idle Done cards. Absent is the shipped default:
      off, 7 days. */
  readonly autoArchiveDone?: boolean;
  readonly autoArchiveAfterDays?: number;
}): BoardSettings => ({
  projects: {},
  // The board has no workspace default in the harness: every test stage names
  // its own model, so a fallback firing would be a bug the suite should see.
  defaultModel: null,
  pipeline: {
    [BOARD_SEED_STAGE_IDS.building]: buildingStageExecution(input.building[0]!, input),
    ...(input.planning === undefined
      ? {}
      : {
          [BOARD_SEED_STAGE_IDS.planning]: planningStageExecution(
            input.planning,
            input.planningHumanInLoop ?? false,
            input.planningAutoAdvance ?? false,
          ),
        }),
    ...(input.merge === undefined
      ? {}
      : {
          [BOARD_SEED_STAGE_IDS.merge]: {
            ...DEFAULT_BOARD_MERGE_STAGE_EXECUTION,
            ...input.merge,
          },
        }),
    ...(input.review === undefined
      ? {}
      : {
          [BOARD_SEED_STAGE_IDS.review]: {
            ...DEFAULT_BOARD_REVIEW_STAGE_EXECUTION,
            ...input.review,
          },
        }),
  },
  concurrency: {
    perInstance: input.perInstance ?? {},
    globalMaxConcurrent: input.globalMaxConcurrent,
    workers: input.workers ?? {},
  },
  lifecycle: {
    reclaimWorktreeOnDone: input.reclaimWorktreeOnDone ?? true,
    autoArchiveDone: input.autoArchiveDone ?? DEFAULT_BOARD_AUTO_ARCHIVE_DONE,
    autoArchiveAfterDays: input.autoArchiveAfterDays ?? DEFAULT_BOARD_AUTO_ARCHIVE_AFTER_DAYS,
  },
  display: { autoCollapseEmptyStages: DEFAULT_BOARD_AUTO_COLLAPSE_EMPTY_STAGES },
});

export type Harness = {
  readonly slots: BoardStepSlots["Service"];
  readonly reactor: SupervisorReactor["Service"];
  readonly model: Ref.Ref<BoardReadModel>;
  /** What the thread gateway answers for each thread. A spawned thread has no
      entry until a test gives it one, so "is it alive" is always explicit. */
  readonly shells: Ref.Ref<ReadonlyMap<string, BoardThreadState>>;
  /** Deliver a board event or a thread signal to the reactor. */
  readonly pumpDomain: (event: HarnessEvent) => Effect.Effect<void>;
  /** The same as `pumpDomain`; named for the turn-and-question signals. */
  readonly pumpRuntime: (event: HarnessEvent) => Effect.Effect<void>;
  readonly board: Effect.Effect<BoardState>;
  /** Every command the reactor dispatched, in order — including the non-board
      ones the engine double otherwise treats as no-ops, so a test can assert
      HOW a thread was spawned, not just that a step went running. */
  readonly commands: Effect.Effect<ReadonlyArray<HarnessCommand>>;
  /**
   * Every board event the double DECIDED, in order. Unlike `commands` it excludes rejected
   * commands, so outcomes the card state does not carry (a pure report) are read here.
   */
  readonly decided: Effect.Effect<ReadonlyArray<HarnessEvent>>;
  /** Every merge the reactor asked the forge for, in order. */
  readonly mergeAttempts: Effect.Effect<ReadonlyArray<{ readonly number: number }>>;
  /** The merge method of each attempt, in the same order. */
  readonly mergeMethods: Effect.Effect<ReadonlyArray<string>>;
  /** Every structured refusal probe the reactor made. */
  readonly mergeStateProbes: Effect.Effect<ReadonlyArray<{ readonly number: number }>>;
  /** Every mark-ready request the reactor made, in order. */
  readonly markReadyCalls: Effect.Effect<ReadonlyArray<{ readonly number: number }>>;
  /** Every pull request the reactor asked the forge to close, in order. */
  readonly closePullRequestCalls: Effect.Effect<ReadonlyArray<{ readonly number: number }>>;
  /** T3o: every pull request lookup, with whether it was FORCED — so a
      test can tell a human's "Check again" from the automatic cached refresh. */
  readonly pullRequestLookups: Effect.Effect<ReadonlyArray<{ readonly forced: boolean }>>;
  /** Every number lookup (`get`), with the number asked for. */
  readonly pullRequestGets: Effect.Effect<
    ReadonlyArray<{ readonly number: number; readonly forced: boolean }>
  >;
  /** Every worktree path the reactor removed, in order. */
  readonly removedWorktrees: Effect.Effect<ReadonlyArray<string>>;
  /** Every thread that actually SETTLED, as opposed to every settle the reactor
      asked for. The two differ exactly when the decider's guard refuses
      — a thread mid-turn — which is the failure the release sweep exists for, so
      an assertion about settling has to read this rather than `commands`. */
  readonly settledThreads: Effect.Effect<ReadonlySet<string>>;
  /** Move a branch tip in the stubbed driver: what
      `rev-parse refs/heads/<ref>` answers from now on. Every unset ref answers
      the stub's historic "main", so existing fixtures never read stale. */
  readonly setBaseTip: (ref: string, tip: string) => void;
  /** End the `unbornBranch` fixture: the human made a first commit, so the
      repository now answers like any other. */
  readonly makeFirstCommit: () => void;
  /** Replace the board settings the reactor reads from now on — what flipping
      a switch in the Settings pane does. */
  readonly setBoardSettings: (settings: BoardSettings) => void;
  /** Flip what the durability probe finds from now on — a kept
      worktree whose work later reaches the remote. */
  readonly setWorktreeUndurable: (undurable: boolean) => void;
  /** Every `git` argv the reactor ran, in order. A test asserting that a
      remote-only base was MATERIALISED has nowhere else to read it:
      `git branch develop origin/develop` leaves no trace on the card. */
  readonly gitInvocations: Effect.Effect<ReadonlyArray<ReadonlyArray<string>>>;
};

/** Run `body` against a live reactor wired to the stateful engine double. */
export function withGovernor(
  input: {
    readonly board: BoardState;
    readonly settings: BoardSettings;
    /** Thread shells present BEFORE the reactor starts, so boot reconcile sees
        the threads a seeded step-state fixture references as alive. */
    readonly initialShells?: ReadonlyMap<string, BoardThreadState>;
    /**
     * What an UNSCOPED `git log -1 --format=%cI` answers: the worktree tip, whoever wrote it.
     * The reactor does not read it; a fixture sets it to reproduce a base-sync heartbeat.
     * Defaults to "" (no commit history).
     */
    readonly latestCommitIso?: string;
    /**
     * What a BRANCH-SCOPED `git log … HEAD --not refs/heads/<base>` answers: the newest commit
     * unique to the card's branch, the commit-liveness signal. Defaults to `latestCommitIso`.
     */
    readonly latestBranchCommitIso?: string;
    /** Local branches the stubbed repository does NOT have: a
        `rev-parse refs/heads/<ref>` for one answers exit 1 with empty stdout,
        which is what the reactor's base materialisation really sees. Every other ref stays present, so existing fixtures are untouched. */
    readonly missingBranches?: ReadonlyArray<string>;
    /** Branches that exist only as `refs/remotes/origin/<ref>`. Combined with
        `missingBranches` this is the remote-only base the reactor has to
        materialise locally before it can cut from it. */
    readonly remoteOnlyBranches?: ReadonlyArray<string>;
    /** Make every git call answer as it does outside a repository: empty
        stdout, exit 128. The driver runs with `allowNonZeroExit`, so this is
        what the reactor's base-branch probes really see when a project's
        workspace root is not a git checkout. */
    readonly notAGitRepo?: boolean;
    /** A repository with no commits yet: HEAD is a symbolic ref to
        this branch, which does not exist, so `symbolic-ref HEAD` answers it and
        every other probe fails as git really does. `makeFirstCommit` ends it. */
    readonly unbornBranch?: string;
    /**
     * Make git fail on a healthy repository: `worktree-add` fails `createWorktree`,
     * `branch-create` fails `git branch <name> <start>` (transient, retried on the next pass),
     * `remote-delete` fails `git push <remote> --delete` as an auth or network error does.
     */
    readonly gitFailure?: "worktree-add" | "branch-create" | "remote-delete";
    /** The app's text-generation fallback and its API-only text generators, when a test needs
        them to differ from the defaults. */
    readonly appSettings?: Partial<
      Pick<ServerSettings, "textGenerationModelSelection" | "textGenerators">
    >;
    /** Reject every `thread.create`, so a test can drive the spawn-failure path
        (a thread the engine refuses to create) without a provider double. */
    readonly rejectThreadCreate?: boolean;
    /** The card detail's CI pass rows can't be read. */
    readonly ciPassesUnreadable?: boolean;
    /** What a branch pull-request lookup answers. `undefined` (the default) is
        "no pull request"; a `detail` string makes the lookup FAIL, which is a
        different answer the reactor must not confuse with "there is none". */
    readonly pullRequest?: BoardFoundPullRequest | { readonly failWith: string } | null;
    /** T3o: the same answer, read afresh on every lookup, for a test
        whose point is that the answer CHANGED between two of them — a pull
        request opened after the board was last told there was none. Takes
        precedence over `pullRequest` when both are given. */
    readonly pullRequestOf?: () =>
      | BoardFoundPullRequest
      | { readonly failWith: string }
      | null
      | undefined;
    /** What a number lookup answers. `undefined` reuses `pullRequest` /
        `pullRequestOf` so fixtures that only care about the forge's one
        answer stay as they are. `null` is "this number is gone". */
    readonly pullRequestByNumber?: BoardFoundPullRequest | { readonly failWith: string } | null;
    /** The repository every project's shell reports — what a linked
        pull request is checked against. Defaults to `github.com/acme/repo`,
        the repository the pull-request fixtures live on; `null` is a project
        with no recognised remote. */
    readonly projectRepository?: RepositoryIdentity | null;
    /** The project's `remote.origin.url`. Absent is a checkout
        whose identity already is its origin; a fork sets this to its own
        repository while `projectRepository` names upstream. */
    readonly projectOriginUrl?: string;
    /**
     * Run before every branch pull-request lookup answers: the refresh path's one forge round
     * trip, so a test can hold it here and mutate `model` to drive that interleaving.
     */
    readonly onPullRequestLookup?: Effect.Effect<void>;
    /**
     * Run at the start of every engine dispatch. Two overlapping refreshes can both pass the
     * re-read, so a test that needs their commands in a set order holds the earlier one here.
     */
    readonly onDispatch?: (command: HarnessCommand) => Effect.Effect<void>;
    /** What a merge attempt answers: `undefined` succeeds, a string is the
        forge's refusal detail (a conflict when it reads like one). */
    readonly mergeFailure?: string;
    /**
     * Per-attempt merge outcomes, consumed in order: `null` succeeds, a string refuses with that
     * detail. Once the script runs out, `mergeFailure` governs.
     */
    readonly mergeOutcomes?: ReadonlyArray<string | null>;
    /** Which KIND of refusal `mergeFailure` / `mergeOutcomes` describe.
        `undefined` is the host's own "no" — the case every fixture
        written before this option existed means — and is the only one the
        reactor answers with a merge-state probe. */
    readonly mergeRefusal?: BoardPullRequestRefusal;
    /** What the structured refusal probe answers. `undefined`
        makes the probe FAIL, which is what an unsupported provider does and
        what the reactor must read as "unclassifiable" — the plain ladder. */
    readonly mergeState?: BoardMergeState;
    /** T3o: the same answer, read afresh on every probe, for a test
        whose checks CHANGE between two probes — a failed check a CI fix's
        push turned into a pending one. Takes precedence over `mergeState`. */
    readonly mergeStateOf?: () => BoardMergeState;
    /**
     * What a mark-ready request answers, per call and in order; the last entry repeats once the
     * script runs out. A string is a failure with that detail. Absent answers `not-draft`.
     */
    readonly markReadyOutcomes?: ReadonlyArray<
      "readied" | "not-draft" | { readonly failWith: string }
    >;
    /**
     * What git finds when asked whether the card's branch conflicts with its base, asked only
     * when the probe above failed. `unresolvable` is `merge-tree` exiting 1 without merging (an
     * unresolvable ref); `unfetched` is a failed fetch. Absent is a clean merge.
     */
    readonly localMergeConflict?: "conflict" | "unresolvable" | "unfetched";
    /** Make the stubbed `statusDetails` report uncommitted changes, so a test
        can drive the reclaim refusal — the case where the checkout holds work
        that exists nowhere else and must NOT be deleted to save disk. */
    readonly worktreeDirty?: boolean;
    /** Make the durability probe find the worktree's commits nowhere else:
        no remote ref contains HEAD and two commits are unmerged.
        Durable by default, since that is what a merged card looks like. */
    readonly worktreeUndurable?: boolean;
    /** What `git worktree list --porcelain` answers for the orphan sweep.
        Empty by default: no registered worktrees. */
    readonly registeredWorktrees?: string;
    /** Runs inside the durability probe, at its dirty check: the
        window in which the board can change under a reclaim already decided
        on. Gets the read model to change it. */
    readonly duringDurabilityProbe?: (model: Ref.Ref<BoardReadModel>) => Effect.Effect<void>;
    /** The cached todo state per thread id: the reactor reads
        `advancedAt` for the stall-reset / timeout-liveness signal. Absent
        threads answer "no list". */
    readonly threadTodos?: ReadonlyMap<string, { readonly advancedAt: string | null }>;
    /**
     * The last assistant message per thread id, read to decide whether a stopped turn ended with
     * a question. Absent threads answer "no message". Dated after the step started by default;
     * `staleThreadMessages` dates them before.
     */
    readonly threadMessages?: ReadonlyMap<string, string>;
    /** Thread ids whose message should be dated BEFORE the step started, i.e.
        text the agent wrote in an earlier turn and has not added to since. */
    readonly staleThreadMessages?: ReadonlySet<string>;
    /** When each thread last produced OUTPUT: the timeout sweep's
        liveness life sign. An absent thread answers null — "no life sign" —
        which is what every fixture written before this signal existed reads as,
        so none of them change behaviour. */
    readonly threadSignals?: ReadonlyMap<string, string>;
    /** When a turn was REQUESTED on each thread and has not started yet:
        the message a human sent while the previous turn was still
        finishing. An absent thread answers null — "nothing outstanding" — which
        is what every fixture written before this signal existed reads as. */
    readonly threadPendingTurnStarts?: ReadonlyMap<string, string>;
    /** A `ServerConfig` layer: with one, a build/plan spawn stages
        the card's brief images from `<stateDir>/board/attachments`; without
        one the reactor stages nothing, as the other tests expect. */
    readonly serverConfig?: Layer.Layer<ServerConfig.ServerConfig>;
    /** The worktree retirer, over the stubbed git driver. By default
        the real one with nothing running and no remove scripts, so it only
        removes — what every fixture written before it expects. */
    readonly worktreeRetirer?: Layer.Layer<WorktreeRetirer, never, GitVcsDriver.GitVcsDriver>;
    /** The board's gateway over the harness's own threads: a router
        that also reaches a worker. Absent: the threads are the fake alone. */
    readonly gateway?: (local: LocalThreadGatewayShape) => ThreadGatewayShape;
    /** Where the supervisor spawns each card's threads. */
    readonly placement?: BoardPlacementShape;
    /** Where cards' git runs, built from this harness's own local
        workspace services. By default every card is local. */
    readonly workspaces?: (local: LocalBoardWorkspaceDeps) => BoardWorkspacesShape;
  },
  body: (h: Harness) => Effect.Effect<void>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const model = yield* Ref.make<BoardReadModel>(readModel(input.board));
    const seq = yield* Ref.make(0);
    const domainQueue = yield* Queue.unbounded<BoardEvent>();

    // Apply a decided (planned) event to the model exactly as the board
    // engine's projector would, so the next read reflects prior dispatches.
    const decided = yield* Ref.make<ReadonlyArray<BoardEvent>>([]);
    const applyDecided = (planned: PlannedBoardEvent) =>
      Effect.gen(function* () {
        const sequence = yield* Ref.updateAndGet(seq, (n) => n + 1);
        const event = { ...planned, sequence } as BoardEvent;
        yield* Ref.update(decided, (current) => [...current, event]);
        const next = yield* projectBoardEvent(yield* Ref.get(model), event);
        yield* Ref.set(model, next);
        if (event.type === "board.card-ci-recorded") projectCiPassRows(event.payload);
      });

    // The CI pass rows, as the SQL projection keeps them (`projection.ts`).
    const ciPassRows = new Map<string, BoardCiPass>();
    const projectCiPassRows = (
      payload: Extract<BoardEvent, { type: "board.card-ci-recorded" }>["payload"],
    ) => {
      for (const settle of payload.settled) {
        const row = ciPassRows.get(settle.runId);
        if (row === undefined) continue;
        ciPassRows.set(settle.runId, {
          ...row,
          outcome: row.outcome ?? settle.outcome ?? null,
          finishedAt: row.finishedAt ?? settle.finishedAt ?? null,
          fixThreadId: settle.fixThreadId ?? row.fixThreadId,
        });
      }
      if (payload.started !== null) ciPassRows.set(payload.started.runId, payload.started);
      const action = payload.action;
      if (action.kind === "step") {
        const row = ciPassRows.get(action.runId);
        if (row !== undefined) {
          ciPassRows.set(action.runId, {
            ...row,
            steps: row.steps.map((step, index) => (index === action.index ? action.step : step)),
          });
        }
      }
    };

    // Board commands and thread-gateway calls, in the one order they were sent.
    const commands = yield* Ref.make<ReadonlyArray<HarnessCommand>>([]);
    const recordCommand = (command: HarnessCommand) =>
      (input.onDispatch?.(command) ?? Effect.void).pipe(
        Effect.andThen(Ref.update(commands, (current) => [...current, command])),
      );

    const threadTodos = input.threadTodos ?? new Map();
    const threadMessages = input.threadMessages ?? new Map<string, string>();
    const staleThreadMessages = input.staleThreadMessages ?? new Set<string>();
    const threadSignals = input.threadSignals ?? new Map<string, string>();
    const threadPendingTurnStarts = input.threadPendingTurnStarts ?? new Map<string, string>();
    const projectRepositoryIdentity: RepositoryIdentity | null =
      input.projectRepository === undefined
        ? {
            canonicalKey: "github.com/acme/repo",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "git@github.com:acme/repo.git",
            },
            provider: SourceControlProviderKind.make("github"),
            owner: "acme",
            name: "repo",
          }
        : input.projectRepository;

    // `initialShells` is the set of threads that exist before the reactor starts, a spawn adds
    // one, and a turn cannot be sent to a thread that was never created.
    const fake = yield* makeFakeThreadGateway({
      projects: harnessProjects.map((project) => ({
        ...project,
        repositoryIdentity: projectRepositoryIdentity,
      })),
      ...(input.initialShells === undefined ? {} : { threads: input.initialShells }),
      ...(input.rejectThreadCreate === true ? { rejectSpawn: true } : {}),
      onCall: recordCommand,
      latestAssistantMessage: (threadId) => {
        const text = threadMessages.get(String(threadId));
        // Dated at one end of time or the other, so a fixture is unambiguously
        // "written since the work resumed" or unambiguously not. The stale date
        // is PRE-epoch on purpose: the harness clock starts at the epoch, so a
        // step's `startedAt` is 1970 and anything later would read as fresh.
        const createdAt = staleThreadMessages.has(String(threadId))
          ? "1969-01-01T00:00:00.000Z"
          : "2999-01-01T00:00:00.000Z";
        return text === undefined ? null : { text, createdAt };
      },
      lastSignalAt: (threadId) => threadSignals.get(String(threadId)) ?? null,
      pendingTurnStartAt: (threadId) => threadPendingTurnStarts.get(String(threadId)) ?? null,
    });
    const shells = fake.states;
    const gateway = input.gateway?.(fake.gateway) ?? fake.gateway;

    const boardQueriesStub = {
      // The reactor's todo signal + boot sweep have something to call;
      // `boardThreadTodo` is fixture-driven, the rest are inert.
      boardCardDetail: (cardId: BoardCardId) =>
        Effect.succeed(
          input.ciPassesUnreadable === true
            ? null
            : {
                ciPasses: [...ciPassRows.values()].filter((pass) => pass.cardId === cardId),
              },
        ),
      boardCardActivity: () => Effect.succeed([]),
      boardCardBrief: () => Effect.succeed(null),
      boardPlanBody: () => Effect.succeed(null),
      boardCardThreads: () => Effect.succeed([]),
      boardAllCardThreads: () => Effect.succeed([]),
      boardCardIdForThread: () => Effect.succeed(null),
      boardThreadWorker: () => Effect.succeed(null),
      boardThreadTodo: (threadId: ThreadId) => {
        const todo = threadTodos.get(String(threadId));
        return Effect.succeed(
          todo === undefined
            ? null
            : {
                doneCount: 0,
                totalCount: 1,
                advancedAt: todo.advancedAt,
              },
        );
      },
      boardSweepThreadTodos: () => Effect.void,
      loadBoardState: () => Ref.get(model).pipe(Effect.map((current) => current.board ?? null)),
    } as unknown as BoardQueries["Service"];

    // Board commands are decided against the context the real engine loads —
    // projects and threads from the gateway — and folded into the model.
    const dispatchBoard = (command: BoardCommand) =>
      recordCommand(command).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const context = yield* loadDecisionContext(command, boardQueriesStub, gateway);
            const outcome = yield* decideBoardCommand({
              command,
              readModel: yield* Ref.get(model),
              context,
            });
            yield* Effect.forEach(boardDecidedEvents(outcome), applyDecided, { discard: true });
          }),
        ),
        Effect.andThen(Ref.get(seq).pipe(Effect.map((sequence) => ({ sequence })))),
      );

    const boardEngineStub = {
      dispatch: dispatchBoard,
      getReadModel: Ref.get(model),
      latestSequence: Ref.get(seq),
      // Every pumped board event arrives here.
      liveBoardEvents: Stream.fromQueue(domainQueue),
      subscribeBoardEvents: Effect.succeed(Stream.never),
      streamBoardEvents: () => Stream.never,
    } as unknown as BoardEngine["Service"];

    // Shaped like the real settings: the reactor falls back to `textGenerationModelSelection`
    // for a stage that names no model. Mutable so a test can change a board setting mid-run;
    // the reactor re-reads `getSettings` on every pass.
    let boardSettings = input.settings;
    const settingsStub = {
      getSettings: Effect.sync(() => ({
        board: boardSettings,
        textGenerationModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
        textGenerators: DEFAULT_SERVER_SETTINGS.textGenerators,
        ...input.appSettings,
      })),
    } as unknown as ServerSettingsService["Service"];

    // Every worktree the reactor removed, so a test can assert that a card
    // reaching Done gave its checkout back — and, just as importantly, that a
    // card whose tree is dirty did not.
    const removedWorktrees = yield* Ref.make<ReadonlyArray<string>>([]);
    let worktreeUndurable = input.worktreeUndurable === true;
    // Movable branch tips for the rev-parse stub — a plain map, so a
    // test can slide a base tip between pumps without an Effect.
    const baseTips = new Map<string, string>();
    let unbornBranch = input.unbornBranch;
    // Every git argv the reactor ran, and the branches it created through this
    // stub — the two things a base-materialisation assertion needs and the card
    // does not record.
    const gitInvocationLog: Array<ReadonlyArray<string>> = [];
    const createdBranches = new Set<string>();
    const gitStub = {
      // Branch cleanup's first call. Its absence used to make
      // `deleteCardBranch` throw straight into the reactor's catch-all,
      // so the cleanup at Done silently did nothing in every test that reached
      // it — which is why nothing in these suites asserted that it fires.
      resolvePrimaryRemoteName: () => Effect.succeed("origin"),
      // The orphan sweep's base for a worktree no card names.
      resolveDefaultBranchName: () => Effect.succeed("main"),
      statusDetails: () =>
        Effect.succeed({
          hasWorkingTreeChanges: input.worktreeDirty === true,
          hasUpstream: true,
          aheadCount: 0,
        }),
      removeWorktree: (request: { readonly path: string }) =>
        Ref.update(removedWorktrees, (paths) => [...paths, request.path]),
      // Reached only by a card whose worktree is not `ready` (a split parent's `branch-only`
      // integration branch). No branch exists locally, so `createWorktree` cuts a fresh one.
      listLocalBranchNames: () => Effect.succeed([] as string[]),
      createWorktree: (request: { readonly branch?: string; readonly refName?: string }) =>
        input.gitFailure === "worktree-add"
          ? Effect.die(new Error("fatal: could not create work tree dir"))
          : Effect.succeed({
              worktree: {
                path: `/tmp/worktrees/${request.branch ?? request.refName ?? "wt"}`,
                refName: request.branch ?? request.refName ?? "board/wt",
              },
            }),
      execute: (request: { readonly args?: ReadonlyArray<string> }) => {
        gitInvocationLog.push(request.args ?? []);
        if (input.notAGitRepo === true) {
          return Effect.succeed({
            stdout: "",
            stderr: "fatal: not a git repository (or any of the parent directories): .git",
            exitCode: 128,
          });
        }
        if (unbornBranch !== undefined) {
          const args = request.args ?? [];
          return Effect.succeed(
            args[0] === "symbolic-ref" && args.at(-1) === "HEAD"
              ? { stdout: unbornBranch, stderr: "", exitCode: 0 }
              : { stdout: "", stderr: "fatal: no commits yet", exitCode: 128 },
          );
        }
        // A `rev-parse refs/heads/<ref>` answers the movable tip fixture:
        // `setBaseTip` moves it mid-test, and an unset ref answers
        // the stub's historic "main" so nothing existing reads differently.
        const ref = request.args?.find((arg) => arg.startsWith("refs/heads/"));
        if (request.args?.[0] === "rev-parse" && ref !== undefined) {
          const name = ref.slice("refs/heads/".length);
          // A branch the fixture says is absent answers as git really does:
          // exit 1, nothing on stdout. `createdBranches` is what a
          // `git branch <name> <start>` in this same stub added, so
          // materialising a remote-only base actually makes it present.
          if (input.missingBranches?.includes(name) === true && !createdBranches.has(name)) {
            return Effect.succeed({ stdout: "", stderr: "", exitCode: 1 });
          }
          return Effect.succeed({
            stdout: baseTips.get(name) ?? "main",
            stderr: "",
            exitCode: 0,
          });
        }
        const remoteRef = request.args?.find((arg) => arg.startsWith("refs/remotes/"));
        if (request.args?.[0] === "rev-parse" && remoteRef !== undefined) {
          const name = remoteRef.slice("refs/remotes/origin/".length);
          return input.remoteOnlyBranches?.includes(name) === true
            ? Effect.succeed({ stdout: "remote-tip", stderr: "", exitCode: 0 })
            : Effect.succeed({ stdout: "", stderr: "", exitCode: 1 });
        }
        // The reclaim durability probe. `status --porcelain` is
        // the dirty check; the ancestry, remote-containment and unmerged-count
        // reads answer "durable" unless the fixture says otherwise.
        if (request.args?.[0] === "status" && request.args[1] === "--porcelain") {
          return (input.duringDurabilityProbe?.(model) ?? Effect.void).pipe(
            Effect.as({
              stdout: input.worktreeDirty === true ? " M README.md\n" : "",
              stderr: "",
              exitCode: 0,
            }),
          );
        }
        if (request.args?.[0] === "merge-base" && request.args[1] === "--is-ancestor") {
          return Effect.succeed({
            stdout: "",
            stderr: "",
            exitCode: worktreeUndurable ? 1 : 0,
          });
        }
        if (request.args?.[0] === "for-each-ref" && request.args[1] === "--contains") {
          return Effect.succeed({
            stdout: worktreeUndurable ? "" : "refs/remotes/origin/main\n",
            stderr: "",
            exitCode: 0,
          });
        }
        if (request.args?.[0] === "merge-tree") {
          const tree = "a".repeat(40);
          return Effect.succeed(
            input.localMergeConflict === "conflict"
              ? { stdout: `${tree}\nREADME.md\n`, stderr: "", exitCode: 1 }
              : input.localMergeConflict === "unresolvable"
                ? { stdout: "", stderr: "not something we can merge", exitCode: 1 }
                : { stdout: `${tree}\n`, stderr: "", exitCode: 0 },
          );
        }
        if (request.args?.[0] === "fetch" && input.localMergeConflict === "unfetched") {
          return Effect.succeed({ stdout: "", stderr: "", exitCode: 128 });
        }
        if (request.args?.[0] === "rev-list" && request.args[1] === "--count") {
          return Effect.succeed({ stdout: "2\n", stderr: "", exitCode: 0 });
        }
        if (
          input.gitFailure === "remote-delete" &&
          request.args?.[0] === "push" &&
          request.args.includes("--delete")
        ) {
          return Effect.succeed({
            stdout: "",
            stderr: "fatal: Authentication failed",
            exitCode: 128,
          });
        }
        if (request.args?.[0] === "worktree" && request.args[1] === "list") {
          return Effect.succeed({
            stdout: input.registeredWorktrees ?? "",
            stderr: "",
            exitCode: 0,
          });
        }
        const createdBranch =
          request.args?.[0] === "branch"
            ? request.args.slice(1).find((arg) => !arg.startsWith("-"))
            : undefined;
        if (createdBranch !== undefined) {
          if (input.gitFailure === "branch-create") {
            return Effect.succeed({ stdout: "", stderr: "fatal: cannot lock ref", exitCode: 128 });
          }
          createdBranches.add(createdBranch);
          return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
        }
        // `git log -1 --format=%cI` answers the configured commit time. A `--not` makes it the
        // branch-scoped read, which differs from the worktree tip after a base sync. Every other
        // call answers "main".
        if (request.args?.[0] === "log") {
          const branchScoped = request.args.includes("--not");
          return Effect.succeed({
            stdout: branchScoped
              ? (input.latestBranchCommitIso ?? input.latestCommitIso ?? "")
              : (input.latestCommitIso ?? ""),
            stderr: "",
            exitCode: 0,
          });
        }
        return Effect.succeed({ stdout: "main", stderr: "", exitCode: 0 });
      },
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];

    const setupStub = {
      runForThread: () => Effect.void,
    } as unknown as BoardSetupScriptRunner["Service"];

    // Every merge attempt the reactor makes, so a test can assert that a
    // refusal did NOT silently retry and that a conflict fix did.
    const mergeAttempts = yield* Ref.make<ReadonlyArray<{ readonly number: number }>>([]);
    const mergeMethods = yield* Ref.make<ReadonlyArray<string>>([]);
    // Every refusal probe, so a test can assert the happy path costs ONE forge
    // call and that a hard hold is never re-probed.
    const mergeStateProbes = yield* Ref.make<ReadonlyArray<{ readonly number: number }>>([]);
    // T3o: see `pullRequestLookups`.
    const pullRequestLookups = yield* Ref.make<ReadonlyArray<{ readonly forced: boolean }>>([]);
    const pullRequestGets = yield* Ref.make<
      ReadonlyArray<{ readonly number: number; readonly forced: boolean }>
    >([]);
    const markReadyCalls = yield* Ref.make<ReadonlyArray<{ readonly number: number }>>([]);
    const closePullRequestCalls = yield* Ref.make<ReadonlyArray<{ readonly number: number }>>([]);
    const pullRequestStub = BoardPullRequestGateway.of({
      close: (request) =>
        Ref.update(closePullRequestCalls, (calls) => [...calls, { number: request.number }]).pipe(
          Effect.as("closed" as const),
        ),
      repository: () =>
        Effect.succeed(
          boardRepositoryOf(projectRepositoryIdentity, input.projectOriginUrl ?? null),
        ),
      markReady: (request) =>
        Ref.updateAndGet(markReadyCalls, (calls) => [...calls, { number: request.number }]).pipe(
          Effect.flatMap((calls) => {
            const script = input.markReadyOutcomes ?? [];
            const scripted = script[Math.min(calls.length, script.length) - 1] ?? "not-draft";
            return typeof scripted === "string"
              ? Effect.succeed(scripted)
              : Effect.fail(
                  new BoardPullRequestGatewayError({
                    operation: "markReady",
                    detail: scripted.failWith,
                    refusal: "unavailable",
                  }),
                );
          }),
        ),
      find: (request) =>
        Ref.update(pullRequestLookups, (lookups) => [
          ...lookups,
          { forced: request.force === true },
        ]).pipe(
          Effect.andThen(input.onPullRequestLookup ?? Effect.void),
          Effect.andThen(() => {
            const configured = input.pullRequestOf?.() ?? input.pullRequest;
            if (configured !== undefined && configured !== null && "failWith" in configured) {
              return Effect.fail(
                new BoardPullRequestGatewayError({
                  operation: "find",
                  detail: configured.failWith,
                }),
              );
            }
            return Effect.succeed(configured ?? null);
          }),
        ),
      get: (request) =>
        Ref.update(pullRequestGets, (gets) => [
          ...gets,
          { number: request.number, forced: request.force === true },
        ]).pipe(
          Effect.andThen(() => {
            const configured =
              input.pullRequestByNumber !== undefined
                ? input.pullRequestByNumber
                : (input.pullRequestOf?.() ?? input.pullRequest);
            // The forge answers an unknown number with an error, never null.
            if (configured === undefined || configured === null || "failWith" in configured) {
              return Effect.fail(
                new BoardPullRequestGatewayError({
                  operation: "get",
                  detail:
                    configured != null ? configured.failWith : "No pull request with that number.",
                }),
              );
            }
            return Effect.succeed(configured);
          }),
        ),
      merge: (request) =>
        Ref.update(mergeMethods, (methods) => [...methods, request.method]).pipe(
          Effect.andThen(
            Ref.updateAndGet(mergeAttempts, (attempts) => [
              ...attempts,
              { number: request.number },
            ]),
          ),
          Effect.andThen((attempts) => {
            const scripted = input.mergeOutcomes?.[attempts.length - 1];
            const detail = scripted === undefined ? input.mergeFailure : (scripted ?? undefined);
            return detail === undefined
              ? Effect.void
              : Effect.fail(
                  new BoardPullRequestGatewayError({
                    operation: "merge",
                    detail,
                    refusal: input.mergeRefusal ?? "host",
                  }),
                );
          }),
        ),
      mergeState: (request) =>
        Ref.update(mergeStateProbes, (probes) => [...probes, { number: request.number }]).pipe(
          Effect.andThen(() => {
            const configured = input.mergeStateOf?.() ?? input.mergeState;
            return configured === undefined
              ? Effect.fail(
                  new BoardPullRequestGatewayError({
                    operation: "mergeState",
                    detail: "No provider is registered.",
                  }),
                )
              : Effect.succeed(configured);
          }),
        ),
    });

    const gitLayer = Layer.succeed(GitVcsDriver.GitVcsDriver, gitStub);
    const deps = Layer.mergeAll(
      (input.worktreeRetirer ?? worktreeRetirerTestLayer()).pipe(Layer.provide(gitLayer)),
      Layer.succeed(BoardEngine, boardEngineStub),
      Layer.succeed(BoardQueries, boardQueriesStub),
      Layer.succeed(ThreadGateway, gateway),
      input.placement === undefined ? Layer.empty : Layer.succeed(BoardPlacement, input.placement),
      Layer.succeed(ServerSettingsService, settingsStub),
      gitLayer,
      Layer.succeed(BoardSetupScriptRunner, setupStub),
      Layer.succeed(BoardPullRequestGateway, pullRequestStub),
      BoardStepSlotsLive,
      input.serverConfig ?? Layer.empty,
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const reactor = yield* SupervisorReactor;
        const slots = yield* BoardStepSlots;
        yield* reactor.start();
        // Buffered queue → published events are never lost to a late
        // subscriber; a cooperative yield lets the worker enqueue before we
        // drain, and `drain` (a transactional wait on the outstanding count)
        // blocks until processing settles — no sleeps, no polling.
        const pump = <A>(offer: Effect.Effect<A>) =>
          offer.pipe(
            Effect.andThen(Effect.yieldNow),
            Effect.andThen(Effect.yieldNow),
            Effect.andThen(reactor.drain),
          );
        // Production folds the completion into the read model before the reactor sees it, so
        // `driveNextStep` advances rather than re-selecting. Only events from outside the reactor
        // are replayed: re-projecting a card-carrying trigger would clobber the recipe snapshot.
        const projectExternal = (event: BoardEvent) =>
          event.type === "board.card-step-completed" ||
          // Same reason: the override lands on the step row through
          // the projection, and `schedule` reads it from there. Pumping the
          // event without folding it in would test a row that never carried
          // the flag.
          event.type === "board.card-step-force-start-requested" ||
          // A requeue is a client command, so its event arrives from outside the reactor.
          // Recovery emits the same type from inside; the projection is an idempotent upsert, so
          // folding twice is harmless.
          event.type === "board.card-step-recovered" ||
          // A card edit is a client command too, and the schedule handler re-reads the card
          // from the model. The projector upserts the payload's card, so a fixture must build
          // the event from the card it currently holds.
          event.type === "board.card-updated" ||
          // And a pin: a client command whose card the placement
          // pass re-reads from the model.
          event.type === "board.card-worker-pinned" ||
          // And plan review turned on late: a card edit's second
          // event, read back as the step's started review; and its rounds
          // changed mid-review.
          event.type === "board.plan-review-started" ||
          event.type === "board.plan-review-rounds-changed"
            ? Ref.get(model).pipe(
                Effect.flatMap((m) => projectBoardEvent(m, event)),
                Effect.flatMap((next) => Ref.set(model, next)),
                // A projector decode error in a test fixture is a defect, not a
                // handled outcome — keep the pump's signature error-free.
                Effect.orDie,
              )
            : Effect.void;
        const isBoardEvent = (event: HarnessEvent): event is BoardEvent =>
          event.type.startsWith("board.");
        // A fixture still shaped like a thread ENGINE event would reach the
        // reactor as a signal it has no case for and wedge its worker, so the
        // test would hang rather than fail. Refuse it here, by name.
        const deliver = (event: HarnessEvent) =>
          isBoardEvent(event)
            ? projectExternal(event).pipe(Effect.andThen(pump(Queue.offer(domainQueue, event))))
            : THREAD_SIGNAL_TYPES.has(event.type)
              ? pump(fake.emit(event))
              : Effect.die(
                  new Error(`Not a board event or a thread signal: '${String(event.type)}'.`),
                );
        yield* body({
          slots,
          reactor,
          model,
          shells,
          pumpDomain: deliver,
          pumpRuntime: deliver,
          board: Ref.get(model).pipe(
            Effect.map(
              (m) => m.board ?? ({ cards: [], nextCardNumberByProject: {} } satisfies BoardState),
            ),
          ),
          commands: Ref.get(commands),
          decided: Ref.get(decided),
          mergeAttempts: Ref.get(mergeAttempts),
          mergeMethods: Ref.get(mergeMethods),
          mergeStateProbes: Ref.get(mergeStateProbes),
          markReadyCalls: Ref.get(markReadyCalls),
          closePullRequestCalls: Ref.get(closePullRequestCalls),
          pullRequestLookups: Ref.get(pullRequestLookups),
          pullRequestGets: Ref.get(pullRequestGets),
          removedWorktrees: Ref.get(removedWorktrees),
          settledThreads: fake.settled,
          setBaseTip: (ref, tip) => void baseTips.set(ref, tip),
          makeFirstCommit: () => {
            unbornBranch = undefined;
          },
          setBoardSettings: (settings) => void (boardSettings = settings),
          setWorktreeUndurable: (undurable) => void (worktreeUndurable = undurable),
          gitInvocations: Effect.sync(() => [...gitInvocationLog]),
        });
      }).pipe(
        Effect.provide(
          SupervisorReactorLive.pipe(
            Layer.provideMerge(
              Layer.effect(
                BoardWorkspaces,
                localBoardWorkspaceDeps.pipe(
                  Effect.map((local) =>
                    input.workspaces === undefined
                      ? makeBoardWorkspaces(local)
                      : input.workspaces(local),
                  ),
                ),
              ),
            ),
            Layer.provideMerge(deps),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
}

/** A generic stage-crossing event. The reactor keys on `toStage`, so this is how
    every human gate (approve → ready, begin build → building) is delivered. */
export const cardMoved = (
  card: BoardCard,
  fromStage: string,
  toStage: string,
  sequence: number,
): HarnessEvent =>
  ({
    type: "board.card-moved",
    sequence,
    payload: {
      cardId: card.id,
      fromStage: BoardStageId.make(fromStage),
      toStage: BoardStageId.make(toStage),
      card,
    },
  }) as unknown as HarnessEvent;

/** The "Begin build" gate: Ready → Building carrying the provisioned card. */
export const movedToBuilding = (card: BoardCard, sequence: number): HarnessEvent =>
  cardMoved(card, "ready", "building", sequence);

export const stepCompleted = (
  cardId: BoardCardId,
  outcome: "succeeded" | "failed" | "blocked",
  sequence: number,
  /**
   * Which step reported. Defaults to the Building stage's step; the handler ignores a
   * completion whose step is not the card's live one, so other stages must say so.
   */
  stepId: string = String(BOARD_SEED_STAGE_IDS.building),
): HarnessEvent =>
  ({
    type: "board.card-step-completed",
    sequence,
    payload: {
      cardId,
      completion: {
        cardId,
        stepId,
        outcome,
        summary: `report ${outcome}`,
        payload: null,
        threadId: null,
        completedAt: NOW,
      },
    },
  }) as unknown as HarnessEvent;

/** A human's force-start request as the decider emits it: the whole
    step row with the override set. The pump projects it into the model before
    the reactor observes it, exactly as the projection pipeline does in
    production, so `schedule` reads a row that really carries `forceStart`. */
export const forceStartRequested = (state: BoardCardStepState, sequence: number): HarnessEvent =>
  ({
    type: "board.card-step-force-start-requested",
    sequence,
    payload: { cardId: state.cardId, state: { ...state, forceStart: true } },
  }) as unknown as HarnessEvent;

/** A turn being INTERRUPTED on a thread — what the Stop button emits,
    and the signal that parks a board-run step. The board's own interrupts emit
    exactly the same signal, which is why the reactor filters them by thread.
    `_sequence` is kept so call sites read like the board events beside them. */
export const turnInterruptRequested = (threadId: ThreadId, _sequence?: number): ThreadSignal => ({
  type: "interrupt-requested",
  threadId,
});

/** A parked step sent back to the build queue — the shape
    `board.card.requeue-step` decides, as it reaches the reactor's domain
    stream. Mirrors `forceStartRequested`: the client's own command is covered
    at the decider, and this is how its EVENT reaches a live reactor. */
export const stepRequeued = (state: BoardCardStepState, sequence: number): HarnessEvent =>
  ({
    type: "board.card-step-recovered",
    sequence,
    payload: {
      cardId: state.cardId,
      state: {
        ...state,
        status: "queued",
        stallCount: 0,
        lastError: null,
        slotHeld: false,
        startedAt: null,
      },
    },
  }) as unknown as HarnessEvent;

/** A card edit as the decider emits it: the whole card, plus the
    key that says the edit TOUCHED the schedule. That key is what the reactor
    reads to tell a schedule edit from a title edit, so a helper that omitted it
    would drive a path production never takes. */
export const cardScheduleUpdated = (
  card: BoardCard,
  scheduledStartAt: string | null,
  sequence: number,
): HarnessEvent =>
  ({
    type: "board.card-updated",
    sequence,
    payload: {
      cardId: card.id,
      card: { ...card, scheduledStartAt },
      scheduledStartAt,
    },
  }) as unknown as HarnessEvent;

/** A human flipping the card's human-in-the-loop toggle, and
    the shape the reactor's own Stop flip re-enters as. The engine
    double applies a decided event to the read model but does not feed it back
    onto the domain stream, so a test that wants the retune leg pumps this. */
export const cardHumanInLoopUpdated = (
  card: BoardCard,
  humanInLoop: boolean | null,
  sequence: number,
): HarnessEvent =>
  ({
    type: "board.card-updated",
    sequence,
    payload: {
      cardId: card.id,
      card: { ...card, humanInLoop },
      humanInLoop,
    },
  }) as unknown as HarnessEvent;

/** A HUMAN starting a turn on a thread — typing into the composer.
    `byBoard: false` is the whole point: it is what tells this apart from the
    board's own nudge. */
export const humanTurnStartRequested = (
  threadId: ThreadId,
  _sequence?: number,
  at: string = NOW,
): ThreadSignal => ({ type: "turn-requested", threadId, byBoard: false, at });

/** The BOARD's own nudge starting a turn. It must NOT read as a
    human steering, or the recovery ladder could never reach its ceiling. */
export const boardTurnStartRequested = (
  threadId: ThreadId,
  _sequence?: number,
  at: string = NOW,
): ThreadSignal => ({ type: "turn-requested", threadId, byBoard: true, at });

/** An edit that leaves the schedule alone — a title change. The absent
    `scheduledStartAt` key is the whole point: it is what must stop an unrelated
    edit from resuming a card parked for another reason. */
export const cardTitleUpdated = (card: BoardCard, sequence: number): HarnessEvent =>
  ({
    type: "board.card-updated",
    sequence,
    payload: { cardId: card.id, card: { ...card, title: `${card.title} (edited)` } },
  }) as unknown as HarnessEvent;

/** An edit that TOUCHED the auto-merge toggle. The marker is what
    the reactor keys the fire-on-toggle on, so a helper that only set the
    card's field would prove nothing. */
export const cardAutoMergeUpdated = (
  card: BoardCard,
  autoMerge: boolean,
  sequence: number,
): HarnessEvent => cardAutomationUpdated(card, { autoMerge: autoMerge ? true : null }, sequence);

/** A `board.card.set-automation` as the decider records it: the card with its
    new own toggles, and the marker naming which moved. The harness does not
    loop the reactor's events back, so a test writes the card into the model
    itself (see `setAutomation`) and pumps this. */
const cardAutomationUpdated = (
  card: BoardCard,
  settings: {
    readonly autoPlan?: boolean | null;
    readonly autoBuild?: boolean | null;
    readonly autoMerge?: boolean | null;
  },
  sequence: number,
): HarnessEvent =>
  ({
    type: "board.card-updated",
    sequence,
    payload: {
      cardId: card.id,
      card: {
        ...card,
        ...(settings.autoPlan === undefined ? {} : { autoPlanSetting: settings.autoPlan }),
        ...(settings.autoBuild === undefined ? {} : { autoBuildSetting: settings.autoBuild }),
        ...(settings.autoMerge === undefined ? {} : { autoMergeSetting: settings.autoMerge }),
      },
      automationChanged: {
        ...(settings.autoPlan === undefined ? {} : { autoPlan: true }),
        ...(settings.autoBuild === undefined ? {} : { autoBuild: true }),
        ...(settings.autoMerge === undefined ? {} : { autoMerge: true }),
      },
    },
  }) as unknown as HarnessEvent;

export const cardArchived = (card: BoardCard, sequence: number): HarnessEvent =>
  ({
    type: "board.card-archived",
    sequence,
    payload: { cardId: card.id, archivedAt: NOW, card },
  }) as unknown as HarnessEvent;

/**
 * A card DELETE. The card is gone when this arrives, so the payload carries the step state
 * whose slot is released (`null` for no live step) and the threads being deleted.
 */
export const cardDeleted = (
  card: BoardCard,
  sequence: number,
  stepState: BoardCardStepState | null,
): HarnessEvent =>
  ({
    type: "board.card-deleted",
    sequence,
    payload: {
      cardId: card.id,
      deletedAt: NOW,
      card,
      threadIds: card.threadLinks.map((link) => link.threadId),
      stepState,
    },
  }) as unknown as HarnessEvent;

/**
 * A turn ending on a thread. `turnId` names the turn that ENDED — pass it
 * whenever the fixture also gives the thread a state, because that is the pair
 * the turn-end handler compares to tell a lagging read from a live second turn.
 */
export const turnCompleted = (threadId: ThreadId, turnId?: string): ThreadSignal => ({
  type: "turn-ended",
  threadId,
  turnRef: turnId,
});

/** A structured question being ANSWERED. It is raised from inside a
    running turn and answering it only resolves the deferred that turn is blocked
    on, so no turn ever starts — this is the only signal a board sees.
    `answered` is what tells it from a cancellation (`userInputCancelled`). */
export const userInputResolved = (threadId: ThreadId): ThreadSignal => ({
  type: "input-resolved",
  threadId,
  answered: true,
});

/** A structured question CANCELLED — resolved with nothing answered, as a
    thread stopped with a question outstanding resolves it. */
export const userInputCancelled = (threadId: ThreadId): ThreadSignal => ({
  type: "input-resolved",
  threadId,
  answered: false,
});

/** An ORDINARY agent question: what every provider raises when it
    asks a human, with no board tool call behind it. */
export const userInputRequested = (threadId: ThreadId): ThreadSignal => ({
  type: "input-requested",
  threadId,
});

export const stepStatus = (board: BoardState, cardId: BoardCardId) =>
  boardCardStepState(board, cardId)?.status ?? null;

/** The stage a card currently sits in, per the live read model. */
export const cardStage = (board: BoardState, cardId: BoardCardId): BoardStageId | null =>
  board.cards.find((candidate) => candidate.id === cardId)?.stage ?? null;

/**
 * Flip a card's own Automation toggles the way `board.card.set-automation`
 * does: the card is written into the model, then the decider's event
 * is delivered to the reactor.
 */
export const setAutomation = (
  h: Pick<Harness, "model" | "pumpDomain">,
  cardId: BoardCardId,
  settings: {
    readonly autoPlan?: boolean | null;
    readonly autoBuild?: boolean | null;
    readonly autoMerge?: boolean | null;
  },
  sequence: number,
) =>
  Effect.gen(function* () {
    let updated: BoardCard | undefined;
    yield* Ref.update(h.model, (current) => {
      const board = current.board!;
      return {
        ...current,
        board: {
          ...board,
          cards: board.cards.map((card) => {
            if (card.id !== cardId) return card;
            updated = {
              ...card,
              ...(settings.autoPlan === undefined ? {} : { autoPlanSetting: settings.autoPlan }),
              ...(settings.autoBuild === undefined ? {} : { autoBuildSetting: settings.autoBuild }),
              ...(settings.autoMerge === undefined ? {} : { autoMergeSetting: settings.autoMerge }),
            };
            return updated;
          }),
        },
      };
    });
    if (updated === undefined) return;
    yield* h.pumpDomain(cardAutomationUpdated(updated, settings, sequence));
  });
