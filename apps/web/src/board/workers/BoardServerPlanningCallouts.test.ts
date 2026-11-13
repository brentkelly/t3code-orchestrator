import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardServerPlanningCallouts } from "./BoardServerPlanningCallouts";

const app = ProjectId.make("project-app");
const api = ProjectId.make("project-api");

describe("the board server's planning callouts (T3O-87)", () => {
  it("counts the cards waiting on each project's problem, and nothing else", () => {
    const callouts = boardServerPlanningCallouts([
      { projectId: app, queuedBy: "server-checkout", queuedDetail: { serverCheckout: "missing" } },
      { projectId: app, queuedBy: "server-checkout", queuedDetail: { serverCheckout: "missing" } },
      {
        projectId: api,
        queuedBy: "server-sign-in",
        queuedDetail: { providerInstanceId: "claude" },
      },
      { projectId: api, queuedBy: "capacity", queuedDetail: {} },
      { projectId: api },
    ]);
    expect(callouts).toEqual([
      { projectId: app, kind: "server-checkout", missing: true, provider: null, waiting: 2 },
      { projectId: api, kind: "server-sign-in", missing: false, provider: "claude", waiting: 1 },
    ]);
  });

  it("shows nothing when no card waits on the board server", () => {
    expect(boardServerPlanningCallouts([{ projectId: app, queuedBy: "quota" }])).toEqual([]);
  });
});
