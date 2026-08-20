/**
 * T3o card thread `+` menu — pure derivations (t3o-14).
 *
 * The menu's restart affordance is gated by two facts about the card's current
 * stage: whether it auto-executes (the item exists at all) and whether a
 * supervised run is in flight (the item is disabled). Both are computed here as
 * pure functions so the D1 safety gate — "never offer a restart that would put
 * two threads on the same step" — is assertable without mounting the connected
 * component.
 */
import type { BoardCardShell } from "@t3tools/contracts";

import type { BoardThreadStageRestart } from "./BoardCardThreadAddMenu";

/** The reason the restart item is disabled while a run is in flight — surfaced
    in the menu and pinned by the tests. */
export const BOARD_STAGE_RESTART_IN_FLIGHT_REASON =
  "A run is already in flight for this card — drag it out and back to restart.";

/**
 * Whether a supervised run is in flight for the card (t3o-14 D1). The step-state
 * read model is server-only, so the client reads the card shell's derived live
 * status as its proxy: an actively working thread, one awaiting the human
 * (`waiting`), or a build holding in the governor queue all count. An idle live
 * linked thread (`stopped` / `none`) does NOT — restarting onto it is the whole
 * point of the explicit escape hatch (D2), so it must stay enabled.
 */
export function isBoardCardRunInFlight(
  shell: Pick<BoardCardShell, "threadState" | "queued"> | undefined,
): boolean {
  if (shell === undefined) return false;
  return shell.threadState === "working" || shell.threadState === "waiting" || shell.queued;
}

/**
 * The `+` menu's restart affordance (t3o-14 D1/D4): `null` when the current
 * stage does not auto-execute (the item is absent, not disabled); otherwise the
 * stage label plus a disabled reason that is non-null exactly while a supervised
 * run is in flight.
 */
export function resolveBoardThreadStageRestart(input: {
  readonly autoExecute: boolean;
  readonly stageLabel: string;
  readonly runInFlight: boolean;
}): BoardThreadStageRestart | null {
  if (!input.autoExecute) return null;
  return {
    label: input.stageLabel,
    disabledReason: input.runInFlight ? BOARD_STAGE_RESTART_IN_FLIGHT_REASON : null,
  };
}
