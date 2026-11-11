// @effect-diagnostics nodeBuiltinImport:off
/**
 * Brief attachment storage: names, paths, the claim from a pending
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
  pendingBriefAttachment,
  sanitizeBoardAttachmentName,
  selectBriefAttachmentsForTurn,
  spawnPushesBriefAttachments,
  discardStagedBriefAttachments,
  stageBriefAttachmentsAsPending,
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
  group: null,
  threadLinks: [],
  attachments,
  externalRef: null,
  humanInLoop: null,
  reviewOverrides: null,
  modelOverrides: null,
  splitRationale: null,
  baseBranch: null,
  scheduledStartAt: null,
  autoPlanSetting: null,
  autoBuildSetting: null,
  autoMergeSetting: null,
  autoMergeHold: null,
  mergeStrategy: null,
  pinnedWorkerId: null,
  placedWorkerId: null,
  workerMove: null,
  placementOrphaned: null,
  ci: null,
  ciLastOutcome: null,
  ciRoundTrips: 0,
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
    // A path contributes its basename only.
    expect(sanitizeBoardAttachmentName({ name: "a/b\\c d.pdf", type: "file", mimeType: "x" })).toBe(
      "c d.pdf",
    );
  });

  it("gives a nameless pasted screenshot a typed placeholder", () => {
    expect(sanitizeBoardAttachmentName({ name: "", type: "image", mimeType: "image/png" })).toBe(
      "image.png",
    );
    expect(sanitizeBoardAttachmentName({ name: "", type: "file", mimeType: "x" })).toBe("file");
  });

  it("keeps a generic file's own name, extension or not, dotfiles included", () => {
    const file = (name: string) =>
      sanitizeBoardAttachmentName({ name, type: "file", mimeType: "x" });
    expect(file("Makefile")).toBe("Makefile");
    expect(file(".env")).toBe(".env");
    expect(file("../../.env")).toBe(".env");
    expect(file("notes.md")).toBe("notes.md");
    expect(file("...")).toBe("file");
  });

  it("bounds the name in bytes and keeps the extension", () => {
    const long = sanitizeBoardAttachmentName({
      name: `${"漢".repeat(120)}.md`,
      type: "file",
      mimeType: "x",
    });
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(200);
    expect(long.endsWith(".md")).toBe(true);
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
        attachmentId: BoardCardAttachmentId.make("att-first"),
        name: "Bug screenshot.png",
        type: "image",
        mimeType: "image/PNG",
        sizeBytes: 9,
        addedAt: NOW,
      });
      assert.strictEqual(stored.name, "Bug screenshot.png");
      assert.strictEqual(stored.id, "att-first");
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
        attachmentId: BoardCardAttachmentId.make("att-second"),
        name: "Bug screenshot.png",
        type: "image",
        mimeType: "image/png",
        sizeBytes: 9,
        addedAt: NOW,
      });
      assert.strictEqual(second.name, "Bug screenshot-2.png");

      // Racing attaches that read the same (stale) record list land beside
      // each other, never on top: the name is claimed with an exclusive
      // create, so the filesystem decides the collision.
      const racers = yield* Effect.forEach(
        ["A", "B", "C"],
        (marker) => {
          const pendingId = createPendingAttachmentId();
          NodeFS.writeFileSync(
            NodePath.join(attachmentsDir, `${pendingId}.png`),
            `png-bytes-${marker}`,
          );
          return claimBoardCardAttachment({
            stateDir,
            attachmentsDir,
            card: card([stored]),
            pendingAttachmentId: pendingId,
            attachmentId: BoardCardAttachmentId.make(`att-racer-${marker}`),
            name: "Bug screenshot.png",
            type: "image",
            mimeType: "image/png",
            sizeBytes: 11,
            addedAt: NOW,
          });
        },
        { concurrency: "unbounded" },
      );
      // `-2` is already on disk from the claim above (the racers' stale record
      // list does not know it), so the exclusive create walks past it.
      const names = racers.map((racer) => racer.name).sort();
      assert.deepStrictEqual(names, [
        "Bug screenshot-3.png",
        "Bug screenshot-4.png",
        "Bug screenshot-5.png",
      ]);
      // Every file holds its own bytes — nothing was overwritten.
      const folder = NodePath.join(stateDir, "board", "attachments", String(cardId));
      const contents = names.map((name) =>
        NodeFS.readFileSync(NodePath.join(folder, name), "utf8"),
      );
      assert.deepStrictEqual(new Set(contents).size, 3);

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
        attachmentId: BoardCardAttachmentId.make("att-x"),
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
      // An image over upstream's image cap is refused even though the file
      // mint would have accepted the bytes.
      const bigImage = yield* Effect.flip(
        claimBoardCardAttachment({
          ...base,
          pendingAttachmentId: pendingId,
          type: "image",
          mimeType: "image/png",
          sizeBytes: 10 * 1024 * 1024 + 1,
        }),
      );
      assert.include(bigImage.failure.message, "limited to");
      // A record type that disagrees with the bytes' mime is refused too.
      NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${pendingId}.pdf`), "abc");
      const wrongType = yield* Effect.flip(
        claimBoardCardAttachment({ ...base, pendingAttachmentId: pendingId, type: "image" }),
      );
      assert.include(wrongType.failure.message, "does not match its content type");
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("the one push (K4)", () => {
  it("reaches the build and planning spawns only", () => {
    expect(spawnPushesBriefAttachments("build")).toBe(true);
    expect(spawnPushesBriefAttachments("plan")).toBe(true);
    for (const role of ["review", "merge", "done", "backlog", "sprint", "ready", null]) {
      expect(spawnPushesBriefAttachments(role)).toBe(false);
    }
  });

  it("selects, in brief order, what fits one turn under upstream's caps", () => {
    const MiB = 1024 * 1024;
    const png = (name: string, sizeBytes: number) => ({
      name,
      type: "image" as const,
      mimeType: "image/png",
      sizeBytes,
    });
    const file = (name: string, sizeBytes: number, mimeType = "application/pdf") => ({
      name,
      type: "file" as const,
      mimeType,
      sizeBytes,
    });
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly input: ReadonlyArray<ReturnType<typeof png> | ReturnType<typeof file>>;
      readonly expected: ReadonlyArray<string>;
    }> = [
      {
        label: "every type, in brief order",
        input: [file("spec.pdf", 10), png("bug.png", 10), file("notes.txt", 5, "text/plain")],
        expected: ["spec.pdf", "bug.png", "notes.txt"],
      },
      { label: "an empty file", input: [file("empty.txt", 0)], expected: [] },
      {
        label: "an image over the image cap",
        input: [png("huge.png", 10 * MiB + 1), png("ok.png", 10 * MiB)],
        expected: ["ok.png"],
      },
      {
        label: "a file over the file cap",
        input: [file("huge.pdf", 50 * MiB + 1), file("ok.pdf", 50 * MiB)],
        expected: ["ok.pdf"],
      },
      {
        // Upstream's 80 MiB image total counts image-mime files too.
        label: "images past the image total, later smaller ones still fit",
        input: [
          ...Array.from({ length: 8 }, (_, index) => png(`${index}.png`, 10 * MiB)),
          png("over.png", 1),
          file("image-mime.png", 1, "image/png"),
          file("spec.pdf", 1),
        ],
        expected: [...Array.from({ length: 8 }, (_, index) => `${index}.png`), "spec.pdf"],
      },
      {
        label: "past the per-turn file count",
        input: Array.from({ length: 101 }, (_, index) => file(`${index}.txt`, 1, "text/plain")),
        expected: Array.from({ length: 100 }, (_, index) => `${index}.txt`),
      },
      {
        // An unsupported image goes as a file, under the file cap.
        label: "an unsupported image mime sent as a file",
        input: [{ ...png("scan.bmp", 20 * MiB), mimeType: "image/bmp" }],
        expected: ["scan.bmp"],
      },
    ];
    for (const { label, input, expected } of cases) {
      assert.deepStrictEqual(
        selectBriefAttachmentsForTurn(input).map((attachment) => attachment.name),
        expected,
        label,
      );
    }
  });

  it("names a pending file the way upstream's claim resolves it", () => {
    const svg = pendingBriefAttachment({
      type: "image",
      name: "diagram",
      mimeType: "image/svg+xml",
      sizeBytes: 3,
    });
    assert.strictEqual(svg.attachment.type, "file");
    assert.strictEqual(svg.attachment.name, "diagram.svg");
    assert.match(String(svg.attachment.id), /^pending-[0-9a-f-]+-svg$/);
    assert.strictEqual(svg.fileName, `${svg.attachment.id}.svg`);
    const bmp = pendingBriefAttachment({
      type: "image",
      name: "scan.bmp",
      mimeType: "image/bmp",
      sizeBytes: 3,
    });
    assert.strictEqual(bmp.attachment.type, "file");
    assert.strictEqual(bmp.fileName, `${bmp.attachment.id}.bmp`);
  });

  it.effect("stages every attachment type as fresh pending uploads", () =>
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
      const staged = yield* stageBriefAttachmentsAsPending({
        stateDir,
        attachmentsDir,
        card: card([file, image]),
      });
      assert.strictEqual(staged.length, 2);
      const [pdf, png] = staged;
      assert.strictEqual(pdf?.type, "file");
      assert.strictEqual(pdf?.name, "spec.pdf");
      assert.match(String(pdf?.id), /^pending-[0-9a-f-]+-pdf$/);
      assert.strictEqual(
        NodeFS.readFileSync(NodePath.join(attachmentsDir, `${pdf?.id}.pdf`), "utf8"),
        "pdf",
      );
      assert.strictEqual(png?.type, "image");
      assert.strictEqual(png?.name, "bug.png");
      assert.match(String(png?.id), /^pending-[0-9a-f-]+$/);
      assert.strictEqual(
        NodeFS.readFileSync(NodePath.join(attachmentsDir, `${png?.id}.png`), "utf8"),
        "png",
      );
      yield* discardStagedBriefAttachments({ attachmentsDir, attachments: staged });
      assert.deepStrictEqual(NodeFS.readdirSync(attachmentsDir), []);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
