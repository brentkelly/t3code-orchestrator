/**
 * T3o: write Gradle release signing when ANDROID_KEYSTORE_PATH and the
 * matching passwords/alias are set. No-op otherwise so debug builds stay
 * unsigned-by-upload-key.
 */
const { withAppBuildGradle } = require("expo/config-plugins");

function withT3oReleaseSigning(config) {
  const storeFile = process.env.ANDROID_KEYSTORE_PATH;
  const storePassword = process.env.ANDROID_KEYSTORE_PASSWORD;
  const keyAlias = process.env.ANDROID_KEY_ALIAS;
  const keyPassword = process.env.ANDROID_KEY_PASSWORD;
  if (!storeFile || !storePassword || !keyAlias || !keyPassword) {
    return config;
  }

  return withAppBuildGradle(config, (mod) => {
    let contents = mod.modResults.contents;
    if (contents.includes("t3oReleaseSigning")) {
      return mod;
    }
    if (!contents.includes("signingConfigs {")) {
      contents = contents.replace(
        /android\s*\{/,
        `android {
    signingConfigs {
        t3oReleaseSigning {
            storeFile file("${storeFile.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}")
            storePassword "${storePassword.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"
            keyAlias "${keyAlias.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"
            keyPassword "${keyPassword.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"
        }
    }`,
      );
    } else {
      contents = contents.replace(
        /signingConfigs\s*\{/,
        `signingConfigs {
        t3oReleaseSigning {
            storeFile file("${storeFile.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}")
            storePassword "${storePassword.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"
            keyAlias "${keyAlias.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"
            keyPassword "${keyPassword.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"
        }`,
      );
    }
    if (contents.includes("buildTypes")) {
      contents = contents.replace(
        /release\s*\{/,
        `release {
            signingConfig signingConfigs.t3oReleaseSigning`,
      );
    }
    mod.modResults.contents = contents;
    return mod;
  });
}

module.exports = withT3oReleaseSigning;
