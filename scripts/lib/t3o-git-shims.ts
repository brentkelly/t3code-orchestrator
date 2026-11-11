// @effect-diagnostics nodeBuiltinImport:off - run by the plain-Node service installer.
/**
 * T3o: the `t3-git-credential` and `gh` shims `scripts/t3o-service.mjs` installs in
 * `~/.local/bin`, both running the built `dist/t3oGitCredential.mjs` against one gitenv file.
 * See docs/t3o/gitenv.md.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Must match `T3O_SHIM_MARKER` in apps/server/src/t3o/gitCredential.ts. */
export const SHIM_MARKER = "# t3o-managed shim";

const HELPER_NAME = "t3-git-credential";

interface ShimTarget {
  readonly binDir: string;
  readonly nodePath: string;
  readonly entryPath: string;
  readonly gitenvFile: string;
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export function shimScript(target: ShimTarget, mode: "helper" | "gh"): string {
  const command = [target.nodePath, target.entryPath, "--file", target.gitenvFile].map(quote);
  return [
    "#!/bin/sh",
    SHIM_MARKER,
    `exec ${command.join(" ")}${mode === "gh" ? " gh" : ""} "$@"`,
    "",
  ].join("\n");
}

function isShim(file: string): boolean {
  try {
    return NodeFS.readFileSync(file, "utf8").includes(SHIM_MARKER);
  } catch {
    return false;
  }
}

/**
 * Write both shims. An existing `gh` that is not ours moves to `gh.bak`, unless a `gh.bak`
 * already exists, in which case the gh shim is skipped and the returned lines say why.
 */
export function installGitShims(target: ShimTarget): ReadonlyArray<string> {
  const notes: Array<string> = [];
  NodeFS.mkdirSync(target.binDir, { recursive: true });
  const write = (name: string, mode: "helper" | "gh") => {
    const file = NodePath.join(target.binDir, name);
    NodeFS.writeFileSync(file, shimScript(target, mode), { mode: 0o755 });
    NodeFS.chmodSync(file, 0o755);
  };
  write(HELPER_NAME, "helper");
  notes.push(`Wrote ${NodePath.join(target.binDir, HELPER_NAME)}.`);

  const gh = NodePath.join(target.binDir, "gh");
  const backup = `${gh}.bak`;
  if (NodeFS.existsSync(gh) && !isShim(gh)) {
    if (NodeFS.existsSync(backup)) {
      notes.push(
        `Left ${gh} alone: it is not a T3o shim and ${backup} already exists. Move one of them and re-run.`,
      );
      return notes;
    }
    NodeFS.renameSync(gh, backup);
    notes.push(`Moved your existing ${gh} to ${backup}; uninstall puts it back.`);
  }
  write("gh", "gh");
  notes.push(`Wrote ${gh}.`);
  return notes;
}

/** Remove the shims (only files carrying the marker) and restore a `gh.bak`. */
export function uninstallGitShims(binDir: string): ReadonlyArray<string> {
  const notes: Array<string> = [];
  for (const name of [HELPER_NAME, "gh"]) {
    const file = NodePath.join(binDir, name);
    if (isShim(file)) {
      NodeFS.rmSync(file);
      notes.push(`Removed ${file}.`);
    }
  }
  const gh = NodePath.join(binDir, "gh");
  const backup = `${gh}.bak`;
  if (!NodeFS.existsSync(gh) && NodeFS.existsSync(backup)) {
    NodeFS.renameSync(backup, gh);
    notes.push(`Restored ${gh} from ${backup}.`);
  }
  return notes;
}

/**
 * The gitconfig lines to add when `helpers` (from `git config --global --get-all
 * credential.https://github.com.helper`) does not yet name the T3o helper, else null.
 */
export function gitconfigAdvice(helpers: ReadonlyArray<string>): string | null {
  if (helpers.some((helper) => helper.includes(HELPER_NAME))) return null;
  return [
    "To have git in any terminal sign in with the same token, add to ~/.gitconfig:",
    "",
    '[credential "https://github.com"]',
    "\thelper =",
    `\thelper = !${HELPER_NAME}`,
    "\thelper = !gh auth git-credential",
    "\tuseHttpPath = true",
  ].join("\n");
}
