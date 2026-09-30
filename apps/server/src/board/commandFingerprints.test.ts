import { CommandId, ProjectId, type OrchestrationCommand } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { commandFingerprint } from "./commandFingerprints.ts";

const base = {
  type: "project.create",
  commandId: CommandId.make("cmd-a"),
  projectId: ProjectId.make("project-a"),
  title: "A",
  workspaceRoot: "/tmp/a",
  createdAt: "2026-01-01T00:00:00.000Z",
} as const satisfies OrchestrationCommand;

describe("commandFingerprint", () => {
  it("ignores commandId, createdAt and key order", () => {
    const reordered = {
      createdAt: "2026-02-02T00:00:00.000Z",
      workspaceRoot: "/tmp/a",
      title: "A",
      projectId: base.projectId,
      commandId: CommandId.make("cmd-b"),
      type: "project.create",
    } as const satisfies OrchestrationCommand;
    expect(commandFingerprint(reordered)).toEqual(commandFingerprint(base));
  });

  it("changes with the payload", () => {
    expect(commandFingerprint({ ...base, title: "B" }).payloadHash).not.toBe(
      commandFingerprint(base).payloadHash,
    );
  });

  it("treats an undefined member as absent", () => {
    expect(commandFingerprint({ ...base, defaultModelSelection: undefined })).toEqual(
      commandFingerprint(base),
    );
  });
});
