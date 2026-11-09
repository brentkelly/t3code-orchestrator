import { BoardCardId, CommandId, ProjectId, type BoardCommand } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { commandFingerprint } from "./commandFingerprints.ts";

const base = {
  type: "board.card.create",
  commandId: CommandId.make("cmd-a"),
  cardId: BoardCardId.make("card-a"),
  projectId: ProjectId.make("project-a"),
  title: "A",
  createdAt: "2026-01-01T00:00:00.000Z",
} as const satisfies BoardCommand;

describe("commandFingerprint", () => {
  it("ignores commandId, createdAt and key order", () => {
    const reordered = {
      createdAt: "2026-02-02T00:00:00.000Z",
      title: "A",
      projectId: base.projectId,
      cardId: base.cardId,
      commandId: CommandId.make("cmd-b"),
      type: "board.card.create",
    } as const satisfies BoardCommand;
    expect(commandFingerprint(reordered)).toEqual(commandFingerprint(base));
  });

  it("changes with the payload", () => {
    expect(commandFingerprint({ ...base, title: "B" }).payloadHash).not.toBe(
      commandFingerprint(base).payloadHash,
    );
  });

  it("treats an undefined member as absent", () => {
    expect(commandFingerprint({ ...base, brief: undefined })).toEqual(commandFingerprint(base));
  });
});
