import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import { createBuildConfig } from "./build-desktop-artifact.ts";
import {
  T3O_STAGE_PACKAGE,
  t3oLinuxTargets,
  t3oStagePackageMetadata,
} from "./lib/t3o-desktop-build.ts";

const forkRepository = ConfigProvider.layer(
  ConfigProvider.fromEnv({ env: { GITHUB_REPOSITORY: "brentkelly/t3code-orchestrator" } }),
);

const buildConfig = (platform: "mac" | "linux" | "win", target: string, version: string) =>
  createBuildConfig(platform, target, version, false, false, undefined, undefined).pipe(
    Effect.provide(forkRepository),
  );

it.layer(NodeServices.layer)("t3o desktop build config", (it) => {
  it.effect("publishes a -t3o.N release to the fork's latest feed, not a `t3o` channel", () =>
    Effect.gen(function* () {
      for (const [platform, target] of [
        ["mac", "dmg"],
        ["linux", "AppImage"],
        ["win", "nsis"],
      ] as const) {
        const config = yield* buildConfig(platform, target, "0.0.42-t3o.1");
        assert.equal(config.detectUpdateChannel, false);
        assert.deepStrictEqual(config.publish, [
          {
            provider: "github",
            owner: "brentkelly",
            repo: "t3code-orchestrator",
            releaseType: "release",
          },
        ]);
        assert.equal(config.appId, "io.github.brentkelly.t3o");
        assert.equal(config.productName, "T3o");
        assert.equal(config.artifactName, "T3o-${version}-${arch}.${ext}");
      }
    }),
  );

  it.effect("ships deb and rpm beside the AppImage of a T3o release", () =>
    Effect.gen(function* () {
      const linux = (yield* buildConfig("linux", "AppImage", "0.0.42-t3o.1")).linux as Record<
        string,
        unknown
      >;
      assert.deepStrictEqual(linux.target, ["AppImage", "deb", "rpm"]);
      assert.equal(linux.executableName, "t3o");
      assert.deepStrictEqual(linux.desktop, { entry: { StartupWMClass: "t3o" } });
      assert.deepStrictEqual(linux.protocols, [{ name: "T3o", schemes: ["t3o", "t3o-dev"] }]);
      // electron-builder refuses a deb/rpm without a maintainer.
      assert.isString(linux.maintainer);
      // Upstream's fields survive the overlay.
      assert.equal(linux.category, "Development");
      assert.equal(linux.icon, "icons");
    }),
  );

  it.effect("names the app T3o in the macOS screen-capture prompt and URL schemes", () =>
    Effect.gen(function* () {
      const mac = (yield* buildConfig("mac", "dmg", "0.0.42-t3o.1")).mac as Record<string, unknown>;
      assert.deepStrictEqual(mac.protocols, [{ name: "T3o", schemes: ["t3o", "t3o-dev"] }]);
      assert.match(
        String((mac.extendInfo as Record<string, unknown>).NSScreenCaptureUsageDescription),
        /^T3o /,
      );
      assert.deepStrictEqual(mac.target, ["dmg", "zip"]);
    }),
  );
});

it("keeps a single Linux target outside T3o releases and for other targets", () => {
  assert.deepStrictEqual(t3oLinuxTargets("AppImage", "0.0.42"), ["AppImage"]);
  assert.deepStrictEqual(t3oLinuxTargets("deb", "0.0.42-t3o.1"), ["deb"]);
  assert.deepStrictEqual(t3oLinuxTargets("AppImage", "0.0.42-t3o.2"), ["AppImage", "deb", "rpm"]);
});

it("stamps the staged package with the fork's name, homepage and signing state", () => {
  assert.deepStrictEqual(T3O_STAGE_PACKAGE, { name: "t3o", description: "T3o desktop build" });
  assert.deepStrictEqual(t3oStagePackageMetadata(false), {
    homepage: "https://github.com/brentkelly/t3code-orchestrator",
    t3oCodeSigned: false,
  });
  assert.equal(t3oStagePackageMetadata(true).t3oCodeSigned, true);
});
