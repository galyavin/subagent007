import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createFakePiChild } from "./helpers/fakePiChild.js";
import { readJsonl } from "./helpers/testUtils.js";

const execFileAsync = promisify(execFile);
const harnessPath = path.resolve("scripts/run-observed-campaign.mjs");
const probePath = path.resolve("scripts/run-observed-mcp-probe.mjs");

type HarnessResult = {
  campaign_id: string;
  evidence_class: "campaign-scoped";
  state_root: string;
  failure_log_path: string;
  campaign_ledger_path: string;
  runs_dir: string;
  run_tasks_dir: string;
  input_requests_dir: string;
  sessions_dir: string;
  pi_raw_sessions_dir: string;
  model_health_path: string;
  archive: null | { ok: boolean; result?: Record<string, unknown> };
  command_exit_code: number | null;
  command_signal: string | null;
};

async function runHarness(args: string[], env: NodeJS.ProcessEnv = {}, cwd = path.resolve(".")) {
  try {
    const result = await execFileAsync(process.execPath, [harnessPath, ...args], {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      ok: true,
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      json: JSON.parse(result.stdout) as HarnessResult,
    };
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string; code?: number };
    return {
      ok: false,
      code: failed.code ?? 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
      json: failed.stdout ? JSON.parse(failed.stdout) as HarnessResult : null,
    };
  }
}

function isPrivateCampaignStatePath(filePath: string): boolean {
  const segments = filePath.split(path.sep);
  const basename = path.basename(filePath);
  return segments.includes("input-requests") ||
    segments.includes("pi-raw-sessions") ||
    segments.includes("raw-sessions") ||
    segments.includes("pi-session") ||
    segments.includes("attempt-pi-sessions") ||
    basename === "config.json" ||
    basename === "model-health.json" ||
    basename === "manifest.json";
}

async function readPublicCampaignArtifactTextUnder(root: string): Promise<string> {
  const chunks: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && !isPrivateCampaignStatePath(entryPath)) {
        chunks.push(await fs.readFile(entryPath, "utf8"));
      }
    }
  }
  await walk(root);
  return chunks.join("\n");
}

test("observed campaign harness supplies isolated state paths by default", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-campaign-test-"));
  const envPath = path.join(tmp, "env.json");
  const productionLogPath = path.join(tmp, "production-failures.jsonl");
  await fs.writeFile(productionLogPath, "production stays here\n", "utf8");

  const childScript = [
    "const fs = require('fs');",
    "const out = process.argv[1];",
    "const env = {",
    "  campaign_id: process.env.SUBAGENT007_CAMPAIGN_ID,",
    "  record_source: process.env.SUBAGENT007_RECORD_SOURCE,",
    "  failure_log_path: process.env.SUBAGENT007_FAILURE_LOG_PATH,",
    "  campaign_ledger_path: process.env.SUBAGENT007_CAMPAIGN_LEDGER_PATH,",
    "  runs_dir: process.env.SUBAGENT007_RUNS_DIR,",
    "  run_tasks_dir: process.env.SUBAGENT007_RUN_TASKS_DIR,",
    "  input_requests_dir: process.env.SUBAGENT007_INPUT_REQUESTS_DIR,",
    "  sessions_dir: process.env.SUBAGENT007_SESSIONS_DIR,",
    "  pi_raw_sessions_dir: process.env.SUBAGENT007_PI_RAW_SESSIONS_DIR,",
    "  model_health_path: process.env.SUBAGENT007_MODEL_HEALTH_PATH,",
    "};",
    "fs.writeFileSync(out, JSON.stringify(env));",
    "fs.appendFileSync(env.failure_log_path, JSON.stringify({ campaign_id: env.campaign_id }) + '\\n');",
  ].join(" ");

  const result = await runHarness(
    ["--campaign-id", "campaign.test-1", "--", process.execPath, "-e", childScript, envPath],
    { SUBAGENT007_FAILURE_LOG_PATH: productionLogPath },
  );

  assert.equal(result.ok, true);
  assert.ok(result.json);
  const summary = result.json;
  assert.equal(summary.campaign_id, "campaign.test-1");
  assert.equal(summary.evidence_class, "campaign-scoped");
  const childEnv = JSON.parse(await fs.readFile(envPath, "utf8")) as Record<string, string>;
  assert.equal(childEnv.campaign_id, "campaign.test-1");
  assert.equal(childEnv.record_source, "test");
  assert.equal(childEnv.failure_log_path, summary.failure_log_path);
  assert.notEqual(childEnv.failure_log_path, productionLogPath);
  assert.equal(await fs.readFile(productionLogPath, "utf8"), "production stays here\n");

  for (const statePath of [
    summary.failure_log_path,
    summary.campaign_ledger_path,
    summary.runs_dir,
    summary.run_tasks_dir,
    summary.input_requests_dir,
    summary.sessions_dir,
    summary.pi_raw_sessions_dir,
    summary.model_health_path,
  ]) {
    assert.equal(statePath.startsWith(`${summary.state_root}${path.sep}`), true, statePath);
  }
  assert.equal(childEnv.runs_dir, summary.runs_dir);
  assert.equal(childEnv.campaign_ledger_path, summary.campaign_ledger_path);
  assert.equal(childEnv.run_tasks_dir, summary.run_tasks_dir);
  assert.equal(childEnv.input_requests_dir, summary.input_requests_dir);
  assert.equal(childEnv.sessions_dir, summary.sessions_dir);
  assert.equal(childEnv.pi_raw_sessions_dir, summary.pi_raw_sessions_dir);
  assert.equal(childEnv.model_health_path, summary.model_health_path);
});

test("observed MCP probe records call attempts and failure-log deltas", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-campaign-probe-"));
  const projectDir = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const configPath = path.join(stateDir, "config.json");
  const fake = await createFakePiChild();
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify({ default_model_class: "C" }),
  );

  const result = await runHarness(
    [
      "--campaign-id",
      "campaign.probe-1",
      "--",
      process.execPath,
      probePath,
      "--server",
      path.resolve("dist/server.js"),
      "--cwd",
      projectDir,
      "--scenario",
      "success",
      "--scenario",
      "schema-error",
      "--scenario",
      "handler-validation",
      "--scenario",
      "child-failure",
      "--quiet",
    ],
    {
      SUBAGENT007_CONFIG_PATH: configPath,
      SUBAGENT007_PI_CHILD_PATH: fake.childPath,
      FAKE_PI_LOG_PATH: fake.logPath,
      SUBAGENT007_RECORD_SOURCE: "test",
    },
  );

  assert.equal(result.ok, true);
  assert.ok(result.json);
  const events = await readJsonl<{
    event: string;
    call_id: string;
    scenario: string;
    tool: string;
    result?: { success: boolean | null; kind?: string | null; transcript_redacted?: boolean };
    argument_shape?: Record<string, unknown>;
    failure_classes?: string[];
    reason_codes?: string[];
    evidence_class?: string;
  }>(result.json.campaign_ledger_path);

  for (const scenario of ["success", "schema-error", "handler-validation", "child-failure"]) {
    assert.ok(events.some((event) => event.event === "call_started" && event.scenario === scenario), scenario);
  }

  const schemaError = events.find((event) => event.event === "call_schema_error" && event.scenario === "schema-error");
  assert.ok(schemaError);
  assert.equal(events.some((event) => event.event === "failure_log_delta" && event.call_id === schemaError.call_id), false);

  const handlerRejection = events.find(
    (event) => event.event === "call_preflight_rejected" && event.scenario === "handler-validation",
  );
  assert.ok(handlerRejection);
  assert.equal(handlerRejection.result?.kind, "preflight_rejected");
  assert.ok(
    events.some(
      (event) =>
        event.event === "failure_log_delta" &&
        event.call_id === handlerRejection.call_id &&
        event.reason_codes?.includes("cwd_not_absolute"),
    ),
  );

  const successResult = events.find((event) => event.event === "call_result" && event.scenario === "success");
  assert.equal(successResult?.result?.success, true);

  const childFailure = events.find((event) => event.event === "call_result" && event.scenario === "child-failure");
  assert.equal(childFailure?.result?.success, false);
  assert.ok(
    events.some(
      (event) =>
        event.event === "failure_log_delta" &&
        event.call_id === childFailure?.call_id &&
        event.failure_classes?.includes("nonzero_exit"),
    ),
  );

  assert.doesNotMatch(JSON.stringify(events), /SECRET_LEDGER_PROMPT/);
  assert.equal(events.every((event) => event.tool === "run_subagent"), true);
  assert.equal(events.every((event) => event.evidence_class === "protocol-deterministic"), true);
  assert.equal(
    events
      .filter((event) => event.event === "call_started")
      .every((event) => Array.isArray(event.argument_shape?.keys)),
    true,
  );
});

test("observed MCP probe maps all scenario alias to full-current coverage", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-probe-coverage-"));
  const projectDir = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const configPath = path.join(stateDir, "config.json");
  const fake = await createFakePiChild();
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ default_model_class: "C" }));

  const result = await execFileAsync(
    process.execPath,
    [
      probePath,
      "--server",
      path.resolve("dist/server.js"),
      "--cwd",
      projectDir,
      "--scenario",
      "all",
    ],
    {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        SUBAGENT007_CONFIG_PATH: configPath,
        SUBAGENT007_PI_CHILD_PATH: fake.childPath,
        FAKE_PI_LOG_PATH: fake.logPath,
        SUBAGENT007_FAILURE_LOG_PATH: path.join(stateDir, "failures.jsonl"),
        SUBAGENT007_CAMPAIGN_LEDGER_PATH: path.join(stateDir, "campaign-ledger.jsonl"),
        SUBAGENT007_SESSIONS_DIR: path.join(stateDir, "sessions"),
        SUBAGENT007_RUNS_DIR: path.join(stateDir, "runs"),
        SUBAGENT007_INPUT_REQUESTS_DIR: path.join(stateDir, "input-requests"),
        SUBAGENT007_PI_RAW_SESSIONS_DIR: path.join(stateDir, "raw-sessions"),
        SUBAGENT007_MODEL_HEALTH_PATH: path.join(stateDir, "model-health.json"),
        SUBAGENT007_RECORD_SOURCE: "test",
      },
      maxBuffer: 8 * 1024 * 1024,
    },
  );

  const summary = JSON.parse(result.stdout) as {
    scenario_set: string;
    mode: string;
    scenarios: string[];
    coverage_summary: {
      covered_surfaces: string[];
      covered_surfaces_by_evidence_class: Record<string, string[]>;
      uncovered_surfaces: string[];
      missing_required_surfaces: string[];
      scenarios: Array<{
        scenario: string;
        tool: string;
        surfaces: string[];
        evidence_class: string;
        evidence_satisfied?: boolean;
        observed_result?: {
          transcript_redacted?: boolean;
          tool_surface_complete?: boolean;
          tool_surface_exact?: boolean;
          skill_alias_guidance_clear?: boolean;
          effect_profile_schema_exact?: boolean;
          operational_guidance_clear?: boolean;
          missing_tools?: string[];
          unexpected_tools?: string[];
          unclear_skill_alias_tools?: string[];
          public_calibration_fields_absent?: boolean;
          forbidden_public_calibration_fields?: string[];
          failure_log_calibration_fields_absent?: boolean;
          forbidden_failure_log_calibration_fields?: string[];
          failure_log_matching_tool?: string;
          failure_log_matching_task_kind?: string;
          failure_log_matching_run_id?: string;
          run_id?: string;
          status?: string;
          success?: boolean;
          kind?: string;
          reason_code?: string;
          child_started?: boolean;
          requested_output_mode?: string;
          written_output_mode?: string;
          output_reference_modes?: string[];
          capacity_rejected?: boolean;
          cleanup_status?: string;
          after_release_status?: string;
          after_release_success?: boolean;
          delegated_status?: string;
          delegated_run_id?: string;
          delegated_kind?: string;
          delegated_reason_code?: string;
          delegated_parent_run_id?: string;
          delegated_root_run_id?: string;
          delegated_recursion_depth?: number;
          delegated_view_status?: string;
          delegated_view_parent_run_id?: string;
          delegated_view_root_run_id?: string;
          delegated_view_recursion_depth?: number;
          root_child_contains_delegated?: boolean;
          root_child_run_count?: number;
          recursive_child_started_event?: boolean;
          recursive_child_finished_event?: boolean;
          recursive_child_started_events?: Array<{
            child_run_id?: string;
            parent_run_id?: string;
            root_run_id?: string;
            recursion_depth?: number;
          }>;
          recursive_child_finished_events?: Array<{
            child_run_id?: string;
            parent_run_id?: string;
            root_run_id?: string;
            recursion_depth?: number;
            status?: string;
            success?: boolean;
          }>;
          recursive_child_finished_status?: string;
          recursive_child_finished_success?: boolean;
        };
      }>;
      evidence_classes: string[];
    };
  };

  assert.equal(summary.scenario_set, "full-current");
  assert.equal(summary.mode, "protocol-deterministic");
  assert.ok(summary.scenarios.includes("run-contract"));
  assert.ok(summary.scenarios.includes("runtime-readiness"));
  assert.ok(summary.scenarios.includes("model-listing-alias"));
  assert.ok(summary.scenarios.includes("auto-promotion"));
  assert.ok(summary.scenarios.includes("start-run-async-polling"));
  assert.ok(summary.scenarios.includes("missing-final-output"));
  assert.ok(summary.scenarios.includes("local-capacity-exhaustion"));
  assert.ok(summary.scenarios.includes("schedule-run-durable-first"));
  assert.ok(summary.scenarios.includes("start-session-run-async-polling"));
  assert.ok(summary.scenarios.includes("start-session-packet-failure"));
  assert.ok(summary.scenarios.includes("start-session-require-existing-missing"));
  assert.ok(summary.scenarios.includes("get-run-missing"));
  assert.ok(summary.scenarios.includes("caller-input"));
  assert.ok(summary.scenarios.includes("caller-input-wrong-request"));
  assert.ok(summary.scenarios.includes("cancellation"));
  assert.ok(summary.scenarios.includes("cancel-terminal-run"));
  assert.ok(summary.scenarios.includes("restart-drift"));
  assert.ok(summary.scenarios.includes("session-valid-closure"));
  assert.ok(summary.scenarios.includes("session-invalid-closure"));
  assert.ok(summary.scenarios.includes("run-subagent-session-require-existing-missing"));
  assert.ok(summary.scenarios.includes("recursive-delegate-success"));
  assert.ok(summary.scenarios.includes("recursive-delegate-parent-terminal-child-finish"));
  assert.ok(summary.scenarios.includes("recursive-delegate-depth-limit"));
  assert.ok(summary.scenarios.includes("recursive-delegate-forged-lineage"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("run_subagent-success"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("tool-listing"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("runtime-readiness"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("durable-run-contract"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("model-class-listing"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("model-class-listing-alias"));
  assert.ok(summary.coverage_summary.covered_surfaces_by_evidence_class["protocol-deterministic"].includes("run_subagent-success"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("run_subagent-auto-promotion"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("run_subagent_session-packet-failure"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("start_run-async-polling"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("start_run-missing-final-output"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("start_run-local-capacity-exhaustion"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("schedule_run-durable-first"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("start_session_run-async-polling"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("start_session_run-packet-failure"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("start_session_run-require-existing-missing"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("get_run-run-not-found"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("answer_run_input-caller-input"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("answer_run_input-wrong-request-rejection"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("cancel_run-cancellation-settlement"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("cancel_run-terminal-idempotency"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("get_run-restart-drift"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("run_subagent_session-require-existing-missing"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("transcript-redaction"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("recursive-delegate-success-lineage"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("recursive-delegate-parent-terminal-child-finish-event"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("recursive-delegate-depth-limit"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("recursive-delegate-forged-lineage"));
  assert.ok(summary.coverage_summary.uncovered_surfaces.includes("installed-pi-integration"));
  assert.deepEqual(summary.coverage_summary.missing_required_surfaces, []);
  assert.equal(summary.coverage_summary.scenarios.every((scenario) => scenario.tool.length > 0), true);
  const toolListingScenario = summary.coverage_summary.scenarios.find((scenario) =>
    scenario.scenario === "tool-listing"
  );
  assert.equal(toolListingScenario?.evidence_satisfied, true);
  assert.equal(toolListingScenario?.observed_result?.tool_surface_complete, true);
  assert.equal(toolListingScenario?.observed_result?.tool_surface_exact, true);
  assert.deepEqual(toolListingScenario?.observed_result?.missing_tools, []);
  assert.deepEqual(toolListingScenario?.observed_result?.unexpected_tools, []);
  assert.equal(toolListingScenario?.observed_result?.skill_alias_guidance_clear, true);
  assert.equal(toolListingScenario?.observed_result?.effect_profile_schema_exact, true);
  assert.equal(toolListingScenario?.observed_result?.operational_guidance_clear, true);
  assert.deepEqual(toolListingScenario?.observed_result?.unclear_skill_alias_tools, []);
  const redactionScenario = summary.coverage_summary.scenarios.find((scenario) =>
    scenario.scenario === "transcript-redaction"
  );
  assert.equal(redactionScenario?.evidence_satisfied, true);
  assert.equal(redactionScenario?.observed_result?.transcript_redacted, true);
  const missingFinal = summary.coverage_summary.scenarios.find((scenario) =>
    scenario.scenario === "missing-final-output"
  );
  assert.equal(missingFinal?.evidence_satisfied, true);
  assert.equal(missingFinal?.observed_result?.status, "failed");
  assert.equal(missingFinal?.observed_result?.success, false);
  assert.equal(missingFinal?.observed_result?.reason_code, "missing_final_output");
  assert.equal(missingFinal?.observed_result?.requested_output_mode, "final");
  assert.equal(missingFinal?.observed_result?.written_output_mode, "transcript");
  assert.equal(missingFinal?.observed_result?.output_reference_modes?.includes("transcript"), true);
  const startSessionMissing = summary.coverage_summary.scenarios.find((scenario) =>
    scenario.scenario === "start-session-require-existing-missing"
  );
  assert.equal(startSessionMissing?.evidence_satisfied, true);
  assert.equal(startSessionMissing?.observed_result?.kind, "preflight_rejected");
  assert.equal(startSessionMissing?.observed_result?.reason_code, "session_does_not_exist");
  assert.equal(startSessionMissing?.observed_result?.child_started, false);
  assert.equal(startSessionMissing?.observed_result?.run_id, undefined);
  const runSessionMissing = summary.coverage_summary.scenarios.find((scenario) =>
    scenario.scenario === "run-subagent-session-require-existing-missing"
  );
  assert.equal(runSessionMissing?.evidence_satisfied, true);
  assert.equal(runSessionMissing?.observed_result?.kind, "preflight_rejected");
  assert.equal(runSessionMissing?.observed_result?.reason_code, "session_does_not_exist");
  assert.equal(runSessionMissing?.observed_result?.child_started, false);
  assert.equal(runSessionMissing?.observed_result?.run_id, undefined);
  const localCapacity = summary.coverage_summary.scenarios.find((scenario) =>
    scenario.scenario === "local-capacity-exhaustion"
  );
  assert.equal(localCapacity?.evidence_satisfied, true);
  assert.equal(localCapacity?.observed_result?.capacity_rejected, true);
  assert.equal(localCapacity?.observed_result?.kind, "preflight_rejected");
  assert.equal(localCapacity?.observed_result?.reason_code, "local_capacity_exhausted");
  assert.equal(localCapacity?.observed_result?.child_started, false);
  assert.equal(localCapacity?.observed_result?.cleanup_status, "cancelled");
  assert.equal(localCapacity?.observed_result?.after_release_status, "completed");
  assert.equal(localCapacity?.observed_result?.after_release_success, true);
  const recursiveSuccess = summary.coverage_summary.scenarios.find((scenario) =>
    scenario.scenario === "recursive-delegate-success"
  );
  assert.equal(recursiveSuccess?.evidence_satisfied, true);
  assert.equal(recursiveSuccess?.observed_result?.root_child_contains_delegated, true);
  assert.equal(recursiveSuccess?.observed_result?.delegated_recursion_depth, 1);
  assert.equal(recursiveSuccess?.observed_result?.delegated_view_status, "completed");
  assert.equal(recursiveSuccess?.observed_result?.recursive_child_started_event, true);
  assert.equal(recursiveSuccess?.observed_result?.recursive_child_finished_event, true);
  assert.equal(recursiveSuccess?.observed_result?.recursive_child_finished_status, "completed");
  assert.equal(recursiveSuccess?.observed_result?.recursive_child_finished_success, true);
  const recursiveSuccessStartedEvent = recursiveSuccess?.observed_result?.recursive_child_started_events?.find((event) =>
    event.child_run_id === recursiveSuccess.observed_result?.delegated_run_id
  );
  const recursiveSuccessFinishedEvent = recursiveSuccess?.observed_result?.recursive_child_finished_events?.find((event) =>
    event.child_run_id === recursiveSuccess.observed_result?.delegated_run_id
  );
  assert.deepEqual(recursiveSuccessStartedEvent, {
    child_run_id: recursiveSuccess?.observed_result?.delegated_run_id,
    parent_run_id: recursiveSuccess?.observed_result?.run_id,
    root_run_id: recursiveSuccess?.observed_result?.run_id,
    recursion_depth: 1,
  });
  assert.deepEqual(recursiveSuccessFinishedEvent, {
    child_run_id: recursiveSuccess?.observed_result?.delegated_run_id,
    parent_run_id: recursiveSuccess?.observed_result?.run_id,
    root_run_id: recursiveSuccess?.observed_result?.run_id,
    recursion_depth: 1,
    status: "completed",
    success: true,
  });
  const recursiveWait0 = summary.coverage_summary.scenarios.find((scenario) =>
    scenario.scenario === "recursive-delegate-parent-terminal-child-finish"
  );
  assert.equal(recursiveWait0?.evidence_satisfied, true);
  assert.equal(recursiveWait0?.observed_result?.delegated_status, "working");
  assert.equal(recursiveWait0?.observed_result?.delegated_view_status, "completed");
  assert.equal(recursiveWait0?.observed_result?.recursive_child_started_event, true);
  assert.equal(recursiveWait0?.observed_result?.recursive_child_finished_event, true);
  assert.equal(
    recursiveWait0?.observed_result?.recursive_child_finished_events?.some((event) =>
      event.child_run_id === recursiveWait0.observed_result?.delegated_run_id &&
      event.status === "completed" &&
      event.success === true
    ),
    true,
  );
  const recursiveDepthLimit = summary.coverage_summary.scenarios.find((scenario) =>
    scenario.scenario === "recursive-delegate-depth-limit"
  );
  assert.equal(recursiveDepthLimit?.evidence_satisfied, true);
  assert.equal(recursiveDepthLimit?.observed_result?.delegated_kind, "recursive_delegate_rejected");
  assert.equal(recursiveDepthLimit?.observed_result?.delegated_reason_code, "recursive_depth_exceeded");
  assert.equal(recursiveDepthLimit?.observed_result?.root_child_run_count, 0);
  assert.notEqual(recursiveDepthLimit?.observed_result?.recursive_child_started_event, true);
  assert.notEqual(recursiveDepthLimit?.observed_result?.recursive_child_finished_event, true);
  const recursiveForgedLineage = summary.coverage_summary.scenarios.find((scenario) =>
    scenario.scenario === "recursive-delegate-forged-lineage"
  );
  assert.equal(recursiveForgedLineage?.evidence_satisfied, true);
  assert.equal(recursiveForgedLineage?.observed_result?.delegated_kind, "recursive_delegate_rejected");
  assert.equal(recursiveForgedLineage?.observed_result?.delegated_reason_code, "recursive_control_invalid");
  assert.equal(recursiveForgedLineage?.observed_result?.root_child_run_count, 0);
  assert.notEqual(recursiveForgedLineage?.observed_result?.recursive_child_started_event, true);
  assert.notEqual(recursiveForgedLineage?.observed_result?.recursive_child_finished_event, true);
  assert.equal(
    summary.coverage_summary.scenarios.every((scenario) =>
      scenario.observed_result?.public_calibration_fields_absent !== false &&
        scenario.observed_result?.failure_log_calibration_fields_absent !== false &&
        (scenario.observed_result?.forbidden_public_calibration_fields?.length ?? 0) === 0 &&
        (scenario.observed_result?.forbidden_failure_log_calibration_fields?.length ?? 0) === 0
    ),
    true,
  );
  assert.deepEqual(summary.coverage_summary.evidence_classes, ["protocol-deterministic"]);
  assert.equal(
    summary.coverage_summary.scenarios.every((scenario) => scenario.evidence_class === "protocol-deterministic"),
    true,
  );
});

test("observed MCP probe covers recursive delegate lineage and rejection edges", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-probe-recursive-"));
  const projectDir = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const configPath = path.join(stateDir, "config.json");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ default_model_class: "C" }));

  const result = await execFileAsync(
    process.execPath,
    [
      probePath,
      "--server",
      path.resolve("dist/server.js"),
      "--cwd",
      projectDir,
      "--scenario",
      "recursive-delegate-success",
      "--scenario",
      "recursive-delegate-depth-limit",
      "--scenario",
      "recursive-delegate-forged-lineage",
    ],
    {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        SUBAGENT007_CONFIG_PATH: configPath,
        SUBAGENT007_FAILURE_LOG_PATH: path.join(stateDir, "failures.jsonl"),
        SUBAGENT007_CAMPAIGN_LEDGER_PATH: path.join(stateDir, "campaign-ledger.jsonl"),
        SUBAGENT007_SESSIONS_DIR: path.join(stateDir, "sessions"),
        SUBAGENT007_RUNS_DIR: path.join(stateDir, "runs"),
        SUBAGENT007_RUN_TASKS_DIR: path.join(stateDir, "run-tasks"),
        SUBAGENT007_INPUT_REQUESTS_DIR: path.join(stateDir, "input-requests"),
        SUBAGENT007_PI_RAW_SESSIONS_DIR: path.join(stateDir, "raw-sessions"),
        SUBAGENT007_MODEL_HEALTH_PATH: path.join(stateDir, "model-health.json"),
        SUBAGENT007_RECORD_SOURCE: "test",
      },
      maxBuffer: 8 * 1024 * 1024,
    },
  );

  const summary = JSON.parse(result.stdout) as {
    coverage_summary: {
      missing_required_surfaces: string[];
      scenarios: Array<{
        scenario: string;
        evidence_satisfied?: boolean;
        observed_result?: Record<string, unknown>;
      }>;
    };
  };
  assert.deepEqual(summary.coverage_summary.missing_required_surfaces, []);
  const byScenario = new Map(
    summary.coverage_summary.scenarios.map((scenario) => [scenario.scenario, scenario]),
  );

  const success = byScenario.get("recursive-delegate-success")?.observed_result;
  assert.equal(byScenario.get("recursive-delegate-success")?.evidence_satisfied, true);
  assert.equal(success?.delegated_status, "completed");
  assert.equal(success?.delegated_recursion_depth, 1);
  assert.equal(success?.root_child_contains_delegated, true);
  assert.equal(success?.delegated_view_status, "completed");
  assert.equal(success?.delegated_parent_run_id, success?.delegated_view_parent_run_id);
  assert.equal(success?.delegated_root_run_id, success?.delegated_view_root_run_id);
  assert.equal(success?.delegated_recursion_depth, success?.delegated_view_recursion_depth);

  const depthLimit = byScenario.get("recursive-delegate-depth-limit")?.observed_result;
  assert.equal(byScenario.get("recursive-delegate-depth-limit")?.evidence_satisfied, true);
  assert.equal(depthLimit?.delegated_status, "rejected");
  assert.equal(depthLimit?.delegated_kind, "recursive_delegate_rejected");
  assert.equal(depthLimit?.delegated_reason_code, "recursive_depth_exceeded");
  assert.equal(depthLimit?.root_child_run_count, 0);

  const forgedLineage = byScenario.get("recursive-delegate-forged-lineage")?.observed_result;
  assert.equal(byScenario.get("recursive-delegate-forged-lineage")?.evidence_satisfied, true);
  assert.equal(forgedLineage?.delegated_status, "rejected");
  assert.equal(forgedLineage?.delegated_kind, "recursive_delegate_rejected");
  assert.equal(forgedLineage?.delegated_reason_code, "recursive_control_invalid");
  assert.equal(forgedLineage?.root_child_run_count, 0);

  const ledgerText = await fs.readFile(path.join(stateDir, "campaign-ledger.jsonl"), "utf8");
  assert.match(ledgerText, /recursive-delegate-success/);
  assert.match(ledgerText, /recursive-delegate-depth-limit/);
  assert.match(ledgerText, /recursive-delegate-forged-lineage/);

  const publicArtifactText = [
    result.stdout,
    ledgerText,
    await readPublicCampaignArtifactTextUnder(stateDir),
  ].join("\n");
  assert.doesNotMatch(publicArtifactText, /recursiveControl|subagent007-recursive|socket_path|"token"/);
});

test("protocol-deterministic observed MCP probe refuses unscoped failure telemetry", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-unscoped-probe-"));
  const projectDir = path.join(tmp, "project");
  await fs.mkdir(projectDir, { recursive: true });
  const env = { ...process.env };
  delete env.SUBAGENT007_FAILURE_LOG_PATH;
  delete env.SUBAGENT007_CAMPAIGN_LEDGER_PATH;
  delete env.SUBAGENT007_CAMPAIGN_ID;
  delete env.SUBAGENT007_RECORD_SOURCE;

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        probePath,
        "--server",
        path.resolve("dist/server.js"),
        "--cwd",
        projectDir,
        "--scenario",
        "success",
      ],
      {
        cwd: path.resolve("."),
        env,
        maxBuffer: 8 * 1024 * 1024,
      },
    ),
    (error: unknown) => {
      const failed = error as Error & { code?: number; stderr?: string };
      assert.equal(failed.code, 2);
      assert.match(
        failed.stderr ?? "",
        /protocol-deterministic observed probes require SUBAGENT007_FAILURE_LOG_PATH/,
      );
      return true;
    },
  );
});

test("observed MCP probe rejects retired all-bundled alias with protocol-core guidance", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-probe-retired-alias-"));
  const projectDir = path.join(tmp, "project");
  await fs.mkdir(projectDir, { recursive: true });

  for (const args of [
    ["--profile", "all-bundled"],
    ["--scenario", "all-bundled"],
  ]) {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          probePath,
          "--server",
          path.resolve("dist/server.js"),
          "--cwd",
          projectDir,
          ...args,
        ],
        {
          cwd: path.resolve("."),
        },
      ),
      /all-bundled is retired; use --profile protocol-core/,
    );
  }
});

test("observed MCP probe separates live-model mode from deterministic-only scenarios", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-probe-live-mode-"));
  const projectDir = path.join(tmp, "project");
  await fs.mkdir(projectDir, { recursive: true });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        probePath,
        "--server",
        path.resolve("dist/server.js"),
        "--cwd",
        projectDir,
        "--mode",
        "live-model",
        "--scenario",
        "child-failure",
      ],
      {
        cwd: path.resolve("."),
      },
    ),
    /incompatible scenarios/,
  );
});

test("observed MCP probe keeps old live profile names as compatibility aliases", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-probe-live-alias-"));
  const projectDir = path.join(tmp, "project");
  await fs.mkdir(projectDir, { recursive: true });

  for (const profile of ["live-smoke", "stateful-live"]) {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          probePath,
          "--server",
          path.resolve("dist/server.js"),
          "--cwd",
          projectDir,
          "--profile",
          profile,
          "--scenario",
          "child-failure",
        ],
        {
          cwd: path.resolve("."),
        },
      ),
      /live-model mode cannot run incompatible scenarios: child-failure/,
    );
  }
});

test("observed MCP probe self-check fails when manifest omits a SAF-required surface", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-probe-manifest-"));
  const manifestPath = path.join(tmp, "bad-manifest.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      saf_required_surfaces: ["missing-surface"],
      surfaces: {},
      scenarios: {},
      profiles: {},
      aliases: {},
    }),
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [probePath, "--help"],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          SUBAGENT007_COVERAGE_MANIFEST_PATH: manifestPath,
        },
      },
    ),
    /coverage manifest omits SAF-required surfaces/,
  );
});

test("observed MCP probe self-check fails when an alias targets a missing profile", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-probe-bad-alias-"));
  const manifestPath = path.join(tmp, "bad-alias-manifest.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      saf_required_surfaces: [],
      surfaces: {},
      scenarios: {},
      profiles: {
        "protocol-core": {
          mode: "protocol-deterministic",
          scenarios: [],
          required_surfaces: [],
        },
      },
      aliases: {
        stale: "missing-profile",
      },
    }),
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [probePath, "--help"],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          SUBAGENT007_COVERAGE_MANIFEST_PATH: manifestPath,
        },
      },
    ),
    /coverage alias stale targets unknown profile: missing-profile/,
  );
});

test("observed MCP probe self-check fails when a profile has no compatible scenario for a required surface", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-probe-unsatisfied-profile-"));
  const manifestPath = path.join(tmp, "bad-profile-manifest.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      saf_required_surfaces: ["run_subagent-success"],
      surfaces: {
        "run_subagent-success": { evidence_classes: ["protocol-deterministic"] },
      },
      scenarios: {
        "schema-error": {
          tool: "run_subagent",
          result_classes: ["schema_error"],
          surfaces: [],
        },
      },
      profiles: {
        "protocol-core": {
          mode: "protocol-deterministic",
          scenarios: ["schema-error"],
          required_surfaces: ["run_subagent-success"],
        },
      },
      aliases: {},
    }),
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [probePath, "--help"],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          SUBAGENT007_COVERAGE_MANIFEST_PATH: manifestPath,
        },
      },
    ),
    /no compatible scenario for required surfaces: run_subagent-success/,
  );
});

test("observed MCP probe full-current covers all deterministic current surfaces", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-full-current-"));
  const projectDir = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const configPath = path.join(stateDir, "config.json");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ default_model_class: "C" }));

  const result = await execFileAsync(
    process.execPath,
    [
      probePath,
      "--server",
      path.resolve("dist/server.js"),
      "--cwd",
      projectDir,
      "--profile",
      "full-current",
    ],
    {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        SUBAGENT007_CONFIG_PATH: configPath,
        SUBAGENT007_FAILURE_LOG_PATH: path.join(stateDir, "failures.jsonl"),
        SUBAGENT007_CAMPAIGN_LEDGER_PATH: path.join(stateDir, "campaign-ledger.jsonl"),
        SUBAGENT007_SESSIONS_DIR: path.join(stateDir, "sessions"),
        SUBAGENT007_RUNS_DIR: path.join(stateDir, "runs"),
        SUBAGENT007_RUN_TASKS_DIR: path.join(stateDir, "run-tasks"),
        SUBAGENT007_INPUT_REQUESTS_DIR: path.join(stateDir, "input-requests"),
        SUBAGENT007_PI_RAW_SESSIONS_DIR: path.join(stateDir, "raw-sessions"),
        SUBAGENT007_MODEL_HEALTH_PATH: path.join(stateDir, "model-health.json"),
        SUBAGENT007_RECORD_SOURCE: "test",
      },
      maxBuffer: 12 * 1024 * 1024,
    },
  );

  const summary = JSON.parse(result.stdout) as {
    scenario_set: string;
    mode: string;
    coverage_summary: {
      covered_surfaces: string[];
      missing_required_surfaces: string[];
      uncovered_surfaces: string[];
      scenarios: Array<{
        scenario: string;
        evidence_satisfied: boolean;
        observed_result?: {
          tool_surface_complete?: boolean;
          tool_surface_exact?: boolean;
          skill_alias_guidance_clear?: boolean;
          effect_profile_schema_exact?: boolean;
          missing_tools?: string[];
          unexpected_tools?: string[];
          unclear_skill_alias_tools?: string[];
          public_calibration_fields_absent?: boolean;
          forbidden_public_calibration_fields?: string[];
          failure_log_calibration_fields_absent?: boolean;
          forbidden_failure_log_calibration_fields?: string[];
          failure_log_matching_tool?: string;
          failure_log_matching_task_kind?: string;
          failure_log_matching_run_id?: string;
          run_id?: string;
        };
      }>;
    };
  };

  assert.equal(summary.scenario_set, "full-current");
  assert.equal(summary.mode, "protocol-deterministic");
  assert.deepEqual(summary.coverage_summary.missing_required_surfaces, []);
  for (const surface of [
    "runtime-readiness",
    "durable-run-contract",
    "model-class-listing-alias",
    "run_subagent-auto-promotion",
    "run_subagent-timeout-recovery",
    "schedule_run-durable-first",
    "start_run-async-polling",
    "start_run-missing-final-output",
    "start_run-local-capacity-exhaustion",
    "start_session_run-async-polling",
    "start_session_run-packet-failure",
    "start_session_run-require-existing-missing",
    "get_run-run-not-found",
    "answer_run_input-caller-input",
    "answer_run_input-wrong-request-rejection",
    "cancel_run-cancellation-settlement",
    "cancel_run-terminal-idempotency",
    "get_run-restart-drift",
    "run_subagent_session-valid-packet-closure",
    "run_subagent_session-invalid-packet-closure",
    "run_subagent_session-require-existing-missing",
  ]) {
    assert.ok(summary.coverage_summary.covered_surfaces.includes(surface), surface);
  }
  assert.ok(summary.coverage_summary.uncovered_surfaces.includes("installed-pi-integration"));
  assert.equal(summary.coverage_summary.scenarios.every((scenario) => scenario.evidence_satisfied), true);
  const toolListingScenario = summary.coverage_summary.scenarios.find((scenario) =>
    scenario.scenario === "tool-listing"
  );
  assert.equal(toolListingScenario?.observed_result?.tool_surface_complete, true);
  assert.equal(toolListingScenario?.observed_result?.tool_surface_exact, true);
  assert.deepEqual(toolListingScenario?.observed_result?.missing_tools, []);
  assert.deepEqual(toolListingScenario?.observed_result?.unexpected_tools, []);
  assert.equal(toolListingScenario?.observed_result?.skill_alias_guidance_clear, true);
  assert.equal(toolListingScenario?.observed_result?.effect_profile_schema_exact, true);
  assert.deepEqual(toolListingScenario?.observed_result?.unclear_skill_alias_tools, []);
  const startSessionPacketScenario = summary.coverage_summary.scenarios.find((scenario) =>
    scenario.scenario === "start-session-packet-failure"
  );
  assert.equal(startSessionPacketScenario?.observed_result?.failure_log_matching_tool, "start_session_run");
  assert.equal(startSessionPacketScenario?.observed_result?.failure_log_matching_task_kind, "session");
  assert.equal(
    startSessionPacketScenario?.observed_result?.failure_log_matching_run_id,
    startSessionPacketScenario?.observed_result?.run_id,
  );
  assert.equal(
    summary.coverage_summary.scenarios.every((scenario) =>
      scenario.observed_result?.public_calibration_fields_absent !== false &&
        scenario.observed_result?.failure_log_calibration_fields_absent !== false &&
        (scenario.observed_result?.forbidden_public_calibration_fields?.length ?? 0) === 0 &&
        (scenario.observed_result?.forbidden_failure_log_calibration_fields?.length ?? 0) === 0
    ),
    true,
  );

  const ledgerText = await fs.readFile(path.join(stateDir, "campaign-ledger.jsonl"), "utf8");
  assert.doesNotMatch(ledgerText, /SECRET_CAMPAIGN_INPUT_ANSWER/);
  const publicArtifactText = await readPublicCampaignArtifactTextUnder(stateDir);
  assert.doesNotMatch(publicArtifactText, /SECRET_LEDGER_PROMPT|SECRET_TRANSCRIPT_PROMPT_SHOULD_NOT_LEAK/);
  assert.doesNotMatch(
    publicArtifactText,
    /"resolved_model"|"resolved_thinking_level"|"resolved_default_model"|"resolved_default_thinking_level"|"model":|"[^"]*thinking_level[^"]*":/,
  );
  const events = ledgerText
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line)) as Array<{
      event: string;
      scenario: string;
      tool: string;
      failure_log_calibration_fields_absent?: boolean;
      forbidden_failure_log_calibration_fields?: string[];
    }>;
  for (const tool of ["schedule_run", "start_run", "get_run", "answer_run_input", "cancel_run", "start_session_run", "run_subagent_session"]) {
    assert.ok(events.some((event) => event.tool === tool), tool);
  }
  assert.ok(
    events.some((event) => event.event === "call_operation_rejected" && event.scenario === "get-run-missing"),
  );
  assert.ok(
    events.some((event) => event.event === "call_operation_rejected" && event.scenario === "caller-input-wrong-request"),
  );
  assert.equal(
    events
      .filter((event) => event.event === "failure_log_delta")
      .every((event) =>
        event.failure_log_calibration_fields_absent === true &&
          (event.forbidden_failure_log_calibration_fields?.length ?? 0) === 0
      ),
    true,
  );
});

test("observed MCP probe fails required coverage when selected scenario has wrong result class", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-probe-wrong-result-"));
  const projectDir = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const configPath = path.join(stateDir, "config.json");
  const manifestPath = path.join(tmp, "wrong-result-manifest.json");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ default_model_class: "C" }));
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      saf_required_surfaces: ["run_subagent-success"],
      surfaces: {
        "run_subagent-success": { evidence_classes: ["protocol-deterministic"] },
      },
      scenarios: {
        "schema-error": {
          tool: "run_subagent",
          result_classes: ["success"],
          surfaces: ["run_subagent-success"],
        },
      },
      profiles: {
        "protocol-core": {
          mode: "protocol-deterministic",
          scenarios: ["schema-error"],
          required_surfaces: ["run_subagent-success"],
        },
      },
      aliases: {},
    }),
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        probePath,
        "--server",
        path.resolve("dist/server.js"),
        "--cwd",
        projectDir,
        "--profile",
        "protocol-core",
      ],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          SUBAGENT007_CONFIG_PATH: configPath,
          SUBAGENT007_COVERAGE_MANIFEST_PATH: manifestPath,
          SUBAGENT007_FAILURE_LOG_PATH: path.join(stateDir, "failures.jsonl"),
          SUBAGENT007_CAMPAIGN_LEDGER_PATH: path.join(stateDir, "campaign-ledger.jsonl"),
          SUBAGENT007_RECORD_SOURCE: "test",
        },
        maxBuffer: 8 * 1024 * 1024,
      },
    ),
    /missing required coverage surfaces: run_subagent-success/,
  );
});

test("observed MCP probe fails tool-listing coverage when required public tools are absent", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-probe-missing-tools-"));
  const projectDir = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const manifestPath = path.join(tmp, "tool-listing-manifest.json");
  const fakeServerPath = path.join(tmp, "empty-mcp-server.mjs");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      saf_required_surfaces: ["tool-listing"],
      surfaces: {
        "tool-listing": { evidence_classes: ["protocol-deterministic"] },
      },
      scenarios: {
        "tool-listing": {
          tool: "__list_tools",
          result_classes: ["expected_tool_surface"],
          surfaces: ["tool-listing"],
        },
      },
      profiles: {
        "protocol-core": {
          mode: "protocol-deterministic",
          scenarios: ["tool-listing"],
          required_surfaces: ["tool-listing"],
        },
      },
      aliases: {},
    }),
  );
  await fs.writeFile(
    fakeServerPath,
    [
      `import { McpServer } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href)};`,
      `import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href)};`,
      "const server = new McpServer({ name: 'empty-mcp-server', version: '0.0.0' });",
      "await server.connect(new StdioServerTransport());",
    ].join("\n"),
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        probePath,
        "--server",
        fakeServerPath,
        "--cwd",
        projectDir,
        "--profile",
        "protocol-core",
      ],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          SUBAGENT007_COVERAGE_MANIFEST_PATH: manifestPath,
          SUBAGENT007_FAILURE_LOG_PATH: path.join(stateDir, "failures.jsonl"),
          SUBAGENT007_CAMPAIGN_LEDGER_PATH: path.join(stateDir, "campaign-ledger.jsonl"),
          SUBAGENT007_RECORD_SOURCE: "test",
        },
        maxBuffer: 8 * 1024 * 1024,
      },
    ),
    /missing required coverage surfaces: tool-listing/,
  );
});

test("observed MCP probe fails tool-listing coverage when unexpected public tools are exposed", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-probe-extra-tools-"));
  const projectDir = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const manifestPath = path.join(tmp, "tool-listing-manifest.json");
  const fakeServerPath = path.join(tmp, "noisy-mcp-server.mjs");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      saf_required_surfaces: ["tool-listing"],
      surfaces: {
        "tool-listing": { evidence_classes: ["protocol-deterministic"] },
      },
      scenarios: {
        "tool-listing": {
          tool: "__list_tools",
          result_classes: ["expected_tool_surface"],
          surfaces: ["tool-listing"],
        },
      },
      profiles: {
        "protocol-core": {
          mode: "protocol-deterministic",
          scenarios: ["tool-listing"],
          required_surfaces: ["tool-listing"],
        },
      },
      aliases: {},
    }),
  );
  await fs.writeFile(
    fakeServerPath,
    [
      `import { McpServer } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href)};`,
      `import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href)};`,
      `import { z } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/zod/index.js")).href)};`,
      "const server = new McpServer({ name: 'noisy-mcp-server', version: '0.0.0' });",
      "const expectedTools = ['answer_run_input','cancel_run','close_skill_snapshot_references','delete_skill_snapshot','get_run','get_run_contract','get_runtime_readiness','list_allowed_models','list_model_classes','plan_skill_snapshot_deletion','publish_skill_snapshots','resolve_retained_skill_snapshot_source','resolve_skill_bindings','resolve_skill_runtime_bundles','run_subagent','run_subagent_session','schedule_run','start_run','start_session_run','validate_skill_runtime_bundle','verify_skill_bindings'];",
      "const skillBindingTools = new Set(['run_subagent','run_subagent_session','schedule_run','start_run','start_session_run']);",
      "const skillName = z.string().nullable().optional().describe('Preferred bare skill name only, such as pda-lite or plugin:skill-name; null means no skill.');",
      "const skill = z.string().nullable().optional().describe('Legacy alias for skill_name; prefer skill_name for new callers. Bare skill name only, such as pda-lite or plugin:skill-name; null means no skill.');",
      "for (const name of expectedTools) {",
      "  server.registerTool(name, { inputSchema: skillBindingTools.has(name) ? { skill_name: skillName, skill } : {} }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));",
      "}",
      "server.registerTool('surprise_debug_tool', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));",
      "await server.connect(new StdioServerTransport());",
    ].join("\n"),
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        probePath,
        "--server",
        fakeServerPath,
        "--cwd",
        projectDir,
        "--profile",
        "protocol-core",
      ],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          SUBAGENT007_COVERAGE_MANIFEST_PATH: manifestPath,
          SUBAGENT007_FAILURE_LOG_PATH: path.join(stateDir, "failures.jsonl"),
          SUBAGENT007_CAMPAIGN_LEDGER_PATH: path.join(stateDir, "campaign-ledger.jsonl"),
          SUBAGENT007_RECORD_SOURCE: "test",
        },
        maxBuffer: 8 * 1024 * 1024,
      },
    ),
    /missing required coverage surfaces: tool-listing/,
  );
});

test("observed campaign harness preserves child command exit code", async () => {
  const result = await runHarness([
    "--campaign-id",
    "campaign.exit-7",
    "--",
    process.execPath,
    "-e",
    "process.exit(7)",
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.code, 7);
  assert.equal(result.json?.campaign_id, "campaign.exit-7");
  assert.equal(result.json?.evidence_class, "campaign-scoped");
  assert.equal(result.json?.command_exit_code, 7);
});

test("observed campaign harness rejects invalid campaign ids before running command", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-campaign-invalid-"));
  const marker = path.join(tmp, "marker");
  const result = await runHarness([
    "--campaign-id",
    "invalid id",
    "--",
    process.execPath,
    "-e",
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /campaign id must/);
  await assert.rejects(fs.stat(marker), /ENOENT/);
});

test("observed campaign harness can archive the campaign ledger", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-campaign-cwd-"));
  const childScript = [
    "const fs = require('fs');",
    "fs.appendFileSync(process.env.SUBAGENT007_FAILURE_LOG_PATH, JSON.stringify({",
    "  schema_version: 2,",
    "  timestamp: '2026-06-10T00:00:00.000Z',",
    "  tool: 'run_subagent',",
    "  failure_class: 'timeout',",
    "  campaign_id: process.env.SUBAGENT007_CAMPAIGN_ID",
    "}) + '\\n');",
  ].join(" ");

  const result = await runHarness(
    [
      "--campaign-id",
      "campaign.archive-harness",
      "--archive",
      "--",
      process.execPath,
      "-e",
      childScript,
    ],
    {},
    tmp,
  );

  assert.equal(result.ok, true);
  assert.ok(result.json);
  const summary = result.json;
  assert.equal(summary.archive?.ok, true);
  assert.equal(summary.evidence_class, "campaign-scoped");
  assert.equal(summary.archive?.result?.archived, true);
  assert.equal(summary.archive?.result?.log_path, summary.failure_log_path);
  await assert.rejects(fs.stat(summary.failure_log_path), /ENOENT/);
});
