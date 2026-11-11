// @effect-diagnostics nodeBuiltinImport:off - read by the Vite config at build time.
/**
 * T3o: the build stamp `scripts/t3o-service.mjs` writes before building, exposed as
 * `import.meta.env.T3O_RELEASE`. Dev servers and builds without the file get "".
 */
import * as NodeFS from "node:fs";

const stampFile = new URL("../.t3o-release.json", import.meta.url);

export function t3oReleaseDefine(): Record<string, string> {
  let stamp: unknown = "";
  try {
    stamp = JSON.parse(NodeFS.readFileSync(stampFile, "utf8"));
  } catch {
    // no stamp: a dev server or a plain `vp run build`
  }
  return { "import.meta.env.T3O_RELEASE": JSON.stringify(stamp) };
}
