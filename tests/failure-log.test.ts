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
  model?: string;
  calibration_era?: string;
  thinking_level?: string;
  output_mode?: string;
};

const TIMESTAMPED_EVENT_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{9}Z-[0-9a-f]{12}$/;

test("failure reason mapping classifies tool profile validation precisely", () => {
  assert.equal(
    failureReasonCodeForError(new ValidationError("tool_profile must be one of: all, inspect, web_search, shell, workspace_write")),
    "invalid_tool_profile",
  );
});

test("failure reason mapping classifies timeout validation precisely", () => {
  assert.equal(
    failureReasonCodeForError(new ValidationError("timeout_ms must be a positive integer when provided")),
    "invalid_timeout_ms",
  );
  assert.equal(
    failureReasonCodeForError(new ValidationError("timeout_ms must be at least 7001 ms with the configured response headroom and kill grace")),
    "invalid_timeout_ms",
  );
  assert.equal(
    failureReasonCodeForError(new ValidationError("timeout_ms under budget for deadline-risk workload; minimum_timeout_ms=600000")),
    "timeout_underbudget_for_deadline_risk",
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
      ...extraEnv,
      SUBAGENT007_CONFIG_PATH: configPath,
      SUBAGENT007_FAILURE_LOG_PATH: failureLogPath,
      SUBAGENT007_MODEL_HEALTH_PATH: path.join(stateDir, "model-health.json"),
      SUBAGENT007_PI_CHILD_PATH: fake.childPath,
      FAKE_PI_LOG_PATH: fake.logPath,
      SUBAGENT007_RECORD_SOURCE: "test",
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
    assert.equal(failures[0].model, "openai-codex/gpt-5.4-mini");
    assert.equal(failures[0].thinking_level, "high");
    assert.equal(failures[0].output_mode, "transcript");
    assert.equal(typeof failures[0].output_path, "string");
    assert.doesNotMatch(JSON.stringify(failures[0]), /do not log this prompt/);
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

test("deadline-risk underbudget preflight failures are logged with specific reason", async () => {
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

    const failures = await readJsonl<FailureRecord>(failureLogPath);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].tool, "schedule_run");
    assert.equal(failures[0].failure_class, "validation_error");
    assert.equal(failures[0].reason_code, "timeout_underbudget_for_deadline_risk");
    assert.equal(failures[0].cwd, projectDir);
    assert.doesNotMatch(JSON.stringify(failures[0]), /Fresh-eye delta scan/);
  });
});

test("deadline-risk underbudget session preflight failures keep session tool identity", async () => {
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

    const failures = await readJsonl<FailureRecord>(failureLogPath);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].tool, "run_subagent_session");
    assert.equal(failures[0].failure_class, "validation_error");
    assert.equal(failures[0].reason_code, "timeout_underbudget_for_deadline_risk");
    assert.equal(failures[0].cwd, projectDir);
    assert.doesNotMatch(JSON.stringify(failures[0]), /Requirements/);
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
    const metadata = response.structuredContent as { success: boolean; packet_parse_status: string };
    assert.equal(metadata.success, false);
    assert.equal(metadata.packet_parse_status, "valid");
    const failures = await readJsonl<FailureRecord>(failureLogPath);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].tool, "run_subagent_session");
    assert.equal(failures[0].failure_class, "packet_failed");
    assert.equal(failures[0].reason_code, "packet_required_invalid");
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

test("run-scoped input failures log resolved run context", async () => {
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
      const started = startedResponse.structuredContent as {
        run_id: string;
        input_requests_dir: string;
      };
      const requestId = `${started.run_id}-abcdef123456`;
      await fs.mkdir(started.input_requests_dir, { recursive: true });
      await fs.writeFile(
        path.join(started.input_requests_dir, `${requestId}.json`),
        `${JSON.stringify({
          schema_version: 1,
          request_id: requestId,
          run_id: started.run_id,
          session_id: null,
          created_at: new Date().toISOString(),
          question: "Answer me",
          options: [],
          freeform: true,
        })}\n`,
      );

      const firstAnswer = await client.callTool({
        name: "answer_run_input",
        arguments: {
          run_id: started.run_id,
          request_id: requestId,
          answer: "first",
        },
      });
      assert.notEqual(firstAnswer.isError, true);

      const duplicateAnswer = await client.callTool({
        name: "answer_run_input",
        arguments: {
          run_id: started.run_id,
          request_id: requestId,
          answer: "second",
        },
      });
      assert.equal(duplicateAnswer.isError, true);

      const failures = await readJsonl<FailureRecord>(failureLogPath);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].tool, "answer_run_input");
      assert.equal(failures[0].failure_class, "validation_error");
      assert.equal(failures[0].reason_code, "input_request_already_answered");
      assert.equal(failures[0].run_id, started.run_id);
      assert.equal(failures[0].task_kind, "run");
      assert.equal(failures[0].cwd, projectDir);
      assert.equal(failures[0].cwd_class, "temp");
      assert.doesNotMatch(JSON.stringify(failures[0]), /first|second/);

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
    assert.equal(response.isError, true);

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
