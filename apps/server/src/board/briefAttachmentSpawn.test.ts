// @effect-diagnostics nodeBuiltinImport:off
/**
 * The one push (t3o-32, K4): a plan-mode or build-mode spawn carries the
 * brief's images natively on its first turn, staged as fresh pending uploads;
 * non-image files never ride a turn (they are pulled by path instead).
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
          const turn = dispatched.find((command) => command.type === "thread.turn.start");
          assert.isDefined(turn, "the planning step's first turn was dispatched");
          if (turn?.type !== "thread.turn.start") return;
          const attachments = turn.message.attachments;
          assert.strictEqual(attachments.length, 1, "images only, files stay on disk");
          const [only] = attachments;
          assert.strictEqual(only?.type, "image");
          assert.strictEqual(only?.name, "bug.png");
          assert.match(String(only?.id), /^pending-/);
          // The staged copy is a real pending upload in upstream's directory,
          // so the Normalizer will claim it into thread scope untouched.
          assert.isTrue(
            NodeFS.existsSync(NodePath.join(storage.stateDir, "attachments", `${only?.id}.png`)),
          );
        }),
    );
    NodeFS.rmSync(storage.baseDir, { recursive: true, force: true });
  }),
);

it.effect("a card with only non-image files spawns with no attachments", () =>
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
          const turn = (yield* commands).find((command) => command.type === "thread.turn.start");
          assert.isDefined(turn);
          if (turn?.type !== "thread.turn.start") return;
          assert.deepStrictEqual(turn.message.attachments, []);
        }),
    );
    NodeFS.rmSync(storage.baseDir, { recursive: true, force: true });
  }),
);
