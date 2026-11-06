/**
 * T3o mobile identity overlay (T3O-18, D17). Authoritative when
 * `repoEnv.APP_VARIANT === "t3o"` — unknown APP_VARIANT values otherwise fall
 * through to production in `app.config.ts`.
 */
import type { ExpoConfig } from "expo/config";

const T3O_PACKAGE = "com.brentkelly.t3o";
const T3O_SCHEME = "t3o";
const T3O_NAME = "T3o";
const T3O_ICON = "./assets/t3o/icon-1024.png";
const T3O_FOREGROUND = "./assets/t3o/android-foreground.png";
const T3O_BACKGROUND = "./assets/t3o/android-background.png";
const T3O_SPLASH = "./assets/t3o/splash.png";
const T3O_NOTIFICATION = "./assets/t3o/notification.png";
const T3O_BACKGROUND_COLOR = "#0b0f1a";

export const T3O_ANDROID_PACKAGE = T3O_PACKAGE;

export function isT3oAppVariant(repoEnv: { readonly APP_VARIANT?: string | undefined }): boolean {
  return repoEnv.APP_VARIANT === "t3o";
}

function pluginName(plugin: NonNullable<ExpoConfig["plugins"]>[number]): string {
  if (typeof plugin === "string") return plugin;
  if (Array.isArray(plugin) && typeof plugin[0] === "string") return plugin[0];
  return "";
}

function rewriteT3CodeCopy(value: string): string {
  return value.replaceAll("T3 Code", "T3o");
}

function stripCloudPlugins(plugins: NonNullable<ExpoConfig["plugins"]>): NonNullable<ExpoConfig["plugins"]> {
  const drop = new Set([
    "@clerk/expo",
    "expo-widgets",
    "./plugins/withWidgetLogoAsset.cjs",
    "./plugins/withShareExtensionDisplayName.cjs",
  ]);
  return plugins.flatMap((plugin) => {
    const name = pluginName(plugin);
    if (drop.has(name)) return [];
    if (name === "expo-sharing" && Array.isArray(plugin)) {
      const options = (plugin[1] ?? {}) as Record<string, unknown>;
      const ios = (options.ios ?? {}) as Record<string, unknown>;
      return [
        [
          "expo-sharing",
          {
            ...options,
            ios: { ...ios, enabled: false },
          },
        ],
      ];
    }
    if (name === "expo-notifications" && Array.isArray(plugin)) {
      const options = (plugin[1] ?? {}) as Record<string, unknown>;
      return [
        [
          "expo-notifications",
          {
            ...options,
            icon: T3O_NOTIFICATION,
            color: "#FFFFFF",
            mode: "production",
          },
        ],
      ];
    }
    if (name === "expo-quick-actions" && Array.isArray(plugin)) {
      return [
        [
          "expo-quick-actions",
          {
            androidIcons: {
              shortcut_icon: {
                foregroundImage: T3O_FOREGROUND,
                backgroundColor: T3O_BACKGROUND_COLOR,
                backgroundImage: T3O_BACKGROUND,
              },
            },
          },
        ],
      ];
    }
    if (name === "expo-splash-screen" && Array.isArray(plugin)) {
      return [
        [
          "expo-splash-screen",
          {
            image: T3O_SPLASH,
            resizeMode: "contain",
            backgroundColor: T3O_BACKGROUND_COLOR,
            imageWidth: 220,
            dark: {
              image: T3O_SPLASH,
              backgroundColor: T3O_BACKGROUND_COLOR,
            },
            android: {
              image: T3O_SPLASH,
              imageWidth: 288,
              dark: { image: T3O_SPLASH },
            },
          },
        ],
      ];
    }
    if (name === "expo-audio" && Array.isArray(plugin)) {
      const options = (plugin[1] ?? {}) as Record<string, unknown>;
      return [
        [
          "expo-audio",
          {
            ...options,
            microphonePermission: rewriteT3CodeCopy(String(options.microphonePermission ?? "")),
          },
        ],
      ];
    }
    if (name === "expo-camera" && Array.isArray(plugin)) {
      const options = (plugin[1] ?? {}) as Record<string, unknown>;
      return [
        [
          "expo-camera",
          {
            ...options,
            cameraPermission: rewriteT3CodeCopy(String(options.cameraPermission ?? "")),
          },
        ],
      ];
    }
    return [plugin];
  });
}

export function applyT3oMobileConfig(
  config: ExpoConfig,
  repoEnv: { readonly APP_VARIANT?: string | undefined },
): ExpoConfig {
  if (!isT3oAppVariant(repoEnv)) return config;

  const extra = { ...(config.extra ?? {}) } as Record<string, unknown>;
  extra.appVariant = "t3o";
  extra.relay = { url: null };
  extra.clerk = { publishableKey: null, jwtTemplate: null };
  extra.observability = {
    tracesUrl: extra.observability && typeof extra.observability === "object"
      ? ((extra.observability as { tracesUrl?: string }).tracesUrl ?? null)
      : null,
    tracesDataset: null,
    tracesToken: null,
  };
  delete extra.eas;
  delete extra.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID;
  delete extra.EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID;
  delete extra.EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID;
  delete extra.EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME;

  const ios = { ...(config.ios ?? {}) };
  delete ios.appleTeamId;
  delete ios.associatedDomains;
  delete ios.googleServicesFile;
  ios.bundleIdentifier = T3O_PACKAGE;
  ios.icon = T3O_ICON;
  const infoPlist = { ...(ios.infoPlist ?? {}) } as Record<string, unknown>;
  if (typeof infoPlist.NSLocalNetworkUsageDescription === "string") {
    infoPlist.NSLocalNetworkUsageDescription = rewriteT3CodeCopy(
      infoPlist.NSLocalNetworkUsageDescription,
    );
  }
  if (typeof infoPlist.NSPhotoLibraryAddUsageDescription === "string") {
    infoPlist.NSPhotoLibraryAddUsageDescription = rewriteT3CodeCopy(
      infoPlist.NSPhotoLibraryAddUsageDescription,
    );
  }
  ios.infoPlist = infoPlist;
  ios.entitlements = {};

  const android = { ...(config.android ?? {}) };
  delete android.googleServicesFile;
  android.package = T3O_PACKAGE;
  android.icon = T3O_ICON;
  android.adaptiveIcon = {
    backgroundColor: T3O_BACKGROUND_COLOR,
    backgroundImage: T3O_BACKGROUND,
    foregroundImage: T3O_FOREGROUND,
    monochromeImage: T3O_FOREGROUND,
  };

  return {
    ...config,
    name: T3O_NAME,
    slug: "t3o",
    scheme: T3O_SCHEME,
    icon: T3O_ICON,
    owner: undefined,
    updates: {
      ...(config.updates ?? {}),
      enabled: false,
    },
    ios,
    android,
    web: {
      ...(config.web ?? {}),
      favicon: T3O_ICON,
    },
    plugins: [...stripCloudPlugins(config.plugins ?? []), "./plugins/withT3oReleaseSigning.cjs"],
    extra,
  };
}
