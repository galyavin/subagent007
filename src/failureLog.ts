import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { defaultSubagentStatePath, timestampedRandomId } from "./output.js";
import { SERVER_VERSION, serverBuildSha } from "./runtimeMetadata.js";
import { ValidationError, type FailureReasonCode } from "./types.js";

export type { FailureReasonCode } from "./types.js";

export type FailureLogTool =
  | "run_subagent"
  | "run_subagent_session"
  | "start_session_run"
  | "schedule_run"
  | "start_run"
  | "list_model_classes"
  | "list_allowed_models"
  | "get_run"
  | "cancel_run"
  | "answer_run_input";
type FailureRecordSource = "production" | "test" | "unknown";
type FailureCwdClass = "missing" | "relative" | "temp" | "absolute";
const CURRENT_CALIBRATION_ERA = "model_class_v1";
const MAX_PENDING_FAILURE_WRITES = 256;
let failureWorker: Worker | undefined;
let pendingFailureWrites = 0;

function enqueueFailureRecord(logPath: string, line: string): void {
  if (pendingFailureWrites >= MAX_PENDING_FAILURE_WRITES) return;
  if (!failureWorker) {
    const worker = new Worker(new URL("./failureStorageWorker.js", import.meta.url));
    failureWorker = worker;
    worker.unref();
    worker.on("message", () => { pendingFailureWrites = Math.max(0, pendingFailureWrites - 1); });
    const reset = () => {
      if (failureWorker === worker) failureWorker = undefined;
      pendingFailureWrites = 0;
    };
    worker.on("error", reset);
    worker.on("exit", reset);
  }
  pendingFailureWrites += 1;
  try {
    failureWorker.postMessage({ logPath, line });
  } catch {
    pendingFailureWrites -= 1;
  }
}

export type FailureClass =
  | "validation_error"
  | "timeout"
  | "cancelled"
  | "nonzero_exit"
  | "packet_failed"
  | "missing_session_id"
  | "missing_final_output"
  | "restart_drift"
  | "resource_exhausted"
  | "session_error"
  | "signal_terminated"
  | "unknown_error";

export interface FailureLogRecord {
  schema_version: 2;
  event_id: string;
  timestamp: string;
  server_version: string;
  calibration_era: string;
  build_sha?: string;
  record_source: FailureRecordSource;
  campaign_id?: string;
  tool: FailureLogTool;
  failure_class: FailureClass;
  reason_code: FailureReasonCode;
  cwd_class: FailureCwdClass;
  cwd?: string;
  run_id?: string;
  task_kind?: "run" | "session";
  output_path?: string | null;
  session_key?: string;
  session_dir?: string;
  success?: boolean;
  exit_code?: number | null;
  timed_out?: boolean;
  duration_ms?: number;
  requested_timeout_ms?: number | null;
  resolved_timeout_ms?: number | null;
  timeout_floor_ms?: number;
  effective_timeout_ms?: number | null;
  timeout_headroom_ms?: number;
  kill_grace_ms?: number;
  force_grace_ms?: number;
  partial_output_available?: boolean;
  resume_possible?: boolean;
  stop_reason?: string;
  stop_signal?: string | null;
  auto_promoted_from?: "run_subagent";
  promotion_reason_code?: string;
  promotion_reason?: string;
  model_class?: string;
  skill?: string | null;
  output_mode?: string;
  provider_error_type?: string;
  provider_status_code?: number;
  provider_error_message?: string;
  usage_limit_plan_type?: string | null;
  usage_limit_resets_at?: number | null;
  usage_limit_resets_in_seconds?: number | null;
  usage_limit_retry_after_seconds?: number | null;
  usage_limit_primary_used_percent?: number | null;
  usage_limit_secondary_used_percent?: number | null;
  usage_limit_primary_reset_after_seconds?: number | null;
  usage_limit_secondary_reset_after_seconds?: number | null;
}

function defaultFailureLogPath(): string {
  return defaultSubagentStatePath("SUBAGENT007_FAILURE_LOG_PATH", "failures.jsonl");
}

function recordSourceFromEnv(): FailureRecordSource {
  const source = process.env.SUBAGENT007_RECORD_SOURCE;
  return source === "production" || source === "test" || source === "unknown" ? source : "production";
}

function campaignIdFromEnv(): string | undefined {
  const value = process.env.SUBAGENT007_CAMPAIGN_ID?.trim();
  if (!value) {
    return undefined;
  }
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

function withoutPrivatePrefix(value: string): string {
  return value.startsWith("/private/") ? value.slice("/private".length) : value;
}

function classifyFailureCwd(cwd: string | undefined): FailureCwdClass {
  if (!cwd) {
    return "missing";
  }
  if (!path.isAbsolute(cwd)) {
    return "relative";
  }
  const normalizedCwd = path.normalize(cwd);
  const normalizedTmp = path.normalize(os.tmpdir());
  const tmpWithoutPrivate = withoutPrivatePrefix(normalizedTmp);
  const cwdWithoutPrivate = withoutPrivatePrefix(normalizedCwd);
  return cwdWithoutPrivate === tmpWithoutPrivate || cwdWithoutPrivate.startsWith(`${tmpWithoutPrivate}${path.sep}`)
    ? "temp"
    : "absolute";
}

function defaultReasonCode(failureClass: FailureClass): FailureReasonCode {
  switch (failureClass) {
    case "timeout":
      return "timeout";
    case "cancelled":
      return "cancelled_before_first_output";
    case "nonzero_exit":
      return "nonzero_exit";
    case "missing_session_id":
      return "missing_session_id";
    case "missing_final_output":
      return "missing_final_output";
    case "restart_drift":
      return "server_restarted_active_run";
    case "resource_exhausted":
      return "disk_reserve_exhausted";
    case "packet_failed":
      return "packet_required_invalid";
    case "validation_error":
      return "unknown_validation_error";
    case "session_error":
      return "handler_error";
    case "signal_terminated":
      return "process_signal_terminated";
    case "unknown_error":
      return "unknown_error";
  }
}

export async function logFailure(
  record: Omit<
    FailureLogRecord,
    | "schema_version"
    | "event_id"
    | "timestamp"
    | "server_version"
    | "build_sha"
    | "record_source"
    | "cwd_class"
    | "calibration_era"
  > & { reason_code?: FailureReasonCode },
): Promise<void> {
  if (process.env.SUBAGENT007_FAILURE_LOG === "off") {
    return;
  }
  try {
    const logPath = defaultFailureLogPath();
    const buildSha = serverBuildSha();
    const campaignId = campaignIdFromEnv();
    const fullRecord: FailureLogRecord = {
      schema_version: 2,
      event_id: timestampedRandomId(),
      timestamp: new Date().toISOString(),
      server_version: SERVER_VERSION,
      calibration_era: CURRENT_CALIBRATION_ERA,
      ...(buildSha ? { build_sha: buildSha } : {}),
      record_source: recordSourceFromEnv(),
      ...(campaignId ? { campaign_id: campaignId } : {}),
      cwd_class: classifyFailureCwd(record.cwd),
      ...record,
      reason_code: record.reason_code ?? defaultReasonCode(record.failure_class),
    };
    enqueueFailureRecord(logPath, JSON.stringify(fullRecord));
  } catch {
    // Failure logging is operational telemetry only; it must never affect tool results.
  }
}

export function failureClassForProcessResult(result: {
  timed_out: boolean;
  exit_code: number | null;
  stop_signal?: string | null;
  reason_code?: FailureReasonCode;
}): FailureClass {
  if (result.timed_out) {
    return "timeout";
  }
  if (result.reason_code === "disk_reserve_exhausted") {
    return "resource_exhausted";
  }
  if (result.exit_code !== null && result.exit_code !== 0) {
    return "nonzero_exit";
  }
  if (result.stop_signal) {
    return "signal_terminated";
  }
  return "unknown_error";
}

function failureClassForThrownError(error: unknown): FailureClass {
  return error instanceof ValidationError ? "validation_error" : "unknown_error";
}

export function failureReasonCodeForError(error: unknown): FailureReasonCode {
  if (!(error instanceof ValidationError)) {
    return "handler_error";
  }
  return error.reasonCode ?? "unknown_validation_error";
}

export function failureClassForToolHandlerError(
  tool: FailureLogTool,
  error: unknown,
): FailureClass {
  const thrownClass = failureClassForThrownError(error);
  return tool === "run_subagent_session" && thrownClass !== "validation_error"
    ? "session_error"
    : thrownClass;
}

function sessionFailureProjection(
  result: {
    session_established: boolean;
    packet_parse_status: string;
    timed_out: boolean;
    exit_code: number | null;
    reason_code?: FailureReasonCode;
  },
  packetSatisfied: boolean,
): { failureClass: FailureClass; reasonCode: FailureReasonCode } {
  if (result.timed_out) {
    return { failureClass: "timeout", reasonCode: "timeout" };
  }
  if (result.reason_code === "disk_reserve_exhausted") {
    return { failureClass: "resource_exhausted", reasonCode: "disk_reserve_exhausted" };
  }
  if (result.exit_code !== null && result.exit_code !== 0) {
    return { failureClass: "nonzero_exit", reasonCode: "nonzero_exit" };
  }
  if (!result.session_established) {
    return { failureClass: "missing_session_id", reasonCode: "missing_session_id" };
  }
  if (result.reason_code === "missing_final_output") {
    return { failureClass: "missing_final_output", reasonCode: "missing_final_output" };
  }
  if (!packetSatisfied) {
    const reasonCode = result.packet_parse_status === "missing"
      ? "packet_required_missing"
      : result.packet_parse_status === "valid"
        ? "packet_required_not_ready"
        : "packet_required_invalid";
    return {
      failureClass: "packet_failed",
      reasonCode,
    };
  }
  return { failureClass: "unknown_error", reasonCode: "unknown_error" };
}

export function failureClassForSessionResult(
  result: {
    session_established: boolean;
    packet_parse_status: string;
    timed_out: boolean;
    exit_code: number | null;
    reason_code?: FailureReasonCode;
  },
  packetSatisfied: boolean,
): FailureClass {
  return sessionFailureProjection(result, packetSatisfied).failureClass;
}

export function failureReasonCodeForSessionResult(
  result: {
    session_established: boolean;
    packet_parse_status: string;
    timed_out: boolean;
    exit_code: number | null;
    reason_code?: FailureReasonCode;
  },
  packetSatisfied: boolean,
): FailureReasonCode {
  return sessionFailureProjection(result, packetSatisfied).reasonCode;
}

export function cwdFromRequest(request: unknown): string | undefined {
  if (typeof request !== "object" || request === null) {
    return undefined;
  }
  const cwd = (request as { cwd?: unknown }).cwd;
  return typeof cwd === "string" && cwd.trim() !== "" ? cwd.trim() : undefined;
}
