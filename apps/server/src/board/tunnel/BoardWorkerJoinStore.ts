// @effect-diagnostics nodeBuiltinImport:off - SHA-256 for stored hashes.
/**
 * Join codes and tunnel credentials (migration 068). Only SHA-256 hashes are kept,
 * so nothing at rest on the board can be replayed as a code or a credential.
 */
import * as Crypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export const hashSecret = (secret: string): string =>
  Crypto.createHash("sha256").update(secret, "utf8").digest("hex");

export interface JoinCodeRecord {
  readonly codeId: string;
  readonly codeHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly usedAt: string | null;
  readonly usedByWorkerId: string | null;
  readonly usedByLabel: string | null;
  readonly usedFrom: string | null;
  readonly usedRelease: string | null;
  readonly rejoin: boolean;
  readonly cancelledAt: string | null;
}

export interface BoardWorkerJoinStoreShape {
  readonly createCode: (record: {
    readonly codeId: string;
    readonly codeHash: string;
    readonly createdAt: string;
    readonly expiresAt: string;
  }) => Effect.Effect<void>;
  readonly findCodeByHash: (codeHash: string) => Effect.Effect<JoinCodeRecord | null>;
  /** Mark a code used, only if it is still open; false when someone else got there first. */
  readonly useCode: (input: {
    readonly codeId: string;
    readonly usedAt: string;
    readonly workerId: string;
    readonly label: string;
    readonly address: string | null;
    readonly release: string;
    readonly rejoin: boolean;
  }) => Effect.Effect<boolean>;
  readonly cancelCode: (codeId: string, at: string) => Effect.Effect<boolean>;
  /** Codes created since `since`, newest first. */
  readonly recentCodes: (since: string) => Effect.Effect<ReadonlyArray<JoinCodeRecord>>;
  readonly issueCredential: (input: {
    readonly workerId: string;
    readonly credentialHash: string;
    readonly issuedAt: string;
  }) => Effect.Effect<void>;
  /** The worker an unrevoked credential belongs to. */
  readonly verifyCredential: (credentialHash: string) => Effect.Effect<string | null>;
  /** Revoke every credential of a worker except `keep` (when given). */
  readonly revokeCredentials: (input: {
    readonly workerId: string;
    readonly at: string;
    readonly keep?: string | undefined;
  }) => Effect.Effect<void>;
}

export class BoardWorkerJoinStore extends Context.Service<
  BoardWorkerJoinStore,
  BoardWorkerJoinStoreShape
>()("t3/board/tunnel/BoardWorkerJoinStore") {}

const CodeRow = Schema.Struct({
  codeId: Schema.String,
  codeHash: Schema.String,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  usedAt: Schema.NullOr(Schema.String),
  usedByWorkerId: Schema.NullOr(Schema.String),
  usedByLabel: Schema.NullOr(Schema.String),
  usedFrom: Schema.NullOr(Schema.String),
  usedRelease: Schema.NullOr(Schema.String),
  rejoin: Schema.Number,
  cancelledAt: Schema.NullOr(Schema.String),
});
const decodeCodeRows = Schema.decodeUnknownEffect(Schema.Array(CodeRow));
const toRecord = (row: typeof CodeRow.Type): JoinCodeRecord => ({ ...row, rejoin: row.rejoin !== 0 });

/** A broken store is the board's own failure, never something a joining worker handles. */
export const BoardWorkerJoinStoreLive = Layer.effect(
  BoardWorkerJoinStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      createCode: (record) =>
        sql`
          INSERT INTO board_worker_join_codes (code_id, code_hash, created_at, expires_at)
          VALUES (${record.codeId}, ${record.codeHash}, ${record.createdAt}, ${record.expiresAt})
        `.pipe(Effect.asVoid, Effect.orDie),
      findCodeByHash: (codeHash) =>
        sql`
          SELECT
              code_id AS "codeId", code_hash AS "codeHash", created_at AS "createdAt",
              expires_at AS "expiresAt", used_at AS "usedAt", used_by_worker_id AS "usedByWorkerId",
              used_by_label AS "usedByLabel", used_from AS "usedFrom", used_release AS "usedRelease",
              rejoin, cancelled_at AS "cancelledAt"
            FROM board_worker_join_codes
          WHERE code_hash = ${codeHash}
        `.pipe(
          Effect.flatMap(decodeCodeRows),
          Effect.map((rows) => (rows[0] === undefined ? null : toRecord(rows[0]))),
          Effect.orDie,
        ),
      useCode: (input) =>
        sql`
          UPDATE board_worker_join_codes SET
            used_at = ${input.usedAt}, used_by_worker_id = ${input.workerId},
            used_by_label = ${input.label}, used_from = ${input.address},
            used_release = ${input.release}, rejoin = ${input.rejoin ? 1 : 0}
          WHERE code_id = ${input.codeId} AND used_at IS NULL AND cancelled_at IS NULL
          RETURNING code_id
        `.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        ),
      cancelCode: (codeId, at) =>
        sql`
          UPDATE board_worker_join_codes SET cancelled_at = ${at}
          WHERE code_id = ${codeId} AND used_at IS NULL AND cancelled_at IS NULL
          RETURNING code_id
        `.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        ),
      recentCodes: (since) =>
        sql`
          SELECT
              code_id AS "codeId", code_hash AS "codeHash", created_at AS "createdAt",
              expires_at AS "expiresAt", used_at AS "usedAt", used_by_worker_id AS "usedByWorkerId",
              used_by_label AS "usedByLabel", used_from AS "usedFrom", used_release AS "usedRelease",
              rejoin, cancelled_at AS "cancelledAt"
            FROM board_worker_join_codes
          WHERE created_at >= ${since} ORDER BY created_at DESC
        `.pipe(
          Effect.flatMap(decodeCodeRows),
          Effect.map((rows) => rows.map(toRecord)),
          Effect.orDie,
        ),
      issueCredential: (input) =>
        sql`
          INSERT INTO board_worker_tunnel_credentials (credential_hash, worker_id, issued_at)
          VALUES (${input.credentialHash}, ${input.workerId}, ${input.issuedAt})
        `.pipe(Effect.asVoid, Effect.orDie),
      verifyCredential: (credentialHash) =>
        sql<{ readonly workerId: string }>`
          SELECT worker_id AS "workerId" FROM board_worker_tunnel_credentials
          WHERE credential_hash = ${credentialHash} AND revoked_at IS NULL
        `.pipe(
          Effect.map((rows) => rows[0]?.workerId ?? null),
          Effect.orDie,
        ),
      revokeCredentials: (input) =>
        (input.keep === undefined
          ? sql`
              UPDATE board_worker_tunnel_credentials SET revoked_at = ${input.at}
              WHERE worker_id = ${input.workerId} AND revoked_at IS NULL
            `
          : sql`
              UPDATE board_worker_tunnel_credentials SET revoked_at = ${input.at}
              WHERE worker_id = ${input.workerId} AND revoked_at IS NULL
                AND credential_hash != ${input.keep}
            `
        ).pipe(Effect.asVoid, Effect.orDie),
    } satisfies BoardWorkerJoinStoreShape;
  }),
);

/** An in-memory store, for tests. */
export const makeMemoryBoardWorkerJoinStore = Effect.gen(function* () {
  const codes = yield* Ref.make(new Map<string, JoinCodeRecord>());
  const credentials = yield* Ref.make(
    new Map<string, { workerId: string; revokedAt: string | null }>(),
  );
  const store: BoardWorkerJoinStoreShape = {
    createCode: (record) =>
      Ref.update(codes, (map) =>
        new Map(map).set(record.codeId, {
          ...record,
          usedAt: null,
          usedByWorkerId: null,
          usedByLabel: null,
          usedFrom: null,
          usedRelease: null,
          rejoin: false,
          cancelledAt: null,
        }),
      ),
    findCodeByHash: (codeHash) =>
      Ref.get(codes).pipe(
        Effect.map((map) => [...map.values()].find((code) => code.codeHash === codeHash) ?? null),
      ),
    useCode: (input) =>
      Ref.modify(codes, (map) => {
        const code = map.get(input.codeId);
        if (code === undefined || code.usedAt !== null || code.cancelledAt !== null) {
          return [false, map];
        }
        return [
          true,
          new Map(map).set(input.codeId, {
            ...code,
            usedAt: input.usedAt,
            usedByWorkerId: input.workerId,
            usedByLabel: input.label,
            usedFrom: input.address,
            usedRelease: input.release,
            rejoin: input.rejoin,
          }),
        ];
      }),
    cancelCode: (codeId, at) =>
      Ref.modify(codes, (map) => {
        const code = map.get(codeId);
        if (code === undefined || code.usedAt !== null || code.cancelledAt !== null) {
          return [false, map];
        }
        return [true, new Map(map).set(codeId, { ...code, cancelledAt: at })];
      }),
    recentCodes: (since) =>
      Ref.get(codes).pipe(
        Effect.map((map) =>
          [...map.values()]
            .filter((code) => code.createdAt >= since)
            .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt)),
        ),
      ),
    issueCredential: (input) =>
      Ref.update(credentials, (map) =>
        new Map(map).set(input.credentialHash, { workerId: input.workerId, revokedAt: null }),
      ),
    verifyCredential: (credentialHash) =>
      Ref.get(credentials).pipe(
        Effect.map((map) => {
          const entry = map.get(credentialHash);
          return entry === undefined || entry.revokedAt !== null ? null : entry.workerId;
        }),
      ),
    revokeCredentials: (input) =>
      Ref.update(credentials, (map) => {
        const next = new Map(map);
        for (const [hash, entry] of map) {
          if (entry.workerId !== input.workerId || entry.revokedAt !== null) continue;
          if (hash === input.keep) continue;
          next.set(hash, { ...entry, revokedAt: input.at });
        }
        return next;
      }),
  };
  return store;
});
