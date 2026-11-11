/**
 * A command id's prefix is the only durable record of who minted it, and it survives
 * restarts on the persisted event. Upstream's actor inference delegates here so the two
 * readers cannot drift: a human's message must never look like a board nudge.
 */

/** Prefix a provider adapter stamps onto commands it originates. */
const PROVIDER_COMMAND_ID_PREFIX = "provider:";

/** Prefix the server stamps onto commands it originates. */
const SERVER_COMMAND_ID_PREFIX = "server:";

/**
 * Prefix the board supervisor stamps onto its own commands, as
 * `server:board-<tag>:<uuid>`. A subset of `SERVER_COMMAND_ID_PREFIX`, so the
 * order of the tests in `commandIdOrigin` does not matter — a board id is a
 * server id, more precisely named.
 */
export const BOARD_COMMAND_ID_PREFIX = "server:board-";

/**
 * Null is not "client": a bare UUID is also what an id with no convention looks like,
 * and callers disagree about the fallback.
 */
export function commandIdOrigin(
  commandId: string | null | undefined,
): "provider" | "server" | null {
  if (commandId == null) return null;
  if (commandId.startsWith(PROVIDER_COMMAND_ID_PREFIX)) return "provider";
  if (commandId.startsWith(SERVER_COMMAND_ID_PREFIX)) return "server";
  return null;
}

/**
 * False for a null id: the board always stamps one, and reading unknown as the board's
 * would let a human's message pass for a nudge.
 */
export function isBoardMintedCommandId(commandId: string | null | undefined): boolean {
  return commandId != null && commandId.startsWith(BOARD_COMMAND_ID_PREFIX);
}
