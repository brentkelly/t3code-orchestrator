/**
 * T3o: command fingerprints — make commandId dedup compare the COMMAND, not
 * just its aggregate (issue #120).
 *
 * Upstream's receipt check replays any receipt whose aggregate matches, so a
 * commandId reused for a different command against the same aggregate (a card
 * move, then a delete; a queued task's model selection, then an edited one)
 * returned the earlier command's sequence as success and never ran. The
 * receipt table is upstream-owned, so the fork records each accepted command's
 * `type` and payload hash beside it in `boards.board_command_fingerprints`
 * (board migration 044) and the engine consults it on a receipt hit through two
 * one-line seams.
 *
 * Receipts with no fingerprint — written before migration 044, or rejected
 * commands, which are not fingerprinted — keep the legacy replay behaviour.
 */
import * as NodeCrypto from "node:crypto";

import type { OrchestrationCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { OrchestrationCommandIdConflictError } from "../orchestration/Errors.ts";

/**
 * Top-level command fields that do not identify WHAT the command does.
 *
 * - `commandId` is the dedup key itself.
 * - `createdAt` is stamped at dispatch time; an honest retry of the same command
 *   (a server reactor re-dispatching after a restart, a client resending its
 *   outbox) rebuilds it, and that must still replay idempotently.
 *
 * Every other field — including semantic timestamps such as `scheduledStartAt`
 * or `retryAt` — is part of the command and changes its fingerprint.
 */
const VOLATILE_COMMAND_FIELDS: ReadonlySet<string> = new Set(["commandId", "createdAt"]);

/** JSON with object keys sorted and `undefined` members dropped, recursively. */
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(",")}}`;
};

export interface CommandFingerprint {
  readonly commandType: string;
  readonly payloadHash: string;
}

/** The command's type plus a SHA-256 of its canonical payload minus volatile fields. */
export const commandFingerprint = (command: OrchestrationCommand): CommandFingerprint => {
  const payload = Object.fromEntries(
    Object.entries(command).filter(([key]) => !VOLATILE_COMMAND_FIELDS.has(key)),
  );
  return {
    commandType: command.type,
    payloadHash: NodeCrypto.createHash("sha256").update(canonicalJson(payload)).digest("hex"),
  };
};

const describe = (fingerprint: CommandFingerprint, aggregateKind: string): string =>
  `${fingerprint.commandType} (payload ${fingerprint.payloadHash.slice(0, 12)}) on ${aggregateKind}`;

export const makeCommandFingerprints = (sql: SqlClient.SqlClient) => {
  /**
   * Record the accepted command's fingerprint. Called inside the engine's
   * accept transaction, right after the receipt upsert. An upsert, not an
   * insert: the receipt and this row live in different database files, so
   * under WAL a crash can commit one without the other. A receipt without a
   * fingerprint degrades to legacy replay; a fingerprint without a receipt is
   * never consulted and is overwritten when the id is next accepted.
   */
  const record = (command: OrchestrationCommand) => {
    const { commandType, payloadHash } = commandFingerprint(command);
    return sql`
      INSERT INTO boards.board_command_fingerprints (command_id, command_type, payload_hash)
      VALUES (${command.commandId}, ${commandType}, ${payloadHash})
      ON CONFLICT (command_id) DO UPDATE SET
        command_type = excluded.command_type,
        payload_hash = excluded.payload_hash
    `.pipe(Effect.asVoid);
  };

  /**
   * On a receipt hit whose aggregate already matched: fail with
   * `OrchestrationCommandIdConflictError` when the recorded fingerprint differs
   * from this command's. No recorded fingerprint means a legacy receipt; the
   * caller keeps its existing replay behaviour.
   *
   * The conflict error's fields are upstream's (aggregate-only), so the command
   * type and payload hash are folded into its `*AggregateKind` strings, which
   * its message interpolates verbatim: "Command id 'K' already used for
   * board.card.update (payload …) on card 'X'; refusing to replay its receipt
   * for board.card.delete (payload …) on card 'X'."
   */
  const assertReplayMatches = (
    command: OrchestrationCommand,
    receipt: { readonly aggregateKind: string; readonly aggregateId: string },
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly commandType: string; readonly payloadHash: string }>`
        SELECT command_type AS "commandType", payload_hash AS "payloadHash"
        FROM boards.board_command_fingerprints
        WHERE command_id = ${command.commandId}
      `;
      const recorded = rows[0];
      if (recorded === undefined) return;
      const incoming = commandFingerprint(command);
      if (
        recorded.commandType === incoming.commandType &&
        recorded.payloadHash === incoming.payloadHash
      ) {
        return;
      }
      return yield* new OrchestrationCommandIdConflictError({
        commandId: command.commandId,
        receiptAggregateKind: describe(recorded, receipt.aggregateKind),
        receiptAggregateId: receipt.aggregateId,
        commandAggregateKind: describe(incoming, receipt.aggregateKind),
        commandAggregateId: receipt.aggregateId,
      });
    }).pipe(
      Effect.catchTag("SqlError", (error) =>
        Effect.fail(toPersistenceSqlError("CommandFingerprints.assertReplayMatches:query")(error)),
      ),
    );

  return { record, assertReplayMatches } as const;
};
