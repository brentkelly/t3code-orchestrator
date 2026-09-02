// @effect-diagnostics nodeBuiltinImport:off
/**
 * Brief attachment storage (t3o-32): names, paths, the claim from a pending
 * upload into the card's folder, the manifest a thread pulls, and the image
 * staging a spawn pushes.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { BoardCardAttachmentId, BoardCardId, ProjectId, type BoardCard } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { createPendingAttachmentId } from "../attachmentStore.ts";
import {
  boardCardAttachmentManifest,
  claimBoardCardAttachment,
  dedupeBoardAttachmentName,
  deleteBoardCardAttachmentFile,
  removeBoardCardAttachmentsDir,
  resolveBoardCardAttachmentPath,
  sanitizeBoardAttachmentName,
  spawnPushesBriefImages,
  stageBoardCardImagesAsPending,
} from "./attachments.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const cardId = BoardCardId.make("card-0b8a2c3d-4e5f-6789-abcd-ef0123456789");

const card = (attachments: BoardCard["attachments"] = []): BoardCard => ({
  id: cardId,
  key: "T3-1",
  cardNumber: 1,
  projectId: ProjectId.make("project-1"),
  labels: [],
  stage: "backlog" as BoardCard["stage"],
  orderKey: "m",
  title: "Card",
  briefRef: null,
  dependsOn: [],
  parentCardId: null,
  sourcePlanId: null,
  threadLinks: [],
  attachments,
  externalRef: null,
  humanInLoop: null,
  reviewOverrides: null,
  modelOverrides: null,
  worktree: null,
  pullRequest: null,
  pullRequestHistory: [],
  pullRequestFloor: null,
  blocked: false,
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const tempRoot = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-brief-attachments-"));

describe("names", () => {
  it("keeps a readable name, drops separators and control characters", () => {
    expect(
      sanitizeBoardAttachmentName({
        name: "../Hire Terms (Draft).docx",
        type: "file",
        mimeType: "x",
      }),
    ).toBe("Hire Terms (Draft).docx");
    expect(sanitizeBoardAttachmentName({ name: "a/b\\c d.pdf", type: "file", mimeType: "x" })).toBe(
      "a b c d.pdf",
    );
  });

  it("gives a nameless pasted screenshot a typed placeholder", () => {
    expect(sanitizeBoardAttachmentName({ name: "", type: "image", mimeType: "image/png" })).toBe(
      "image.png",
    );
    expect(sanitizeBoardAttachmentName({ name: "", type: "file", mimeType: "x" })).toBe("file.bin");
  });

  it("de-duplicates with a numeric suffix before the extension", () => {
    const taken = new Set(["shot.png", "shot-2.png"]);
    expect(dedupeBoardAttachmentName("shot.png", taken)).toBe("shot-3.png");
    expect(dedupeBoardAttachmentName("fresh.png", taken)).toBe("fresh.png");
  });
});

describe("paths", () => {
  it.effect("resolves under the card folder and refuses traversal", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const stateDir = "/state";
      assert.strictEqual(
        resolveBoardCardAttachmentPath({ path, stateDir, cardId, name: "bug.png" }),
        NodePath.join("/state", "board", "attachments", String(cardId), "bug.png"),
      );
      assert.isNull(resolveBoardCardAttachmentPath({ path, stateDir, cardId, name: "../x" }));
      assert.isNull(resolveBoardCardAttachmentPath({ path, stateDir, cardId, name: "a/b" }));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("claim, manifest, delete", () => {
  it.effect("copies a pending upload into the card folder under its original name", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = tempRoot();
      const stateDir = NodePath.join(root, "userdata");
      const attachmentsDir = NodePath.join(stateDir, "attachments");
      NodeFS.mkdirSync(attachmentsDir, { recursive: true });
      const pendingId = createPendingAttachmentId();
      NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${pendingId}.png`), "png-bytes");

      const stored = yield* claimBoardCardAttachment({
        stateDir,
        attachmentsDir,
        card: card(),
        pendingAttachmentId: pendingId,
        name: "Bug screenshot.png",
        type: "image",
        mimeType: "image/PNG",
        sizeBytes: 9,
        addedAt: NOW,
      });
      assert.strictEqual(stored.name, "Bug screenshot.png");
      assert.strictEqual(stored.mimeType, "image/png");
      assert.strictEqual(stored.sizeBytes, 9);
      const expected = NodePath.join(
        stateDir,
        "board",
        "attachments",
        String(cardId),
        "Bug screenshot.png",
      );
      assert.strictEqual(NodeFS.readFileSync(expected, "utf8"), "png-bytes");
      // The pending copy stays for upstream's sweep, as the chat path leaves it.
      assert.isTrue(NodeFS.existsSync(NodePath.join(attachmentsDir, `${pendingId}.png`)));

      // A second file with the same name lands as name-2.
      const pending2 = createPendingAttachmentId();
      NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${pending2}.png`), "png-bytes");
      const second = yield* claimBoardCardAttachment({
        stateDir,
        attachmentsDir,
        card: card([stored]),
        pendingAttachmentId: pending2,
        name: "Bug screenshot.png",
        type: "image",
        mimeType: "image/png",
        sizeBytes: 9,
        addedAt: NOW,
      });
      assert.strictEqual(second.name, "Bug screenshot-2.png");

      const manifest = boardCardAttachmentManifest({
        path,
        stateDir,
        card: card([stored, second]),
      });
      assert.deepStrictEqual(
        manifest.map((entry) => entry.path),
        [expected, expected.replace("Bug screenshot.png", "Bug screenshot-2.png")],
      );

      yield* deleteBoardCardAttachmentFile({ stateDir, cardId, name: stored.name });
      assert.isFalse(NodeFS.existsSync(expected));
      // Deleting a file that is already gone is not an error.
      yield* deleteBoardCardAttachmentFile({ stateDir, cardId, name: stored.name });
      yield* removeBoardCardAttachmentsDir({ stateDir, cardId });
      assert.isFalse(
        NodeFS.existsSync(NodePath.join(stateDir, "board", "attachments", String(cardId))),
      );
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a non-pending id, a missing upload and a size mismatch", () =>
    Effect.gen(function* () {
      const root = tempRoot();
      const stateDir = NodePath.join(root, "userdata");
      const attachmentsDir = NodePath.join(stateDir, "attachments");
      NodeFS.mkdirSync(attachmentsDir, { recursive: true });
      const base = {
        stateDir,
        attachmentsDir,
        card: card(),
        name: "x.pdf",
        type: "file" as const,
        mimeType: "application/pdf",
        sizeBytes: 3,
        addedAt: NOW,
      };
      const notPending = yield* Effect.flip(
        claimBoardCardAttachment({ ...base, pendingAttachmentId: "thread-1-not-a-uuid" }),
      );
      assert.strictEqual(notPending.failure.reason, "rejected");
      const missing = yield* Effect.flip(
        claimBoardCardAttachment({
          ...base,
          pendingAttachmentId: createPendingAttachmentId("pdf"),
        }),
      );
      assert.strictEqual(missing.failure.reason, "upload-missing");
      const pendingId = createPendingAttachmentId("pdf");
      NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${pendingId}.pdf`), "abcd");
      const mismatch = yield* Effect.flip(
        claimBoardCardAttachment({ ...base, pendingAttachmentId: pendingId }),
      );
      assert.strictEqual(mismatch.failure.reason, "rejected");
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("the one push (K4)", () => {
  it("reaches the build and planning spawns only", () => {
    expect(spawnPushesBriefImages("build")).toBe(true);
    expect(spawnPushesBriefImages("plan")).toBe(true);
    for (const role of ["review", "merge", "done", "backlog", "sprint", "ready", null]) {
      expect(spawnPushesBriefImages(role)).toBe(false);
    }
  });

  it.effect("stages the card's images as fresh pending uploads and skips files", () =>
    Effect.gen(function* () {
      const root = tempRoot();
      const stateDir = NodePath.join(root, "userdata");
      const attachmentsDir = NodePath.join(stateDir, "attachments");
      const folder = NodePath.join(stateDir, "board", "attachments", String(cardId));
      NodeFS.mkdirSync(folder, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(folder, "bug.png"), "png");
      NodeFS.writeFileSync(NodePath.join(folder, "spec.pdf"), "pdf");
      const image = {
        id: BoardCardAttachmentId.make("att-image"),
        name: "bug.png",
        type: "image" as const,
        mimeType: "image/png",
        sizeBytes: 3,
        addedAt: NOW,
      };
      const file = {
        ...image,
        id: BoardCardAttachmentId.make("att-file"),
        name: "spec.pdf",
        type: "file" as const,
        mimeType: "application/pdf",
      };
      const staged = yield* stageBoardCardImagesAsPending({
        stateDir,
        attachmentsDir,
        card: card([file, image]),
      });
      assert.strictEqual(staged.length, 1);
      const [only] = staged;
      assert.strictEqual(only?.type, "image");
      assert.strictEqual(only?.name, "bug.png");
      assert.match(String(only?.id), /^pending-/);
      assert.strictEqual(
        NodeFS.readFileSync(NodePath.join(attachmentsDir, `${only?.id}.png`), "utf8"),
        "png",
      );
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
