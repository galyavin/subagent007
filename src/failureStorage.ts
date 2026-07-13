import fs from "node:fs/promises";
import path from "node:path";
import { processIsDefinitelyGone } from "./processLiveness.js";

const DEFAULT_FAILURE_STORAGE_MAX_BYTES = 64 * 1024 * 1024;
const LOCK_RETRY_MS = 10;
const LOCK_RETRIES = 100;

function failureStorageMaxBytes(): number {
  const configured = process.env.SUBAGENT007_FAILURE_STORAGE_MAX_BYTES?.trim();
  if (configured === undefined || configured === "") {
    return DEFAULT_FAILURE_STORAGE_MAX_BYTES;
  }
  if (!/^\d+$/.test(configured)) {
    return DEFAULT_FAILURE_STORAGE_MAX_BYTES;
  }
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) ? parsed : DEFAULT_FAILURE_STORAGE_MAX_BYTES;
}

async function removeAbandonedLock(lockPath: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")) as { pid?: unknown };
    if (typeof owner.pid !== "number" || !processIsDefinitelyGone(owner.pid)) {
      return false;
    }
    await fs.rm(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt += 1) {
    try {
      await fs.mkdir(lockPath);
      await fs.writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid })}\n`, "utf8");
      return async () => fs.rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (await removeAbandonedLock(lockPath)) {
        continue;
      }
      if (attempt === LOCK_RETRIES) {
        throw new Error("failure storage lock is busy");
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  throw new Error("failure storage lock is busy");
}

async function rawArchives(logPath: string): Promise<Array<{ path: string; bytes: number }>> {
  const archiveDir = path.join(path.dirname(logPath), "archives");
  let names: string[];
  try {
    names = await fs.readdir(archiveDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const archives: Array<{ path: string; bytes: number }> = [];
  for (const name of names.filter((entry) => entry.startsWith("failures-") && entry.endsWith(".jsonl")).sort()) {
    const archivePath = path.join(archiveDir, name);
    const stat = await fs.stat(archivePath);
    if (stat.isFile()) {
      archives.push({ path: archivePath, bytes: stat.size });
    }
  }
  return archives;
}

async function rewriteNewestCompleteRecords(logPath: string, maxBytes: number): Promise<void> {
  const text = await fs.readFile(logPath, "utf8");
  const lines = text.split("\n").filter((line) => {
    if (line.length === 0) {
      return false;
    }
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  });
  const retained: string[] = [];
  let retainedBytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const lineBytes = Buffer.byteLength(`${lines[index]}\n`);
    if (retainedBytes + lineBytes > maxBytes) {
      break;
    }
    retained.unshift(lines[index]);
    retainedBytes += lineBytes;
  }
  if (retained.length === 0) {
    await fs.rm(logPath, { force: true });
    return;
  }
  const temporaryPath = `${logPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporaryPath, `${retained.join("\n")}\n`, "utf8");
    await fs.rename(temporaryPath, logPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function enforceBudget(logPath: string, budget: number): Promise<void> {
  const archives = await rawArchives(logPath);
  const activeBytes = (await fs.stat(logPath)).size;
  let archiveBytes = archives.reduce((total, archive) => total + archive.bytes, 0);
  for (const archive of archives) {
    if (archiveBytes + activeBytes <= budget) {
      break;
    }
    await fs.rm(archive.path, { force: true });
    archiveBytes -= archive.bytes;
  }
  if (archiveBytes + activeBytes <= budget) {
    return;
  }
  await rewriteNewestCompleteRecords(logPath, Math.max(0, budget - archiveBytes));
}

export async function appendFailureRecord(logPath: string, line: string): Promise<void> {
  const budget = failureStorageMaxBytes();
  if (budget === 0) {
    return;
  }
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const lockPath = `${logPath}.lock`;
  const release = await acquireLock(lockPath);
  try {
    await fs.appendFile(logPath, `${line}\n`, "utf8");
    await enforceBudget(logPath, budget);
  } finally {
    await release();
  }
}
