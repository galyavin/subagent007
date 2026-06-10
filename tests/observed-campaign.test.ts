import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const harnessPath = path.resolve("scripts/run-observed-campaign.mjs");

type HarnessResult = {
  campaign_id: string;
  state_root: string;
  failure_log_path: string;
  runs_dir: string;
  run_tasks_dir: string;
  input_requests_dir: string;
  sessions_dir: string;
  pi_raw_sessions_dir: string;
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
    "  runs_dir: process.env.SUBAGENT007_RUNS_DIR,",
    "  run_tasks_dir: process.env.SUBAGENT007_RUN_TASKS_DIR,",
    "  input_requests_dir: process.env.SUBAGENT007_INPUT_REQUESTS_DIR,",
    "  sessions_dir: process.env.SUBAGENT007_SESSIONS_DIR,",
    "  pi_raw_sessions_dir: process.env.SUBAGENT007_PI_RAW_SESSIONS_DIR,",
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
  const childEnv = JSON.parse(await fs.readFile(envPath, "utf8")) as Record<string, string>;
  assert.equal(childEnv.campaign_id, "campaign.test-1");
  assert.equal(childEnv.failure_log_path, summary.failure_log_path);
  assert.notEqual(childEnv.failure_log_path, productionLogPath);
  assert.equal(await fs.readFile(productionLogPath, "utf8"), "production stays here\n");

  for (const statePath of [
    summary.failure_log_path,
    summary.runs_dir,
    summary.run_tasks_dir,
    summary.input_requests_dir,
    summary.sessions_dir,
    summary.pi_raw_sessions_dir,
  ]) {
    assert.equal(statePath.startsWith(`${summary.state_root}${path.sep}`), true, statePath);
  }
  assert.equal(childEnv.runs_dir, summary.runs_dir);
  assert.equal(childEnv.run_tasks_dir, summary.run_tasks_dir);
  assert.equal(childEnv.input_requests_dir, summary.input_requests_dir);
  assert.equal(childEnv.sessions_dir, summary.sessions_dir);
  assert.equal(childEnv.pi_raw_sessions_dir, summary.pi_raw_sessions_dir);
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
  assert.equal(summary.archive?.result?.archived, true);
  assert.equal(summary.archive?.result?.log_path, summary.failure_log_path);
  await assert.rejects(fs.stat(summary.failure_log_path), /ENOENT/);
});
