import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { safeIntegerFromEnv } from "./env.js";
import { defaultSubagentStatePath } from "./output.js";
import { processIsDefinitelyGone } from "./processLiveness.js";
import { ValidationError } from "./types.js";

const MAX_ACTIVE_CHILDREN_ENV = "SUBAGENT007_MAX_ACTIVE_CHILDREN";
const ACTIVE_CHILDREN_DIR_ENV = "SUBAGENT007_ACTIVE_CHILDREN_DIR";
export const DEFAULT_MAX_ACTIVE_CHILDREN = 24;
const LOCK_STALE_MS = 5_000;
const LOCK_RETRY_MS = 10;
const LOCK_ATTEMPTS = 100;

interface ActiveChildLeaseRecord {
  schema_version: 1;
  owner_id: string;
  pid: number;
  run_id?: string;
  created_at: string;
}

export interface ActiveChildLease {
  release: () => Promise<void>;
}

function activeChildrenDir(): string {
  return defaultSubagentStatePath(ACTIVE_CHILDREN_DIR_ENV, "active-children");
}

function maxActiveChildren(): number {
  return safeIntegerFromEnv(MAX_ACTIVE_CHILDREN_ENV, DEFAULT_MAX_ACTIVE_CHILDREN, 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLease(filePath: string): Promise<ActiveChildLeaseRecord | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Partial<ActiveChildLeaseRecord>;
    if (parsed.schema_version !== 1 || typeof parsed.owner_id !== "string" || typeof parsed.pid !== "number") {
      return null;
    }
    return parsed as ActiveChildLeaseRecord;
  } catch {
    return null;
  }
}

async function listLeasePaths(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => path.join(dir, entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function pruneStaleLeases(dir: string): Promise<ActiveChildLeaseRecord[]> {
  const active: ActiveChildLeaseRecord[] = [];
  for (const leasePath of await listLeasePaths(dir)) {
    const lease = await readLease(leasePath);
    if (!lease || processIsDefinitelyGone(lease.pid)) {
      await fs.rm(leasePath, { force: true });
      continue;
    }
    active.push(lease);
  }
  return active;
}

async function withCapacityLock<T>(dir: string, run: () => Promise<T>): Promise<T> {
  await fs.mkdir(dir, { recursive: true });
  const lockDir = path.join(dir, ".lock");
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      await fs.mkdir(lockDir);
      try {
        return await run();
      } finally {
        await fs.rm(lockDir, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      try {
        const stats = await fs.stat(lockDir);
        if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  throw new ValidationError("local child capacity lock is busy", "local_capacity_exhausted");
}

export async function acquireActiveChildLease(runId?: string): Promise<ActiveChildLease> {
  const max = maxActiveChildren();
  if (max <= 0) {
    return { release: async () => {} };
  }

  const dir = activeChildrenDir();
  return withCapacityLock(dir, async () => {
    const active = await pruneStaleLeases(dir);
    if (active.length >= max) {
      throw new ValidationError(
        `local child capacity exhausted: active_children=${active.length} max_active_children=${max}`,
        "local_capacity_exhausted",
      );
    }

    const ownerId = randomBytes(12).toString("hex");
    const leasePath = path.join(dir, `${ownerId}.json`);
    const lease: ActiveChildLeaseRecord = {
      schema_version: 1,
      owner_id: ownerId,
      pid: process.pid,
      ...(runId ? { run_id: runId } : {}),
      created_at: new Date().toISOString(),
    };
    await fs.writeFile(leasePath, `${JSON.stringify(lease)}\n`, { encoding: "utf8", flag: "wx" });

    return {
      release: async () => {
        const current = await readLease(leasePath);
        if (!current || current.owner_id === ownerId) {
          await fs.rm(leasePath, { force: true });
        }
      },
    };
  });
}

export async function hasLiveActiveChildLease(runId: string): Promise<boolean> {
  const active = await pruneStaleLeases(activeChildrenDir());
  return active.some((lease) => lease.run_id === runId);
}
