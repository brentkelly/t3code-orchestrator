/**
 * Where a board card's linked thread should open (T3O-18).
 *
 * Destination is the thread's own environment when one is recorded, otherwise
 * the board host. If that destination is not connected, the client must
 * connect it first — never open a worker thread against the board-host
 * environment id when the thread lives elsewhere.
 */
import type { EnvironmentId } from "@t3tools/contracts";

export type BoardThreadOpenAction =
  | { readonly kind: "open"; readonly environmentId: EnvironmentId }
  | { readonly kind: "connect"; readonly environmentId: EnvironmentId };

export interface BoardThreadOpenInput {
  readonly boardHostEnvironmentId: EnvironmentId;
  readonly threadEnvironmentId?: EnvironmentId | null;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId> | ReadonlyArray<EnvironmentId>;
}

export function boardThreadOpen(input: BoardThreadOpenInput): BoardThreadOpenAction {
  const environmentId = input.threadEnvironmentId ?? input.boardHostEnvironmentId;
  const connected =
    input.connectedEnvironmentIds instanceof Set
      ? input.connectedEnvironmentIds
      : new Set(input.connectedEnvironmentIds);
  if (!connected.has(environmentId)) {
    return { kind: "connect", environmentId };
  }
  return { kind: "open", environmentId };
}
