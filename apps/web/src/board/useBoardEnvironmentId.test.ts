/**
 * Which server's board a device shows (T3O-71). The rule that matters: a nominated board server
 * that can't be reached is reported, never silently swapped for the primary — the primary's board
 * is a different board, and showing it would look like every card had vanished.
 */
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardServerOptions } from "./BoardServerSettings";
import { resolveBoardEnvironment, type BoardEnvironmentCandidate } from "./useBoardEnvironmentId";

const local = EnvironmentId.make("env-local");
const central = EnvironmentId.make("env-central");
const removed = EnvironmentId.make("env-removed");

const candidate = (
  overrides: Partial<BoardEnvironmentCandidate> = {},
): BoardEnvironmentCandidate => ({
  label: "Central",
  enabled: true,
  phase: "connected",
  ...overrides,
});

describe("resolveBoardEnvironment", () => {
  it("shows the primary environment's board when nothing is nominated", () => {
    expect(
      resolveBoardEnvironment({ nominated: null, primary: local, candidates: new Map() }),
    ).toEqual({ kind: "ready", environmentId: local, nominated: false });
  });

  it("has nothing to show with no nomination and no primary", () => {
    expect(
      resolveBoardEnvironment({ nominated: null, primary: null, candidates: new Map() }),
    ).toEqual({ kind: "none" });
  });

  it("treats nominating the primary itself as the default", () => {
    expect(
      resolveBoardEnvironment({ nominated: local, primary: local, candidates: new Map() }),
    ).toEqual({ kind: "ready", environmentId: local, nominated: false });
  });

  it("shows a nominated server that is connected, or on its way to being connected", () => {
    for (const phase of ["connected", "connecting", "reconnecting", "available"] as const) {
      expect(
        resolveBoardEnvironment({
          nominated: central,
          primary: local,
          candidates: new Map([[central, candidate({ phase })]]),
        }),
      ).toEqual({ kind: "ready", environmentId: central, nominated: true });
    }
  });

  it("works without a primary, as the hosted app does", () => {
    expect(
      resolveBoardEnvironment({
        nominated: central,
        primary: null,
        candidates: new Map([[central, candidate()]]),
      }),
    ).toEqual({ kind: "ready", environmentId: central, nominated: true });
  });

  it("reports a nominated server that is offline, failed, unsupported or disabled", () => {
    const unreachable: ReadonlyArray<Partial<BoardEnvironmentCandidate>> = [
      { phase: "offline" },
      { phase: "error" },
      { phase: "unsupported" },
      { enabled: false },
    ];
    for (const overrides of unreachable) {
      expect(
        resolveBoardEnvironment({
          nominated: central,
          primary: local,
          candidates: new Map([[central, candidate(overrides)]]),
        }),
      ).toEqual({ kind: "unavailable", environmentId: central, label: "Central" });
    }
  });

  it("reports a nominated server this device no longer knows, without a label", () => {
    expect(
      resolveBoardEnvironment({
        nominated: removed,
        primary: local,
        candidates: new Map([[central, candidate()]]),
      }),
    ).toEqual({ kind: "unavailable", environmentId: removed, label: null });
  });
});

describe("boardServerOptions", () => {
  const environments = [
    { environmentId: local, label: "This machine" },
    { environmentId: central, label: "Central" },
  ];

  it("offers this server first, then every other saved environment", () => {
    expect(boardServerOptions({ primary: local, nominated: null, environments })).toEqual([
      { value: "primary", label: "This server" },
      { value: central, label: "Central" },
    ]);
  });

  it("keeps a removed nomination listed so the select can still name it", () => {
    expect(boardServerOptions({ primary: local, nominated: removed, environments })).toEqual([
      { value: "primary", label: "This server" },
      { value: central, label: "Central" },
      { value: removed, label: "Removed connection" },
    ]);
  });

  it("offers no 'This server' entry when there is no primary to point at", () => {
    expect(
      boardServerOptions({ primary: null, nominated: central, environments: [environments[1]!] }),
    ).toEqual([{ value: central, label: "Central" }]);
  });
});
