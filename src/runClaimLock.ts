import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { processIsDefinitelyGone } from "./processLiveness.js";
import { ValidationError } from "./types.js";

const LOCK_OWNER_NAME = "subagent007.run_claim_lock" as const;
const LOCK_OWNER_VERSION = 1 as const;
const LOCK_WAIT_ATTEMPTS = 400;
const LOCK_WAIT_MS = 5;

interface RunClaimLockOwner {
  name: typeof LOCK_OWNER_NAME;
  version: typeof LOCK_OWNER_VERSION;
  pid: number;
  nonce: string;
}

function lockDirectory(runTasksDir: string): string {
  return path.join(runTasksDir, ".claim-locks");
}

function lockPath(runTasksDir: string, runId: string): string {
  const encoded = createHash("sha256").update(runId).digest("hex");
  return path.join(lockDirectory(runTasksDir), `${encoded}.lock`);
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function decodeOwner(bytes: string): RunClaimLockOwner | undefined {
  try {
    const value = JSON.parse(bytes) as Partial<RunClaimLockOwner>;
    if (
      value.name !== LOCK_OWNER_NAME ||
      value.version !== LOCK_OWNER_VERSION ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) < 1 ||
      typeof value.nonce !== "string" ||
      !/^[0-9a-f]{24}$/.test(value.nonce)
    ) return undefined;
    return value as RunClaimLockOwner;
  } catch {
    return undefined;
  }
}

async function tryRemoveDefinitelyAbandonedLock(filePath: string): Promise<boolean> {
  let bytes: string;
  try {
    bytes = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
  const owner = decodeOwner(bytes);
  if (!owner || !processIsDefinitelyGone(owner.pid)) return false;
  let current: string;
  try {
    current = await fs.readFile(filePath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  if (current !== bytes) return false;
  try {
    await fs.unlink(filePath);
    await fsyncDirectory(path.dirname(filePath));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function acquireRunClaimLock(runTasksDir: string, runId: string): Promise<{
  filePath: string;
  bytes: string;
}> {
  const directory = lockDirectory(runTasksDir);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = lockPath(runTasksDir, runId);
  const owner: RunClaimLockOwner = {
    name: LOCK_OWNER_NAME,
    version: LOCK_OWNER_VERSION,
    pid: process.pid,
    nonce: randomBytes(12).toString("hex"),
  };
  const bytes = `${JSON.stringify(owner)}\n`;
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await fs.writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
  try {
    for (let attempt = 0; attempt < LOCK_WAIT_ATTEMPTS; attempt += 1) {
      try {
        await fs.link(temporaryPath, filePath);
        return { filePath, bytes };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (await tryRemoveDefinitelyAbandonedLock(filePath)) continue;
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
  throw new ValidationError(
    `run claim transition ownership is live or ambiguous: ${runId}`,
    "run_liveness_unknown",
  );
}

async function releaseRunClaimLock(lock: { filePath: string; bytes: string }): Promise<void> {
  const current = await fs.readFile(lock.filePath, "utf8").catch(() => undefined);
  if (current !== lock.bytes) {
    throw new ValidationError("run claim transition ownership changed before release", "run_liveness_unknown");
  }
  await fs.unlink(lock.filePath);
}

/**
 * Temporary per-run cross-process critical section. The lock has no lifecycle
 * meaning: every caller must reread the current claim after entry and derive
 * its operation-specific transition from that truth.
 */
export async function withRunClaimLock<T>(
  runTasksDir: string,
  runId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = await acquireRunClaimLock(runTasksDir, runId);
  try {
    return await operation();
  } finally {
    await releaseRunClaimLock(lock);
  }
}
