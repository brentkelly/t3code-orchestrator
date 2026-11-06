import { describe, expect, it } from "vite-plus/test";

/** JS form of the T3o Android workflow grep (`[[:space:]]` → `\s`). */
const APPLICATION_ID = /applicationId\s+['"]com\.brentkelly\.t3o['"]/;
const NAMESPACE = /namespace\s+['"]com\.brentkelly\.t3o['"]/;

describe("T3o Android package-id assert", () => {
  it("accepts Expo Groovy single quotes", () => {
    const gradle = [
      "    namespace 'com.brentkelly.t3o'",
      "    defaultConfig {",
      "        applicationId 'com.brentkelly.t3o'",
      "    }",
    ].join("\n");
    expect(APPLICATION_ID.test(gradle)).toBe(true);
    expect(NAMESPACE.test(gradle)).toBe(true);
  });

  it("accepts double quotes", () => {
    const gradle = '    namespace "com.brentkelly.t3o"\n        applicationId "com.brentkelly.t3o"';
    expect(APPLICATION_ID.test(gradle)).toBe(true);
    expect(NAMESPACE.test(gradle)).toBe(true);
  });

  it("rejects the upstream T3 Code id", () => {
    const gradle = "        applicationId 'com.t3tools.t3code'\n    namespace 'com.t3tools.t3code'";
    expect(APPLICATION_ID.test(gradle)).toBe(false);
    expect(NAMESPACE.test(gradle)).toBe(false);
  });
});
