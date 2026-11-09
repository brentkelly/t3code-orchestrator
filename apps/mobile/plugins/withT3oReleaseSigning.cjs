/**
 * T3o: write Gradle release signing when ANDROID_KEYSTORE_PATH and the
 * matching passwords/alias are set. No-op otherwise so debug builds stay
 * unsigned-by-upload-key.
 *
 * Passwords stay in the process environment (`System.getenv`) rather than
 * being interpolated into `android/app/build.gradle`. Gradle takes the last
 * `signingConfig` assignment in a `buildTypes` block, so this replaces Expo's
 * `signingConfigs.debug` on `release` instead of prepending a second line.
 */
const { withAppBuildGradle } = require("expo/config-plugins");

const T3O_RELEASE_SIGNING_CONFIG = `        t3oReleaseSigning {
            storeFile file(System.getenv("ANDROID_KEYSTORE_PATH"))
            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
            keyAlias System.getenv("ANDROID_KEY_ALIAS")
            keyPassword System.getenv("ANDROID_KEY_PASSWORD")
        }`;

function lastSigningConfigInReleaseBlock(contents) {
  const match = contents.match(/buildTypes\s*\{[\s\S]*?release\s*\{([\s\S]*?)\n\s*\}/);
  if (match === null) return null;
  const assignments = [...match[1].matchAll(/signingConfig\s+(signingConfigs\.\w+)/g)];
  return assignments.length > 0 ? assignments[assignments.length - 1][1] : null;
}

function applyT3oReleaseSigningGradle(contents) {
  if (contents.includes("t3oReleaseSigning")) {
    return contents;
  }
  if (!contents.includes("signingConfigs {")) {
    contents = contents.replace(
      /android\s*\{/,
      `android {
    signingConfigs {
${T3O_RELEASE_SIGNING_CONFIG}
    }`,
    );
  } else {
    contents = contents.replace(
      /signingConfigs\s*\{/,
      `signingConfigs {
${T3O_RELEASE_SIGNING_CONFIG}`,
    );
  }
  const replaced = contents.replace(
    /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig\s+signingConfigs\.\w+/,
    "$1signingConfig signingConfigs.t3oReleaseSigning",
  );
  if (replaced !== contents) {
    return replaced;
  }
  if (contents.includes("buildTypes")) {
    return contents.replace(
      /release\s*\{/,
      `release {
            signingConfig signingConfigs.t3oReleaseSigning`,
    );
  }
  return contents;
}

function withT3oReleaseSigning(config) {
  const storeFile = process.env.ANDROID_KEYSTORE_PATH;
  const storePassword = process.env.ANDROID_KEYSTORE_PASSWORD;
  const keyAlias = process.env.ANDROID_KEY_ALIAS;
  const keyPassword = process.env.ANDROID_KEY_PASSWORD;
  if (!storeFile || !storePassword || !keyAlias || !keyPassword) {
    return config;
  }

  return withAppBuildGradle(config, (mod) => {
    mod.modResults.contents = applyT3oReleaseSigningGradle(mod.modResults.contents);
    return mod;
  });
}

module.exports = withT3oReleaseSigning;
module.exports.applyT3oReleaseSigningGradle = applyT3oReleaseSigningGradle;
module.exports.lastSigningConfigInReleaseBlock = lastSigningConfigInReleaseBlock;
