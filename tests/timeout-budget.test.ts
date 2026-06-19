import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runChildProcess } from "../src/processRunner.js";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_INTERVAL_ENV,
  heartbeatIntervalMsFromEnv,
} from "../src/progress.js";
import { computeTimeoutBudget, minimumRequestedTimeoutMs } from "../src/timeoutBudget.js";
import { createFakePiChild } from "./helpers/fakePiChild.js";

type RunSubagentMetadata = {
  run_id: string;
  status: "working" | "input_required" | "completed" | "failed" | "cancelled" | "timed_out";
  output_path: string;
  success: boolean;
  exit_code: number | null;
  timed_out: boolean;
  timeout_recovery_hint?: string;
  partial_output_available: boolean;
  resume_possible: boolean;
  duration_ms: number;
  requested_timeout_ms: number | null;
  resolved_timeout_ms: number | null;
  timeout_floor_ms: number;
  effective_timeout_ms: number | null;
  timeout_headroom_ms: number;
  kill_grace_ms: number;
  force_grace_ms: number;
  written_output_mode: "final" | "transcript";
  active_phase?: string;
  last_phase_at?: string;
  error_class?: string;
  reason_code?: string;
  recent_events?: Array<{ kind: string; event?: string; text: string; occurred_at: string }>;
};

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`deadline exceeded after ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!processIsAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(processIsAlive(pid), false, `expected child process ${pid} to be gone`);
}

async function waitForTerminalRun(client: Client, runId: string, timeoutMs: number): Promise<RunSubagentMetadata> {
  const deadline = Date.now() + timeoutMs;
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

async function createProcessScript(tmpPrefix = "subagent007-process-runner-"): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), tmpPrefix));
  const scriptPath = path.join(tmp, "process-script.cjs");
  await fs.writeFile(
    scriptPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      "const path = require('path');",
      "const { spawn } = require('child_process');",
      "const mode = process.argv[2];",
      "if (mode === 'HEARTBEAT_SLEEP') {",
      "  setTimeout(() => process.stdout.write('HEARTBEAT DONE'), 160);",
      "} else if (mode === 'TIMEOUT_SPAWN_CHILD') {",
      "  process.on('SIGTERM', () => {});",
      "  const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore' });",
      "  fs.writeFileSync(path.join(process.cwd(), 'child.pid'), String(child.pid));",
      "  process.stdout.write('TIMEOUT START\\n' + 'A'.repeat(200000) + '\\n');",
      "  setInterval(() => {}, 1000);",
      "} else {",
      "  process.stdout.write('FAST FINAL');",
      "}",
      "",
    ].join("\n"),
  );
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

test("start_run returns timeout metadata and transcript before caller deadline", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-timeout-"));
  const projectDir = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const runsDir = path.join(stateDir, "runs");
  const configPath = path.join(stateDir, "config.json");
  const failureLogPath = path.join(stateDir, "failures.jsonl");
  const childPidPath = path.join(projectDir, "child.pid");
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
      SUBAGENT007_RUNS_DIR: runsDir,
      SUBAGENT007_FAILURE_LOG_PATH: failureLogPath,
      SUBAGENT007_PI_CHILD_PATH: fake.childPath,
      FAKE_PI_LOG_PATH: fake.logPath,
      SUBAGENT007_MIN_REQUESTED_TIMEOUT_MS: "0",
      SUBAGENT007_TIMEOUT_RESPONSE_HEADROOM_MS: "500",
      SUBAGENT007_TIMEOUT_KILL_GRACE_MS: "100",
      SUBAGENT007_TIMEOUT_FORCE_GRACE_MS: "100",
    },
  });
  const client = new Client({ name: "subagent007-pi-timeout-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    const startedAt = Date.now();
    const startResponse = await withDeadline(
      client.callTool({
        name: "start_run",
        arguments: {
          cwd: projectDir,
          prompt: "TIMEOUT_SPAWN_CHILD",
          output_mode: "final",
          timeout_ms: 2500,
        },
      }),
      250,
    );
    assert.notEqual(startResponse.isError, true);
    const started = startResponse.structuredContent as RunSubagentMetadata;
    const metadata = await withDeadline(waitForTerminalRun(client, started.run_id, 2300), 2300);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(metadata.success, false);
    assert.equal(metadata.status, "timed_out");
    assert.equal(metadata.timed_out, true);
    assert.equal(metadata.error_class, "timeout");
    assert.equal(metadata.reason_code, "timeout");
    assert.equal(metadata.active_phase, "timed_out");
    assert.equal(typeof metadata.last_phase_at, "string");
    assert.equal(metadata.timeout_recovery_hint, undefined);
    assert.equal(metadata.partial_output_available, false);
    assert.equal(metadata.resume_possible, false);
    assert.equal(metadata.requested_timeout_ms, 2500);
    assert.equal(metadata.resolved_timeout_ms, 2500);
    assert.equal(metadata.timeout_floor_ms, 0);
    assert.equal(metadata.effective_timeout_ms, 1800);
    assert.equal(metadata.timeout_headroom_ms, 500);
    assert.equal(metadata.kill_grace_ms, 100);
    assert.equal(metadata.force_grace_ms, 100);
    assert.equal(metadata.written_output_mode, "transcript");
    assert.equal(
      (metadata.recent_events ?? []).filter((event) => event.event === "timeout").length,
      1,
    );
    assert.equal(
      (metadata.recent_events ?? []).filter((event) => event.text.startsWith("[subagent007 timeout]")).length,
      0,
    );
    assert.equal(path.dirname(metadata.output_path), runsDir);
    assert.equal(elapsedMs < 2300, true);

    const output = await fs.readFile(metadata.output_path, "utf8");
    assert.match(output, /TIMEOUT START/);
    assert.match(
      output,
      /\[subagent007 timeout\] requested_timeout_ms=2500 resolved_timeout_ms=2500 timeout_floor_ms=0 effective_timeout_ms=1800/,
    );
    assert.equal(output.length > 100000, true);

    const childPid = Number(await fs.readFile(childPidPath, "utf8"));
    assert.equal(Number.isInteger(childPid), true);
    await waitForProcessExit(childPid);
  } finally {
    await client.close();
  }
});

test("start_run treats timeout_ms as a hard caller cap", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-timeout-hard-cap-"));
  const projectDir = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const runsDir = path.join(stateDir, "runs");
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
      SUBAGENT007_RUNS_DIR: runsDir,
      SUBAGENT007_FAILURE_LOG_PATH: failureLogPath,
      SUBAGENT007_PI_CHILD_PATH: fake.childPath,
      FAKE_PI_LOG_PATH: fake.logPath,
      SUBAGENT007_MIN_REQUESTED_TIMEOUT_MS: "0",
      SUBAGENT007_TIMEOUT_RESPONSE_HEADROOM_MS: "500",
      SUBAGENT007_TIMEOUT_KILL_GRACE_MS: "100",
      SUBAGENT007_TIMEOUT_FORCE_GRACE_MS: "100",
    },
  });
  const client = new Client({ name: "subagent007-pi-timeout-hard-cap-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    const startResponse = await withDeadline(
      client.callTool({
        name: "start_run",
        arguments: {
          cwd: projectDir,
          prompt: "FAST",
          output_mode: "final",
          timeout_ms: 2500,
        },
      }),
      1000,
    );
    assert.notEqual(startResponse.isError, true);
    const started = startResponse.structuredContent as RunSubagentMetadata;
    const metadata = await withDeadline(waitForTerminalRun(client, started.run_id, 1000), 1000);

    assert.equal(metadata.success, true);
    assert.equal(metadata.timed_out, false);
    assert.equal(metadata.requested_timeout_ms, 2500);
    assert.equal(metadata.resolved_timeout_ms, 2500);
    assert.equal(metadata.timeout_floor_ms, 0);
    assert.equal(metadata.effective_timeout_ms, 1800);
    assert.equal(metadata.timeout_headroom_ms, 500);
    assert.equal(metadata.kill_grace_ms, 100);
    assert.equal(metadata.force_grace_ms, 100);
  } finally {
    await client.close();
  }
});

test("runChildProcess emits optional heartbeats without changing process output", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-heartbeat-"));
  const projectDir = path.join(tmp, "project");
  const scriptPath = await createProcessScript();
  await fs.mkdir(projectDir, { recursive: true });

  const beats: number[] = [];
  const result = await runChildProcess({
    command: process.execPath,
    args: [scriptPath, "HEARTBEAT_SLEEP"],
    cwd: projectDir,
    timeoutBudget: computeTimeoutBudget(2000, {
      responseHeadroomMs: 100,
      killGraceMs: 100,
      forceGraceMs: 100,
    }),
    heartbeat: {
      intervalMs: 25,
      notify: (beat) => {
        beats.push(beat);
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(await fs.readFile(result.outputPath, "utf8"), "HEARTBEAT DONE");
  assert.equal(beats.length > 0, true);
  assert.deepEqual(beats, Array.from({ length: beats.length }, (_, index) => index + 1));
});

test("heartbeat interval env accepts only positive safe integers", () => {
  const original = process.env[HEARTBEAT_INTERVAL_ENV];
  try {
    delete process.env[HEARTBEAT_INTERVAL_ENV];
    assert.equal(heartbeatIntervalMsFromEnv(), DEFAULT_HEARTBEAT_INTERVAL_MS);

    process.env[HEARTBEAT_INTERVAL_ENV] = "250";
    assert.equal(heartbeatIntervalMsFromEnv(), 250);

    for (const value of ["0", "-1", "1.5", "abc", ""]) {
      process.env[HEARTBEAT_INTERVAL_ENV] = value;
      assert.equal(heartbeatIntervalMsFromEnv(), DEFAULT_HEARTBEAT_INTERVAL_MS, value);
    }
  } finally {
    if (original === undefined) {
      delete process.env[HEARTBEAT_INTERVAL_ENV];
    } else {
      process.env[HEARTBEAT_INTERVAL_ENV] = original;
    }
  }
});

test("minimum requested timeout preserves at least one millisecond of child runtime", () => {
  assert.equal(
    minimumRequestedTimeoutMs({
      responseHeadroomMs: 500,
      killGraceMs: 100,
      forceGraceMs: 100,
    }),
    701,
  );
  assert.equal(
    minimumRequestedTimeoutMs({
      minRequestedTimeoutMs: 2000,
      responseHeadroomMs: 500,
      killGraceMs: 100,
      forceGraceMs: 100,
    }),
    2000,
  );
});

test("runChildProcess swallows heartbeat failures", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-heartbeat-failure-"));
  const projectDir = path.join(tmp, "project");
  const scriptPath = await createProcessScript();
  await fs.mkdir(projectDir, { recursive: true });

  let attempts = 0;
  const result = await runChildProcess({
    command: process.execPath,
    args: [scriptPath, "HEARTBEAT_SLEEP"],
    cwd: projectDir,
    timeoutBudget: computeTimeoutBudget(2000, {
      responseHeadroomMs: 100,
      killGraceMs: 100,
      forceGraceMs: 100,
    }),
    heartbeat: {
      intervalMs: 25,
      notify: async () => {
        attempts += 1;
        throw new Error("progress failed");
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(await fs.readFile(result.outputPath, "utf8"), "HEARTBEAT DONE");
  assert.equal(attempts > 0, true);
});

test("runChildProcess clears heartbeat interval after timeout", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-heartbeat-timeout-"));
  const projectDir = path.join(tmp, "project");
  const scriptPath = await createProcessScript();
  await fs.mkdir(projectDir, { recursive: true });

  let beats = 0;
  const result = await runChildProcess({
    command: process.execPath,
    args: [scriptPath, "TIMEOUT_SPAWN_CHILD"],
    cwd: projectDir,
    timeoutBudget: computeTimeoutBudget(220, {
      minRequestedTimeoutMs: 0,
      responseHeadroomMs: 100,
      killGraceMs: 50,
      forceGraceMs: 50,
    }),
    heartbeat: {
      intervalMs: 20,
      notify: () => {
        beats += 1;
      },
    },
  });
  const beatsAtFinish = beats;
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(result.timedOut, true);
  assert.ok(["SIGTERM", "SIGKILL"].includes(result.stopSignal ?? ""));
  assert.match(await fs.readFile(result.outputPath, "utf8"), /\[subagent007 timeout\]/);
  assert.equal(beatsAtFinish > 0, true);
  assert.equal(beats, beatsAtFinish);
});
