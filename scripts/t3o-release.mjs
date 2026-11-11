#!/usr/bin/env node
/**
 * Cut a T3o release: `pnpm run t3o-release [--dry-run]`. Tags the pushed `t3o` HEAD as
 * `t3o<upstream base>.<n>` and publishes a GitHub Release with gh. No Actions, no assets:
 * the tagged source is the release. See docs/t3o/releasing.md.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import {
  STAMP_FILE,
  T3O_REPO,
  changedPaths,
  formatBase,
  latestT3oTag,
  nextT3oTag,
  parseT3oTag,
  parseUnitFile,
  porcelainIsDirty,
  probeHost,
  readStamp,
  selectUpstreamBase,
} from "./lib/t3o-release.ts";

const repoRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));

const { values } = NodeUtil.parseArgs({
  args: process.argv.slice(2).filter((argument) => argument !== "--"),
  options: {
    "dry-run": { type: "boolean", default: false },
    "skip-gate": { type: "boolean", default: false },
    unit: { type: "string", default: "t3o" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(
    [
      "Usage: pnpm run t3o-release [flags]",
      "",
      "  --dry-run       Run the checks and print the tag and release commands",
      "  --skip-gate     Do not require your installed service to be running HEAD",
      "  --unit <name>   The service the dogfood gate checks (default t3o)",
    ].join("\n"),
  );
  process.exit(0);
}

const dryRun = values["dry-run"];

function fail(message) {
  console.error(`\nt3o-release: ${message}`);
  process.exit(1);
}

const log = (message) => console.log(`[t3o-release] ${message}`);

function run(bin, args, { allowFailure = false, quiet = false } = {}) {
  const result = NodeChildProcess.spawnSync(bin, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: quiet ? ["ignore", "pipe", "pipe"] : ["inherit", "pipe", "inherit"],
  });
  if (result.error) fail(`${bin} failed to start: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    fail(`${bin} ${args.join(" ")} exited ${result.status}\n${(result.stderr ?? "").trim()}`);
  }
  return result.status === 0 ? (result.stdout ?? "").trim() : null;
}

const git = (args, options) => run("git", args, options);
const lines = (output) => (output ?? "").split("\n").filter(Boolean);

// 1. Preflight.
const porcelain = git(["status", "--porcelain", "--untracked-files=no"]);
if (porcelainIsDirty(porcelain)) {
  fail(`the tree has local changes:\n${changedPaths(porcelain).join("\n")}`);
}
if (git(["symbolic-ref", "--short", "-q", "HEAD"], { allowFailure: true }) !== "t3o") {
  fail("releases are cut from the t3o branch. `git switch t3o` first.");
}
if (git(["remote", "get-url", "upstream"], { allowFailure: true, quiet: true }) === null) {
  fail(
    "no `upstream` remote, which the T3 Code base version comes from. Add it:\n  git remote add upstream https://github.com/pingdotgg/t3code.git",
  );
}
log("Fetching origin and upstream tags...");
git(["fetch", "--quiet", "origin", "--tags"]);
git(["fetch", "--quiet", "upstream", "--tags"]);
const head = git(["rev-parse", "HEAD"]);
if (head !== git(["rev-parse", "origin/t3o"])) {
  fail("HEAD is not origin/t3o. Pull or push first, so the release is what users fetch.");
}
if (run("gh", ["auth", "status"], { allowFailure: true, quiet: true }) === null) {
  fail("gh is not signed in. Run `gh auth login`.");
}

// 2. Resolve the tag, or resume one a previous run created.
const releaseExists = (tag) =>
  run("gh", ["release", "view", tag, "--repo", T3O_REPO], { allowFailure: true, quiet: true }) !==
  null;

const existingHeadTag = latestT3oTag(lines(git(["tag", "--points-at", "HEAD"])));
let tag;
if (existingHeadTag !== null) {
  if (releaseExists(existingHeadTag)) {
    console.log(`HEAD is already released as ${existingHeadTag}. Nothing to do.`);
    process.exit(0);
  }
  tag = existingHeadTag;
  log(`HEAD is tagged ${tag} but has no GitHub Release; resuming.`);
} else {
  const base = selectUpstreamBase(lines(git(["tag", "--merged", "HEAD", "--list", "v*"])));
  if (base === null) fail("no stable upstream vX.Y.Z tag is contained in HEAD.");
  tag = nextT3oTag(base, lines(git(["tag", "--list", "t3o*"])));
}
const parsed = parseT3oTag(tag);
const base = formatBase(parsed.base);
const previous = latestT3oTag(
  lines(git(["tag", "--merged", "HEAD", "--list", "t3o*"])).filter((entry) => entry !== tag),
);
log(`Release ${tag} (T3 Code v${base})${previous ? `, notes since ${previous}` : ", the first"}.`);

// 3. Gate: the maintainer's own service runs exactly this commit.
async function dogfoodGate() {
  const unitPath = `/etc/systemd/system/${values.unit}.service`;
  const skipHint = "Install HEAD with `pnpm run install-t3o-service`, or pass --skip-gate.";
  if (!NodeFS.existsSync(unitPath)) fail(`no ${unitPath} to check. ${skipHint}`);
  let settings;
  try {
    settings = parseUnitFile(NodeFS.readFileSync(unitPath, "utf8"));
  } catch (error) {
    fail(`cannot read ${unitPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const stamp = readStamp(NodePath.join(settings.appDir, "dist", STAMP_FILE));
  if (stamp?.commit !== head || stamp.dirty) {
    fail(
      `${values.unit}.service is running ${stamp ? `${stamp.commit.slice(0, 7)}${stamp.dirty ? " (dirty)" : ""}` : "an unstamped build"}, not a clean ${head.slice(0, 7)}. ${skipHint}`,
    );
  }
  const url = `http://${probeHost(settings.host)}:${settings.port}/`;
  const status = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    .then((response) => response.status)
    .catch(() => 0);
  if (status !== 200) fail(`${url} answered ${status || "nothing"}, not 200. ${skipHint}`);
  log(`Gate passed: ${values.unit}.service serves ${head.slice(0, 7)} at ${url}.`);
}

if (values["skip-gate"]) log("Skipping the dogfood gate (--skip-gate).");
else await dogfoodGate();

// 4–5. Tag, push only that tag (never --tags: it would copy upstream's tags to origin), publish.
const title = `T3o ${base}.${parsed.n}`;
const notes = `Based on T3 Code v${base}.`;
const tagExists = git(["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
  allowFailure: true,
  quiet: true,
});
const commands = [
  ...(tagExists ? [] : [["git", "tag", "-a", tag, "-m", `${title} (T3 Code v${base})`]]),
  ["git", "push", "origin", `refs/tags/${tag}`],
  [
    "gh",
    "release",
    "create",
    tag,
    "--repo",
    T3O_REPO,
    "--verify-tag",
    "--latest",
    "--title",
    title,
    ...(previous
      ? ["--notes", notes, "--generate-notes", "--notes-start-tag", previous]
      : ["--notes", `${notes}\n\nThe first T3o release.`]),
  ],
];

if (dryRun) {
  console.log("\nDry run. Would run:");
  for (const [bin, ...args] of commands) {
    console.log(
      `  ${bin} ${args.map((arg) => (/[\s"'()]/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`,
    );
  }
  process.exit(0);
}

for (const [bin, ...args] of commands) {
  const status = NodeChildProcess.spawnSync(bin, args, { cwd: repoRoot, stdio: "inherit" }).status;
  if (status !== 0) {
    fail(
      `${bin} ${args.slice(0, 2).join(" ")} failed. Fix it and re-run; the script resumes from the tag.`,
    );
  }
}

console.log(
  [
    "",
    `Released ${tag}: https://github.com/${T3O_REPO}/releases/tag/${tag}`,
    `Re-run \`pnpm run install-t3o-service\` so your own service shows ${tag}.`,
  ].join("\n"),
);
