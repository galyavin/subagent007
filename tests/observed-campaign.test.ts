import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createFakePiChild } from "./helpers/fakePiChild.js";
import { readJsonl, sha256File } from "./helpers/testUtils.js";

const execFileAsync = promisify(execFile);
const harnessPath = path.resolve("scripts/run-observed-campaign.mjs");
const probePath = path.resolve("scripts/run-observed-mcp-probe.mjs");

async function createSourceServerEntrypoint(directory: string): Promise<string> {
  const projectRoot = path.resolve(".");
  const detachedProject = path.join(directory, "compiled-source-server");
  const outputDir = path.join(detachedProject, "dist");
  await fs.mkdir(detachedProject);
  await Promise.all([
    fs.copyFile(path.join(projectRoot, "package.json"), path.join(detachedProject, "package.json")),
    fs.symlink(path.join(projectRoot, "node_modules"), path.join(detachedProject, "node_modules"), "dir"),
  ]);
  await execFileAsync(
    process.execPath,
    [path.join(projectRoot, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(projectRoot, "tsconfig.json"), "--outDir", outputDir, "--noCheck"],
    { cwd: projectRoot, maxBuffer: 10 * 1024 * 1024 },
  );
  return path.join(outputDir, "server.js");
}

async function waitForNoOwnedProcessCommand(identity: string): Promise<void> {
  if (process.platform === "win32") return;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { stdout } = await execFileAsync("ps", ["-ax", "-o", "command="]);
    if (!stdout.split(/\r?\n/).some((line) => line.includes(identity))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`campaign-owned process remains: ${identity}`);
}

async function assertDirectoryEmpty(directory: string): Promise<void> {
  assert.deepEqual(await fs.readdir(directory).catch(() => []), [], directory);
}

async function probeFakeRoots(): Promise<Set<string>> {
  return new Set(
    (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("subagent007-probe-fake-pi-")),
  );
}

function isolatedRuntimeStateEnv(stateDir: string): NodeJS.ProcessEnv {
  return {
    SUBAGENT007_SESSIONS_DIR: path.join(stateDir, "sessions"),
    SUBAGENT007_RUNS_DIR: path.join(stateDir, "runs"),
    SUBAGENT007_RUN_TASKS_DIR: path.join(stateDir, "run-tasks"),
    SUBAGENT007_INPUT_REQUESTS_DIR: path.join(stateDir, "input-requests"),
    SUBAGENT007_PI_RAW_SESSIONS_DIR: path.join(stateDir, "raw-sessions"),
    SUBAGENT007_ACTIVE_CHILDREN_DIR: path.join(stateDir, "active-children"),
    SUBAGENT007_QUEUED_RUNS_DIR: path.join(stateDir, "queued-runs"),
    SUBAGENT007_TEMP_DIR: path.join(stateDir, "tmp"),
    SUBAGENT007_MODEL_HEALTH_PATH: path.join(stateDir, "model-health.json"),
  };
}

async function assertCampaignRuntimeClean(stateDir: string): Promise<void> {
  await Promise.all([
    assertDirectoryEmpty(path.join(stateDir, "active-children")),
    assertDirectoryEmpty(path.join(stateDir, "queued-runs")),
    assertDirectoryEmpty(path.join(stateDir, "input-requests")),
    assertDirectoryEmpty(path.join(stateDir, "raw-sessions")),
    assertDirectoryEmpty(path.join(stateDir, "tmp")),
  ]);
  await waitForNoOwnedProcessCommand(stateDir);
}

function coverageFailureRecord(stderr: string): Record<string, unknown> {
  const line = stderr.split(/\r?\n/).find((entry) => entry.startsWith("{\"record_name\":\"subagent007.observed_coverage_failure\""));
  assert.ok(line, stderr);
  return JSON.parse(line) as Record<string, unknown>;
}

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

function isPrivateCampaignStatePath(filePath: string): boolean {
  const segments = filePath.split(path.sep);
  const basename = path.basename(filePath);
  return segments.includes("input-requests") ||
    segments.includes("pi-raw-sessions") ||
    segments.includes("raw-sessions") ||
    segments.includes("pi-session") ||
    segments.includes("attempt-pi-sessions") ||
    basename === "config.json" ||
    basename === "model-health.json" ||
    basename === "manifest.json";
}

async function readPublicCampaignArtifactTextUnder(root: string): Promise<string> {
  const chunks: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && !isPrivateCampaignStatePath(entryPath)) {
        chunks.push(await fs.readFile(entryPath, "utf8"));
      }
    }
  }
  await walk(root);
  return chunks.join("\n");
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
    "  record_source: process.env.SUBAGENT007_RECORD_SOURCE,",
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
  assert.equal(childEnv.record_source, "test");
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
    result?: { success: boolean | null; kind?: string | null; transcript_redacted?: boolean };
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

  const handlerRejection = events.find(
    (event) => event.event === "call_preflight_rejected" && event.scenario === "handler-validation",
  );
  assert.ok(handlerRejection);
  assert.equal(handlerRejection.result?.kind, "preflight_rejected");
  assert.ok(
    events.some(
      (event) =>
        event.event === "failure_log_delta" &&
        event.call_id === handlerRejection.call_id &&
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

test("observed coverage manifest maps all scenario alias to full-current", async () => {
  const manifest = JSON.parse(
    await fs.readFile(path.resolve("scripts/observed-coverage-manifest.json"), "utf8"),
  ) as {
    aliases: Record<string, string>;
    profiles: Record<string, { mode: string }>;
  };

  assert.equal(manifest.aliases.all, "full-current");
  const targetProfile = manifest.profiles[manifest.aliases.all];
  assert.ok(targetProfile);
  assert.equal(targetProfile.mode, "protocol-deterministic");
});

test("observed MCP probe covers recursive delegate lineage and rejection edges", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-probe-recursive-"));
  const projectDir = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const configPath = path.join(stateDir, "config.json");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ default_model_class: "C" }));
  const sourceServerPath = await createSourceServerEntrypoint(tmp);

  const result = await execFileAsync(
    process.execPath,
    [
      probePath,
      "--server",
      sourceServerPath,
      "--cwd",
      projectDir,
      "--scenario",
      "recursive-delegate-success",
      "--scenario",
      "recursive-delegate-depth-limit",
      "--scenario",
      "recursive-delegate-forged-lineage",
    ],
    {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        SUBAGENT007_CONFIG_PATH: configPath,
        SUBAGENT007_FAILURE_LOG_PATH: path.join(stateDir, "failures.jsonl"),
        SUBAGENT007_CAMPAIGN_LEDGER_PATH: path.join(stateDir, "campaign-ledger.jsonl"),
        SUBAGENT007_SESSIONS_DIR: path.join(stateDir, "sessions"),
        SUBAGENT007_RUNS_DIR: path.join(stateDir, "runs"),
        SUBAGENT007_RUN_TASKS_DIR: path.join(stateDir, "run-tasks"),
        SUBAGENT007_INPUT_REQUESTS_DIR: path.join(stateDir, "input-requests"),
        SUBAGENT007_PI_RAW_SESSIONS_DIR: path.join(stateDir, "raw-sessions"),
        SUBAGENT007_MODEL_HEALTH_PATH: path.join(stateDir, "model-health.json"),
        SUBAGENT007_RECORD_SOURCE: "test",
      },
      maxBuffer: 8 * 1024 * 1024,
    },
  );

  const summary = JSON.parse(result.stdout) as {
    coverage_summary: {
      missing_required_surfaces: string[];
      scenarios: Array<{
        scenario: string;
        evidence_satisfied?: boolean;
        observed_result?: Record<string, unknown>;
      }>;
    };
  };
  assert.deepEqual(summary.coverage_summary.missing_required_surfaces, []);
  const byScenario = new Map(
    summary.coverage_summary.scenarios.map((scenario) => [scenario.scenario, scenario]),
  );

  const success = byScenario.get("recursive-delegate-success")?.observed_result;
  assert.equal(byScenario.get("recursive-delegate-success")?.evidence_satisfied, true);
  assert.equal(success?.delegated_status, "completed");
  assert.equal(success?.delegated_recursion_depth, 1);
  assert.equal(success?.root_child_contains_delegated, true);
  assert.equal(success?.delegated_view_status, "completed");
  assert.equal(success?.delegated_parent_run_id, success?.delegated_view_parent_run_id);
  assert.equal(success?.delegated_root_run_id, success?.delegated_view_root_run_id);
  assert.equal(success?.delegated_recursion_depth, success?.delegated_view_recursion_depth);

  const depthLimit = byScenario.get("recursive-delegate-depth-limit")?.observed_result;
  assert.equal(byScenario.get("recursive-delegate-depth-limit")?.evidence_satisfied, true);
  assert.equal(depthLimit?.delegated_status, "rejected");
  assert.equal(depthLimit?.delegated_kind, "recursive_delegate_rejected");
  assert.equal(depthLimit?.delegated_reason_code, "recursive_depth_exceeded");
  assert.equal(depthLimit?.root_child_run_count, 0);

  const forgedLineage = byScenario.get("recursive-delegate-forged-lineage")?.observed_result;
  assert.equal(byScenario.get("recursive-delegate-forged-lineage")?.evidence_satisfied, true);
  assert.equal(forgedLineage?.delegated_status, "rejected");
  assert.equal(forgedLineage?.delegated_kind, "recursive_delegate_rejected");
  assert.equal(forgedLineage?.delegated_reason_code, "recursive_control_invalid");
  assert.equal(forgedLineage?.root_child_run_count, 0);

  const ledgerText = await fs.readFile(path.join(stateDir, "campaign-ledger.jsonl"), "utf8");
  assert.match(ledgerText, /recursive-delegate-success/);
  assert.match(ledgerText, /recursive-delegate-depth-limit/);
  assert.match(ledgerText, /recursive-delegate-forged-lineage/);

  const publicArtifactText = [
    result.stdout,
    ledgerText,
    await readPublicCampaignArtifactTextUnder(stateDir),
  ].join("\n");
  assert.doesNotMatch(publicArtifactText, /recursiveControl|subagent007-recursive|socket_path|"token"/);
});

test("protocol-deterministic observed MCP probe refuses unscoped failure telemetry", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-unscoped-probe-"));
  const projectDir = path.join(tmp, "project");
  await fs.mkdir(projectDir, { recursive: true });
  const env = { ...process.env };
  delete env.SUBAGENT007_FAILURE_LOG_PATH;
  delete env.SUBAGENT007_CAMPAIGN_LEDGER_PATH;
  delete env.SUBAGENT007_CAMPAIGN_ID;
  delete env.SUBAGENT007_RECORD_SOURCE;

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        probePath,
        "--server",
        path.resolve("dist/server.js"),
        "--cwd",
        projectDir,
        "--scenario",
        "success",
      ],
      {
        cwd: path.resolve("."),
        env,
        maxBuffer: 8 * 1024 * 1024,
      },
    ),
    (error: unknown) => {
      const failed = error as Error & { code?: number; stderr?: string };
      assert.equal(failed.code, 2);
      assert.match(
        failed.stderr ?? "",
        /protocol-deterministic observed probes require SUBAGENT007_FAILURE_LOG_PATH/,
      );
      return true;
    },
  );
});

test("observed MCP probe rejects retired all-bundled alias with protocol-core guidance", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-probe-retired-alias-"));
  const projectDir = path.join(tmp, "project");
  await fs.mkdir(projectDir, { recursive: true });

  for (const args of [
    ["--profile", "all-bundled"],
    ["--scenario", "all-bundled"],
  ]) {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          probePath,
          "--server",
          path.resolve("dist/server.js"),
          "--cwd",
          projectDir,
          ...args,
        ],
        {
          cwd: path.resolve("."),
        },
      ),
      /all-bundled is retired; use --profile protocol-core/,
    );
  }
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
    /incompatible scenarios/,
  );
});

test("observed MCP probe keeps old live profile names as compatibility aliases", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-probe-live-alias-"));
  const projectDir = path.join(tmp, "project");
  await fs.mkdir(projectDir, { recursive: true });

  for (const profile of ["live-smoke", "stateful-live"]) {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          probePath,
          "--server",
          path.resolve("dist/server.js"),
          "--cwd",
          projectDir,
          "--profile",
          profile,
          "--scenario",
          "child-failure",
        ],
        {
          cwd: path.resolve("."),
        },
      ),
      /live-model mode cannot run incompatible scenarios: child-failure/,
    );
  }
});

test("observed MCP probe self-check fails when manifest omits a SAF-required surface", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-probe-manifest-"));
  const manifestPath = path.join(tmp, "bad-manifest.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      saf_required_surfaces: ["missing-surface"],
      surfaces: {},
      scenarios: {},
      profiles: {},
      aliases: {},
    }),
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [probePath, "--help"],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          SUBAGENT007_COVERAGE_MANIFEST_PATH: manifestPath,
        },
      },
    ),
    /coverage manifest omits SAF-required surfaces/,
  );
});

test("observed MCP probe self-check fails when an alias targets a missing profile", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-probe-bad-alias-"));
  const manifestPath = path.join(tmp, "bad-alias-manifest.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      saf_required_surfaces: [],
      surfaces: {},
      scenarios: {},
      profiles: {
        "protocol-core": {
          mode: "protocol-deterministic",
          scenarios: [],
          required_surfaces: [],
        },
      },
      aliases: {
        stale: "missing-profile",
      },
    }),
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [probePath, "--help"],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          SUBAGENT007_COVERAGE_MANIFEST_PATH: manifestPath,
        },
      },
    ),
    /coverage alias stale targets unknown profile: missing-profile/,
  );
});

test("observed MCP probe self-check fails when a profile has no compatible scenario for a required surface", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-probe-unsatisfied-profile-"));
  const manifestPath = path.join(tmp, "bad-profile-manifest.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      saf_required_surfaces: ["run_subagent-success"],
      surfaces: {
        "run_subagent-success": { evidence_classes: ["protocol-deterministic"] },
      },
      scenarios: {
        "schema-error": {
          tool: "run_subagent",
          result_classes: ["schema_error"],
          surfaces: [],
        },
      },
      profiles: {
        "protocol-core": {
          mode: "protocol-deterministic",
          scenarios: ["schema-error"],
          required_surfaces: ["run_subagent-success"],
        },
      },
      aliases: {},
    }),
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [probePath, "--help"],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          SUBAGENT007_COVERAGE_MANIFEST_PATH: manifestPath,
        },
      },
    ),
    /no compatible scenario for required surfaces: run_subagent-success/,
  );
});

test("observed MCP probe full-current covers all deterministic current surfaces", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-full-current-"));
  const projectDir = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const configPath = path.join(stateDir, "config.json");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ default_model_class: "C" }));
  const sourceServerPath = await createSourceServerEntrypoint(tmp);
  const fakeRootsBefore = await probeFakeRoots();

  const result = await execFileAsync(
    process.execPath,
    [
      probePath,
      "--server",
      sourceServerPath,
      "--cwd",
      projectDir,
      "--profile",
      "full-current",
    ],
    {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        SUBAGENT007_CONFIG_PATH: configPath,
        SUBAGENT007_FAILURE_LOG_PATH: path.join(stateDir, "failures.jsonl"),
        SUBAGENT007_CAMPAIGN_LEDGER_PATH: path.join(stateDir, "campaign-ledger.jsonl"),
        ...isolatedRuntimeStateEnv(stateDir),
        SUBAGENT007_RECORD_SOURCE: "test",
      },
      maxBuffer: 12 * 1024 * 1024,
    },
  );

  const summary = JSON.parse(result.stdout) as {
    scenario_set: string;
    mode: string;
    coverage_summary: {
      covered_surfaces: string[];
      missing_required_surfaces: string[];
      uncovered_surfaces: string[];
      scenarios: Array<{
        scenario: string;
        evidence_satisfied: boolean;
        observed_result?: {
          tool_surface_complete?: boolean;
          tool_surface_exact?: boolean;
          skill_alias_guidance_clear?: boolean;
          effect_profile_schema_exact?: boolean;
          missing_tools?: string[];
          unexpected_tools?: string[];
          unclear_skill_alias_tools?: string[];
          public_calibration_fields_absent?: boolean;
          forbidden_public_calibration_fields?: string[];
          failure_log_calibration_fields_absent?: boolean;
          forbidden_failure_log_calibration_fields?: string[];
          failure_log_matching_tool?: string;
          failure_log_matching_task_kind?: string;
          failure_log_matching_run_id?: string;
          run_id?: string;
        };
      }>;
    };
  };

  assert.deepEqual(
    [...await probeFakeRoots()].filter((name) => !fakeRootsBefore.has(name)),
    [],
  );

  assert.equal(summary.scenario_set, "full-current");
  assert.equal(summary.mode, "protocol-deterministic");
  assert.deepEqual(summary.coverage_summary.missing_required_surfaces, []);
  for (const surface of [
    "runtime-readiness",
    "durable-run-contract",
    "model-class-listing-alias",
    "run_subagent-timeout-recovery",
    "schedule_run-durable-first",
    "start_run-async-polling",
    "get_run-bounded-wait",
    "start_run-missing-final-output",
    "start_run-local-capacity-exhaustion",
    "start_session_run-async-polling",
    "start_session_run-packet-failure",
    "start_session_run-packet-missing",
    "start_session_run-packet-invalid",
    "start_session_run-require-existing-missing",
    "get_run-run-not-found",
    "answer_run_input-caller-input",
    "answer_run_input-wrong-request-rejection",
    "cancel_run-cancellation-settlement",
    "cancel_run-terminal-idempotency",
    "get_run-restart-drift",
    "run_subagent_session-valid-packet-closure",
    "run_subagent_session-invalid-packet-closure",
    "run_subagent_session-require-existing-missing",
  ]) {
    assert.ok(summary.coverage_summary.covered_surfaces.includes(surface), surface);
  }
  assert.ok(summary.coverage_summary.uncovered_surfaces.includes("installed-pi-integration"));
  assert.equal(summary.coverage_summary.scenarios.every((scenario) => scenario.evidence_satisfied), true);
  const toolListingScenario = summary.coverage_summary.scenarios.find((scenario) =>
    scenario.scenario === "tool-listing"
  );
  assert.equal(toolListingScenario?.observed_result?.tool_surface_complete, true);
  assert.equal(toolListingScenario?.observed_result?.tool_surface_exact, true);
  assert.deepEqual(toolListingScenario?.observed_result?.missing_tools, []);
  assert.deepEqual(toolListingScenario?.observed_result?.unexpected_tools, []);
  assert.equal(toolListingScenario?.observed_result?.skill_alias_guidance_clear, true);
  assert.equal(toolListingScenario?.observed_result?.effect_profile_schema_exact, true);
  assert.deepEqual(toolListingScenario?.observed_result?.unclear_skill_alias_tools, []);
  for (const scenarioName of [
    "start-session-packet-failure",
    "start-session-packet-missing",
    "start-session-packet-invalid",
  ]) {
    const startSessionPacketScenario = summary.coverage_summary.scenarios.find((scenario) =>
      scenario.scenario === scenarioName
    );
    assert.equal(startSessionPacketScenario?.observed_result?.failure_log_matching_tool, "start_session_run");
    assert.equal(startSessionPacketScenario?.observed_result?.failure_log_matching_task_kind, "session");
    assert.equal(
      startSessionPacketScenario?.observed_result?.failure_log_matching_run_id,
      startSessionPacketScenario?.observed_result?.run_id,
    );
  }
  assert.equal(
    summary.coverage_summary.scenarios.every((scenario) =>
      scenario.observed_result?.public_calibration_fields_absent !== false &&
        scenario.observed_result?.failure_log_calibration_fields_absent !== false &&
        (scenario.observed_result?.forbidden_public_calibration_fields?.length ?? 0) === 0 &&
        (scenario.observed_result?.forbidden_failure_log_calibration_fields?.length ?? 0) === 0
    ),
    true,
  );
  await assertCampaignRuntimeClean(stateDir);

  const ledgerText = await fs.readFile(path.join(stateDir, "campaign-ledger.jsonl"), "utf8");
  assert.doesNotMatch(ledgerText, /SECRET_CAMPAIGN_INPUT_ANSWER/);
  const publicArtifactText = await readPublicCampaignArtifactTextUnder(stateDir);
  assert.doesNotMatch(publicArtifactText, /SECRET_LEDGER_PROMPT|SECRET_TRANSCRIPT_PROMPT_SHOULD_NOT_LEAK/);
  assert.doesNotMatch(
    publicArtifactText,
    /"resolved_model"|"resolved_thinking_level"|"resolved_default_model"|"resolved_default_thinking_level"|"model":|"[^"]*thinking_level[^"]*":/,
  );
  const events = ledgerText
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line)) as Array<{
      event: string;
      scenario: string;
      tool: string;
      failure_log_calibration_fields_absent?: boolean;
      forbidden_failure_log_calibration_fields?: string[];
    }>;
  for (const tool of ["schedule_run", "start_run", "get_run", "answer_run_input", "cancel_run", "start_session_run", "run_subagent_session"]) {
    assert.ok(events.some((event) => event.tool === tool), tool);
  }
  assert.ok(
    events.some((event) => event.event === "call_operation_rejected" && event.scenario === "get-run-missing"),
  );
  assert.ok(
    events.some((event) => event.event === "call_operation_rejected" && event.scenario === "caller-input-wrong-request"),
  );
  assert.equal(
    events
      .filter((event) => event.event === "failure_log_delta")
      .every((event) =>
        event.failure_log_calibration_fields_absent === true &&
          (event.forbidden_failure_log_calibration_fields?.length ?? 0) === 0
      ),
    true,
  );
});

test("observed MCP probe removes its deterministic fake root when initial server connection fails", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-probe-connect-failure-"));
  const projectDir = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const configPath = path.join(stateDir, "config.json");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ default_model_class: "C" }));
  const fakeRootsBefore = await probeFakeRoots();

  await assert.rejects(
    execFileAsync(process.execPath, [
      probePath,
      "--server",
      path.join(tmp, "missing-server.js"),
      "--cwd",
      projectDir,
      "--profile",
      "protocol-core",
    ], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        ...isolatedRuntimeStateEnv(stateDir),
        SUBAGENT007_CONFIG_PATH: configPath,
        SUBAGENT007_FAILURE_LOG_PATH: path.join(stateDir, "failures.jsonl"),
        SUBAGENT007_CAMPAIGN_LEDGER_PATH: path.join(stateDir, "campaign-ledger.jsonl"),
        SUBAGENT007_RECORD_SOURCE: "test",
      },
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
  assert.deepEqual(
    [...await probeFakeRoots()].filter((name) => !fakeRootsBefore.has(name)),
    [],
  );
  await assertCampaignRuntimeClean(stateDir);
  await waitForNoOwnedProcessCommand(tmp);
});

test("observed MCP probe fails required coverage when selected scenario has wrong result class", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-probe-wrong-result-"));
  const projectDir = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const configPath = path.join(stateDir, "config.json");
  const manifestPath = path.join(tmp, "wrong-result-manifest.json");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ default_model_class: "C" }));
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      saf_required_surfaces: ["run_subagent-success"],
      surfaces: {
        "run_subagent-success": { evidence_classes: ["protocol-deterministic"] },
      },
      scenarios: {
        "schema-error": {
          tool: "run_subagent",
          result_classes: ["success"],
          surfaces: ["run_subagent-success"],
        },
      },
      profiles: {
        "protocol-core": {
          mode: "protocol-deterministic",
          scenarios: ["schema-error"],
          required_surfaces: ["run_subagent-success"],
        },
      },
      aliases: {},
    }),
  );

  const expectedIdentity = {
    source: { path: probePath, sha256: await sha256File(probePath) },
    dist: { path: path.resolve("dist/server.js"), sha256: await sha256File(path.resolve("dist/server.js")) },
    manifest: { path: manifestPath, sha256: await sha256File(manifestPath) },
  };
  let failure: { stderr?: string } | undefined;
  try {
    await execFileAsync(
      process.execPath,
      [
        probePath,
        "--server",
        path.resolve("dist/server.js"),
        "--cwd",
        projectDir,
        "--profile",
        "protocol-core",
      ],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          SUBAGENT007_CONFIG_PATH: configPath,
          SUBAGENT007_COVERAGE_MANIFEST_PATH: manifestPath,
          SUBAGENT007_FAILURE_LOG_PATH: path.join(stateDir, "failures.jsonl"),
          SUBAGENT007_CAMPAIGN_LEDGER_PATH: path.join(stateDir, "campaign-ledger.jsonl"),
          SUBAGENT007_RECORD_SOURCE: "test",
        },
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  } catch (error) {
    failure = error as { stderr?: string };
  }
  assert.ok(failure);
  const retainedStderr = failure.stderr ?? "";
  assert.match(retainedStderr, /missing required coverage surfaces: run_subagent-success/);
  await fs.rm(tmp, { recursive: true, force: true });
  const record = coverageFailureRecord(retainedStderr);
  assert.equal(record.record_version, 1);
  assert.deepEqual(record.source, expectedIdentity.source);
  assert.deepEqual(record.dist, expectedIdentity.dist);
  assert.deepEqual(record.manifest, expectedIdentity.manifest);
  assert.equal(record.profile, "protocol-core");
  assert.equal(record.scenario, "schema-error");
  assert.equal(record.run_id, null);
  assert.equal(typeof record.observed_result, "object");
});

test("predicate-specific cancellation wait outlives a premature terminal view and fails with exact terminal evidence when absent", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-cancellation-predicate-"));
  const projectDir = path.join(tmp, "project");
  const manifestPath = path.join(tmp, "cancellation-manifest.json");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify({
    saf_required_surfaces: ["cancel_run-cancellation-settlement"],
    surfaces: {
      "cancel_run-cancellation-settlement": { evidence_classes: ["protocol-deterministic"] },
    },
    scenarios: {
      cancellation: {
        tool: "cancel_run",
        result_classes: ["cancelled"],
        surfaces: ["cancel_run-cancellation-settlement"],
      },
    },
    profiles: {
      "protocol-core": {
        mode: "protocol-deterministic",
        scenarios: ["cancellation"],
        required_surfaces: ["cancel_run-cancellation-settlement"],
      },
    },
    aliases: {},
  }));
  const campaignEnv = async (label: string, settlementMask: "once" | "always") => {
    const stateDir = path.join(tmp, `state-${label}`);
    const configPath = path.join(stateDir, "config.json");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ default_model_class: "C" }));
    return {
      stateDir,
      env: {
        ...process.env,
        ...isolatedRuntimeStateEnv(stateDir),
        SUBAGENT007_CONFIG_PATH: configPath,
        SUBAGENT007_COVERAGE_MANIFEST_PATH: manifestPath,
        SUBAGENT007_FAILURE_LOG_PATH: path.join(stateDir, "failures.jsonl"),
        SUBAGENT007_CAMPAIGN_LEDGER_PATH: path.join(stateDir, "campaign-ledger.jsonl"),
        SUBAGENT007_RECORD_SOURCE: "test",
        SUBAGENT007_TEST_WAIT_FOR_RUN_TIMEOUT_MS: "1000",
        SUBAGENT007_TEST_MASK_CANCELLATION_SETTLEMENT: settlementMask,
      },
    };
  };
  const args = [
    probePath,
    "--server",
    path.resolve("dist/server.js"),
    "--cwd",
    projectDir,
    "--profile",
    "protocol-core",
  ];

  const recoveredCampaign = await campaignEnv("once", "once");
  const recovered = await execFileAsync(process.execPath, args, {
    cwd: path.resolve("."),
    env: recoveredCampaign.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  const recoveredSummary = JSON.parse(recovered.stdout) as {
    coverage_summary: { missing_required_surfaces: string[] };
  };
  assert.deepEqual(recoveredSummary.coverage_summary.missing_required_surfaces, []);
  await assertCampaignRuntimeClean(recoveredCampaign.stateDir);

  const failedCampaign = await campaignEnv("always", "always");
  let failure: { stderr?: string } | undefined;
  try {
    await execFileAsync(process.execPath, args, {
      cwd: path.resolve("."),
      env: failedCampaign.env,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    failure = error as { stderr?: string };
  }
  assert.ok(failure);
  const record = coverageFailureRecord(failure.stderr ?? "");
  assert.equal(record.scenario, "cancellation");
  assert.equal(typeof record.run_id, "string");
  assert.deepEqual(record.observed_result, {
    ...(record.observed_result as Record<string, unknown>),
    status: "cancelled",
    cancellation_settled: false,
  });
  await assertCampaignRuntimeClean(failedCampaign.stateDir);
});

test("observed MCP probe fails tool-listing coverage when required public tools are absent", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-probe-missing-tools-"));
  const projectDir = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const manifestPath = path.join(tmp, "tool-listing-manifest.json");
  const fakeServerPath = path.join(tmp, "empty-mcp-server.mjs");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      saf_required_surfaces: ["tool-listing"],
      surfaces: {
        "tool-listing": { evidence_classes: ["protocol-deterministic"] },
      },
      scenarios: {
        "tool-listing": {
          tool: "__list_tools",
          result_classes: ["expected_tool_surface"],
          surfaces: ["tool-listing"],
        },
      },
      profiles: {
        "protocol-core": {
          mode: "protocol-deterministic",
          scenarios: ["tool-listing"],
          required_surfaces: ["tool-listing"],
        },
      },
      aliases: {},
    }),
  );
  await fs.writeFile(
    fakeServerPath,
    [
      `import { McpServer } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href)};`,
      `import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href)};`,
      "const server = new McpServer({ name: 'empty-mcp-server', version: '0.0.0' });",
      "await server.connect(new StdioServerTransport());",
    ].join("\n"),
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        probePath,
        "--server",
        fakeServerPath,
        "--cwd",
        projectDir,
        "--profile",
        "protocol-core",
      ],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          SUBAGENT007_COVERAGE_MANIFEST_PATH: manifestPath,
          SUBAGENT007_FAILURE_LOG_PATH: path.join(stateDir, "failures.jsonl"),
          SUBAGENT007_CAMPAIGN_LEDGER_PATH: path.join(stateDir, "campaign-ledger.jsonl"),
          SUBAGENT007_RECORD_SOURCE: "test",
        },
        maxBuffer: 8 * 1024 * 1024,
      },
    ),
    /missing required coverage surfaces: tool-listing/,
  );
});

test("observed MCP probe fails tool-listing coverage when unexpected public tools are exposed", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-probe-extra-tools-"));
  const projectDir = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const manifestPath = path.join(tmp, "tool-listing-manifest.json");
  const fakeServerPath = path.join(tmp, "noisy-mcp-server.mjs");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      saf_required_surfaces: ["tool-listing"],
      surfaces: {
        "tool-listing": { evidence_classes: ["protocol-deterministic"] },
      },
      scenarios: {
        "tool-listing": {
          tool: "__list_tools",
          result_classes: ["expected_tool_surface"],
          surfaces: ["tool-listing"],
        },
      },
      profiles: {
        "protocol-core": {
          mode: "protocol-deterministic",
          scenarios: ["tool-listing"],
          required_surfaces: ["tool-listing"],
        },
      },
      aliases: {},
    }),
  );
  await fs.writeFile(
    fakeServerPath,
    [
      `import { McpServer } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href)};`,
      `import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href)};`,
      `import { z } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/zod/index.js")).href)};`,
      "const server = new McpServer({ name: 'noisy-mcp-server', version: '0.0.0' });",
      "const expectedTools = ['answer_run_input','cancel_run','close_skill_snapshot_references','delete_skill_snapshot','get_run','get_run_contract','get_runtime_readiness','list_allowed_models','list_model_classes','plan_skill_snapshot_deletion','publish_skill_snapshots','resolve_retained_skill_snapshot_source','resolve_skill_bindings','resolve_skill_runtime_bundles','run_subagent','run_subagent_session','schedule_run','start_run','start_session_run','validate_skill_runtime_bundle','verify_skill_bindings'];",
      "const skillBindingTools = new Set(['run_subagent','run_subagent_session','schedule_run','start_run','start_session_run']);",
      "const skillName = z.string().nullable().optional().describe('Preferred bare skill name only, such as pda-lite or plugin:skill-name; null means no skill.');",
      "const skill = z.string().nullable().optional().describe('Legacy alias for skill_name; prefer skill_name for new callers. Bare skill name only, such as pda-lite or plugin:skill-name; null means no skill.');",
      "for (const name of expectedTools) {",
      "  server.registerTool(name, { inputSchema: skillBindingTools.has(name) ? { skill_name: skillName, skill } : {} }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));",
      "}",
      "server.registerTool('surprise_debug_tool', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));",
      "await server.connect(new StdioServerTransport());",
    ].join("\n"),
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        probePath,
        "--server",
        fakeServerPath,
        "--cwd",
        projectDir,
        "--profile",
        "protocol-core",
      ],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          SUBAGENT007_COVERAGE_MANIFEST_PATH: manifestPath,
          SUBAGENT007_FAILURE_LOG_PATH: path.join(stateDir, "failures.jsonl"),
          SUBAGENT007_CAMPAIGN_LEDGER_PATH: path.join(stateDir, "campaign-ledger.jsonl"),
          SUBAGENT007_RECORD_SOURCE: "test",
        },
        maxBuffer: 8 * 1024 * 1024,
      },
    ),
    /missing required coverage surfaces: tool-listing/,
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

test("live observed probes reject a configured fake Pi child before claiming live evidence", async () => {
  const tmp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-live-provenance-")),
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        probePath,
        "--server",
        path.resolve("dist/server.js"),
        "--cwd",
        tmp,
        "--profile",
        "live-current",
        "--quiet",
      ],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          SUBAGENT007_PI_CHILD_PATH: path.join(tmp, "fake-child.js"),
          SUBAGENT007_FAILURE_LOG_PATH: path.join(tmp, "failures.jsonl"),
          SUBAGENT007_CAMPAIGN_LEDGER_PATH: path.join(tmp, "campaign-ledger.jsonl"),
          SUBAGENT007_RECORD_SOURCE: "test",
        },
        maxBuffer: 8 * 1024 * 1024,
      },
    ),
    /live-model observed probes reject SUBAGENT007_PI_CHILD_PATH/,
  );
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
