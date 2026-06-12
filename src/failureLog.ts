import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { timestampedRandomId } from "./output.js";
import { SERVER_VERSION, serverBuildSha } from "./runtimeMetadata.js";
import { ValidationError } from "./types.js";

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
export type FailureRecordSource = "production" | "test" | "unknown";
export type FailureCwdClass = "missing" | "relative" | "temp" | "absolute";
export const CURRENT_CALIBRATION_ERA = "model_class_v1";

export type FailureClass =
  | "validation_error"
  | "timeout"
  | "nonzero_exit"
  | "packet_failed"
  | "missing_session_id"
  | "session_error"
  | "unknown_error";

export type FailureReasonCode =
  | "config_missing_default_model_class"
  | "cwd_inaccessible"
  | "cwd_not_absolute"
  | "cwd_not_directory"
  | "handler_error"
  | "invalid_output_mode"
  | "invalid_packet_policy"
  | "invalid_model"
  | "invalid_model_class"
  | "model_class_unhealthy"
  | "invalid_resume_mode"
  | "invalid_session_id"
  | "invalid_session_key"
  | "invalid_skill"
  | "invalid_thinking_level"
  | "invalid_tool_profile"
  | "invalid_timeout_ms"
  | "missing_session_id"
  | "nonzero_exit"
  | "packet_required_invalid"
  | "packet_required_missing"
  | "prompt_missing"
  | "raw_session_id_unsupported"
  | "run_not_accepting_input"
  | "run_not_found"
  | "run_subagent_incompatible_workload"
  | "run_subagent_timeout_unsupported"
  | "input_request_already_answered"
  | "input_request_already_closed"
  | "input_request_already_timed_out"
  | "input_request_not_part_of_run"
  | "session_already_exists"
  | "session_already_running"
  | "session_cwd_mismatch"
  | "session_does_not_exist"
  | "session_ledger_invalid"
  | "session_manifest_invalid"
  | "session_skill_mismatch"
  | "timeout"
  | "unknown_error"
  | "unknown_validation_error";

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
  model_class?: string;
  model?: string;
  thinking_level?: string;
  skill?: string | null;
  output_mode?: string;
  tool_profile?: string;
}

function defaultFailureLogPath(): string {
  return process.env.SUBAGENT007_FAILURE_LOG_PATH
    ? path.resolve(process.env.SUBAGENT007_FAILURE_LOG_PATH)
    : path.join(os.homedir(), ".codex", "subagent007-pi", "failures.jsonl");
}

function recordSourceFromEnv(): FailureRecordSource {
  const source = process.env.SUBAGENT007_RECORD_SOURCE;
  return source === "production" || source === "test" || source === "unknown" ? source : "production";
}

export function campaignIdFromEnv(): string | undefined {
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
    case "nonzero_exit":
      return "nonzero_exit";
    case "missing_session_id":
      return "missing_session_id";
    case "packet_failed":
      return "packet_required_invalid";
    case "validation_error":
      return "unknown_validation_error";
    case "session_error":
      return "handler_error";
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
    await fs.mkdir(path.dirname(logPath), { recursive: true });
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
    await fs.appendFile(logPath, `${JSON.stringify(fullRecord)}\n`, "utf8");
  } catch {
    // Failure logging is operational telemetry only; it must never affect tool results.
  }
}

export function failureClassForProcessResult(result: {
  timed_out: boolean;
  exit_code: number | null;
}): FailureClass {
  if (result.timed_out) {
    return "timeout";
  }
  if (result.exit_code !== null && result.exit_code !== 0) {
    return "nonzero_exit";
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
  const message = error.message;
  if (message.includes("cwd must be an absolute path")) return "cwd_not_absolute";
  if (message.includes("cwd is not accessible")) return "cwd_inaccessible";
  if (message.includes("cwd must be a directory")) return "cwd_not_directory";
  if (message.includes("prompt must be a nonempty string")) return "prompt_missing";
  if (message.includes("default_model_class is not configured")) return "config_missing_default_model_class";
  if (message.includes("timeout_ms must be at least") || message.includes("timeout_ms must be a positive integer")) {
    return "invalid_timeout_ms";
  }
  if (message.includes("timeout_ms is not supported by run_subagent")) {
    return "run_subagent_timeout_unsupported";
  }
  if (message.includes("incompatible with run_subagent's quick_noninteractive contract")) {
    return "run_subagent_incompatible_workload";
  }
  if (message.includes("skill must") || message.includes("skill_name") || message.includes("skill invocation syntax")) {
    return "invalid_skill";
  }
  if (message.includes("model is no longer a public input")) return "invalid_model";
  if (message.includes("model_class must")) return "invalid_model_class";
  if (message.includes("known unhealthy for run_subagent one-shot")) return "model_class_unhealthy";
  if (message.includes("thinking_level is calibrated by model_class")) return "invalid_thinking_level";
  if (message.includes("curated Subagent007 Pi allowlist")) return "invalid_model";
  if (message.includes("thinking_level must")) return "invalid_thinking_level";
  if (message.includes("tool_profile must")) return "invalid_tool_profile";
  if (message.includes("output_mode must")) return "invalid_output_mode";
  if (message.includes("resume session ")) return "invalid_session_id";
  if (message.includes("session_id is not supported")) return "raw_session_id_unsupported";
  if (message.includes("session_id")) return "invalid_session_id";
  if (message.includes("run not found")) return "run_not_found";
  if (message.includes("run is not accepting input")) return "run_not_accepting_input";
  if (message.includes("input request is not part of run")) return "input_request_not_part_of_run";
  if (message.includes("input request is already answered")) return "input_request_already_answered";
  if (message.includes("input request is already timed out")) return "input_request_already_timed_out";
  if (message.includes("input request is already closed")) return "input_request_already_closed";
  if (message.includes("session_key must")) return "invalid_session_key";
  if (message.includes("resume_mode must")) return "invalid_resume_mode";
  if (message.includes("packet_policy must")) return "invalid_packet_policy";
  if (message.includes("session already exists")) return "session_already_exists";
  if (message.includes("session is already running")) return "session_already_running";
  if (message.includes("session does not exist")) return "session_does_not_exist";
  if (message.includes("session manifest is invalid") || message.includes("session manifest is unreadable")) {
    return "session_manifest_invalid";
  }
  if (message.includes("session ledger is invalid") || message.includes("session ledger is behind")) {
    return "session_ledger_invalid";
  }
  if (message.includes("session manifest cwd does not match")) return "session_cwd_mismatch";
  if (message.includes("session skill mismatch")) return "session_skill_mismatch";
  return "unknown_validation_error";
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
  },
  packetSatisfied: boolean,
): { failureClass: FailureClass; reasonCode: FailureReasonCode } {
  if (result.timed_out) {
    return { failureClass: "timeout", reasonCode: "timeout" };
  }
  if (result.exit_code !== null && result.exit_code !== 0) {
    return { failureClass: "nonzero_exit", reasonCode: "nonzero_exit" };
  }
  if (!result.session_established) {
    return { failureClass: "missing_session_id", reasonCode: "missing_session_id" };
  }
  if (!packetSatisfied) {
    return {
      failureClass: "packet_failed",
      reasonCode: result.packet_parse_status === "missing"
        ? "packet_required_missing"
        : "packet_required_invalid",
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
