import { assert, describe, it } from "@effect/vitest";
import {
  resolveT3oAppId,
  resolveT3oLinuxDesktopEntryName,
  resolveT3oLinuxWmClass,
  resolveT3oUserDataNames,
} from "./t3o-desktop-identity.ts";

describe("t3oIdentity", () => {
  it("uses profile names that never resolve to upstream T3 Code's profiles", () => {
    for (const isDevelopment of [false, true]) {
      const names = resolveT3oUserDataNames(isDevelopment);
      assert.equal(names.legacy, names.current);
      assert.notMatch(names.current, /t3code|T3 Code/);
    }
    assert.equal(resolveT3oUserDataNames(false).current, "t3o");
    assert.equal(resolveT3oUserDataNames(true).current, "t3o-dev");
  });

  it("keeps the runtime portal entry distinct from the .deb's t3o.desktop", () => {
    assert.equal(resolveT3oAppId(false), "com.brentkelly.t3o");
    assert.equal(resolveT3oLinuxWmClass(false), "t3o");
    assert.notEqual(resolveT3oLinuxDesktopEntryName(false), "t3o.desktop");
    assert.notEqual(resolveT3oLinuxDesktopEntryName(true), resolveT3oLinuxDesktopEntryName(false));
  });
});
