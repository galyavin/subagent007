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
  timestamp: string;
  server_version: string;
  record_source: "production" | "test" | "unknown";
  tool: string;
  failure_class: string;
  reason_code: string;
  cwd_class: string;
  cwd?: string;
  output_path?: string;
  session_key?: string;
  session_dir?: string;
  success?: boolean;
  exit_code?: number | null;
  partial_output_available?: boolean;
  resume_possible?: boolean;
  resolved_timeout_ms?: number | null;
  model?: string;
  thinking_level?: string;
  output_mode?: string;
};

test("failure reason mapping classifies tool profile validation precisely", () => {
  assert.equal(
    failureReasonCodeForError(new ValidationError("tool_profile must be one of: inspect, shell, workspace_write")),
    "invalid_tool_profile",
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
    JSON.stringify({ default_model: "openai-codex/gpt-5.4-mini", default_thinking_level: "medium" }),
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/server.js")],
    env: {
      ...process.env,
      ...extraEnv,
      SUBAGENT007_CONFIG_PATH: configPath,
      SUBAGENT007_FAILURE_LOG_PATH: failureLogPath,
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
        output_mode: "transcript",
      },
    });

    assert.notEqual(response.isError, true);
    const failures = await readJsonl<FailureRecord>(failureLogPath);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].tool, "run_subagent");
    assert.equal(failures[0].schema_version, 2);
    assert.equal(failures[0].server_version, "0.1.0");
    assert.equal(failures[0].record_source, "test");
    assert.equal(failures[0].failure_class, "nonzero_exit");
    assert.equal(failures[0].reason_code, "nonzero_exit");
    assert.equal(failures[0].cwd, projectDir);
    assert.equal(failures[0].cwd_class, "temp");
    assert.equal(failures[0].exit_code, 42);
    assert.equal(failures[0].success, false);
    assert.equal(failures[0].partial_output_available, false);
    assert.equal(failures[0].resume_possible, false);
    assert.equal(failures[0].resolved_timeout_ms, 110000);
    assert.equal(failures[0].model, "openai-codex/gpt-5.4-mini");
    assert.equal(failures[0].thinking_level, "medium");
    assert.equal(failures[0].output_mode, "transcript");
    assert.equal(typeof failures[0].output_path, "string");
    assert.doesNotMatch(JSON.stringify(failures[0]), /do not log this prompt/);
  });
});

test("handler-level validation failures are logged without prompt text", async () => {
  await withFakeClient(async (client, { failureLogPath }) => {
    const response = await client.callTool({
      name: "run_subagent",
      arguments: {
        cwd: "relative-path",
        prompt: "SECRET_PROMPT_SHOULD_NOT_BE_LOGGED",
      },
    });

    assert.equal(response.isError, true);
    const failures = await readJsonl<FailureRecord>(failureLogPath);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].tool, "run_subagent");
    assert.equal(failures[0].failure_class, "validation_error");
    assert.equal(failures[0].reason_code, "cwd_not_absolute");
    assert.equal(failures[0].cwd, "relative-path");
    assert.equal(failures[0].cwd_class, "relative");
    assert.doesNotMatch(JSON.stringify(failures[0]), /SECRET_PROMPT_SHOULD_NOT_BE_LOGGED/);
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

test("failure logging can be disabled", async () => {
  await withFakeClient(
    async (client, { projectDir, failureLogPath }) => {
      await client.callTool({
        name: "run_subagent",
        arguments: {
          cwd: projectDir,
          prompt: "FAIL_EXIT",
        },
      });
      await assert.rejects(fs.stat(failureLogPath), /ENOENT/);
    },
    { SUBAGENT007_FAILURE_LOG: "off" },
  );
});
