import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectId } from "./baseSchemas.ts";
import { BOARD_WORKER_GIT_RPCS, BOARD_WORKER_GIT_WS_METHODS } from "./boardWorkspace.ts";

const projectId = ProjectId.make("project-1");
const payloadOf = (method: string) =>
  BOARD_WORKER_GIT_RPCS.find((rpc) => rpc._tag === method)!.payloadSchema;
const accepts = (method: string, payload: object) =>
  Schema.decodeUnknownExit(payloadOf(method) as Schema.Decoder<unknown>)({ projectId, ...payload })
    ._tag === "Success";

describe("boardWorker.git payloads", () => {
  it("refuse a branch git would read as an option or reject as a ref", () => {
    const method = BOARD_WORKER_GIT_WS_METHODS.measureBaseTip;
    expect(accepts(method, { baseRefName: "main" })).toBe(true);
    expect(accepts(method, { baseRefName: "board/t3o-60" })).toBe(true);
    for (const bad of [
      "-D",
      "--mirror",
      "a..b",
      "a b",
      "a~1",
      "x:y",
      "a.lock",
      "/a",
      "a//b",
      "@{u}",
    ]) {
      expect(accepts(method, { baseRefName: bad }), bad).toBe(false);
    }
  });

  it("only create, push or delete a board/ branch", () => {
    const {
      provisionWorktree,
      provisionWorktreeFromRemoteBranch,
      createIntegrationBranch,
      deleteCardBranch,
    } = BOARD_WORKER_GIT_WS_METHODS;
    for (const method of [provisionWorktree, provisionWorktreeFromRemoteBranch]) {
      expect(accepts(method, { branch: "board/t3o-1", baseRefName: "main" })).toBe(true);
      expect(accepts(method, { branch: "main", baseRefName: "main" })).toBe(false);
    }
    expect(accepts(createIntegrationBranch, { branch: "board/t3o-1", base: "main" })).toBe(true);
    expect(accepts(createIntegrationBranch, { branch: "main", base: "main" })).toBe(false);
    expect(accepts(deleteCardBranch, { branch: "board/t3o-1" })).toBe(true);
    expect(accepts(deleteCardBranch, { branch: "main" })).toBe(false);
    expect(accepts(deleteCardBranch, { branch: "-D" })).toBe(false);
  });
});
