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
  runSubagentCore as runSubagent,
  RUN_SUBAGENT_TIMEOUT_RECOVERY_HINT,
} from "../src/runSubagent.js";
import { preparePublicTranscriptFromProcessOutput } from "../src/transcript.js";
import { createFakePiChild } from "./helpers/fakePiChild.js";
import { readJsonl, sha256File, withEnv } from "./helpers/testUtils.js";

type RunSubagentMetadata = {
  run_id: string;
  status: "working" | "input_required" | "completed" | "failed" | "cancelled" | "timed_out";
  output_path: string;
  output_references?: Array<{
    kind: "file";
    name: "primary";
    path: string;
    size_bytes: number;
    output_mode: "final" | "transcript";
  }>;
  success: boolean;
  exit_code: number | null;
  timed_out: boolean;
  requested_timeout_ms: number | null;
  resolved_timeout_ms: number | null;
  effective_timeout_ms: number | null;
  stop_signal: string | null;
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
  active_phase?: string;
  last_phase_at?: string;
  finished_at?: string;
  recent_events?: Array<{ kind: string; event?: string; text: string; occurred_at: string }>;
  last_public_output_excerpt?: string;
  requested_wait_ms?: number;
  effective_wait_ms?: number;
  wait_truncated?: boolean;
  requested_skill?: string | null;
  resolved_skill_path?: string | null;
  resolved_skill_sha256?: string | null;
  auto_promoted_from?: "run_subagent";
  promotion_reason_code?: "skill_bound" | "prompt_too_long" | "broad_work" | "workspace_write";
  promotion_reason?: string;
  poll_with?: "get_run";
  cancel_with?: "cancel_run";
  contract_name?: string;
  contract_version?: number;
  error_class?: string;
  reason_code?: string;
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

async function writeSkillFixture(root: string, name: string): Promise<string> {
  const skillDir = path.join(root, name.replace(/:/g, "__"));
  const skillPath = path.join(skillDir, "SKILL.md");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    skillPath,
    [
      "---",
      `name: ${name}`,
      `description: Test skill ${name}`,
      "---",
      "",
      `# ${name}`,
      "",
      "Use only for tests.",
      "",
    ].join("\n"),
    "utf8",
  );
  return skillPath;
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
    if (metadata.status === "completed" || metadata.status === "failed" || metadata.status === "cancelled" || metadata.status === "timed_out") {
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
    if (metadata.status === "completed" || metadata.status === "failed" || metadata.status === "cancelled" || metadata.status === "timed_out") {
      throw new Error(`run reached terminal state before heartbeat metadata appeared: ${metadata.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for heartbeat metadata on run ${runId}`);
}

async function waitForInputRequired(client: Client, runId: string): Promise<RunSubagentMetadata> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const response = await client.callTool({
      name: "get_run",
      arguments: { run_id: runId },
    });
    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as RunSubagentMetadata;
    if (metadata.status === "input_required") {
      return metadata;
    }
    if (metadata.status === "completed" || metadata.status === "failed" || metadata.status === "cancelled" || metadata.status === "timed_out") {
      throw new Error(`run reached terminal state before input_required: ${metadata.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for input_required on run ${runId}`);
}

async function waitForFileText(filePath: string, pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 2000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const text = await fs.readFile(filePath, "utf8");
      if (pattern.test(text)) {
        return text;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${filePath} to match ${pattern}: ${String(lastError)}`);
}

function assertCancellationInProgressOrSettled(metadata: RunSubagentMetadata): void {
  if (metadata.active_phase === "cancelling") {
    assert.equal(metadata.status, "working");
    return;
  }
  if (metadata.active_phase === "cancelled") {
    assert.equal(metadata.status, "cancelled");
    return;
  }
  assert.fail(`expected cancellation phase, got status=${metadata.status} active_phase=${metadata.active_phase}`);
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
  const skillsRoot = path.join(tmp, "skills");
  const skillName = "fixture-pda-lite";
  const skillPath = await writeSkillFixture(skillsRoot, skillName);
  const fake = await createFakePiChild();
  await fs.mkdir(projectDir, { recursive: true });

  await withEnv(
    {
      SUBAGENT007_PI_CHILD_PATH: fake.childPath,
      FAKE_PI_LOG_PATH: fake.logPath,
      SUBAGENT007_FAILURE_LOG: "off",
      SUBAGENT007_PI_SKILL_PATHS: skillsRoot,
    },
    async () => {
      const result = await runSubagent(
        {
          cwd: projectDir,
          prompt: "FAST",
          model_class: "C",
          skill_name: skillName,
        },
        { runsDir },
      );

      assert.equal(result.success, true);
      assert.equal(result.session_id, null);
      assert.equal(result.session_established, false);
      assert.equal(result.resolved_skill_path, skillPath);
      assert.equal(result.resolved_skill_sha256, await sha256File(skillPath));
      assert.equal(path.dirname(result.output_path), runsDir);
      assert.equal(await fs.readFile(result.output_path, "utf8"), "FAST FINAL");

      const logs = await readJsonl<{ request: Record<string, unknown> }>(fake.logPath);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].request.sessionMode, "ephemeral");
      assert.equal(logs[0].request.prompt, "/skill:fixture-pda-lite\n\n<prompt>\nFAST\n</prompt>");
      assert.deepEqual(logs[0].request.promptProvenance, {
        public_prompt: "FAST",
        skill_name: skillName,
        skill_marker: "[server_contract] skill_name=fixture-pda-lite",
        composed_child_prompt: "/skill:fixture-pda-lite\n\n<prompt>\nFAST\n</prompt>",
      });
      assert.equal(logs[0].request.skill, skillName);
      assert.equal(logs[0].request.skillFilePath, skillPath);
      assert.equal(logs[0].request.cwd, projectDir);
      assert.equal(logs[0].request.toolProfile, "all");
    },
  );
});

test("runSubagent accepts skill_name and passes a normalized skill to the Pi child", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-skill-name-"));
  const projectDir = path.join(tmp, "project");
  const runsDir = path.join(tmp, "runs");
  const skillsRoot = path.join(tmp, "skills");
  const skillName = "fixture-tension-hunter";
  const skillPath = await writeSkillFixture(skillsRoot, skillName);
  const fake = await createFakePiChild();
  await fs.mkdir(projectDir, { recursive: true });

  await withEnv(
    {
      SUBAGENT007_PI_CHILD_PATH: fake.childPath,
      FAKE_PI_LOG_PATH: fake.logPath,
      SUBAGENT007_FAILURE_LOG: "off",
      SUBAGENT007_PI_SKILL_PATHS: skillsRoot,
    },
    async () => {
      const result = await runSubagent(
        {
          cwd: projectDir,
          prompt: "FAST",
          model_class: "C",
          skill_name: skillName,
        },
        { runsDir },
      );

      assert.equal(result.success, true);
      assert.equal(result.requested_skill, skillName);
      assert.equal(result.resolved_skill_path, skillPath);
      assert.equal(result.resolved_skill_sha256, await sha256File(skillPath));

      const logs = await readJsonl<{ request: Record<string, unknown> }>(fake.logPath);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].request.skill, skillName);
      assert.equal(logs[0].request.skillFilePath, skillPath);
    },
  );
});

test("runSubagent accepts legacy explicit tool profile but resolves all tools", async () => {
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
      assert.equal(result.resolved_tool_profile, "all");

      const logs = await readJsonl<{ request: Record<string, unknown> }>(fake.logPath);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].request.toolProfile, "all");
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
    /timeout_ms is not supported by run_subagent; use schedule_run or start_run for timed work/,
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

  await withEnv({ SUBAGENT007_MAX_TRANSCRIPT_BYTES: "not-a-number" }, async () => {
    const transcript = preparePublicTranscriptFromProcessOutput(assistantEvent);
    assert.equal(transcript.hasAssistantText, true);
    assert.doesNotMatch(transcript.text, /\[subagent007 transcript truncated/);
    assert.match(transcript.text, /PUBLIC ASSISTANT TEXT/);
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
      [
        "start_run",
        "schedule_run",
        "get_run",
        "answer_run_input",
        "cancel_run",
        "run_subagent",
        "start_session_run",
        "run_subagent_session",
      ].every((name) => names.includes(name)),
      true,
    );
    assert.equal(names.includes("list_model_classes"), true);
    assert.equal(names.includes("list_allowed_models"), true);
    assert.equal(names.includes("get_run_contract"), true);
    assert.equal(names.includes("get_runtime_readiness"), true);
    assert.equal(names.includes("run_codex"), false);
    assert.equal(names.includes("run_codex_session"), false);
    const listModelClassesTool = response.tools.find((tool) => tool.name === "list_model_classes");
    assert.ok(listModelClassesTool);
    assert.equal(listModelClassesTool.title, "List Model Classes");
    assert.equal(listModelClassesTool.description, "List the Subagent007 capability classes accepted by this MCP server.");
    const listAllowedModelsTool = response.tools.find((tool) => tool.name === "list_allowed_models");
    assert.ok(listAllowedModelsTool);
    assert.equal(listAllowedModelsTool.title, "List Model Classes");
    assert.equal(listAllowedModelsTool.description, "Compatibility alias for list_model_classes.");
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
    const contractResponse = await client.callTool({
      name: "get_run_contract",
      arguments: {},
    });
    assert.notEqual(contractResponse.isError, true);
    const contract = contractResponse.structuredContent as {
      contract_name?: string;
      contract_version?: number;
      statuses?: { non_terminal?: string[]; terminal?: string[] };
      capabilities?: string[];
      input_mailbox?: { waiting_status_terminal?: boolean };
    };
    assert.equal(contract.contract_name, "subagent007.durable_run");
    assert.equal(contract.contract_version, 1);
    assert.deepEqual(contract.statuses?.terminal, ["completed", "failed", "cancelled", "timed_out"]);
    assert.deepEqual(contract.statuses?.non_terminal, ["working", "input_required"]);
    assert.equal(contract.capabilities?.includes("file_backed_output_references"), true);
    assert.equal(contract.capabilities?.includes("restart_drift_fail_closed"), true);
    assert.equal(contract.input_mailbox?.waiting_status_terminal, false);
    const readinessResponse = await client.callTool({
      name: "get_runtime_readiness",
      arguments: {
        expected_contract_name: "subagent007.durable_run",
        expected_contract_version: 1,
        source_state_policy: "allow_unknown",
      },
    });
    assert.notEqual(readinessResponse.isError, true);
    const readiness = readinessResponse.structuredContent as {
      schema_version?: number;
      ready?: boolean;
      status?: string;
      contract?: { compatible?: boolean };
      runtime?: { server_entrypoint?: string };
      capabilities?: { public_tools?: string[] };
      blocks?: Array<{ class?: string }>;
    };
    assert.equal(readiness.schema_version, 1);
    assert.equal(readiness.ready, true);
    assert.equal(readiness.status, "ready");
    assert.equal(readiness.contract?.compatible, true);
    assert.equal(readiness.runtime?.server_entrypoint?.endsWith("dist/server.js"), true);
    assert.equal(readiness.capabilities?.public_tools?.includes("get_runtime_readiness"), true);
    assert.deepEqual(readiness.blocks, []);
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
      /use schedule_run or start_run for longer/,
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

    const scheduleRawSessionResponse = await client.callTool({
      name: "schedule_run",
      arguments: {
        cwd: projectDir,
        prompt: "FAST",
        session_id: "raw",
      },
    });
    assert.equal(scheduleRawSessionResponse.isError, true);
    const scheduleRawSessionContent = scheduleRawSessionResponse.content as Array<{ type: string; text?: string }>;
    assert.match(
      scheduleRawSessionContent[0]?.type === "text" ? (scheduleRawSessionContent[0].text ?? "") : "",
      /session_id is not a schedule_run input/,
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
      model_classes: Array<{
        class: string;
        description: string;
        one_shot_health?: {
          status: string;
          usable_for_one_shot: boolean | null;
          health_basis: string;
          health_gate: string;
          health_action: string;
        };
      }>;
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
      default_one_shot_health_status: string;
      default_one_shot_health_basis: string;
      model_health_probe_command: string;
    };
    assert.deepEqual(metadata.model_classes.map((entry) => entry.class), ["A", "B", "C", "D", "E"]);
    assert.equal(metadata.model_classes.every((entry) => entry.description.length > 0), true);
    assert.equal(
      metadata.model_classes.every((entry) =>
        entry.one_shot_health?.status === "unknown" &&
          entry.one_shot_health.usable_for_one_shot === null &&
          entry.one_shot_health.health_basis === "never_probed" &&
          entry.one_shot_health.health_gate === "blocks_only_known_unhealthy" &&
          entry.one_shot_health.health_action.includes(`--model-class ${entry.class}`)
      ),
      true,
    );
    assert.equal(metadata.default_model_class, "C");
    assert.equal(metadata.default_model_class_configured, "C");
    assert.equal(metadata.default_model_class_effective, "C");
    assert.equal(metadata.default_model_class_repaired, false);
    assert.equal(metadata.config_migration, null);
    assert.equal(metadata.resolved_default_model, "openai-codex/gpt-5.4-mini");
    assert.equal(metadata.resolved_default_thinking_level, "high");
    assert.equal(metadata.default_one_shot_health_status, "unknown");
    assert.equal(metadata.default_one_shot_health_basis, "never_probed");
    assert.match(metadata.model_health_probe_command, /--model-class C/);
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
      assert.equal(metadata.resolved_default_model, "openai-codex/gpt-5.4-mini");
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

test("MCP list_model_classes exposes cached healthy one-shot health basis", async () => {
  await connectFakeClient(async (client, { modelHealthPath }) => {
    await fs.writeFile(
      modelHealthPath,
      `${JSON.stringify([
        {
          schema_version: 1,
          model_class: "C",
          resolved_model: "openai-codex/gpt-5.4-mini",
          surface: "run_subagent_one_shot",
          checked_at: "2026-06-11T00:00:00.000Z",
          usable_for_one_shot: true,
          last_success_latency_ms: 1234,
        },
      ], null, 2)}\n`,
    );

    const response = await client.callTool({
      name: "list_model_classes",
      arguments: {},
    });
    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as {
      model_classes: Array<{
        class: string;
        one_shot_health?: {
          status: string;
          usable_for_one_shot: boolean | null;
          health_basis: string;
          last_checked_at: string | null;
          last_success_latency_ms?: number;
        };
      }>;
      default_one_shot_health_status: string;
      default_one_shot_health_basis: string;
    };
    const classC = metadata.model_classes.find((entry) => entry.class === "C");
    assert.equal(classC?.one_shot_health?.status, "healthy");
    assert.equal(classC?.one_shot_health?.usable_for_one_shot, true);
    assert.equal(classC?.one_shot_health?.health_basis, "cached_probe");
    assert.equal(classC?.one_shot_health?.last_checked_at, "2026-06-11T00:00:00.000Z");
    assert.equal(classC?.one_shot_health?.last_success_latency_ms, 1234);
    assert.equal(metadata.default_one_shot_health_status, "healthy");
    assert.equal(metadata.default_one_shot_health_basis, "cached_probe");
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
      },
    });
    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as RunSubagentMetadata;
    assert.equal(metadata.success, true);
    assert.equal(metadata.session_id, null);
    assert.equal(await fs.readFile(metadata.output_path, "utf8"), "FAST FINAL");

    const logs = await readJsonl<{ request: Record<string, unknown> }>(fakeLogPath);
    assert.equal(logs[0].request.model, "openai-codex/gpt-5.4-mini");
    assert.equal(logs[0].request.thinkingLevel, "high");
    assert.equal(logs[0].request.skill, undefined);
    assert.equal(logs[0].request.toolProfile, "all");
  });
});

test("MCP run_subagent auto-promotes skill-bound work without one-shot health gating", async () => {
  const runTasksDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-promoted-skill-"));
  const skillsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-promoted-skills-"));
  const skillName = "fixture-promoted-skill";
  const skillPath = await writeSkillFixture(skillsRoot, skillName);
  await connectFakeClient(
    async (client, { projectDir, fakeLogPath, modelHealthPath }) => {
      await fs.writeFile(
        modelHealthPath,
        `${JSON.stringify([
          {
            schema_version: 1,
            model_class: "A",
            resolved_model: "openrouter/qwen/qwen3.6-35b-a3b",
            surface: "run_subagent_one_shot",
            checked_at: "2026-06-11T00:00:00.000Z",
            usable_for_one_shot: false,
            last_failure_class: "timeout",
            last_failure_at: "2026-06-11T00:00:00.000Z",
          },
        ], null, 2)}\n`,
      );

      const response = await client.callTool({
        name: "run_subagent",
        arguments: {
          cwd: projectDir,
          prompt: "FAST",
          run_kind: "quick_noninteractive",
          model_class: "A",
          skill_name: skillName,
        },
      });
      assert.notEqual(response.isError, true);
      const metadata = response.structuredContent as RunSubagentMetadata;
      assert.equal(metadata.status, "completed");
      assert.equal(metadata.success, true);
      assert.equal(metadata.auto_promoted_from, "run_subagent");
      assert.equal(metadata.promotion_reason_code, "skill_bound");
      assert.match(metadata.promotion_reason ?? "", /skill-bound work/);
      assert.equal(metadata.poll_with, "get_run");
      assert.equal(metadata.cancel_with, "cancel_run");
      assert.equal(metadata.requested_timeout_ms, null);
      assert.equal(metadata.resolved_timeout_ms, null);
      assert.equal(metadata.effective_timeout_ms, null);
      assert.equal(metadata.requested_skill, skillName);
      assert.equal(metadata.resolved_skill_path, skillPath);
      assert.equal(metadata.resolved_skill_sha256, await sha256File(skillPath));
      assert.equal(await fs.readFile(metadata.output_path, "utf8"), "FAST FINAL");

      const logs = await readJsonl<{ request: Record<string, unknown> }>(fakeLogPath);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].request.skill, skillName);
      assert.equal(logs[0].request.skillFilePath, skillPath);
      assert.equal(logs[0].request.model, "openrouter/qwen/qwen3.6-35b-a3b");

      const rawEvents = await fs.readFile(path.join(runTasksDir, `${metadata.run_id}.events.jsonl`), "utf8");
      assert.match(rawEvents, /\[auto_promoted\] run_subagent -> durable_run/);

      const runView = await client.callTool({
        name: "get_run",
        arguments: { run_id: metadata.run_id },
      });
      assert.notEqual(runView.isError, true);
      assert.equal(
        (runView.structuredContent as RunSubagentMetadata).promotion_reason_code,
        "skill_bound",
      );
    },
    {
      env: {
        SUBAGENT007_RUN_TASKS_DIR: runTasksDir,
        SUBAGENT007_PI_SKILL_PATHS: skillsRoot,
      },
    },
  );
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
      assert.equal(metadata.status, "timed_out");
      assert.equal(metadata.success, false);
      assert.equal(metadata.timed_out, true);
      assert.equal(metadata.error_class, "timeout");
      assert.equal(metadata.reason_code, "timeout");
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

test("run_subagent raw public event file omits thinking payloads", async () => {
  const runTasksDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-events-"));
  await connectFakeClient(
    async (client, { projectDir }) => {
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
      const rawEvents = await fs.readFile(path.join(runTasksDir, `${metadata.run_id}.events.jsonl`), "utf8");
      assert.doesNotMatch(rawEvents, /SECRET_THINKING_SHOULD_NOT_LEAK/);
      assert.doesNotMatch(rawEvents, /thinking_delta|assistantMessageEvent/);
      assert.doesNotMatch(JSON.stringify(metadata.recent_events), /SECRET_THINKING_SHOULD_NOT_LEAK/);
    },
    {
      env: {
        SUBAGENT007_RUN_TASKS_DIR: runTasksDir,
      },
    },
  );
});

test("MCP run_subagent fails fast for known unhealthy one-shot model class", async () => {
  await connectFakeClient(async (client, { projectDir, fakeLogPath, modelHealthPath }) => {
    await fs.writeFile(
      modelHealthPath,
      `${JSON.stringify([
        {
          schema_version: 1,
          model_class: "A",
          resolved_model: "openrouter/qwen/qwen3.6-35b-a3b",
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
        one_shot_health?: {
          status: string;
          usable_for_one_shot: boolean | null;
          health_basis: string;
          health_gate: string;
          health_action: string;
          last_failure_class?: string;
        };
      }>;
    }).model_classes.find((entry) => entry.class === "A");
    assert.equal(classA?.one_shot_health?.status, "unhealthy");
    assert.equal(classA?.one_shot_health?.usable_for_one_shot, false);
    assert.equal(classA?.one_shot_health?.health_basis, "cached_probe");
    assert.equal(classA?.one_shot_health?.health_gate, "blocks_only_known_unhealthy");
    assert.match(classA?.one_shot_health?.health_action ?? "", /--model-class A/);
    assert.equal(classA?.one_shot_health?.last_failure_class, "timeout");

    const response = await client.callTool({
      name: "run_subagent",
      arguments: {
        cwd: projectDir,
        prompt: "FAST",
        run_kind: "quick_noninteractive",
        model_class: "A",
      },
    });
    assert.notEqual(response.isError, true);
    assert.equal((response.structuredContent as { kind?: string }).kind, "preflight_rejected");
    assert.equal((response.structuredContent as { child_started?: boolean }).child_started, false);
    const content = response.content as Array<{ type: string; text?: string }>;
    assert.match(
      content[0]?.type === "text" ? (content[0].text ?? "") : "",
      /known unhealthy for run_subagent one-shot/,
    );
    await assert.rejects(fs.stat(fakeLogPath), /ENOENT/);
  });
});

test("MCP run_subagent auto-promotes broad analysis prompts to a cancellable durable run", async () => {
  await connectFakeClient(async (client, { projectDir, fakeLogPath }) => {
    const response = await client.callTool({
      name: "run_subagent",
      arguments: {
        cwd: projectDir,
        prompt: "CANCEL_WAIT Investigate the HORCs and SAFs across this repo and produce an implementation plan.",
        run_kind: "quick_noninteractive",
      },
    });
    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as RunSubagentMetadata;
    assert.equal(metadata.status, "working");
    assert.equal(metadata.auto_promoted_from, "run_subagent");
    assert.equal(metadata.promotion_reason_code, "broad_work");
    assert.equal(metadata.poll_with, "get_run");
    assert.equal(metadata.cancel_with, "cancel_run");
    await waitForFileText(fakeLogPath, /Investigate the HORCs and SAFs/);

    const cancelled = await client.callTool({
      name: "cancel_run",
      arguments: { run_id: metadata.run_id },
    });
    assert.notEqual(cancelled.isError, true);
    assertCancellationInProgressOrSettled(cancelled.structuredContent as RunSubagentMetadata);
  });
});

test("MCP run_subagent auto-promotes artifact verification scans before one-shot timeout", async () => {
  await connectFakeClient(async (client, { projectDir }) => {
    const response = await client.callTool({
      name: "run_subagent",
      arguments: {
        cwd: projectDir,
        prompt: "Artifact verification scan A: review docs/DOCTRINE_FULL.md against docs/ARCHITECTURE_FULL.md.",
        run_kind: "quick_noninteractive",
      },
    });
    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as RunSubagentMetadata;
    assert.equal(metadata.auto_promoted_from, "run_subagent");
    assert.equal(metadata.promotion_reason_code, "broad_work");
    assert.equal(metadata.requested_timeout_ms, null);
    assert.equal(metadata.resolved_timeout_ms, null);
    assert.equal(metadata.effective_timeout_ms, null);
  });
});

test("MCP run_subagent auto-promotes lexical broad-work false positives instead of rejecting them", async () => {
  await connectFakeClient(async (client, { projectDir }) => {
    const response = await client.callTool({
      name: "run_subagent",
      arguments: {
        cwd: projectDir,
        prompt: "FAST Check the saf-ninja fixture.",
        run_kind: "quick_noninteractive",
      },
    });
    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as RunSubagentMetadata;
    assert.equal(metadata.status, "completed");
    assert.equal(metadata.success, true);
    assert.equal(metadata.promotion_reason_code, "broad_work");
    assert.equal(metadata.requested_timeout_ms, null);
    assert.equal(metadata.resolved_timeout_ms, null);
    assert.equal(metadata.effective_timeout_ms, null);
    assert.equal(await fs.readFile(metadata.output_path, "utf8"), "FAST FINAL");
  });
});

test("MCP schedule_run does not hard-reject lexical broad-work false positives with timeout_ms", async () => {
  await connectFakeClient(async (client, { projectDir, fakeLogPath }) => {
    const response = await client.callTool({
      name: "schedule_run",
      arguments: {
        cwd: projectDir,
        prompt: "FAST Check the saf-ninja fixture.",
        wait_ms: 2_000,
        timeout_ms: 90_000,
      },
    });
    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as RunSubagentMetadata;
    assert.equal(metadata.status, "completed");
    assert.equal(metadata.success, true);
    assert.equal(metadata.reason_code, undefined);
    assert.equal(metadata.requested_timeout_ms, 90_000);
    assert.equal(metadata.resolved_timeout_ms, 90_000);
    assert.equal(await fs.readFile(metadata.output_path, "utf8"), "FAST FINAL");
    const logs = await readJsonl<{ request: { prompt: string } }>(fakeLogPath);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].request.prompt, "FAST Check the saf-ninja fixture.");
  });
});

test("MCP run_subagent auto-promotes edit prompts because write tools are available", async () => {
  await connectFakeClient(async (client, { projectDir, fakeLogPath }) => {
    const response = await client.callTool({
      name: "run_subagent",
      arguments: {
        cwd: projectDir,
        prompt: "FAST implement a tiny fixture change.",
        run_kind: "quick_noninteractive",
      },
    });
    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as RunSubagentMetadata;
    assert.equal(metadata.status, "completed");
    assert.equal(metadata.success, true);
    assert.equal(metadata.promotion_reason_code, "workspace_write");

    const logs = await readJsonl<{ request: Record<string, unknown> }>(fakeLogPath);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].request.toolProfile, "all");
  });
});

test("MCP schedule_run returns completed output when the durable task finishes within wait_ms", async () => {
  await connectFakeClient(async (client, { projectDir }) => {
    const response = await client.callTool({
      name: "schedule_run",
      arguments: {
        cwd: projectDir,
        prompt: "FAST",
        wait_ms: 1000,
      },
    });
    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as RunSubagentMetadata;
    assert.equal(metadata.status, "completed");
    assert.equal(metadata.success, true);
    assert.equal(await fs.readFile(metadata.output_path, "utf8"), "FAST FINAL");
  });
});

test("MCP schedule_run rejects deadline-risk work with underbudget hard timeout before child spawn", async () => {
  await connectFakeClient(async (client, { projectDir, fakeLogPath }) => {
    const response = await client.callTool({
      name: "schedule_run",
      arguments: {
        cwd: projectDir,
        prompt: "Verify the implementation against the requirements before merging.",
        wait_ms: 0,
        timeout_ms: 90_000,
      },
    });
    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as {
      kind?: string;
      child_started?: boolean;
      reason_code?: string;
      retry_guidance?: string;
      message?: string;
    };
    assert.equal(metadata.kind, "preflight_rejected");
    assert.equal(metadata.child_started, false);
    assert.equal(metadata.reason_code, "timeout_underbudget_for_deadline_risk");
    assert.match(metadata.retry_guidance ?? "", /Use wait_ms/);
    assert.match(metadata.message ?? "", /minimum_timeout_ms=600000/);
    const logs = await readJsonl(fakeLogPath).catch(() => []);
    assert.equal(logs.length, 0);
  });
});

test("MCP session tools reject deadline-risk work with underbudget hard timeout before child spawn", async () => {
  await connectFakeClient(async (client, { projectDir, fakeLogPath }) => {
    for (const tool of ["start_session_run", "run_subagent_session"] as const) {
      const response = await client.callTool({
        name: tool,
        arguments: {
          cwd: projectDir,
          prompt: "Review the implementation for correctness against the requirements.",
          session_key: `mcp-session:underbudget-${tool}`,
          resume_mode: "new",
          timeout_ms: 90_000,
        },
      });
      assert.notEqual(response.isError, true);
      const metadata = response.structuredContent as {
        kind?: string;
        child_started?: boolean;
        reason_code?: string;
        retry_guidance?: string;
        message?: string;
      };
      assert.equal(metadata.kind, "preflight_rejected");
      assert.equal(metadata.child_started, false);
      assert.equal(metadata.reason_code, "timeout_underbudget_for_deadline_risk");
      assert.match(metadata.retry_guidance ?? "", /Use wait_ms/);
      assert.match(metadata.message ?? "", new RegExp(`tool=${tool}`));
    }
    const logs = await readJsonl(fakeLogPath).catch(() => []);
    assert.equal(logs.length, 0);
  });
});

test("MCP schedule_run starts broad work durably without run_subagent preflight rejection", async () => {
  await connectFakeClient(async (client, { projectDir, fakeLogPath }) => {
    const response = await client.callTool({
      name: "schedule_run",
      arguments: {
        cwd: projectDir,
        prompt: "HEARTBEAT_LONG_WAIT Investigate HORCs and SAFs into an implementation plan",
        wait_ms: 0,
      },
    });
    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as RunSubagentMetadata;
    assert.equal(metadata.status, "working");
    assert.equal(metadata.active_phase, "running_silent");
    assert.equal(metadata.last_progress_message, "child process running; waiting for output");
    await waitForFileText(fakeLogPath, /Investigate HORCs and SAFs/);
    const terminal = await waitForTerminalRun(client, metadata.run_id);
    assert.equal(terminal.status, "completed");
  });
});

test("MCP schedule_run caps long wait windows and returns a pollable run identity", async () => {
  await connectFakeClient(
    async (client, { projectDir }) => {
      const startedAt = Date.now();
      const response = await client.callTool({
        name: "schedule_run",
        arguments: {
          cwd: projectDir,
          prompt: "HEARTBEAT_LONG_WAIT",
          wait_ms: 5000,
        },
      });
      const elapsedMs = Date.now() - startedAt;
      assert.notEqual(response.isError, true);
      const metadata = response.structuredContent as RunSubagentMetadata;
      assert.equal(metadata.status, "working");
      assert.equal(metadata.requested_wait_ms, 5000);
      assert.equal(metadata.effective_wait_ms, 25);
      assert.equal(metadata.wait_truncated, true);
      assert.equal(elapsedMs < 250, true);

      const terminal = await waitForTerminalRun(client, metadata.run_id);
      assert.equal(terminal.status, "completed");
    },
    {
      env: {
        SUBAGENT007_SCHEDULE_RUN_MAX_WAIT_MS: "25",
      },
    },
  );
});

test("MCP schedule_run supports caller input through the durable run mailbox", async () => {
  await connectFakeClient(async (client, { projectDir }) => {
    const startedResponse = await client.callTool({
      name: "schedule_run",
      arguments: {
        cwd: projectDir,
        prompt: "HEARTBEAT_LONG_WAIT",
        wait_ms: 0,
      },
    });
    assert.notEqual(startedResponse.isError, true);
    const started = startedResponse.structuredContent as RunSubagentMetadata;
    const mailboxRoot = path.dirname(started.input_requests_dir);
    const request = await createInputRequest({
      mailboxRoot,
      runId: started.run_id,
      question: "Need clarification?",
    });

    const inputRequired = await waitForInputRequired(client, started.run_id);
    assert.equal(inputRequired.input_requests.some((input) => input.request_id === request.request_id), true);

    const answerResponse = await client.callTool({
      name: "answer_run_input",
      arguments: {
        run_id: started.run_id,
        request_id: request.request_id,
        answer: "continue",
      },
    });
    assert.notEqual(answerResponse.isError, true);
    const answered = answerResponse.structuredContent as RunSubagentMetadata;
    assert.equal(answered.status, "working");
    const terminal = await waitForTerminalRun(client, started.run_id);
    assert.equal(terminal.status, "completed");
  });
});

test("MCP schedule_run returns input_required without waiting for the full grace window", async () => {
  await connectFakeClient(async (client, { projectDir }) => {
    const startedAt = Date.now();
    const startedResponse = await client.callTool({
      name: "schedule_run",
      arguments: {
        cwd: projectDir,
        prompt: "REQUEST_INPUT_WAIT",
        wait_ms: 1500,
      },
    });
    const elapsedMs = Date.now() - startedAt;
    assert.notEqual(startedResponse.isError, true);
    const started = startedResponse.structuredContent as RunSubagentMetadata;
    assert.equal(started.status, "input_required");
    assert.equal(started.input_requests.some((input) => input.status === "pending"), true);
    assert.equal(elapsedMs < 800, true);

    const cancelResponse = await client.callTool({
      name: "cancel_run",
      arguments: { run_id: started.run_id },
    });
    assert.notEqual(cancelResponse.isError, true);
  });
});

test("MCP schedule_run tasks can be cancelled", async () => {
  await connectFakeClient(async (client, { projectDir }) => {
    const startedResponse = await client.callTool({
      name: "schedule_run",
      arguments: {
        cwd: projectDir,
        prompt: "CANCEL_WAIT",
        wait_ms: 0,
      },
    });
    assert.notEqual(startedResponse.isError, true);
    const started = startedResponse.structuredContent as RunSubagentMetadata;

    const cancelResponse = await client.callTool({
      name: "cancel_run",
      arguments: { run_id: started.run_id },
    });
    assert.notEqual(cancelResponse.isError, true);
    const cancelled = cancelResponse.structuredContent as RunSubagentMetadata;
    assertCancellationInProgressOrSettled(cancelled);
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
    assert.equal(["running_silent", "completed"].includes(started.active_phase ?? ""), true);
    assert.equal(typeof started.last_phase_at, "string");

    const terminal = await waitForTerminalRun(client, started.run_id);
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.active_phase, "completed");
    assert.equal(terminal.success, true);
    assert.equal(await fs.readFile(terminal.output_path, "utf8"), "FAST FINAL");
    assert.equal(terminal.contract_name, "subagent007.durable_run");
    assert.equal(terminal.contract_version, 1);
    assert.equal(terminal.output_references?.length, 1);
    assert.equal(terminal.output_references?.[0].kind, "file");
    assert.equal(terminal.output_references?.[0].path, terminal.output_path);
    assert.equal(terminal.output_references?.[0].output_mode, terminal.written_output_mode);
    assert.equal(terminal.output_references?.[0].size_bytes, Buffer.byteLength("FAST FINAL", "utf8"));
  });
});

test("MCP start_run resolves skill_name before child spawn and passes the resolved skill path", async () => {
  const skillsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-mcp-skills-"));
  const skillPath = await writeSkillFixture(skillsRoot, "requested-skill");
  await connectFakeClient(
    async (client, { projectDir, fakeLogPath }) => {
      const response = await client.callTool({
        name: "start_run",
        arguments: {
          cwd: projectDir,
          prompt: "FAST",
          skill_name: "requested-skill",
        },
      });
      assert.notEqual(response.isError, true);
      const metadata = response.structuredContent as RunSubagentMetadata;
      const terminal = await waitForTerminalRun(client, metadata.run_id);
      assert.equal(terminal.status, "completed");
      assert.equal(terminal.requested_skill, "requested-skill");
      assert.equal(terminal.resolved_skill_path, skillPath);
      assert.equal(terminal.resolved_skill_sha256, await sha256File(skillPath));

      const logs = await readJsonl<{ request: Record<string, unknown> }>(fakeLogPath);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].request.skill, "requested-skill");
      assert.equal(logs[0].request.skillFilePath, skillPath);
    },
    {
      env: {
        SUBAGENT007_PI_SKILL_PATHS: skillsRoot,
      },
    },
  );
});

test("MCP start_run rejects unknown skill_name before child spawn", async () => {
  const skillsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-empty-skills-"));
  await connectFakeClient(
    async (client, { projectDir, fakeLogPath }) => {
      const response = await client.callTool({
        name: "start_run",
        arguments: {
          cwd: projectDir,
          prompt: "FAST",
          skill_name: "missing-skill",
        },
      });
      assert.notEqual(response.isError, true);
      const metadata = response.structuredContent as {
        kind?: string;
        child_started?: boolean;
        message?: string;
      };
      assert.equal(metadata.kind, "preflight_rejected");
      assert.equal(metadata.child_started, false);
      assert.match(metadata.message ?? "", /unknown skill "missing-skill"/);
      await assert.rejects(fs.stat(fakeLogPath), /ENOENT/);
    },
    {
      env: {
        SUBAGENT007_PI_SKILL_PATHS: skillsRoot,
      },
    },
  );
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
      const silentDeadline = Date.now() + 2000;
      let silentView = started;
      while (silentView.status === "working" && silentView.active_phase !== "running_silent" && Date.now() < silentDeadline) {
        const response = await client.callTool({
          name: "get_run",
          arguments: { run_id: started.run_id },
        });
        assert.notEqual(response.isError, true);
        silentView = response.structuredContent as RunSubagentMetadata;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(silentView.heartbeat_count, 0);
      assert.equal(silentView.active_phase, "running_silent");
      assert.equal(typeof silentView.elapsed_ms, "number");
      assert.equal(typeof silentView.last_progress_at, "string");
      assert.equal(silentView.last_progress_message, "child process running; waiting for output");

      const heartbeat = await waitForActiveHeartbeat(client, started.run_id);
      assert.equal(heartbeat.status, "working");
      assert.equal(heartbeat.active_phase, "running");
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
        if (metadata.status === "input_required") {
          pendingView = metadata;
          break;
        }
        if (metadata.status === "completed" || metadata.status === "failed" || metadata.status === "cancelled" || metadata.status === "timed_out") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      assert.ok(pendingView);
      assert.equal(pendingView.status, "input_required");
      assert.equal(pendingView.active_phase, "input_required");
      assert.ok(pendingView.input_requests.some((entry) => entry.request_id === request.request_id));

      const answerResponse = await client.callTool({
        name: "answer_run_input",
        arguments: {
          run_id: started.run_id,
          request_id: request.request_id,
          answer: "continue",
        },
      });
      assert.notEqual(answerResponse.isError, true);
      const answeredView = answerResponse.structuredContent as RunSubagentMetadata;
      assert.equal(answeredView.status, "working");
      assert.equal(answeredView.active_phase, "running");

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

test("MCP start_run/get_run exposes sanitized active public events", async () => {
  await connectFakeClient(async (client, { projectDir }) => {
    const startedResponse = await client.callTool({
      name: "start_run",
      arguments: {
        cwd: projectDir,
        prompt: "TIMEOUT_ASSISTANT_EVENT",
      },
    });
    assert.notEqual(startedResponse.isError, true);
    const started = startedResponse.structuredContent as RunSubagentMetadata;

    const deadline = Date.now() + 2000;
    let eventView: RunSubagentMetadata | undefined;
    while (Date.now() < deadline) {
      const response = await client.callTool({
        name: "get_run",
        arguments: { run_id: started.run_id },
      });
      assert.notEqual(response.isError, true);
      const metadata = response.structuredContent as RunSubagentMetadata;
      if (metadata.recent_events?.some((event) => /PUBLIC PARTIAL ASSISTANT/.test(event.text))) {
        eventView = metadata;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.ok(eventView);
    assert.match(eventView.last_public_output_excerpt ?? "", /PUBLIC PARTIAL ASSISTANT/);
    assert.doesNotMatch(JSON.stringify(eventView.recent_events), /thinking_delta|SECRET_THINKING/);
    await client.callTool({ name: "cancel_run", arguments: { run_id: started.run_id } });
  });
});

test("MCP start_session_run exposes running_silent before first child output", async () => {
  await connectFakeClient(
    async (client, { projectDir }) => {
      const startedResponse = await client.callTool({
        name: "start_session_run",
        arguments: {
          cwd: projectDir,
          prompt: "HEARTBEAT_LONG_WAIT",
          session_key: "mcp-session:silent",
          resume_mode: "new",
        },
      });
      assert.notEqual(startedResponse.isError, true);
      const started = startedResponse.structuredContent as RunSubagentMetadata & {
        task_kind?: string;
        session_key?: string;
      };
      assert.equal(started.task_kind, "session");
      assert.equal(started.session_key, "mcp-session:silent");
      assert.equal(started.status, "working");
      assert.equal(started.active_phase, "running_silent");
      assert.equal(started.last_progress_message, "child process running; waiting for output");
      const terminal = await waitForTerminalRun(client, started.run_id);
      assert.equal(terminal.status, "completed");
    },
    {
      env: {
        SUBAGENT007_HEARTBEAT_INTERVAL_MS: "1000",
      },
    },
  );
});

test("MCP start_session_run returns a durable pollable named-session task", async () => {
  await connectFakeClient(async (client, { projectDir }) => {
    const startedResponse = await client.callTool({
      name: "start_session_run",
      arguments: {
        cwd: projectDir,
        prompt: "PACKET_VALID",
        session_key: "mcp-session:T001",
        resume_mode: "new",
        packet_policy: "required",
      },
    });
    assert.notEqual(startedResponse.isError, true);
    const started = startedResponse.structuredContent as RunSubagentMetadata & {
      task_kind?: string;
      session_key?: string;
      packet_parse_status?: string;
    };
    assert.equal(started.task_kind, "session");
    assert.equal(started.session_key, "mcp-session:T001");

    const terminal = await waitForTerminalRun(client, started.run_id) as RunSubagentMetadata & {
      task_kind?: string;
      session_key?: string;
      packet_parse_status?: string;
      run_record?: { success: boolean };
    };
    assert.equal(terminal.task_kind, "session");
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.success, true);
    assert.equal(terminal.session_key, "mcp-session:T001");
    assert.equal(terminal.packet_parse_status, "valid");
    assert.equal(terminal.run_record?.success, true);
    assert.ok(terminal.recent_events?.some((event) => event.event === "packet_accepted"));
    assert.ok(terminal.recent_events?.some((event) => event.text === "[server_contract] packet_policy=required contract_packet_v1 instruction applied"));
    assert.doesNotMatch(JSON.stringify(terminal.recent_events), /<subagent007_contract_packet>/);
  });
});

test("answer_run_input records no answer text in raw public event file", async () => {
  const runTasksDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-input-events-"));
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
      const mailboxRoot = path.dirname(started.input_requests_dir);
      const request = await createInputRequest({
        mailboxRoot,
        runId: started.run_id,
        question: "Need secret?",
      });

      const answerResponse = await client.callTool({
        name: "answer_run_input",
        arguments: {
          run_id: started.run_id,
          request_id: request.request_id,
          answer: "SECRET_ANSWER_SHOULD_NOT_LEAK",
        },
      });
      assert.notEqual(answerResponse.isError, true);
      const rawEvents = await fs.readFile(path.join(runTasksDir, `${started.run_id}.events.jsonl`), "utf8");
      assert.match(rawEvents, /input_answered/);
      assert.doesNotMatch(rawEvents, /SECRET_ANSWER_SHOULD_NOT_LEAK/);
      const terminal = await waitForTerminalRun(client, started.run_id);
      assert.doesNotMatch(JSON.stringify(terminal.recent_events), /SECRET_ANSWER_SHOULD_NOT_LEAK/);
    },
    {
      env: {
        SUBAGENT007_RUN_TASKS_DIR: runTasksDir,
        SUBAGENT007_HEARTBEAT_INTERVAL_MS: "25",
      },
    },
  );
});

test("MCP start_session_run rejects invalid session input before creating a task", async () => {
  await connectFakeClient(async (client, { projectDir }) => {
    const response = await client.callTool({
      name: "start_session_run",
      arguments: {
        cwd: projectDir,
        prompt: "FAST",
        session_key: "bad key with spaces",
      },
    });
    assert.notEqual(response.isError, true);
    assert.equal((response.structuredContent as { kind?: string }).kind, "preflight_rejected");
    assert.equal((response.structuredContent as { child_started?: boolean }).child_started, false);
    const content = response.content as Array<{ type: string; text?: string }>;
    assert.match(
      content[0]?.type === "text" ? (content[0].text ?? "") : "",
      /session_key must start with an ASCII letter or digit/,
    );
  });
});

test("MCP run_subagent_session returns structured preflight rejection for invalid session input", async () => {
  await connectFakeClient(async (client, { projectDir }) => {
    const rawContinuityResponse = await client.callTool({
      name: "run_subagent_session",
      arguments: {
        cwd: projectDir,
        prompt: "FAST",
        session_key: "coherent-execution:T000-continuity",
        continuity: { mode: "fresh" },
      },
    });
    assert.equal(rawContinuityResponse.isError, true);
    const rawContinuityContent = rawContinuityResponse.content as Array<{ type: string; text?: string }>;
    assert.match(
      rawContinuityContent[0]?.type === "text" ? (rawContinuityContent[0].text ?? "") : "",
      /continuity is not supported by run_subagent_session/,
    );

    const response = await client.callTool({
      name: "run_subagent_session",
      arguments: {
        cwd: projectDir,
        prompt: "FAST",
        session_key: "bad key with spaces",
      },
    });
    assert.notEqual(response.isError, true);
    assert.equal((response.structuredContent as { kind?: string }).kind, "preflight_rejected");
    assert.equal((response.structuredContent as { child_started?: boolean }).child_started, false);
    const content = response.content as Array<{ type: string; text?: string }>;
    assert.match(
      content[0]?.type === "text" ? (content[0].text ?? "") : "",
      /session_key must start with an ASCII letter or digit/,
    );
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

test("get_run persists stale active restart drift as terminal failed snapshot", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-stale-run-"));
  const stateDir = path.join(tmp, "state");
  const runTasksDir = path.join(stateDir, "run-tasks");
  const inputRequestsDir = path.join(stateDir, "input-requests");
  const configPath = path.join(stateDir, "config.json");
  const runId = "2026-06-19T000000000Z-stale";
  const inputRequestsRunDir = path.join(inputRequestsDir, runId);
  await fs.mkdir(runTasksDir, { recursive: true });
  await fs.mkdir(inputRequestsRunDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ default_model_class: "C" }));
  await fs.writeFile(
    path.join(runTasksDir, `${runId}.json`),
    `${JSON.stringify({
      run_id: runId,
      task_id: runId,
      task_kind: "run",
      status: "input_required",
      started_at: "2026-06-19T00:00:00.000Z",
      input_requests_dir: inputRequestsRunDir,
      input_requests: [],
      active_phase: "input_required",
      last_phase_at: "2026-06-19T00:00:01.000Z",
    }, null, 2)}\n`,
  );
  const request = await createInputRequest({
    mailboxRoot: inputRequestsDir,
    runId,
    question: "This stale request should close",
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/server.js")],
    env: {
      ...process.env,
      SUBAGENT007_CONFIG_PATH: configPath,
      SUBAGENT007_RUN_TASKS_DIR: runTasksDir,
      SUBAGENT007_INPUT_REQUESTS_DIR: inputRequestsDir,
      SUBAGENT007_FAILURE_LOG: "off",
    },
  });
  const client = new Client({ name: "subagent007-pi-stale-run-test", version: "0.1.0" });
  try {
    await client.connect(transport);
    const response = await client.callTool({
      name: "get_run",
      arguments: { run_id: runId },
    });
    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as RunSubagentMetadata;
    assert.equal(metadata.status, "failed");
    assert.equal(metadata.success, false);
    assert.equal(metadata.error_class, "restart_drift");
    assert.equal(metadata.reason_code, "server_restarted_active_run");
    assert.equal(metadata.contract_name, "subagent007.durable_run");
    assert.equal(metadata.input_requests.some((entry) => entry.status === "pending"), false);
    assert.ok(metadata.input_requests.some((entry) =>
      entry.request_id === request.request_id && entry.status === "closed"
    ));
    assert.ok(metadata.recent_events?.some((event) => event.event === "failed"));

    const persisted = JSON.parse(await fs.readFile(path.join(runTasksDir, `${runId}.json`), "utf8")) as RunSubagentMetadata;
    assert.equal(persisted.status, "failed");
    assert.equal(persisted.error_class, "restart_drift");
    assert.equal(persisted.reason_code, "server_restarted_active_run");

    const secondResponse = await client.callTool({
      name: "get_run",
      arguments: { run_id: runId },
    });
    assert.notEqual(secondResponse.isError, true);
    const second = secondResponse.structuredContent as RunSubagentMetadata;
    assert.equal(second.status, "failed");
    assert.equal(second.finished_at, metadata.finished_at);
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
      assertCancellationInProgressOrSettled(cancelled);
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

      const terminal = await waitForTerminalRun(client, started.run_id);
      assert.equal(terminal.status, "cancelled");
      assert.equal(terminal.active_phase, "cancelled");
      assert.equal(
        (terminal.recent_events ?? []).filter((event) => event.event === "cancellation_settled").length,
        1,
      );
      assert.equal(
        (terminal.recent_events ?? []).filter((event) => event.text === "[subagent007 cancelled]").length,
        0,
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
