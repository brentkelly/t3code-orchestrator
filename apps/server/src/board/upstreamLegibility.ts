/**
 * Is this database still legible to stock t3code?
 *
 * T3o's promise to anyone trialling the fork (t3o-26) is deliberately narrower
 * than "t3o never writes to your database" — it cannot be, because the board's
 * job is to drive thread work and a card that runs a build has to create a
 * thread. The promise is about legibility:
 *
 *   > t3o writes nothing to your database that stock t3code cannot read.
 *
 * This module is the instrument that checks it.
 *
 * Every read is qualified to `main`: with a second database attached, "what is in
 * the file stock t3code reads?" is the actual question, and an unqualified name
 * would answer a subtly different one.
 *
 * It has no production caller yet, and deliberately so. The plan (t3o-26 P4)
 * makes it a CI gate once P2 has moved the board's rows out, which is the first
 * point at which it can report clean. It is also too expensive for the boot path:
 * the grouped read is a full scan with a temp B-tree — measured at ~2.8s over a
 * 202k-event production log — so calling it on every start would be a visible
 * regression in return for a check that only changes answer across an upgrade. Stock t3code decodes
 * `orchestration_events` through closed `Schema.Literals` unions, so a row whose
 * `event_type` or `aggregate_kind` it does not know is not a degraded read — it
 * is a hard decode failure that takes down replay. Anything this reports is
 * therefore a row that would break stock t3code, not merely confuse it.
 *
 * The upstream event-type set is derived by SUBTRACTING `BOARD_EVENT_TYPES` from
 * the union t3o ships, rather than being written out by hand, so a board event
 * type added later is excluded without anyone remembering to update this file.
 *
 * The derivation has one gap, and it is the dangerous direction: a type t3o adds
 * to `OrchestrationEventType` WITHOUT adding it to `BOARD_EVENT_TYPES` — a
 * t3o-invented `thread.*` type, say — is subtracted from nothing and counts as
 * upstream-legible. Rows for it would then be reported CLEAN while stock t3code
 * could not decode them. Nothing like that exists today (t3o adds no non-board
 * event type; every one of its 35 is `board.*`-namespaced), and the invariant to
 * hold is: anything t3o adds to `OrchestrationEventType` also goes in
 * `BOARD_EVENT_TYPES`. If that ever stops being true, this set needs a different
 * derivation.
 *
 * The remaining gaps all err the safe way, toward over-reporting: a type upstream
 * adds appears here only after a rebase, and a board type retired from
 * `BOARD_EVENT_TYPES` reads as unknown rather than as t3o's doing.
 */
import { BOARD_EVENT_TYPES, OrchestrationEventType } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Aggregate kinds stock t3code knows. Board added `card` / `label` / `stage`. */
export const UPSTREAM_AGGREGATE_KINDS: ReadonlySet<string> = new Set(["project", "thread"]);

/** Event types stock t3code knows: everything t3o ships, minus the board's. */
export const UPSTREAM_EVENT_TYPES: ReadonlySet<string> = (() => {
  const board = new Set<string>(BOARD_EVENT_TYPES);
  return new Set(OrchestrationEventType.literals.filter((type) => !board.has(type)));
})();

export interface UpstreamLegibilityReport {
  /** Event rows whose type or aggregate kind stock t3code cannot decode. */
  readonly illegibleEventRows: number;
  /** The distinct offending event types, for a message worth reading. */
  readonly illegibleEventTypes: ReadonlyArray<string>;
  /** The distinct offending aggregate kinds. */
  readonly illegibleAggregateKinds: ReadonlyArray<string>;
  /** Command receipts carrying a board aggregate kind. */
  readonly illegibleReceiptRows: number;
  /** t3o-owned tables still sitting in the file. */
  readonly t3oTables: ReadonlyArray<string>;
}

export const isUpstreamLegible = (report: UpstreamLegibilityReport): boolean =>
  report.illegibleEventRows === 0 &&
  report.illegibleReceiptRows === 0 &&
  report.t3oTables.length === 0;

/** A one-line explanation of what would break, or why nothing would. */
export const describeUpstreamLegibility = (report: UpstreamLegibilityReport): string =>
  isUpstreamLegible(report)
    ? "legible to stock t3code"
    : [
        `${report.illegibleEventRows} undecodable event row(s)`,
        report.illegibleEventTypes.length > 0
          ? `types [${report.illegibleEventTypes.join(", ")}]`
          : undefined,
        report.illegibleAggregateKinds.length > 0
          ? `kinds [${report.illegibleAggregateKinds.join(", ")}]`
          : undefined,
        report.illegibleReceiptRows > 0
          ? `${report.illegibleReceiptRows} board command receipt(s)`
          : undefined,
        report.t3oTables.length > 0 ? `tables [${report.t3oTables.join(", ")}]` : undefined,
      ]
        .filter((part) => part !== undefined)
        .join("; ");

/**
 * Read the report from the database on the current `SqlClient`.
 *
 * Event types and aggregate kinds are grouped in SQL and filtered in JS: the
 * DISTINCT sets are tiny (tens of values) regardless of log size, and pushing a
 * literal set into the query would have to be regenerated every time the unions
 * move — the exact rot this module is built to avoid.
 */
export const readUpstreamLegibility = Effect.fn("readUpstreamLegibility")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const eventRows = yield* sql<{
    readonly eventType: string;
    readonly aggregateKind: string;
    readonly count: number;
  }>`
    SELECT event_type AS "eventType", aggregate_kind AS "aggregateKind", COUNT(*) AS "count"
    FROM main.orchestration_events
    GROUP BY event_type, aggregate_kind
  `;

  const illegible = eventRows.filter(
    (row) =>
      !UPSTREAM_EVENT_TYPES.has(row.eventType) || !UPSTREAM_AGGREGATE_KINDS.has(row.aggregateKind),
  );

  const receiptRows = yield* sql<{ readonly aggregateKind: string; readonly count: number }>`
    SELECT aggregate_kind AS "aggregateKind", COUNT(*) AS "count"
    FROM main.orchestration_command_receipts
    GROUP BY aggregate_kind
  `;

  // Tables t3o owns. Inert to upstream (it never selects from them), but their
  // presence still means the file has not been cleanly separated. A substr
  // prefix test rather than LIKE: `_` is a LIKE wildcard, and escaping it
  // through a JS template literal is a trap not worth setting.
  const tableRows = yield* sql<{ readonly name: string }>`
    SELECT name FROM main.sqlite_master
    WHERE type = 'table'
      AND (substr(name, 1, 6) = 'board_' OR name = 't3o_sql_migrations')
    ORDER BY name
  `;

  return {
    illegibleEventRows: illegible.reduce((total, row) => total + row.count, 0),
    illegibleEventTypes: [...new Set(illegible.map((row) => row.eventType))].sort(),
    illegibleAggregateKinds: [
      ...new Set(
        illegible
          .map((row) => row.aggregateKind)
          .filter((kind) => !UPSTREAM_AGGREGATE_KINDS.has(kind)),
      ),
    ].sort(),
    illegibleReceiptRows: receiptRows
      .filter((row) => !UPSTREAM_AGGREGATE_KINDS.has(row.aggregateKind))
      .reduce((total, row) => total + row.count, 0),
    t3oTables: tableRows.map((row) => row.name),
  } satisfies UpstreamLegibilityReport;
});
