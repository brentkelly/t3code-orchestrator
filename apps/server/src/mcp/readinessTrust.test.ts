/**
 * T3o (T3O-124): trusting a project's readiness script is the board owner's call alone. A
 * committed hostile change could otherwise ask an agent to switch it on, so no MCP tool may take
 * the setting, or the readiness checks, as input.
 */
import { assert, it } from "@effect/vitest";
import type { Tool } from "effect/ai";

import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";
import * as AttachmentTools from "./toolkits/attachment/tools.ts";
import * as BoardTools from "./toolkits/board/tools.ts";
import * as DeviceTools from "./toolkits/device/tools.ts";
import * as EnvironmentTools from "./toolkits/environment/tools.ts";
import * as HtmlTools from "./toolkits/html/tools.ts";
import * as OrchestratorTools from "./toolkits/orchestrator/tools.ts";
import * as PreviewTools from "./toolkits/preview/tools.ts";
import * as PreviewControlsTools from "./toolkits/previewControls/tools.ts";
import * as ProjectTools from "./toolkits/project/tools.ts";
import * as PullRequestsTools from "./toolkits/pullRequests/tools.ts";
import * as ThreadTools from "./toolkits/thread/tools.ts";
import * as WorktreeTools from "./toolkits/worktree/tools.ts";

const toolkitModules: ReadonlyArray<Record<string, unknown>> = [
  AttachmentTools,
  BoardTools,
  DeviceTools,
  EnvironmentTools,
  HtmlTools,
  OrchestratorTools,
  PreviewTools,
  PreviewControlsTools,
  ProjectTools,
  PullRequestsTools,
  ThreadTools,
  WorktreeTools,
];

it("no MCP tool can set a project's readiness trust or checks", () => {
  const tools = toolkitModules
    .flatMap((module) => Object.values(module))
    .filter(
      (value): value is { readonly tools: Record<string, Tool.Any> } =>
        (typeof value === "object" || typeof value === "function") &&
        value !== null &&
        "~effect/ai/Toolkit" in value,
    )
    .flatMap((toolkit) => Object.values(toolkit.tools));
  assert.isAbove(tools.length, 20);
  for (const tool of tools) {
    const schema = JSON.stringify(advertisedJsonSchema(tool));
    assert.notInclude(schema, "trustReadinessScript", tool.name);
    assert.notInclude(schema, "readinessChecks", tool.name);
  }
});
