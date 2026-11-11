#!/usr/bin/env node
/**
 * Move a systemd T3o install to the latest release: `pnpm run t3o-update [--check]`.
 * Settings come from the installed unit file, the running build from its stamp, and the
 * switch is checkout → pnpm install → the release's own `t3o-service.mjs install`.
 * See docs/t3o/install.md#update-to-a-new-release.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadlinePromises from "node:readline/promises";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import {
  INSIDE_UNIT_MESSAGE,
  STAMP_FILE,
  T3O_LATEST_RELEASE_API,
  T3O_REPO_URL,
  changedPaths,
  checkExitCode,
  childPath,
  decideUpdate,
  parseT3oTag,
  parseUnitFile,
  porcelainIsDirty,
  readStamp,
  relationOf,
  runningInsideUnit,
} from "./lib/t3o-release.ts";

const repoRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));

const { values } = NodeUtil.parseArgs({
  // pnpm forwards a bare `--` separator; see t3o-service.mjs.
  args: process.argv.slice(2).filter((argument) => argument !== "--"),
  options: {
    check: { type: "boolean", default: false },
    to: { type: "string" },
    force: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    unit: { type: "string", default: "t3o" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(
    [
      "Usage: pnpm run t3o-update [flags]",
      "",
      "  --check         Report only. Exits 10 when a newer release is available",
      "  --to <tag>      Install this release instead of the latest (e.g. t3o0.1.8.1)",
      "  --force         Install even when it is not newer (downgrade or reinstall)",
      "  --yes           Do not ask for confirmation",
      "  --unit <name>   systemd unit to update, without .service (default t3o)",
    ].join("\n"),
  );
  process.exit(0);
}

function fail(message) {
  console.error(`\nt3o-update: ${message}`);
  process.exit(1);
}

const log = (message) => console.log(`[t3o-update] ${message}`);

function git(args, { allowFailure = false } = {}) {
  const result = NodeChildProcess.spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    fail(`git ${args.join(" ")} failed:\n${(result.stderr ?? "").trim()}`);
  }
  return result.status === 0 ? result.stdout.trim() : null;
}

const capture = (bin, args) =>
  (NodeChildProcess.spawnSync(bin, args, { encoding: "utf8" }).stdout ?? "").trim();

if (values.to !== undefined && parseT3oTag(values.to) === null) {
  fail(`${values.to} is not a T3o release tag (expected e.g. t3o0.1.8.1).`);
}

// 1. Stopping the unit from inside it would kill this script with the service down.
if (!values.check && runningInsideUnit(values.unit)) fail(INSIDE_UNIT_MESSAGE);

// 2. Settings, read back from the installed unit.
const unitName = `${values.unit}.service`;
const unitPath = `/etc/systemd/system/${unitName}`;
if (!NodeFS.existsSync(unitPath)) {
  fail(
    [
      `no installed service: ${unitPath} does not exist.`,
      "Install one with `pnpm run install-t3o-service`, or, without systemd, follow the manual",
      "steps in docs/t3o/install.md#update-to-a-new-release.",
    ].join("\n"),
  );
}
let settings;
try {
  settings = parseUnitFile(NodeFS.readFileSync(unitPath, "utf8"));
} catch (error) {
  fail(
    `cannot read ${unitPath}: ${error instanceof Error ? error.message : String(error)}. Re-run \`pnpm run install-t3o-service\` to rewrite it.`,
  );
}

// The parent env with only PATH changed: HOME, the tty and SSH_AUTH_SOCK stay for sudo and git.
const childEnv = {
  ...process.env,
  PATH: childPath(settings.node, settings.path, process.env.PATH),
};

// 3. What is running.
const runningStamp = readStamp(NodePath.join(settings.appDir, "dist", STAMP_FILE));
const running = runningStamp?.commit ?? git(["rev-parse", "HEAD"]);
if (!runningStamp) {
  log(
    `${settings.appDir} has no build stamp (installed before releases); assuming this clone's HEAD.`,
  );
}
const runningLabel = runningStamp ? `T3o ${runningStamp.version}` : `commit ${running.slice(0, 7)}`;

// 4. The release to move to.
async function latestReleaseTag() {
  let response;
  try {
    response = await fetch(T3O_LATEST_RELEASE_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "t3o-update" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    fail(`could not reach GitHub: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 404) fail("there is no T3o release yet.");
  if (!response.ok) fail(`GitHub answered ${response.status} for the latest release.`);
  const tag = (await response.json())?.tag_name;
  if (typeof tag !== "string" || parseT3oTag(tag) === null) {
    fail(`the latest release (${String(tag)}) is not a T3o tag.`);
  }
  return tag;
}

const targetTag = values.to ?? (await latestReleaseTag());
// The canonical URL, whatever `origin` points at.
git([
  "fetch",
  "--quiet",
  "--no-tags",
  T3O_REPO_URL,
  `+refs/tags/${targetTag}:refs/tags/${targetTag}`,
]);
const target = git(["rev-parse", `${targetTag}^{commit}`]);

// 5. Decide.
const isAncestor = (ancestor, descendant) =>
  NodeChildProcess.spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: repoRoot,
  }).status === 0;
const relation = relationOf({
  running,
  target,
  runningDirty: runningStamp?.dirty ?? false,
  isAncestor,
});
const describeRelation = {
  equal: `${runningLabel} is up to date with ${targetTag}.`,
  behind: `${runningLabel} is behind ${targetTag}: an update is available.`,
  ahead: `${runningLabel} is ahead of ${targetTag}.`,
  diverged: `${runningLabel} is not on ${targetTag}'s history (a dev or modified build).`,
}[relation];

if (values.check) {
  console.log(describeRelation);
  process.exit(checkExitCode(relation));
}

const decision = decideUpdate({
  relation,
  explicitTarget: values.to !== undefined,
  force: values.force,
});
if (decision.kind === "none") {
  console.log(
    decision.reason === "up-to-date"
      ? describeRelation
      : `${describeRelation} Nothing to do; --force installs ${targetTag} anyway.`,
  );
  process.exit(0);
}
if (decision.kind === "needs-force") {
  fail(`${describeRelation} Installing ${targetTag} would go backwards; add --force to do it.`);
}

// 6. Preflight.
const porcelain = git(["status", "--porcelain", "--untracked-files=no"]);
if (porcelainIsDirty(porcelain)) {
  fail(
    `this clone has local changes; commit or stash them first:\n${changedPaths(porcelain).join("\n")}`,
  );
}
if (porcelain !== "") {
  log("Resetting pnpm-lock.yaml, which `pnpm install` rewrote.");
  git(["checkout", "--", "pnpm-lock.yaml"]);
}

const warnings = [
  `Updating ${unitName}: ${runningLabel} → ${targetTag}`,
  `  data: ${settings.home}   app: ${settings.appDir}   listen: ${settings.host}:${settings.port}`,
  "In-flight agent turns will be interrupted when the service restarts, and sudo will prompt.",
  ...(decision.downgrade
    ? [
        "",
        `WARNING: ${targetTag} is not newer than what is running. Database migrations are not`,
        `reversed, so back up ${NodePath.join(settings.home, "userdata")} before going on.`,
      ]
    : []),
];
console.log(`\n${warnings.join("\n")}\n`);
if (!values.yes) {
  if (!process.stdin.isTTY) fail("not a terminal; re-run with --yes to confirm.");
  const prompt = NodeReadlinePromises.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await prompt.question("Continue? [y/N] ");
  prompt.close();
  if (!/^y(es)?$/i.test(answer.trim())) fail("cancelled. Nothing was changed.");
}

// 7. Switch.
const previousBranch = git(["symbolic-ref", "--short", "-q", "HEAD"], { allowFailure: true });
const previousTag = git(["describe", "--tags", "--exact-match", "--match", "t3o[0-9]*", "HEAD"], {
  allowFailure: true,
});
const previousCommit = git(["rev-parse", "HEAD"]);
const recovery =
  previousTag !== null
    ? `pnpm run t3o-update --to ${previousTag} --force`
    : `git ${previousBranch ? `switch ${previousBranch}` : `checkout ${previousCommit}`} && pnpm install && pnpm run install-t3o-service -- --home ${settings.home} --app-dir ${settings.appDir} --host ${settings.host} --port ${settings.port} --unit ${values.unit}`;

function report(reason) {
  const active = capture("systemctl", ["is-active", unitName]) || "unknown";
  const stamp = readStamp(NodePath.join(settings.appDir, "dist", STAMP_FILE));
  fail(
    [
      `the update to ${targetTag} did not finish: ${reason}`,
      `  ${unitName} is ${active}, serving ${stamp ? `T3o ${stamp.version} (${stamp.commit.slice(0, 7)})` : "no stamped build"}.`,
      "  The clone may be on the new tag. To go back:",
      `    ${recovery}`,
    ].join("\n"),
  );
}

function step(label, bin, args) {
  log(label);
  const result = NodeChildProcess.spawnSync(bin, args, {
    cwd: repoRoot,
    env: childEnv,
    stdio: "inherit",
  });
  if (result.error) report(`${bin} failed to start: ${result.error.message}`);
  if (result.status !== 0) report(`${bin} ${args.join(" ")} exited ${result.status}`);
}

step(`Checking out ${targetTag}...`, "git", ["checkout", "--quiet", "--detach", targetTag]);
step("Installing dependencies (pnpm install)...", "pnpm", ["install"]);
step(`Building and installing ${targetTag}...`, settings.node, [
  NodePath.join(repoRoot, "scripts/t3o-service.mjs"),
  "install",
  "--home",
  settings.home,
  "--app-dir",
  settings.appDir,
  "--host",
  settings.host,
  "--port",
  settings.port,
  "--unit",
  values.unit,
]);

// 8. Verify: the install can exit 0 without starting anything (e.g. the port is held).
const active = capture("systemctl", ["is-active", unitName]);
const installed = readStamp(NodePath.join(settings.appDir, "dist", STAMP_FILE));
if (active !== "active") report(`${unitName} is ${active || "unknown"}, not active`);
if (installed?.commit !== target) report(`${settings.appDir} is not serving ${targetTag}'s build`);

console.log(
  [
    "",
    `${runningLabel} → T3o ${installed.version}`,
    `This clone is on a detached ${targetTag}; \`git switch t3o\` goes back to tracking the branch.`,
  ].join("\n"),
);
