import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
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
    result?: { success: boolean | null };
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

  const handlerError = events.find(
    (event) => event.event === "call_handler_error" && event.scenario === "handler-validation",
  );
  assert.ok(handlerError);
  assert.ok(
    events.some(
      (event) =>
        event.event === "failure_log_delta" &&
        event.call_id === handlerError.call_id &&
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

test("observed MCP probe reports bundled scenario coverage semantics", async () => {
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
      "all-bundled",
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
      scenarios: Array<{ scenario: string; tool: string; surfaces: string[]; evidence_class: string }>;
      evidence_classes: string[];
    };
  };

  assert.equal(summary.scenario_set, "all-bundled");
  assert.equal(summary.mode, "protocol-deterministic");
  assert.deepEqual(summary.scenarios.sort(), [
    "child-failure",
    "handler-validation",
    "packet-failure",
    "schema-error",
    "success",
  ]);
  assert.ok(summary.coverage_summary.covered_surfaces.includes("run_subagent-success"));
  assert.ok(summary.coverage_summary.covered_surfaces_by_evidence_class["protocol-deterministic"].includes("run_subagent-success"));
  assert.ok(summary.coverage_summary.covered_surfaces.includes("run_subagent_session-packet-failure"));
  assert.ok(summary.coverage_summary.uncovered_surfaces.includes("start_run-async-polling"));
  assert.ok(summary.coverage_summary.uncovered_surfaces.includes("installed-pi-integration"));
  assert.equal(summary.coverage_summary.scenarios.every((scenario) => scenario.tool.length > 0), true);
  assert.deepEqual(summary.coverage_summary.evidence_classes, ["protocol-deterministic"]);
  assert.equal(
    summary.coverage_summary.scenarios.every((scenario) => scenario.evidence_class === "protocol-deterministic"),
    true,
  );
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
    /deterministic-only scenarios/,
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
