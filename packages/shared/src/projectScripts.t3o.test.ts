import { describe, expect, it } from "vite-plus/test";

import { projectScriptMenuLabel } from "./projectScripts.ts";

// T3O-23: setup and remove scripts are both marked in the menu.
describe("projectScriptMenuLabel", () => {
  const script = {
    id: "s",
    name: "Park caches",
    command: "./park.sh",
    icon: "play" as const,
    runOnWorktreeCreate: false,
  };

  it("marks setup and remove scripts", () => {
    expect(projectScriptMenuLabel(script)).toBe("Park caches");
    expect(projectScriptMenuLabel({ ...script, runOnWorktreeCreate: true })).toBe(
      "Park caches (setup)",
    );
    expect(projectScriptMenuLabel({ ...script, runOnWorktreeRemove: true })).toBe(
      "Park caches (teardown)",
    );
    expect(
      projectScriptMenuLabel({ ...script, runOnWorktreeCreate: true, runOnWorktreeRemove: true }),
    ).toBe("Park caches (setup, teardown)");
  });
});
