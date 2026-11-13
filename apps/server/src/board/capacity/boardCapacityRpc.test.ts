import { assert, it } from "@effect/vitest";

import type { BoardWorkerId } from "@t3tools/contracts";

import { boardCardsHeldOnWorker, boardPinReadinessRefusal } from "./boardCapacityRpc.ts";

it("a worker that isn't ready for a project can't be chosen as that project's pin", () => {
  const snapshot = (state: string) => ({
    readiness: [{ repositoryKey: "github.com/acme/app", state }],
  });
  assert.include(
    boardPinReadinessRefusal(snapshot("not-ready"), "github.com/acme/app", "build-01") ?? "",
    "build-01 isn't ready for this project yet (not-ready)",
  );
  assert.isNotNull(boardPinReadinessRefusal(snapshot("not-set-up"), "github.com/acme/app", "b"));
  assert.isNull(boardPinReadinessRefusal(snapshot("ready"), "github.com/acme/app", "b"));
  // Not reported yet (an offline worker, or a project it was never asked about): no refusal.
  assert.isNull(boardPinReadinessRefusal(snapshot("not-ready"), "github.com/other/repo", "b"));
  assert.isNull(boardPinReadinessRefusal(null, "github.com/acme/app", "b"));
});

it("counts what this board's placed cards hold on a worker, CPU and RAM only while heavy", () => {
  const card = (
    id: string,
    placedWorkerId: string,
    heavy: boolean,
    status: "ready" | "removed" = "ready",
  ) =>
    ({
      id,
      worktree: { status },
      pinnedWorkerId: null,
      placedWorkerId,
      archivedAt: null,
      resources: {
        sizing: null,
        grant: {
          profile: { cpuCores: 4, ramGiB: 8, diskGB: 10 },
          heavy,
          claimId: null,
          grantedAt: "2026-11-13T00:00:00.000Z",
          settled: true,
        },
        setup: null,
      },
    }) as unknown as Parameters<typeof boardCardsHeldOnWorker>[0][number];
  const cards = [
    card("heavy", "build-01", true),
    card("light", "build-01", false),
    card("running", "build-01", false),
    card("elsewhere", "build-02", true),
    card("gone", "build-01", true, "removed"),
  ];
  assert.deepStrictEqual(boardCardsHeldOnWorker(cards, "build-01" as BoardWorkerId, ["running"]), {
    cpuCores: 8,
    ramGiB: 16,
    diskGB: 30,
  });
});
