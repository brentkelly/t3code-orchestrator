import { createRequire } from "node:module";

import { describe, expect, it } from "vite-plus/test";

const requirePlugin = createRequire(import.meta.url);

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
});
