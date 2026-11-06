import type { ExpoConfig } from "expo/config";
import { describe, expect, it } from "vite-plus/test";

import { applyT3oMobileConfig, isT3oAppVariant, T3O_ANDROID_PACKAGE } from "./applyT3oMobileConfig.ts";

const base = {
  name: "T3 Code",
  slug: "t3-code",
  scheme: "t3code",
  owner: "pingdotgg",
  icon: "./assets/prod/black-ios-1024.png",
  updates: { enabled: true, url: "https://u.expo.dev/example" },
  ios: {
    bundleIdentifier: "com.t3tools.t3code",
    appleTeamId: "ARK85ZXQ4Z",
    associatedDomains: ["applinks:clerk.t3.codes"],
    entitlements: { "keychain-access-groups": ["$(AppIdentifierPrefix)com.t3tools.t3code"] },
    infoPlist: {
      NSLocalNetworkUsageDescription: "Allow T3 Code to connect to T3 Code servers.",
    },
  },
  android: {
    package: "com.t3tools.t3code",
    googleServicesFile: "./google-services.json",
  },
  plugins: [
    ["@clerk/expo", { appleSignIn: true }],
    "expo-widgets",
    "./plugins/withWidgetLogoAsset.cjs",
    ["expo-sharing", { ios: { enabled: true }, android: { enabled: true } }],
    ["expo-camera", { cameraPermission: "Allow T3 Code to access your camera." }],
  ],
  extra: {
    appVariant: "production",
    eas: { projectId: "d763fcb8-d37c-41ea-a773-b54a0ab4a454" },
    clerk: { publishableKey: "pk_test", jwtTemplate: "t3" },
    relay: { url: "https://relay.example" },
    EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: "web",
  },
} as unknown as ExpoConfig;

describe("applyT3oMobileConfig", () => {
  it("is a no-op unless APP_VARIANT is exactly t3o", () => {
    expect(isT3oAppVariant({})).toBe(false);
    expect(isT3oAppVariant({ APP_VARIANT: "production" })).toBe(false);
    expect(applyT3oMobileConfig(base, { APP_VARIANT: "production" })).toBe(base);
  });

  it("rewrites identity, strips cloud, and disables OTA for t3o", () => {
    const next = applyT3oMobileConfig(base, { APP_VARIANT: "t3o" });
    expect(next.name).toBe("T3o");
    expect(next.scheme).toBe("t3o");
    expect(next.ios?.bundleIdentifier).toBe(T3O_ANDROID_PACKAGE);
    expect(next.android?.package).toBe(T3O_ANDROID_PACKAGE);
    expect(next.ios?.appleTeamId).toBeUndefined();
    expect(next.ios?.associatedDomains).toBeUndefined();
    expect(next.android?.googleServicesFile).toBeUndefined();
    expect(next.owner).toBeUndefined();
    expect(next.updates?.enabled).toBe(false);
    expect(next.extra?.appVariant).toBe("t3o");
    expect(next.extra?.eas).toBeUndefined();
    expect(next.extra?.clerk).toEqual({ publishableKey: null, jwtTemplate: null });
    expect(next.extra?.relay).toEqual({ url: null });
    expect(next.extra?.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID).toBeUndefined();
    const names = (next.plugins ?? []).map((plugin) =>
      typeof plugin === "string" ? plugin : plugin[0],
    );
    expect(names).not.toContain("@clerk/expo");
    expect(names).not.toContain("expo-widgets");
    expect(names).toContain("./plugins/withT3oReleaseSigning.cjs");
    expect(next.ios?.infoPlist?.NSLocalNetworkUsageDescription).toContain("T3o");
    expect(next.ios?.infoPlist?.NSLocalNetworkUsageDescription).not.toContain("T3 Code");
  });
});
