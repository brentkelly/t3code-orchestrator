/**
 * T3o: who minted a command id (T3O-17, D2).
 *
 * Every orchestration command carries a `commandId`, and its PREFIX is the only
 * durable record of where the command came from. The server stamps
 * `server:<tag>:<uuid>`, a provider adapter stamps `provider:…`, and a client —
 * the composer in web, desktop or mobile — mints a bare UUID. Upstream already
 * leans on exactly that rule to label an event's actor
 * (`OrchestrationEventStore`'s `inferActorKind`).
 *
 * The board needs the same rule for a sharper question: was this turn started
 * by the supervisor's own nudge, or by a HUMAN typing into the thread? A human's
 * message must never draw a resume nudge on top of it, and the board's own nudge
 * must never look like one. The prefix answers both, and it answers them
 * durably: it rides the persisted event, so it survives a restart and a
 * projection rebuild.
 *
 * Kept here, with upstream's own classifier delegating to it, so the two cannot
 * drift. If the minting convention ever changes, both readers move together —
 * and `commandOrigin.test.ts` fails if the board's minting stops matching.
 */

/** Prefix a provider adapter stamps onto commands it originates. */
export const PROVIDER_COMMAND_ID_PREFIX = "provider:";

/** Prefix the server stamps onto commands it originates. */
export const SERVER_COMMAND_ID_PREFIX = "server:";

/**
 * Prefix the board supervisor stamps onto its own commands, as
 * `server:board-<tag>:<uuid>`. A subset of `SERVER_COMMAND_ID_PREFIX`, so the
 * order of the tests in `commandIdOrigin` does not matter — a board id is a
 * server id, more precisely named.
 */
export const BOARD_COMMAND_ID_PREFIX = "server:board-";

/**
 * The origin a command id DECLARES, or null when it declares nothing.
 *
 * Null is not "client": a bare UUID is how a client mints, but it is also what
 * an id with no convention at all looks like, and callers disagree about the
 * fallback. Upstream's actor inference has further evidence to weigh (event
 * metadata) before it settles on `client`; the board only ever asks the
 * narrower `isBoardMintedCommandId`.
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
 * Whether the board supervisor minted this command id.
 *
 * False for a null id on purpose. The board always stamps one, so an absent id
 * is by definition not the board's — and reading "unknown" as "mine" is the
 * dangerous direction here: it would let a human's message be mistaken for a
 * nudge and suppress nothing.
 */
export function isBoardMintedCommandId(commandId: string | null | undefined): boolean {
  return commandId != null && commandId.startsWith(BOARD_COMMAND_ID_PREFIX);
}
