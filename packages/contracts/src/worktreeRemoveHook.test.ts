/**
 * T3O-23: the `runOnWorktreeRemove` flag and the reclaim's `hookWarning`.
 * Both are new optional fields on data already stored, so what matters is
 * that the new shape round-trips and the old shape still decodes.
 */
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { BoardCardWorktreeReclaimedPayload, BoardCardActivityPayload } from "./board.ts";
import { ProjectScript } from "./orchestration.ts";
import { T3ProjectFile } from "./t3ProjectFile.ts";

const legacyCard = {
  id: "card-1",
  key: "T3-1",
  cardNumber: 1,
  projectId: "project-1",
  labels: [],
  stage: "done",
  orderKey: "m",
  title: "Card",
  briefRef: null,
  dependsOn: [],
  parentCardId: null,
  threadLinks: [],
  attachments: [],
  externalRef: null,
  blocked: false,
  archivedAt: null,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
};

describe("runOnWorktreeRemove", () => {
  it("decodes from t3.json", () => {
    const file = Schema.decodeUnknownSync(T3ProjectFile)({
      scripts: [{ name: "Park caches", command: "./park.sh", runOnWorktreeRemove: true }],
    });
    expect(file.scripts?.[0]?.runOnWorktreeRemove).toBe(true);
  });

  it("round-trips on a stored script, and a script stored without it still decodes", () => {
    const decode = Schema.decodeUnknownSync(ProjectScript);
    const encode = Schema.encodeSync(ProjectScript);
    const stored = {
      id: "park",
      name: "Park caches",
      command: "./park.sh",
      icon: "play",
      runOnWorktreeCreate: false,
    };
    expect(decode(stored).runOnWorktreeRemove).toBeUndefined();
    const flagged = decode({ ...stored, runOnWorktreeRemove: true });
    expect(decode(encode(flagged)).runOnWorktreeRemove).toBe(true);
  });
});

describe("hookWarning on a reclaimed worktree", () => {
  const decode = Schema.decodeUnknownSync(BoardCardWorktreeReclaimedPayload);
  const encode = Schema.encodeSync(BoardCardWorktreeReclaimedPayload);

  it("round-trips through the event payload", () => {
    const payload = decode({
      cardId: "card-1",
      outcome: "removed",
      reason: null,
      forced: false,
      reasonChanged: false,
      hookWarning: 'Remove script "park" exited with code 1',
      card: legacyCard,
    });
    expect(decode(encode(payload)).hookWarning).toBe('Remove script "park" exited with code 1');
  });

  it("is absent from an event written before it existed", () => {
    const payload = decode({
      cardId: "card-1",
      outcome: "removed",
      reason: null,
      card: legacyCard,
    });
    expect(payload.hookWarning).toBeUndefined();
  });

  it("rides the activity row", () => {
    const row = Schema.decodeUnknownSync(BoardCardActivityPayload)({
      hookWarning: "Remove script timed out",
    });
    expect(row.hookWarning).toBe("Remove script timed out");
  });
});
