/**
 * T3o: commandId dedup compares the command itself, not just its aggregate.
 * Missing fingerprints (pre-062 receipts, rejected commands) keep legacy replay.
 */
import * as NodeCrypto from "node:crypto";

import type { BoardCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { BoardCommandIdConflictError } from "./errors.ts";

/** `commandId` is the key; `createdAt` is rebuilt on honest retries. */
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
export const commandFingerprint = (command: BoardCommand): CommandFingerprint => {
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
  /** Record the accepted command beside its receipt (upsert for crash replay). */
  const record = (command: BoardCommand) => {
    const { commandType, payloadHash } = commandFingerprint(command);
    return sql`
      INSERT INTO boards.board_command_fingerprints (command_id, command_type, payload_hash)
      VALUES (${command.commandId}, ${commandType}, ${payloadHash})
      ON CONFLICT (command_id) DO UPDATE SET
        command_type = excluded.command_type,
        payload_hash = excluded.payload_hash
    `.pipe(
      Effect.asVoid,
      Effect.catchTags({
        SqlError: (error) =>
          Effect.fail(toPersistenceSqlError("CommandFingerprints.record:query")(error)),
      }),
    );
  };

  /** Refuse a receipt hit whose recorded type or payload hash does not match. */
  const assertReplayMatches = (
    command: BoardCommand,
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
      return yield* new BoardCommandIdConflictError({
        commandId: command.commandId,
        receiptAggregateKind: describe(recorded, receipt.aggregateKind),
        receiptAggregateId: receipt.aggregateId,
        commandAggregateKind: describe(incoming, receipt.aggregateKind),
        commandAggregateId: receipt.aggregateId,
      });
    }).pipe(
      Effect.catchTags({
        SqlError: (error) =>
          Effect.fail(
            toPersistenceSqlError("CommandFingerprints.assertReplayMatches:query")(error),
          ),
      }),
    );

  return { record, assertReplayMatches } as const;
};
