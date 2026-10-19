/**
 * T3O-23: `runOnWorktreeRemove` survives every step a script goes through on
 * the client — import from `t3.json`, opening it in the editor, and saving it
 * back — and a remove script is never the project's main run button.
 */
import type { ProjectScript, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  editorRequestForScript,
  newProjectScriptInputFromFile,
} from "./components/projectScriptEditor";
import { buildProjectScript, primaryProjectScript } from "./projectScripts";

const noKeybindings = [] as unknown as ResolvedKeybindingsConfig;

const stored = (overrides: Partial<ProjectScript> = {}): ProjectScript => ({
  id: "park",
  name: "Park caches",
  command: "./park.sh",
  icon: "play",
  runOnWorktreeCreate: false,
  ...overrides,
});

describe("runOnWorktreeRemove on the client", () => {
  it("is stored when a t3.json script is imported", () => {
    const input = newProjectScriptInputFromFile({
      name: "Park caches",
      command: "./park.sh",
      runOnWorktreeRemove: true,
    });
    expect(buildProjectScript("park", input)).toEqual(stored({ runOnWorktreeRemove: true }));
  });

  it("is not stored for an imported script that does not set it", () => {
    const input = newProjectScriptInputFromFile({ name: "Park caches", command: "./park.sh" });
    expect(buildProjectScript("park", input)).toEqual(stored());
  });

  it("survives opening the script in the editor and saving it unchanged", () => {
    const script = stored({ runOnWorktreeRemove: true });
    const { initial } = editorRequestForScript(script, noKeybindings);
    expect(initial.runOnWorktreeRemove).toBe(true);
    expect(buildProjectScript(script.id, initial)).toEqual(script);
  });

  it("leaves a script stored before the flag existed unchanged on save", () => {
    const script = stored();
    const { initial } = editorRequestForScript(script, noKeybindings);
    expect(initial.runOnWorktreeRemove).toBe(false);
    expect(buildProjectScript(script.id, initial)).toEqual(script);
  });

  it("can sit on a setup script too", () => {
    const script = stored({ runOnWorktreeCreate: true, runOnWorktreeRemove: true });
    const { initial } = editorRequestForScript(script, noKeybindings);
    expect(buildProjectScript(script.id, initial)).toEqual(script);
  });
});

describe("primaryProjectScript with remove scripts", () => {
  it("skips a remove script listed first", () => {
    const dev = stored({ id: "dev", name: "Dev", runOnWorktreeRemove: false });
    expect(primaryProjectScript([stored({ runOnWorktreeRemove: true }), dev])).toBe(dev);
  });

  it("offers no main button when the only script is a remove script", () => {
    expect(primaryProjectScript([stored({ runOnWorktreeRemove: true })])).toBeNull();
  });
});
