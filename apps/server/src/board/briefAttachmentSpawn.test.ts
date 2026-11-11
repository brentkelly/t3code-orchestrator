// @effect-diagnostics nodeBuiltinImport:off
/**
 * The one push (t3o-32, K4): a plan-mode or build-mode spawn carries the
 * brief's attachments on its first turn, staged as fresh pending uploads —
 * images natively, everything else as files (T3O-74).
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  BoardCardAttachmentId,
  BoardCardId,
  type BoardCard,
  type BoardCardAttachment,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layerTest } from "../config.ts";
import {
  cardMoved,
  codexStep,
  makeBoardCard,
  NOW,
  settingsWith,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const cardId = BoardCardId.make("card-1");

const image: BoardCardAttachment = {
  id: BoardCardAttachmentId.make("att-image"),
  name: "bug.png",
  type: "image",
  mimeType: "image/png",
  sizeBytes: 3,
  addedAt: NOW,
};
const document: BoardCardAttachment = {
  ...image,
  id: BoardCardAttachmentId.make("att-doc"),
  name: "spec.pdf",
  type: "file",
  mimeType: "application/pdf",
};

const cardWith = (stage: string, attachments: ReadonlyArray<BoardCardAttachment>): BoardCard => ({
  ...makeBoardCard({ id: "card-1", stage, orderKey: "m" }),
  attachments,
});

// The fixture card already sits in Planning: the reactor resolves the card
// from the live model at admit time (in production the projection lands the
// move first), and the harness does not re-project a move event.

/** A throwaway base dir with the card's files already in board storage. */
function seedStorage(files: ReadonlyArray<string>) {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-brief-spawn-"));
  const stateDir = NodePath.join(baseDir, "userdata");
  const folder = NodePath.join(stateDir, "board", "attachments", String(cardId));
  NodeFS.mkdirSync(folder, { recursive: true });
  NodeFS.mkdirSync(NodePath.join(stateDir, "attachments"), { recursive: true });
  for (const name of files) NodeFS.writeFileSync(NodePath.join(folder, name), "png");
  // `layerTest` derives paths through the platform services; the harness
  // wants a self-contained config layer.
  const serverConfig = layerTest(process.cwd(), baseDir).pipe(
    Layer.provide(NodeServices.layer),
    Layer.orDie,
  );
  return { baseDir, stateDir, serverConfig };
}

it.effect("a planning spawn carries the brief's images as pending uploads", () =>
  Effect.gen(function* () {
    const storage = seedStorage(["bug.png", "spec.pdf"]);
    yield* withGovernor(
      {
        board: { cards: [cardWith("planning", [document, image])], nextCardNumberByProject: {} },
        settings: settingsWith({
          building: [codexStep],
          planning: codexStep,
          globalMaxConcurrent: 3,
        }),
        serverConfig: storage.serverConfig,
      },
      ({ pumpDomain, commands }) =>
        Effect.gen(function* () {
          yield* pumpDomain(
            cardMoved(cardWith("planning", [document, image]), "sprint", "planning", 1),
          );
          const dispatched = yield* commands;
          const spawn = dispatched.find((command) => command.type === "thread.spawn");
          assert.isDefined(
            spawn,
            "the planning step's spawn (and so its first turn) was dispatched",
          );
          if (spawn?.type !== "thread.spawn") return;
          const attachments = spawn.attachments;
          assert.deepStrictEqual(
            attachments.map((attachment) => [attachment.type, attachment.name]),
            [
              ["file", "spec.pdf"],
              ["image", "bug.png"],
            ],
          );
          const [pdf, png] = attachments;
          assert.match(String(png?.id), /^pending-/);
          // The gateway has claimed its own copies by the time the spawn
          // returns, so the staged pending sources are gone, not left to the sweep.
          assert.isFalse(
            NodeFS.existsSync(NodePath.join(storage.stateDir, "attachments", `${png?.id}.png`)),
          );
          assert.isFalse(
            NodeFS.existsSync(NodePath.join(storage.stateDir, "attachments", `${pdf?.id}.pdf`)),
          );
        }),
    );
    NodeFS.rmSync(storage.baseDir, { recursive: true, force: true });
  }),
);

it.effect("a card with only non-image files spawns with them as files", () =>
  Effect.gen(function* () {
    const storage = seedStorage(["spec.pdf"]);
    yield* withGovernor(
      {
        board: { cards: [cardWith("planning", [document])], nextCardNumberByProject: {} },
        settings: settingsWith({
          building: [codexStep],
          planning: codexStep,
          globalMaxConcurrent: 3,
        }),
        serverConfig: storage.serverConfig,
      },
      ({ pumpDomain, commands }) =>
        Effect.gen(function* () {
          yield* pumpDomain(cardMoved(cardWith("planning", [document]), "sprint", "planning", 1));
          const spawn = (yield* commands).find((command) => command.type === "thread.spawn");
          assert.isDefined(spawn);
          if (spawn?.type !== "thread.spawn") return;
          assert.deepStrictEqual(
            spawn.attachments.map((attachment) => [attachment.type, attachment.name]),
            [["file", "spec.pdf"]],
          );
        }),
    );
    NodeFS.rmSync(storage.baseDir, { recursive: true, force: true });
  }),
);

it.effect("a spawn refused as provider-disabled leaves no staged copies behind", () =>
  Effect.gen(function* () {
    const storage = seedStorage(["spec.pdf"]);
    yield* withGovernor(
      {
        board: { cards: [cardWith("planning", [document])], nextCardNumberByProject: {} },
        settings: settingsWith({
          building: [codexStep],
          planning: codexStep,
          globalMaxConcurrent: 3,
        }),
        serverConfig: storage.serverConfig,
        providerDisabled: [codexStep.providerInstanceId],
      },
      ({ pumpDomain }) =>
        Effect.gen(function* () {
          yield* pumpDomain(cardMoved(cardWith("planning", [document]), "sprint", "planning", 1));
          assert.deepStrictEqual(
            NodeFS.readdirSync(NodePath.join(storage.stateDir, "attachments")),
            [],
          );
        }),
    );
    NodeFS.rmSync(storage.baseDir, { recursive: true, force: true });
  }),
);
