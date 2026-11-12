/**
 * The label a board's own session carries on a worker, shown there under Settings →
 * Sharing & access → Authorized clients. The worker mints that session itself when its
 * tunnel asks for one (T3O-84); trust rests on the session's subject, never this label.
 */
const BOARD_SESSION_LABEL_PREFIX = "T3o board (";

export function boardSessionLabel(centralLabel: string): string {
  return `${BOARD_SESSION_LABEL_PREFIX}${centralLabel})`;
}
