import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createFakePiChild } from "./helpers/fakePiChild.js";
import { readJsonl, withEnv } from "./helpers/testUtils.js";
import * as clientStartAdmissionApi from "../src/clientStartAdmission.js";
import { cancelRunTask, getRunTask, startRunTask } from "../src/runTask.js";
import * as runTaskApi from "../src/runTask.js";
import { skillOnlyActivationReceipt } from "../src/toolProfile.js";

type RunView = {
  run_id: string;
  kind?: string;
  status: string;
  started_at?: string;
  child_started?: boolean;
  success?: boolean;
  exit_code?: number | null;
  timed_out?: boolean;
  resume_possible?: boolean;
  requested_timeout_ms?: number | null;
  resolved_timeout_ms?: number | null;
  effective_timeout_ms?: number | null;
  stop_reason?: string;
  input_requests?: Array<{ status?: string }>;
  reason_code?: string;
  error_class?: string;
  finished_at?: string;
  active_phase?: string;
  client_start_binding?: { client_start_id: string; request_sha256: string; run_id: string };
  recent_events?: Array<{ event?: string; metadata?: Record<string, unknown> }>;
};

function persistedRunView(value: unknown): RunView {
  if (value && typeof value === "object" && "public_view" in value) {
    return (value as { public_view: RunView }).public_view;
  }
  return value as RunView;
}

async function readPersistedRunView(filePath: string): Promise<RunView> {
  return persistedRunView(JSON.parse(await fs.readFile(filePath, "utf8")));
}

async function withServer<T>(
  fixture: { root: string; project: string; config: string; fakeChild: string; fakeLog: string },
  run: (client: Client) => Promise<T>,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<T> {
  const state = path.join(fixture.root, "state");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/server.js")],
    env: {
      ...process.env,
      SUBAGENT007_CONFIG_PATH: fixture.config,
      SUBAGENT007_PI_CHILD_PATH: fixture.fakeChild,
      FAKE_PI_LOG_PATH: fixture.fakeLog,
      SUBAGENT007_FAILURE_LOG: "off",
      SUBAGENT007_RUN_TASKS_DIR: path.join(state, "run-tasks"),
      SUBAGENT007_INPUT_REQUESTS_DIR: path.join(state, "input-requests"),
      SUBAGENT007_ACTIVE_CHILDREN_DIR: path.join(state, "active-children"),
      SUBAGENT007_QUEUED_RUNS_DIR: path.join(state, "queued-runs"),
      ...extraEnv,
    },
  });
  const client = new Client({ name: "client-start-id-test", version: "0.1.0" });
  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-client-start-"));
  const project = path.join(root, "project");
  const config = path.join(root, "config.json");
  const fake = await createFakePiChild();
  await fs.mkdir(project);
  await fs.writeFile(config, JSON.stringify({ default_model_class: "C" }));
  return { root, project, config, fakeChild: fake.childPath, fakeLog: fake.logPath };
}

async function waitTerminal(client: Client, runId: string): Promise<RunView> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await client.callTool({ name: "get_run", arguments: { run_id: runId } });
    const view = response.structuredContent as RunView;
    if (["completed", "failed", "cancelled", "timed_out"].includes(view.status)) return view;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run did not terminate: ${runId}`);
}

async function waitTerminalTask(runId: string): Promise<RunView> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const view = await getRunTask(runId) as RunView;
    if (["completed", "failed", "cancelled", "timed_out"].includes(view.status)) return view;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run task did not terminate: ${runId}`);
}

async function readFakeLog(filePath: string): Promise<unknown[]> {
  try {
    return await readJsonl(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function waitForFakeLogEntries(filePath: string, count: number): Promise<unknown[]> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const entries = await readFakeLog(filePath);
    if (entries.length >= count) return entries;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`fake child log did not reach ${count} entries: ${filePath}`);
}

async function waitForDirectoryEntry(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await fs.readdir(directory).catch(() => [])).length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`directory entry did not appear: ${directory}`);
}

async function waitForClientStartSnapshot(directory: string, clientStartId: string): Promise<RunView> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const entries = (await fs.readdir(directory).catch(() => []))
      .filter((entry) => !entry.startsWith(".") && entry.endsWith(".json"));
    for (const entry of entries) {
      const snapshot = await readPersistedRunView(path.join(directory, entry));
      if (snapshot.client_start_binding?.client_start_id === clientStartId) return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`client-start run snapshot did not appear: ${clientStartId}`);
}

async function waitForPath(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await fs.stat(filePath).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`path did not appear: ${filePath}`);
}

test("current durable client-start snapshots obey one lifecycle/result invariant", () => {
  const assertSnapshot = (runTaskApi as Record<string, unknown>).assertCurrentRunTaskSnapshot;
  assert.equal(typeof assertSnapshot, "function", "runTask must own one current snapshot invariant");
  const assertCurrent = assertSnapshot as (view: Record<string, unknown>, admission?: Record<string, unknown>) => void;
  const runId = "2026-07-21T000000000Z-lifecycle";
  const requestSha256 = "a".repeat(64);
  const binding = { client_start_id: "lifecycle-matrix", request_sha256: requestSha256, run_id: runId };
  const admission = {
    binding,
    admitted_at: "2026-07-21T00:00:00.000Z",
    created: false,
    owner_pid: process.pid,
    owner_instance_id: "b".repeat(32),
  };
  const active = {
    contract_name: "subagent007.durable_run",
    contract_version: 3,
    run_id: runId,
    task_id: runId,
    task_kind: "run",
    root_run_id: runId,
    recursion_depth: 0,
    child_run_ids: [],
    descendant_run_ids: [],
    descendant_terminal_statuses: {},
    status: "working",
    started_at: admission.admitted_at,
    input_requests_dir: `/tmp/${runId}`,
    input_requests: [],
    child_started: false,
    client_start_binding: binding,
    active_phase: "starting",
    last_phase_at: admission.admitted_at,
  };
  const terminalEvidence = {
    finished_at: "2026-07-21T00:00:01.000Z",
    success: true,
    exit_code: 0,
    timed_out: false,
    partial_output_available: false,
    resume_possible: false,
    duration_ms: 1000,
    requested_timeout_ms: null,
    resolved_timeout_ms: null,
    timeout_floor_ms: 0,
    effective_timeout_ms: null,
    timeout_headroom_ms: 0,
    kill_grace_ms: 0,
    force_grace_ms: 0,
    output_path: "/tmp/output.md",
    output_references: [],
    size_bytes: 0,
    resolved_model_class: "C",
    requested_skill: null,
    resolved_skill_path: null,
    resolved_skill_sha256: null,
    requested_output_mode: "final",
    written_output_mode: "final",
    stop_reason: "completed",
    stop_signal: null,
    session_id: null,
    session_established: false,
  };
  const terminal = (status: string, evidence: Record<string, unknown>) => ({
    ...active,
    ...terminalEvidence,
    ...evidence,
    status,
    active_phase: status,
    child_started: true,
  });
  const sessionActive = {
    ...active,
    task_kind: "session",
    session_key: "lifecycle-session",
    client_start_binding: undefined,
  };
  const sessionTerminal = (status: string, evidence: Record<string, unknown>) => {
    const { session_id: _sessionId, ...sessionResultEvidence } = terminalEvidence;
    return {
      ...sessionActive,
      ...sessionResultEvidence,
      ...evidence,
      status,
      active_phase: status,
      child_started: true,
      session_dir: "/tmp/session",
      manifest_path: "/tmp/session/manifest.json",
      ledger_path: "/tmp/session/ledger.jsonl",
      attempts_path: "/tmp/session/attempts.jsonl",
      subagent_session_id: null,
      attempt_subagent_session_id: "/tmp/session/attempt/pi.json",
      attempt_session_established: true,
      session_established: false,
      created_or_resumed: "not_created",
      resume_mode: "new",
      requested_packet_policy: "required",
      packet_path: "/tmp/session/packet.json",
      packet_parse_status: "valid",
      packet_error: "packet did not satisfy required policy",
      claimed_packet: { contract: "subagent007.packet", schema_version: 1 },
      model_changed_from_manifest: false,
      run_record: {
        // Session ledger records are ordered within the session and are not
        // durable-run identities.
        run_id: "0001-lifecycle-session-record",
        sequence: 1,
        started_at: admission.admitted_at,
        finished_at: terminalEvidence.finished_at,
        action: "not_created",
        subagent_session_id: null,
        attempt_subagent_session_id: "/tmp/session/attempt/pi.json",
        attempt_session_established: true,
        resume_mode: "new",
        output_path: "/tmp/output.md",
        packet_path: "/tmp/session/packet.json",
        packet_policy: "required",
        success: false,
        exit_code: 0,
        timed_out: false,
        duration_ms: 1000,
        requested_skill: null,
        requested_output_mode: "final",
        written_output_mode: "final",
        stop_reason: "completed",
        packet_parse_status: "valid",
      },
      ...evidence,
    };
  };
  const ownerCancellation = {
    ...active,
    status: "cancelled",
    active_phase: "cancelled",
    finished_at: terminalEvidence.finished_at,
    success: false,
    exit_code: null,
    timed_out: false,
    partial_output_available: false,
    resume_possible: false,
    duration_ms: 1000,
    requested_timeout_ms: null,
    resolved_timeout_ms: null,
    effective_timeout_ms: null,
    session_id: null,
    session_established: false,
    output_references: [],
    child_started: false,
    last_phase_at: terminalEvidence.finished_at,
    recent_events: [{
      kind: "terminal",
      event: "cancellation_settled",
      text: "[cancellation_settled] run cancelled",
      occurred_at: terminalEvidence.finished_at,
      metadata: {},
    }],
  };
  const ownerTerminal = (
    status: "failed" | "cancelled",
    errorClass: "validation_error" | "unknown_error",
    reasonCode: string,
    message: string,
    extra: Record<string, unknown> = {},
  ) => ({
    ...ownerCancellation,
    ...extra,
    status,
    active_phase: status,
    child_started: true,
    error: message,
    error_class: errorClass,
    reason_code: reasonCode,
    recent_events: [{
      kind: "terminal",
      event: status === "cancelled" ? "cancellation_settled" : "failed",
      text: status === "cancelled" ? "[cancellation_settled] run cancelled" : `[failed] ${message}`,
      occurred_at: terminalEvidence.finished_at,
      metadata: {
        success: false,
        error_class: errorClass,
        reason_code: reasonCode,
        exit_code: null,
        timed_out: false,
        duration_ms: 1000,
        effective_timeout_ms: null,
        partial_output_available: false,
        resume_possible: false,
        session_id: null,
        output_reference_count: 0,
        error: message,
      },
    }],
  });
  const restartDrift = (withRecoveredOutput: boolean) => {
    const outputPath = withRecoveredOutput ? "/tmp/recovered-transcript.md" : undefined;
    const outputReferences = outputPath ? [{
      kind: "file", name: "primary", path: outputPath, size_bytes: 12,
      content_type: "text/markdown", encoding: "utf-8", output_mode: "transcript",
    }] : [];
    const metadata = {
      success: false,
      error_class: "restart_drift",
      reason_code: "server_restarted_active_run",
      exit_code: null,
      timed_out: false,
      duration_ms: 1000,
      effective_timeout_ms: null,
      partial_output_available: withRecoveredOutput,
      resume_possible: false,
      session_id: null,
      output_reference_count: outputReferences.length,
    };
    return {
      ...ownerCancellation,
      status: "failed",
      active_phase: "failed",
      child_started: true,
      error: "run is not active in this MCP server process; the server may have restarted",
      error_class: "restart_drift",
      reason_code: "server_restarted_active_run",
      partial_output_available: withRecoveredOutput,
      ...(outputPath ? { output_path: outputPath } : {}),
      output_references: outputReferences,
      recent_events: [{
        kind: "terminal", event: "failed", text: "[failed] run is not active after MCP server restart",
        occurred_at: terminalEvidence.finished_at, metadata,
      }],
    };
  };
  const expectedSkillSha256 = "d".repeat(64);
  const activationSkillBinding = {
    name: "producer-shaped-skill",
    path: "/tmp/producer-shaped-skill/SKILL.md",
    content_sha256: expectedSkillSha256,
    expected_content_sha256: expectedSkillSha256,
  };
  const expectedDigestActivationReceipt = skillOnlyActivationReceipt(activationSkillBinding);
  const defaultRecursiveReceipt = {
    schema_version: 1,
    confirmed_before_prompt: true,
    requested_recursive_delegation: null,
    resolved_recursive_delegation: "disabled",
    delegate_tool_active: false,
  };
  const snapshotBinding = {
    contract_version: 1,
    snapshot_id: "1".repeat(64),
    metadata_sha256: "2".repeat(64),
    publication_receipt_sha256: "3".repeat(64),
    reference_id: "4".repeat(64),
    project_id: "producer-project",
    publication_id: "producer-publication",
  };
  const snapshotActivationReceipt = {
    schema_version: 1,
    confirmed_before_prompt: true,
    skill_name: "producer-shaped-skill",
    snapshot_id: snapshotBinding.snapshot_id,
    metadata_sha256: snapshotBinding.metadata_sha256,
    bundle_sha256: "5".repeat(64),
    publication_receipt_sha256: snapshotBinding.publication_receipt_sha256,
    reference_id: snapshotBinding.reference_id,
    project_id: snapshotBinding.project_id,
    publication_id: snapshotBinding.publication_id,
    resolved_skill_path: `/tmp/snapshots/bundles/${snapshotBinding.snapshot_id}/runtime/SKILL.md`,
    runtime_closure_sha256: "6".repeat(64),
  };
  const observedOwnerFailure = {
    ...ownerTerminal("failed", "validation_error", "invalid_skill", "observed owner failure"),
    expected_skill_sha256: expectedSkillSha256,
    activation_receipt: expectedDigestActivationReceipt,
    resolved_recursive_delegation: "disabled",
    recursive_delegation_receipt: defaultRecursiveReceipt,
    last_child_lifecycle_event: "child_prompt_submitted",
    last_child_lifecycle_at: terminalEvidence.finished_at,
  };
  const promotedOwnerFailure = {
    ...observedOwnerFailure,
    client_start_binding: undefined,
    auto_promoted_from: "run_subagent",
    promotion_reason_code: "broad_work",
    promotion_reason: "broad work",
    poll_with: "get_run",
    cancel_with: "cancel_run",
  };
  const matrix: Array<{ name: string; valid: boolean; view: Record<string, unknown>; expected?: Record<string, unknown> }> = [
    { name: "working", valid: true, view: active },
    { name: "queued pre-child working", valid: true, view: { ...active, active_phase: "queued" } },
    {
      name: "input_required",
      valid: true,
      view: { ...active, status: "input_required", active_phase: "input_required", child_started: true, input_requests: [{ status: "pending" }] },
    },
    { name: "completed", valid: true, view: terminal("completed", {}) },
    { name: "failed", valid: true, view: terminal("failed", { success: false, exit_code: 1, stop_reason: "failed", error_class: "nonzero_exit", reason_code: "nonzero_exit" }) },
    {
      name: "failed after process-zero contract validation",
      valid: true,
      view: terminal("failed", {
        success: false,
        exit_code: 0,
        stop_reason: "completed",
        error_class: "capability_unavailable",
        reason_code: "effect_profile_activation_failed",
      }),
    },
    { name: "cancelled", valid: true, view: terminal("cancelled", { success: false, exit_code: null, stop_reason: "cancelled" }) },
    { name: "timed_out", valid: true, view: terminal("timed_out", { success: false, exit_code: null, timed_out: true, stop_reason: "timeout" }) },
    {
      name: "session packet terminal",
      valid: true,
      view: sessionTerminal("failed", {
        success: false,
        error_class: "packet_failed",
        reason_code: "packet_required_not_ready",
      }),
    },
    {
      name: "failed session without an established attempt session",
      valid: true,
      view: sessionTerminal("failed", {
        success: false,
        error_class: "packet_failed",
        reason_code: "packet_required_not_ready",
        subagent_session_id: null,
        attempt_subagent_session_id: null,
        attempt_session_established: false,
        session_established: false,
        created_or_resumed: "not_created",
        run_record: {
          ...sessionTerminal("failed", {}).run_record,
          attempt_subagent_session_id: null,
          attempt_session_established: false,
        },
      }),
    },
    {
      name: "cancelled session without an established attempt session",
      valid: true,
      view: sessionTerminal("cancelled", {
        success: false,
        exit_code: null,
        timed_out: false,
        stop_reason: "cancelled",
        subagent_session_id: null,
        attempt_subagent_session_id: null,
        attempt_session_established: false,
        session_established: false,
        created_or_resumed: "not_created",
        run_record: {
          ...sessionTerminal("failed", {}).run_record,
          subagent_session_id: null,
          attempt_subagent_session_id: null,
          attempt_session_established: false,
          success: false,
          exit_code: null,
          timed_out: false,
          stop_reason: "cancelled",
        },
      }),
    },
    {
      name: "failed session preserves an earlier committed session identity",
      valid: true,
      view: sessionTerminal("failed", {
        success: false,
        error_class: "packet_failed",
        reason_code: "packet_required_not_ready",
        subagent_session_id: "/tmp/session/prior.json",
        session_established: true,
        created_or_resumed: "not_created",
        run_record: {
          ...sessionTerminal("failed", {}).run_record,
          subagent_session_id: "/tmp/session/prior.json",
          action: "not_created",
        },
      }),
    },
    { name: "owner cancellation before child launch", valid: true, view: ownerCancellation },
    { name: "owner validation failure", valid: true, view: ownerTerminal("failed", "validation_error", "invalid_skill", "skill rejected") },
    { name: "owner handler failure", valid: true, view: ownerTerminal("failed", "unknown_error", "handler_error", "run task handler failed") },
    { name: "owner cancellation after child launch", valid: true, view: ownerTerminal("cancelled", "validation_error", "local_capacity_exhausted", "run cancelled after child launch") },
    { name: "restart drift without recovered output", valid: true, view: restartDrift(false) },
    { name: "restart drift with recovered output", valid: true, view: restartDrift(true) },
    { name: "session owner failure", valid: true, view: { ...ownerTerminal("failed", "unknown_error", "handler_error", "session owner failed"), task_kind: "session", session_key: "owner-session", client_start_binding: undefined } },
    { name: "pre-child request-only effect profile", valid: true, view: { ...ownerCancellation, requested_effect_profile: "workspace_read_only" } },
    { name: "pre-child request-only expected digest", valid: true, view: { ...ownerCancellation, expected_skill_sha256: expectedSkillSha256 } },
    { name: "pre-child request-only snapshot binding", valid: true, view: { ...ownerCancellation, skill_snapshot_binding: snapshotBinding } },
    { name: "pre-child request-only recursive policy", valid: true, view: { ...ownerCancellation, requested_recursive_delegation: "disabled" } },
    { name: "post-child expected-digest activation omits null top-level profiles", valid: true, view: observedOwnerFailure },
    {
      name: "post-child snapshot activation preserves exact publication identity",
      valid: true,
      view: {
        ...ownerTerminal("failed", "validation_error", "invalid_skill", "observed snapshot owner failure"),
        skill_snapshot_binding: snapshotBinding,
        skill_snapshot_activation_receipt: snapshotActivationReceipt,
        resolved_recursive_delegation: "disabled",
        recursive_delegation_receipt: defaultRecursiveReceipt,
        last_child_lifecycle_event: "child_prompt_submitted",
        last_child_lifecycle_at: terminalEvidence.finished_at,
      },
    },
    {
      name: "post-child default recursion receipt omits requested top-level value",
      valid: true,
      view: {
        ...ownerTerminal("failed", "validation_error", "invalid_skill", "observed recursive owner failure"),
        resolved_recursive_delegation: "disabled",
        recursive_delegation_receipt: defaultRecursiveReceipt,
        last_child_lifecycle_event: "child_prompt_submitted",
        last_child_lifecycle_at: terminalEvidence.finished_at,
      },
    },
    {
      name: "complete owner promotion and activation", valid: true,
      view: promotedOwnerFailure,
    },
    { name: "owner requires session id", valid: false, view: { ...ownerCancellation, session_id: undefined } },
    { name: "owner requires matching session established", valid: false, view: { ...ownerCancellation, session_established: true } },
    { name: "owner requires exact duration", valid: false, view: { ...ownerCancellation, duration_ms: 1 } },
    { name: "owner requires terminal phase timestamp", valid: false, view: { ...ownerCancellation, last_phase_at: admission.admitted_at } },
    { name: "owner forbids provider residue", valid: false, view: { ...ownerCancellation, provider_error_message: "residue" } },
    { name: "owner forbids timeout recovery residue", valid: false, view: { ...ownerCancellation, timeout_recovery_hint: "resume" } },
    { name: "owner forbids nonrestart output", valid: false, view: { ...ownerCancellation, output_path: "/tmp/residue", output_references: [] } },
    { name: "owner typed cancellation requires error taxonomy", valid: false, view: { ...ownerTerminal("cancelled", "validation_error", "invalid_skill", "cancelled"), error: undefined, error_class: undefined, reason_code: undefined } },
    { name: "owner failure rejects invented taxonomy", valid: false, view: { ...ownerTerminal("failed", "unknown_error", "invalid_skill", "mismatch") } },
    { name: "restart drift requires fixed message", valid: false, view: { ...restartDrift(false), error: "other" } },
    { name: "restart drift rejects absent recovered output", valid: false, view: { ...restartDrift(true), output_path: undefined } },
    { name: "restart drift rejects mismatched reference", valid: false, view: { ...restartDrift(true), output_references: [{ ...restartDrift(true).output_references[0], path: "/tmp/other" }] } },
    { name: "promotion is all or none", valid: false, view: { ...ownerTerminal("failed", "validation_error", "invalid_skill", "partial promotion"), auto_promoted_from: "run_subagent" } },
    { name: "extra completed settlement rejects owner terminal", valid: false, view: { ...ownerCancellation, recent_events: [...ownerCancellation.recent_events, { kind: "terminal", event: "completed", text: "[completed] run completed", occurred_at: terminalEvidence.finished_at, metadata: {} }] } },
    { name: "extra timeout settlement rejects owner terminal", valid: false, view: { ...ownerCancellation, recent_events: [...ownerCancellation.recent_events, { kind: "terminal", event: "timeout", text: "[timeout] run timed out", occurred_at: terminalEvidence.finished_at, metadata: {} }] } },
    { name: "truncated activation receipt rejects", valid: false, view: { ...observedOwnerFailure, activation_receipt: { ...expectedDigestActivationReceipt, toolset_sha256: undefined } } },
    { name: "invalid activation receipt rejects", valid: false, view: { ...observedOwnerFailure, activation_receipt: { ...expectedDigestActivationReceipt, confirmed_before_prompt: false } } },
    { name: "truncated snapshot receipt rejects", valid: false, view: { ...observedOwnerFailure, expected_skill_sha256: undefined, activation_receipt: undefined, skill_snapshot_binding: snapshotBinding, skill_snapshot_activation_receipt: { ...snapshotActivationReceipt, bundle_sha256: undefined } } },
    { name: "snapshot publication receipt mismatch rejects", valid: false, view: { ...observedOwnerFailure, expected_skill_sha256: undefined, activation_receipt: undefined, skill_snapshot_binding: snapshotBinding, skill_snapshot_activation_receipt: { ...snapshotActivationReceipt, publication_receipt_sha256: "7".repeat(64) } } },
    { name: "truncated recursive receipt rejects", valid: false, view: { ...observedOwnerFailure, recursive_delegation_receipt: { ...defaultRecursiveReceipt, delegate_tool_active: undefined } } },
    { name: "invalid recursive receipt rejects", valid: false, view: { ...observedOwnerFailure, recursive_delegation_receipt: { ...defaultRecursiveReceipt, delegate_tool_active: true } } },
    { name: "child prompt requires triggered activation", valid: false, view: { ...observedOwnerFailure, activation_receipt: undefined } },
    { name: "pre-child declaration forbids child lifecycle residue", valid: false, view: { ...ownerCancellation, requested_effect_profile: "workspace_read_only", last_child_lifecycle_event: "child_bridge_started" } },
    { name: "pre-child declaration forbids session residue", valid: false, view: { ...ownerCancellation, requested_effect_profile: "workspace_read_only", session_id: "/tmp/forged-session.json", session_established: true } },
    { name: "pre-child declaration forbids child timing residue", valid: false, view: { ...ownerCancellation, requested_effect_profile: "workspace_read_only", child_started_at: admission.admitted_at } },
    { name: "promotion rejects session owner", valid: false, view: { ...promotedOwnerFailure, task_kind: "session", session_key: "promoted-session" } },
    { name: "promotion rejects client-start owner", valid: false, view: { ...promotedOwnerFailure, client_start_binding: binding } },
    { name: "restart drift rejects relative recovered path", valid: false, view: { ...restartDrift(true), output_path: "relative.md", output_references: [{ ...restartDrift(true).output_references[0], path: "relative.md" }] } },
    { name: "restart drift rejects extra reference keys", valid: false, view: { ...restartDrift(true), output_references: [{ ...restartDrift(true).output_references[0], forged: true }] } },
    { name: "pre-child restart drift forbids session identity", valid: false, view: { ...restartDrift(false), child_started: false, session_id: "/tmp/forged-session.json", session_established: true } },
    { name: "expected digest and snapshot declarations are exclusive", valid: false, view: { ...ownerCancellation, expected_skill_sha256: expectedSkillSha256, skill_snapshot_binding: snapshotBinding } },
    { name: "effect profile and recursive enablement conflict", valid: false, view: { ...ownerCancellation, requested_effect_profile: "workspace_read_only", requested_recursive_delegation: "enabled" } },
    { name: "bounded effect declaration requires snapshot binding", valid: false, view: { ...ownerCancellation, requested_effect_profile: "researcher_bounded_v1" } },
    { name: "owner requires terminal event", valid: false, view: { ...ownerCancellation, recent_events: [] } },
    { name: "owner rejects duplicate terminal event", valid: false, view: { ...ownerCancellation, recent_events: [...ownerCancellation.recent_events, ...ownerCancellation.recent_events] } },
    { name: "owner rejects contradictory terminal event", valid: false, view: { ...ownerCancellation, recent_events: [{ ...ownerCancellation.recent_events[0], event: "failed" }] } },
    { name: "missing completion evidence", valid: false, view: { ...active, status: "completed", active_phase: "completed", finished_at: terminalEvidence.finished_at } },
    { name: "empty completion timestamp", valid: false, view: { ...terminal("completed", {}), finished_at: "" } },
    { name: "input without child", valid: false, view: { ...active, status: "input_required", active_phase: "input_required", input_requests: [{ status: "pending" }] } },
    { name: "working with input-required phase", valid: false, view: { ...active, active_phase: "input_required" } },
    { name: "working with pending input", valid: false, view: { ...active, input_requests: [{ status: "pending" }] } },
    { name: "working with completion timestamp", valid: false, view: { ...active, finished_at: terminalEvidence.finished_at } },
    { name: "completed without child", valid: false, view: { ...terminal("completed", {}), child_started: false } },
    { name: "terminal preserves answered input settlement", valid: true, view: { ...terminal("completed", {}), input_requests: [{ status: "answered" }] } },
    { name: "terminal cannot retain pending input", valid: false, view: { ...terminal("completed", {}), input_requests: [{ status: "pending" }] } },
    { name: "failed process result requires a child", valid: false, view: { ...terminal("failed", { success: false, exit_code: 1, stop_reason: "failed", error_class: "nonzero_exit", reason_code: "nonzero_exit" }), child_started: false } },
    { name: "cancelled process result requires a child", valid: false, view: { ...terminal("cancelled", { success: false, exit_code: null, stop_reason: "cancelled" }), child_started: false } },
    { name: "timed-out process result requires a child", valid: false, view: { ...terminal("timed_out", { success: false, exit_code: null, timed_out: true, stop_reason: "timeout" }), child_started: false } },
    { name: "owner terminal requires an exact synthetic envelope", valid: false, view: { ...ownerCancellation, status: "failed", active_phase: "failed", error: "owner failed", error_class: "validation_error", reason_code: "unknown_error", success: true, exit_code: 0, timed_out: true, resume_possible: true, requested_timeout_ms: 1 } },
    { name: "completed with error evidence", valid: false, view: { ...terminal("completed", {}), error: "contradiction" } },
    { name: "failed with successful result", valid: false, view: terminal("failed", { success: true, stop_reason: "failed" }) },
    {
      name: "process result minus stop reason cannot impersonate owner failure",
      valid: false,
      view: { ...terminal("failed", { success: false, stop_reason: undefined, error: "truncated result" }) },
    },
    {
      name: "owner failure cannot carry process-only evidence",
      valid: false,
      view: { ...ownerCancellation, status: "failed", active_phase: "failed", error: "owner failed", error_class: "validation_error", reason_code: "unknown_error", timeout_floor_ms: 0 },
    },
    {
      name: "process result cannot carry session-only evidence",
      valid: false,
      view: { ...terminal("failed", { success: false, stop_reason: "failed", error_class: "nonzero_exit", reason_code: "nonzero_exit", session_dir: "/tmp/mixed" }) },
    },
    {
      name: "session null attempt cannot claim establishment",
      valid: false,
      view: sessionTerminal("failed", {
        success: false,
        error_class: "packet_failed",
        reason_code: "packet_required_not_ready",
        attempt_subagent_session_id: null,
        attempt_session_established: true,
      }),
    },
    {
      name: "successful session must commit a session identity",
      valid: false,
      view: sessionTerminal("completed", {
        success: true,
        exit_code: 0,
        error_class: undefined,
        reason_code: undefined,
        subagent_session_id: null,
        session_established: false,
        created_or_resumed: "created",
        run_record: {
          ...sessionTerminal("failed", {}).run_record,
          success: true,
          exit_code: 0,
          action: "created",
          subagent_session_id: null,
        },
      }),
    },
    {
      name: "failed session cannot claim a create-or-resume action",
      valid: false,
      view: sessionTerminal("failed", {
        success: false,
        error_class: "packet_failed",
        reason_code: "packet_required_not_ready",
        created_or_resumed: "resumed",
        run_record: { ...sessionTerminal("failed", {}).run_record, action: "resumed" },
      }),
    },
    { name: "historical active cannot erase root lineage", valid: false, view: { ...active, client_start_binding: undefined, child_started: undefined, root_run_id: undefined } },
    { name: "historical active cannot erase descendant closure", valid: false, view: { ...active, client_start_binding: undefined, child_started: undefined, descendant_terminal_statuses: undefined } },
    { name: "historical active cannot erase phase timestamp", valid: false, view: { ...active, client_start_binding: undefined, child_started: undefined, last_phase_at: undefined } },
    { name: "current v3 cannot infer historical provenance from missing child evidence", valid: false, view: { ...active, client_start_binding: undefined, child_started: undefined } },
    {
      name: "exact binding mismatch",
      valid: false,
      view: active,
      expected: { ...admission, binding: { ...binding, request_sha256: "c".repeat(64) } },
    },
  ];
  for (const entry of matrix) {
    const expectedAdmission = entry.expected ?? (
      entry.view.client_start_binding === undefined ? undefined : admission
    );
    if (entry.valid) {
      assert.doesNotThrow(() => assertCurrent(entry.view, expectedAdmission), entry.name);
    } else {
      assert.throws(() => assertCurrent(entry.view, expectedAdmission), /client_start_id|lifecycle|snapshot/i, entry.name);
    }
  }
});

test("client start identity is strict, schema-normalized, and deterministically canonical", () => {
  const identity = (clientStartAdmissionApi as Record<string, unknown>).validatedClientStartRequestIdentity;
  assert.equal(typeof identity, "function", "one public-start schema-normalized identity owner must exist");
  const normalize = identity as (request: Record<string, unknown>) => Record<string, unknown>;
  const left = {
    prompt: "FAST",
    cwd: "/tmp/project",
    client_start_id: "one",
    continuity: { session_id: "session.json", mode: "resume" },
    output_mode: undefined,
  };
  const right = {
    cwd: "/tmp/project",
    continuity: { mode: "resume", session_id: "session.json" },
    prompt: "FAST",
    client_start_id: "two",
  };
  assert.deepEqual(normalize(left), normalize(right));
  assert.equal(
    clientStartAdmissionApi.canonicalClientStartRequestSha256(left as never),
    clientStartAdmissionApi.canonicalClientStartRequestSha256(right as never),
  );
  assert.notEqual(
    clientStartAdmissionApi.canonicalClientStartRequestSha256(left as never),
    clientStartAdmissionApi.canonicalClientStartRequestSha256({ ...left, prompt: "FAST changed" } as never),
  );
  assert.throws(() => normalize({ ...left, ambient_private_field: true }), /unrecognized|unknown|strict/i);
});

test("client_start_id exact replay returns one run while body drift rejects and distinct keys admit", async () => {
  const f = await fixture();
  try {
    await withServer(f, async (client) => {
      const base = { cwd: f.project, prompt: "FAST", client_start_id: "episode-1-call-1" };
      const firstResponse = await client.callTool({ name: "start_run", arguments: base });
      assert.notEqual(firstResponse.isError, true);
      const first = firstResponse.structuredContent as RunView;
      assert.equal(first.client_start_binding?.client_start_id, base.client_start_id);
      assert.equal(first.client_start_binding?.run_id, first.run_id);
      assert.match(first.client_start_binding?.request_sha256 ?? "", /^[0-9a-f]{64}$/);

      const replay = (await client.callTool({ name: "start_run", arguments: base })).structuredContent as RunView;
      assert.equal(replay.run_id, first.run_id);
      assert.deepEqual(replay.client_start_binding, first.client_start_binding);

      const drift = await client.callTool({
        name: "start_run",
        arguments: { ...base, prompt: "FAST changed" },
      });
      assert.notEqual(drift.isError, true);
      assert.equal((drift.structuredContent as RunView).reason_code, "client_start_id_conflict");
      assert.equal((drift.structuredContent as RunView).child_started, false);

      const second = (await client.callTool({
        name: "start_run",
        arguments: { ...base, client_start_id: "episode-1-call-2" },
      })).structuredContent as RunView;
      assert.notEqual(second.run_id, first.run_id);
      await Promise.all([waitTerminal(client, first.run_id), waitTerminal(client, second.run_id)]);
      assert.equal((await readJsonl(f.fakeLog)).length, 2);

      const concurrentRequest = { ...base, client_start_id: "episode-1-call-concurrent" };
      const concurrent = await Promise.all(Array.from({ length: 6 }, () =>
        client.callTool({ name: "start_run", arguments: concurrentRequest })));
      const concurrentRunIds = concurrent.map((response) => (response.structuredContent as RunView).run_id);
      assert.equal(new Set(concurrentRunIds).size, 1);
      await waitTerminal(client, concurrentRunIds[0]!);
      assert.equal((await readJsonl(f.fakeLog)).length, 3);
      assert.deepEqual(
        (await fs.readdir(path.join(f.root, "state", "run-tasks"))).filter((entry) => entry.endsWith(".prepared")),
        [],
        "concurrent losing candidates must be removed",
      );
    });
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("concurrent exact replay observes the same admitted run during a slow live-owner capacity scan", async () => {
  const f = await fixture();
  const request = { cwd: f.project, prompt: "FAST", client_start_id: "slow-live-owner" };
  try {
    await withServer(f, async (ownerClient) => withServer(f, async (replayClient) => {
      const firstPromise = ownerClient.callTool({ name: "start_run", arguments: request });
      await waitForDirectoryEntry(path.join(f.root, "state", "run-tasks", "client-start-ids"));
      const replayPromise = replayClient.callTool({ name: "start_run", arguments: request });
      const promptReplay = await Promise.race([
        replayPromise.then((response) => ({ response })),
        new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), 500)),
      ]);
      const first = (await firstPromise).structuredContent as RunView;

      assert.equal("timedOut" in promptReplay, false, "exact replay must not wait for the live owner capacity scan");
      if (!("response" in promptReplay)) throw new Error("exact replay timed out");
      const replay = promptReplay.response.structuredContent as RunView;
      assert.notEqual(replay.reason_code, "run_liveness_unknown", JSON.stringify(replay));
      assert.equal(replay.run_id, first.run_id);
      assert.equal(replay.status, "working", JSON.stringify(replay));
      await waitTerminal(ownerClient, first.run_id);
      assert.equal((await readJsonl(f.fakeLog)).length, 1);
    }), { SUBAGENT007_TEST_ACTIVE_LEASE_SCAN_DELAY_MS: "1250" });
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("constrained client start cancelled during capacity scan durably settles declaration-only", async () => {
  const f = await fixture();
  const request = {
    cwd: f.project,
    prompt: "CANCEL_WAIT",
    client_start_id: "cancel-during-pre-child-capacity-scan",
    effect_profile: "workspace_read_only" as const,
    recursive_delegation: "disabled" as const,
  };
  const runTasksDir = path.join(f.root, "state", "run-tasks");
  const failureLog = path.join(f.root, "failures.jsonl");
  try {
    await withEnv({
      SUBAGENT007_CONFIG_PATH: f.config,
      SUBAGENT007_PI_CHILD_PATH: f.fakeChild,
      FAKE_PI_LOG_PATH: f.fakeLog,
      SUBAGENT007_FAILURE_LOG: undefined,
      SUBAGENT007_FAILURE_LOG_PATH: failureLog,
      SUBAGENT007_RECORD_SOURCE: "test",
      SUBAGENT007_RUN_TASKS_DIR: runTasksDir,
      SUBAGENT007_INPUT_REQUESTS_DIR: path.join(f.root, "state", "input-requests"),
      SUBAGENT007_ACTIVE_CHILDREN_DIR: path.join(f.root, "state", "active-children"),
      SUBAGENT007_QUEUED_RUNS_DIR: path.join(f.root, "state", "queued-runs"),
      SUBAGENT007_TEST_ACTIVE_LEASE_SCAN_DELAY_MS: "1250",
    }, async () => {
      const ownerStart = startRunTask(request);
      const published = await waitForClientStartSnapshot(runTasksDir, request.client_start_id);
      assert.equal(published.child_started, false);
      assert.equal(published.active_phase, "starting");
      await waitForPath(path.join(runTasksDir, `${published.run_id}.events.jsonl`));

      await cancelRunTask(published.run_id);

      await ownerStart;
      const terminal = await waitTerminalTask(published.run_id);
      assert.equal(terminal.status, "cancelled", JSON.stringify(terminal));
      assert.equal(terminal.child_started, false);
      assert.equal(terminal.active_phase, "cancelled");
      assert.equal(terminal.stop_reason, undefined);
      assert.equal(terminal.success, false);
      assert.equal(terminal.exit_code, null);
      assert.equal(terminal.timed_out, false);
      assert.equal(terminal.resume_possible, false);
      assert.equal(terminal.requested_timeout_ms, null);
      assert.equal(terminal.resolved_timeout_ms, null);
      assert.equal(terminal.effective_timeout_ms, null);
      assert.deepEqual(terminal.input_requests?.filter((request) => request.status === "pending"), []);
      const settled = terminal.recent_events?.find((event) => event.event === "cancellation_settled");
      assert.ok(settled);
      assert.deepEqual(settled.metadata, {});

      const persisted = await readPersistedRunView(path.join(runTasksDir, `${published.run_id}.json`));
      assert.equal(persisted.status, "cancelled");
      assert.equal(persisted.child_started, false);
      assert.equal(persisted.active_phase, "cancelled");
      assert.equal(persisted.stop_reason, undefined);
      assert.equal(persisted.success, false);
      assert.equal(persisted.exit_code, null);
      assert.equal(persisted.timed_out, false);

      const readback = await getRunTask(published.run_id) as RunView;
      const repeatedCancellation = await cancelRunTask(published.run_id) as RunView;
      assert.equal(readback.status, "cancelled");
      assert.equal(repeatedCancellation.status, "cancelled");
    });
    assert.equal((await readFakeLog(f.fakeLog)).length, 0);
    assert.equal((await readFakeLog(failureLog)).length, 0, "accepted pre-child cancellation must not log a lifecycle failure");
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("owner record retains independently captured authoring evidence and rejects a forged public projection", async () => {
  const f = await fixture();
  const runTasksDir = path.join(f.root, "state", "run-tasks");
  try {
    await withEnv({
      SUBAGENT007_CONFIG_PATH: f.config,
      SUBAGENT007_PI_CHILD_PATH: f.fakeChild,
      FAKE_PI_LOG_PATH: f.fakeLog,
      SUBAGENT007_FAILURE_LOG: "off",
      SUBAGENT007_RUN_TASKS_DIR: runTasksDir,
      SUBAGENT007_INPUT_REQUESTS_DIR: path.join(f.root, "state", "input-requests"),
      SUBAGENT007_ACTIVE_CHILDREN_DIR: path.join(f.root, "state", "active-children"),
      SUBAGENT007_QUEUED_RUNS_DIR: path.join(f.root, "state", "queued-runs"),
    }, async () => {
      const started = await startRunTask({
        cwd: f.project,
        prompt: "FAST OWNER_RECORD_SECRET_PROMPT",
        client_start_id: "owner-record-authoring-evidence",
        effect_profile: "task_root_authoring_v1",
        allowed_output_paths: [],
        recursive_delegation: "disabled",
      });
      const terminal = await waitTerminalTask(started.run_id);
      const recordPath = path.join(runTasksDir, `${started.run_id}.json`);
      const record = JSON.parse(await fs.readFile(recordPath, "utf8")) as {
        record_name?: unknown;
        record_version?: unknown;
        immutable_admission?: { run_id?: unknown; request_bytes?: unknown; request_sha256?: unknown };
        launch_observation?: { effect_scope_binding_bytes?: unknown; effect_scope_binding_sha256?: unknown };
        settlement?: { status?: unknown; event?: unknown; occurred_at?: unknown };
        public_view?: Record<string, unknown>;
      };

      assert.equal(record.record_name, "subagent007.run_owner_record");
      assert.equal(record.record_version, 1);
      assert.equal(record.immutable_admission?.run_id, started.run_id);
      assert.equal(typeof record.immutable_admission?.request_bytes, "string");
      assert.doesNotMatch(record.immutable_admission?.request_bytes as string, /OWNER_RECORD_SECRET_PROMPT/);
      assert.match(record.immutable_admission?.request_bytes as string, /prompt_sha256/);
      assert.match(record.immutable_admission?.request_sha256 as string, /^[0-9a-f]{64}$/);
      assert.equal(typeof record.launch_observation?.effect_scope_binding_bytes, "string");
      assert.match(record.launch_observation?.effect_scope_binding_sha256 as string, /^[0-9a-f]{64}$/);
      assert.equal(record.settlement?.status, terminal.status);
      assert.equal(record.settlement?.occurred_at, terminal.finished_at);
      assert.ok(record.settlement?.event);

      const forged = structuredClone(record);
      const publicView = forged.public_view as {
        activation_receipt?: { effect_scope_binding?: { immutable_tree_sha256?: string } };
      };
      assert.ok(publicView.activation_receipt?.effect_scope_binding);
      publicView.activation_receipt.effect_scope_binding.immutable_tree_sha256 = "f".repeat(64);
      await fs.writeFile(recordPath, `${JSON.stringify(forged, null, 2)}\n`);
      await assert.rejects(
        () => getRunTask(started.run_id),
        /owner record|run_liveness_unknown|client_start_id_conflict|snapshot/i,
      );
    });
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("get_run, startup reconciliation, and exact replay preserve a live pre-capacity client-start admission", async () => {
  const f = await fixture();
  const request = { cwd: f.project, prompt: "FAST", client_start_id: "live-owner-observation" };
  const runTasksDir = path.join(f.root, "state", "run-tasks");
  let runId = "";
  try {
    await withServer(f, async (ownerClient) => {
      const ownerStart = ownerClient.callTool({ name: "start_run", arguments: request });
      void ownerStart.catch(() => undefined);
      const admitted = await waitForClientStartSnapshot(runTasksDir, request.client_start_id);
      runId = admitted.run_id;
      assert.equal(admitted.status, "working");
      assert.equal(admitted.child_started, false);

      const reconciliationMarker = path.join(f.root, "observer-reconciliation-complete");
      await withServer(f, async (observerClient) => {
        await waitForPath(reconciliationMarker);
        const afterStartupReconciliation = await readPersistedRunView(
          path.join(runTasksDir, `${runId}.json`),
        );
        assert.equal(afterStartupReconciliation.status, "working", JSON.stringify(afterStartupReconciliation));

        const startedAt = Date.now();
        const observed = (await observerClient.callTool({
          name: "get_run",
          arguments: { run_id: runId },
        })).structuredContent as RunView;
        const replay = (await observerClient.callTool({
          name: "start_run",
          arguments: request,
        })).structuredContent as RunView;
        assert.equal(Date.now() - startedAt < 500, true, "observation and replay must not wait for capacity");
        for (const view of [observed, replay]) {
          assert.equal(view.run_id, runId);
          assert.equal(view.status, "working", JSON.stringify(view));
          assert.equal(view.child_started, false);
        }
        assert.equal((await readFakeLog(f.fakeLog)).length, 0);
      }, { SUBAGENT007_TEST_RECONCILIATION_COMPLETE_PATH: reconciliationMarker });
    }, { SUBAGENT007_TEST_ACTIVE_LEASE_SCAN_DELAY_MS: "8000" });

    await withServer(f, async (observerClient) => {
      const lost = (await observerClient.callTool({
        name: "get_run",
        arguments: { run_id: runId },
      })).structuredContent as RunView;
      assert.equal(lost.status, "failed");
      assert.equal(lost.reason_code, "server_restarted_active_run");
      assert.equal(lost.child_started, false);

      const exact = (await observerClient.callTool({
        name: "start_run",
        arguments: request,
      })).structuredContent as RunView;
      assert.equal(exact.run_id, runId);
      assert.equal(exact.reason_code, "server_restarted_active_run");
      const drift = (await observerClient.callTool({
        name: "start_run",
        arguments: { ...request, prompt: "changed" },
      })).structuredContent as RunView;
      assert.equal(drift.reason_code, "client_start_id_conflict");
      assert.equal(drift.child_started, false);
      assert.equal((await readFakeLog(f.fakeLog)).length, 0);
    });
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("client_start_id survives owner loss after admission and replay returns one owner-issued restart_drift run", async () => {
  const f = await fixture();
  const request = { cwd: f.project, prompt: "WAIT_FOR_CANCEL", client_start_id: "crash-after-admission" };
  try {
    await assert.rejects(() => withServer(
      f,
      (client) => client.callTool({ name: "start_run", arguments: request }),
      { SUBAGENT007_TEST_EXIT_AFTER_CLIENT_START_ADMISSION: request.client_start_id },
    ));

    await withServer(f, async (client) => {
      const replayResponse = await client.callTool({ name: "start_run", arguments: request });
      assert.notEqual(replayResponse.isError, true);
      const replay = replayResponse.structuredContent as RunView;
      assert.equal(replay.status, "failed", JSON.stringify(replay));
      assert.equal(replay.reason_code, "server_restarted_active_run");
      assert.equal(replay.client_start_binding?.run_id, replay.run_id);
      assert.equal(
        replay.recent_events?.filter((event) => event.event === "child_spawned").length,
        replay.child_started ? 1 : 0,
        "staged child lifecycle telemetry may be retained only when the owner record committed the launch",
      );
      const exactAgain = (await client.callTool({ name: "start_run", arguments: request })).structuredContent as RunView;
      assert.equal(exactAgain.run_id, replay.run_id);
      assert.equal(exactAgain.reason_code, "server_restarted_active_run");
      assert.equal(exactAgain.finished_at, replay.finished_at);
      assert.equal(exactAgain.recent_events?.filter((event) => event.event === "failed").length, 1);
      assert.equal((await readFakeLog(f.fakeLog)).length <= 1, true);
    });
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("durable client binding survives owner loss before run registration with zero child duplication", async () => {
  const f = await fixture();
  const request = { cwd: f.project, prompt: "FAST", client_start_id: "crash-after-durable-binding" };
  try {
    await assert.rejects(() => withServer(
      f,
      (client) => client.callTool({ name: "start_run", arguments: request }),
      { SUBAGENT007_TEST_EXIT_AFTER_CLIENT_START_BINDING: request.client_start_id },
    ));
    const runTasksDir = path.join(f.root, "state", "run-tasks");
    const preparedEntry = (await fs.readdir(runTasksDir)).find((entry) => entry.endsWith(".prepared"));
    assert.equal(typeof preparedEntry, "string");
    const prepared = await readPersistedRunView(path.join(runTasksDir, preparedEntry!));
    await withServer(f, async (client) => {
      const replay = (await client.callTool({
        name: "get_run",
        arguments: { run_id: prepared.run_id },
      })).structuredContent as RunView;
      assert.equal(replay.status, "failed");
      assert.equal(replay.reason_code, "server_restarted_active_run");
      assert.equal(replay.run_id, prepared.run_id);
      assert.equal(replay.started_at, prepared.started_at);
      assert.equal(replay.client_start_binding?.run_id, replay.run_id);
      assert.equal(replay.recent_events?.filter((event) => event.event === "child_spawned").length, 0);
      assert.equal((await readFakeLog(f.fakeLog)).length, 0);
      const exactAgain = (await client.callTool({ name: "start_run", arguments: request })).structuredContent as RunView;
      assert.equal(exactAgain.run_id, replay.run_id);
      assert.equal(exactAgain.finished_at, replay.finished_at);
      assert.equal(exactAgain.recent_events?.filter((event) => event.event === "failed").length, 1);
      assert.deepEqual((await fs.readdir(runTasksDir)).filter((entry) => entry.endsWith(".prepared")), []);
    });
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("pre-claim owner interruption leaves no public admitted run and exact retry admits one honest child", async () => {
  const f = await fixture();
  const request = { cwd: f.project, prompt: "FAST", client_start_id: "crash-before-client-start-claim" };
  const runTasksDir = path.join(f.root, "state", "run-tasks");
  try {
    await assert.rejects(() => withServer(
      f,
      (client) => client.callTool({ name: "start_run", arguments: request }),
      { SUBAGENT007_TEST_EXIT_BEFORE_CLIENT_START_CLAIM: request.client_start_id },
    ));

    const publicSnapshots = (await fs.readdir(runTasksDir).catch(() => []))
      .filter((entry) => !entry.startsWith(".") && entry.endsWith(".json"));
    assert.deepEqual(publicSnapshots, [], "a pre-claim candidate must not be a public run snapshot");
    const preparedEntries = (await fs.readdir(runTasksDir)).filter((entry) => entry.endsWith(".prepared"));
    assert.equal(preparedEntries.length, 1);
    const prepared = await readPersistedRunView(path.join(runTasksDir, preparedEntries[0]!));

    await withServer(f, async (client) => {
      const oldCandidate = (await client.callTool({
        name: "get_run",
        arguments: { run_id: prepared.run_id },
      })).structuredContent as RunView;
      assert.equal(oldCandidate.reason_code, "run_not_found");
      const admitted = (await client.callTool({ name: "start_run", arguments: request })).structuredContent as RunView;
      assert.notEqual(admitted.run_id, prepared.run_id);
      assert.equal(admitted.client_start_binding?.run_id, admitted.run_id);
      await waitTerminal(client, admitted.run_id);
    });
    assert.equal((await readJsonl(f.fakeLog)).length, 1);
    assert.deepEqual(
      (await fs.readdir(runTasksDir)).filter((entry) => entry.endsWith(".prepared")),
      [],
      "retry must remove dead pre-binding candidates",
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("interruption before candidate preparation leaves no admission state", async () => {
  const f = await fixture();
  const request = { cwd: f.project, prompt: "FAST", client_start_id: "crash-before-prepare" };
  const runTasksDir = path.join(f.root, "state", "run-tasks");
  try {
    await assert.rejects(() => withServer(
      f,
      (client) => client.callTool({ name: "start_run", arguments: request }),
      { SUBAGENT007_TEST_EXIT_BEFORE_CLIENT_START_PREPARE: request.client_start_id },
    ));
    assert.deepEqual(await fs.readdir(runTasksDir).catch(() => []), []);
    assert.equal((await readFakeLog(f.fakeLog)).length, 0);

    await withServer(f, async (client) => {
      const retry = (await client.callTool({ name: "start_run", arguments: request })).structuredContent as RunView;
      await waitTerminal(client, retry.run_id);
    });
    assert.equal((await readFakeLog(f.fakeLog)).length, 1);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("post-promotion interruption preserves the exact canonical run for owner-loss terminalization", async () => {
  const f = await fixture();
  const request = { cwd: f.project, prompt: "FAST", client_start_id: "crash-after-promotion" };
  const runTasksDir = path.join(f.root, "state", "run-tasks");
  try {
    await assert.rejects(() => withServer(
      f,
      (client) => client.callTool({ name: "start_run", arguments: request }),
      { SUBAGENT007_TEST_EXIT_AFTER_CLIENT_START_PROMOTION: request.client_start_id },
    ));
    const snapshot = await waitForClientStartSnapshot(runTasksDir, request.client_start_id);
    await withServer(f, async (client) => {
      const observed = (await client.callTool({
        name: "get_run",
        arguments: { run_id: snapshot.run_id },
      })).structuredContent as RunView;
      assert.equal(observed.run_id, snapshot.run_id);
      assert.equal(observed.status, "failed");
      assert.equal(observed.reason_code, "server_restarted_active_run");
      assert.equal(observed.child_started, false);
      const replay = (await client.callTool({ name: "start_run", arguments: request })).structuredContent as RunView;
      assert.equal(replay.run_id, snapshot.run_id);
      assert.equal(replay.finished_at, observed.finished_at);
    });
    assert.equal((await readFakeLog(f.fakeLog)).length, 0);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("creator joins a canonical snapshot when exact replay wins prepared-candidate promotion", async () => {
  const f = await fixture();
  const request = { cwd: f.project, prompt: "FAST", client_start_id: "replay-wins-promotion" };
  const barrier = path.join(f.root, "promotion-barrier");
  try {
    await withServer(f, async (ownerClient) => {
      const ownerStart = ownerClient.callTool({ name: "start_run", arguments: request });
      await waitForPath(`${barrier}.ready`);
      const replay = await withServer(f, async (replayClient) =>
        (await replayClient.callTool({ name: "start_run", arguments: request })).structuredContent as RunView);
      assert.equal(replay.status, "working", JSON.stringify(replay));
      await fs.writeFile(`${barrier}.continue`, "continue\n");
      const creator = (await ownerStart).structuredContent as RunView;
      assert.equal(creator.run_id, replay.run_id);
      assert.equal(creator.status, "working", JSON.stringify(creator));
      await waitTerminal(ownerClient, creator.run_id);
    }, { SUBAGENT007_TEST_CLIENT_START_PROMOTION_BARRIER: barrier });
    assert.equal((await readFakeLog(f.fakeLog)).length, 1);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("creator joins when replay publishes and removes the candidate after both promoters read it", async () => {
  const f = await fixture();
  const request = {
    cwd: f.project,
    prompt: "CANCEL_WAIT",
    client_start_id: "replay-removes-after-both-read",
  };
  const barrier = path.join(f.root, "promotion-after-read-barrier");
  try {
    await withServer(f, async (ownerClient) => {
      const ownerStart = ownerClient.callTool({ name: "start_run", arguments: request });
      await waitForPath(`${barrier}.ready`);
      const replay = await withServer(f, async (replayClient) =>
        (await replayClient.callTool({ name: "start_run", arguments: request })).structuredContent as RunView);
      assert.equal(replay.status, "working", JSON.stringify(replay));
      await fs.writeFile(`${barrier}.continue`, "continue\n");
      const creator = (await ownerStart).structuredContent as RunView;
      assert.equal(creator.run_id, replay.run_id);
      assert.equal(creator.status, "working", JSON.stringify(creator));
      await waitForFakeLogEntries(f.fakeLog, 1);
      const cancelled = (await ownerClient.callTool({
        name: "cancel_run",
        arguments: { run_id: creator.run_id },
      })).structuredContent as RunView;
      assert.equal(cancelled.run_id, creator.run_id);
      await waitTerminal(ownerClient, creator.run_id);
    }, { SUBAGENT007_TEST_CLIENT_START_PROMOTION_AFTER_READ_BARRIER: barrier });
    assert.equal((await readFakeLog(f.fakeLog)).length, 1);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("replay joins an exact canonical run that advances after its initial target miss", async () => {
  for (const lifecycle of ["working-child", "terminal"] as const) {
    const f = await fixture();
    const request = {
      cwd: f.project,
      prompt: lifecycle === "working-child" ? "CANCEL_WAIT" : "FAST",
      client_start_id: `replay-target-miss-${lifecycle}`,
    };
    const ownerBarrier = path.join(f.root, `owner-promotion-${lifecycle}`);
    const replayBarrier = path.join(f.root, `replay-target-miss-${lifecycle}`);
    try {
      await withServer(f, async (ownerClient) => {
        const ownerStart = ownerClient.callTool({ name: "start_run", arguments: request });
        await waitForPath(`${ownerBarrier}.ready`);
        const replayStart = ownerClient.callTool({ name: "start_run", arguments: request });
        await waitForPath(`${replayBarrier}.ready`);
        await fs.writeFile(`${ownerBarrier}.continue`, "continue\n");
        const owner = (await ownerStart).structuredContent as RunView;
        if (lifecycle === "working-child") {
          await waitForFakeLogEntries(f.fakeLog, 1);
          const active = (await ownerClient.callTool({
            name: "get_run",
            arguments: { run_id: owner.run_id },
          })).structuredContent as RunView;
          assert.equal(active.status, "working", JSON.stringify(active));
          assert.equal(active.child_started, true);
        } else {
          const terminal = await waitTerminal(ownerClient, owner.run_id);
          assert.equal(terminal.status, "completed", JSON.stringify(terminal));
        }
        await fs.writeFile(`${replayBarrier}.continue`, "continue\n");
        const replay = (await replayStart).structuredContent as RunView;
        assert.equal(replay.run_id, owner.run_id, lifecycle);
        assert.equal(replay.status, lifecycle === "working-child" ? "working" : "completed", JSON.stringify(replay));
        if (lifecycle === "working-child") {
          assert.equal(replay.child_started, true);
          await ownerClient.callTool({ name: "cancel_run", arguments: { run_id: owner.run_id } });
          await waitTerminal(ownerClient, owner.run_id);
        }
      }, {
        SUBAGENT007_TEST_CLIENT_START_PROMOTION_BARRIER: ownerBarrier,
        SUBAGENT007_TEST_CLIENT_START_REPLAY_AFTER_TARGET_MISS_BARRIER: replayBarrier,
      });
      assert.equal((await readFakeLog(f.fakeLog)).length, 1, lifecycle);
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  }
});

test("replay rejects an exact-binding canonical target with an inconsistent lifecycle", async () => {
  const f = await fixture();
  const request = {
    cwd: f.project,
    prompt: "CANCEL_WAIT",
    client_start_id: "replay-target-miss-inconsistent-lifecycle",
  };
  const runTasksDir = path.join(f.root, "state", "run-tasks");
  const ownerBarrier = path.join(f.root, "owner-promotion-inconsistent");
  const replayBarrier = path.join(f.root, "replay-target-miss-inconsistent");
  try {
    await withServer(f, async (client) => {
      const ownerStart = client.callTool({ name: "start_run", arguments: request });
      await waitForPath(`${ownerBarrier}.ready`);
      const replayStart = client.callTool({ name: "start_run", arguments: request });
      await waitForPath(`${replayBarrier}.ready`);

      const candidateEntry = (await fs.readdir(runTasksDir)).find((entry) => entry.endsWith(".prepared"));
      assert.ok(candidateEntry);
      const candidateRecord = JSON.parse(await fs.readFile(path.join(runTasksDir, candidateEntry), "utf8"));
      const candidate = persistedRunView(candidateRecord);
      const canonicalPath = path.join(runTasksDir, `${candidate.run_id}.json`);
      await fs.writeFile(canonicalPath, `${JSON.stringify({
        ...candidateRecord,
        public_view: {
          ...candidate,
          status: "completed",
          active_phase: "completed",
          finished_at: "",
        },
      })}\n`);
      await fs.writeFile(`${replayBarrier}.continue`, "continue\n");

      const rejected = (await replayStart).structuredContent as RunView;
      await fs.writeFile(canonicalPath, `${JSON.stringify(candidateRecord)}\n`);
      await fs.writeFile(`${ownerBarrier}.continue`, "continue\n");
      const owner = (await ownerStart).structuredContent as RunView;
      assert.equal(rejected.reason_code, "client_start_id_conflict", JSON.stringify(rejected));
      assert.equal(rejected.child_started, false);
      assert.equal(owner.run_id, candidate.run_id);
      await waitForFakeLogEntries(f.fakeLog, 1);
      await client.callTool({ name: "cancel_run", arguments: { run_id: owner.run_id } });
      await waitTerminal(client, owner.run_id);
    }, {
      SUBAGENT007_TEST_CLIENT_START_PROMOTION_BARRIER: ownerBarrier,
      SUBAGENT007_TEST_CLIENT_START_REPLAY_AFTER_TARGET_MISS_BARRIER: replayBarrier,
    });
    assert.equal((await readFakeLog(f.fakeLog)).length, 1);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("binding published between initial ENOENT and observation is joined by one bounded reread", async () => {
  const f = await fixture();
  const runTasksDir = path.join(f.root, "direct-run-tasks");
  const request = { cwd: f.project, prompt: "FAST", client_start_id: "binding-read-race" };
  const bindingPath = path.join(
    runTasksDir,
    "client-start-ids",
    `${createHash("sha256").update(request.client_start_id).digest("hex")}.json`,
  );
  const previousRunTasksDir = process.env.SUBAGENT007_RUN_TASKS_DIR;
  const mutableFs = fs as typeof fs & { readFile: typeof fs.readFile };
  const originalReadFile = mutableFs.readFile;
  let injected = false;
  try {
    process.env.SUBAGENT007_RUN_TASKS_DIR = runTasksDir;
    mutableFs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
      if (!injected && path.resolve(String(args[0])) === bindingPath) {
        injected = true;
        await clientStartAdmissionApi.claimClientStartAdmission(request as never);
        throw Object.assign(new Error("forced stale ENOENT"), { code: "ENOENT" });
      }
      return originalReadFile(...args as Parameters<typeof fs.readFile>);
    }) as typeof fs.readFile;

    const joined = await clientStartAdmissionApi.findClientStartAdmission(request as never);
    assert.equal(joined?.binding.client_start_id, request.client_start_id);
    assert.equal(joined?.created, false);
    assert.equal(joined?.binding.run_id, JSON.parse(await originalReadFile(bindingPath, "utf8") as string).run_id);
  } finally {
    mutableFs.readFile = originalReadFile;
    if (previousRunTasksDir === undefined) delete process.env.SUBAGENT007_RUN_TASKS_DIR;
    else process.env.SUBAGENT007_RUN_TASKS_DIR = previousRunTasksDir;
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("omitting client_start_id preserves v2 non-idempotent start behavior", async () => {
  const f = await fixture();
  try {
    await withServer(f, async (client) => {
      const request = { cwd: f.project, prompt: "FAST" };
      const first = (await client.callTool({ name: "start_run", arguments: request })).structuredContent as RunView;
      const second = (await client.callTool({ name: "start_run", arguments: request })).structuredContent as RunView;
      assert.notEqual(first.run_id, second.run_id);
      assert.equal(first.client_start_binding, undefined);
      assert.equal(second.client_start_binding, undefined);
      await Promise.all([waitTerminal(client, first.run_id), waitTerminal(client, second.run_id)]);
    });
    assert.equal((await readFakeLog(f.fakeLog)).length, 2);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("live active-lease owner remains authoritative to foreign get and exact replay, then loss terminalizes once", async () => {
  const f = await fixture();
  const request = { cwd: f.project, prompt: "CANCEL_WAIT", client_start_id: "live-owner-after-lease" };
  let runId = "";
  try {
    await withServer(f, async (ownerClient) => {
      const started = (await ownerClient.callTool({ name: "start_run", arguments: request })).structuredContent as RunView;
      runId = started.run_id;
      await waitForFakeLogEntries(f.fakeLog, 1);
      const liveOwner = (await ownerClient.callTool({
        name: "get_run",
        arguments: { run_id: runId },
      })).structuredContent as RunView;
      assert.equal(liveOwner.status, "working", JSON.stringify(liveOwner));
      assert.equal(liveOwner.child_started, true);
      await withServer(f, async (observerClient) => {
        const observed = (await observerClient.callTool({
          name: "get_run",
          arguments: { run_id: runId },
        })).structuredContent as RunView;
        const replay = (await observerClient.callTool({ name: "start_run", arguments: request })).structuredContent as RunView;
        assert.equal(observed.run_id, runId);
        assert.equal(replay.run_id, runId);
        assert.equal(observed.status, "working", JSON.stringify(observed));
        assert.equal(replay.status, "working", JSON.stringify(replay));
        assert.equal(observed.child_started, true);
        assert.equal(replay.child_started, true);
        assert.equal((await readFakeLog(f.fakeLog)).length, 1);
      });
    });

    await withServer(f, async (observerClient) => {
      const lost = (await observerClient.callTool({
        name: "get_run",
        arguments: { run_id: runId },
      })).structuredContent as RunView;
      const again = (await observerClient.callTool({ name: "start_run", arguments: request })).structuredContent as RunView;
      assert.equal(lost.status, "failed");
      assert.equal(lost.reason_code, "server_restarted_active_run");
      assert.equal(again.run_id, runId);
      assert.equal(again.finished_at, lost.finished_at);
      assert.equal(again.recent_events?.filter((event) => event.event === "failed").length, 1);
    });
    assert.equal((await readFakeLog(f.fakeLog)).length, 1);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("full-capacity queued client-start run stays prompt and single-owner across foreign observation", async () => {
  const f = await fixture();
  const env = {
    SUBAGENT007_MAX_ACTIVE_CHILDREN: "1",
    SUBAGENT007_MAX_QUEUED_RUNS: "4",
  };
  const queuedRequest = { cwd: f.project, prompt: "FAST", client_start_id: "queued-live-owner" };
  try {
    await withServer(f, async (ownerClient) => {
      const holder = (await ownerClient.callTool({
        name: "start_run",
        arguments: { cwd: f.project, prompt: "CANCEL_WAIT" },
      })).structuredContent as RunView;
      await waitForFakeLogEntries(f.fakeLog, 1);
      const liveHolder = (await ownerClient.callTool({
        name: "get_run",
        arguments: { run_id: holder.run_id },
      })).structuredContent as RunView;
      assert.equal(liveHolder.status, "working", JSON.stringify(liveHolder));
      assert.equal(liveHolder.child_started, true);
      const queued = (await ownerClient.callTool({ name: "start_run", arguments: queuedRequest })).structuredContent as RunView;
      assert.equal(queued.status, "working");
      assert.equal(queued.active_phase, "queued");
      assert.equal(queued.child_started, false);

      await withServer(f, async (observerClient) => {
        const observedAt = Date.now();
        const observed = (await observerClient.callTool({
          name: "get_run",
          arguments: { run_id: queued.run_id },
        })).structuredContent as RunView;
        const replay = (await observerClient.callTool({ name: "start_run", arguments: queuedRequest })).structuredContent as RunView;
        assert.equal(Date.now() - observedAt < 500, true);
        assert.equal(observed.run_id, queued.run_id);
        assert.equal(replay.run_id, queued.run_id);
        assert.equal(observed.status, "working", JSON.stringify(observed));
        assert.equal(replay.status, "working", JSON.stringify(replay));
        assert.equal(observed.active_phase, "queued");
        assert.equal(replay.active_phase, "queued");
        assert.equal(observed.child_started, false);
        assert.equal(replay.child_started, false);
        assert.equal((await readFakeLog(f.fakeLog)).length, 1);
      }, env);

      await ownerClient.callTool({ name: "cancel_run", arguments: { run_id: holder.run_id } });
      await waitTerminal(ownerClient, holder.run_id);
      await waitTerminal(ownerClient, queued.run_id);
    }, env);
    assert.equal((await readFakeLog(f.fakeLog)).length, 2);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

for (const bindingFault of ["missing", "corrupt", "mismatched"] as const) {
  test(`${bindingFault} client-start owner binding fails closed without restart mutation or duplicate child`, async () => {
    const f = await fixture();
    const request = { cwd: f.project, prompt: "FAST", client_start_id: `binding-${bindingFault}` };
    const runTasksDir = path.join(f.root, "state", "run-tasks");
    const bindingPath = path.join(
      runTasksDir,
      "client-start-ids",
      `${createHash("sha256").update(request.client_start_id).digest("hex")}.json`,
    );
    let runId = "";
    try {
      await withServer(f, async (ownerClient) => {
        const ownerStart = ownerClient.callTool({ name: "start_run", arguments: request });
        void ownerStart.catch(() => undefined);
        const snapshot = await waitForClientStartSnapshot(runTasksDir, request.client_start_id);
        runId = snapshot.run_id;
        if (bindingFault === "missing") {
          await fs.rm(bindingPath);
        } else if (bindingFault === "corrupt") {
          await fs.writeFile(bindingPath, "{\n");
        } else {
          const binding = JSON.parse(await fs.readFile(bindingPath, "utf8"));
          await fs.writeFile(bindingPath, `${JSON.stringify({ ...binding, run_id: `${binding.run_id}-other` })}\n`);
        }

        const marker = path.join(f.root, `${bindingFault}-reconciliation-complete`);
        await withServer(f, async (observerClient) => {
          await waitForPath(marker);
          const observed = (await observerClient.callTool({
            name: "get_run",
            arguments: { run_id: runId },
          })).structuredContent as RunView;
          assert.equal(observed.reason_code, "run_liveness_unknown", JSON.stringify(observed));
          const replay = (await observerClient.callTool({ name: "start_run", arguments: request })).structuredContent as RunView;
          assert.equal(replay.reason_code, "client_start_id_conflict", JSON.stringify(replay));
          assert.equal(replay.child_started, false);
        }, { SUBAGENT007_TEST_RECONCILIATION_COMPLETE_PATH: marker });
      }, { SUBAGENT007_TEST_ACTIVE_LEASE_SCAN_DELAY_MS: "8000" });

      const persisted = await readPersistedRunView(path.join(runTasksDir, `${runId}.json`));
      assert.equal(persisted.status, "working");
      assert.equal(persisted.recent_events?.some((event) => event.event === "failed"), false);
      assert.equal((await readFakeLog(f.fakeLog)).length, 0);
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });
}

for (const fault of ["after_binding", "promotion_read"] as const) {
  test(`recoverable ${fault} fault terminalizes the bound run while the server remains live`, async () => {
    const f = await fixture();
    const request = { cwd: f.project, prompt: "FAST", client_start_id: `same-process-${fault}` };
    const faultEnv = fault === "after_binding"
      ? { SUBAGENT007_TEST_THROW_AFTER_CLIENT_START_BINDING: request.client_start_id }
      : { SUBAGENT007_TEST_FAIL_CLIENT_START_PROMOTION_READ: request.client_start_id };
    try {
      await withServer(f, async (ownerClient) => {
        const failed = (await ownerClient.callTool({ name: "start_run", arguments: request })).structuredContent as RunView;
        assert.equal(failed.status, "failed", JSON.stringify(failed));
        assert.notEqual(failed.error_class, "restart_drift");
        assert.equal(failed.client_start_binding?.run_id, failed.run_id);
        assert.equal(failed.child_started, false);
        const ownerStillServes = (await ownerClient.callTool({
          name: "get_run",
          arguments: { run_id: failed.run_id },
        })).structuredContent as RunView;
        assert.equal(ownerStillServes.run_id, failed.run_id);
        assert.equal(ownerStillServes.status, "failed");

        await withServer(f, async (replayClient) => {
          const replay = (await replayClient.callTool({ name: "start_run", arguments: request })).structuredContent as RunView;
          assert.equal(replay.run_id, failed.run_id);
          assert.equal(replay.status, "failed");
          assert.equal(replay.finished_at, failed.finished_at);
          assert.equal(replay.recent_events?.filter((event) => event.event === "failed").length, 1);
        });
      }, faultEnv);
      assert.equal((await readFakeLog(f.fakeLog)).length, 0);
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });
}
