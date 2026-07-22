import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { newRunId } from "./inputMailbox.js";
import { defaultSubagentStatePath } from "./output.js";
import { processIsDefinitelyGone } from "./processLiveness.js";
import {
  EFFECT_PROFILES,
  MODEL_CLASSES,
  OUTPUT_MODES,
  RECURSIVE_DELEGATIONS,
  TOOL_PROFILES,
  ValidationError,
  type StartRunTaskRequest,
} from "./types.js";

const CLIENT_START_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const REQUEST_HASH_DOMAIN = "subagent007.client_start_request.v1\n";
const OWNER_INSTANCE_ID_PATTERN = /^[0-9a-f]{24}$/;
const OWNER_PROCESS_TITLE_PREFIX = "subagent007-pi:";
const execFileAsync = promisify(execFile);
let localOwnerInstanceId: string | undefined;

const continuityIdentitySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("ephemeral") }),
  z.strictObject({ mode: z.literal("fresh") }),
  z.strictObject({ mode: z.literal("resume"), session_id: z.string().min(1) }),
]);
const snapshotBindingIdentitySchema = z.strictObject({
  contract_version: z.literal(1),
  snapshot_id: z.string().regex(/^[0-9a-f]{64}$/),
  metadata_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  publication_receipt_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  reference_id: z.string().regex(/^[0-9a-f]{64}$/),
  project_id: z.string().min(1),
  publication_id: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
});
const clientStartIdentitySchema = z.strictObject({
  prompt: z.string().min(1),
  cwd: z.string().min(1),
  model_class: z.enum(MODEL_CLASSES).optional(),
  skill_name: z.string().nullable().optional(),
  skill: z.string().nullable().optional(),
  output_mode: z.enum(OUTPUT_MODES).optional(),
  tool_profile: z.enum(TOOL_PROFILES).optional(),
  effect_profile: z.enum(EFFECT_PROFILES).optional(),
  expected_skill_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  skill_snapshot_binding: snapshotBindingIdentitySchema.optional(),
  recursive_delegation: z.enum(RECURSIVE_DELEGATIONS).optional(),
  allowed_output_paths: z.array(z.string().min(1)).max(128).optional(),
  continuity: continuityIdentitySchema.optional(),
  timeout_ms: z.number().int().positive().optional(),
  client_start_id: z.string().min(1).max(200).regex(CLIENT_START_ID_PATTERN).optional(),
});

export interface ClientStartBinding {
  client_start_id: string;
  request_sha256: string;
  run_id: string;
}

interface PersistedClientStartBinding extends ClientStartBinding {
  schema_version: 2;
  admitted_at: string;
  owner_pid: number;
  owner_instance_id: string;
}

export interface ClientStartAdmission {
  binding: ClientStartBinding;
  admitted_at: string;
  created: boolean;
  owner_pid: number;
  owner_instance_id: string;
}

export type ClientStartAdmissionOwnerLiveness = "live" | "gone" | "unknown";

function ownerProcessTitle(ownerInstanceId: string): string {
  return `${OWNER_PROCESS_TITLE_PREFIX}${ownerInstanceId}`;
}

function currentOwnerInstanceId(): string {
  if (localOwnerInstanceId) return localOwnerInstanceId;
  const candidate = randomBytes(12).toString("hex");
  const title = ownerProcessTitle(candidate);
  process.title = title;
  if (process.title !== title) {
    throw new Error("client-start owner process title could not preserve exact instance identity");
  }
  localOwnerInstanceId = candidate;
  return candidate;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

/** Shared code-point-ordered canonical JSON for durable owner evidence. */
export function canonicalJson(value: unknown): string {
  const bytes = JSON.stringify(canonicalValue(value));
  if (bytes === undefined) throw new Error("canonical JSON rejects unsupported values");
  return bytes;
}

export function validatedClientStartRequestIdentity(request: StartRunTaskRequest): Record<string, unknown> {
  const parsed = clientStartIdentitySchema.parse(request);
  const { client_start_id: _excluded, ...body } = parsed;
  return canonicalValue(body) as Record<string, unknown>;
}

export function canonicalClientStartRequestSha256(request: StartRunTaskRequest): string {
  return createHash("sha256")
    .update(REQUEST_HASH_DOMAIN)
    .update(canonicalJson(validatedClientStartRequestIdentity(request)))
    .digest("hex");
}

function bindingsDir(): string {
  return path.join(defaultSubagentStatePath("SUBAGENT007_RUN_TASKS_DIR", "run-tasks"), "client-start-ids");
}

function bindingPath(clientStartId: string): string {
  const idSha256 = createHash("sha256").update(clientStartId).digest("hex");
  return path.join(bindingsDir(), `${idSha256}.json`);
}

function validatePersistedBinding(value: unknown, clientStartId: string): PersistedClientStartBinding {
  if (!value || typeof value !== "object") {
    throw new ValidationError("client_start_id admission binding is unreadable", "client_start_id_conflict");
  }
  const record = value as Partial<PersistedClientStartBinding>;
  if (
    record.schema_version !== 2 ||
    record.client_start_id !== clientStartId ||
    typeof record.request_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.request_sha256) ||
    typeof record.run_id !== "string" || record.run_id.trim() === "" ||
    typeof record.admitted_at !== "string" || !Number.isFinite(Date.parse(record.admitted_at)) ||
    typeof record.owner_pid !== "number" || !Number.isSafeInteger(record.owner_pid) || record.owner_pid < 1 ||
    typeof record.owner_instance_id !== "string" || !OWNER_INSTANCE_ID_PATTERN.test(record.owner_instance_id)
  ) {
    throw new ValidationError("client_start_id admission binding is invalid", "client_start_id_conflict");
  }
  return record as PersistedClientStartBinding;
}

async function readBinding(filePath: string, clientStartId: string): Promise<PersistedClientStartBinding> {
  try {
    return validatePersistedBinding(JSON.parse(await fs.readFile(filePath, "utf8")), clientStartId);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new ValidationError("client_start_id admission binding is unreadable", "client_start_id_conflict");
  }
}

function admissionFromRecord(record: PersistedClientStartBinding, created: boolean): ClientStartAdmission {
  return {
    binding: {
      client_start_id: record.client_start_id,
      request_sha256: record.request_sha256,
      run_id: record.run_id,
    },
    admitted_at: record.admitted_at,
    created,
    owner_pid: record.owner_pid,
    owner_instance_id: record.owner_instance_id,
  };
}

export async function clientStartAdmissionOwnerLiveness(
  admission: Pick<ClientStartAdmission, "owner_pid" | "owner_instance_id">,
): Promise<ClientStartAdmissionOwnerLiveness> {
  if (processIsDefinitelyGone(admission.owner_pid)) return "gone";
  try {
    const { stdout } = await execFileAsync(
      "/bin/ps",
      ["-p", String(admission.owner_pid), "-o", "command="],
      { encoding: "utf8", timeout: 1_000, maxBuffer: 4_096 },
    );
    return stdout.trim() === ownerProcessTitle(admission.owner_instance_id) ? "live" : "gone";
  } catch {
    return processIsDefinitelyGone(admission.owner_pid) ? "gone" : "unknown";
  }
}

export async function resolveClientStartAdmissionBinding(
  binding: ClientStartBinding,
): Promise<ClientStartAdmission> {
  const authoritative = await readBinding(bindingPath(binding.client_start_id), binding.client_start_id);
  if (
    authoritative.request_sha256 !== binding.request_sha256 ||
    authoritative.run_id !== binding.run_id
  ) {
    throw new ValidationError(
      "run snapshot client_start_binding does not match its authoritative admission record",
      "client_start_id_conflict",
    );
  }
  return admissionFromRecord(authoritative, false);
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function claimClientStartAdmission(
  request: StartRunTaskRequest,
  candidate?: { run_id: string; admitted_at: string },
): Promise<ClientStartAdmission | undefined> {
  if (request.client_start_id === undefined) return undefined;
  if (!CLIENT_START_ID_PATTERN.test(request.client_start_id)) {
    throw new ValidationError(
      "client_start_id must be 1-200 characters using letters, digits, dots, underscores, colons, or hyphens",
      "client_start_id_conflict",
    );
  }
  const requestSha256 = canonicalClientStartRequestSha256(request);
  const filePath = bindingPath(request.client_start_id);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const record: PersistedClientStartBinding = {
    schema_version: 2,
    client_start_id: request.client_start_id,
    request_sha256: requestSha256,
    run_id: candidate?.run_id ?? newRunId(),
    admitted_at: candidate?.admitted_at ?? new Date().toISOString(),
    owner_pid: process.pid,
    owner_instance_id: currentOwnerInstanceId(),
  };
  const tempPath = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const tempHandle = await fs.open(tempPath, "wx", 0o600);
  try {
    await tempHandle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await tempHandle.sync();
  } finally {
    await tempHandle.close();
  }
  let created = false;
  try {
    try {
      await fs.link(tempPath, filePath);
      created = true;
      await fsyncDirectory(path.dirname(filePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await fs.rm(tempPath, { force: true });
    if (created) await fsyncDirectory(path.dirname(filePath));
  }
  const authoritative = created ? record : await readBinding(filePath, request.client_start_id);
  if (authoritative.request_sha256 !== requestSha256) {
    throw new ValidationError(
      "client_start_id is already bound to a different validated start request",
      "client_start_id_conflict",
    );
  }
  return admissionFromRecord(authoritative, created);
}

export async function findClientStartAdmission(request: StartRunTaskRequest): Promise<ClientStartAdmission | undefined> {
  if (request.client_start_id === undefined) return undefined;
  if (!CLIENT_START_ID_PATTERN.test(request.client_start_id)) {
    throw new ValidationError(
      "client_start_id must be 1-200 characters using letters, digits, dots, underscores, colons, or hyphens",
      "client_start_id_conflict",
    );
  }
  const filePath = bindingPath(request.client_start_id);
  let authoritative: PersistedClientStartBinding | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      authoritative = await readBinding(filePath, request.client_start_id);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!authoritative) return undefined;
  const requestSha256 = canonicalClientStartRequestSha256(request);
  if (authoritative.request_sha256 !== requestSha256) {
    throw new ValidationError(
      "client_start_id is already bound to a different validated start request",
      "client_start_id_conflict",
    );
  }
  return admissionFromRecord(authoritative, false);
}
