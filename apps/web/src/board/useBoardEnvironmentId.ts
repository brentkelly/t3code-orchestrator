/**
 * T3o: which environment's board this device shows (T3O-71).
 *
 * In the distributed board (D19–D22) one central server hosts the board. A desktop app's primary
 * environment is its own local server, so a client that only ever read the primary would show an
 * empty local board while paired with the central one. The per-device `boardEnvironmentId` client
 * setting nominates the board server; null means the primary. Every board surface — the board,
 * its card detail, and Settings → Board — reads its environment, its board settings and its
 * provider list through this module so they always agree on one server.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ServerProvider,
  type ServerSettings,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import {
  mergeEnvironmentSettings,
  useClientSettings,
  useUpdateEnvironmentSettings,
} from "../hooks/useSettings";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";

/** What a known environment looks like to the resolver. */
export interface BoardEnvironmentCandidate {
  readonly label: string;
  readonly enabled: boolean;
  readonly phase: EnvironmentConnectionPhase;
}

export type BoardEnvironmentResolution =
  /** Show this environment's board. `nominated` is false when it is the primary by default. */
  | { readonly kind: "ready"; readonly environmentId: EnvironmentId; readonly nominated: boolean }
  /** Nothing nominated and no primary: the hosted app before any connection. */
  | { readonly kind: "none" }
  /** The nominated board server is not reachable; the board must say so rather than fall back. */
  | {
      readonly kind: "unavailable";
      readonly environmentId: EnvironmentId;
      /** Null when the environment is not in this device's catalog at all. */
      readonly label: string | null;
    };

/**
 * Phases in which the nominated server's board can render. A server still connecting renders the
 * same loading board the primary does, so a cold start never flashes "not connected".
 */
const RENDERABLE_PHASES: ReadonlySet<EnvironmentConnectionPhase> = new Set([
  "available",
  "connecting",
  "reconnecting",
  "connected",
]);

/**
 * Resolve the board environment. A nominated server that is unknown, disabled or failed is
 * reported unavailable — never silently swapped for the primary, whose board is a different one.
 */
export function resolveBoardEnvironment(input: {
  readonly nominated: EnvironmentId | null;
  readonly primary: EnvironmentId | null;
  readonly candidates: ReadonlyMap<EnvironmentId, BoardEnvironmentCandidate>;
}): BoardEnvironmentResolution {
  const { nominated, primary, candidates } = input;
  if (nominated === null || nominated === primary) {
    return primary === null
      ? { kind: "none" }
      : { kind: "ready", environmentId: primary, nominated: false };
  }
  const candidate = candidates.get(nominated);
  if (candidate === undefined) {
    return { kind: "unavailable", environmentId: nominated, label: null };
  }
  if (!candidate.enabled || !RENDERABLE_PHASES.has(candidate.phase)) {
    return { kind: "unavailable", environmentId: nominated, label: candidate.label };
  }
  return { kind: "ready", environmentId: nominated, nominated: true };
}

const selectBoardEnvironmentId = (settings: {
  readonly boardEnvironmentId: EnvironmentId | null;
}) => settings.boardEnvironmentId;

/** The board environment, resolved against this device's connection catalog. */
export function useBoardEnvironment(): BoardEnvironmentResolution {
  const nominated = useClientSettings(selectBoardEnvironmentId);
  const primary = usePrimaryEnvironmentId();
  const { presentationById } = useEnvironments();
  return useMemo(() => {
    const candidates = new Map<EnvironmentId, BoardEnvironmentCandidate>();
    for (const [environmentId, presentation] of presentationById) {
      candidates.set(environmentId, {
        label: presentation.entry.target.label,
        enabled: presentation.entry.enabled,
        phase: presentation.connection.phase,
      });
    }
    return resolveBoardEnvironment({ nominated, primary, candidates });
  }, [nominated, primary, presentationById]);
}

/** The environment whose board to show, or null when there is none to show. */
export function useBoardEnvironmentId(): EnvironmentId | null {
  const resolution = useBoardEnvironment();
  return resolution.kind === "ready" ? resolution.environmentId : null;
}

const noBoardServerSettingsAtom = Atom.make<ServerSettings | null>(null);
const noBoardServerProvidersAtom = Atom.make<ReadonlyArray<ServerProvider> | null>(null);

/** The board server's settings merged with this device's client settings. */
export function useBoardSettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const environmentId = useBoardEnvironmentId();
  const serverSettings = useAtomValue(
    environmentId === null
      ? noBoardServerSettingsAtom
      : serverEnvironment.settingsValueAtom(environmentId),
  );
  const clientSettings = useClientSettings();
  return useMemo(() => {
    const merged = mergeEnvironmentSettings(
      serverSettings ?? DEFAULT_SERVER_SETTINGS,
      clientSettings,
    );
    return selector ? selector(merged) : (merged as T);
  }, [clientSettings, selector, serverSettings]);
}

/** Writes settings to the board server (board settings live on the server that hosts the board). */
export function useUpdateBoardSettings() {
  return useUpdateEnvironmentSettings(useBoardEnvironmentId());
}

/** The board server's provider instances, for the board's model pickers and limit pills. */
export function useBoardServerProviders(): ReadonlyArray<ServerProvider> {
  const environmentId = useBoardEnvironmentId();
  return (
    useAtomValue(
      environmentId === null
        ? noBoardServerProvidersAtom
        : serverEnvironment.providersValueAtom(environmentId),
    ) ?? EMPTY_SERVER_PROVIDERS
  );
}
