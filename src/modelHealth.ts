import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveModelClass } from "./modelAllowlist.js";
import { defaultSubagentStatePath } from "./output.js";
import type { ModelClass } from "./types.js";
import { ValidationError } from "./types.js";

export const MODEL_HEALTH_SURFACE_ONE_SHOT = "run_subagent_one_shot" as const;
export const MODEL_HEALTH_STATUSES = ["healthy", "unhealthy", "unknown"] as const;
export type ModelHealthSurface = typeof MODEL_HEALTH_SURFACE_ONE_SHOT;
export type ModelHealthStatus = (typeof MODEL_HEALTH_STATUSES)[number];

export interface ModelHealthRecord {
  schema_version: 1;
  model_class: ModelClass;
  resolved_model: string;
  surface: ModelHealthSurface;
  checked_at: string;
  usable_for_one_shot: boolean;
  last_success_latency_ms?: number;
  last_failure_class?: string;
  last_failure_at?: string;
}

export interface ModelHealthView {
  surface: ModelHealthSurface;
  status: ModelHealthStatus;
  usable_for_one_shot: boolean | null;
  last_checked_at: string | null;
  last_success_latency_ms?: number;
  last_failure_class?: string;
  last_failure_at?: string;
}

export function defaultModelHealthPath(): string {
  return defaultSubagentStatePath("SUBAGENT007_MODEL_HEALTH_PATH", "model-health.json");
}

function assertRecord(value: unknown): asserts value is ModelHealthRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("model health record must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== 1) {
    throw new ValidationError("model health record schema_version must be 1");
  }
  if (!["A", "B", "C", "D", "E"].includes(String(record.model_class))) {
    throw new ValidationError("model health record model_class is invalid");
  }
  if (typeof record.resolved_model !== "string" || record.resolved_model.trim() === "") {
    throw new ValidationError("model health record resolved_model must be a nonempty string");
  }
  if (record.surface !== MODEL_HEALTH_SURFACE_ONE_SHOT) {
    throw new ValidationError("model health record surface is invalid");
  }
  if (typeof record.checked_at !== "string" || record.checked_at.trim() === "") {
    throw new ValidationError("model health record checked_at must be a nonempty string");
  }
  if (typeof record.usable_for_one_shot !== "boolean") {
    throw new ValidationError("model health record usable_for_one_shot must be boolean");
  }
}

async function readRecords(healthPath = defaultModelHealthPath()): Promise<ModelHealthRecord[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(healthPath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw new ValidationError(`model health file is unreadable: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new ValidationError("model health file must contain an array");
  }
  for (const record of parsed) {
    assertRecord(record);
  }
  return parsed;
}

async function writeRecords(records: ModelHealthRecord[], healthPath = defaultModelHealthPath()): Promise<void> {
  await fs.mkdir(path.dirname(healthPath), { recursive: true });
  const tmpPath = `${healthPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, healthPath);
}

function sameHealthKey(a: ModelHealthRecord, b: Pick<ModelHealthRecord, "model_class" | "resolved_model" | "surface">) {
  return a.model_class === b.model_class && a.resolved_model === b.resolved_model && a.surface === b.surface;
}

export async function upsertModelHealthRecord(
  record: ModelHealthRecord,
  options: { healthPath?: string } = {},
): Promise<void> {
  assertRecord(record);
  const records = await readRecords(options.healthPath);
  const next = records.filter((existing) => !sameHealthKey(existing, record));
  next.push(record);
  await writeRecords(next, options.healthPath);
}

export async function modelHealthForClass(
  modelClass: ModelClass,
  options: { healthPath?: string; surface?: ModelHealthSurface } = {},
): Promise<ModelHealthView> {
  const surface = options.surface ?? MODEL_HEALTH_SURFACE_ONE_SHOT;
  const { model: resolvedModel } = resolveModelClass(modelClass);
  const records = await readRecords(options.healthPath);
  const record = records.find((candidate) =>
    candidate.model_class === modelClass &&
    candidate.resolved_model === resolvedModel &&
    candidate.surface === surface
  );
  if (!record) {
    return {
      surface,
      status: "unknown",
      usable_for_one_shot: null,
      last_checked_at: null,
    };
  }
  return {
    surface,
    status: record.usable_for_one_shot ? "healthy" : "unhealthy",
    usable_for_one_shot: record.usable_for_one_shot,
    last_checked_at: record.checked_at,
    ...(record.last_success_latency_ms !== undefined
      ? { last_success_latency_ms: record.last_success_latency_ms }
      : {}),
    ...(record.last_failure_class ? { last_failure_class: record.last_failure_class } : {}),
    ...(record.last_failure_at ? { last_failure_at: record.last_failure_at } : {}),
  };
}

export async function assertModelClassUsableForOneShot(modelClass: ModelClass): Promise<void> {
  const health = await modelHealthForClass(modelClass);
  if (health.status === "unhealthy") {
    throw new ValidationError(
      `model_class ${modelClass} is known unhealthy for run_subagent one-shot use; refresh model health or use start_run/model_class with healthy one-shot status`,
    );
  }
}
