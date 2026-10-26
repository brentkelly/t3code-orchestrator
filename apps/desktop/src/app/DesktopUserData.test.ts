import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { resolveUserDataPath } from "./DesktopUserData.ts";

// T3o: the fork has no legacy profile of its own, so the only Local State it may read is the one
// in its own profile; upstream T3 Code's profiles are never inspected for migration.
it.effect("identifies a failed profile inspection and preserves its cause", () => {
  const ownState = "/profiles/t3o/Local State";
  const cause = PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "exists",
    pathOrDescriptor: ownState,
  });
  return Effect.gen(function* () {
    const error = yield* resolveUserDataPath({
      appDataDirectory: "/profiles",
      isDevelopment: false,
      platform: "win32",
    }).pipe(Effect.flip);
    assert.equal(error.operation, "inspect");
    assert.equal(error.resourcePath, ownState);
    assert.equal(error.category, "PermissionDenied");
    assert.strictEqual(error.cause, cause);
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.fail(cause),
      }),
    ),
    Effect.provide(NodeServices.layer),
  );
});

it.effect.each(["t3code", "t3code-v2", "T3 Code (Alpha)"])(
  "never adopts upstream's Windows credential keys from %s",
  (sourceName) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3o-profile-" });
      const source = path.join(directory, sourceName);
      yield* fs.makeDirectory(source, { recursive: true });
      yield* fs.writeFileString(path.join(source, "Local State"), "upstream keys");
      for (const isDevelopment of [false, true]) {
        const resolved = yield* resolveUserDataPath({
          appDataDirectory: directory,
          isDevelopment,
          platform: "win32",
        });
        assert.equal(resolved, path.join(directory, isDevelopment ? "t3o-dev" : "t3o"));
        assert.isFalse(yield* fs.exists(path.join(resolved, "Local State")));
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
