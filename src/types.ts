export const THINKING_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const MODEL_CLASSES = ["A", "B", "C", "D", "E"] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];
export const OUTPUT_MODES = ["final", "transcript"] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];
export const TOOL_PROFILES = ["inspect", "shell", "workspace_write"] as const;
export type ToolProfile = (typeof TOOL_PROFILES)[number];
export const RUN_KINDS = ["quick_noninteractive"] as const;
export type RunKind = (typeof RUN_KINDS)[number];
export const RUN_CONTINUITY_MODES = ["ephemeral", "fresh", "resume"] as const;
export const SESSION_PACKET_POLICIES = ["none", "required", "best_effort"] as const;
export type SessionPacketPolicy = (typeof SESSION_PACKET_POLICIES)[number];
export const RESUME_MODES = ["new", "resume_or_new", "require_existing"] as const;
export type ResumeMode = (typeof RESUME_MODES)[number];
export const PACKET_PARSE_STATUSES = ["valid", "missing", "invalid", "not_run"] as const;
export type PacketParseStatus = (typeof PACKET_PARSE_STATUSES)[number];
export const RUN_STOP_REASONS = ["completed", "failed", "timeout", "cancelled", "spawn_error"] as const;
export type RunStopReason = (typeof RUN_STOP_REASONS)[number];

export interface SubagentRequestBase {
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
  toolProfile: ToolProfile;
}

export interface PromptProvenance {
  public_prompt: string;
  skill_name?: string;
  skill_marker?: string;
  packet_policy?: SessionPacketPolicy;
  packet_marker?: string;
  composed_child_prompt: string;
}

export interface SubagentRunResultBase {
  output_path: string;
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
  resolved_model: string;
  resolved_thinking_level: string;
  resolved_model_class: ModelClass;
  requested_skill: string | null;
  requested_output_mode: OutputMode;
  written_output_mode: OutputMode;
  resolved_tool_profile: ToolProfile;
  stop_reason: RunStopReason;
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
  status: "completed" | "failed" | "cancelled" | "input_required" | "working";
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
  resolved_model: string;
  resolved_thinking_level: string;
  resolved_model_class?: ModelClass;
  requested_skill: string | null;
  requested_output_mode: OutputMode;
  written_output_mode: OutputMode;
  resolved_tool_profile?: ToolProfile;
  stop_reason?: RunStopReason;
  error?: string;
}

export interface SessionManifest {
  schema_version: 1;
  session_key: string;
  cwd: string;
  skill: string | null;
  initial_model: string;
  initial_thinking_level: string;
  initial_model_class?: ModelClass;
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
  thinking_level_changed_from_manifest: boolean;
}

export interface PreflightRejectedResult {
  status: "rejected";
  kind: "preflight_rejected";
  success: false;
  child_started: false;
  error_class: "validation_error";
  reason_code: string;
  message: string;
  retry_guidance?: string;
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

export interface ContractPacketFinding {
  severity: "high" | "medium" | "low";
  claim: string;
  evidence: string;
  required_repair?: string;
}

export interface ContractPacketClosure {
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
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
