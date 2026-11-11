// T3o: kept out of upstream's vite-env.d.ts. See vite/t3oReleaseDefine.ts.
import type { T3oReleaseStamp } from "./components/t3o/t3oRelease";

declare global {
  interface ImportMetaEnv {
    readonly T3O_RELEASE: T3oReleaseStamp | "";
  }
}
