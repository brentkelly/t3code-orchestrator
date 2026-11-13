/**
 * T3o: a worker's capacity as the Workers page shows it (T3O-86): how much of each declared
 * dimension is free, its agents, any exhausted provider quota, and its project readiness.
 */
import {
  BOARD_RESOURCE_DIMENSIONS,
  boardResourceProfileValue,
  type BoardWorkerCapacitySnapshot,
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
  }>;
  /** "2 agents running · at most 4". */
  readonly agents: string;
  /** Amber: the worker takes nothing new until it drops back. */
  readonly over: string | null;
  /** "Claude quota used up · resets 14:00", one per exhausted provider. */
  readonly quota: ReadonlyArray<string>;
  /** "Ready for 3 of 4 projects", or null when none was checked. */
  readonly readiness: string | null;
  readonly notReady: number;
}

export function boardWorkerCapacityLines(
  snapshot: BoardWorkerCapacitySnapshot,
  clock: (iso: string) => string,
): BoardWorkerCapacityLines {
  const bars = BOARD_RESOURCE_DIMENSIONS.map((dimension) => {
    const declared = boardResourceProfileValue(snapshot.declared, dimension);
    const free = Math.max(0, boardResourceProfileValue(snapshot.headroom, dimension));
    return {
      label: NAMES[dimension],
      used: declared <= 0 ? 1 : Math.min(1, Math.max(0, 1 - free / declared)),
      text: `${round(free)} of ${round(declared)} ${UNITS[dimension]} free`,
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
    quota: snapshot.providers
      .filter((provider) => provider.quota.exhausted)
      .map(
        (provider) =>
          `${provider.driver} quota used up${
            provider.quota.resetsAt === null ? "" : ` · resets ${clock(provider.quota.resetsAt)}`
          }`,
      ),
    readiness:
      snapshot.readiness.length === 0
        ? null
        : `Ready for ${ready} of ${snapshot.readiness.length} ${
            snapshot.readiness.length === 1 ? "project" : "projects"
          }`,
    notReady,
  };
}
