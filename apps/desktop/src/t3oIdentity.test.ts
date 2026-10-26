import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { resolveDesktopBaseDir } from "./app/DesktopStatePaths.ts";
import {
  resolveT3oAppId,
  resolveT3oLinuxDesktopEntryName,
  resolveT3oLinuxWmClass,
  resolveT3oUserDataNames,
} from "./t3oIdentity.ts";

describe("t3oIdentity", () => {
  it("defaults the T3 home to ~/.t3o and still honours T3CODE_HOME", () => {
    const joinPath = (first: string, ...segments: string[]) => [first, ...segments].join("/");
    assert.equal(
      resolveDesktopBaseDir({ homeDirectory: "/home/u", joinPath, t3Home: Option.none() }),
      "/home/u/.t3o",
    );
    assert.equal(
      resolveDesktopBaseDir({ homeDirectory: "/home/u", joinPath, t3Home: Option.some("  ") }),
      "/home/u/.t3o",
    );
    assert.equal(
      resolveDesktopBaseDir({ homeDirectory: "/home/u", joinPath, t3Home: Option.some("/srv/t3") }),
      "/srv/t3",
    );
  });

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
