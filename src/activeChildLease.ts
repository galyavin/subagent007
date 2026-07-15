import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { safeIntegerFromEnv } from "./env.js";
import { defaultSubagentStatePath } from "./output.js";
import { processIsDefinitelyGone } from "./processLiveness.js";
import { ValidationError } from "./types.js";

const MAX_ACTIVE_CHILDREN_ENV = "SUBAGENT007_MAX_ACTIVE_CHILDREN";
const ACTIVE_CHILDREN_DIR_ENV = "SUBAGENT007_ACTIVE_CHILDREN_DIR";
const MAX_QUEUED_RUNS_ENV = "SUBAGENT007_MAX_QUEUED_RUNS";
const QUEUED_RUNS_DIR_ENV = "SUBAGENT007_QUEUED_RUNS_DIR";
export const DEFAULT_MAX_ACTIVE_CHILDREN = 24;
export const DEFAULT_MAX_QUEUED_RUNS = 96;
const LOCK_STALE_MS = 5_000;
const LOCK_RETRY_MS = 10;
const LOCK_ATTEMPTS = 100;
const QUEUE_POLL_MS = 100;
const PROCESS_OWNER_ID = randomBytes(12).toString("hex");
const ATTRIBUTED_ACTIVE_LEASE_PATTERN = /^[A-Za-z0-9_-]+\.[a-f0-9]{24}\.json$/;

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

export type ActiveChildLeaseLiveness = "live" | "absent" | "unknown";

interface QueuedRunTicketRecord {
  schema_version: 1;
  owner_id: string;
  pid: number;
  run_id: string;
  queued_at: string;
  owner_sequence: number;
}

export interface QueuedRunTicket {
  queuedAt: string;
  release: () => Promise<void>;
  waitForLease: (signal: AbortSignal) => Promise<ActiveChildLease>;
}

export type ActiveChildAdmission =
  | { kind: "active"; lease: ActiveChildLease }
  | { kind: "queued"; ticket: QueuedRunTicket };

interface LocalQueuedRun {
  record: QueuedRunTicketRecord;
  ticketPath: string;
  ready: boolean;
  cancelled: boolean;
  signal?: AbortSignal;
  resolve?: (lease: ActiveChildLease) => void;
  reject?: (error: Error) => void;
}

const localQueuedRuns = new Map<string, LocalQueuedRun>();
let nextOwnerSequence = 0;
let ownerPumpRunning = false;
let ownerPumpWakePending = false;
let ownerPumpTimer: ReturnType<typeof setTimeout> | undefined;

function activeChildrenDir(): string {
  return defaultSubagentStatePath(ACTIVE_CHILDREN_DIR_ENV, "active-children");
}

function activeLeaseRunPrefix(runId: string): string {
  return `${Buffer.from(runId, "utf8").toString("base64url")}.`;
}

function queuedRunsDir(): string {
  return defaultSubagentStatePath(QUEUED_RUNS_DIR_ENV, "queued-runs");
}

function maxActiveChildren(): number {
  return safeIntegerFromEnv(MAX_ACTIVE_CHILDREN_ENV, DEFAULT_MAX_ACTIVE_CHILDREN, 0);
}

function maxQueuedRuns(): number {
  return safeIntegerFromEnv(MAX_QUEUED_RUNS_ENV, DEFAULT_MAX_QUEUED_RUNS, 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    return true;
  }
}

async function publishJsonExclusive(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await fs.writeFile(tempPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await fs.link(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
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

async function pruneStaleLeases(dir: string): Promise<Array<ActiveChildLeaseRecord | null>> {
  const active: Array<ActiveChildLeaseRecord | null> = [];
  for (const leasePath of await listLeasePaths(dir)) {
    const lease = await readLease(leasePath);
    if (!lease) {
      active.push(null);
      continue;
    }
    if (processIsDefinitelyGone(lease.pid)) {
      await fs.rm(leasePath, { force: true });
      continue;
    }
    active.push(lease);
  }
  return active;
}

async function readQueueTicket(filePath: string): Promise<QueuedRunTicketRecord | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Partial<QueuedRunTicketRecord>;
    if (
      parsed.schema_version !== 1 ||
      typeof parsed.owner_id !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.run_id !== "string" ||
      typeof parsed.queued_at !== "string" ||
      typeof parsed.owner_sequence !== "number"
    ) {
      return null;
    }
    return parsed as QueuedRunTicketRecord;
  } catch {
    return null;
  }
}

async function queueTicketRecords(dir: string): Promise<Array<QueuedRunTicketRecord | null>> {
  const records: Array<QueuedRunTicketRecord | null> = [];
  for (const ticketPath of await listLeasePaths(dir)) {
    const record = await readQueueTicket(ticketPath);
    if (!record) {
      records.push(null);
      continue;
    }
    if (processIsDefinitelyGone(record.pid)) {
      await fs.rm(ticketPath, { force: true });
      continue;
    }
    records.push(record);
  }
  return records;
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
  const admission = await admitActiveChild(runId ?? randomBytes(12).toString("hex"), false);
  if (admission.kind !== "active") {
    throw new Error("fail-fast child admission unexpectedly queued");
  }
  return admission.lease;
}

function activeLeaseRecord(runId?: string): ActiveChildLeaseRecord {
  return {
    schema_version: 1,
    owner_id: randomBytes(12).toString("hex"),
    pid: process.pid,
    ...(runId ? { run_id: runId } : {}),
    created_at: new Date().toISOString(),
  };
}

async function writeActiveLease(dir: string, runId?: string): Promise<ActiveChildLease> {
  const lease = activeLeaseRecord(runId);
  const leasePath = path.join(
    dir,
    runId ? `${activeLeaseRunPrefix(runId)}${lease.owner_id}.json` : `${lease.owner_id}.json`,
  );
  await publishJsonExclusive(leasePath, lease);
  return {
    release: async () => {
      const current = await readLease(leasePath);
      if (!current) {
        if (await pathExists(leasePath)) {
          throw new Error(`active child lease ownership cannot be confirmed: ${leasePath}`);
        }
        wakeOwnerPump();
        return;
      }
      if (current.owner_id !== lease.owner_id) {
        throw new Error(`active child lease owner changed: ${leasePath}`);
      }
      await fs.rm(leasePath);
      wakeOwnerPump();
    },
  };
}

function queueTicketPath(runId: string): string {
  return path.join(queuedRunsDir(), `${runId}.json`);
}

async function releaseOwnedQueueTicket(ticketPath: string, runId: string): Promise<void> {
  const local = localQueuedRuns.get(runId);
  if (local) {
    local.cancelled = true;
    local.reject?.(new ValidationError("queued run cancelled before child launch", "local_capacity_exhausted"));
    localQueuedRuns.delete(runId);
  }
  const current = await readQueueTicket(ticketPath);
  if (!current) {
    if (await pathExists(ticketPath)) {
      throw new Error(`queued run ticket ownership cannot be confirmed: ${ticketPath}`);
    }
    wakeOwnerPump();
    return;
  }
  if (current.run_id !== runId || current.owner_id !== PROCESS_OWNER_ID) {
    throw new Error(`queued run ticket owner changed: ${ticketPath}`);
  }
  await fs.rm(ticketPath);
  wakeOwnerPump();
}

function queuedRunTicket(record: QueuedRunTicketRecord): QueuedRunTicket {
  const ticketPath = queueTicketPath(record.run_id);
  return {
    queuedAt: record.queued_at,
    release: () => releaseOwnedQueueTicket(ticketPath, record.run_id),
    waitForLease: (signal) => new Promise<ActiveChildLease>((resolve, reject) => {
      const local = localQueuedRuns.get(record.run_id);
      if (!local || local.ready) {
        reject(new ValidationError("queued run ownership is no longer active", "local_capacity_exhausted"));
        return;
      }
      local.ready = true;
      local.signal = signal;
      local.resolve = resolve;
      local.reject = reject;
      signal.addEventListener("abort", () => {
        local.cancelled = true;
        wakeOwnerPump();
      }, { once: true });
      wakeOwnerPump();
    }),
  };
}

function localQueueHead(): LocalQueuedRun | undefined {
  return [...localQueuedRuns.values()].sort(
    (left, right) => left.record.owner_sequence - right.record.owner_sequence,
  )[0];
}

function scheduleOwnerPump(): void {
  if (ownerPumpTimer || localQueuedRuns.size === 0) {
    return;
  }
  ownerPumpTimer = setTimeout(() => {
    ownerPumpTimer = undefined;
    wakeOwnerPump();
  }, QUEUE_POLL_MS);
}

function wakeOwnerPump(): void {
  if (ownerPumpRunning) {
    ownerPumpWakePending = true;
    return;
  }
  if (ownerPumpTimer) {
    clearTimeout(ownerPumpTimer);
    ownerPumpTimer = undefined;
  }
  ownerPumpRunning = true;
  void pumpOwnerQueue().finally(() => {
    ownerPumpRunning = false;
    if (ownerPumpWakePending) {
      ownerPumpWakePending = false;
      wakeOwnerPump();
    }
  });
}

async function promoteLocalQueueHead(local: LocalQueuedRun): Promise<ActiveChildLease | null> {
  return withCapacityLock(activeChildrenDir(), async () => {
    const ticket = await readQueueTicket(local.ticketPath);
    if (!ticket || ticket.owner_id !== PROCESS_OWNER_ID || ticket.run_id !== local.record.run_id) {
      throw new Error("queued run ownership is no longer active");
    }
    if (local.cancelled || local.signal?.aborted) {
      return null;
    }
    const max = maxActiveChildren();
    const active = max > 0 ? await pruneStaleLeases(activeChildrenDir()) : [];
    if (max > 0 && active.length >= max) {
      return null;
    }
    if (local.cancelled || local.signal?.aborted) {
      return null;
    }
    const lease = max > 0
      ? await writeActiveLease(activeChildrenDir(), local.record.run_id)
      : { release: async () => {} };
    try {
      await fs.rm(local.ticketPath);
    } catch (error) {
      await lease.release();
      throw error;
    }
    if (local.cancelled || local.signal?.aborted) {
      await lease.release();
      return null;
    }
    return lease;
  });
}

async function pumpOwnerQueue(): Promise<void> {
  while (true) {
    const local = localQueueHead();
    if (!local || !local.ready) {
      return;
    }
    if (local.cancelled || local.signal?.aborted) {
      await releaseOwnedQueueTicket(local.ticketPath, local.record.run_id);
      continue;
    }
    try {
      const lease = await promoteLocalQueueHead(local);
      if (!lease) {
        if (local.cancelled || local.signal?.aborted) {
          await releaseOwnedQueueTicket(local.ticketPath, local.record.run_id);
          continue;
        }
        scheduleOwnerPump();
        return;
      }
      localQueuedRuns.delete(local.record.run_id);
      local.resolve?.(lease);
    } catch (error) {
      if (error instanceof ValidationError && error.reasonCode === "local_capacity_exhausted") {
        scheduleOwnerPump();
        return;
      }
      localQueuedRuns.delete(local.record.run_id);
      local.reject?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export async function admitActiveChild(runId: string, allowQueue: boolean): Promise<ActiveChildAdmission> {
  const max = maxActiveChildren();
  if (max <= 0) {
    return { kind: "active", lease: { release: async () => {} } };
  }
  const activeDir = activeChildrenDir();
  return withCapacityLock(activeDir, async () => {
    const active = await pruneStaleLeases(activeDir);
    if (active.length < max) {
      return { kind: "active", lease: await writeActiveLease(activeDir, runId) };
    }
    const maxQueued = maxQueuedRuns();
    if (!allowQueue || maxQueued <= 0) {
      throw new ValidationError(
        `local child capacity exhausted: active_children=${active.length} max_active_children=${max}`,
        "local_capacity_exhausted",
      );
    }
    const queueDir = queuedRunsDir();
    await fs.mkdir(queueDir, { recursive: true });
    const queued = await queueTicketRecords(queueDir);
    if (queued.length >= maxQueued) {
      throw new ValidationError(
        `local run queue exhausted: queued_runs=${queued.length} max_queued_runs=${maxQueued}`,
        "local_queue_exhausted",
      );
    }
    const record: QueuedRunTicketRecord = {
      schema_version: 1,
      owner_id: PROCESS_OWNER_ID,
      pid: process.pid,
      run_id: runId,
      queued_at: new Date().toISOString(),
      owner_sequence: nextOwnerSequence++,
    };
    const ticketPath = queueTicketPath(runId);
    await publishJsonExclusive(ticketPath, record);
    localQueuedRuns.set(runId, { record, ticketPath, ready: false, cancelled: false });
    return { kind: "queued", ticket: queuedRunTicket(record) };
  });
}

export async function hasLiveQueuedRunTicket(runId: string): Promise<boolean> {
  const ticket = await readQueueTicket(queueTicketPath(runId));
  if (!ticket) {
    return pathExists(queueTicketPath(runId));
  }
  if (processIsDefinitelyGone(ticket.pid)) {
    await fs.rm(queueTicketPath(runId), { force: true });
    return false;
  }
  return true;
}

export async function activeChildLeaseLiveness(runId: string): Promise<ActiveChildLeaseLiveness> {
  const dir = activeChildrenDir();
  const runPrefix = activeLeaseRunPrefix(runId);
  let unknownLegacyLease = false;
  for (const leasePath of await listLeasePaths(dir)) {
    const lease = await readLease(leasePath);
    if (!lease) {
      const leaseName = path.basename(leasePath);
      if (leaseName.startsWith(runPrefix)) {
        return "live";
      }
      if (ATTRIBUTED_ACTIVE_LEASE_PATTERN.test(leaseName)) {
        continue;
      }
      unknownLegacyLease = true;
      continue;
    }
    if (processIsDefinitelyGone(lease.pid)) {
      await fs.rm(leasePath, { force: true });
      continue;
    }
    if (lease.run_id === runId) {
      return "live";
    }
  }
  return unknownLegacyLease ? "unknown" : "absent";
}

export async function hasLiveActiveChildLease(runId: string): Promise<boolean> {
  return (await activeChildLeaseLiveness(runId)) === "live";
}
