import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createFakePiChild } from "./helpers/fakePiChild.js";
import { readJsonl } from "./helpers/testUtils.js";

type FailureRecord = {
  tool: string;
  failure_class: string;
  reason_code: string;
  run_id?: string;
  child_started?: boolean;
  stop_signal?: string | null;
};

type RunView = {
  run_id: string;
  status: string;
  child_started?: boolean;
  kind?: string;
  error_class?: string;
  reason_code?: string;
  first_public_output_at?: string;
  recent_events?: Array<{ kind: string; event?: string }>;
};

async function withFailureLoggingClient<T>(
  run: (client: Client, dirs: {
    projectDir: string;
    failureLogPath: string;
    fakeLogPath: string;
  }) => Promise<T>,
  extraEnv: Record<string, string> = {},
): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-saf-batch-"));
  const projectDir = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const configPath = path.join(stateDir, "config.json");
  const failureLogPath = path.join(stateDir, "failures.jsonl");
  const fake = await createFakePiChild();
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ default_model_class: "C" }), "utf8");

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
  const client = new Client({ name: "subagent007-pi-saf-batch-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    return await run(client, { projectDir, failureLogPath, fakeLogPath: fake.logPath });
  } finally {
    await client.close();
  }
}

async function waitForRun(
  client: Client,
  runId: string,
  predicate: (view: RunView) => boolean,
): Promise<RunView> {
  const deadline = Date.now() + 2000;
  let last: RunView | undefined;
  while (Date.now() < deadline) {
    const response = await client.callTool({
      name: "get_run",
      arguments: { run_id: runId },
    });
    assert.notEqual(response.isError, true);
    last = response.structuredContent as RunView;
    if (predicate(last)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for run ${runId}; last status was ${last?.status ?? "unknown"}`);
}

test("start_run rejects a missing configured child entrypoint before spawning", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-missing-child-"));
  const missingChildPath = path.join(tmp, "missing-pi-child.cjs");

  await withFailureLoggingClient(
    async (client, { projectDir, failureLogPath, fakeLogPath }) => {
      const response = await client.callTool({
        name: "start_run",
        arguments: {
          cwd: projectDir,
          prompt: "FAST",
        },
      });

      assert.notEqual(response.isError, true);
      const result = response.structuredContent as RunView;
      assert.equal(result.kind, "preflight_rejected");
      assert.equal(result.child_started, false);
      assert.equal(result.error_class, "validation_error");
      assert.notEqual(result.reason_code, "nonzero_exit");

      await assert.rejects(fs.stat(fakeLogPath), /ENOENT/);
      const failures = await readJsonl<FailureRecord>(failureLogPath);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].tool, "start_run");
      assert.equal(failures[0].failure_class, "validation_error");
      assert.notEqual(failures[0].reason_code, "nonzero_exit");
    },
    { SUBAGENT007_PI_CHILD_PATH: missingChildPath },
  );
});

test("start_run logs Codex usage limits with the specific reason code", async () => {
  await withFailureLoggingClient(async (client, { projectDir, failureLogPath }) => {
    const response = await client.callTool({
      name: "start_run",
      arguments: {
        cwd: projectDir,
        prompt: "USAGE_LIMIT_REACHED",
        output_mode: "transcript",
      },
    });

    assert.notEqual(response.isError, true);
    const started = response.structuredContent as { run_id: string };
    const terminal = await waitForRun(client, started.run_id, (view) => view.status === "failed");
    assert.equal(terminal.error_class, "nonzero_exit");
    assert.equal(terminal.reason_code, "usage_limit_reached");

    const failures = await readJsonl<FailureRecord>(failureLogPath);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].tool, "start_run");
    assert.equal(failures[0].failure_class, "nonzero_exit");
    assert.equal(failures[0].reason_code, "usage_limit_reached");
  });
});

test("start_run logs signal-terminated children without unknown-error collapse", async () => {
  await withFailureLoggingClient(async (client, { projectDir, failureLogPath }) => {
    const response = await client.callTool({
      name: "start_run",
      arguments: {
        cwd: projectDir,
        prompt: "SIGNAL_TERM",
      },
    });

    assert.notEqual(response.isError, true);
    const started = response.structuredContent as { run_id: string };
    const terminal = await waitForRun(client, started.run_id, (view) => view.status === "failed");
    assert.equal(terminal.error_class, "signal_terminated");
    assert.equal(terminal.reason_code, "process_signal_terminated");

    const failures = await readJsonl<FailureRecord>(failureLogPath);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].tool, "start_run");
    assert.equal(failures[0].failure_class, "signal_terminated");
    assert.equal(failures[0].reason_code, "process_signal_terminated");
    assert.equal(failures[0].stop_signal, "SIGTERM");
  });
});

test("cancelled runs after child session establishment do not append cancelled-before-first-output failures", async () => {
  await withFailureLoggingClient(
    async (client, { projectDir, failureLogPath }) => {
      const startedResponse = await client.callTool({
        name: "start_run",
        arguments: {
          cwd: projectDir,
          prompt: "CANCEL_WAIT EMIT_EPHEMERAL_SESSION_EVENT SECRET_CANCEL_PROMPT",
          timeout_ms: 6000,
        },
      });
      assert.notEqual(startedResponse.isError, true);
      const started = startedResponse.structuredContent as { run_id: string };

      const active = await waitForRun(client, started.run_id, (view) =>
        view.status === "working" &&
        view.first_public_output_at === undefined &&
        (view.recent_events ?? []).some((event) =>
          event.kind === "child" && event.event === "child_session_established"
        )
      );
      assert.equal(active.first_public_output_at, undefined);

      const cancelResponse = await client.callTool({
        name: "cancel_run",
        arguments: { run_id: started.run_id },
      });
      assert.notEqual(cancelResponse.isError, true);

      await waitForRun(client, started.run_id, (view) => view.status === "cancelled");
      let failures: FailureRecord[] = [];
      try {
        failures = await readJsonl<FailureRecord>(failureLogPath);
      } catch (error) {
        assert.match(String(error), /ENOENT/);
      }
      assert.deepEqual(failures, []);
    },
    {
      SUBAGENT007_HEARTBEAT_INTERVAL_MS: "25",
      SUBAGENT007_TIMEOUT_KILL_GRACE_MS: "10",
      SUBAGENT007_TIMEOUT_FORCE_GRACE_MS: "10",
    },
  );
});

test("cancelled runs after prompt submission do not append cancelled-before-first-output failures", async () => {
  await withFailureLoggingClient(
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

      const active = await waitForRun(client, started.run_id, (view) =>
        view.status === "working" &&
        view.first_public_output_at === undefined &&
        (view.recent_events ?? []).some((event) =>
          event.kind === "child" && event.event === "child_prompt_submitted"
        )
      );
      assert.equal(active.first_public_output_at, undefined);

      const cancelResponse = await client.callTool({
        name: "cancel_run",
        arguments: { run_id: started.run_id },
      });
      assert.notEqual(cancelResponse.isError, true);

      await waitForRun(client, started.run_id, (view) => view.status === "cancelled");
      let failures: FailureRecord[] = [];
      try {
        failures = await readJsonl<FailureRecord>(failureLogPath);
      } catch (error) {
        assert.match(String(error), /ENOENT/);
      }
      assert.deepEqual(failures, []);
    },
    {
      SUBAGENT007_HEARTBEAT_INTERVAL_MS: "25",
      SUBAGENT007_TIMEOUT_KILL_GRACE_MS: "10",
      SUBAGENT007_TIMEOUT_FORCE_GRACE_MS: "10",
    },
  );
});
