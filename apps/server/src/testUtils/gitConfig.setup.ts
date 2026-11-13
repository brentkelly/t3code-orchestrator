// @effect-diagnostics nodeBuiltinImport:off - a vitest setup file resolving its sibling config path.
// T3o: resolves the committed test.gitconfig beside this file.
import * as NodeURL from "node:url";

// Override inherited autocrlf, signing and init-branch settings through env so every git child gets stable fixtures.
const entries: ReadonlyArray<readonly [key: string, value: string]> = [
  ["core.autocrlf", "false"],
  ["core.filemode", "false"],
  ["core.longpaths", "true"],
  ["commit.gpgsign", "false"],
  ["tag.gpgsign", "false"],
  ["init.defaultBranch", "main"],
];

// T3o: non-isolated projects re-run setup files per test file in one process (T3O-45).
if (process.env.T3O_GIT_CONFIG_APPLIED !== "1") {
  process.env.T3O_GIT_CONFIG_APPLIED = "1";
  // T3o: hide the host's global and system git config (url.*.insteadOf rewrote fixture remotes).
  process.env.GIT_CONFIG_GLOBAL = NodeURL.fileURLToPath(
    new URL("./test.gitconfig", import.meta.url),
  );
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  const existing = Number(process.env.GIT_CONFIG_COUNT ?? "0");
  process.env.GIT_CONFIG_COUNT = String(existing + entries.length);
  entries.forEach(([key, value], index) => {
    process.env[`GIT_CONFIG_KEY_${existing + index}`] = key;
    process.env[`GIT_CONFIG_VALUE_${existing + index}`] = value;
  });
}
