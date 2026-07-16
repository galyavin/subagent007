import { SERVER_VERSION, serverBuildSha } from "./runtimeMetadata.js";
import {
  NON_TERMINAL_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  type RunStatus,
} from "./types.js";
import { WORKSPACE_READ_ONLY_TOOL_NAMES } from "./toolProfile.js";

export const DURABLE_RUN_CONTRACT_NAME = "subagent007.durable_run";
export const DURABLE_RUN_CONTRACT_VERSION = 2;

export { NON_TERMINAL_RUN_STATUSES, TERMINAL_RUN_STATUSES };
export type DurableRunStatus = RunStatus;

export const DURABLE_RUN_CAPABILITIES = [
  "run_id_authoritative",
  "stable_terminal_snapshots",
  "first_class_timed_out_status",
  "explicit_error_taxonomy",
  "file_backed_output_references",
  "complete_file_backed_transcripts",
  "bounded_public_output_excerpt",
  "disk_reserve_fail_closed",
  "bounded_local_admission_queue",
  "run_input_mailbox",
  "acknowledged_run_input",
  "live_response_replay",
  "operational_answer_nonretention",
  "terminal_state_compaction",
  "restart_drift_fail_closed",
  "recursive_delegate_lineage",
  "workspace_read_only_effect_profile",
  "pre_prompt_skill_content_binding",
] as const;

export function durableRunContractView(): {
  contract_name: typeof DURABLE_RUN_CONTRACT_NAME;
  contract_version: typeof DURABLE_RUN_CONTRACT_VERSION;
  server_version: string;
  build_sha?: string;
  statuses: {
    non_terminal: typeof NON_TERMINAL_RUN_STATUSES;
    terminal: typeof TERMINAL_RUN_STATUSES;
  };
  capabilities: typeof DURABLE_RUN_CAPABILITIES;
  tools: {
    start: ["start_run", "schedule_run"];
    session_start: ["start_session_run", "run_subagent_session"];
    poll: "get_run";
    answer_input: "answer_run_input";
    cancel: "cancel_run";
  };
  output_reference: {
    field: "output_references";
    kind: "file";
    bounded_inline_fields: ["recent_events", "last_public_output_excerpt"];
    transcript_size_policy: "unbounded_file";
    legacy_path_field: "output_path";
  };
  input_mailbox: {
    address: "run_id/request_id";
    waiting_status: "input_required";
    waiting_status_terminal: false;
    pending_cardinality: "zero_or_more";
    safe_auto_answer: "caller_policy_required";
    multiple_pending_action: "fail_closed";
    duplicate_response: "exact_live_replay_only";
    stale_request_id: "rejected";
    foreign_request_id: "rejected";
    terminal_pending_settlement: "closed_or_timed_out";
    response_id: "required";
    receipt: "child_waiter_accepted";
    replay: "live_exact_response";
    raw_answer_persistence: "forbidden";
    process_loss: "fails_closed";
  };
  effect_profiles: {
    workspace_read_only: {
      supported_tools: typeof WORKSPACE_READ_ONLY_TOOL_NAMES;
      supported_start_tools: ["run_subagent", "start_run", "schedule_run"];
      supported_continuity_modes: ["ephemeral", "fresh", "resume"];
      named_sessions: "unsupported";
      recursive_delegate: "excluded";
      ambient_extensions: "disabled";
      provider_binding: "explicit_identity_and_sha256";
      enforcement_boundary: "pi_create_agent_session_tools_allowlist";
      claim_ceiling: "pi_tool_dispatch_not_os_sandbox";
      activation_receipt: {
        result_field: "activation_receipt";
        event_type: "subagent007.activation_confirmed";
        required_before_prompt: true;
        schema_version: 1;
        fields: [
          "schema_version",
          "confirmed_before_prompt",
          "requested_effect_profile",
          "resolved_effect_profile",
          "active_tool_names",
          "tool_bindings",
          "toolset_sha256",
          "skill_binding",
        ];
      };
    };
  };
} {
  const buildSha = serverBuildSha();
  return {
    contract_name: DURABLE_RUN_CONTRACT_NAME,
    contract_version: DURABLE_RUN_CONTRACT_VERSION,
    server_version: SERVER_VERSION,
    ...(buildSha ? { build_sha: buildSha } : {}),
    statuses: {
      non_terminal: NON_TERMINAL_RUN_STATUSES,
      terminal: TERMINAL_RUN_STATUSES,
    },
    capabilities: DURABLE_RUN_CAPABILITIES,
    tools: {
      start: ["start_run", "schedule_run"],
      session_start: ["start_session_run", "run_subagent_session"],
      poll: "get_run",
      answer_input: "answer_run_input",
      cancel: "cancel_run",
    },
    output_reference: {
      field: "output_references",
      kind: "file",
      bounded_inline_fields: ["recent_events", "last_public_output_excerpt"],
      transcript_size_policy: "unbounded_file",
      legacy_path_field: "output_path",
    },
    input_mailbox: {
      address: "run_id/request_id",
      waiting_status: "input_required",
      waiting_status_terminal: false,
      pending_cardinality: "zero_or_more",
      safe_auto_answer: "caller_policy_required",
      multiple_pending_action: "fail_closed",
      duplicate_response: "exact_live_replay_only",
      stale_request_id: "rejected",
      foreign_request_id: "rejected",
      terminal_pending_settlement: "closed_or_timed_out",
      response_id: "required",
      receipt: "child_waiter_accepted",
      replay: "live_exact_response",
      raw_answer_persistence: "forbidden",
      process_loss: "fails_closed",
    },
    effect_profiles: {
      workspace_read_only: {
        supported_tools: WORKSPACE_READ_ONLY_TOOL_NAMES,
        supported_start_tools: ["run_subagent", "start_run", "schedule_run"],
        supported_continuity_modes: ["ephemeral", "fresh", "resume"],
        named_sessions: "unsupported",
        recursive_delegate: "excluded",
        ambient_extensions: "disabled",
        provider_binding: "explicit_identity_and_sha256",
        enforcement_boundary: "pi_create_agent_session_tools_allowlist",
        claim_ceiling: "pi_tool_dispatch_not_os_sandbox",
        activation_receipt: {
          result_field: "activation_receipt",
          event_type: "subagent007.activation_confirmed",
          required_before_prompt: true,
          schema_version: 1,
          fields: [
            "schema_version",
            "confirmed_before_prompt",
            "requested_effect_profile",
            "resolved_effect_profile",
            "active_tool_names",
            "tool_bindings",
            "toolset_sha256",
            "skill_binding",
          ],
        },
      },
    },
  };
}
