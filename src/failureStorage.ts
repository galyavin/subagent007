import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { processIsDefinitelyGone } from "./processLiveness.js";

const DEFAULT_FAILURE_STORAGE_MAX_BYTES = 64 * 1024 * 1024;
const LOCK_RETRY_MS = 10;
const LOCK_RETRIES = 100;

interface LockOwner {
  schema_version: 2;
  owner_id: string;
  pid: number;
}

export interface FailureArchiveResult {
  archived: boolean;
  reason?: string;
  log_path: string;
  archive_path?: string;
  summary_path?: string;
  raw_archive_retained?: boolean;
}

export function failureStorageMaxBytes(): number {
  const configured = process.env.SUBAGENT007_FAILURE_STORAGE_MAX_BYTES?.trim();
  if (configured === undefined || configured === "") return DEFAULT_FAILURE_STORAGE_MAX_BYTES;
  if (!/^\d+$/.test(configured)) return DEFAULT_FAILURE_STORAGE_MAX_BYTES;
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) ? parsed : DEFAULT_FAILURE_STORAGE_MAX_BYTES;
}

async function readLockOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const owner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")) as Partial<LockOwner>;
    return owner.schema_version === 2 && typeof owner.owner_id === "string" && typeof owner.pid === "number"
      ? owner as LockOwner
      : null;
  } catch {
    return null;
  }
}

async function pruneDeadLockCandidates(lockPath: string): Promise<void> {
  const parent = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.candidate-`;
  for (const entry of await fs.readdir(parent).catch(() => [])) {
    if (!entry.startsWith(prefix)) continue;
    const pid = Number(entry.slice(prefix.length).split("-")[0]);
    if (processIsDefinitelyGone(pid)) {
      await fs.rm(path.join(parent, entry), { recursive: true, force: true });
    }
  }
}

async function removeAbandonedLock(lockPath: string): Promise<boolean> {
  const owner = await readLockOwner(lockPath);
  if (!owner || !processIsDefinitelyGone(owner.pid)) return false;
  await fs.rm(lockPath, { recursive: true, force: true });
  return true;
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  await pruneDeadLockCandidates(lockPath);
  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt += 1) {
    const owner: LockOwner = { schema_version: 2, owner_id: randomBytes(12).toString("hex"), pid: process.pid };
    const candidatePath = `${lockPath}.candidate-${process.pid}-${owner.owner_id}`;
    try {
      await fs.mkdir(candidatePath);
      await fs.writeFile(path.join(candidatePath, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
      await fs.rename(candidatePath, lockPath);
      return async () => {
        const current = await readLockOwner(lockPath);
        if (current?.owner_id === owner.owner_id) {
          await fs.rm(lockPath, { recursive: true, force: true });
        }
      };
    } catch (error) {
      await fs.rm(candidatePath, { recursive: true, force: true });
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      if (await removeAbandonedLock(lockPath)) continue;
      if (attempt === LOCK_RETRIES) throw new Error("failure storage lock is busy");
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  throw new Error("failure storage lock is busy");
}

async function rawArchives(logPath: string): Promise<Array<{ path: string; bytes: number }>> {
  const archiveDir = path.join(path.dirname(logPath), "archives");
  const names = await fs.readdir(archiveDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const archives: Array<{ path: string; bytes: number }> = [];
  for (const name of names.filter((entry) => entry.startsWith("failures-") && entry.endsWith(".jsonl")).sort()) {
    const archivePath = path.join(archiveDir, name);
    const stat = await fs.stat(archivePath).catch(() => null);
    if (stat?.isFile()) archives.push({ path: archivePath, bytes: stat.size });
  }
  return archives;
}

async function rewriteNewestCompleteRecords(logPath: string, maxBytes: number): Promise<void> {
  const text = await fs.readFile(logPath, "utf8");
  const lines = text.split("\n").filter((line) => {
    if (!line) return false;
    try { JSON.parse(line); return true; } catch { return false; }
  });
  const retained: string[] = [];
  let retainedBytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const lineBytes = Buffer.byteLength(`${lines[index]}\n`);
    if (retainedBytes + lineBytes > maxBytes) break;
    retained.unshift(lines[index]);
    retainedBytes += lineBytes;
  }
  if (retained.length === 0) {
    await fs.rm(logPath, { force: true });
    return;
  }
  const temporaryPath = `${logPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(temporaryPath, `${retained.join("\n")}\n`, "utf8");
    await fs.rename(temporaryPath, logPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function enforceBudget(logPath: string, budget: number): Promise<void> {
  const archives = await rawArchives(logPath);
  const activeBytes = await fs.stat(logPath).then((stat) => stat.size, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return 0;
    throw error;
  });
  let archiveBytes = archives.reduce((total, archive) => total + archive.bytes, 0);
  for (const archive of archives) {
    if (archiveBytes + activeBytes <= budget) break;
    await fs.rm(archive.path, { force: true });
    archiveBytes -= archive.bytes;
  }
  if (activeBytes > 0 && archiveBytes + activeBytes > budget) {
    await rewriteNewestCompleteRecords(logPath, Math.max(0, budget - archiveBytes));
  }
}

function summarize(text: string): Record<string, unknown> {
  const summary: Record<string, unknown> & { total_records: number; parse_errors: number } = {
    archived_at: new Date().toISOString(), total_records: 0, by_schema_version: {}, by_tool: {},
    by_failure_class: {}, by_calibration_era: {}, by_cwd_class: {}, by_campaign_id: {}, by_day: {}, parse_errors: 0,
  };
  const increment = (field: string, key: string) => {
    const values = summary[field] as Record<string, number>;
    values[key] = (values[key] ?? 0) + 1;
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    summary.total_records += 1;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line) as Record<string, unknown>; } catch { summary.parse_errors += 1; continue; }
    increment("by_schema_version", String(record.schema_version ?? "missing"));
    increment("by_tool", String(record.tool ?? "missing"));
    increment("by_failure_class", String(record.failure_class ?? "missing"));
    increment("by_calibration_era", String(record.calibration_era ?? "legacy_unclassified"));
    const cwdClass = record.cwd_class ?? (() => {
      if (typeof record.cwd !== "string" || !record.cwd.trim()) return "missing";
      if (!path.isAbsolute(record.cwd)) return "relative";
      const cwd = path.normalize(record.cwd).replace(/^\/private\//, "/");
      const tmp = path.normalize(os.tmpdir()).replace(/^\/private\//, "/");
      return cwd === tmp || cwd.startsWith(`${tmp}${path.sep}`) ? "temp" : "absolute";
    })();
    increment("by_cwd_class", String(cwdClass));
    increment("by_campaign_id", String(record.campaign_id ?? "uncategorized"));
    increment("by_day", String(record.timestamp ?? "missing").slice(0, 10));
  }
  return summary;
}

export async function appendFailureRecord(logPath: string, line: string): Promise<void> {
  const budget = failureStorageMaxBytes();
  if (budget === 0) return;
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const release = await acquireLock(`${logPath}.lock`);
  try {
    await fs.appendFile(logPath, `${line}\n`, "utf8");
    await enforceBudget(logPath, budget);
  } finally {
    await release();
  }
}

export async function archiveFailureLog(logPath: string): Promise<FailureArchiveResult> {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const release = await acquireLock(`${logPath}.lock`);
  try {
    const archiveDir = path.join(path.dirname(logPath), "archives");
    await fs.mkdir(archiveDir, { recursive: true });
    const slug = `${new Date().toISOString().replace(/[:.]/g, "")}-${randomBytes(6).toString("hex")}`;
    const archivePath = path.join(archiveDir, `failures-${slug}.jsonl`);
    const summaryPath = path.join(archiveDir, `failures-${slug}.summary.json`);
    try {
      await fs.rename(logPath, archivePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { archived: false, reason: "failure log does not exist", log_path: logPath };
      }
      throw error;
    }
    const text = await fs.readFile(archivePath, "utf8");
    await fs.writeFile(summaryPath, `${JSON.stringify(summarize(text), null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await enforceBudget(logPath, failureStorageMaxBytes());
    const rawRetained = await fs.stat(archivePath).then(() => true, () => false);
    return {
      archived: true, log_path: logPath, archive_path: archivePath, summary_path: summaryPath,
      raw_archive_retained: rawRetained,
    };
  } finally {
    await release();
  }
}
