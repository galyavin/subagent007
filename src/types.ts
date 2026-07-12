export const THINKING_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const MODEL_CLASSES = ["A", "B", "C", "D", "E"] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];
export const OUTPUT_MODES = ["final", "transcript"] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];
export const TOOL_PROFILES = ["all", "inspect", "web_search", "shell", "workspace_write"] as const;
export type ToolProfile = (typeof TOOL_PROFILES)[number];
export const NON_TERMINAL_RUN_STATUSES = ["working", "input_required"] as const;
export const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled", "timed_out"] as const;
const RUN_STATUSES = [...NON_TERMINAL_RUN_STATUSES, ...TERMINAL_RUN_STATUSES] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const RUN_KINDS = ["quick_noninteractive"] as const;
type RunKind = (typeof RUN_KINDS)[number];
export const RUN_CONTINUITY_MODES = ["ephemeral", "fresh", "resume"] as const;
export const SESSION_PACKET_POLICIES = ["none", "required", "best_effort"] as const;
export type SessionPacketPolicy = (typeof SESSION_PACKET_POLICIES)[number];
export const RESUME_MODES = ["new", "resume_or_new", "require_existing"] as const;
export type ResumeMode = (typeof RESUME_MODES)[number];
export const PACKET_PARSE_STATUSES = ["valid", "missing", "invalid", "not_run"] as const;
export type PacketParseStatus = (typeof PACKET_PARSE_STATUSES)[number];
export const RUN_STOP_REASONS = [
  "completed",
  "failed",
  "timeout",
  "cancelled",
  "spawn_error",
  "resource_exhausted",
] as const;
export type RunStopReason = (typeof RUN_STOP_REASONS)[number];

export type FailureReasonCode =
  | "child_entrypoint_missing"
  | "child_entrypoint_not_file"
  | "config_missing_default_model_class"
  | "cancelled_before_first_output"
  | "cwd_inaccessible"
  | "cwd_not_absolute"
  | "cwd_not_directory"
  | "disk_reserve_exhausted"
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
  | "invalid_wait_ms"
  | "local_capacity_exhausted"
  | "timeout_underbudget_for_deadline_risk"
  | "missing_session_id"
  | "missing_final_output"
  | "nonzero_exit"
  | "packet_required_invalid"
  | "packet_required_missing"
  | "packet_required_not_ready"
  | "prompt_missing"
  | "raw_session_id_unsupported"
  | "recursive_control_invalid"
  | "recursive_depth_exceeded"
  | "run_not_accepting_input"
  | "run_not_found"
  | "run_subagent_incompatible_workload"
  | "run_subagent_timeout_unsupported"
  | "input_request_already_answered"
  | "input_request_already_closed"
  | "input_request_already_timed_out"
  | "input_request_not_found"
  | "input_request_not_part_of_run"
  | "input_response_id_conflict"
  | "session_already_exists"
  | "session_already_running"
  | "session_cwd_mismatch"
  | "session_does_not_exist"
  | "session_ledger_invalid"
  | "session_manifest_invalid"
  | "session_skill_mismatch"
  | "server_restarted_active_run"
  | "spawn_error"
  | "timeout"
  | "usage_limit_reached"
  | "process_signal_terminated"
  | "unknown_error"
  | "unknown_validation_error";

interface SubagentRequestBase {
  prompt: string;
  cwd: string;
  model_class?: ModelClass;
  timeout_ms?: number;
  skill?: string | null;
  skill_name?: string | null;
  output_mode?: OutputMode;
  tool_profile?: ToolProfile;
}

export type RunContinuity =
  | { mode: "ephemeral" }
  | { mode: "fresh" }
  | { mode: "resume"; session_id: string };

export interface RunSubagentRequest extends SubagentRequestBase {
  continuity?: RunContinuity;
  run_kind?: RunKind;
}

export interface RunnerConfig {
  default_model_class?: ModelClass;
}

export interface ResolvedRunSubagentRequest {
  prompt: string;
  cwd: string;
  modelClass: ModelClass;
  model: string;
  thinkingLevel: ThinkingLevel;
  timeoutMs?: number;
  continuity: RunContinuity;
  skill?: string;
  outputMode: OutputMode;
}

export interface PromptProvenance {
  /**
   * Safe public projection of the caller prompt. Never store the raw prompt here.
   */
  public_prompt: string;
  skill_name?: string;
  skill_marker?: string;
  packet_policy?: SessionPacketPolicy;
  packet_marker?: string;
  composed_child_prompt: string;
}

interface SubagentRunResultBase {
  output_path: string;
  output_references: RunOutputReference[];
  success: boolean;
  exit_code: number | null;
  timed_out: boolean;
  partial_output_available: boolean;
  resume_possible: boolean;
  duration_ms: number;
  requested_timeout_ms: number | null;
  resolved_timeout_ms: number | null;
  timeout_floor_ms: number;
  effective_timeout_ms: number | null;
  timeout_headroom_ms: number;
  kill_grace_ms: number;
  force_grace_ms: number;
  size_bytes: number;
  resolved_model_class: ModelClass;
  requested_skill: string | null;
  resolved_skill_path: string | null;
  resolved_skill_sha256: string | null;
  requested_output_mode: OutputMode;
  written_output_mode: OutputMode;
  stop_reason: RunStopReason;
  stop_signal: string | null;
  error_class?: string;
  reason_code?: FailureReasonCode;
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

interface RunOutputReference {
  kind: "file";
  name: "primary";
  path: string;
  size_bytes: number;
  content_type: "text/markdown";
  encoding: "utf-8";
  output_mode: OutputMode;
}

export type RunSubagentPromotionReasonCode =
  | "skill_bound"
  | "prompt_too_long"
  | "broad_work"
  | "workspace_write";

export interface RunSubagentPromotion {
  auto_promoted_from: "run_subagent";
  promotion_reason_code: RunSubagentPromotionReasonCode;
  promotion_reason: string;
  poll_with: "get_run";
  cancel_with: "cancel_run";
}

export interface RunSubagentResult extends SubagentRunResultBase {
  run_id: string;
  task_id: string;
  status: RunStatus;
  timeout_recovery_hint?: string;
  session_id: string | null;
  session_established: boolean;
  input_requests_dir: string;
  auto_promoted_from?: RunSubagentPromotion["auto_promoted_from"];
  promotion_reason_code?: RunSubagentPromotion["promotion_reason_code"];
  promotion_reason?: RunSubagentPromotion["promotion_reason"];
  poll_with?: RunSubagentPromotion["poll_with"];
  cancel_with?: RunSubagentPromotion["cancel_with"];
}

export interface RunSubagentSessionRequest extends SubagentRequestBase {
  session_key: string;
  resume_mode?: ResumeMode;
  packet_policy?: SessionPacketPolicy;
}

export interface SessionRunRecord {
  run_id: string;
  sequence: number;
  started_at: string;
  finished_at: string;
  action: "created" | "resumed" | "not_created";
  subagent_session_id: string | null;
  attempt_subagent_session_id?: string | null;
  attempt_session_established?: boolean;
  resume_mode: ResumeMode;
  output_path: string;
  packet_path: string | null;
  packet_policy: SessionPacketPolicy;
  packet_parse_status: PacketParseStatus;
  packet_error?: string;
  success: boolean;
  exit_code: number | null;
  timed_out: boolean;
  partial_output_available?: boolean;
  resume_possible?: boolean;
  duration_ms: number;
  requested_timeout_ms?: number | null;
  resolved_timeout_ms?: number | null;
  timeout_floor_ms?: number;
  effective_timeout_ms?: number | null;
  timeout_headroom_ms?: number;
  kill_grace_ms?: number;
  force_grace_ms?: number;
  resolved_model_class?: ModelClass;
  requested_skill: string | null;
  resolved_skill_path?: string | null;
  resolved_skill_sha256?: string | null;
  requested_output_mode: OutputMode;
  written_output_mode: OutputMode;
  stop_reason?: RunStopReason;
  stop_signal?: string | null;
  error?: string;
}

export interface SessionManifest {
  schema_version: 1;
  session_key: string;
  cwd: string;
  skill: string | null;
  initial_model_class?: ModelClass;
  initial_model?: string;
  subagent_session_id: string;
  created_at: string;
  last_run_at: string;
  run_count: number;
  last_output_path: string;
  status: "active";
}

export interface RunSubagentSessionResult extends SubagentRunResultBase {
  session_key: string;
  session_dir: string;
  manifest_path: string;
  ledger_path: string;
  attempts_path: string;
  subagent_session_id: string | null;
  attempt_subagent_session_id?: string | null;
  attempt_session_established?: boolean;
  session_established: boolean;
  created_or_resumed: "created" | "resumed" | "not_created";
  resume_mode: ResumeMode;
  requested_packet_policy: SessionPacketPolicy;
  packet_path: string | null;
  packet_parse_status: PacketParseStatus;
  packet_error?: string;
  claimed_packet: ContractPacketV1 | null;
  run_record: SessionRunRecord;
  model_changed_from_manifest: boolean;
}

export interface PreflightRejectedResult {
  status: "rejected";
  kind: "preflight_rejected";
  success: false;
  child_started: false;
  error_class: "validation_error";
  reason_code: FailureReasonCode;
  message: string;
  retry_guidance?: string;
}

export interface OperationRejectedResult {
  status: "rejected";
  kind: "operation_rejected";
  success: false;
  error_class: "validation_error";
  reason_code: FailureReasonCode;
  message: string;
  run_id?: string;
}

export type RunPublicEventKind =
  | "task"
  | "child"
  | "user"
  | "assistant"
  | "warning"
  | "error"
  | "input"
  | "packet"
  | "terminal";

export type RunPublicEventName =
  | "run_started"
  | "auto_promoted"
  | "child_spawned"
  | "child_bridge_started"
  | "child_session_established"
  | "child_prompt_submitted"
  | "recursive_child_started"
  | "recursive_child_finished"
  | "input_required"
  | "input_answered"
  | "input_timed_out"
  | "input_closed"
  | "timeout"
  | "cancellation_requested"
  | "cancellation_settled"
  | "packet_accepted"
  | "packet_rejected"
  | "completed"
  | "failed"
  | "message";

export interface RunPublicEvent {
  schema_version?: 1;
  kind: RunPublicEventKind;
  event?: RunPublicEventName;
  text: string;
  occurred_at: string;
  metadata?: Record<string, unknown>;
}

interface ContractPacketFinding {
  severity: "high" | "medium" | "low";
  claim: string;
  evidence: string;
  required_repair?: string;
}

interface ContractPacketClosure {
  canonical_closure_source?: string;
  artifact_roles?: Array<{ path: string; role: string }>;
  validation?: string[];
  claim_ceiling?: string;
}

export interface ContractPacketV1 {
  verdict: "ready" | "needs_repair" | "blocked" | "inconclusive";
  summary: string;
  findings: ContractPacketFinding[];
  blockers: string[];
  next_step: string;
  closure?: ContractPacketClosure;
}

export class ValidationError extends Error {
  readonly reasonCode?: FailureReasonCode;

  constructor(message: string, reasonCode?: FailureReasonCode) {
    super(message);
    this.name = "ValidationError";
    this.reasonCode = reasonCode;
  }
}
