import Constants from "expo-constants";

const appVariant = Constants.expoConfig?.extra?.appVariant;

export const T3_CODE_BRAND_MARK_SOURCE =
  // T3o: dedicated icon; do not fall through to production T3 Code art.
  appVariant === "t3o"
    ? require("../../assets/t3o/icon-1024.png")
    : appVariant === "development"
      ? require("../../../../assets/dev/blueprint-ios-1024.png")
      : appVariant === "preview"
        ? require("../../../../assets/nightly/nightly-ios-1024.png")
        : require("../../../../assets/prod/black-ios-1024.png");
