import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRecursiveRejoinTool } from "../src/recursiveDelegateTool.js";
import { createFakePiChild } from "./helpers/fakePiChild.js";

type RunView = {
  run_id: string;
  status: string;
  success: boolean;
  descendant_run_ids?: string[];
  descendant_terminal_statuses?: Record<string, string>;
  output_references?: Array<{
    name: string;
    relative_path: string;
  }>;
};

function outputPathFor(view: RunView, runsDir: string): string {
  const primary = view.output_references?.find((reference) => reference.name === "primary");
  assert.ok(primary, "terminal result must preserve the primary output reference");
  return path.join(runsDir, primary.relative_path);
}

async function withFakeClient(run: (client: Client, projectDir: string, runsDir: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-recursive-rejoin-"));
  const projectDir = path.join(root, "project");
  const stateDir = path.join(root, "state");
  const runsDir = path.join(stateDir, "runs");
  const fake = await createFakePiChild("subagent007-recursive-rejoin-child-");
  const configPath = path.join(stateDir, "config.json");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ default_model_class: "C" }), "utf8");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.resolve("src/server.ts")],
    env: {
      ...process.env,
      SUBAGENT007_CONFIG_PATH: configPath,
      SUBAGENT007_PI_CHILD_PATH: fake.childPath,
      FAKE_PI_LOG_PATH: fake.logPath,
      SUBAGENT007_FAILURE_LOG: "off",
      SUBAGENT007_RECORD_SOURCE: "test",
      SUBAGENT007_MODEL_HEALTH_PATH: path.join(stateDir, "model-health.json"),
      SUBAGENT007_RUN_TASKS_DIR: path.join(stateDir, "run-tasks"),
      SUBAGENT007_INPUT_REQUESTS_DIR: path.join(stateDir, "input-requests"),
      SUBAGENT007_ACTIVE_CHILDREN_DIR: path.join(stateDir, "active-children"),
      SUBAGENT007_QUEUED_RUNS_DIR: path.join(stateDir, "queued-runs"),
      SUBAGENT007_RUNS_DIR: runsDir,
      SUBAGENT007_SESSIONS_DIR: path.join(stateDir, "sessions"),
      SUBAGENT007_PI_RAW_SESSIONS_DIR: path.join(stateDir, "pi-sessions"),
      SUBAGENT007_SKILL_SNAPSHOTS_DIR: path.join(stateDir, "skill-snapshots"),
    },
  });
  const client = new Client({ name: "recursive-rejoin-test", version: "0.1.0" });
  try {
    await client.connect(transport);
    await run(client, projectDir, runsDir);
  } finally {
    await client.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(path.dirname(fake.childPath), { recursive: true, force: true });
  }
}

test("rejoin is a minimal child-facing recursive tool", () => {
  const tool = createRecursiveRejoinTool({
    recursiveControl: {
      socket_path: "/tmp/subagent007-recursive-rejoin.sock",
      token: "test-token",
      parent_run_id: "parent-run",
      root_run_id: "root-run",
      recursion_depth: 0,
    },
  });
  assert.ok(tool);
  assert.equal(tool.name, "rejoin");
  assert.match(tool.description, /existing recursive descendant result/i);
  assert.match((tool.promptGuidelines ?? []).join("\n"), /outside this caller's descendant lineage/i);
});

test("recursive callers can rejoin working descendants at each depth and receive terminal output references", async () => {
  await withFakeClient(async (client, projectDir, runsDir) => {
    const response = await client.callTool({
      name: "schedule_run",
      arguments: {
        cwd: projectDir,
        prompt: "RECURSIVE_REJOIN_ROOT",
        recursive_delegation: "enabled",
        wait_ms: 5_000,
      },
    });
    assert.notEqual(response.isError, true);
    const root = response.structuredContent as RunView;
    assert.equal(root.status, "completed", JSON.stringify(root));
    assert.equal(root.success, true);
    assert.equal(root.descendant_run_ids?.length, 2);
    assert.deepEqual(Object.values(root.descendant_terminal_statuses ?? {}), ["completed", "completed"]);

    const rootOutput = JSON.parse(await fs.readFile(outputPathFor(root, runsDir), "utf8")) as {
      initial: RunView;
      rejoined: RunView;
    };
    assert.equal(rootOutput.initial.status, "working");
    assert.equal(rootOutput.rejoined.status, "completed");
    assert.ok(rootOutput.rejoined.output_references?.some((reference) => reference.name === "primary"));

    const childOutput = JSON.parse(
      await fs.readFile(outputPathFor(rootOutput.rejoined, runsDir), "utf8"),
    ) as { initial: RunView; rejoined: RunView };
    assert.equal(childOutput.initial.status, "working");
    assert.equal(childOutput.rejoined.status, "completed");
    assert.ok(childOutput.rejoined.output_references?.some((reference) => reference.name === "primary"));
  });
});

test("recursive rejoin rejects a caller's own non-descendant run ID without exposing its state", async () => {
  await withFakeClient(async (client, projectDir, runsDir) => {
    const response = await client.callTool({
      name: "schedule_run",
      arguments: {
        cwd: projectDir,
        prompt: "RECURSIVE_REJOIN_FOREIGN",
        recursive_delegation: "enabled",
        wait_ms: 2_000,
      },
    });
    assert.notEqual(response.isError, true);
    const root = response.structuredContent as RunView;
    assert.equal(root.status, "completed");
    const output = JSON.parse(await fs.readFile(outputPathFor(root, runsDir), "utf8")) as {
      rejoined: Record<string, unknown>;
    };
    assert.equal(output.rejoined.status, "rejected");
    assert.equal(output.rejoined.reason_code, "recursive_control_invalid");
    assert.equal(Object.hasOwn(output.rejoined, "run_id"), false);
  });
});
