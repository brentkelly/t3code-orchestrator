/**
 * T3o: a worker's capacity as the Workers page shows it (T3O-86): how much of each declared
 * dimension is free, its agents, each provider's account and quota, and its project readiness.
 */
import {
  BOARD_RESOURCE_DIMENSIONS,
  boardResourceProfileValue,
  PROVIDER_DISPLAY_NAMES,
  type BoardResourceProfile,
  type BoardWorkerCapacitySnapshot,
  type BoardWorkerProviderCapacity,
  type ProviderDriverKind,
} from "@t3tools/contracts";

const NAMES = { cpu: "CPU", ram: "RAM", disk: "Disk" } as const;
const UNITS = { cpu: "cores", ram: "GiB", disk: "GB" } as const;
const round = (value: number) => Math.round(value * 10) / 10;

export interface BoardWorkerCapacityLines {
  readonly bars: ReadonlyArray<{
    readonly label: string;
    /** 0 to 1: how much of the declared amount is in use. */
    readonly used: number;
    /** "3.5 of 16 cores free". */
    readonly text: string;
    /** "Declared 32 cores · offered 4 · this board's cards hold 24". */
    readonly tooltip: string;
  }>;
  /** "2 agents running · at most 4". */
  readonly agents: string;
  /** Amber: the worker takes nothing new until it drops back. */
  readonly over: string | null;
  /** One per provider: its account, its usage windows, and why it takes no work. */
  readonly providers: ReadonlyArray<BoardWorkerProviderLines>;
  /** "Ready for 3 of 4 projects", or null when none was checked. */
  readonly readiness: string | null;
  readonly notReady: number;
  /** One line per project not ready: "acme/app · Not ready · exit 1". */
  readonly projects: ReadonlyArray<string>;
  /** Null while live; "Last report 14:02" when the worker is out of reach. */
  readonly stale: string | null;
}

export interface BoardWorkerProviderLines {
  /** "Claude · dev@acme.dev · Max". */
  readonly title: string;
  readonly windows: ReadonlyArray<{
    readonly label: string;
    /** 0 to 1. */
    readonly used: number;
    /** "Session · 42% used · resets 14:00". */
    readonly text: string;
    /** Amber: at the worker's threshold, so it refuses new cards. */
    readonly nearLimit: boolean;
  }>;
  /** Amber: "Near its limit: takes no new cards · resets Fri 09:00". */
  readonly nearLimit: string | null;
  /** Violet, a human's to fix: "Signed out · run `claude auth login` on build-01". */
  readonly signedOut: string | null;
}

/** The provider's own sign-in command, or null when it has none a human types. */
const LOGIN_COMMANDS: Readonly<Record<string, string>> = {
  claudeAgent: "claude auth login",
  codex: "codex login",
};

function providerLines(
  provider: BoardWorkerProviderCapacity,
  clock: (iso: string) => string,
  workerName: string,
): BoardWorkerProviderLines {
  const name = PROVIDER_DISPLAY_NAMES[provider.driver as ProviderDriverKind] ?? provider.driver;
  const login = LOGIN_COMMANDS[provider.driver];
  const signedIn = provider.account.status === "signed-in";
  return {
    title: [name, signedIn ? provider.account.email : null, signedIn ? provider.account.plan : null]
      .filter((part): part is string => part != null)
      .join(" · "),
    windows: provider.quota.windows.map((window) => ({
      label: window.label,
      used: Math.min(1, Math.max(0, window.usedPercent / 100)),
      text: [
        window.label,
        `${Math.round(window.usedPercent)}% used`,
        window.resetsAt === null ? null : `resets ${clock(window.resetsAt)}`,
      ]
        .filter((part): part is string => part !== null)
        .join(" · "),
      nearLimit: window.nearLimit === true,
    })),
    nearLimit: provider.quota.exhausted
      ? `Near its limit: takes no new cards${
          provider.quota.resetsAt === null ? "" : ` · resets ${clock(provider.quota.resetsAt)}`
        }`
      : null,
    signedOut:
      provider.account.status === "signed-out"
        ? login === undefined
          ? `Signed out · sign ${name} in on ${workerName}`
          : `Signed out · run \`${login}\` on ${workerName}`
        : null,
  };
}

const STATE_NAMES = {
  "not-set-up": "Not set up",
  cloning: "Cloning",
  checking: "Checking",
  ready: "Ready",
  "not-ready": "Not ready",
} as const;

/**
 * T3o: what the Workers page says of a worker's holds (T3O-87). This board's own hold names its
 * card; a worker closed for any other reason says only that it isn't taking new cards.
 */
export function boardWorkerHoldLine(
  hold: BoardWorkerCapacitySnapshot["hold"],
  cardKeyOf: (cardId: string) => string | null,
  clock: (iso: string) => string,
): string | null {
  if (hold === undefined || !hold.closed) return null;
  const until = hold.until === null ? "" : ` · until ${clock(hold.until)} at the latest`;
  if (hold.cardId !== null) {
    return `Reserved for ${cardKeyOf(hold.cardId) ?? "one of this board's cards"}${until}`;
  }
  return `Not taking new cards${hold.until === null ? "" : ` · until ${clock(hold.until)}`}`;
}

export function boardWorkerCapacityLines(
  snapshot: BoardWorkerCapacitySnapshot & { readonly held?: BoardResourceProfile },
  clock: (iso: string) => string,
  workerName: string,
  /** False when the worker is offline: the snapshot is its last, not what it offers now. */
  live = true,
): BoardWorkerCapacityLines {
  const bars = BOARD_RESOURCE_DIMENSIONS.map((dimension) => {
    const declared = boardResourceProfileValue(snapshot.declared, dimension);
    const free = Math.max(0, boardResourceProfileValue(snapshot.headroom, dimension));
    const unit = UNITS[dimension];
    return {
      label: NAMES[dimension],
      used: declared <= 0 ? 1 : Math.min(1, Math.max(0, 1 - free / declared)),
      text: `${round(free)} of ${round(declared)} ${unit} free`,
      tooltip: [
        `Declared ${round(declared)} ${unit}`,
        `offered ${round(free)}`,
        snapshot.held === undefined
          ? null
          : `this board's cards hold ${round(boardResourceProfileValue(snapshot.held, dimension))}`,
      ]
        .filter((part): part is string => part !== null)
        .join(" · "),
    };
  });
  const { running, max } = snapshot.agents;
  const ready = snapshot.readiness.filter((entry) => entry.state === "ready").length;
  const notReady = snapshot.readiness.filter((entry) => entry.state === "not-ready").length;
  return {
    bars,
    agents: `${running} ${running === 1 ? "agent" : "agents"} running${
      max === null ? "" : ` · at most ${max}`
    }`,
    over: snapshot.over.cpuRam
      ? "Over its declared CPU or RAM: takes no new work until usage drops."
      : snapshot.over.disk
        ? "Over its declared disk: takes no new worktrees until space is freed."
        : null,
    providers: snapshot.providers.map((provider) => providerLines(provider, clock, workerName)),
    readiness:
      snapshot.readiness.length === 0
        ? null
        : `Ready for ${ready} of ${snapshot.readiness.length} ${
            snapshot.readiness.length === 1 ? "project" : "projects"
          }`,
    notReady,
    projects: snapshot.readiness
      .filter((entry) => entry.state !== "ready")
      .map((entry) =>
        [
          entry.repositoryKey?.split("/").slice(-2).join("/") ?? "This project",
          STATE_NAMES[entry.state],
          entry.exitCode == null ? null : `exit ${entry.exitCode}`,
          entry.lastLine ?? null,
        ]
          .filter((part): part is string => part !== null && part !== "")
          .join(" · "),
      ),
    stale: live ? null : `Last report ${clock(snapshot.at)}`,
  };
}
