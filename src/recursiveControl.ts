import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { safeIntegerFromEnv } from "./env.js";
import {
  MODEL_CLASSES,
  type FailureReasonCode,
  type ModelClass,
  type OutputMode,
  type SpecialistCatalogueScope,
} from "./types.js";
import { ValidationError } from "./types.js";
import { validateSkillName } from "./skillBinding.js";

const DEFAULT_MAX_RECURSION_DEPTH = 8;
const MAX_RECURSION_DEPTH_ENV = "SUBAGENT007_MAX_RECURSION_DEPTH";
const RECURSIVE_DELEGATE_REQUEST_DIGEST_DOMAIN = "subagent007.recursive_delegate_request.v1\n";
const RECURSIVE_DELEGATE_PUBLIC_PARAM_FIELDS = [
  "cwd",
  "model_class",
  "skill_name",
  "output_mode",
  "wait_ms",
  "timeout_ms",
] as const;

function canonicalRecursiveRequestJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalRecursiveRequestJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      .map((key) => `${JSON.stringify(key)}:${canonicalRecursiveRequestJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  const bytes = JSON.stringify(value);
  if (bytes === undefined) throw new Error("recursive request canonical JSON rejects unsupported values");
  return bytes;
}

export interface RecursiveCallerContext {
  parent_run_id: string;
  root_run_id: string;
  recursion_depth: number;
  system_skill_name?: string;
  specialist_catalogue_scope?: SpecialistCatalogueScope;
  /** Root-resolved class for a governed recursive lineage; private control data. */
  governing_model_class?: ModelClass;
}

export interface RecursiveControlChildConfig extends RecursiveCallerContext {
  socket_path: string;
  token: string;
}

export interface RecursiveDelegateParams {
  prompt: string;
  cwd: string;
  model_class?: ModelClass;
  skill_name?: string | null;
  output_mode?: OutputMode;
  wait_ms?: number;
  timeout_ms?: number;
}

export interface RecursiveRejoinParams {
  run_id: string;
  wait_ms?: number;
}

export interface RecursiveDelegateRequest {
  caller: RecursiveCallerContext;
  params: RecursiveDelegateParams;
}

export interface RecursiveRejoinRequest {
  caller: RecursiveCallerContext;
  params: RecursiveRejoinParams;
}

export interface RecursiveDelegateRejectedResult {
  status: "rejected";
  kind: "recursive_delegate_rejected";
  success: false;
  error_class: "validation_error";
  reason_code: FailureReasonCode;
  message: string;
  /** Present for a valid delegate envelope that reached start admission. */
  request_id?: string;
  /** Canonical digest of public lineage, Task digest/size, and public request fields. */
  request_sha256?: string;
  /** Exact caller Task bytes are bound without echoing prompt text. */
  task_sha256?: string | null;
  task_size_bytes?: number | null;
  public_request?: RecursiveDelegatePublicRequest;
}

export interface RecursiveDelegatePublicRequest {
  method: "delegate";
  parent_run_id: string;
  root_run_id: string;
  recursion_depth: number;
  system_skill_name?: string;
  task_sha256: string | null;
  task_size_bytes: number | null;
  cwd?: unknown;
  model_class?: unknown;
  skill_name?: unknown;
  output_mode?: unknown;
  wait_ms?: unknown;
  timeout_ms?: unknown;
}

export interface RecursiveDelegateAttemptReceipt {
  request_id: string;
  request_sha256: string;
  task_sha256: string | null;
  task_size_bytes: number | null;
  public_request: RecursiveDelegatePublicRequest;
}

export type RecursiveDelegateHandler = (request: RecursiveDelegateRequest) => Promise<Record<string, unknown>>;
export type RecursiveRejoinHandler = (request: RecursiveRejoinRequest) => Promise<Record<string, unknown>>;
export type RecursiveDelegateResult = Record<string, unknown> | RecursiveDelegateRejectedResult;
export type RecursiveRejoinResult = Record<string, unknown> | RecursiveDelegateRejectedResult;

type RecursiveRpcMethod = "delegate" | "rejoin";

export interface RecursiveControlHandlers {
  delegate: RecursiveDelegateHandler;
  rejoin: RecursiveRejoinHandler;
}

interface RecursiveRpcRequest {
  id?: string;
  token?: string;
  method?: RecursiveRpcMethod;
  caller?: Partial<RecursiveCallerContext>;
  params?: unknown;
}

interface RecursiveRpcSuccess {
  id: string;
  ok: true;
  result: RecursiveDelegateResult;
}

interface RecursiveRpcFailure {
  id: string;
  ok: false;
  error: {
    message: string;
    reason_code: FailureReasonCode;
  };
}

type RecursiveRpcResponse = RecursiveRpcSuccess | RecursiveRpcFailure;

interface RecursiveControlServerHandle {
  socketPath: string;
  token: string;
  maxDepth: number;
  server: net.Server;
}

let activeHandle: RecursiveControlServerHandle | undefined;

export function maxRecursiveDepthFromEnv(): number {
  return safeIntegerFromEnv(MAX_RECURSION_DEPTH_ENV, DEFAULT_MAX_RECURSION_DEPTH, 0);
}

function socketPathForProcess(): string {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\subagent007-recursive-${suffix}`;
  }
  return path.join(os.tmpdir(), `subagent007-recursive-${suffix}.sock`);
}

export function recursiveDelegateAttemptReceipt(input: {
  requestId: string;
  caller: RecursiveCallerContext;
  params: Record<string, unknown>;
}): RecursiveDelegateAttemptReceipt {
  const task = typeof input.params.prompt === "string" ? input.params.prompt : undefined;
  const taskSha256 = task === undefined
    ? null
    : createHash("sha256").update(task, "utf8").digest("hex");
  const taskSizeBytes = task === undefined ? null : Buffer.byteLength(task, "utf8");
  const publicRequest: RecursiveDelegatePublicRequest = {
    method: "delegate",
    parent_run_id: input.caller.parent_run_id,
    root_run_id: input.caller.root_run_id,
    recursion_depth: input.caller.recursion_depth,
    ...(input.caller.system_skill_name
      ? { system_skill_name: input.caller.system_skill_name }
      : {}),
    task_sha256: taskSha256,
    task_size_bytes: taskSizeBytes,
  };
  const target = publicRequest as RecursiveDelegatePublicRequest & Record<string, unknown>;
  for (const field of RECURSIVE_DELEGATE_PUBLIC_PARAM_FIELDS) {
    if (Object.hasOwn(input.params, field)) {
      target[field] = input.params[field];
    }
  }
  return {
    request_id: input.requestId,
    request_sha256: createHash("sha256")
      .update(RECURSIVE_DELEGATE_REQUEST_DIGEST_DOMAIN)
      .update(canonicalRecursiveRequestJson(publicRequest))
      .digest("hex"),
    task_sha256: taskSha256,
    task_size_bytes: taskSizeBytes,
    public_request: publicRequest,
  };
}

function validationFailure(
  error: unknown,
  attempt?: RecursiveDelegateAttemptReceipt,
): RecursiveDelegateRejectedResult {
  const reasonCode =
    error instanceof ValidationError && error.reasonCode
      ? error.reasonCode
      : "unknown_validation_error";
  return {
    status: "rejected",
    kind: "recursive_delegate_rejected",
    success: false,
    error_class: "validation_error",
    reason_code: reasonCode,
    message: error instanceof Error ? error.message : String(error),
    ...(attempt ?? {}),
  };
}

function protocolFailure(error: unknown): RecursiveRpcFailure["error"] {
  const failure = validationFailure(error);
  return {
    message: failure.message,
    reason_code: failure.reason_code,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("recursive delegate request must be an object", "recursive_control_invalid");
  }
  return value as Record<string, unknown>;
}

function nonemptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${field} must be a nonempty string`, "recursive_control_invalid");
  }
  return value.trim();
}

function nonnegativeInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    throw new ValidationError(`${field} must be a nonnegative integer`, "recursive_control_invalid");
  }
  return value;
}

function validateCaller(value: RecursiveRpcRequest["caller"]): RecursiveCallerContext {
  const caller = asRecord(value);
  const systemSkillName = caller.system_skill_name === undefined
    ? undefined
    : validateSkillName(caller.system_skill_name, "caller.system_skill_name");
  const governingModelClass = caller.governing_model_class === undefined
    ? undefined
    : caller.governing_model_class;
  const specialistCatalogueScope = caller.specialist_catalogue_scope === undefined
    ? undefined
    : caller.specialist_catalogue_scope;
  if (specialistCatalogueScope !== undefined && specialistCatalogueScope !== "selected_only") {
    throw new ValidationError(
      "caller.specialist_catalogue_scope must be selected_only",
      "recursive_control_invalid",
    );
  }
  if (governingModelClass !== undefined && !MODEL_CLASSES.includes(governingModelClass as ModelClass)) {
    throw new ValidationError("caller.governing_model_class must be a valid model class", "recursive_control_invalid");
  }
  if ((systemSkillName === undefined) !== (governingModelClass === undefined)) {
    throw new ValidationError(
      "recursive governing system skill and model class must be present together",
      "recursive_control_invalid",
    );
  }
  if (specialistCatalogueScope !== undefined && systemSkillName === undefined) {
    throw new ValidationError(
      "recursive specialist catalogue scope requires a governing system skill",
      "recursive_control_invalid",
    );
  }
  return {
    parent_run_id: nonemptyString(caller.parent_run_id, "caller.parent_run_id"),
    root_run_id: nonemptyString(caller.root_run_id, "caller.root_run_id"),
    recursion_depth: nonnegativeInteger(caller.recursion_depth, "caller.recursion_depth"),
    ...(systemSkillName ? { system_skill_name: systemSkillName } : {}),
    ...(specialistCatalogueScope ? { specialist_catalogue_scope: specialistCatalogueScope } : {}),
    ...(governingModelClass ? { governing_model_class: governingModelClass as ModelClass } : {}),
  };
}

function validateEnvelope(value: unknown, token: string): {
  id: string;
  method: RecursiveRpcMethod;
  caller: RecursiveCallerContext;
  params: Record<string, unknown>;
} {
  const envelope = asRecord(value) as RecursiveRpcRequest;
  const id = typeof envelope.id === "string" && envelope.id.trim() !== ""
    ? envelope.id.trim()
    : randomBytes(6).toString("hex");
  if (envelope.token !== token) {
    throw new ValidationError("recursive control token is invalid", "recursive_control_invalid");
  }
  if (envelope.method !== "delegate" && envelope.method !== "rejoin") {
    throw new ValidationError("recursive control method must be delegate or rejoin", "recursive_control_invalid");
  }
  const caller = validateCaller(envelope.caller);
  return {
    id,
    method: envelope.method,
    caller,
    params: asRecord(envelope.params),
  };
}

async function handleRpcLine(
  line: string,
  handle: RecursiveControlServerHandle,
  handlers: RecursiveControlHandlers,
): Promise<RecursiveRpcResponse> {
  let id = randomBytes(6).toString("hex");
  try {
    const parsed = JSON.parse(line) as unknown;
    const envelope = validateEnvelope(parsed, handle.token);
    id = envelope.id;
    const attempt = envelope.method === "delegate"
      ? recursiveDelegateAttemptReceipt({
          requestId: envelope.id,
          caller: envelope.caller,
          params: envelope.params,
        })
      : undefined;
    if (envelope.method === "delegate" && envelope.caller.recursion_depth >= handle.maxDepth) {
      return {
        id,
        ok: true,
        result: validationFailure(
          new ValidationError(
            `recursive subagent depth limit reached: depth=${envelope.caller.recursion_depth}, max=${handle.maxDepth}`,
            "recursive_depth_exceeded",
          ),
          attempt,
        ),
      };
    }
    try {
      return {
        id,
        ok: true,
        result: envelope.method === "delegate"
          ? await handlers.delegate({
              caller: envelope.caller,
              params: envelope.params as unknown as RecursiveDelegateParams,
            })
          : await handlers.rejoin({
              caller: envelope.caller,
              params: envelope.params as unknown as RecursiveRejoinParams,
            }),
      };
    } catch (error) {
      return {
        id,
        ok: true,
        result: validationFailure(error, attempt),
      };
    }
  } catch (error) {
    return {
      id,
      ok: false,
      error: protocolFailure(error),
    };
  }
}

async function writeResponse(socket: net.Socket, response: RecursiveRpcResponse): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.write(`${JSON.stringify(response)}\n`, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export async function startRecursiveControlServer(
  handlers: RecursiveControlHandlers,
): Promise<void> {
  if (activeHandle) {
    return;
  }
  const socketPath = socketPathForProcess();
  if (process.platform !== "win32") {
    await fsp.rm(socketPath, { force: true });
  }
  const handle: RecursiveControlServerHandle = {
    socketPath,
    token: randomBytes(32).toString("hex"),
    maxDepth: maxRecursiveDepthFromEnv(),
    server: net.createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          return;
        }
        const line = buffer.slice(0, newlineIndex);
        socket.pause();
        void handleRpcLine(line, handle, handlers)
          .then((response) => writeResponse(socket, response))
          .catch((error) =>
            writeResponse(socket, {
              id: randomBytes(6).toString("hex"),
              ok: false,
              error: protocolFailure(error),
            }),
          )
          .finally(() => socket.end());
      });
    }),
  };
  await new Promise<void>((resolve, reject) => {
    handle.server.once("error", reject);
    handle.server.listen(socketPath, () => {
      handle.server.off("error", reject);
      resolve();
    });
  });
  handle.server.unref();
  if (process.platform !== "win32") {
    process.once("exit", () => {
      try {
        fs.rmSync(socketPath, { force: true });
      } catch {
        // Best-effort socket cleanup only.
      }
    });
  }
  activeHandle = handle;
}

export function recursiveControlConfigForChild(input: {
  runId: string;
  rootRunId?: string;
  recursionDepth?: number;
  systemSkillName?: string;
  specialistCatalogueScope?: SpecialistCatalogueScope;
  governingModelClass?: ModelClass;
}): RecursiveControlChildConfig | undefined {
  if (!activeHandle) {
    return undefined;
  }
  const recursionDepth = input.recursionDepth ?? 0;
  return {
    socket_path: activeHandle.socketPath,
    token: activeHandle.token,
    parent_run_id: input.runId,
    root_run_id: input.rootRunId ?? input.runId,
    recursion_depth: recursionDepth,
    ...(input.systemSkillName ? { system_skill_name: input.systemSkillName } : {}),
    ...(input.specialistCatalogueScope
      ? { specialist_catalogue_scope: input.specialistCatalogueScope }
      : {}),
    ...(input.governingModelClass ? { governing_model_class: input.governingModelClass } : {}),
  };
}

async function callRecursiveControl(
  config: RecursiveControlChildConfig,
  method: RecursiveRpcMethod,
  params: RecursiveDelegateParams | RecursiveRejoinParams,
): Promise<RecursiveDelegateResult | RecursiveRejoinResult> {
  const id = randomBytes(6).toString("hex");
  const request = {
    id,
    token: config.token,
    method,
    caller: {
      parent_run_id: config.parent_run_id,
      root_run_id: config.root_run_id,
      recursion_depth: config.recursion_depth,
      ...(config.system_skill_name ? { system_skill_name: config.system_skill_name } : {}),
      ...(config.specialist_catalogue_scope
        ? { specialist_catalogue_scope: config.specialist_catalogue_scope }
        : {}),
      ...(config.governing_model_class ? { governing_model_class: config.governing_model_class } : {}),
    },
    params,
  };
  return new Promise<RecursiveDelegateResult | RecursiveRejoinResult>((resolve, reject) => {
    const socket = net.createConnection(config.socket_path);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      socket.end();
      try {
        const response = JSON.parse(line) as RecursiveRpcResponse;
        if (response.id !== id) {
          reject(new Error("recursive control response id mismatch"));
          return;
        }
        if (!response.ok) {
          resolve({
            status: "rejected",
            kind: "recursive_delegate_rejected",
            success: false,
            error_class: "validation_error",
            reason_code: response.error.reason_code,
            message: response.error.message,
          });
          return;
        }
        resolve(response.result);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
    socket.once("end", () => {
      if (buffer.trim() === "") {
        reject(new Error("recursive control closed without a response"));
      }
    });
  });
}

export async function callRecursiveDelegate(
  config: RecursiveControlChildConfig,
  params: RecursiveDelegateParams,
): Promise<RecursiveDelegateResult> {
  return callRecursiveControl(config, "delegate", params) as Promise<RecursiveDelegateResult>;
}

export async function callRecursiveRejoin(
  config: RecursiveControlChildConfig,
  params: RecursiveRejoinParams,
): Promise<RecursiveRejoinResult> {
  return callRecursiveControl(config, "rejoin", params) as Promise<RecursiveRejoinResult>;
}
