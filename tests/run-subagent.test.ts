import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { listInputRequests } from "../src/inputMailbox.js";
import { extractSubagentSessionId, runSubagent } from "../src/runSubagent.js";
import { preparePublicTranscriptFromProcessOutput } from "../src/transcript.js";
import { createFakePiChild } from "./helpers/fakePiChild.js";
import { readJsonl, withEnv } from "./helpers/testUtils.js";

type RunSubagentMetadata = {
  run_id: string;
  status: "working" | "input_required" | "completed" | "failed" | "cancelled";
  output_path: string;
  success: boolean;
  exit_code: number | null;
  timed_out: boolean;
  session_id: string | null;
  session_established: boolean;
  input_requests_dir: string;
  written_output_mode: "final" | "transcript";
};

async function connectFakeClient<T>(
  run: (client: Client, dirs: { projectDir: string; configPath: string; fakeLogPath: string }) => Promise<T>,
): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-mcp-"));
  const projectDir = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const configPath = path.join(stateDir, "config.json");
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
      SUBAGENT007_CONFIG_PATH: configPath,
      SUBAGENT007_PI_CHILD_PATH: fake.childPath,
      FAKE_PI_LOG_PATH: fake.logPath,
      SUBAGENT007_FAILURE_LOG: "off",
      SUBAGENT007_RECORD_SOURCE: "test",
    },
  });
  const client = new Client({ name: "subagent007-pi-runner-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    return await run(client, { projectDir, configPath, fakeLogPath: fake.logPath });
  } finally {
    await client.close();
  }
}

async function waitForTerminalRun(client: Client, runId: string): Promise<RunSubagentMetadata> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const response = await client.callTool({
      name: "get_run",
      arguments: { run_id: runId },
    });
    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as RunSubagentMetadata;
    if (metadata.status === "completed" || metadata.status === "failed" || metadata.status === "cancelled") {
      return metadata;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for terminal run ${runId}`);
}

test("extracts only Subagent007 Pi session events from child output", () => {
  assert.equal(
    extractSubagentSessionId(
      [
        "assistant text {\"type\":\"subagent007.session\",\"session_id\":\"wrong\"}",
        JSON.stringify({ type: "subagent007.session", session_id: "/tmp/pi-session.jsonl" }),
      ].join("\n"),
    ),
    "/tmp/pi-session.jsonl",
  );
  assert.equal(extractSubagentSessionId(JSON.stringify({ type: "turn.started", session_id: "wrong" })), null);
});

test("runSubagent is ephemeral by default and invokes the Pi child request-file contract", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-run-"));
  const projectDir = path.join(tmp, "project");
  const runsDir = path.join(tmp, "runs");
  const fake = await createFakePiChild();
  await fs.mkdir(projectDir, { recursive: true });

  await withEnv(
    {
      SUBAGENT007_PI_CHILD_PATH: fake.childPath,
      FAKE_PI_LOG_PATH: fake.logPath,
      SUBAGENT007_FAILURE_LOG: "off",
    },
    async () => {
      const result = await runSubagent(
        {
          cwd: projectDir,
          prompt: "FAST",
          model: "openai-codex/gpt-5.4-mini",
          thinking_level: "medium",
          skill_name: "pda-lite",
        },
        { runsDir },
      );

      assert.equal(result.success, true);
      assert.equal(result.session_id, null);
      assert.equal(result.session_established, false);
      assert.equal(path.dirname(result.output_path), runsDir);
      assert.equal(await fs.readFile(result.output_path, "utf8"), "FAST FINAL");

      const logs = await readJsonl<{ request: Record<string, unknown> }>(fake.logPath);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].request.sessionMode, "ephemeral");
      assert.equal(logs[0].request.prompt, "FAST");
      assert.equal(logs[0].request.skill, "pda-lite");
      assert.equal(logs[0].request.cwd, projectDir);
      assert.equal(logs[0].request.toolProfile, "inspect");
    },
  );
});

test("runSubagent accepts skill_name and passes a normalized skill to the Pi child", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-skill-name-"));
  const projectDir = path.join(tmp, "project");
  const runsDir = path.join(tmp, "runs");
  const fake = await createFakePiChild();
  await fs.mkdir(projectDir, { recursive: true });

  await withEnv(
    {
      SUBAGENT007_PI_CHILD_PATH: fake.childPath,
      FAKE_PI_LOG_PATH: fake.logPath,
      SUBAGENT007_FAILURE_LOG: "off",
    },
    async () => {
      const result = await runSubagent(
        {
          cwd: projectDir,
          prompt: "FAST",
          model: "openai-codex/gpt-5.4-mini",
          thinking_level: "medium",
          skill_name: "tension-hunter",
        },
        { runsDir },
      );

      assert.equal(result.success, true);
      assert.equal(result.requested_skill, "tension-hunter");

      const logs = await readJsonl<{ request: Record<string, unknown> }>(fake.logPath);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].request.skill, "tension-hunter");
    },
  );
});

test("runSubagent passes explicit workspace write profile to the Pi child", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-tool-profile-"));
  const projectDir = path.join(tmp, "project");
  const runsDir = path.join(tmp, "runs");
  const fake = await createFakePiChild();
  await fs.mkdir(projectDir, { recursive: true });

  await withEnv(
    {
      SUBAGENT007_PI_CHILD_PATH: fake.childPath,
      FAKE_PI_LOG_PATH: fake.logPath,
      SUBAGENT007_FAILURE_LOG: "off",
    },
    async () => {
      const result = await runSubagent(
        {
          cwd: projectDir,
          prompt: "FAST",
          model: "openai-codex/gpt-5.4-mini",
          thinking_level: "medium",
          tool_profile: "workspace_write",
        },
        { runsDir },
      );

      assert.equal(result.success, true);
      assert.equal(result.resolved_tool_profile, "workspace_write");

      const logs = await readJsonl<{ request: Record<string, unknown> }>(fake.logPath);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].request.toolProfile, "workspace_write");
    },
  );
});

test("runSubagent creates and resumes raw Pi session files", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-session-"));
  const projectDir = path.join(tmp, "project");
  const runsDir = path.join(tmp, "runs");
  const fake = await createFakePiChild();
  await fs.mkdir(projectDir, { recursive: true });

  await withEnv(
    {
      SUBAGENT007_PI_CHILD_PATH: fake.childPath,
      FAKE_PI_LOG_PATH: fake.logPath,
      SUBAGENT007_FAILURE_LOG: "off",
      SUBAGENT007_PI_RAW_SESSIONS_DIR: path.join(tmp, "raw-pi-sessions"),
    },
    async () => {
      const created = await runSubagent(
        {
          cwd: projectDir,
          prompt: "FAST",
          model: "openai-codex/gpt-5.4-mini",
          thinking_level: "medium",
          continuity: { mode: "fresh" },
        },
        { runsDir },
      );
      assert.equal(created.success, true);
      assert.equal(created.session_established, true);
      assert.match(created.session_id ?? "", /fake-pi-session\.jsonl$/);

      const resumed = await runSubagent(
        {
          cwd: projectDir,
          prompt: "FAST",
          model: "openai-codex/gpt-5.4-mini",
          thinking_level: "medium",
          continuity: { mode: "resume", session_id: created.session_id! },
        },
        { runsDir },
      );
      assert.equal(resumed.success, true);
      assert.equal(resumed.session_id, created.session_id);

      const logs = await readJsonl<{ request: Record<string, unknown> }>(fake.logPath);
      assert.equal(logs[0].request.sessionMode, "fresh");
      assert.equal(logs[1].request.sessionMode, "resume");
      assert.equal(logs[1].request.sessionFile, created.session_id);
    },
  );
});

test("runSubagent rejects missing resume session files before invoking Pi child", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-missing-resume-"));
  const projectDir = path.join(tmp, "project");
  const runsDir = path.join(tmp, "runs");
  const missingSession = path.join(tmp, "missing-session.jsonl");
  const fake = await createFakePiChild();
  await fs.mkdir(projectDir, { recursive: true });

  await withEnv(
    {
      SUBAGENT007_PI_CHILD_PATH: fake.childPath,
      FAKE_PI_LOG_PATH: fake.logPath,
      SUBAGENT007_FAILURE_LOG: "off",
    },
    async () => {
      await assert.rejects(
        runSubagent(
          {
            cwd: projectDir,
            prompt: "FAST",
            model: "openai-codex/gpt-5.4-mini",
            thinking_level: "medium",
            continuity: { mode: "resume", session_id: missingSession },
          },
          { runsDir },
        ),
        /resume session file does not exist/,
      );

      const logs = await readJsonl(fake.logPath).catch(() => []);
      assert.equal(logs.length, 0);
    },
  );
});

test("runSubagent rejects timeout_ms unless internal callers opt into timed work", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-no-timeout-"));
  await assert.rejects(
    runSubagent({
      cwd,
      prompt: "FAST",
      model: "openai-codex/gpt-5.4-mini",
      thinking_level: "medium",
      timeout_ms: 1000,
    }),
    /timeout_ms is not supported by run_subagent; use start_run for timed work/,
  );
});

test("public transcript flags describe persisted rendered content", async () => {
  const assistantEvent = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "PUBLIC ASSISTANT TEXT" }],
    },
  });

  await withEnv({ SUBAGENT007_MAX_TRANSCRIPT_BYTES: undefined }, async () => {
    const transcript = preparePublicTranscriptFromProcessOutput(assistantEvent);
    assert.equal(transcript.hasAssistantText, true);
    assert.match(transcript.text, /PUBLIC ASSISTANT TEXT/);
  });

  await withEnv({ SUBAGENT007_MAX_TRANSCRIPT_BYTES: "20" }, async () => {
    const transcript = preparePublicTranscriptFromProcessOutput(assistantEvent);
    assert.equal(transcript.hasAssistantText, false);
    assert.match(transcript.text, /\[subagent007 transcript truncated at 20 bytes\]/);
    assert.doesNotMatch(transcript.text, /PUBLIC ASSISTANT TEXT/);
  });
});

test("MCP server exposes run_subagent names and not old run_codex names", async () => {
  await connectFakeClient(async (client) => {
    const response = await client.listTools();
    const names = response.tools.map((tool) => tool.name);
    assert.deepEqual(
      ["start_run", "get_run", "answer_run_input", "cancel_run", "run_subagent", "run_subagent_session"].every((name) =>
        names.includes(name),
      ),
      true,
    );
    assert.equal(names.includes("list_allowed_models"), true);
    assert.equal(names.includes("run_codex"), false);
    assert.equal(names.includes("run_codex_session"), false);
    const runSubagentTool = response.tools.find((tool) => tool.name === "run_subagent");
    assert.ok(runSubagentTool);
    assert.equal(
      Object.hasOwn(runSubagentTool.inputSchema.properties ?? {}, "timeout_ms"),
      false,
    );
    const runSubagentSessionTool = response.tools.find((tool) => tool.name === "run_subagent_session");
    assert.ok(runSubagentSessionTool);
    assert.equal(
      Object.hasOwn(runSubagentSessionTool.inputSchema.properties ?? {}, "continuity"),
      false,
    );
  });
});

test("MCP list_allowed_models exposes curated model choices", async () => {
  await connectFakeClient(async (client) => {
    const response = await client.callTool({
      name: "list_allowed_models",
      arguments: {},
    });
    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as {
      allowed_models: string[];
      exact_models: string[];
      model_patterns: string[];
      default_model: string | null;
      default_model_resolved: string | null;
      default_model_allowed: boolean | null;
      default_model_repaired: boolean;
      suggested_default_model: string | null;
    };
    const refs = metadata.allowed_models;
    assert.equal(refs.includes("openai-codex/gpt-5.4+"), true);
    assert.equal(refs.includes("openrouter/deepseek/deepseek-v4-pro"), true);
    assert.equal(metadata.exact_models.includes("openrouter/deepseek/deepseek-v4-pro"), true);
    assert.equal(metadata.exact_models.includes("openai-codex/gpt-5.4+"), false);
    assert.deepEqual(metadata.model_patterns, ["openai-codex/gpt-5.4+"]);
    assert.equal(metadata.default_model, "openai-codex/gpt-5.4-mini");
    assert.equal(metadata.default_model_resolved, "openai-codex/gpt-5.4-mini");
    assert.equal(metadata.default_model_allowed, true);
    assert.equal(metadata.default_model_repaired, false);
    assert.equal(metadata.suggested_default_model, null);
  });
});

test("MCP run_subagent uses the configured fake Pi child", async () => {
  await connectFakeClient(async (client, { projectDir, fakeLogPath }) => {
    const response = await client.callTool({
      name: "run_subagent",
      arguments: {
        cwd: projectDir,
        prompt: "FAST",
        skill_name: "pda-lite",
      },
    });
    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as RunSubagentMetadata;
    assert.equal(metadata.success, true);
    assert.equal(metadata.session_id, null);
    assert.equal(await fs.readFile(metadata.output_path, "utf8"), "FAST FINAL");

    const logs = await readJsonl<{ request: Record<string, unknown> }>(fakeLogPath);
    assert.equal(logs[0].request.model, "openai-codex/gpt-5.4-mini");
    assert.equal(logs[0].request.thinkingLevel, "medium");
    assert.equal(logs[0].request.skill, "pda-lite");
    assert.equal(logs[0].request.toolProfile, "inspect");
  });
});

test("run_subagent writes public transcripts without thinking event payloads", async () => {
  await connectFakeClient(async (client, { projectDir }) => {
    const response = await client.callTool({
      name: "run_subagent",
      arguments: {
        cwd: projectDir,
        prompt: "RAW_THINKING_TRANSCRIPT",
      },
    });
    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as RunSubagentMetadata;
    assert.equal(metadata.success, true);
    assert.equal(metadata.written_output_mode, "transcript");

    const output = await fs.readFile(metadata.output_path, "utf8");
    assert.match(output, /PUBLIC ASSISTANT TEXT/);
    assert.doesNotMatch(output, /SECRET_THINKING_SHOULD_NOT_LEAK/);
    assert.doesNotMatch(output, /thinking_delta/);
    assert.doesNotMatch(output, /assistantMessageEvent/);
  });
});

test("MCP start_run/get_run completes asynchronously with the same child contract", async () => {
  await connectFakeClient(async (client, { projectDir }) => {
    const startedResponse = await client.callTool({
      name: "start_run",
      arguments: {
        cwd: projectDir,
        prompt: "FAST",
      },
    });
    assert.notEqual(startedResponse.isError, true);
    const started = startedResponse.structuredContent as RunSubagentMetadata;
    assert.equal(["working", "completed"].includes(started.status), true);

    const terminal = await waitForTerminalRun(client, started.run_id);
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.success, true);
    assert.equal(await fs.readFile(terminal.output_path, "utf8"), "FAST FINAL");
  });
});

test("get_run can read a completed run snapshot after MCP server restart", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-run-snapshot-"));
  const projectDir = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const configPath = path.join(stateDir, "config.json");
  const fake = await createFakePiChild();
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify({ default_model: "openai-codex/gpt-5.4-mini", default_thinking_level: "medium" }),
  );
  const env = {
    ...process.env,
    SUBAGENT007_CONFIG_PATH: configPath,
    SUBAGENT007_RUNS_DIR: path.join(stateDir, "runs"),
    SUBAGENT007_RUN_TASKS_DIR: path.join(stateDir, "run-tasks"),
    SUBAGENT007_INPUT_REQUESTS_DIR: path.join(stateDir, "input-requests"),
    SUBAGENT007_PI_CHILD_PATH: fake.childPath,
    FAKE_PI_LOG_PATH: fake.logPath,
    SUBAGENT007_FAILURE_LOG: "off",
  };

  let runId: string;
  {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("dist/server.js")],
      env,
    });
    const client = new Client({ name: "subagent007-pi-run-snapshot-test", version: "0.1.0" });
    try {
      await client.connect(transport);
      const startedResponse = await client.callTool({
        name: "start_run",
        arguments: {
          cwd: projectDir,
          prompt: "FAST",
        },
      });
      const started = startedResponse.structuredContent as RunSubagentMetadata;
      runId = started.run_id;
      const terminal = await waitForTerminalRun(client, runId);
      assert.equal(terminal.status, "completed");
    } finally {
      await client.close();
    }
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/server.js")],
    env,
  });
  const client = new Client({ name: "subagent007-pi-run-snapshot-test-restart", version: "0.1.0" });
  try {
    await client.connect(transport);
    const response = await client.callTool({
      name: "get_run",
      arguments: { run_id: runId! },
    });
    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as RunSubagentMetadata;
    assert.equal(metadata.status, "completed");
    assert.equal(metadata.success, true);
    assert.equal(await fs.readFile(metadata.output_path, "utf8"), "FAST FINAL");
  } finally {
    await client.close();
  }
});

test("answer_run_input can answer a pending request belonging to a started run", async () => {
  await connectFakeClient(async (client, { projectDir }) => {
    const startedResponse = await client.callTool({
      name: "start_run",
      arguments: {
        cwd: projectDir,
        prompt: "HEARTBEAT_SLEEP",
      },
    });
    const started = startedResponse.structuredContent as RunSubagentMetadata;
    const mailboxRoot = path.dirname(started.input_requests_dir);
    const pending = await listInputRequests({ mailboxRoot, runId: started.run_id });
    assert.equal(pending.length, 0);

    const requestId = `${started.run_id}-abcdef123456`;
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

    const response = await client.callTool({
      name: "answer_run_input",
      arguments: {
        run_id: started.run_id,
        request_id: requestId,
        answer: "done",
      },
    });
    assert.notEqual(response.isError, true);
    const answered = await listInputRequests({ mailboxRoot, runId: started.run_id, status: "answered" });
    assert.equal(answered.length, 1);
    assert.equal(answered[0].request_id, requestId);
  });
});
