import { createRequire } from "node:module";

import { describe, expect, it } from "vite-plus/test";

const requirePlugin = createRequire(import.meta.url);

const EXPO_APP_BUILD_GRADLE = `
android {
    ndkVersion rootProject.ext.ndkVersion
    compileSdk rootProject.ext.compileSdkVersion
    namespace 'com.brentkelly.t3o'
    defaultConfig {
        applicationId 'com.brentkelly.t3o'
        versionCode 1
        versionName "1.0.0"
    }
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
            minifyEnabled false
        }
    }
}
`;

describe("withT3oReleaseSigning", () => {
  it("loads through expo/config-plugins and no-ops without a keystore", () => {
    const plugin = requirePlugin("./withT3oReleaseSigning.cjs") as (config: {
      name: string;
      slug: string;
    }) => { name: string; slug: string };
    expect(typeof plugin).toBe("function");
    const config = { name: "T3o", slug: "t3o" };
    expect(plugin(config)).toBe(config);
  });

  it("leaves the last signingConfig in release as t3oReleaseSigning, not debug", () => {
    const plugin = requirePlugin("./withT3oReleaseSigning.cjs") as {
      applyT3oReleaseSigningGradle: (contents: string) => string;
      lastSigningConfigInReleaseBlock: (contents: string) => string | null;
    };
    const patched = plugin.applyT3oReleaseSigningGradle(EXPO_APP_BUILD_GRADLE);
    expect(plugin.lastSigningConfigInReleaseBlock(patched)).toBe(
      "signingConfigs.t3oReleaseSigning",
    );
    expect(patched).toMatch(/debug \{\s*signingConfig signingConfigs\.debug/);
    expect(patched).not.toMatch(/storePassword "/);
    expect(patched).toContain('storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")');
    expect(patched).toContain('storeFile file(System.getenv("ANDROID_KEYSTORE_PATH"))');
  });
});
