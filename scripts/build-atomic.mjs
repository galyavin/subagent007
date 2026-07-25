#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
const CANDIDATE_MARKER = ".subagent007-build-candidate.json";
const LEASE_PATTERN = /^\.subagent007-server-(\d+)\.lease\.json$/;
const RELEASE_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{9}Z-[a-f0-9]{8}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

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

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(filePath, content, mode) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  let handle;
  try {
    handle = await fs.open(tmpPath, "w", mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmpPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await handle?.close();
    await fs.rm(tmpPath, { force: true });
  }
}

function requireExactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has an ambiguous shape`);
  }
}

function requireReleaseId(value, label) {
  if (typeof value !== "string" || !RELEASE_ID_PATTERN.test(value)) {
    throw new Error(`${label} must name one build release`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function requireRetention(value) {
  if (value !== "retained" && value !== "published" && value !== "abandoned") {
    throw new Error("candidate retention marker is invalid");
  }
  return value;
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function requireAbsoluteLocator(value, option) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${option} requires an absolute locator path`);
  }
  return path.resolve(value);
}

async function releaseCustodyPath() {
  try {
    return await fs.realpath(RELEASES_DIR);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    try {
      return path.join(await fs.realpath(DIST_DIR), "releases");
    } catch (distError) {
      if (distError?.code !== "ENOENT") throw distError;
      return path.join(await fs.realpath(PROJECT_ROOT), "dist", "releases");
    }
  }
}

async function validateDetachedLocator(locator, option) {
  const parent = await fs.realpath(path.dirname(locator));
  const stats = await fs.lstat(locator).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (stats && !stats.isFile()) {
    throw new Error(`${option} locator must be a regular file when it already exists`);
  }
  const canonicalLocator = path.join(parent, path.basename(locator));
  if (isWithin(await releaseCustodyPath(), canonicalLocator)) {
    throw new Error(`${option} locator must be detached from release custody`);
  }
}

async function sha256(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function compareCodePoints(left, right) {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const difference = leftPoints[index].codePointAt(0) - rightPoints[index].codePointAt(0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

async function releaseTree(releaseDir) {
  const entries = [];
  async function visit(relativeDir) {
    const directory = path.join(releaseDir, relativeDir);
    const children = await fs.readdir(directory, { withFileTypes: true });
    for (const child of children.sort((left, right) => compareCodePoints(left.name, right.name))) {
      const relativePath = path.join(relativeDir, child.name).split(path.sep).join("/");
      const absolutePath = path.join(releaseDir, relativePath);
      const stats = await fs.lstat(absolutePath);
      if (relativePath === CANDIDATE_MARKER) continue;
      if (relativeDir === "" && LEASE_PATTERN.test(child.name) && stats.isFile()) continue;
      const mode = stats.mode & 0o777;
      if (stats.isDirectory()) {
        entries.push({ path: relativePath, type: "directory", mode });
        await visit(relativePath);
      } else if (stats.isFile()) {
        entries.push({ path: relativePath, type: "file", mode, bytes: stats.size, sha256: await sha256(absolutePath) });
      } else {
        throw new Error(`release contains an unsupported entry: ${relativePath}`);
      }
    }
  }
  await visit("");
  return entries;
}

function treeDigest(entries) {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function validateTreeEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("candidate manifest must describe a non-empty release tree");
  }
  let previous = "";
  for (const entry of entries) {
    requireExactKeys(
      entry,
      entry?.type === "file" ? ["path", "type", "mode", "bytes", "sha256"] : ["path", "type", "mode"],
      "candidate tree entry",
    );
    if (typeof entry.path !== "string" || entry.path === "" || path.posix.isAbsolute(entry.path) || entry.path.includes("..") || entry.path === CANDIDATE_MARKER) {
      throw new Error("candidate tree entry path is invalid");
    }
    if (compareCodePoints(entry.path, previous) <= 0) throw new Error("candidate tree entries must be strictly sorted");
    previous = entry.path;
    if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {
      throw new Error("candidate tree entry mode is invalid");
    }
    if (entry.type === "file") {
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error("candidate file size is invalid");
      requireSha256(entry.sha256, "candidate file digest");
    } else if (entry.type !== "directory") {
      throw new Error("candidate tree entry type is invalid");
    }
  }
}

function markerPath(releaseDir) {
  return path.join(releaseDir, CANDIDATE_MARKER);
}

async function readCandidateMarker(releaseIdValue) {
  const id = requireReleaseId(releaseIdValue, "candidate release id");
  const releaseDir = path.join(RELEASES_DIR, id);
  if (!(await fs.lstat(releaseDir)).isDirectory()) {
    throw new Error("candidate release directory must be a directory");
  }
  const markerFile = markerPath(releaseDir);
  if (!(await fs.lstat(markerFile)).isFile()) {
    throw new Error("candidate marker must be a regular file");
  }
  const marker = JSON.parse(await fs.readFile(markerFile, "utf8"));
  requireExactKeys(marker, ["release_id", "retention", "tree_sha256", "tree"], "candidate manifest");
  if (requireReleaseId(marker.release_id, "candidate manifest release id") !== id) {
    throw new Error("candidate manifest does not match its release directory");
  }
  const retention = requireRetention(marker.retention);
  const digest = requireSha256(marker.tree_sha256, "candidate tree digest");
  validateTreeEntries(marker.tree);
  if (treeDigest(marker.tree) !== digest) {
    throw new Error("candidate manifest tree digest is invalid");
  }
  const observedTree = await releaseTree(releaseDir);
  if (JSON.stringify(observedTree) !== JSON.stringify(marker.tree) || treeDigest(observedTree) !== digest) {
    throw new Error("candidate release tree no longer matches its manifest");
  }
  return { id, releaseDir, marker, retention, digest };
}

async function readLocator(locator) {
  const parsed = JSON.parse(await fs.readFile(locator, "utf8"));
  requireExactKeys(parsed, ["release_id", "tree_sha256"], "candidate locator");
  return {
    id: requireReleaseId(parsed.release_id, "candidate locator release id"),
    digest: requireSha256(parsed.tree_sha256, "candidate locator tree digest"),
  };
}

async function candidateFromLocator(locator) {
  const reference = await readLocator(locator);
  const candidate = await readCandidateMarker(reference.id);
  if (candidate.digest !== reference.digest) {
    throw new Error("candidate locator does not match the release-local manifest");
  }
  return candidate;
}

async function writeCandidateMarker(candidate, retention) {
  const marker = {
    release_id: candidate.id,
    retention,
    tree_sha256: candidate.digest,
    tree: candidate.marker.tree,
  };
  await atomicWrite(markerPath(candidate.releaseDir), `${JSON.stringify(marker)}\n`, 0o644);
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

async function candidateRetention(releaseIdValue) {
  const releaseDir = path.join(RELEASES_DIR, releaseIdValue);
  const marker = markerPath(releaseDir);
  const stats = await fs.lstat(marker).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stats) return undefined;
  if (!stats.isFile()) throw new Error(`candidate marker is not a regular file: ${releaseIdValue}`);
  return (await readCandidateMarker(releaseIdValue)).retention;
}

async function cleanupInactiveReleases(currentId) {
  const entries = await fs.readdir(RELEASES_DIR, { withFileTypes: true }).catch(() => []);
  const releases = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  const retentions = new Map();
  for (const id of releases) {
    retentions.set(id, await candidateRetention(id));
  }
  const protectedIds = new Set([currentId, releases.find((id) => id !== currentId)].filter(Boolean));
  for (const id of releases) {
    if (id === currentId) continue;
    const retention = retentions.get(id);
    if (retention === "retained") continue;
    if (protectedIds.has(id) && retention !== "abandoned") continue;
    const releaseDir = path.join(RELEASES_DIR, id);
    if (!(await liveReleaseLease(releaseDir))) {
      await fs.rm(releaseDir, { recursive: true, force: true });
    }
  }
}

function wrapperBody(entry) {
  const executable = entry === "server.js" || entry === "piChild.js";
  return executable
    ? `#!/usr/bin/env node\nimport "./current/${entry}";\n`
    : `export * from "./current/${entry}";\n`;
}

async function publishWrappers(releaseDir) {
  const entries = (await fs.readdir(releaseDir)).filter((entry) => entry.endsWith(".js"));
  const expected = new Set(entries);
  let removed = false;
  for (const entry of (await fs.readdir(DIST_DIR)).filter((name) => name.endsWith(".js"))) {
    if (expected.has(entry)) continue;
    const wrapperPath = path.join(DIST_DIR, entry);
    const stats = await fs.lstat(wrapperPath);
    if (!stats.isFile() && !stats.isSymbolicLink()) {
      throw new Error(`obsolete stable wrapper is not a file: ${entry}`);
    }
    await fs.rm(wrapperPath, { force: true });
    removed = true;
  }
  if (removed) await syncDirectory(DIST_DIR);
  for (const entry of entries) {
    const executable = entry === "server.js" || entry === "piChild.js";
    await atomicWrite(path.join(DIST_DIR, entry), wrapperBody(entry), executable ? 0o755 : 0o644);
  }
}

async function wrappersMatch(releaseDir) {
  const entries = (await fs.readdir(releaseDir)).filter((entry) => entry.endsWith(".js")).sort();
  const publishedEntries = (await fs.readdir(DIST_DIR)).filter((entry) => entry.endsWith(".js")).sort();
  if (JSON.stringify(publishedEntries) !== JSON.stringify(entries)) return false;
  for (const entry of entries) {
    try {
      if ((await fs.readFile(path.join(DIST_DIR, entry), "utf8")) !== wrapperBody(entry)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function currentReleaseId() {
  try {
    return path.basename(await fs.readlink(CURRENT_LINK));
  } catch {
    return undefined;
  }
}

async function switchCurrent(id) {
  const nextLink = path.join(DIST_DIR, `.current-${id}-${randomBytes(3).toString("hex")}`);
  try {
    await fs.symlink(path.join("releases", id), nextLink, "dir");
    await fs.rename(nextLink, CURRENT_LINK);
    await syncDirectory(DIST_DIR);
  } finally {
    await fs.rm(nextLink, { force: true });
  }
}

async function compileRelease() {
  const id = releaseId();
  const stagingDir = path.join(PROJECT_ROOT, `.dist-staging-${id}`);
  const releaseDir = path.join(RELEASES_DIR, id);
  await fs.mkdir(RELEASES_DIR, { recursive: true });
  try {
    await execFileAsync(
      process.execPath,
      [path.join(PROJECT_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json", "--outDir", stagingDir],
      { cwd: PROJECT_ROOT, maxBuffer: 10 * 1024 * 1024 },
    );
    await fs.rename(stagingDir, releaseDir);
    await syncDirectory(RELEASES_DIR);
    return { id, releaseDir };
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}

async function build() {
  const release = await compileRelease();
  await switchCurrent(release.id);
  await publishWrappers(release.releaseDir);
  await cleanupInactiveReleases(release.id);
}

async function stage(locator) {
  await validateDetachedLocator(locator, "--manifest-out");
  await cleanupInactiveReleases(await currentReleaseId());
  let release;
  try {
    release = await compileRelease();
    const tree = await releaseTree(release.releaseDir);
    const candidate = {
      id: release.id,
      releaseDir: release.releaseDir,
      marker: { tree },
      digest: treeDigest(tree),
    };
    await writeCandidateMarker(candidate, "retained");
    await atomicWrite(locator, `${JSON.stringify({ release_id: release.id, tree_sha256: candidate.digest })}\n`, 0o644);
  } catch (error) {
    if (release) await fs.rm(release.releaseDir, { recursive: true, force: true });
    throw error;
  }
}

async function verifyCandidate(locator) {
  await validateDetachedLocator(locator, "--verify-manifest");
  const candidate = await candidateFromLocator(locator);
  if (candidate.retention !== "retained") {
    throw new Error("only retained candidates can be verified for pre-import");
  }
  process.stdout.write(`${JSON.stringify({ release_id: candidate.id, release_path: candidate.releaseDir, tree_sha256: candidate.digest })}\n`);
}

async function publishCandidate(locator) {
  await validateDetachedLocator(locator, "--publish-manifest");
  const candidate = await candidateFromLocator(locator);
  if (candidate.retention === "abandoned") {
    throw new Error("abandoned candidates cannot be published");
  }
  await switchCurrent(candidate.id);
  await publishWrappers(candidate.releaseDir);
  if ((await currentReleaseId()) !== candidate.id || !(await wrappersMatch(candidate.releaseDir))) {
    throw new Error("candidate publication did not reach a readiness-safe state");
  }
  if (candidate.retention === "retained" && (await liveReleaseLease(candidate.releaseDir))) {
    await writeCandidateMarker(candidate, "published");
  }
}

async function abandonCandidate(locator) {
  await validateDetachedLocator(locator, "--abandon-manifest");
  const candidate = await candidateFromLocator(locator);
  if (candidate.retention === "published") {
    throw new Error("published candidates cannot be abandoned");
  }
  if (candidate.retention === "retained") {
    await writeCandidateMarker(candidate, "abandoned");
  }
}

async function cleanInactive() {
  await cleanupInactiveReleases(await currentReleaseId());
}

function parseOperation(argv) {
  if (argv.length === 0) return { kind: "build" };
  if (argv.length === 1 && argv[0] === "--clean-inactive") return { kind: "clean" };
  if (argv.length === 3 && argv[1] === "--manifest-out" && argv[0] === "--stage-only") {
    return { kind: "stage", locator: requireAbsoluteLocator(argv[2], "--manifest-out") };
  }
  if (argv.length === 2 && argv[0] === "--verify-manifest") {
    return { kind: "verify", locator: requireAbsoluteLocator(argv[1], "--verify-manifest") };
  }
  if (argv.length === 2 && argv[0] === "--publish-manifest") {
    return { kind: "publish", locator: requireAbsoluteLocator(argv[1], "--publish-manifest") };
  }
  if (argv.length === 2 && argv[0] === "--abandon-manifest") {
    return { kind: "abandon", locator: requireAbsoluteLocator(argv[1], "--abandon-manifest") };
  }
  throw new Error("expected one unambiguous build operation");
}

const operation = parseOperation(process.argv.slice(2));
if (operation.kind === "build") {
  await withBuildLock(build);
} else if (operation.kind === "clean") {
  await withBuildLock(cleanInactive);
} else if (operation.kind === "stage") {
  await withBuildLock(() => stage(operation.locator));
} else if (operation.kind === "verify") {
  await withBuildLock(() => verifyCandidate(operation.locator));
} else if (operation.kind === "publish") {
  await withBuildLock(() => publishCandidate(operation.locator));
} else {
  await withBuildLock(() => abandonCandidate(operation.locator));
}
