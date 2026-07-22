import { SERVER_VERSION, serverBuildSha } from "./runtimeMetadata.js";
import {
  NON_TERMINAL_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  type RunStatus,
} from "./types.js";
import {
  ASSUMPTION_AUDIT_BOUNDED_V1_TOOL_NAMES,
  RESEARCHER_BOUNDED_V1_TOOL_NAMES,
  SKILL_CREATOR_AUTHORING_V1_TOOL_NAMES,
  TASK_ROOT_AUTHORING_V1_TOOL_NAMES,
  WORKSPACE_READ_ONLY_TOOL_NAMES,
} from "./toolProfile.js";
import {
  MAX_SKILL_BINDING_VERIFICATION_ENTRIES,
  SKILL_BINDING_VERIFICATION_CONTRACT_NAME,
  SKILL_BINDING_VERIFICATION_CONTRACT_VERSION,
} from "./skillVerification.js";
import {
  MAX_SKILL_BINDING_RESOLUTION_ENTRIES,
  SKILL_BINDING_RESOLUTION_CONTRACT_NAME,
  SKILL_BINDING_RESOLUTION_CONTRACT_VERSION,
} from "./skillResolution.js";
import {
  MAX_SKILL_RUNTIME_BUNDLE_RESOLUTION_ENTRIES,
  SKILL_RUNTIME_BUNDLE_RESOLUTION_CONTRACT_NAME,
  SKILL_RUNTIME_BUNDLE_RESOLUTION_CONTRACT_VERSION,
} from "./skillSnapshot.js";
import { SKILL_RUNTIME_BUNDLE_ALGORITHM } from "./skillRuntimeBundle.js";
import { SKILL_RUNTIME_BUNDLE_VALIDATION_CONTRACT_NAME } from "./skillRuntimeBundleValidation.js";
import {
  MAX_AUTHORING_INITIAL_FILE_BYTES,
  MAX_AUTHORING_INITIAL_FILES,
  MAX_AUTHORING_INITIAL_TOTAL_BYTES,
  MAX_AUTHORING_WRITABLE_FILE_BYTES,
  MAX_AUTHORING_WRITABLE_TOTAL_BYTES,
} from "./authoringEffectScope.js";

export const DURABLE_RUN_CONTRACT_NAME = "subagent007.durable_run";
export const DURABLE_RUN_CONTRACT_VERSION = 3;

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
  "skill_creator_authoring_v1_effect_profile",
  "task_root_authoring_v1_effect_profile",
  "authoring_effect_scope_binding",
  "idempotent_start_by_client_id",
  "researcher_bounded_v1_effect_profile",
  "assumption_audit_bounded_v1_effect_profile",
  "pre_prompt_skill_content_binding",
  "batch_skill_binding_verification",
  "batch_skill_binding_resolution",
  "full_runtime_bundle_resolution",
  "exact_root_runtime_bundle_validation",
  "immutable_skill_snapshots",
  "snapshot_bound_launch",
  "reference_retained_skill_snapshots",
  "retained_skill_snapshot_source_resolution",
  "explicit_skill_snapshot_deletion",
  "explicit_recursive_delegation",
  "terminal_recursive_subtree_closure",
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
  idempotent_start: {
    request_field: "client_start_id";
    supported_tool: "start_run";
    request_hash: "canonical_validated_request_excluding_client_start_id";
    binding_field: "client_start_binding";
    binding_persistence: "atomic_before_child_spawn";
    binding_durability: "file_and_parent_directory_fsync";
    replay: "same_run_across_process_restart";
    conflict_reason_code: "client_start_id_conflict";
    lookup_tool: "none";
    lost_owner_terminal: "restart_drift";
  };
  skill_binding_verification: {
    tool: "verify_skill_bindings";
    contract_name: typeof SKILL_BINDING_VERIFICATION_CONTRACT_NAME;
    contract_version: typeof SKILL_BINDING_VERIFICATION_CONTRACT_VERSION;
    max_bindings: typeof MAX_SKILL_BINDING_VERIFICATION_ENTRIES;
    all_or_nothing: true;
    model_invocation: "none";
    operational_state_writes: "none";
    verification_scope: "point_in_time";
    launch_recheck_required: true;
  };
  skill_binding_resolution: {
    tool: "resolve_skill_bindings";
    contract_name: typeof SKILL_BINDING_RESOLUTION_CONTRACT_NAME;
    contract_version: typeof SKILL_BINDING_RESOLUTION_CONTRACT_VERSION;
    max_skill_names: typeof MAX_SKILL_BINDING_RESOLUTION_ENTRIES;
    all_or_nothing: true;
    model_invocation: "none";
    operational_state_writes: "none";
    resolution_scope: "point_in_time";
    launch_recheck_required: true;
  };
  skill_runtime_bundle_resolution: {
    tool: "resolve_skill_runtime_bundles";
    contract_name: typeof SKILL_RUNTIME_BUNDLE_RESOLUTION_CONTRACT_NAME;
    contract_version: typeof SKILL_RUNTIME_BUNDLE_RESOLUTION_CONTRACT_VERSION;
    max_skill_names: typeof MAX_SKILL_RUNTIME_BUNDLE_RESOLUTION_ENTRIES;
    digest_algorithm: typeof SKILL_RUNTIME_BUNDLE_ALGORITHM;
    all_or_nothing: true;
    model_invocation: "none";
    operational_state_writes: "none";
    resolution_scope: "point_in_time";
    executable_identity: false;
  };
  skill_runtime_bundle_validation: {
    tool: "validate_skill_runtime_bundle";
    contract_name: typeof SKILL_RUNTIME_BUNDLE_VALIDATION_CONTRACT_NAME;
    contract_version: 1;
    digest_algorithm: typeof SKILL_RUNTIME_BUNDLE_ALGORITHM;
    catalog_resolution: "none";
    model_invocation: "none";
    operational_state_writes: "none";
    valid_root_contexts: ["settled_staging", "canonical_source"];
  };
  skill_snapshot_foundation: {
    publication_tool: "publish_skill_snapshots";
    source_resolution_tool: "resolve_retained_skill_snapshot_source";
    deletion_plan_tool: "plan_skill_snapshot_deletion";
    deletion_tool: "delete_skill_snapshot";
    close_references_tool: "close_skill_snapshot_references";
    contract_version: 1;
    identity: "content_addressed_complete_runtime_bundle";
    project_reference_lifecycles: ["active", "closed"];
    project_reference_identity: "project_id_and_stable_publication_id";
    publication_identity_cardinality: "one_canonical_request_and_snapshot_set";
    publication_replay: "pending_resume_or_committed_exact_replay";
    publication_conflict: "fail_closed";
    source_resolution_scope: "point_in_time";
    source_resolution_state_writes: "none";
    source_resolution_reference_lifecycles: ["active", "closed"];
    consumer_copy_revalidation_required: true;
    automatic_gc: "disabled";
    referenced_snapshot_gc: "forbidden";
    deletion_authorization: "exact_fresh_impact_sha256";
    source_updates: "future_publications_only";
    concurrent_pinned_versions: true;
    named_sessions: "unsupported";
    launch: {
      request_field: "skill_snapshot_binding";
      supported_start_tools: ["run_subagent", "start_run", "schedule_run"];
      supported_continuity_modes: ["ephemeral", "fresh", "resume"];
      pre_prompt_revalidation: "parent_and_pi_child";
      activation_receipt_field: "skill_snapshot_activation_receipt";
      activation_event_type: "subagent007.skill_snapshot_activation_confirmed";
    };
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
    task_root_authoring_v1: {
      supported_tools: typeof TASK_ROOT_AUTHORING_V1_TOOL_NAMES;
      supported_start_tools: ["run_subagent", "start_run", "schedule_run"];
      supported_continuity_modes: ["ephemeral", "fresh", "resume"];
      named_sessions: "unsupported";
      recursive_delegate: "excluded";
      ambient_extensions: "disabled";
      enforcement_boundary: "pi_create_agent_session_tools_allowlist_and_task_root_path_guards";
      task_root: "exact_run_cwd";
      request_field: "allowed_output_paths";
      request_field_required: true;
      task_root_write_scope: "exact_declared_new_output_files";
      immutable_input_scope: "bounded_initial_task_root_regular_tree_excluding_declared_outputs";
      immutable_file_limit: typeof MAX_AUTHORING_INITIAL_FILES;
      immutable_file_max_bytes: typeof MAX_AUTHORING_INITIAL_FILE_BYTES;
      immutable_total_max_bytes: typeof MAX_AUTHORING_INITIAL_TOTAL_BYTES;
      writable_file_max_bytes: typeof MAX_AUTHORING_WRITABLE_FILE_BYTES;
      writable_total_max_bytes: typeof MAX_AUTHORING_WRITABLE_TOTAL_BYTES;
      sparse_regular_files: "rejected";
      multi_link_regular_files: "rejected";
      terminal_closure: "initial_tree_unchanged_all_declared_outputs_present_no_extra_entries";
      terminal_reinspection: "every_settled_child_outcome";
      snapshot_runtime_read_scope: "active_validated_snapshot_runtime_root_or_none";
      claim_ceiling: "pi_tool_dispatch_path_controller_and_terminal_reinspection_not_os_sandbox";
      activation_receipt: {
        result_field: "activation_receipt";
        event_type: "subagent007.activation_confirmed";
        required_before_prompt: true;
        schema_version: 2;
        fields: [
          "schema_version",
          "confirmed_before_prompt",
          "requested_effect_profile",
          "resolved_effect_profile",
          "active_tool_names",
          "tool_bindings",
          "toolset_sha256",
          "skill_binding",
          "effect_scope_binding",
        ];
      };
    };
    skill_creator_authoring_v1: {
      supported_tools: typeof SKILL_CREATOR_AUTHORING_V1_TOOL_NAMES;
      supported_start_tools: ["run_subagent", "start_run", "schedule_run"];
      supported_continuity_modes: ["ephemeral", "fresh", "resume"];
      named_sessions: "unsupported";
      recursive_delegate: "excluded";
      ambient_extensions: "disabled";
      enforcement_boundary: "pi_create_agent_session_tools_allowlist_and_task_root_path_guards";
      task_root: "exact_run_cwd";
      task_root_write_scope: "exact_real_run_cwd";
      snapshot_runtime_read_scope: "active_validated_snapshot_runtime_root_or_none";
      claim_ceiling: "pi_tool_dispatch_and_path_guards_not_os_sandbox";
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
    researcher_bounded_v1: {
      supported_tools: typeof RESEARCHER_BOUNDED_V1_TOOL_NAMES;
      supported_start_tools: ["run_subagent", "start_run", "schedule_run"];
      supported_continuity_modes: ["ephemeral", "fresh"];
      named_sessions: "unsupported";
      recursive_delegate: "excluded";
      ambient_extensions: "disabled";
      provider_binding: "explicit_identity_and_sha256";
      controller_binding: "fixed_wrapper_exact_snapshot_script_and_resolved_python_sha256";
      enforcement_boundary: "pi_create_agent_session_tools_allowlist_and_task_root_path_guards_and_execfile_controller";
      task_root: "exact_run_cwd";
      task_root_write_scope: "exact_fixed_profile_state_subtree";
      snapshot_runtime_read_scope: "active_validated_snapshot_runtime_root";
      state_scope: ".subagent007/researcher_bounded_v1";
      state_initialization: "state_root_absent_at_parent_and_child_pre_prompt_capture";
      controller_mutation_scope: "exact_fixed_profile_state_subtree";
      controller_read_scope: "validated_task_root_inputs";
      immutable_input_scope: "bounded_initial_task_root_tree_outside_fixed_state_subtree";
      writable_file_max_bytes: typeof MAX_AUTHORING_WRITABLE_FILE_BYTES;
      writable_total_max_bytes: typeof MAX_AUTHORING_WRITABLE_TOTAL_BYTES;
      sparse_regular_files: "rejected";
      multi_link_regular_files: "rejected";
      terminal_reinspection: "every_settled_child_outcome";
      claim_ceiling: "pi_tool_dispatch_path_controller_and_terminal_reinspection_not_os_sandbox";
      activation_receipt: {
        result_field: "activation_receipt";
        event_type: "subagent007.activation_confirmed";
        required_before_prompt: true;
        schema_version: 2;
        fields: [
          "schema_version",
          "confirmed_before_prompt",
          "requested_effect_profile",
          "resolved_effect_profile",
          "active_tool_names",
          "tool_bindings",
          "toolset_sha256",
          "skill_binding",
          "effect_scope_binding",
        ];
      };
    };
    assumption_audit_bounded_v1: {
      supported_tools: typeof ASSUMPTION_AUDIT_BOUNDED_V1_TOOL_NAMES;
      supported_start_tools: ["run_subagent", "start_run", "schedule_run"];
      supported_continuity_modes: ["ephemeral", "fresh"];
      named_sessions: "unsupported";
      recursive_delegate: "excluded";
      ambient_extensions: "disabled";
      provider_binding: "explicit_identity_and_sha256";
      controller_binding: "fixed_wrapper_exact_snapshot_script_and_resolved_python_sha256";
      enforcement_boundary: "pi_create_agent_session_tools_allowlist_and_task_root_path_guards_and_execfile_controller";
      task_root: "exact_run_cwd";
      task_root_write_scope: "exact_fixed_profile_state_subtree";
      snapshot_runtime_read_scope: "active_validated_snapshot_runtime_root";
      state_scope: ".subagent007/assumption_audit_bounded_v1";
      state_initialization: "state_root_absent_at_parent_and_child_pre_prompt_capture";
      controller_mutation_scope: "exact_fixed_profile_state_subtree";
      controller_read_scope: "validated_task_root_inputs";
      immutable_input_scope: "bounded_initial_task_root_tree_outside_fixed_state_subtree";
      writable_file_max_bytes: typeof MAX_AUTHORING_WRITABLE_FILE_BYTES;
      writable_total_max_bytes: typeof MAX_AUTHORING_WRITABLE_TOTAL_BYTES;
      sparse_regular_files: "rejected";
      multi_link_regular_files: "rejected";
      terminal_reinspection: "every_settled_child_outcome";
      claim_ceiling: "pi_tool_dispatch_path_controller_and_terminal_reinspection_not_os_sandbox";
      activation_receipt: {
        result_field: "activation_receipt";
        event_type: "subagent007.activation_confirmed";
        required_before_prompt: true;
        schema_version: 2;
        fields: [
          "schema_version",
          "confirmed_before_prompt",
          "requested_effect_profile",
          "resolved_effect_profile",
          "active_tool_names",
          "tool_bindings",
          "toolset_sha256",
          "skill_binding",
          "effect_scope_binding",
        ];
      };
    };
  };
  recursive_delegation: {
    request_field: "recursive_delegation";
    values: ["disabled", "enabled"];
    omitted: "disabled";
    raw_resume: "explicit_reauthorization_required";
    named_sessions: "unsupported";
    enabled_scope: "entire_depth_bounded_subtree";
    descendant_widening: "forbidden";
    parent_terminal_rule: "full_subtree_terminal";
    descendant_ids_field: "descendant_run_ids";
    descendant_statuses_field: "descendant_terminal_statuses";
    receipt: {
      result_field: "recursive_delegation_receipt";
      event_type: "subagent007.recursive_delegation_confirmed";
      required_before_prompt: true;
      schema_version: 1;
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
    idempotent_start: {
      request_field: "client_start_id",
      supported_tool: "start_run",
      request_hash: "canonical_validated_request_excluding_client_start_id",
      binding_field: "client_start_binding",
      binding_persistence: "atomic_before_child_spawn",
      binding_durability: "file_and_parent_directory_fsync",
      replay: "same_run_across_process_restart",
      conflict_reason_code: "client_start_id_conflict",
      lookup_tool: "none",
      lost_owner_terminal: "restart_drift",
    },
    skill_binding_verification: {
      tool: "verify_skill_bindings",
      contract_name: SKILL_BINDING_VERIFICATION_CONTRACT_NAME,
      contract_version: SKILL_BINDING_VERIFICATION_CONTRACT_VERSION,
      max_bindings: MAX_SKILL_BINDING_VERIFICATION_ENTRIES,
      all_or_nothing: true,
      model_invocation: "none",
      operational_state_writes: "none",
      verification_scope: "point_in_time",
      launch_recheck_required: true,
    },
    skill_binding_resolution: {
      tool: "resolve_skill_bindings",
      contract_name: SKILL_BINDING_RESOLUTION_CONTRACT_NAME,
      contract_version: SKILL_BINDING_RESOLUTION_CONTRACT_VERSION,
      max_skill_names: MAX_SKILL_BINDING_RESOLUTION_ENTRIES,
      all_or_nothing: true,
      model_invocation: "none",
      operational_state_writes: "none",
      resolution_scope: "point_in_time",
      launch_recheck_required: true,
    },
    skill_runtime_bundle_resolution: {
      tool: "resolve_skill_runtime_bundles",
      contract_name: SKILL_RUNTIME_BUNDLE_RESOLUTION_CONTRACT_NAME,
      contract_version: SKILL_RUNTIME_BUNDLE_RESOLUTION_CONTRACT_VERSION,
      max_skill_names: MAX_SKILL_RUNTIME_BUNDLE_RESOLUTION_ENTRIES,
      digest_algorithm: SKILL_RUNTIME_BUNDLE_ALGORITHM,
      all_or_nothing: true,
      model_invocation: "none",
      operational_state_writes: "none",
      resolution_scope: "point_in_time",
      executable_identity: false,
    },
    skill_runtime_bundle_validation: {
      tool: "validate_skill_runtime_bundle",
      contract_name: SKILL_RUNTIME_BUNDLE_VALIDATION_CONTRACT_NAME,
      contract_version: 1,
      digest_algorithm: SKILL_RUNTIME_BUNDLE_ALGORITHM,
      catalog_resolution: "none",
      model_invocation: "none",
      operational_state_writes: "none",
      valid_root_contexts: ["settled_staging", "canonical_source"],
    },
    skill_snapshot_foundation: {
    publication_tool: "publish_skill_snapshots",
      source_resolution_tool: "resolve_retained_skill_snapshot_source",
      deletion_plan_tool: "plan_skill_snapshot_deletion",
      deletion_tool: "delete_skill_snapshot",
      close_references_tool: "close_skill_snapshot_references",
      contract_version: 1,
      identity: "content_addressed_complete_runtime_bundle",
      project_reference_lifecycles: ["active", "closed"],
      project_reference_identity: "project_id_and_stable_publication_id",
      publication_identity_cardinality: "one_canonical_request_and_snapshot_set",
      publication_replay: "pending_resume_or_committed_exact_replay",
      publication_conflict: "fail_closed",
      source_resolution_scope: "point_in_time",
      source_resolution_state_writes: "none",
      source_resolution_reference_lifecycles: ["active", "closed"],
      consumer_copy_revalidation_required: true,
      automatic_gc: "disabled",
      referenced_snapshot_gc: "forbidden",
      deletion_authorization: "exact_fresh_impact_sha256",
      source_updates: "future_publications_only",
      concurrent_pinned_versions: true,
      named_sessions: "unsupported",
      launch: {
        request_field: "skill_snapshot_binding",
        supported_start_tools: ["run_subagent", "start_run", "schedule_run"],
        supported_continuity_modes: ["ephemeral", "fresh", "resume"],
        pre_prompt_revalidation: "parent_and_pi_child",
        activation_receipt_field: "skill_snapshot_activation_receipt",
        activation_event_type: "subagent007.skill_snapshot_activation_confirmed",
      },
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
      task_root_authoring_v1: {
        supported_tools: TASK_ROOT_AUTHORING_V1_TOOL_NAMES,
        supported_start_tools: ["run_subagent", "start_run", "schedule_run"],
        supported_continuity_modes: ["ephemeral", "fresh", "resume"],
        named_sessions: "unsupported",
        recursive_delegate: "excluded",
        ambient_extensions: "disabled",
        enforcement_boundary: "pi_create_agent_session_tools_allowlist_and_task_root_path_guards",
        task_root: "exact_run_cwd",
        request_field: "allowed_output_paths",
        request_field_required: true,
        task_root_write_scope: "exact_declared_new_output_files",
        immutable_input_scope: "bounded_initial_task_root_regular_tree_excluding_declared_outputs",
        immutable_file_limit: MAX_AUTHORING_INITIAL_FILES,
        immutable_file_max_bytes: MAX_AUTHORING_INITIAL_FILE_BYTES,
        immutable_total_max_bytes: MAX_AUTHORING_INITIAL_TOTAL_BYTES,
        writable_file_max_bytes: MAX_AUTHORING_WRITABLE_FILE_BYTES,
        writable_total_max_bytes: MAX_AUTHORING_WRITABLE_TOTAL_BYTES,
        sparse_regular_files: "rejected",
        multi_link_regular_files: "rejected",
        terminal_closure: "initial_tree_unchanged_all_declared_outputs_present_no_extra_entries",
        terminal_reinspection: "every_settled_child_outcome",
        snapshot_runtime_read_scope: "active_validated_snapshot_runtime_root_or_none",
        claim_ceiling: "pi_tool_dispatch_path_controller_and_terminal_reinspection_not_os_sandbox",
        activation_receipt: {
          result_field: "activation_receipt",
          event_type: "subagent007.activation_confirmed",
          required_before_prompt: true,
          schema_version: 2,
          fields: [
            "schema_version",
            "confirmed_before_prompt",
            "requested_effect_profile",
            "resolved_effect_profile",
            "active_tool_names",
            "tool_bindings",
            "toolset_sha256",
            "skill_binding",
            "effect_scope_binding",
          ],
        },
      },
      skill_creator_authoring_v1: {
        supported_tools: SKILL_CREATOR_AUTHORING_V1_TOOL_NAMES,
        supported_start_tools: ["run_subagent", "start_run", "schedule_run"],
        supported_continuity_modes: ["ephemeral", "fresh", "resume"],
        named_sessions: "unsupported",
        recursive_delegate: "excluded",
        ambient_extensions: "disabled",
        enforcement_boundary: "pi_create_agent_session_tools_allowlist_and_task_root_path_guards",
        task_root: "exact_run_cwd",
        task_root_write_scope: "exact_real_run_cwd",
        snapshot_runtime_read_scope: "active_validated_snapshot_runtime_root_or_none",
        claim_ceiling: "pi_tool_dispatch_and_path_guards_not_os_sandbox",
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
      researcher_bounded_v1: {
        supported_tools: RESEARCHER_BOUNDED_V1_TOOL_NAMES,
        supported_start_tools: ["run_subagent", "start_run", "schedule_run"],
        supported_continuity_modes: ["ephemeral", "fresh"],
        named_sessions: "unsupported",
        recursive_delegate: "excluded",
        ambient_extensions: "disabled",
        provider_binding: "explicit_identity_and_sha256",
        controller_binding: "fixed_wrapper_exact_snapshot_script_and_resolved_python_sha256",
        enforcement_boundary: "pi_create_agent_session_tools_allowlist_and_task_root_path_guards_and_execfile_controller",
        task_root: "exact_run_cwd",
        task_root_write_scope: "exact_fixed_profile_state_subtree",
        snapshot_runtime_read_scope: "active_validated_snapshot_runtime_root",
        state_scope: ".subagent007/researcher_bounded_v1",
        state_initialization: "state_root_absent_at_parent_and_child_pre_prompt_capture",
        controller_mutation_scope: "exact_fixed_profile_state_subtree",
        controller_read_scope: "validated_task_root_inputs",
        immutable_input_scope: "bounded_initial_task_root_tree_outside_fixed_state_subtree",
        writable_file_max_bytes: MAX_AUTHORING_WRITABLE_FILE_BYTES,
        writable_total_max_bytes: MAX_AUTHORING_WRITABLE_TOTAL_BYTES,
        sparse_regular_files: "rejected",
        multi_link_regular_files: "rejected",
        terminal_reinspection: "every_settled_child_outcome",
        claim_ceiling: "pi_tool_dispatch_path_controller_and_terminal_reinspection_not_os_sandbox",
        activation_receipt: {
          result_field: "activation_receipt",
          event_type: "subagent007.activation_confirmed",
          required_before_prompt: true,
          schema_version: 2,
          fields: [
            "schema_version",
            "confirmed_before_prompt",
            "requested_effect_profile",
            "resolved_effect_profile",
            "active_tool_names",
            "tool_bindings",
            "toolset_sha256",
            "skill_binding",
            "effect_scope_binding",
          ],
        },
      },
      assumption_audit_bounded_v1: {
        supported_tools: ASSUMPTION_AUDIT_BOUNDED_V1_TOOL_NAMES,
        supported_start_tools: ["run_subagent", "start_run", "schedule_run"],
        supported_continuity_modes: ["ephemeral", "fresh"],
        named_sessions: "unsupported",
        recursive_delegate: "excluded",
        ambient_extensions: "disabled",
        provider_binding: "explicit_identity_and_sha256",
        controller_binding: "fixed_wrapper_exact_snapshot_script_and_resolved_python_sha256",
        enforcement_boundary: "pi_create_agent_session_tools_allowlist_and_task_root_path_guards_and_execfile_controller",
        task_root: "exact_run_cwd",
        task_root_write_scope: "exact_fixed_profile_state_subtree",
        snapshot_runtime_read_scope: "active_validated_snapshot_runtime_root",
        state_scope: ".subagent007/assumption_audit_bounded_v1",
        state_initialization: "state_root_absent_at_parent_and_child_pre_prompt_capture",
        controller_mutation_scope: "exact_fixed_profile_state_subtree",
        controller_read_scope: "validated_task_root_inputs",
        immutable_input_scope: "bounded_initial_task_root_tree_outside_fixed_state_subtree",
        writable_file_max_bytes: MAX_AUTHORING_WRITABLE_FILE_BYTES,
        writable_total_max_bytes: MAX_AUTHORING_WRITABLE_TOTAL_BYTES,
        sparse_regular_files: "rejected",
        multi_link_regular_files: "rejected",
        terminal_reinspection: "every_settled_child_outcome",
        claim_ceiling: "pi_tool_dispatch_path_controller_and_terminal_reinspection_not_os_sandbox",
        activation_receipt: {
          result_field: "activation_receipt",
          event_type: "subagent007.activation_confirmed",
          required_before_prompt: true,
          schema_version: 2,
          fields: [
            "schema_version",
            "confirmed_before_prompt",
            "requested_effect_profile",
            "resolved_effect_profile",
            "active_tool_names",
            "tool_bindings",
            "toolset_sha256",
            "skill_binding",
            "effect_scope_binding",
          ],
        },
      },
    },
    recursive_delegation: {
      request_field: "recursive_delegation",
      values: ["disabled", "enabled"],
      omitted: "disabled",
      raw_resume: "explicit_reauthorization_required",
      named_sessions: "unsupported",
      enabled_scope: "entire_depth_bounded_subtree",
      descendant_widening: "forbidden",
      parent_terminal_rule: "full_subtree_terminal",
      descendant_ids_field: "descendant_run_ids",
      descendant_statuses_field: "descendant_terminal_statuses",
      receipt: {
        result_field: "recursive_delegation_receipt",
        event_type: "subagent007.recursive_delegation_confirmed",
        required_before_prompt: true,
        schema_version: 1,
      },
    },
  };
}
