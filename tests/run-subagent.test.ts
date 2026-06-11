import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createInputRequest, listInputRequests } from "../src/inputMailbox.js";
import {
  extractSubagentSessionId,
  partialOutputAvailableForRun,
  runSubagent,
  RUN_SUBAGENT_TIMEOUT_RECOVERY_HINT,
} from "../src/runSubagent.js";
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
  timeout_recovery_hint?: string;
  session_id: string | null;
  session_established: boolean;
  input_requests_dir: string;
  input_requests: Array<{ request_id: string; status: string }>;
  written_output_mode: "final" | "transcript";
  elapsed_ms?: number;
  last_progress_at?: string;
  last_progress_message?: string;
  heartbeat_count?: number;
};

async function connectFakeClient<T>(
  run: (client: Client, dirs: {
    projectDir: string;
    configPath: string;
    fakeLogPath: string;
    modelHealthPath: string;
  }) => Promise<T>,
  options: { config?: Record<string, unknown>; env?: NodeJS.ProcessEnv } = {},
): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-mcp-"));
  const projectDir = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const configPath = path.join(stateDir, "config.json");
  const modelHealthPath = path.join(stateDir, "model-health.json");
  const fake = await createFakePiChild();
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify(
      options.config ?? { default_model_class: "C" },
    ),
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
      SUBAGENT007_MODEL_HEALTH_PATH: modelHealthPath,
      ...options.env,
    },
  });
  const client = new Client({ name: "subagent007-pi-runner-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    return await run(client, { projectDir, configPath, fakeLogPath: fake.logPath, modelHealthPath });
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

async function waitForActiveHeartbeat(client: Client, runId: string): Promise<RunSubagentMetadata> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const response = await client.callTool({
      name: "get_run",
      arguments: { run_id: runId },
    });
    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as RunSubagentMetadata;
    if ((metadata.heartbeat_count ?? 0) > 0) {
      return metadata;
    }
    if (metadata.status === "completed" || metadata.status === "failed" || metadata.status === "cancelled") {
      throw new Error(`run reached terminal state before heartbeat metadata appeared: ${metadata.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for heartbeat metadata on run ${runId}`);
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
          model_class: "C",
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
          model_class: "C",
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
          model_class: "C",
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
          model_class: "C",
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
          model_class: "C",
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
            model_class: "C",
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
      model_class: "C",
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

test("public transcript flags classify deterministic public content classes", async () => {
  const assistantEvent = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "assistant text" }],
    },
  });
  const warningEvent = JSON.stringify({ type: "subagent007.warning", message: "watch this" });
  const errorEvent = JSON.stringify({ type: "subagent007.error", error: "failed cleanly" });
  const userEvent = JSON.stringify({
    type: "message_end",
    message: {
      role: "user",
      content: [{ type: "text", text: "user-only text" }],
    },
  });

  await withEnv({ SUBAGENT007_MAX_TRANSCRIPT_BYTES: undefined }, async () => {
    const assistant = preparePublicTranscriptFromProcessOutput(assistantEvent);
    assert.equal(assistant.hasAssistantText, true);
    assert.equal(assistant.hasSubagentWarning, false);
    assert.equal(assistant.hasSubagentError, false);

    const warning = preparePublicTranscriptFromProcessOutput(warningEvent);
    assert.equal(warning.hasAssistantText, false);
    assert.equal(warning.hasSubagentWarning, true);
    assert.equal(warning.hasSubagentError, false);

    const error = preparePublicTranscriptFromProcessOutput(errorEvent);
    assert.equal(error.hasAssistantText, false);
    assert.equal(error.hasSubagentWarning, false);
    assert.equal(error.hasSubagentError, true);

    for (const rawOutput of [
      "raw child text",
      userEvent,
      "[subagent007 timeout] requested_timeout_ms=120 resolved_timeout_ms=120",
      "[subagent007 cancelled]",
    ]) {
      const transcript = preparePublicTranscriptFromProcessOutput(rawOutput);
      assert.equal(transcript.hasAssistantText, false, rawOutput);
      assert.equal(transcript.hasSubagentWarning, false, rawOutput);
      assert.equal(transcript.hasSubagentError, false, rawOutput);
    }
  });
});

test("partial output availability is pure timeout plus public child content", () => {
  const base = {
    timedOut: true,
    hasPublicAssistantText: false,
    hasPublicSubagentWarning: false,
    hasPublicSubagentError: false,
  };

  assert.equal(partialOutputAvailableForRun({ ...base, finalMessage: "final answer" }), true);
  assert.equal(partialOutputAvailableForRun({ ...base, hasPublicAssistantText: true }), true);
  assert.equal(partialOutputAvailableForRun({ ...base, hasPublicSubagentWarning: true }), true);
  assert.equal(partialOutputAvailableForRun({ ...base, hasPublicSubagentError: true }), true);
  assert.equal(partialOutputAvailableForRun(base), false);
  assert.equal(
    partialOutputAvailableForRun({
      ...base,
      timedOut: false,
      finalMessage: "final answer",
      hasPublicAssistantText: true,
      hasPublicSubagentWarning: true,
      hasPublicSubagentError: true,
    }),
    false,
  );
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
    assert.equal(names.includes("list_model_classes"), true);
    assert.equal(names.includes("list_allowed_models"), true);
    assert.equal(names.includes("run_codex"), false);
    assert.equal(names.includes("run_codex_session"), false);
    const runSubagentTool = response.tools.find((tool) => tool.name === "run_subagent");
    assert.ok(runSubagentTool);
    assert.equal(
      Object.hasOwn(runSubagentTool.inputSchema.properties ?? {}, "timeout_ms"),
      false,
    );
    assert.equal(
      Object.hasOwn(runSubagentTool.inputSchema.properties ?? {}, "run_kind"),
      true,
    );
    assert.deepEqual(runSubagentTool.inputSchema.required, ["prompt", "cwd", "run_kind"]);
    const runSubagentSessionTool = response.tools.find((tool) => tool.name === "run_subagent_session");
    assert.ok(runSubagentSessionTool);
    assert.equal(
      Object.hasOwn(runSubagentSessionTool.inputSchema.properties ?? {}, "continuity"),
      false,
    );
  });
});

test("MCP run_subagent rejects missing or invalid run_kind before invoking the child", async () => {
  await connectFakeClient(async (client, { projectDir, fakeLogPath }) => {
    const missingResponse = await client.callTool({
      name: "run_subagent",
      arguments: {
        cwd: projectDir,
        prompt: "FAST",
      },
    });
    assert.equal(missingResponse.isError, true);
    const missingContent = missingResponse.content as Array<{ type: string; text?: string }>;
    assert.match(missingContent[0]?.type === "text" ? (missingContent[0].text ?? "") : "", /run_kind/);

    const invalidResponse = await client.callTool({
      name: "run_subagent",
      arguments: {
        cwd: projectDir,
        prompt: "FAST",
        run_kind: "long_running",
      },
    });
    assert.equal(invalidResponse.isError, true);
    const invalidContent = invalidResponse.content as Array<{ type: string; text?: string }>;
    assert.match(
      invalidContent[0]?.type === "text" ? (invalidContent[0].text ?? "") : "",
      /use start_run for longer/,
    );
    await assert.rejects(fs.stat(fakeLogPath), /ENOENT/);
  });
});

test("MCP run_subagent and start_run reject unsupported session fields before invoking the child", async () => {
  await connectFakeClient(async (client, { projectDir, fakeLogPath }) => {
    const rawSessionResponse = await client.callTool({
      name: "start_run",
      arguments: {
        cwd: projectDir,
        prompt: "FAST",
        session_id: "raw",
      },
    });
    assert.equal(rawSessionResponse.isError, true);
    const rawSessionContent = rawSessionResponse.content as Array<{ type: string; text?: string }>;
    assert.match(
      rawSessionContent[0]?.type === "text" ? (rawSessionContent[0].text ?? "") : "",
      /session_id is not a start_run input/,
    );

    const startRunFreshWithSessionResponse = await client.callTool({
      name: "start_run",
      arguments: {
        cwd: projectDir,
        prompt: "FAST",
        continuity: { mode: "fresh", session_id: "/tmp/session.jsonl" },
      },
    });
    assert.equal(startRunFreshWithSessionResponse.isError, true);
    const startRunFreshContent = startRunFreshWithSessionResponse.content as Array<{ type: string; text?: string }>;
    assert.match(
      startRunFreshContent[0]?.type === "text" ? (startRunFreshContent[0].text ?? "") : "",
      /session_id/,
    );

    const runSubagentFreshWithSessionResponse = await client.callTool({
      name: "run_subagent",
      arguments: {
        cwd: projectDir,
        prompt: "FAST",
        run_kind: "quick_noninteractive",
        continuity: { mode: "fresh", session_id: "/tmp/session.jsonl" },
      },
    });
    assert.equal(runSubagentFreshWithSessionResponse.isError, true);
    const runSubagentFreshContent = runSubagentFreshWithSessionResponse.content as Array<{ type: string; text?: string }>;
    assert.match(
      runSubagentFreshContent[0]?.type === "text" ? (runSubagentFreshContent[0].text ?? "") : "",
      /session_id/,
    );

    await assert.rejects(fs.stat(fakeLogPath), /ENOENT/);
  });
});

test("MCP list_model_classes exposes curated model classes", async () => {
  await connectFakeClient(async (client) => {
    const response = await client.callTool({
      name: "list_model_classes",
      arguments: {},
    });
    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as {
      model_classes: Array<{ class: string; description: string }>;
      default_model_class: string;
      default_model_class_configured: string | null;
      default_model_class_effective: string;
      default_model_class_repaired: boolean;
      config_migration: null | {
        needed: true;
        field: string;
        from: string | null;
        to: string;
        command: string;
      };
      resolved_default_model: string;
      resolved_default_thinking_level: string;
    };
    assert.deepEqual(metadata.model_classes.map((entry) => entry.class), ["A", "B", "C", "D", "E"]);
    assert.equal(metadata.model_classes.every((entry) => entry.description.length > 0), true);
    assert.equal(metadata.default_model_class, "C");
    assert.equal(metadata.default_model_class_configured, "C");
    assert.equal(metadata.default_model_class_effective, "C");
    assert.equal(metadata.default_model_class_repaired, false);
    assert.equal(metadata.config_migration, null);
    assert.equal(metadata.resolved_default_model, "openrouter/deepseek/deepseek-v4-pro");
    assert.equal(metadata.resolved_default_thinking_level, "high");
  });
});

test("MCP list_model_classes falls back to class C for unsupported legacy defaults", async () => {
  await connectFakeClient(
    async (client) => {
      const response = await client.callTool({
        name: "list_model_classes",
        arguments: {},
      });
      assert.notEqual(response.isError, true);
      const metadata = response.structuredContent as {
        default_model_class: string;
        default_model_class_configured: string | null;
        default_model_class_effective: string;
        default_model_class_repaired: boolean;
        config_migration: null | {
          needed: true;
          field: string;
          from: string | null;
          to: string;
          command: string;
        };
        resolved_default_model: string;
        resolved_default_thinking_level: string;
      };
      assert.equal(metadata.default_model_class, "C");
      assert.equal(metadata.default_model_class_configured, null);
      assert.equal(metadata.default_model_class_effective, "C");
      assert.equal(metadata.default_model_class_repaired, false);
      assert.deepEqual(metadata.config_migration, {
        needed: true,
        field: "default_model_class",
        from: null,
        to: "C",
        command: "npm run config:migrate",
      });
      assert.equal(metadata.resolved_default_model, "openrouter/deepseek/deepseek-v4-pro");
      assert.equal(metadata.resolved_default_thinking_level, "high");
    },
    {
      config: {
        default_model: "anthropic/claude-sonnet-4.5",
        default_thinking_level: "medium",
      },
    },
  );
});

test("MCP list_model_classes exposes config migration guidance for whitespace-padded model classes", async () => {
  await connectFakeClient(
    async (client) => {
      const response = await client.callTool({
        name: "list_model_classes",
        arguments: {},
      });
      assert.notEqual(response.isError, true);
      const metadata = response.structuredContent as {
        default_model_class_configured: string | null;
        default_model_class_effective: string;
        default_model_class_repaired: boolean;
        config_migration: null | {
          needed: true;
          field: string;
          from: string;
          to: string;
          command: string;
        };
      };
      assert.equal(metadata.default_model_class_configured, " C ");
      assert.equal(metadata.default_model_class_effective, "C");
      assert.equal(metadata.default_model_class_repaired, true);
      assert.deepEqual(metadata.config_migration, {
        needed: true,
        field: "default_model_class",
        from: " C ",
        to: "C",
        command: "npm run config:migrate",
      });
    },
    {
      config: {
        default_model_class: " C ",
      },
    },
  );
});

test("MCP list_allowed_models remains a compatibility alias for model classes", async () => {
  await connectFakeClient(async (client) => {
    const canonical = await client.callTool({
      name: "list_model_classes",
      arguments: {},
    });
    const alias = await client.callTool({
      name: "list_allowed_models",
      arguments: {},
    });
    assert.notEqual(canonical.isError, true);
    assert.notEqual(alias.isError, true);
    assert.deepEqual(alias.structuredContent, canonical.structuredContent);
  });
});

test("MCP run_subagent uses the configured fake Pi child", async () => {
  await connectFakeClient(async (client, { projectDir, fakeLogPath }) => {
    const response = await client.callTool({
      name: "run_subagent",
      arguments: {
        cwd: projectDir,
        prompt: "FAST",
        run_kind: "quick_noninteractive",
        skill_name: "pda-lite",
      },
    });
    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as RunSubagentMetadata;
    assert.equal(metadata.success, true);
    assert.equal(metadata.session_id, null);
    assert.equal(await fs.readFile(metadata.output_path, "utf8"), "FAST FINAL");

    const logs = await readJsonl<{ request: Record<string, unknown> }>(fakeLogPath);
    assert.equal(logs[0].request.model, "openrouter/deepseek/deepseek-v4-pro");
    assert.equal(logs[0].request.thinkingLevel, "high");
    assert.equal(logs[0].request.skill, "pda-lite");
    assert.equal(logs[0].request.toolProfile, "inspect");
  });
});

test("MCP run_subagent timeout returns async recovery guidance", async () => {
  await connectFakeClient(
    async (client, { projectDir }) => {
      const response = await client.callTool({
        name: "run_subagent",
        arguments: {
          cwd: projectDir,
          prompt: "TIMEOUT_ASSISTANT_EVENT",
          run_kind: "quick_noninteractive",
        },
      });
      assert.notEqual(response.isError, true);
      const metadata = response.structuredContent as RunSubagentMetadata;
      assert.equal(metadata.success, false);
      assert.equal(metadata.timed_out, true);
      assert.match(metadata.timeout_recovery_hint ?? "", new RegExp(RUN_SUBAGENT_TIMEOUT_RECOVERY_HINT));
      assert.match(metadata.timeout_recovery_hint ?? "", new RegExp(metadata.run_id));
      const runView = await client.callTool({
        name: "get_run",
        arguments: { run_id: metadata.run_id },
      });
      assert.notEqual(runView.isError, true);
      assert.deepEqual(runView.structuredContent, metadata);
    },
    {
      env: {
        SUBAGENT007_RUN_SUBAGENT_TIMEOUT_MS: "260",
        SUBAGENT007_MIN_REQUESTED_TIMEOUT_MS: "0",
        SUBAGENT007_TIMEOUT_RESPONSE_HEADROOM_MS: "100",
        SUBAGENT007_TIMEOUT_KILL_GRACE_MS: "50",
        SUBAGENT007_TIMEOUT_FORCE_GRACE_MS: "50",
      },
    },
  );
});

test("run_subagent writes public transcripts without thinking event payloads", async () => {
  await connectFakeClient(async (client, { projectDir }) => {
    const response = await client.callTool({
      name: "run_subagent",
      arguments: {
        cwd: projectDir,
        prompt: "RAW_THINKING_TRANSCRIPT",
        run_kind: "quick_noninteractive",
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

test("MCP run_subagent fails fast for known unhealthy one-shot model class", async () => {
  await connectFakeClient(async (client, { projectDir, fakeLogPath, modelHealthPath }) => {
    await fs.writeFile(
      modelHealthPath,
      `${JSON.stringify([
        {
          schema_version: 1,
          model_class: "A",
          resolved_model: "ollama/gemma4:12b-mlx",
          surface: "run_subagent_one_shot",
          checked_at: "2026-06-11T00:00:00.000Z",
          usable_for_one_shot: false,
          last_failure_class: "timeout",
          last_failure_at: "2026-06-11T00:00:00.000Z",
        },
      ], null, 2)}\n`,
    );

    const classes = await client.callTool({
      name: "list_model_classes",
      arguments: {},
    });
    assert.notEqual(classes.isError, true);
    const classA = (classes.structuredContent as {
      model_classes: Array<{
        class: string;
        one_shot_health?: { status: string; usable_for_one_shot: boolean | null };
      }>;
    }).model_classes.find((entry) => entry.class === "A");
    assert.equal(classA?.one_shot_health?.status, "unhealthy");
    assert.equal(classA?.one_shot_health?.usable_for_one_shot, false);

    const response = await client.callTool({
      name: "run_subagent",
      arguments: {
        cwd: projectDir,
        prompt: "FAST",
        run_kind: "quick_noninteractive",
        model_class: "A",
      },
    });
    assert.equal(response.isError, true);
    const content = response.content as Array<{ type: string; text?: string }>;
    assert.match(
      content[0]?.type === "text" ? (content[0].text ?? "") : "",
      /known unhealthy for run_subagent one-shot/,
    );
    await assert.rejects(fs.stat(fakeLogPath), /ENOENT/);
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

test("MCP start_run/get_run exposes active liveness and pending-input progress", async () => {
  await connectFakeClient(
    async (client, { projectDir }) => {
      const startedResponse = await client.callTool({
        name: "start_run",
        arguments: {
          cwd: projectDir,
          prompt: "HEARTBEAT_LONG_WAIT",
        },
      });
      assert.notEqual(startedResponse.isError, true);
      const started = startedResponse.structuredContent as RunSubagentMetadata;
      assert.equal(["working", "completed"].includes(started.status), true);
      assert.equal(started.heartbeat_count, 0);
      assert.equal(typeof started.elapsed_ms, "number");
      assert.equal(typeof started.last_progress_at, "string");
      assert.equal(started.last_progress_message, "running");

      const heartbeat = await waitForActiveHeartbeat(client, started.run_id);
      assert.equal(heartbeat.status, "working");
      assert.equal((heartbeat.heartbeat_count ?? 0) > 0, true);
      assert.equal(typeof heartbeat.elapsed_ms, "number");
      assert.equal(typeof heartbeat.last_progress_at, "string");
      assert.equal(heartbeat.last_progress_message, "running");

      const mailboxRoot = path.dirname(started.input_requests_dir);
      const request = await createInputRequest({
        mailboxRoot,
        runId: started.run_id,
        question: "Which follow-up path should the child take?",
      });

      const pendingDeadline = Date.now() + 2000;
      let pendingView: RunSubagentMetadata | undefined;
      while (Date.now() < pendingDeadline) {
        const response = await client.callTool({
          name: "get_run",
          arguments: { run_id: started.run_id },
        });
        assert.notEqual(response.isError, true);
        const metadata = response.structuredContent as RunSubagentMetadata;
        if (metadata.last_progress_message?.includes("pending input request")) {
          pendingView = metadata;
          break;
        }
        if (metadata.status === "completed" || metadata.status === "failed" || metadata.status === "cancelled") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      assert.ok(pendingView);
      assert.equal(pendingView.status, "input_required");
      assert.match(pendingView.last_progress_message ?? "", new RegExp(request.request_id));

      const answerResponse = await client.callTool({
        name: "answer_run_input",
        arguments: {
          run_id: started.run_id,
          request_id: request.request_id,
          answer: "continue",
        },
      });
      assert.notEqual(answerResponse.isError, true);

      const terminal = await waitForTerminalRun(client, started.run_id);
      assert.equal(terminal.status, "completed");
      assert.equal(await fs.readFile(terminal.output_path, "utf8"), "HEARTBEAT LONG DONE");
    },
    {
      env: {
        SUBAGENT007_HEARTBEAT_INTERVAL_MS: "25",
      },
    },
  );
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
    JSON.stringify({ default_model_class: "C" }),
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

test("cancel_run closes pending input requests and rejects late answers", async () => {
  await connectFakeClient(
    async (client, { projectDir }) => {
      const startedResponse = await client.callTool({
        name: "start_run",
        arguments: {
          cwd: projectDir,
          prompt: "CANCEL_WAIT",
          timeout_ms: 6000,
        },
      });
      assert.notEqual(startedResponse.isError, true);
      const started = startedResponse.structuredContent as RunSubagentMetadata;
      const mailboxRoot = path.dirname(started.input_requests_dir);
      const request = await createInputRequest({
        mailboxRoot,
        runId: started.run_id,
        question: "Should be closed on cancel",
      });

      const cancelResponse = await client.callTool({
        name: "cancel_run",
        arguments: { run_id: started.run_id },
      });
      assert.notEqual(cancelResponse.isError, true);
      const cancelled = cancelResponse.structuredContent as RunSubagentMetadata;
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.input_requests.some((input) => input.status === "pending"), false);

      const closed = await listInputRequests({ mailboxRoot, runId: started.run_id, status: "closed" });
      assert.equal(closed.length, 1);
      assert.equal(closed[0].request_id, request.request_id);

      const lateAnswer = await client.callTool({
        name: "answer_run_input",
        arguments: {
          run_id: started.run_id,
          request_id: request.request_id,
          answer: "late",
        },
      });
      assert.equal(lateAnswer.isError, true);
      const content = lateAnswer.content as Array<{ type: string; text?: string }>;
      assert.match(
        content[0]?.type === "text" ? (content[0].text ?? "") : "",
        /not accepting input|already closed/,
      );
    },
    {
      env: {
        SUBAGENT007_TIMEOUT_KILL_GRACE_MS: "10",
        SUBAGENT007_TIMEOUT_FORCE_GRACE_MS: "10",
      },
    },
  );
});
