import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { failureReasonCodeForError } from "../src/failureLog.js";
import { ValidationError } from "../src/types.js";
import { createFakePiChild } from "./helpers/fakePiChild.js";
import { readJsonl } from "./helpers/testUtils.js";

type FailureRecord = {
  schema_version: 2;
  event_id: string;
  timestamp: string;
  server_version: string;
  record_source: "production" | "test" | "unknown";
  campaign_id?: string;
  tool: string;
  failure_class: string;
  reason_code: string;
  cwd_class: string;
  cwd?: string;
  run_id?: string;
  task_kind?: "run" | "session";
  output_path?: string;
  session_key?: string;
  session_dir?: string;
  success?: boolean;
  exit_code?: number | null;
  timed_out?: boolean;
  partial_output_available?: boolean;
  resume_possible?: boolean;
  requested_timeout_ms?: number | null;
  resolved_timeout_ms?: number | null;
  effective_timeout_ms?: number | null;
  stop_reason?: string;
  stop_signal?: string | null;
  auto_promoted_from?: "run_subagent";
  promotion_reason_code?: string;
  promotion_reason?: string;
  model_class?: string;
  calibration_era?: string;
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
};

const TIMESTAMPED_EVENT_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{9}Z-[0-9a-f]{12}$/;

test("failure reason mapping uses explicit validation reason codes", () => {
  assert.equal(
    failureReasonCodeForError(
      new ValidationError(
        "tool_profile must be one of: all, inspect, web_search, shell, workspace_write",
        "invalid_tool_profile",
      ),
    ),
    "invalid_tool_profile",
  );
  assert.equal(
    failureReasonCodeForError(new ValidationError("timeout_ms must be a positive integer when provided", "invalid_timeout_ms")),
    "invalid_timeout_ms",
  );
  assert.equal(
    failureReasonCodeForError(
      new ValidationError(
        "timeout_ms under budget for deadline-risk workload; minimum_timeout_ms=600000",
        "timeout_underbudget_for_deadline_risk",
      ),
    ),
    "timeout_underbudget_for_deadline_risk",
  );
  assert.equal(
    failureReasonCodeForError(new ValidationError("input request not found: run-123", "input_request_not_found")),
    "input_request_not_found",
  );
  assert.equal(
    failureReasonCodeForError(
      new ValidationError(
        "Subagent007 child entrypoint is missing: /tmp/piChild.js. Run npm run build and restart the MCP server.",
        "child_entrypoint_missing",
      ),
    ),
    "child_entrypoint_missing",
  );
});

test("failure reason mapping does not infer reason codes from validation messages", () => {
  assert.equal(
    failureReasonCodeForError(new ValidationError("timeout_ms must be a positive integer when provided")),
    "unknown_validation_error",
  );
  assert.equal(
    failureReasonCodeForError(new ValidationError("tool_profile must be one of: all, inspect, web_search, shell, workspace_write")),
    "unknown_validation_error",
  );
  assert.equal(
    failureReasonCodeForError(new ValidationError("input request not found: run-123")),
    "unknown_validation_error",
  );
});

test("failure reason mapping prefers structured validation reason code over message text", () => {
  assert.equal(
    failureReasonCodeForError(new ValidationError("tool_profile must be one of: all, inspect", "invalid_output_mode")),
    "invalid_output_mode",
  );
});

async function withFakeClient<T>(
  run: (client: Client, dirs: { projectDir: string; failureLogPath: string }) => Promise<T>,
  extraEnv: Record<string, string> = {},
): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-failure-log-"));
  const projectDir = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const configPath = path.join(stateDir, "config.json");
  const failureLogPath = path.join(stateDir, "failures.jsonl");
  const fake = await createFakePiChild();
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify({ default_model_class: "C" }),
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/server.js")],
    env: {
      ...process.env,
      SUBAGENT007_CONFIG_PATH: configPath,
      SUBAGENT007_FAILURE_LOG_PATH: failureLogPath,
      SUBAGENT007_MODEL_HEALTH_PATH: path.join(stateDir, "model-health.json"),
      SUBAGENT007_PI_CHILD_PATH: fake.childPath,
      FAKE_PI_LOG_PATH: fake.logPath,
      SUBAGENT007_RECORD_SOURCE: "test",
      ...extraEnv,
    },
  });
  const client = new Client({ name: "subagent007-pi-failure-log-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    return await run(client, { projectDir, failureLogPath });
  } finally {
    await client.close();
  }
}

async function waitForRunStatus(client: Client, runId: string, expectedStatus: string): Promise<void> {
  const deadline = Date.now() + 3000;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const response = await client.callTool({
      name: "get_run",
      arguments: { run_id: runId },
    });
    assert.notEqual(response.isError, true);
    const view = response.structuredContent as { status: string };
    lastStatus = view.status;
    if (lastStatus === expectedStatus) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for run ${runId} to reach ${expectedStatus}; last status was ${lastStatus}`);
}

test("run_subagent appends one central record for a nonzero child failure", async () => {
  await withFakeClient(async (client, { projectDir, failureLogPath }) => {
    const response = await client.callTool({
      name: "run_subagent",
      arguments: {
        cwd: projectDir,
        prompt: "FAIL_EXIT do not log this prompt",
        run_kind: "quick_noninteractive",
        output_mode: "transcript",
      },
    });

    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as { run_id: string; stop_signal: string | null };
    const failures = await readJsonl<FailureRecord>(failureLogPath);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].tool, "run_subagent");
    assert.equal(failures[0].schema_version, 2);
    assert.match(failures[0].event_id, TIMESTAMPED_EVENT_ID_PATTERN);
    assert.equal(failures[0].server_version, "0.1.0");
    assert.equal(failures[0].calibration_era, "model_class_v1");
    assert.equal(failures[0].record_source, "test");
    assert.equal(failures[0].run_id, metadata.run_id);
    assert.equal(failures[0].task_kind, "run");
    assert.equal(failures[0].failure_class, "nonzero_exit");
    assert.equal(failures[0].reason_code, "nonzero_exit");
    assert.equal(failures[0].cwd, projectDir);
    assert.equal(failures[0].cwd_class, "temp");
    assert.equal(failures[0].exit_code, 42);
    assert.equal(failures[0].stop_reason, "failed");
    assert.equal(failures[0].stop_signal, null);
    assert.equal(failures[0].success, false);
    assert.equal(failures[0].partial_output_available, false);
    assert.equal(failures[0].resume_possible, false);
    assert.equal(failures[0].resolved_timeout_ms, 110000);
    assert.equal(failures[0].model_class, "C");
    assert.equal(Object.hasOwn(failures[0], "model"), false);
    assert.equal(Object.hasOwn(failures[0], "thinking_level"), false);
    assert.equal(failures[0].output_mode, "transcript");
    assert.equal(typeof failures[0].output_path, "string");
    assert.doesNotMatch(JSON.stringify(failures[0]), /do not log this prompt/);
  });
});

test("run_subagent records missing final output as a typed terminal failure", async () => {
  await withFakeClient(async (client, { projectDir, failureLogPath }) => {
    const response = await client.callTool({
      name: "run_subagent",
      arguments: {
        cwd: projectDir,
        prompt: "CLEAN_EXIT_NO_FINAL",
        run_kind: "quick_noninteractive",
        output_mode: "final",
      },
    });

    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as {
      run_id: string;
      status: string;
      success: boolean;
      error_class?: string;
      reason_code?: string;
      exit_code: number | null;
      written_output_mode?: string;
    };
    assert.equal(metadata.status, "failed");
    assert.equal(metadata.success, false);
    assert.equal(metadata.exit_code, 0);
    assert.equal(metadata.error_class, "missing_final_output");
    assert.equal(metadata.reason_code, "missing_final_output");
    assert.equal(metadata.written_output_mode, "transcript");

    const failures = await readJsonl<FailureRecord>(failureLogPath);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].tool, "run_subagent");
    assert.equal(failures[0].run_id, metadata.run_id);
    assert.equal(failures[0].failure_class, "missing_final_output");
    assert.equal(failures[0].reason_code, "missing_final_output");
    assert.equal(failures[0].exit_code, 0);
    assert.equal(failures[0].stop_reason, "completed");
    assert.equal(failures[0].output_mode, "final");
  });
});

test("run_subagent classifies Codex usage limits and preserves provider reset metadata", async () => {
  await withFakeClient(async (client, { projectDir, failureLogPath }) => {
    const response = await client.callTool({
      name: "run_subagent",
      arguments: {
        cwd: projectDir,
        prompt: "USAGE_LIMIT_WITH_RESET",
        run_kind: "quick_noninteractive",
        output_mode: "transcript",
      },
    });

    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as {
      reason_code?: string;
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
    };
    assert.equal(metadata.reason_code, "usage_limit_reached");
    assert.equal(metadata.provider_error_type, "usage_limit_reached");
    assert.equal(metadata.provider_status_code, 429);
    assert.equal(metadata.provider_error_message, "The usage limit has been reached");
    assert.equal(metadata.usage_limit_plan_type, "pro");
    assert.equal(metadata.usage_limit_resets_at, 1782491143);
    assert.equal(metadata.usage_limit_resets_in_seconds, 205140);
    assert.equal(metadata.usage_limit_retry_after_seconds, 60);
    assert.equal(metadata.usage_limit_primary_used_percent, 26);
    assert.equal(metadata.usage_limit_secondary_used_percent, 100);
    assert.equal(metadata.usage_limit_primary_reset_after_seconds, 3600);
    assert.equal(metadata.usage_limit_secondary_reset_after_seconds, 205140);

    const failures = await readJsonl<FailureRecord>(failureLogPath);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].tool, "run_subagent");
    assert.equal(failures[0].failure_class, "nonzero_exit");
    assert.equal(failures[0].reason_code, "usage_limit_reached");
    assert.equal(failures[0].provider_error_type, "usage_limit_reached");
    assert.equal(failures[0].provider_status_code, 429);
    assert.equal(failures[0].usage_limit_resets_in_seconds, 205140);
    assert.equal(failures[0].usage_limit_retry_after_seconds, 60);
    assert.equal(failures[0].usage_limit_secondary_used_percent, 100);
  });
});

test("run_subagent timeout failure records include canonical run identity and stop signal", async () => {
  await withFakeClient(
    async (client, { projectDir, failureLogPath }) => {
      const response = await client.callTool({
        name: "run_subagent",
        arguments: {
          cwd: projectDir,
          prompt: "TIMEOUT_RAW_TEXT",
          run_kind: "quick_noninteractive",
          output_mode: "transcript",
        },
      });

      assert.notEqual(response.isError, true);
      const metadata = response.structuredContent as { run_id: string; timed_out: boolean };
      assert.equal(metadata.timed_out, true);
      const failures = await readJsonl<FailureRecord>(failureLogPath);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].tool, "run_subagent");
      assert.equal(failures[0].run_id, metadata.run_id);
      assert.equal(failures[0].task_kind, "run");
      assert.equal(failures[0].failure_class, "timeout");
      assert.equal(failures[0].reason_code, "timeout");
      assert.equal(failures[0].timed_out, true);
      assert.equal(failures[0].requested_timeout_ms, 180);
      assert.equal(failures[0].effective_timeout_ms, 120);
      assert.equal(failures[0].stop_reason, "timeout");
      assert.equal(failures[0].stop_signal, "SIGTERM");
    },
    {
      SUBAGENT007_RUN_SUBAGENT_TIMEOUT_MS: "180",
      SUBAGENT007_MIN_REQUESTED_TIMEOUT_MS: "0",
      SUBAGENT007_TIMEOUT_RESPONSE_HEADROOM_MS: "20",
      SUBAGENT007_TIMEOUT_KILL_GRACE_MS: "20",
      SUBAGENT007_TIMEOUT_FORCE_GRACE_MS: "20",
    },
  );
});

test("auto-promoted run_subagent failures log promotion context without one-shot timeout", async () => {
  await withFakeClient(async (client, { projectDir, failureLogPath }) => {
    const response = await client.callTool({
      name: "run_subagent",
      arguments: {
        cwd: projectDir,
        prompt: "FAIL_EXIT Investigate the HORCs and SAFs.",
        run_kind: "quick_noninteractive",
      },
    });

    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as { run_id: string; success: boolean; promotion_reason_code?: string };
    assert.equal(metadata.success, false);
    assert.equal(metadata.promotion_reason_code, "broad_work");
    const failures = await readJsonl<FailureRecord>(failureLogPath);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].tool, "run_subagent");
    assert.equal(failures[0].run_id, metadata.run_id);
    assert.equal(failures[0].task_kind, "run");
    assert.equal(failures[0].failure_class, "nonzero_exit");
    assert.equal(failures[0].auto_promoted_from, "run_subagent");
    assert.equal(failures[0].promotion_reason_code, "broad_work");
    assert.match(failures[0].promotion_reason ?? "", /broad/);
    assert.equal(failures[0].requested_timeout_ms, null);
    assert.equal(failures[0].resolved_timeout_ms, null);
    assert.equal(failures[0].effective_timeout_ms, null);
    assert.equal(failures[0].stop_reason, "failed");
    assert.equal(failures[0].stop_signal, null);
  });
});

test("run_subagent raw Pi session establishment failures keep the missing-session reason", async () => {
  await withFakeClient(async (client, { projectDir, failureLogPath }) => {
    const response = await client.callTool({
      name: "run_subagent",
      arguments: {
        cwd: projectDir,
        prompt: "NO_SESSION",
        run_kind: "quick_noninteractive",
        continuity: { mode: "fresh" },
      },
    });

    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as { run_id: string; success: boolean; session_established: boolean };
    assert.equal(metadata.success, false);
    assert.equal(metadata.session_established, false);
    const failures = await readJsonl<FailureRecord>(failureLogPath);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].tool, "run_subagent");
    assert.equal(failures[0].run_id, metadata.run_id);
    assert.equal(failures[0].task_kind, "run");
    assert.equal(failures[0].failure_class, "missing_session_id");
    assert.equal(failures[0].reason_code, "missing_session_id");
    assert.equal(failures[0].exit_code, 0);
    assert.equal(failures[0].stop_reason, "completed");
  });
});

test("schedule_run terminal child failures keep the schedule_run tool identity", async () => {
  await withFakeClient(async (client, { projectDir, failureLogPath }) => {
    const response = await client.callTool({
      name: "schedule_run",
      arguments: {
        cwd: projectDir,
        prompt: "FAIL_EXIT",
        wait_ms: 1000,
      },
    });

    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as { run_id: string; success: boolean };
    assert.equal(metadata.success, false);
    const failures = await readJsonl<FailureRecord>(failureLogPath);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].tool, "schedule_run");
    assert.equal(failures[0].run_id, metadata.run_id);
    assert.equal(failures[0].task_kind, "run");
    assert.equal(failures[0].failure_class, "nonzero_exit");
  });
});

test("restart drift failure stays authoritative when the stale owner later times out", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-restart-drift-log-"));
  const projectDir = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const runTasksDir = path.join(stateDir, "run-tasks");
  const inputRequestsDir = path.join(stateDir, "input-requests");
  const configPath = path.join(stateDir, "config.json");
  const failureLogPath = path.join(stateDir, "failures.jsonl");
  const modelHealthPath = path.join(stateDir, "model-health.json");
  const fake = await createFakePiChild();
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ default_model_class: "C" }));

  const sharedEnv = {
    ...process.env,
    SUBAGENT007_CONFIG_PATH: configPath,
    SUBAGENT007_RUN_TASKS_DIR: runTasksDir,
    SUBAGENT007_INPUT_REQUESTS_DIR: inputRequestsDir,
    SUBAGENT007_FAILURE_LOG_PATH: failureLogPath,
    SUBAGENT007_MODEL_HEALTH_PATH: modelHealthPath,
    SUBAGENT007_PI_CHILD_PATH: fake.childPath,
    FAKE_PI_LOG_PATH: fake.logPath,
    SUBAGENT007_RECORD_SOURCE: "test",
    SUBAGENT007_TIMEOUT_RESPONSE_HEADROOM_MS: "20",
    SUBAGENT007_TIMEOUT_KILL_GRACE_MS: "20",
    SUBAGENT007_TIMEOUT_FORCE_GRACE_MS: "20",
  };

  const transportA = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/server.js")],
    env: sharedEnv,
  });
  const clientA = new Client({ name: "subagent007-pi-restart-drift-owner", version: "0.1.0" });

  const transportB = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/server.js")],
    env: sharedEnv,
  });
  const clientB = new Client({ name: "subagent007-pi-restart-drift-reader", version: "0.1.0" });

  try {
    await clientA.connect(transportA);
    const startedResponse = await clientA.callTool({
      name: "start_run",
      arguments: {
        cwd: projectDir,
        prompt: "TIMEOUT_RAW_TEXT",
        continuity: { mode: "fresh" },
        timeout_ms: 1500,
        output_mode: "transcript",
      },
    });
    assert.notEqual(startedResponse.isError, true);
    const started = startedResponse.structuredContent as { run_id: string };

    await clientB.connect(transportB);
    const driftResponse = await clientB.callTool({
      name: "get_run",
      arguments: { run_id: started.run_id },
    });
    assert.notEqual(driftResponse.isError, true);
    const drift = driftResponse.structuredContent as { status: string; error_class?: string; reason_code?: string };
    assert.equal(drift.status, "failed");
    assert.equal(drift.error_class, "restart_drift");
    assert.equal(drift.reason_code, "server_restarted_active_run");

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const failures = await readJsonl<FailureRecord>(failureLogPath);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].tool, "start_run");
    assert.equal(failures[0].run_id, started.run_id);
    assert.equal(failures[0].task_kind, "run");
    assert.equal(failures[0].failure_class, "restart_drift");
    assert.equal(failures[0].reason_code, "server_restarted_active_run");
    assert.equal(failures[0].timed_out, false);
    assert.equal(failures[0].stop_reason, "failed");
    assert.equal(failures[0].stop_signal, null);

    const persisted = JSON.parse(await fs.readFile(path.join(runTasksDir, `${started.run_id}.json`), "utf8")) as {
      status: string;
      error_class?: string;
      reason_code?: string;
    };
    assert.equal(persisted.status, "failed");
    assert.equal(persisted.error_class, "restart_drift");
    assert.equal(persisted.reason_code, "server_restarted_active_run");
  } finally {
    await clientB.close().catch(() => {});
    await clientA.close().catch(() => {});
  }
});

test("failure records include a valid campaign id from environment", async () => {
  await withFakeClient(
    async (client, { projectDir, failureLogPath }) => {
      const response = await client.callTool({
        name: "run_subagent",
        arguments: {
          cwd: projectDir,
          prompt: "FAIL_EXIT",
          run_kind: "quick_noninteractive",
        },
      });

      assert.notEqual(response.isError, true);
      const failures = await readJsonl<FailureRecord>(failureLogPath);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].campaign_id, "campaign.test-1");
    },
    { SUBAGENT007_CAMPAIGN_ID: "campaign.test-1" },
  );
});

test("failure records omit invalid campaign ids from environment", async () => {
  await withFakeClient(
    async (client, { projectDir, failureLogPath }) => {
      const response = await client.callTool({
        name: "run_subagent",
        arguments: {
          cwd: projectDir,
          prompt: "FAIL_EXIT",
          run_kind: "quick_noninteractive",
        },
      });

      assert.notEqual(response.isError, true);
      const failures = await readJsonl<FailureRecord>(failureLogPath);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].campaign_id, undefined);
    },
    { SUBAGENT007_CAMPAIGN_ID: "invalid id with spaces" },
  );
});

test("handler-level validation failures are logged without prompt text", async () => {
  await withFakeClient(async (client, { failureLogPath }) => {
    const response = await client.callTool({
      name: "run_subagent",
      arguments: {
        cwd: "relative-path",
        prompt: "SECRET_PROMPT_SHOULD_NOT_BE_LOGGED",
        run_kind: "quick_noninteractive",
      },
    });

    assert.notEqual(response.isError, true);
    assert.equal((response.structuredContent as { kind?: string }).kind, "preflight_rejected");
    const failures = await readJsonl<FailureRecord>(failureLogPath);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].tool, "run_subagent");
    assert.equal(failures[0].failure_class, "validation_error");
    assert.equal(failures[0].reason_code, "cwd_not_absolute");
    assert.equal(failures[0].calibration_era, "model_class_v1");
    assert.equal(failures[0].cwd, "relative-path");
    assert.equal(failures[0].cwd_class, "relative");
    assert.doesNotMatch(JSON.stringify(failures[0]), /SECRET_PROMPT_SHOULD_NOT_BE_LOGGED/);
  });
});

test("deadline-risk underbudget preflight rejections are not logged as failures", async () => {
  await withFakeClient(async (client, { projectDir, failureLogPath }) => {
    const response = await client.callTool({
      name: "schedule_run",
      arguments: {
        cwd: projectDir,
        prompt: "Fresh-eye delta scan for a repaired implementation. Review only material correctness issues.",
        wait_ms: 0,
        timeout_ms: 90_000,
      },
    });

    assert.notEqual(response.isError, true);
    assert.equal((response.structuredContent as { kind?: string }).kind, "preflight_rejected");
    assert.equal(
      (response.structuredContent as { reason_code?: string }).reason_code,
      "timeout_underbudget_for_deadline_risk",
    );
    assert.equal((response.structuredContent as { child_started?: boolean }).child_started, false);

    await assert.rejects(fs.stat(failureLogPath), /ENOENT/);
  });
});

test("missing child entrypoint preflight failures are logged without spawning a child", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-missing-child-"));
  const missingChildPath = path.join(tmp, "missing-piChild.js");
  await withFakeClient(
    async (client, { projectDir, failureLogPath }) => {
      const response = await client.callTool({
        name: "start_run",
        arguments: {
          cwd: projectDir,
          prompt: "FAST",
        },
      });

      assert.notEqual(response.isError, true);
      assert.equal((response.structuredContent as { kind?: string }).kind, "preflight_rejected");
      assert.equal(
        (response.structuredContent as { reason_code?: string }).reason_code,
        "child_entrypoint_missing",
      );
      assert.equal((response.structuredContent as { child_started?: boolean }).child_started, false);

      const failures = await readJsonl<FailureRecord>(failureLogPath);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].tool, "start_run");
      assert.equal(failures[0].failure_class, "validation_error");
      assert.equal(failures[0].reason_code, "child_entrypoint_missing");
      assert.equal(failures[0].cwd, projectDir);
      assert.doesNotMatch(JSON.stringify(failures[0]), /FAST/);
    },
    { SUBAGENT007_PI_CHILD_PATH: missingChildPath },
  );
});

test("deadline-risk underbudget session preflight rejections are not logged as failures", async () => {
  await withFakeClient(async (client, { projectDir, failureLogPath }) => {
    const response = await client.callTool({
      name: "run_subagent_session",
      arguments: {
        cwd: projectDir,
        prompt: "Requirements\nverification before merging.",
        session_key: "coherent-execution:underbudget-session",
        timeout_ms: 90_000,
      },
    });

    assert.notEqual(response.isError, true);
    assert.equal((response.structuredContent as { kind?: string }).kind, "preflight_rejected");
    assert.equal(
      (response.structuredContent as { reason_code?: string }).reason_code,
      "timeout_underbudget_for_deadline_risk",
    );
    assert.equal((response.structuredContent as { child_started?: boolean }).child_started, false);

    await assert.rejects(fs.stat(failureLogPath), /ENOENT/);
  });
});

test("SDK input-schema rejections happen before failure logging", async () => {
  await withFakeClient(async (client, { projectDir, failureLogPath }) => {
    const response = await client.callTool({
      name: "run_subagent",
      arguments: {
        cwd: projectDir,
      },
    });

    assert.equal(response.isError, true);
    const content = response.content as Array<{ type: string; text?: string }>;
    assert.match(content[0]?.type === "text" ? (content[0].text ?? "") : "", /Input validation error/);
    await assert.rejects(fs.stat(failureLogPath), /ENOENT/);
  });
});

test("run_subagent rejects timeout_ms at the MCP schema boundary", async () => {
  await withFakeClient(async (client, { projectDir, failureLogPath }) => {
    const response = await client.callTool({
      name: "run_subagent",
      arguments: {
        cwd: projectDir,
        prompt: "FAST",
        run_kind: "quick_noninteractive",
        timeout_ms: 1000,
      },
    });

    assert.equal(response.isError, true);
    const content = response.content as Array<{ type: string; text?: string }>;
    assert.match(
      content[0]?.type === "text" ? (content[0].text ?? "") : "",
      /timeout_ms is not supported by run_subagent/,
    );
    await assert.rejects(fs.stat(failureLogPath), /ENOENT/);
  });
});

test("run_subagent_session logs missing Pi session establishment failures", async () => {
  await withFakeClient(async (client, { projectDir, failureLogPath }) => {
    const response = await client.callTool({
      name: "run_subagent_session",
      arguments: {
        cwd: projectDir,
        session_key: "coherent-execution:T000",
        resume_mode: "new",
        prompt: "NO_SESSION",
      },
    });

    assert.notEqual(response.isError, true);
    const failures = await readJsonl<FailureRecord>(failureLogPath);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].tool, "run_subagent_session");
    assert.equal(failures[0].failure_class, "missing_session_id");
    assert.equal(failures[0].reason_code, "missing_session_id");
    assert.equal(failures[0].cwd, await fs.realpath(projectDir));
    assert.equal(failures[0].cwd_class, "temp");
    assert.equal(failures[0].session_key, "coherent-execution:T000");
    assert.equal(typeof failures[0].session_dir, "string");
  });
});

test("run_subagent_session logs non-ready required packets as packet failures", async () => {
  await withFakeClient(async (client, { projectDir, failureLogPath }) => {
    const response = await client.callTool({
      name: "run_subagent_session",
      arguments: {
        cwd: projectDir,
        session_key: "coherent-execution:T000-packet-not-ready",
        resume_mode: "new",
        prompt: "PACKET_INCONCLUSIVE",
        packet_policy: "required",
      },
    });

    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as { run_id: string; success: boolean; packet_parse_status: string };
    assert.equal(metadata.success, false);
    assert.equal(metadata.packet_parse_status, "valid");
    const failures = await readJsonl<FailureRecord>(failureLogPath);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].tool, "run_subagent_session");
    assert.equal(failures[0].failure_class, "packet_failed");
    assert.equal(failures[0].reason_code, "packet_required_not_ready");
    assert.equal(failures[0].run_id, metadata.run_id);
    assert.equal(failures[0].task_kind, "session");
  });
});

test("start_session_run logs packet failures with async session caller context", async () => {
  await withFakeClient(async (client, { projectDir, failureLogPath }) => {
    const response = await client.callTool({
      name: "start_session_run",
      arguments: {
        cwd: projectDir,
        session_key: "coherent-execution:T000-start-session-packet-not-ready",
        resume_mode: "new",
        prompt: "PACKET_INCONCLUSIVE",
        packet_policy: "required",
      },
    });

    assert.notEqual(response.isError, true);
    const started = response.structuredContent as { run_id: string; status: string };
    assert.equal(started.status, "working");
    await waitForRunStatus(client, started.run_id, "failed");

    const failures = await readJsonl<FailureRecord>(failureLogPath);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].tool, "start_session_run");
    assert.equal(failures[0].failure_class, "packet_failed");
    assert.equal(failures[0].reason_code, "packet_required_not_ready");
    assert.equal(failures[0].run_id, started.run_id);
    assert.equal(failures[0].task_kind, "session");
  });
});

test("cancelled start_run tasks do not append unknown failure records", async () => {
  await withFakeClient(
    async (client, { projectDir, failureLogPath }) => {
      const startedResponse = await client.callTool({
        name: "start_run",
        arguments: {
          cwd: projectDir,
          prompt: "CANCEL_WAIT",
          timeout_ms: 6000,
        },
      });
      assert.notEqual(startedResponse.isError, true);
      const started = startedResponse.structuredContent as { run_id: string };

      const cancelResponse = await client.callTool({
        name: "cancel_run",
        arguments: { run_id: started.run_id },
      });
      assert.notEqual(cancelResponse.isError, true);

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await client.callTool({
          name: "get_run",
          arguments: { run_id: started.run_id },
        });
        const view = response.structuredContent as { status: string };
        if (view.status === "cancelled") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      await assert.rejects(fs.stat(failureLogPath), /ENOENT/);
    },
    {
      SUBAGENT007_TIMEOUT_KILL_GRACE_MS: "10",
      SUBAGENT007_TIMEOUT_FORCE_GRACE_MS: "10",
    },
  );
});

test("truly silent cancelled start_run tasks append a targeted pre-output record", async () => {
  await withFakeClient(
    async (client, { projectDir, failureLogPath }) => {
      const startedResponse = await client.callTool({
        name: "start_run",
        arguments: {
          cwd: projectDir,
          prompt: "CANCEL_WAIT OMIT_PROMPT_SUBMITTED SECRET_CANCEL_PROMPT",
          timeout_ms: 6000,
        },
      });
      assert.notEqual(startedResponse.isError, true);
      const started = startedResponse.structuredContent as { run_id: string };

      const heartbeatDeadline = Date.now() + 2000;
      type HeartbeatRunView = {
        status: string;
        active_phase?: string;
        heartbeat_count?: number;
        first_public_output_at?: string;
      };
      let heartbeatView: HeartbeatRunView | undefined;
      while (Date.now() < heartbeatDeadline) {
        const response = await client.callTool({
          name: "get_run",
          arguments: { run_id: started.run_id },
        });
        assert.notEqual(response.isError, true);
        heartbeatView = response.structuredContent as HeartbeatRunView;
        if ((heartbeatView?.heartbeat_count ?? 0) > 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(heartbeatView);
      assert.equal(heartbeatView.status, "working");
      assert.equal(heartbeatView.active_phase, "running_silent");
      assert.equal(heartbeatView.first_public_output_at, undefined);

      const cancelResponse = await client.callTool({
        name: "cancel_run",
        arguments: { run_id: started.run_id },
      });
      assert.notEqual(cancelResponse.isError, true);

      await waitForRunStatus(client, started.run_id, "cancelled");

      const failures = await readJsonl<FailureRecord>(failureLogPath);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].tool, "start_run");
      assert.equal(failures[0].run_id, started.run_id);
      assert.equal(failures[0].failure_class, "cancelled");
      assert.equal(failures[0].reason_code, "cancelled_before_first_output");
      assert.equal(failures[0].stop_reason, "cancelled");
      assert.equal(failures[0].success, false);
      assert.doesNotMatch(JSON.stringify(failures[0]), /SECRET_CANCEL_PROMPT/);
    },
    {
      SUBAGENT007_HEARTBEAT_INTERVAL_MS: "25",
      SUBAGENT007_TIMEOUT_KILL_GRACE_MS: "10",
      SUBAGENT007_TIMEOUT_FORCE_GRACE_MS: "10",
    },
  );
});

test("cancelled start_run tasks after prompt submission do not append pre-output records", async () => {
  await withFakeClient(
    async (client, { projectDir, failureLogPath }) => {
      const startedResponse = await client.callTool({
        name: "start_run",
        arguments: {
          cwd: projectDir,
          prompt: "CANCEL_WAIT SECRET_CANCEL_PROMPT",
          timeout_ms: 6000,
        },
      });
      assert.notEqual(startedResponse.isError, true);
      const started = startedResponse.structuredContent as { run_id: string };

      const promptDeadline = Date.now() + 2000;
      type PromptRunView = {
        status: string;
        first_public_output_at?: string;
        recent_events?: Array<{ kind: string; event?: string }>;
      };
      let promptView: PromptRunView | undefined;
      while (Date.now() < promptDeadline) {
        const response = await client.callTool({
          name: "get_run",
          arguments: { run_id: started.run_id },
        });
        assert.notEqual(response.isError, true);
        promptView = response.structuredContent as PromptRunView;
        if ((promptView.recent_events ?? []).some((event) =>
          event.kind === "child" && event.event === "child_prompt_submitted"
        )) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(promptView);
      assert.equal(promptView.first_public_output_at, undefined);

      const cancelResponse = await client.callTool({
        name: "cancel_run",
        arguments: { run_id: started.run_id },
      });
      assert.notEqual(cancelResponse.isError, true);

      await waitForRunStatus(client, started.run_id, "cancelled");
      await assert.rejects(fs.stat(failureLogPath), /ENOENT/);
    },
    {
      SUBAGENT007_HEARTBEAT_INTERVAL_MS: "25",
      SUBAGENT007_TIMEOUT_KILL_GRACE_MS: "10",
      SUBAGENT007_TIMEOUT_FORCE_GRACE_MS: "10",
    },
  );
});

test("cancelled start_run tasks after raw child output do not append pre-output records", async () => {
  await withFakeClient(
    async (client, { projectDir, failureLogPath }) => {
      const startedResponse = await client.callTool({
        name: "start_run",
        arguments: {
          cwd: projectDir,
          prompt: "TIMEOUT_RAW_TEXT",
          timeout_ms: 6000,
        },
      });
      assert.notEqual(startedResponse.isError, true);
      const started = startedResponse.structuredContent as { run_id: string };

      const outputDeadline = Date.now() + 2000;
      let activeView: { first_public_output_at?: string; heartbeat_count?: number } | undefined;
      while (Date.now() < outputDeadline) {
        const response = await client.callTool({
          name: "get_run",
          arguments: { run_id: started.run_id },
        });
        assert.notEqual(response.isError, true);
        activeView = response.structuredContent as { first_public_output_at?: string; heartbeat_count?: number };
        if (activeView.first_public_output_at && (activeView.heartbeat_count ?? 0) > 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(typeof activeView?.first_public_output_at, "string");
      assert.equal((activeView?.heartbeat_count ?? 0) > 0, true);

      const cancelResponse = await client.callTool({
        name: "cancel_run",
        arguments: { run_id: started.run_id },
      });
      assert.notEqual(cancelResponse.isError, true);

      await waitForRunStatus(client, started.run_id, "cancelled");

      await assert.rejects(fs.stat(failureLogPath), /ENOENT/);
    },
    {
      SUBAGENT007_HEARTBEAT_INTERVAL_MS: "25",
      SUBAGENT007_TIMEOUT_KILL_GRACE_MS: "10",
      SUBAGENT007_TIMEOUT_FORCE_GRACE_MS: "10",
    },
  );
});

test("run-scoped input failures log resolved run context", async () => {
  await withFakeClient(
    async (client, { projectDir, failureLogPath }) => {
      const startedResponse = await client.callTool({
        name: "start_run",
        arguments: {
          cwd: projectDir,
          prompt: "REQUEST_INPUT_WAIT",
          timeout_ms: 6000,
        },
      });
      assert.notEqual(startedResponse.isError, true);
      const started = startedResponse.structuredContent as {
        run_id: string;
        input_requests: Array<{ request_id: string; status: string }>;
      };
      let requestId = started.input_requests.find((request) => request.status === "pending")?.request_id;
      const deadline = Date.now() + 3000;
      while (!requestId && Date.now() < deadline) {
        const view = await client.callTool({ name: "get_run", arguments: { run_id: started.run_id } });
        const inputRequests = (view.structuredContent as {
          input_requests?: Array<{ request_id: string; status: string }>;
        }).input_requests ?? [];
        requestId = inputRequests.find((request) => request.status === "pending")?.request_id;
        if (!requestId) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      assert.ok(requestId);

      const firstAnswer = await client.callTool({
        name: "answer_run_input",
        arguments: {
          run_id: started.run_id,
          request_id: requestId,
          response_id: "failure-log-first-001",
          answer: "FIRST_SECRET_ANSWER",
        },
      });
      assert.notEqual(firstAnswer.isError, true);

      const duplicateAnswer = await client.callTool({
        name: "answer_run_input",
        arguments: {
          run_id: started.run_id,
          request_id: requestId,
          response_id: "failure-log-second-001",
          answer: "SECOND_SECRET_ANSWER",
        },
      });
      assert.notEqual(duplicateAnswer.isError, true);
      assert.equal((duplicateAnswer.structuredContent as { kind?: string }).kind, "operation_rejected");
      assert.equal(
        (duplicateAnswer.structuredContent as { reason_code?: string }).reason_code,
        "input_request_already_answered",
      );

      const failures = await readJsonl<FailureRecord>(failureLogPath);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].tool, "answer_run_input");
      assert.equal(failures[0].failure_class, "validation_error");
      assert.equal(failures[0].reason_code, "input_request_already_answered");
      assert.equal(failures[0].run_id, started.run_id);
      assert.equal(failures[0].task_kind, "run");
      assert.equal(failures[0].cwd, projectDir);
      assert.equal(failures[0].cwd_class, "temp");
      assert.doesNotMatch(JSON.stringify(failures[0]), /FIRST_SECRET_ANSWER|SECOND_SECRET_ANSWER/);

      await client.callTool({
        name: "cancel_run",
        arguments: { run_id: started.run_id },
      });
    },
    {
      SUBAGENT007_TIMEOUT_KILL_GRACE_MS: "10",
      SUBAGENT007_TIMEOUT_FORCE_GRACE_MS: "10",
    },
  );
});

test("unknown run-scoped tools log run_not_found without cwd", async () => {
  await withFakeClient(async (client, { failureLogPath }) => {
    const response = await client.callTool({
      name: "get_run",
      arguments: { run_id: "missing-run" },
    });
    assert.notEqual(response.isError, true);
    assert.equal((response.structuredContent as { kind?: string }).kind, "operation_rejected");
    assert.equal((response.structuredContent as { reason_code?: string }).reason_code, "run_not_found");

    const failures = await readJsonl<FailureRecord>(failureLogPath);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].tool, "get_run");
    assert.equal(failures[0].failure_class, "validation_error");
    assert.equal(failures[0].reason_code, "run_not_found");
    assert.equal(failures[0].run_id, "missing-run");
    assert.equal(failures[0].cwd, undefined);
    assert.equal(failures[0].cwd_class, "missing");
  });
});

test("failure logging can be disabled", async () => {
  await withFakeClient(
    async (client, { projectDir, failureLogPath }) => {
      await client.callTool({
        name: "run_subagent",
        arguments: {
          cwd: projectDir,
          prompt: "FAIL_EXIT",
          run_kind: "quick_noninteractive",
        },
      });
      await assert.rejects(fs.stat(failureLogPath), /ENOENT/);
    },
    { SUBAGENT007_FAILURE_LOG: "off" },
  );
});
