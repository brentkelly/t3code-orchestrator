/** Last Home surface the user chose. Persisted in mobile preferences (T3O-18). */
export type HomeMode = "threads" | "board";

export function sanitizeHomeMode(value: unknown): HomeMode | undefined {
  if (value === "threads" || value === "board") return value;
  return undefined;
}

export function resolveHomeMode(input: {
  readonly saved: HomeMode | undefined;
  readonly boardAvailable: boolean;
}): HomeMode {
  if (!input.boardAvailable) return "threads";
  return input.saved ?? "threads";
}

export function boardCapableEnvironmentIds(
  configs: Iterable<{
    readonly environmentId: string;
    readonly environment?: { readonly capabilities?: { readonly board?: boolean } };
  }>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const config of configs) {
    if (config.environment?.capabilities?.board === true) {
      ids.add(config.environmentId);
    }
  }
  return ids;
}

/** Home filter's environment when it has a board; All falls back; a non-board server stays empty. */
export function pickBoardEnvironmentId<T extends { readonly environmentId: string }>(input: {
  readonly selectedEnvironmentId: string | null;
  readonly environments: ReadonlyArray<T>;
  readonly boardCapableIds: ReadonlySet<string>;
}): T["environmentId"] | null {
  if (input.selectedEnvironmentId !== null) {
    return input.boardCapableIds.has(input.selectedEnvironmentId)
      ? (input.selectedEnvironmentId as T["environmentId"])
      : null;
  }
  return (
    input.environments.find((environment) => input.boardCapableIds.has(environment.environmentId))
      ?.environmentId ?? null
  );
}

export function boardShouldShowEnvironmentLabel(input: {
  readonly boardEnvironmentId: string;
  readonly selectedEnvironmentId: string | null;
}): boolean {
  return input.selectedEnvironmentId !== input.boardEnvironmentId;
}

export function boardEmptyStateCopy(input: {
  readonly selectedEnvironmentId: string | null;
  readonly boardCapableIds: ReadonlySet<string>;
}): { readonly title: string; readonly detail: string } {
  return {
    title: "No board on this server",
    detail:
      input.selectedEnvironmentId !== null &&
      !input.boardCapableIds.has(input.selectedEnvironmentId)
        ? "The Home filter is a server without a board."
        : "Pair a T3o server to see the Board.",
  };
}

export type BoardComposeAction = "create" | "empty-board" | "new-task";

export function boardComposeAction(input: {
  readonly homeMode: HomeMode;
  readonly boardEnvironmentId: string | null;
}): BoardComposeAction {
  if (input.homeMode !== "board") return "new-task";
  return input.boardEnvironmentId === null ? "empty-board" : "create";
}

/** Environment id BoardHomeScreen is mounted for, or null when it is not. */
export function boardCreateHostKey(input: {
  readonly homeMode: HomeMode;
  readonly boardEnvironmentId: string | null;
}): string | null {
  return input.homeMode === "board" ? input.boardEnvironmentId : null;
}

/** True while BoardHomeScreen is mounted to consume a New-card press. */
export function boardCreateRequestStaysArmed(input: {
  readonly homeMode: HomeMode;
  readonly boardEnvironmentId: string | null;
}): boolean {
  return boardCreateHostKey(input) !== null;
}

/** Drop a New-card press once the board that armed it is no longer mounted. */
export function boardCreateRequestForHost(input: {
  readonly createForHost: string | null;
  readonly createHostKey: string | null;
}): string | null {
  if (input.createForHost === null || input.createForHost !== input.createHostKey) {
    return null;
  }
  return input.createForHost;
}
