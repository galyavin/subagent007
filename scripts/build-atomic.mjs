#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const DIST_DIR = path.join(PROJECT_ROOT, "dist");
const RELEASES_DIR = path.join(DIST_DIR, "releases");
const CURRENT_LINK = path.join(DIST_DIR, "current");
const BUILD_LOCK = path.join(DIST_DIR, ".build-lock");
const LEASE_PATTERN = /^\.subagent007-server-(\d+)\.lease\.json$/;

function releaseId() {
  return `${new Date().toISOString().replace(/[:.]/g, "")}-${randomBytes(4).toString("hex")}`;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withBuildLock(run) {
  await fs.mkdir(DIST_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2_400; attempt += 1) {
    let acquired = false;
    try {
      await fs.mkdir(BUILD_LOCK);
      acquired = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await fs.readFile(path.join(BUILD_LOCK, "owner.json"), "utf8"));
        if (!processIsAlive(Number(owner.pid))) {
          await fs.rm(BUILD_LOCK, { recursive: true, force: true });
          continue;
        }
      } catch {
        const stats = await fs.stat(BUILD_LOCK).catch(() => undefined);
        if (stats && Date.now() - stats.mtimeMs > 5 * 60 * 1000) {
          await fs.rm(BUILD_LOCK, { recursive: true, force: true });
          continue;
        }
      }
      await sleep(50);
    }
    if (acquired) {
      try {
        await fs.writeFile(path.join(BUILD_LOCK, "owner.json"), `${JSON.stringify({ pid: process.pid })}\n`);
        return await run();
      } finally {
        await fs.rm(BUILD_LOCK, { recursive: true, force: true });
      }
    }
  }
  throw new Error("timed out waiting for atomic build publication lock");
}

async function atomicWrite(filePath, content, mode) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  try {
    await fs.writeFile(tmpPath, content, { encoding: "utf8", mode });
    await fs.rename(tmpPath, filePath);
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
}

async function liveReleaseLease(releaseDir) {
  const entries = await fs.readdir(releaseDir).catch(() => []);
  let live = false;
  for (const entry of entries) {
    const match = LEASE_PATTERN.exec(entry);
    if (!match) continue;
    const leasePath = path.join(releaseDir, entry);
    const pid = Number(match[1]);
    if (processIsAlive(pid)) {
      live = true;
    } else {
      await fs.rm(leasePath, { force: true });
    }
  }
  return live;
}

async function cleanupInactiveReleases(currentId) {
  const entries = await fs.readdir(RELEASES_DIR, { withFileTypes: true }).catch(() => []);
  const releases = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  const protectedIds = new Set([currentId, releases.find((id) => id !== currentId)].filter(Boolean));
  for (const id of releases) {
    if (protectedIds.has(id)) continue;
    const releaseDir = path.join(RELEASES_DIR, id);
    if (!(await liveReleaseLease(releaseDir))) {
      await fs.rm(releaseDir, { recursive: true, force: true });
    }
  }
}

async function publishWrappers(releaseDir) {
  const entries = (await fs.readdir(releaseDir)).filter((entry) => entry.endsWith(".js"));
  for (const entry of entries) {
    const executable = entry === "server.js" || entry === "piChild.js";
    const body = executable
      ? `#!/usr/bin/env node\nimport "./current/${entry}";\n`
      : `export * from "./current/${entry}";\n`;
    await atomicWrite(path.join(DIST_DIR, entry), body, executable ? 0o755 : 0o644);
  }
}

async function currentReleaseId() {
  try {
    return path.basename(await fs.readlink(CURRENT_LINK));
  } catch {
    return undefined;
  }
}

async function build() {
  const id = releaseId();
  const stagingDir = path.join(PROJECT_ROOT, `.dist-staging-${id}`);
  const releaseDir = path.join(RELEASES_DIR, id);
  const nextLink = path.join(DIST_DIR, `.current-${id}`);
  await fs.mkdir(RELEASES_DIR, { recursive: true });
  try {
    await execFileAsync(
      process.execPath,
      [path.join(PROJECT_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json", "--outDir", stagingDir],
      { cwd: PROJECT_ROOT, maxBuffer: 10 * 1024 * 1024 },
    );
    await fs.rename(stagingDir, releaseDir);
    await fs.symlink(path.join("releases", id), nextLink, "dir");
    await fs.rename(nextLink, CURRENT_LINK);
    await publishWrappers(releaseDir);
    await cleanupInactiveReleases(id);
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.rm(nextLink, { force: true });
  }
}

async function cleanInactive() {
  const currentId = await currentReleaseId();
  if (currentId) await cleanupInactiveReleases(currentId);
}

if (process.argv.includes("--clean-inactive")) {
  await withBuildLock(cleanInactive);
} else {
  await withBuildLock(build);
}
