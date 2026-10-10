// @effect-diagnostics nodeBuiltinImport:off -- Builds a real on-disk app and resources directory per case.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import { isAppImageProcess } from "./autoUpdater.ts";
import {
  makeInstallGate,
  resolveT3oUpdateInstallMode,
  t3oReleasePageOpenFailureMessage,
  t3oReleasePageUrl,
} from "./updateInstallGate.ts";

interface GateFixture {
  readonly platform: NodeJS.Platform;
  readonly packageType?: string;
  readonly packageJson?: string;
  readonly env?: Record<string, string | undefined>;
  readonly withShell?: boolean;
  readonly openExternal?: boolean;
}

function withGate<A, E>(
  fixture: GateFixture,
  body: (
    gate: Effect.Success<typeof makeInstallGate>,
    opened: ReadonlyArray<unknown>,
  ) => Effect.Effect<A, E>,
) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-update-gate-"));
  const appPath = NodePath.join(root, "app");
  const resourcesPath = NodePath.join(root, "resources");
  NodeFS.mkdirSync(appPath, { recursive: true });
  NodeFS.mkdirSync(resourcesPath, { recursive: true });
  if (fixture.packageType !== undefined) {
    NodeFS.writeFileSync(NodePath.join(resourcesPath, "package-type"), fixture.packageType);
  }
  if (fixture.packageJson !== undefined) {
    NodeFS.writeFileSync(NodePath.join(appPath, "package.json"), fixture.packageJson);
  }

  const opened: unknown[] = [];
  const shellLayer = Layer.succeed(ElectronShell.ElectronShell, {
    openExternal: (url) =>
      Effect.sync(() => {
        opened.push(url);
        return fixture.openExternal ?? true;
      }),
    openSystemSettings: () => Effect.succeed(true),
    copyText: () => Effect.void,
  });
  const configLayer = DesktopConfig.layerTest({ T3CODE_HOME: root, ...fixture.env });
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: root,
    platform: fixture.platform,
    processArch: "x64",
    appVersion: "0.0.42-t3o.1",
    appPath,
    isPackaged: true,
    resourcesPath,
    runningUnderArm64Translation: false,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, configLayer)));

  const layer = Layer.mergeAll(
    environmentLayer,
    configLayer,
    NodeServices.layer,
    fixture.withShell === false ? Layer.empty : shellLayer,
  );

  return Effect.gen(function* () {
    const gate = yield* makeInstallGate;
    return yield* body(gate, opened);
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
}

describe("resolveT3oUpdateInstallMode", () => {
  it("lets Windows and AppImage installs replace themselves", () => {
    assert.equal(
      resolveT3oUpdateInstallMode({
        platform: "win32",
        appImagePath: undefined,
        codeSigned: false,
      }),
      "self-install",
    );
    assert.equal(
      resolveT3oUpdateInstallMode({
        platform: "linux",
        appImagePath: "/home/a/T3o.AppImage",
        codeSigned: undefined,
      }),
      "self-install",
    );
  });

  it("sends deb/rpm and unsigned macOS installs to the release page", () => {
    assert.equal(
      resolveT3oUpdateInstallMode({
        platform: "linux",
        appImagePath: undefined,
        codeSigned: false,
      }),
      "release-page",
    );
    assert.equal(
      resolveT3oUpdateInstallMode({
        platform: "darwin",
        appImagePath: undefined,
        codeSigned: false,
      }),
      "release-page",
    );
  });

  it("keeps upstream's behaviour for a signed or unstamped macOS build", () => {
    for (const codeSigned of [true, undefined]) {
      assert.equal(
        resolveT3oUpdateInstallMode({ platform: "darwin", appImagePath: undefined, codeSigned }),
        "self-install",
      );
    }
  });
});

describe("t3oReleasePageUrl", () => {
  it("links the exact release, or the release list when the version is unknown", () => {
    assert.equal(
      t3oReleasePageUrl("0.0.43-t3o.1"),
      "https://github.com/brentkelly/t3code-orchestrator/releases/tag/v0.0.43-t3o.1",
    );
    assert.equal(
      t3oReleasePageUrl(null),
      "https://github.com/brentkelly/t3code-orchestrator/releases",
    );
    assert.equal(
      t3oReleasePageUrl("  "),
      "https://github.com/brentkelly/t3code-orchestrator/releases",
    );
  });

  it("names the release URL when the page cannot be opened", () => {
    assert.equal(
      t3oReleasePageOpenFailureMessage("0.0.43-t3o.1"),
      "Couldn't open the release page. Open https://github.com/brentkelly/t3code-orchestrator/releases/tag/v0.0.43-t3o.1 to install the update.",
    );
  });
});

describe("makeInstallGate", () => {
  it.effect("opens the release page for an unsigned macOS build instead of downloading", () =>
    withGate(
      { platform: "darwin", packageJson: JSON.stringify({ t3oCodeSigned: false }) },
      (gate, opened) =>
        Effect.gen(function* () {
          assert.equal(gate.mode, "release-page");
          assert.isTrue(yield* gate.redirectDownload("0.0.43-t3o.1"));
          assert.deepEqual(opened, [
            "https://github.com/brentkelly/t3code-orchestrator/releases/tag/v0.0.43-t3o.1",
          ]);
        }),
    ),
  );

  it.effect("lets a signed macOS build download as upstream does", () =>
    withGate(
      { platform: "darwin", packageJson: JSON.stringify({ t3oCodeSigned: true }) },
      (gate, opened) =>
        Effect.gen(function* () {
          assert.equal(gate.mode, "self-install");
          assert.isFalse(yield* gate.redirectDownload("0.0.43-t3o.1"));
          assert.deepEqual(opened, []);
        }),
    ),
  );

  it.effect("lets a deb/rpm install check for updates and sends it to the release page", () =>
    withGate({ platform: "linux", packageType: "deb\n" }, (gate, opened) =>
      Effect.gen(function* () {
        assert.isString(gate.linuxPackageSource);
        assert.equal(gate.mode, "release-page");
        assert.isTrue(yield* gate.redirectDownload(null));
        assert.deepEqual(opened, ["https://github.com/brentkelly/t3code-orchestrator/releases"]);
      }),
    ),
  );

  it.effect("self-installs an AppImage even when a package-type leaked into it", () =>
    withGate(
      {
        platform: "linux",
        packageType: "deb",
        env: { APPIMAGE: "/home/a/Applications/T3o.AppImage" },
      },
      (gate, opened) =>
        Effect.gen(function* () {
          assert.equal(gate.mode, "self-install");
          assert.isFalse(yield* gate.redirectDownload("0.0.43-t3o.1"));
          assert.deepEqual(opened, []);
        }),
    ),
  );

  it.effect("keeps a Linux build without a package type unable to check", () =>
    withGate({ platform: "linux", packageType: "something-else" }, (gate) =>
      Effect.sync(() => {
        assert.isUndefined(gate.linuxPackageSource);
      }),
    ),
  );

  it.effect("returns false when no shell can open the page", () =>
    withGate(
      {
        platform: "darwin",
        packageJson: JSON.stringify({ t3oCodeSigned: false }),
        withShell: false,
      },
      (gate) =>
        Effect.gen(function* () {
          assert.isFalse(yield* gate.redirectDownload("0.0.43-t3o.1"));
        }),
    ),
  );

  it.effect("returns false when the shell cannot open the release page", () =>
    withGate(
      {
        platform: "linux",
        packageType: "deb",
        openExternal: false,
      },
      (gate, opened) =>
        Effect.gen(function* () {
          assert.equal(gate.mode, "release-page");
          assert.isFalse(yield* gate.redirectDownload("0.0.43-t3o.1"));
          assert.deepEqual(opened, [
            "https://github.com/brentkelly/t3code-orchestrator/releases/tag/v0.0.43-t3o.1",
          ]);
        }),
    ),
  );
});

describe("isAppImageProcess", () => {
  it("trusts the APPIMAGE variable the AppImage runtime sets, on Linux only", () => {
    assert.isTrue(isAppImageProcess("linux", { APPIMAGE: "/a/T3o.AppImage" }));
    assert.isFalse(isAppImageProcess("linux", { APPIMAGE: "  " }));
    assert.isFalse(isAppImageProcess("linux", {}));
    assert.isFalse(isAppImageProcess("darwin", { APPIMAGE: "/a/T3o.AppImage" }));
  });
});
