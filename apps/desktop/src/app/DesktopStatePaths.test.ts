// T3o: the fork's desktop app keeps its T3 home in ~/.t3o, apart from upstream T3 Code's ~/.t3.
import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { resolveDesktopBaseDir } from "./DesktopStatePaths.ts";

describe("DesktopStatePaths", () => {
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
});
