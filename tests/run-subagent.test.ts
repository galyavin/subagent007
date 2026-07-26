import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { SkillBindingVerificationResult } from "../src/types.js";
import { createInputRequest, listInputRequests } from "../src/inputMailbox.js";
import { PUBLIC_PROMPT_REDACTED_MARKER } from "../src/prompt.js";
import {
  extractSubagentSessionId,
  partialOutputAvailableForRun,
  runSubagentCore as runSubagent,
  RUN_SUBAGENT_TIMEOUT_RECOVERY_HINT,
} from "../src/runSubagent.js";
import {
  answerRunTaskInput,
  cancelRunTask,
  getRunTask,
  reconcilePersistedActiveRunTasks,
  startRunTask,
} from "../src/runTask.js";
import { validateSkillRuntimeBundle } from "../src/skillRuntimeBundle.js";
import { publishSkillSnapshotsRequest } from "../src/skillSnapshot.js";
import { ValidationError } from "../src/types.js";
import { createFakePiChild } from "./helpers/fakePiChild.js";
import { readJsonl, sha256File, withEnv } from "./helpers/testUtils.js";

type RunSubagentMetadata = {
  run_id: string;
  status: "working" | "input_required" | "completed" | "failed" | "cancelled" | "timed_out" | "rejected";
  output_references?: Array<{
    kind: "file";
    name: "primary" | "packet";
    relative_path: string;
    size_bytes: number;
    content_sha256: string;
    output_mode: "final" | "transcript";
  }>;
  success: boolean;
  exit_code: number | null;
  timed_out: boolean;
  stop_reason?: "completed" | "failed" | "cancelled" | "timeout";
  requested_timeout_ms: number | null;
  resolved_timeout_ms: number | null;
  effective_timeout_ms: number | null;
  partial_output_available?: boolean;
  partial_output_path?: string;
  resume_possible?: boolean;
  duration_ms?: number;
  stop_signal: string | null;
  timeout_recovery_hint?: string;
  session_id: string | null;
  session_established: boolean;
  input_requests_dir?: string;
  input_requests: Array<{ request_id: string; status: string }>;
  written_output_mode: "final" | "transcript";
  elapsed_ms?: number;
  last_progress_at?: string;
  last_progress_message?: string;
  heartbeat_count?: number;
  active_phase?: string;
  last_phase_at?: string;
  last_child_lifecycle_event?: string;
  last_child_lifecycle_at?: string;
  first_public_output_at?: string;
  no_public_output_elapsed_ms?: number;
  finished_at?: string;
  recent_events?: Array<{
    kind: string;
    event?: string;
    text: string;
    occurred_at: string;
    metadata?: Record<string, unknown>;
  }>;
  last_public_output_excerpt?: string;
  requested_wait_ms?: number;
  effective_wait_ms?: number;
  wait_truncated?: boolean;
  requested_skill?: string | null;
  requested_output_mode?: "final" | "transcript";
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
  child_started?: boolean;
  queued_at?: string;
  child_started_at?: string;
  queue_wait_ms?: number;
  requested_effect_profile?: "workspace_read_only" | "task_root_authoring_v1" | "skill_creator_authoring_v1" | "researcher_bounded_v1" | "assumption_audit_bounded_v1";
  resolved_effect_profile?: "workspace_read_only" | "task_root_authoring_v1" | "skill_creator_authoring_v1" | "researcher_bounded_v1" | "assumption_audit_bounded_v1";
  activation_receipt?: {
    schema_version: 1 | 2;
    confirmed_before_prompt: true;
    requested_effect_profile: "workspace_read_only" | "task_root_authoring_v1" | "skill_creator_authoring_v1" | "researcher_bounded_v1" | "assumption_audit_bounded_v1" | null;
    resolved_effect_profile: "workspace_read_only" | "task_root_authoring_v1" | "skill_creator_authoring_v1" | "researcher_bounded_v1" | "assumption_audit_bounded_v1" | null;
    active_tool_names: string[];
    tool_bindings: Array<{ tool_name: string; provider_id: string; implementation_sha256: string }>;
    toolset_sha256: string | null;
    skill_binding: { name: string; path: string; content_sha256: string; expected_content_sha256: string | null } | null;
    effect_scope_binding?: {
      schema_version: 1;
      effect_profile: "task_root_authoring_v1" | "researcher_bounded_v1" | "assumption_audit_bounded_v1";
      task_root: string;
      task_root_device: string;
      task_root_inode: string;
      recursive_delegation: "disabled";
      immutable_tree_sha256: string;
      writable_scope: { kind: "exact_output_files" | "fixed_state_subtree"; paths: string[] };
      terminal_reinspection_required: true;
      claim_ceiling: string;
    };
  };
  kind?: string;
  retry_guidance?: string;
  input_response_id?: string;
  input_response_receipt?: string;
  input_response_outcome?: string;
  parent_run_id?: string;
  root_run_id?: string;
  recursion_depth?: number;
  child_run_ids?: string[];
  descendant_run_ids?: string[];
  descendant_terminal_statuses?: Record<string, string>;
  session_dir?: string;
};

let currentMcpRunsDir: string | undefined;

function outputPathFor(metadata: Pick<RunSubagentMetadata, "output_references"> & { session_dir?: string }, runsDir?: string): string {
  const references = metadata.output_references ?? [];
  const reference = references.find((candidate) => candidate.name === "primary");
  assert.equal(references.filter((candidate) => candidate.name === "primary").length, 1);
  assert.ok(reference, "one primary output reference is required");
  const root = runsDir ?? currentMcpRunsDir ?? process.env.SUBAGENT007_RUNS_DIR;
  assert.ok(root, "a configured runs root is required to resolve output bytes");
  return path.join(path.resolve(root), reference.relative_path);
}

function persistedDurableRunView(value: unknown): RunSubagentMetadata {
  if (value && typeof value === "object" && "public_view" in value) {
    return (value as { public_view: RunSubagentMetadata }).public_view;
  }
  if (value && typeof value === "object" &&
    (value as { record_name?: unknown }).record_name === "subagent007.current_run_claim") {
    const {
      record_name: _recordName,
      record_version: _recordVersion,
      declarations: _declarations,
      launch_observation: _launchObservation,
      ...view
    } = value as Record<string, unknown>;
    return view as RunSubagentMetadata;
  }
  return value as RunSubagentMetadata;
}

const FORBIDDEN_PUBLIC_CALIBRATION_FIELDS = new Set([
  "resolved_model",
  "resolved_thinking_level",
  "resolved_default_model",
  "resolved_default_thinking_level",
]);

function forbiddenPublicCalibrationFields(value: unknown, pathParts: string[] = []): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      forbiddenPublicCalibrationFields(entry, [...pathParts, String(index)]),
    );
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => {
    const path = [...pathParts, key];
    return [
      ...(FORBIDDEN_PUBLIC_CALIBRATION_FIELDS.has(key) || key.includes("thinking_level") ? [path.join(".")] : []),
      ...forbiddenPublicCalibrationFields(child, path),
    ];
  });
}

function assertNoPublicCalibrationFields(value: unknown): void {
  assert.deepEqual(forbiddenPublicCalibrationFields(value), []);
}

async function connectFakeClient<T>(
  run: (client: Client, dirs: {
    projectDir: string;
    configPath: string;
    fakeLogPath: string;
    modelHealthPath: string;
    inputRequestsDir: string;
    activeChildrenDir: string;
  }) => Promise<T>,
  options: { config?: Record<string, unknown>; env?: NodeJS.ProcessEnv } = {},
): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-mcp-"));
  const projectDir = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const configPath = path.join(stateDir, "config.json");
  const modelHealthPath = path.join(stateDir, "model-health.json");
  const runsDir = options.env?.SUBAGENT007_RUNS_DIR ?? path.join(stateDir, "runs");
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
    args: ["--import", "tsx", path.resolve("src/server.ts")],
    env: {
      ...process.env,
      SUBAGENT007_CONFIG_PATH: configPath,
      SUBAGENT007_PI_CHILD_PATH: fake.childPath,
      FAKE_PI_LOG_PATH: fake.logPath,
      SUBAGENT007_FAILURE_LOG: "off",
      SUBAGENT007_RECORD_SOURCE: "test",
      SUBAGENT007_MODEL_HEALTH_PATH: modelHealthPath,
      SUBAGENT007_RUN_TASKS_DIR: path.join(stateDir, "run-tasks"),
      SUBAGENT007_INPUT_REQUESTS_DIR: path.join(stateDir, "input-requests"),
      SUBAGENT007_ACTIVE_CHILDREN_DIR: path.join(stateDir, "active-children"),
      SUBAGENT007_QUEUED_RUNS_DIR: path.join(stateDir, "queued-runs"),
      SUBAGENT007_RUNS_DIR: runsDir,
      SUBAGENT007_SESSIONS_DIR: path.join(stateDir, "sessions"),
      SUBAGENT007_PI_RAW_SESSIONS_DIR: path.join(stateDir, "pi-sessions"),
      SUBAGENT007_SKILL_SNAPSHOTS_DIR: path.join(stateDir, "skill-snapshots"),
      ...options.env,
    },
  });
  const client = new Client({ name: "subagent007-pi-runner-test", version: "0.1.0" });

  const previousMcpRunsDir = currentMcpRunsDir;
  currentMcpRunsDir = runsDir;
  try {
    await client.connect(transport);
    return await run(client, {
      projectDir,
      configPath,
      fakeLogPath: fake.logPath,
      modelHealthPath,
      inputRequestsDir: options.env?.SUBAGENT007_INPUT_REQUESTS_DIR ??
        process.env.SUBAGENT007_INPUT_REQUESTS_DIR ??
        path.join(stateDir, "input-requests"),
      activeChildrenDir: options.env?.SUBAGENT007_ACTIVE_CHILDREN_DIR ??
        path.join(stateDir, "active-children"),
    });
  } finally {
    currentMcpRunsDir = previousMcpRunsDir;
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

async function waitForTerminalRunTask(runId: string): Promise<RunSubagentMetadata> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const metadata = await getRunTask(runId);
    if (metadata.status === "completed" || metadata.status === "failed" || metadata.status === "cancelled" || metadata.status === "timed_out") {
      return metadata as RunSubagentMetadata;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for terminal run ${runId}`);
}

interface DirectRunTestFixture {
  root: string;
  projectDir: string;
  runTasksDir: string;
  fake: Awaited<ReturnType<typeof createFakePiChild>>;
  env: Record<string, string>;
}

async function createDirectRunTestFixture(prefix: string): Promise<DirectRunTestFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const projectDir = path.join(root, "project");
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "config.json");
  const runTasksDir = path.join(stateDir, "run-tasks");
  const inputRequestsDir = path.join(stateDir, "input-requests");
  const fake = await createFakePiChild();
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ default_model_class: "C" }), "utf8");
  return {
    root,
    projectDir,
    runTasksDir,
    fake,
    env: {
      SUBAGENT007_CONFIG_PATH: configPath,
      SUBAGENT007_PI_CHILD_PATH: fake.childPath,
      FAKE_PI_LOG_PATH: fake.logPath,
      SUBAGENT007_FAILURE_LOG: "off",
      SUBAGENT007_RECORD_SOURCE: "test",
      SUBAGENT007_MODEL_HEALTH_PATH: path.join(stateDir, "model-health.json"),
      SUBAGENT007_RUNS_DIR: path.join(stateDir, "runs"),
      SUBAGENT007_RUN_TASKS_DIR: runTasksDir,
      SUBAGENT007_INPUT_REQUESTS_DIR: inputRequestsDir,
      SUBAGENT007_ACTIVE_CHILDREN_DIR: path.join(stateDir, "active-children"),
      SUBAGENT007_QUEUED_RUNS_DIR: path.join(stateDir, "queued-runs"),
      SUBAGENT007_SESSIONS_DIR: path.join(stateDir, "sessions"),
    },
  };
}

async function removeDirectRunTestFixture(fixture: DirectRunTestFixture): Promise<void> {
  await Promise.all([
    fs.rm(fixture.root, { recursive: true, force: true }),
    fs.rm(path.dirname(fixture.fake.childPath), { recursive: true, force: true }),
  ]);
}

async function makeDirectoriesRemovable(root: string): Promise<void> {
  await fs.chmod(root, 0o755).catch(() => undefined);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => makeDirectoriesRemovable(path.join(root, entry.name))));
}

async function waitForDirectRunView(
  runId: string,
  predicate: (view: RunSubagentMetadata) => boolean,
  description: string,
): Promise<RunSubagentMetadata> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const view = await getRunTask(runId) as RunSubagentMetadata;
    if (predicate(view)) return view;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${description} on run ${runId}`);
}

function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function runTestWorker(
  source: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 5_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  if (timedOut) {
    throw new Error(`test worker timed out: stdout=${stdout} stderr=${stderr}`);
  }
  return { ...result, stdout, stderr };
}

async function cancelAndWaitForDirectRun(runId: string): Promise<void> {
  await cancelRunTask(runId).catch(() => undefined);
  await waitForTerminalRunTask(runId).catch(() => undefined);
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

async function waitForPathMissing(filePath: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      await fs.stat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for path removal: ${filePath}`);
}

interface DelayedEffectArmedRecord {
  event: "delayed_effect_armed";
  run_id: string;
  pid: number;
  nonce: string;
  delay_ms: number;
  effect_path: string;
  armed_at: string;
}

async function waitForDelayedEffectArmed(
  logPath: string,
  nonce: string,
): Promise<DelayedEffectArmedRecord> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const text = await fs.readFile(logPath, "utf8").catch(() => "");
    for (const line of text.trim().split(/\r?\n/)) {
      if (!line) continue;
      try {
        const record = JSON.parse(line) as Partial<DelayedEffectArmedRecord>;
        if (record.event === "delayed_effect_armed" && record.nonce === nonce) {
          return record as DelayedEffectArmedRecord;
        }
      } catch {
        // The producer may still be completing its append.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for delayed effect nonce ${nonce}`);
}

function exactPidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForExactPidGone(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!exactPidIsAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`process ${pid} survived its owner`);
}

async function hasActiveLeaseForRun(activeChildrenDir: string, runId: string): Promise<boolean> {
  const entries = await fs.readdir(activeChildrenDir).catch(() => []);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const lease = JSON.parse(await fs.readFile(path.join(activeChildrenDir, entry), "utf8")) as { run_id?: string };
    if (lease.run_id === runId) {
      return true;
    }
  }
  return false;
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

interface DirectSyncEvidence {
  paths: string[];
  publications: string[];
  runTasksDir: string;
  runsDir: string;
}

async function collectDirectSyncEvidence(
  run: (fixture: DirectRunTestFixture, measure: <T>(operation: () => Promise<T>) => Promise<T>) => Promise<void>,
): Promise<DirectSyncEvidence> {
  const fixture = await createDirectRunTestFixture("subagent007-sync-");
  const originalOpen = fs.open.bind(fs);
  const originalRename = fs.rename.bind(fs);
  const paths: string[] = [];
  const publications: string[] = [];
  let measuring = false;
  (fs as unknown as { open: typeof fs.open }).open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const openedPath = args[0];
    if (typeof openedPath === "string") {
      const originalSync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (measuring) paths.push(path.resolve(openedPath));
        return originalSync();
      };
    }
    return handle;
  }) as typeof fs.open;
  (fs as unknown as { rename: typeof fs.rename }).rename = (async (...args: Parameters<typeof fs.rename>) => {
    const [source, destination] = args;
    await originalRename(...args);
    if (
      measuring &&
      typeof source === "string" &&
      typeof destination === "string" &&
      source.includes(".json.tmp-") &&
      path.dirname(path.resolve(destination)) === path.resolve(fixture.runTasksDir)
    ) publications.push(path.resolve(destination));
  }) as typeof fs.rename;
  try {
    await withEnv(fixture.env, () => run(fixture, async (operation) => {
      measuring = true;
      try { return await operation(); } finally { measuring = false; }
    }));
    assert.equal((await fs.readdir(fixture.runTasksDir)).some((entry) => entry.endsWith(".events.jsonl")), false);
    return { paths, publications, runTasksDir: fixture.runTasksDir, runsDir: fixture.env.SUBAGENT007_RUNS_DIR };
  } finally {
    (fs as unknown as { open: typeof fs.open }).open = originalOpen;
    (fs as unknown as { rename: typeof fs.rename }).rename = originalRename;
    await removeDirectRunTestFixture(fixture);
  }
}

function assertDirectClaimSyncs(evidence: DirectSyncEvidence, transitions: number, outputs: number): void {
  const runTasksDir = path.resolve(evidence.runTasksDir);
  assert.equal(evidence.publications.length, transitions);
  assert.equal(evidence.paths.filter((entry) => entry.includes(`${path.sep}.claim-locks${path.sep}`)).length, 0);
  assert.equal(evidence.paths.filter((entry) => entry === runTasksDir).length, transitions);
  assert.equal(evidence.paths.filter((entry) =>
    path.dirname(entry) === runTasksDir && path.basename(entry).includes(".json.tmp-")
  ).length, transitions);
  assert.equal(evidence.paths.filter((entry) => entry.startsWith(`${path.resolve(evidence.runsDir)}${path.sep}`)).length, outputs);
}

test("durable persistence has exact sync targets and constant event-volume growth", async () => {
  const fresh = await collectDirectSyncEvidence(async (f, measure) => {
    const started = await measure(() => startRunTask({ cwd: f.projectDir, prompt: "CANCEL_WAIT", client_start_id: "sync-fresh" }));
    await waitForDirectRunView(started.run_id, (view) => view.child_started === true, "fresh child start");
    await cancelAndWaitForDirectRun(started.run_id);
  });
  const cancelRpc = await collectDirectSyncEvidence(async (f, measure) => {
    const started = await startRunTask({ cwd: f.projectDir, prompt: "CANCEL_WAIT" });
    await waitForDirectRunView(started.run_id, (view) => view.child_started === true, "cancel child start");
    await measure(() => cancelRunTask(started.run_id));
    await waitForTerminalRunTask(started.run_id);
  });
  const input = await collectDirectSyncEvidence(async (f, measure) => {
    const started = await startRunTask({ cwd: f.projectDir, prompt: "REQUEST_INPUT_WAIT" });
    const pending = await waitForDirectRunView(started.run_id, (view) =>
      view.status === "input_required" && view.input_requests.some((request) => request.status === "pending"), "input request");
    const request = pending.input_requests.find((entry) => entry.status === "pending");
    assert.ok(request);
    await measure(() => answerRunTaskInput({
      runId: started.run_id, requestId: request.request_id, answer: "continue", responseId: "sync-response-001",
    }));
    await waitForTerminalRunTask(started.run_id);
  });
  const cancelTerminal = await collectDirectSyncEvidence(async (f, measure) => {
    const started = await startRunTask({ cwd: f.projectDir, prompt: "CANCEL_WAIT" });
    await waitForDirectRunView(started.run_id, (view) => view.child_started === true, "cancel terminal child start");
    await measure(async () => { await cancelRunTask(started.run_id); await waitForTerminalRunTask(started.run_id); });
  });
  const complete = (events: number) => collectDirectSyncEvidence(async (f, measure) => {
    await measure(async () => {
      const started = await startRunTask({ cwd: f.projectDir, prompt: `MANY_PUBLIC_EVENTS:${events}` });
      assert.equal((await waitForTerminalRunTask(started.run_id)).status, "completed");
    });
  });
  const zero = await complete(0);
  const thousand = await complete(1000);
  assert.deepEqual([fresh, cancelRpc, input, cancelTerminal, zero].map((entry) => entry.paths.length), [5, 2, 2, 5, 11]);
  const bindingRoot = path.join(path.resolve(fresh.runTasksDir), "client-start-ids");
  assert.equal(fresh.paths.filter((entry) => entry.endsWith(".prepared")).length, 1);
  assert.equal(fresh.paths.filter((entry) => path.dirname(entry) === bindingRoot && entry.includes(".json.tmp-")).length, 1);
  assert.equal(fresh.paths.filter((entry) => entry === bindingRoot).length, 1);
  assert.equal(fresh.paths.filter((entry) => entry === path.resolve(fresh.runTasksDir)).length, 2);
  assertDirectClaimSyncs(cancelRpc, 1, 0);
  assertDirectClaimSyncs(input, 1, 0);
  assertDirectClaimSyncs(cancelTerminal, 2, 1);
  assertDirectClaimSyncs(zero, 5, 1);
  assert.equal(thousand.paths.length, zero.paths.length);
  assertDirectClaimSyncs(thousand, 5, 1);
});

test("accepted control crash cuts recover only canonical same-run facts from fresh processes", async (t) => {
  type CrashCut =
    | "input_after_ack_before_claim"
    | "claim_after_file_sync_before_rename"
    | "claim_after_rename_before_directory_sync"
    | "cancel_after_directory_sync_before_reply"
    | "input_after_directory_sync_before_reply";
  type Control = "cancel" | "input";
  const cuts: Array<{
    cut: CrashCut;
    control: Control;
    canonicalAcceptedBeforeRecovery: boolean;
  }> = [
    { cut: "input_after_ack_before_claim", control: "input", canonicalAcceptedBeforeRecovery: false },
    { cut: "claim_after_file_sync_before_rename", control: "cancel", canonicalAcceptedBeforeRecovery: false },
    { cut: "claim_after_rename_before_directory_sync", control: "cancel", canonicalAcceptedBeforeRecovery: true },
    { cut: "cancel_after_directory_sync_before_reply", control: "cancel", canonicalAcceptedBeforeRecovery: true },
    { cut: "input_after_directory_sync_before_reply", control: "input", canonicalAcceptedBeforeRecovery: true },
  ];
  const runTaskUrl = pathToFileURL(path.resolve("src/runTask.ts")).href;

  function claimAccepted(view: RunSubagentMetadata, control: Control, requestId?: string): boolean {
    return control === "cancel"
      ? view.recent_events?.some((event) => event.event === "cancellation_requested") === true
      : view.input_requests.some((request) => request.request_id === requestId && request.status === "answered");
  }

  function crashWorkerSource(
    fixture: DirectRunTestFixture,
    cut: CrashCut,
    control: Control,
  ): string {
    return `
      import fs from "node:fs/promises";
      import path from "node:path";
      const { answerRunTaskInput, cancelRunTask, getRunTask, startRunTask } = await import(${JSON.stringify(runTaskUrl)});
      const cut = ${JSON.stringify(cut)};
      const control = ${JSON.stringify(control)};
      const runTasksDir = path.resolve(${JSON.stringify(fixture.runTasksDir)});
      const mailboxRoot = path.resolve(${JSON.stringify(fixture.env.SUBAGENT007_INPUT_REQUESTS_DIR)});
      const accepted = (view, requestId) => control === "cancel"
        ? view.recent_events?.some((event) => event.event === "cancellation_requested") === true
        : view.input_requests.some((request) => request.request_id === requestId && request.status === "answered");
      const dieAtCut = (label) => new Promise(() => {
        process.stderr.write("CRASH_CUT:" + label + "\\n", () => process.kill(process.pid, "SIGKILL"));
      });
      const clientStartId = "crash-cut-" + control + "-" + cut;
      const started = await startRunTask({
        cwd: ${JSON.stringify(fixture.projectDir)},
        prompt: control === "cancel" ? "CANCEL_WAIT" : "REQUEST_INPUT_WAIT",
        client_start_id: clientStartId,
      });
      let requestId;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const view = await getRunTask(started.run_id);
        requestId = view.input_requests.find((request) => request.status === "pending")?.request_id;
        if ((control === "cancel" && view.child_started === true) ||
          (control === "input" && view.status === "input_required" && requestId)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (control === "input" && !requestId) throw new Error("input request did not become pending");
      const recordPath = path.join(runTasksDir, started.run_id + ".json");
      await new Promise((resolve) => process.stdout.write(JSON.stringify({
        kind: "ready",
        run_id: started.run_id,
        request_id: requestId ?? null,
      }) + "\\n", resolve));

      const originalOpen = fs.open.bind(fs);
      const originalRename = fs.rename.bind(fs);
      fs.open = async (...args) => {
        const handle = await originalOpen(...args);
        const openedPath = typeof args[0] === "string" ? path.resolve(args[0]) : undefined;
        const fileSyncCut = cut === "claim_after_file_sync_before_rename" &&
          openedPath?.startsWith(recordPath + ".tmp-");
        const directorySyncCut = (cut === "cancel_after_directory_sync_before_reply" ||
          cut === "input_after_directory_sync_before_reply") && openedPath === runTasksDir;
        if (fileSyncCut || directorySyncCut) {
          const originalSync = handle.sync.bind(handle);
          handle.sync = async () => {
            await originalSync();
            const candidatePath = fileSyncCut ? openedPath : recordPath;
            const candidate = JSON.parse(await fs.readFile(candidatePath, "utf8"));
            if (accepted(candidate, requestId)) await dieAtCut(cut);
          };
        }
        return handle;
      };
      fs.rename = async (source, destination) => {
        const canonicalClaim = typeof source === "string" && typeof destination === "string" &&
          source.startsWith(recordPath + ".tmp-") && path.resolve(destination) === recordPath;
        if (!canonicalClaim) return originalRename(source, destination);
        const candidate = JSON.parse(await fs.readFile(source, "utf8"));
        if (!accepted(candidate, requestId)) return originalRename(source, destination);
        if (cut === "input_after_ack_before_claim") {
          const terminalPath = path.join(mailboxRoot, started.run_id, requestId + ".terminal.json");
          const terminal = JSON.parse(await fs.readFile(terminalPath, "utf8"));
          if (terminal.status !== "answered") throw new Error("input ACK mailbox settlement is absent");
          await dieAtCut(cut);
        }
        await originalRename(source, destination);
        if (cut === "claim_after_rename_before_directory_sync") await dieAtCut(cut);
      };

      const result = control === "cancel"
        ? await cancelRunTask(started.run_id)
        : await answerRunTaskInput({
            runId: started.run_id,
            requestId,
            answer: "continue",
            responseId: "crash-cut-response-001",
          });
      await new Promise((resolve) => process.stdout.write(JSON.stringify({ kind: "success", result }) + "\\n", resolve));
      process.exit(90);
    `;
  }

  for (const spec of cuts) {
    await t.test(spec.cut, async () => {
      const fixture = await createDirectRunTestFixture(`subagent007-control-crash-${spec.cut}-`);
      const env = { ...process.env, ...fixture.env };
      try {
        const crashed = await runTestWorker(crashWorkerSource(fixture, spec.cut, spec.control), env, 8_000);
        assert.equal(crashed.code, null, crashed.stderr || crashed.stdout);
        assert.equal(crashed.signal, "SIGKILL", crashed.stderr || crashed.stdout);
        assert.match(crashed.stderr, new RegExp(`CRASH_CUT:${spec.cut}`));
        const outputLines = crashed.stdout.trim().split(/\r?\n/).filter(Boolean);
        assert.equal(outputLines.length, 1, crashed.stdout);
        const identity = JSON.parse(outputLines[0]) as {
          kind: "ready";
          run_id: string;
          request_id: string | null;
        };
        assert.equal(identity.kind, "ready");
        assert.equal(crashed.stdout.includes('"kind":"success"'), false);

        const recordPath = path.join(fixture.runTasksDir, `${identity.run_id}.json`);
        const rawBeforeRecovery = JSON.parse(await fs.readFile(recordPath, "utf8")) as Record<string, unknown>;
        assert.equal(rawBeforeRecovery.record_name, "subagent007.current_run_claim");
        const beforeRecovery = persistedDurableRunView(rawBeforeRecovery);
        assert.equal(beforeRecovery.run_id, identity.run_id);
        const expectedClientStartId = `crash-cut-${spec.control}-${spec.cut}`;
        const clientStartBinding = rawBeforeRecovery.client_start_binding as {
          client_start_id?: unknown;
          request_sha256?: unknown;
          run_id?: unknown;
        } | undefined;
        assert.ok(clientStartBinding);
        assert.equal(clientStartBinding.client_start_id, expectedClientStartId);
        assert.equal(clientStartBinding.run_id, identity.run_id);
        assert.match(String(clientStartBinding.request_sha256 ?? ""), /^[0-9a-f]{64}$/);
        assert.equal(
          claimAccepted(beforeRecovery, spec.control, identity.request_id ?? undefined),
          spec.canonicalAcceptedBeforeRecovery,
        );
        if (spec.cut === "claim_after_file_sync_before_rename") {
          const tempNames = (await fs.readdir(fixture.runTasksDir)).filter((entry) =>
            entry.startsWith(`${identity.run_id}.json.tmp-`));
          assert.equal(tempNames.length, 1);
          const privateCandidate = persistedDurableRunView(JSON.parse(
            await fs.readFile(path.join(fixture.runTasksDir, tempNames[0]), "utf8"),
          ));
          assert.equal(claimAccepted(privateCandidate, spec.control), true);
        }
        if (spec.cut === "input_after_ack_before_claim") {
          assert.ok(identity.request_id);
          const terminalPath = path.join(
            fixture.env.SUBAGENT007_INPUT_REQUESTS_DIR,
            identity.run_id,
            `${identity.request_id}.terminal.json`,
          );
          const terminal = JSON.parse(await fs.readFile(terminalPath, "utf8")) as { status?: string };
          assert.equal(terminal.status, "answered");
        }

        const childPids = (await readJsonl<{ pid?: number }>(fixture.fake.logPath))
          .map((entry) => entry.pid)
          .filter((pid): pid is number => typeof pid === "number");
        assert.equal(childPids.length, 1);
        await Promise.all(childPids.map((pid) => waitForExactPidGone(pid)));
        const fakeLogBeforeReplay = await fs.readFile(fixture.fake.logPath, "utf8");

        const recoverSource = `
          const { getRunTask } = await import(${JSON.stringify(runTaskUrl)});
          console.log(JSON.stringify(await getRunTask(${JSON.stringify(identity.run_id)})));
        `;
        const recoveredProcess = await runTestWorker(recoverSource, env);
        assert.equal(recoveredProcess.code, 0, recoveredProcess.stderr);
        const recovered = JSON.parse(recoveredProcess.stdout.trim()) as RunSubagentMetadata;
        assert.equal(recovered.run_id, identity.run_id);
        assert.equal(recovered.status, "failed");
        assert.equal(recovered.error_class, "restart_drift");
        assert.equal(recovered.reason_code, "server_restarted_active_run");
        assert.equal(recovered.recent_events?.filter((event) => event.event === "failed").length, 1);
        assert.equal(
          claimAccepted(recovered, spec.control, identity.request_id ?? undefined),
          spec.canonicalAcceptedBeforeRecovery,
        );

        const terminalBytes = await fs.readFile(recordPath, "utf8");
        const replayedRecoveryProcess = await runTestWorker(recoverSource, env);
        assert.equal(replayedRecoveryProcess.code, 0, replayedRecoveryProcess.stderr);
        assert.deepEqual(JSON.parse(replayedRecoveryProcess.stdout.trim()), recovered);
        assert.equal(await fs.readFile(recordPath, "utf8"), terminalBytes);

        const controlReplaySource = spec.control === "input"
          ? `
              const { answerRunTaskInput } = await import(${JSON.stringify(runTaskUrl)});
              const attempts = {};
              for (const [name, answer] of [["exact", "continue"], ["changed", "changed"]]) {
                try {
                  await answerRunTaskInput({
                    runId: ${JSON.stringify(identity.run_id)},
                    requestId: ${JSON.stringify(identity.request_id)},
                    answer,
                    responseId: "crash-cut-response-001",
                  });
                  attempts[name] = "authored";
                } catch (error) {
                  attempts[name] = error?.reasonCode ?? error?.name;
                }
              }
              console.log(JSON.stringify(attempts));
            `
          : `
              const { cancelRunTask } = await import(${JSON.stringify(runTaskUrl)});
              try {
                const result = await cancelRunTask(${JSON.stringify(identity.run_id)});
                console.log(JSON.stringify({ replay: "returned", run_id: result.run_id, status: result.status }));
              } catch (error) {
                console.log(JSON.stringify({ replay: error?.reasonCode ?? error?.name }));
              }
            `;
        const controlReplay = await runTestWorker(controlReplaySource, env);
        assert.equal(controlReplay.code, 0, controlReplay.stderr);
        const replayResult = JSON.parse(controlReplay.stdout.trim()) as Record<string, string>;
        if (spec.control === "input") {
          assert.deepEqual(replayResult, { exact: "run_not_found", changed: "run_not_found" });
        } else {
          assert.equal(replayResult.replay, "returned");
          assert.equal(replayResult.run_id, identity.run_id);
          assert.equal(replayResult.status, "failed");
        }
        assert.equal(await fs.readFile(fixture.fake.logPath, "utf8"), fakeLogBeforeReplay);
        assert.equal(await fs.readFile(recordPath, "utf8"), terminalBytes);
        const canonicalNames = (await fs.readdir(fixture.runTasksDir)).filter((entry) =>
          entry.endsWith(".json") && !entry.includes(".tmp-"));
        assert.deepEqual(canonicalNames, [`${identity.run_id}.json`]);
      } finally {
        await removeDirectRunTestFixture(fixture);
      }
    });
  }
});

test("resident public cancel and accepted input settlement do not acquire the claim lock", async (t) => {
  const fixture = await createDirectRunTestFixture("subagent007-resident-control-claim-lock-");
  const originalLink = fs.link.bind(fs);
  const originalRename = fs.rename.bind(fs);
  const acquisitions: string[] = [];
  let tracked: { runId: string; operation: "cancel" | "input" } | undefined;

  t.mock.method(fs, "link", async (source: string, destination: string) => {
    if (tracked) {
      const expected = path.join(
        path.resolve(fixture.runTasksDir),
        ".claim-locks",
        `${createHash("sha256").update(tracked.runId).digest("hex")}.lock`,
      );
      if (path.resolve(destination) === expected) acquisitions.push(tracked.operation);
    }
    await originalLink(source, destination);
  });
  t.mock.method(fs, "rename", async (source: string, destination: string) => {
    await originalRename(source, destination);
    if (!tracked || !source.includes(".tmp-") || path.resolve(destination) !==
      path.join(path.resolve(fixture.runTasksDir), `${tracked.runId}.json`)) return;
    const candidate = persistedDurableRunView(JSON.parse(await fs.readFile(destination, "utf8")));
    const operationCommitted = tracked.operation === "cancel"
      ? candidate.recent_events?.some((event) => event.event === "cancellation_requested") === true
      : candidate.input_requests.some((request) => request.status === "answered");
    if (operationCommitted) tracked = undefined;
  });

  const runIds: string[] = [];
  try {
    await withEnv(fixture.env, async () => {
      const cancellable = await startRunTask({ cwd: fixture.projectDir, prompt: "CANCEL_WAIT" });
      runIds.push(cancellable.run_id);
      await waitForDirectRunView(cancellable.run_id, (view) => view.child_started === true, "cancellable child start");
      tracked = { runId: cancellable.run_id, operation: "cancel" };
      const cancelling = await cancelRunTask(cancellable.run_id) as RunSubagentMetadata;
      assertCancellationInProgressOrSettled(cancelling);
      assert.equal(tracked, undefined, "cancel claim publication interceptor was not reached");

      const inputRun = await startRunTask({ cwd: fixture.projectDir, prompt: "REQUEST_INPUT_WAIT" });
      runIds.push(inputRun.run_id);
      const pending = await waitForDirectRunView(inputRun.run_id, (view) =>
        view.status === "input_required" && view.input_requests.some((request) => request.status === "pending"), "input request");
      const request = pending.input_requests.find((entry) => entry.status === "pending");
      assert.ok(request);
      tracked = { runId: inputRun.run_id, operation: "input" };
      const accepted = await answerRunTaskInput({
        runId: inputRun.run_id,
        requestId: request.request_id,
        answer: "continue",
        responseId: "claim-lock-witness-001",
      });
      assert.equal(accepted.outcome, "accepted");
      assert.equal(tracked, undefined, "input claim publication interceptor was not reached");
      assert.deepEqual(acquisitions, []);
    });
  } finally {
    await withEnv(fixture.env, async () => {
      await Promise.all(runIds.map((runId) => cancelAndWaitForDirectRun(runId)));
    });
    await removeDirectRunTestFixture(fixture);
  }
});

test("resident cancel, input ACK, and terminal races preserve one exact committed claim", async (t) => {
  const fixture = await createDirectRunTestFixture("subagent007-resident-control-races-");
  const originalRename = fs.rename.bind(fs);
  let armed: {
    predicate: (view: RunSubagentMetadata) => boolean;
    entered: ReturnType<typeof deferredSignal>;
    release: ReturnType<typeof deferredSignal>;
  } | undefined;

  t.mock.method(fs, "rename", async (source: string, destination: string) => {
    if (armed && source.includes(".tmp-") && path.dirname(path.resolve(destination)) === path.resolve(fixture.runTasksDir)) {
      const candidate = persistedDurableRunView(JSON.parse(await fs.readFile(source, "utf8")));
      if (armed.predicate(candidate)) {
        const pause = armed;
        armed = undefined;
        pause.entered.resolve();
        await pause.release.promise;
      }
    }
    await originalRename(source, destination);
  });

  function pauseNext(predicate: (view: RunSubagentMetadata) => boolean) {
    const pause = { predicate, entered: deferredSignal(), release: deferredSignal() };
    armed = pause;
    return pause;
  }

  async function assertExactCommittedReplay(runId: string): Promise<RunSubagentMetadata> {
    const recordPath = path.join(fixture.runTasksDir, `${runId}.json`);
    const bytes = await fs.readFile(recordPath, "utf8");
    const committed = persistedDurableRunView(JSON.parse(bytes));
    const resident = await getRunTask(runId) as RunSubagentMetadata;
    const residentClaimProjection = Object.fromEntries(
      Object.keys(committed).map((key) => [key, (resident as unknown as Record<string, unknown>)[key]]),
    );
    assert.deepEqual(residentClaimProjection, committed);
    assert.deepEqual(await getRunTask(runId), resident);
    assert.equal(await fs.readFile(recordPath, "utf8"), bytes);
    return committed;
  }

  const runIds: string[] = [];
  try {
    await withEnv(fixture.env, async () => {
      const cancelAckRun = await startRunTask({ cwd: fixture.projectDir, prompt: "REQUEST_INPUT_WAIT" });
      runIds.push(cancelAckRun.run_id);
      const cancelAckPending = await waitForDirectRunView(cancelAckRun.run_id, (view) =>
        view.status === "input_required" && view.input_requests.some((request) => request.status === "pending"), "cancel/ACK input request");
      const cancelAckRequest = cancelAckPending.input_requests.find((entry) => entry.status === "pending");
      assert.ok(cancelAckRequest);
      const ackPause = pauseNext((view) => view.run_id === cancelAckRun.run_id &&
        view.input_requests.some((request) => request.request_id === cancelAckRequest.request_id && request.status === "answered"));
      const answer = answerRunTaskInput({
        runId: cancelAckRun.run_id,
        requestId: cancelAckRequest.request_id,
        answer: "continue",
        responseId: "race-cancel-ack-001",
      });
      await ackPause.entered.promise;
      let cancelSettled = false;
      const cancel = cancelRunTask(cancelAckRun.run_id).finally(() => { cancelSettled = true; });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(cancelSettled, false);
      ackPause.release.resolve();
      const accepted = await answer;
      assert.equal(accepted.outcome, "accepted");
      await cancel;
      const cancelled = await waitForTerminalRunTask(cancelAckRun.run_id);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.input_requests.find((request) => request.request_id === cancelAckRequest.request_id)?.status, "answered");
      const cancelAckReplay = await answerRunTaskInput({
        runId: cancelAckRun.run_id,
        requestId: cancelAckRequest.request_id,
        answer: "continue",
        responseId: "race-cancel-ack-001",
      });
      assert.equal(cancelAckReplay.outcome, "replayed");
      await assertExactCommittedReplay(cancelAckRun.run_id);

      const terminalPause = pauseNext((view) => view.status === "completed");
      const terminalCancelRun = await startRunTask({ cwd: fixture.projectDir, prompt: "FAST" });
      runIds.push(terminalCancelRun.run_id);
      await terminalPause.entered.promise;
      let terminalCancelSettled = false;
      const lateCancel = cancelRunTask(terminalCancelRun.run_id).finally(() => { terminalCancelSettled = true; });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(terminalCancelSettled, false);
      terminalPause.release.resolve();
      await lateCancel;
      const completed = await waitForTerminalRunTask(terminalCancelRun.run_id);
      assert.equal(completed.status, "completed");
      assert.equal(completed.recent_events?.some((event) => event.event === "cancellation_requested"), false);
      await assertExactCommittedReplay(terminalCancelRun.run_id);

      const ackTerminalRun = await startRunTask({ cwd: fixture.projectDir, prompt: "REQUEST_INPUT_ACK_THEN_EXIT" });
      runIds.push(ackTerminalRun.run_id);
      const ackTerminalPending = await waitForDirectRunView(ackTerminalRun.run_id, (view) =>
        view.status === "input_required" && view.input_requests.some((request) => request.status === "pending"), "ACK/terminal input request");
      const ackTerminalRequest = ackTerminalPending.input_requests.find((entry) => entry.status === "pending");
      assert.ok(ackTerminalRequest);
      const ackTerminalPause = pauseNext((view) => view.run_id === ackTerminalRun.run_id &&
        view.input_requests.some((request) => request.request_id === ackTerminalRequest.request_id && request.status === "answered"));
      const terminalAnswer = answerRunTaskInput({
        runId: ackTerminalRun.run_id,
        requestId: ackTerminalRequest.request_id,
        answer: "continue",
        responseId: "race-ack-terminal-001",
      });
      await ackTerminalPause.entered.promise;
      await new Promise((resolve) => setTimeout(resolve, 30));
      ackTerminalPause.release.resolve();
      const terminalAccepted = await terminalAnswer;
      assert.equal(terminalAccepted.outcome, "accepted");
      const failed = await waitForTerminalRunTask(ackTerminalRun.run_id);
      assert.equal(failed.status, "failed");
      assert.equal(failed.input_requests.find((request) => request.request_id === ackTerminalRequest.request_id)?.status, "answered");
      const terminalReplay = await answerRunTaskInput({
        runId: ackTerminalRun.run_id,
        requestId: ackTerminalRequest.request_id,
        answer: "continue",
        responseId: "race-ack-terminal-001",
      });
      assert.equal(terminalReplay.outcome, "replayed");
      await assertExactCommittedReplay(ackTerminalRun.run_id);
    });
  } finally {
    armed?.release.resolve();
    await withEnv(fixture.env, async () => {
      await Promise.all(runIds.map((runId) => cancelAndWaitForDirectRun(runId)));
    });
    await removeDirectRunTestFixture(fixture);
  }
});

test("a foreign process cannot control a live run and owner death yields one restart drift", async () => {
  const fixture = await createDirectRunTestFixture("subagent007-two-process-live-owner-");
  const runTaskUrl = pathToFileURL(path.resolve("src/runTask.ts")).href;
  const ownerSource = `
    const { getRunTask, startRunTask } = await import(${JSON.stringify(runTaskUrl)});
    const started = await startRunTask({ cwd: ${JSON.stringify(fixture.projectDir)}, prompt: "REQUEST_INPUT_WAIT" });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const view = await getRunTask(started.run_id);
      const request = view.input_requests.find((entry) => entry.status === "pending");
      if (view.status === "input_required" && request) {
        console.log(JSON.stringify({ run_id: started.run_id, request_id: request.request_id }));
        await new Promise(() => {});
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("owner did not reach input_required");
  `;
  const env = { ...process.env, ...fixture.env };
  const owner = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", ownerSource], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let ownerStdout = "";
  let ownerStderr = "";
  owner.stdout.setEncoding("utf8");
  owner.stderr.setEncoding("utf8");
  owner.stdout.on("data", (chunk: string) => { ownerStdout += chunk; });
  owner.stderr.on("data", (chunk: string) => { ownerStderr += chunk; });

  try {
    const deadline = Date.now() + 2_000;
    while (!ownerStdout.includes("\n") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(ownerStdout, /run_id/, ownerStderr);
    const identity = JSON.parse(ownerStdout.trim().split(/\r?\n/)[0]) as { run_id: string; request_id: string };
    const recordPath = path.join(fixture.runTasksDir, `${identity.run_id}.json`);
    const liveBytes = await fs.readFile(recordPath, "utf8");
    const foreignSource = `
      const { answerRunTaskInput, cancelRunTask, getRunTask } = await import(${JSON.stringify(runTaskUrl)});
      const rejected = {};
      for (const [name, operation] of [
        ["cancel", () => cancelRunTask(${JSON.stringify(identity.run_id)})],
        ["input", () => answerRunTaskInput({
          runId: ${JSON.stringify(identity.run_id)},
          requestId: ${JSON.stringify(identity.request_id)},
          answer: "foreign-answer",
          responseId: "foreign-response-001",
        })],
      ]) {
        try { await operation(); rejected[name] = "authored"; }
        catch (error) { rejected[name] = error?.reasonCode; }
      }
      const view = await getRunTask(${JSON.stringify(identity.run_id)});
      console.log(JSON.stringify({ rejected, view }));
    `;
    const foreign = await runTestWorker(foreignSource, env);
    assert.equal(foreign.code, 0, foreign.stderr);
    const witness = JSON.parse(foreign.stdout.trim()) as {
      rejected: { cancel: string; input: string };
      view: RunSubagentMetadata;
    };
    assert.deepEqual(witness.rejected, { cancel: "run_not_found", input: "run_not_found" });
    assert.equal(["working", "input_required"].includes(witness.view.status), true);
    assert.notEqual(witness.view.error_class, "restart_drift");
    assert.equal(await fs.readFile(recordPath, "utf8"), liveBytes);

    const childPid = (await readJsonl<{ pid?: number }>(fixture.fake.logPath))
      .map((entry) => entry.pid)
      .find((pid): pid is number => typeof pid === "number");
    assert.ok(childPid);
    assert.equal(owner.kill("SIGKILL"), true);
    const ownerExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      owner.once("error", reject);
      owner.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(ownerExit.signal, "SIGKILL", ownerStderr);
    await waitForExactPidGone(childPid);

    const recoverSource = `
      const { getRunTask } = await import(${JSON.stringify(runTaskUrl)});
      console.log(JSON.stringify(await getRunTask(${JSON.stringify(identity.run_id)})));
    `;
    const recovered = await Promise.all([
      runTestWorker(recoverSource, env),
      runTestWorker(recoverSource, env),
    ]);
    assert.equal(recovered.every((result) => result.code === 0), true,
      recovered.map((result) => result.stderr).join("\n"));
    const views = recovered.map((result) => JSON.parse(result.stdout.trim()) as RunSubagentMetadata);
    assert.equal(views.every((view) => view.status === "failed" &&
      view.error_class === "restart_drift" && view.reason_code === "server_restarted_active_run"), true);
    assert.equal(views[1].finished_at, views[0].finished_at);
    assert.deepEqual(views[1].output_references, views[0].output_references);
    assert.deepEqual(views[1].recent_events, views[0].recent_events);
    const terminalBytes = await fs.readFile(recordPath, "utf8");
    const committed = persistedDurableRunView(JSON.parse(terminalBytes));
    assert.equal(committed.recent_events?.filter((event) => event.event === "failed").length, 1);
    const replay = await runTestWorker(recoverSource, env);
    const secondReplay = await runTestWorker(recoverSource, env);
    assert.equal(replay.code, 0, replay.stderr);
    assert.equal(secondReplay.code, 0, secondReplay.stderr);
    const replayView = JSON.parse(replay.stdout.trim()) as RunSubagentMetadata;
    assert.deepEqual(JSON.parse(secondReplay.stdout.trim()), replayView);
    const replayClaimProjection = Object.fromEntries(
      Object.keys(committed).map((key) => [key, (replayView as unknown as Record<string, unknown>)[key]]),
    );
    assert.deepEqual(replayClaimProjection, committed);
    assert.equal(await fs.readFile(recordPath, "utf8"), terminalBytes);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    await removeDirectRunTestFixture(fixture);
  }
});

test("lineage cannot publish a stale claim after child-spawn publication overtakes lock acquisition", async () => {
  const fixture = await createDirectRunTestFixture("subagent007-lineage-spawn-owner-race-");
  const activeChildrenDir = fixture.env.SUBAGENT007_ACTIVE_CHILDREN_DIR;
  assert.ok(activeChildrenDir);
  const capacityLockPath = path.join(activeChildrenDir, ".lock");
  const capacityAcquisitionPaused = deferredSignal();
  const releaseCapacityAcquisition = deferredSignal();
  const lineageAcquisitionPaused = deferredSignal();
  const releaseLineageAcquisition = deferredSignal();
  const childSpawnPublished = deferredSignal();
  const originalMkdir = fs.mkdir.bind(fs);
  const originalLink = fs.link.bind(fs);
  const originalRename = fs.rename.bind(fs);
  let pauseCapacityPromotion = false;
  let capacityPaused = false;
  let lineageLockPath: string | undefined;
  let lineagePaused = false;
  let rootRunId: string | undefined;
  let holderRunId: string | undefined;
  const previousMaxActiveChildren = process.env.SUBAGENT007_MAX_ACTIVE_CHILDREN;

  (fs as unknown as { mkdir: typeof fs.mkdir }).mkdir = (async (...args: Parameters<typeof fs.mkdir>) => {
    const directory = args[0];
    if (
      pauseCapacityPromotion &&
      !capacityPaused &&
      typeof directory === "string" &&
      path.resolve(directory) === path.resolve(capacityLockPath)
    ) {
      capacityPaused = true;
      capacityAcquisitionPaused.resolve();
      await releaseCapacityAcquisition.promise;
    }
    return originalMkdir(...args);
  }) as typeof fs.mkdir;
  (fs as unknown as { link: typeof fs.link }).link = (async (...args: Parameters<typeof fs.link>) => {
    const destination = args[1];
    if (
      lineageLockPath &&
      !lineagePaused &&
      typeof destination === "string" &&
      path.resolve(destination) === lineageLockPath
    ) {
      lineagePaused = true;
      lineageAcquisitionPaused.resolve();
      await releaseLineageAcquisition.promise;
    }
    return originalLink(...args);
  }) as typeof fs.link;
  (fs as unknown as { rename: typeof fs.rename }).rename = (async (...args: Parameters<typeof fs.rename>) => {
    await originalRename(...args);
    const [source, destination] = args;
    if (
      rootRunId &&
      typeof source === "string" &&
      typeof destination === "string" &&
      path.resolve(destination) === path.join(path.resolve(fixture.runTasksDir), `${rootRunId}.json`) &&
      source.includes(".tmp-")
    ) {
      const published = JSON.parse(await fs.readFile(destination, "utf8")) as RunSubagentMetadata;
      if (published.child_started === true) childSpawnPublished.resolve();
    }
  }) as typeof fs.rename;

  try {
    await withEnv({
      ...fixture.env,
      SUBAGENT007_MAX_ACTIVE_CHILDREN: "1",
      SUBAGENT007_MAX_QUEUED_RUNS: "1",
    }, async () => {
      const holder = await startRunTask({ cwd: fixture.projectDir, prompt: "CANCEL_WAIT" });
      holderRunId = holder.run_id;
      await waitForDirectRunView(holder.run_id, (view) => view.child_started === true, "capacity holder start");

      const root = await startRunTask({ cwd: fixture.projectDir, prompt: "CANCEL_WAIT" });
      rootRunId = root.run_id;
      assert.equal(root.child_started, false);
      assert.equal(root.active_phase, "queued");
      lineageLockPath = path.join(
        path.resolve(fixture.runTasksDir),
        ".claim-locks",
        `${createHash("sha256").update(root.run_id).digest("hex")}.lock`,
      );

      pauseCapacityPromotion = true;
      await Promise.race([
        capacityAcquisitionPaused.promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("queue promotion did not reach capacity lock")), 1_500)),
      ]);

      process.env.SUBAGENT007_MAX_ACTIVE_CHILDREN = "0";
      const childStart = startRunTask(
        { cwd: fixture.projectDir, prompt: "FAST" },
        { lineage: { parentRunId: root.run_id, rootRunId: root.run_id, recursionDepth: 1 } },
      );
      await Promise.race([
        lineageAcquisitionPaused.promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("lineage did not pause before root claim-lock acquisition")), 1_500)),
      ]);

      process.env.SUBAGENT007_MAX_ACTIVE_CHILDREN = "1";
      await cancelRunTask(holder.run_id);
      await waitForTerminalRunTask(holder.run_id);
      releaseCapacityAcquisition.resolve();
      const spawnOvertookLineage = await Promise.race([
        childSpawnPublished.promise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 150)),
      ]);
      releaseLineageAcquisition.resolve();
      if (!spawnOvertookLineage) {
        await Promise.race([
          childSpawnPublished.promise,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("root child-spawn claim did not follow lineage publication")), 1_500)),
        ]);
      }

      const child = await childStart;
      await waitForTerminalRunTask(child.run_id);
      const converged = await getRunTask(root.run_id) as RunSubagentMetadata;
      assert.equal(converged.child_started, true);
      assert.deepEqual(converged.child_run_ids, [child.run_id]);
      assert.deepEqual(converged.descendant_run_ids, [child.run_id]);
    });
  } finally {
    if (previousMaxActiveChildren === undefined) delete process.env.SUBAGENT007_MAX_ACTIVE_CHILDREN;
    else process.env.SUBAGENT007_MAX_ACTIVE_CHILDREN = previousMaxActiveChildren;
    pauseCapacityPromotion = false;
    releaseCapacityAcquisition.resolve();
    releaseLineageAcquisition.resolve();
    (fs as unknown as { mkdir: typeof fs.mkdir }).mkdir = originalMkdir;
    (fs as unknown as { link: typeof fs.link }).link = originalLink;
    (fs as unknown as { rename: typeof fs.rename }).rename = originalRename;
    await withEnv(fixture.env, async () => {
      if (rootRunId) await cancelAndWaitForDirectRun(rootRunId);
      if (holderRunId) await cancelAndWaitForDirectRun(holderRunId);
    });
    await removeDirectRunTestFixture(fixture);
  }
});

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
      assert.equal(path.dirname(outputPathFor(result, runsDir)), runsDir);
      assert.equal(await fs.readFile(outputPathFor(result, runsDir), "utf8"), "FAST FINAL");

      const logs = await readJsonl<{ request: Record<string, unknown> }>(fake.logPath);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].request.sessionMode, "ephemeral");
      assert.equal(logs[0].request.prompt, "/skill:fixture-pda-lite\n\n<prompt>\nFAST\n</prompt>");
      assert.deepEqual(logs[0].request.promptProvenance, {
        public_prompt: PUBLIC_PROMPT_REDACTED_MARKER,
        skill_name: skillName,
        skill_marker: "[server_contract] skill_name=fixture-pda-lite",
        composed_child_prompt: "/skill:fixture-pda-lite\n\n<prompt>\nFAST\n</prompt>",
      });
      assert.equal(logs[0].request.skill, skillName);
      assert.equal(logs[0].request.skillFilePath, skillPath);
      assert.equal(logs[0].request.cwd, projectDir);
      assert.equal(Object.hasOwn(logs[0].request, "toolProfile"), false);
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

test("start_run rejects before child launch when the configured local child fuse is exhausted", async () => {
  const activeChildrenDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-active-children-"));
  await connectFakeClient(
    async (client, { projectDir }) => {
      const firstResponse = await client.callTool({
        name: "start_run",
        arguments: {
          cwd: projectDir,
          prompt: "REQUEST_INPUT_WAIT",
          output_mode: "final",
          timeout_ms: 10000,
        },
      });
      assert.notEqual(firstResponse.isError, true);
      const first = firstResponse.structuredContent as RunSubagentMetadata;
      await waitForInputRequired(client, first.run_id);

      const rejectedResponse = await client.callTool({
        name: "start_run",
        arguments: {
          cwd: projectDir,
          prompt: "FAST",
          output_mode: "final",
          timeout_ms: 10000,
        },
      });
      assert.notEqual(rejectedResponse.isError, true);
      const rejected = rejectedResponse.structuredContent as RunSubagentMetadata;
      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.kind, "preflight_rejected");
      assert.equal(rejected.child_started, false);
      assert.equal(rejected.reason_code, "local_capacity_exhausted");
      assert.match(rejected.retry_guidance ?? "", /active child run completes/);

      const cancelResponse = await client.callTool({
        name: "cancel_run",
        arguments: { run_id: first.run_id },
      });
      assert.notEqual(cancelResponse.isError, true);
      const cancelled = await waitForTerminalRun(client, first.run_id);
      assert.equal(cancelled.status, "cancelled");

      const afterReleaseResponse = await client.callTool({
        name: "start_run",
        arguments: {
          cwd: projectDir,
          prompt: "FAST",
          output_mode: "final",
          timeout_ms: 10000,
        },
      });
      assert.notEqual(afterReleaseResponse.isError, true);
      const afterRelease = afterReleaseResponse.structuredContent as RunSubagentMetadata;
      assert.notEqual(afterRelease.status, "rejected");
      const completed = await waitForTerminalRun(client, afterRelease.run_id);
      assert.equal(completed.success, true);
      assert.equal(completed.status, "completed");
    },
    {
      env: {
        SUBAGENT007_MAX_ACTIVE_CHILDREN: "1",
        SUBAGENT007_MAX_QUEUED_RUNS: "0",
        SUBAGENT007_ACTIVE_CHILDREN_DIR: activeChildrenDir,
      },
    },
  );
});

test("top-level start_run and schedule_run share bounded queue promotion", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-queued-runs-"));
  await connectFakeClient(
    async (client, { projectDir }) => {
      const firstResponse = await client.callTool({
        name: "start_run",
        arguments: { cwd: projectDir, prompt: "REQUEST_INPUT_WAIT", output_mode: "final", timeout_ms: 10000 },
      });
      const first = firstResponse.structuredContent as RunSubagentMetadata;
      await waitForInputRequired(client, first.run_id);

      const cancelledQueuedResponse = await client.callTool({
        name: "start_run",
        arguments: { cwd: projectDir, prompt: "FAST", output_mode: "final", timeout_ms: 10000 },
      });
      const cancelledQueued = cancelledQueuedResponse.structuredContent as RunSubagentMetadata;
      assert.equal(cancelledQueued.active_phase, "queued");
      await client.callTool({ name: "cancel_run", arguments: { run_id: cancelledQueued.run_id } });
      const cancelledBeforeLaunch = await waitForTerminalRun(client, cancelledQueued.run_id);
      assert.equal(cancelledBeforeLaunch.status, "cancelled");
      assert.equal(cancelledBeforeLaunch.child_started, false);
      assert.equal(cancelledBeforeLaunch.active_phase, "cancelled");
      assert.equal(cancelledBeforeLaunch.success, false);
      assert.equal(cancelledBeforeLaunch.exit_code, null);
      assert.equal(cancelledBeforeLaunch.timed_out, false);
      assert.equal(cancelledBeforeLaunch.resume_possible, false);
      assert.equal(cancelledBeforeLaunch.requested_timeout_ms, null);
      assert.equal(cancelledBeforeLaunch.resolved_timeout_ms, null);
      assert.equal(cancelledBeforeLaunch.effective_timeout_ms, null);
      assert.deepEqual(cancelledBeforeLaunch.input_requests.filter((request) => request.status === "pending"), []);
      assert.equal(cancelledBeforeLaunch.reason_code, undefined);
      const settledEvent = cancelledBeforeLaunch.recent_events?.find((event) => event.event === "cancellation_settled");
      assert.ok(settledEvent);
      assert.deepEqual(settledEvent.metadata, {});
      const persistedBeforeLaunch = persistedDurableRunView(JSON.parse(await fs.readFile(
        path.join(stateRoot, "run-tasks", `${cancelledQueued.run_id}.json`),
        "utf8",
      )) as unknown);
      assert.equal(persistedBeforeLaunch.status, "cancelled");
      assert.equal(persistedBeforeLaunch.child_started, false);
      assert.equal(persistedBeforeLaunch.active_phase, "cancelled");
      assert.equal(persistedBeforeLaunch.stop_reason, undefined);
      assert.equal(persistedBeforeLaunch.exit_code, null);
      assert.equal(persistedBeforeLaunch.timed_out, false);
      const readbackBeforeLaunch = (await client.callTool({
        name: "get_run",
        arguments: { run_id: cancelledQueued.run_id },
      })).structuredContent as RunSubagentMetadata;
      const cancelledAgain = (await client.callTool({
        name: "cancel_run",
        arguments: { run_id: cancelledQueued.run_id },
      })).structuredContent as RunSubagentMetadata;
      assert.equal(readbackBeforeLaunch.status, "cancelled");
      assert.equal(cancelledAgain.status, "cancelled");

      const queuedResponse = await client.callTool({
        name: "schedule_run",
        arguments: { cwd: projectDir, prompt: "FAST", output_mode: "final", timeout_ms: 10000, wait_ms: 0 },
      });
      const queued = queuedResponse.structuredContent as RunSubagentMetadata;
      assert.equal(queued.status, "working");
      assert.equal(queued.active_phase, "queued");
      assert.equal(queued.child_started, false);
      assert.equal(typeof queued.queued_at, "string");
      const ticketText = await fs.readFile(
        path.join(stateRoot, "queued", `${queued.run_id}.json`),
        "utf8",
      );
      assert.doesNotMatch(ticketText, /FAST|prompt|cwd/);

      const overflowResponse = await client.callTool({
        name: "start_run",
        arguments: { cwd: projectDir, prompt: "FAST", output_mode: "final", timeout_ms: 10000 },
      });
      const overflow = overflowResponse.structuredContent as RunSubagentMetadata & { kind?: string; retry_guidance?: string };
      assert.equal(overflow.status, "rejected");
      assert.equal(overflow.kind, "preflight_rejected");
      assert.equal(overflow.child_started, false);
      assert.equal(overflow.reason_code, "local_queue_exhausted");
      assert.match(overflow.retry_guidance ?? "", /queued work advances/);

      await client.callTool({ name: "cancel_run", arguments: { run_id: first.run_id } });
      const cancelledAfterLaunch = await waitForTerminalRun(client, first.run_id);
      assert.equal(cancelledAfterLaunch.status, "cancelled");
      assert.equal(cancelledAfterLaunch.child_started, true);
      assert.equal(cancelledAfterLaunch.stop_reason, "cancelled");
      const completed = await waitForTerminalRun(client, queued.run_id);
      assert.equal(completed.status, "completed");
      assert.equal(completed.child_started, true);
      assert.equal(completed.child_started_at, undefined);
      assert.equal(completed.queue_wait_ms, undefined);
    },
    {
      env: {
        SUBAGENT007_MAX_ACTIVE_CHILDREN: "1",
        SUBAGENT007_MAX_QUEUED_RUNS: "1",
        SUBAGENT007_ACTIVE_CHILDREN_DIR: path.join(stateRoot, "active"),
        SUBAGENT007_QUEUED_RUNS_DIR: path.join(stateRoot, "queued"),
        SUBAGENT007_RUN_TASKS_DIR: path.join(stateRoot, "run-tasks"),
      },
    },
  );
});

test("start_run returns typed disk-reserve preflight rejection before child launch", async () => {
  await connectFakeClient(
    async (client, { projectDir, fakeLogPath }) => {
      const response = await client.callTool({
        name: "start_run",
        arguments: { cwd: projectDir, prompt: "FAST", output_mode: "final" },
      });
      assert.notEqual(response.isError, true);
      const rejected = response.structuredContent as RunSubagentMetadata;
      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.kind, "preflight_rejected");
      assert.equal(rejected.reason_code, "disk_reserve_exhausted");
      assert.equal(rejected.child_started, false);
      const childLogs = await readJsonl(fakeLogPath).catch(() => []);
      assert.equal(childLogs.length, 0);
    },
    { env: { SUBAGENT007_MIN_FREE_DISK_BYTES: String(Number.MAX_SAFE_INTEGER) } },
  );
});

test("runSubagent accepts legacy explicit tool profile without runtime profile state", async () => {
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
      assert.equal(Object.hasOwn(result, "resolved_tool_profile"), false);

      const logs = await readJsonl<{ request: Record<string, unknown> }>(fake.logPath);
      assert.equal(logs.length, 1);
      assert.equal(Object.hasOwn(logs[0].request, "toolProfile"), false);
    },
  );
});

test("workspace_read_only requires an exact pre-prompt activation receipt", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-read-only-"));
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
        { cwd: projectDir, prompt: "FAST", effect_profile: "workspace_read_only" },
        { runsDir },
      );
      assert.equal(result.success, true);
      assert.equal(result.requested_effect_profile, "workspace_read_only");
      assert.equal(result.resolved_effect_profile, "workspace_read_only");
      assert.deepEqual(result.activation_receipt?.active_tool_names, [
        "read", "grep", "find", "ls", "web_search", "web_read", "request_input",
      ]);
      const logs = await readJsonl<{ request: Record<string, unknown> }>(fake.logPath);
      assert.equal(logs[0].request.effectProfile, "workspace_read_only");
      assert.equal(Object.hasOwn(logs[0].request, "recursiveControl"), false);

      const missing = await runSubagent(
        { cwd: projectDir, prompt: "OMIT_ACTIVATION_RECEIPT", effect_profile: "workspace_read_only" },
        { runsDir },
      );
      assert.equal(missing.success, false);
      assert.equal(missing.reason_code, "effect_profile_activation_failed");
      assert.equal(missing.error_class, "capability_unavailable");
      assert.equal(missing.resolved_effect_profile, undefined);

      const conflicting = await runSubagent(
        { cwd: projectDir, prompt: "CONFLICT_ACTIVATION_RECEIPT", effect_profile: "workspace_read_only" },
        { runsDir },
      );
      assert.equal(conflicting.success, false);
      assert.equal(conflicting.reason_code, "effect_profile_activation_failed");
    },
  );
});

test("skill_creator_authoring_v1 exposes only task-root authoring tools with a pre-prompt receipt", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-skill-creator-authoring-"));
  const projectDir = path.join(tmp, "project");
  const runsDir = path.join(tmp, "runs");
  const fake = await createFakePiChild();
  await fs.mkdir(projectDir, { recursive: true });

  await withEnv({
    SUBAGENT007_PI_CHILD_PATH: fake.childPath,
    FAKE_PI_LOG_PATH: fake.logPath,
    SUBAGENT007_FAILURE_LOG: "off",
  }, async () => {
    const result = await runSubagent(
      { cwd: projectDir, prompt: "FAST", effect_profile: "skill_creator_authoring_v1" as never },
      { runsDir },
    );
    assert.equal(result.success, true);
    assert.equal(result.requested_effect_profile, "skill_creator_authoring_v1");
    assert.equal(result.resolved_effect_profile, "skill_creator_authoring_v1");
    assert.deepEqual(result.activation_receipt?.active_tool_names, [
      "read", "grep", "find", "ls", "write", "edit",
    ]);
    assert.deepEqual(result.activation_receipt?.tool_bindings, []);
    const logs = await readJsonl<{ request: Record<string, unknown> }>(fake.logPath);
    assert.equal(logs[0].request.effectProfile, "skill_creator_authoring_v1");
    assert.equal(Object.hasOwn(logs[0].request, "recursiveControl"), false);

    const fresh = await runSubagent(
      { cwd: projectDir, prompt: "FAST", continuity: { mode: "fresh" }, effect_profile: "skill_creator_authoring_v1" as never },
      { runsDir },
    );
    assert.equal(fresh.success, true);
    assert.ok(fresh.session_id);
    const resumed = await runSubagent(
      {
        cwd: projectDir,
        prompt: "FAST",
        continuity: { mode: "resume", session_id: fresh.session_id! },
        recursive_delegation: "disabled",
        effect_profile: "skill_creator_authoring_v1" as never,
      },
      { runsDir },
    );
    assert.equal(resumed.success, true);
    assert.equal(resumed.session_id, fresh.session_id);
  });
});

test("durable constrained runs persist activation before prompt for start_run and schedule_run", async () => {
  await connectFakeClient(async (client, { projectDir, fakeLogPath }) => {
    const startedResponse = await client.callTool({
      name: "start_run",
      arguments: {
        cwd: projectDir,
        prompt: "FAST",
        effect_profile: "workspace_read_only",
      },
    });
    assert.notEqual(startedResponse.isError, true);
    const started = startedResponse.structuredContent as RunSubagentMetadata;
    assert.equal(started.requested_effect_profile, "workspace_read_only");
    const terminal = await waitForTerminalRun(client, started.run_id);
    assert.equal(terminal.success, true);
    assert.equal(terminal.resolved_effect_profile, "workspace_read_only");
    assert.equal(terminal.activation_receipt?.confirmed_before_prompt, true);
    const eventNames = terminal.recent_events?.map((event) => event.event) ?? [];
    assert.ok(eventNames.indexOf("activation_confirmed") >= 0);
    assert.ok(eventNames.indexOf("activation_confirmed") < eventNames.indexOf("child_prompt_submitted"));

    const scheduledResponse = await client.callTool({
      name: "schedule_run",
      arguments: {
        cwd: projectDir,
        prompt: "FAST",
        effect_profile: "workspace_read_only",
        wait_ms: 5000,
      },
    });
    assert.notEqual(scheduledResponse.isError, true);
    const scheduled = scheduledResponse.structuredContent as RunSubagentMetadata;
    assert.equal(scheduled.success, true);
    assert.equal(scheduled.activation_receipt?.confirmed_before_prompt, true);

    const conflictingResponse = await client.callTool({
      name: "schedule_run",
      arguments: {
        cwd: projectDir,
        prompt: "CONFLICT_ACTIVATION_RECEIPT",
        effect_profile: "workspace_read_only",
        wait_ms: 5000,
      },
    });
    const conflicting = conflictingResponse.structuredContent as RunSubagentMetadata;
    assert.equal(conflicting.success, false);
    assert.equal(conflicting.reason_code, "effect_profile_activation_failed");
    assert.equal(
      conflicting.recent_events?.some((event) => event.event === "activation_confirmed") ?? false,
      false,
    );

    const missingStartResponse = await client.callTool({
      name: "start_run",
      arguments: {
        cwd: projectDir,
        prompt: "OMIT_ACTIVATION_RECEIPT",
        effect_profile: "workspace_read_only",
      },
    });
    const missingStart = missingStartResponse.structuredContent as RunSubagentMetadata;
    const missingTerminal = await waitForTerminalRun(client, missingStart.run_id) as RunSubagentMetadata & {
      stop_reason?: string;
    };
    assert.equal(missingTerminal.status, "failed");
    assert.equal(missingTerminal.success, false);
    assert.equal(missingTerminal.exit_code, 0);
    assert.equal(missingTerminal.stop_reason, "completed");
    assert.equal(missingTerminal.reason_code, "effect_profile_activation_failed");

    const logs = await readJsonl<{ request: Record<string, unknown> }>(fakeLogPath);
    assert.equal(logs.length, 4);
    assert.equal(logs.every((entry) => entry.request.effectProfile === "workspace_read_only"), true);
    assert.equal(logs.every((entry) => !Object.hasOwn(entry.request, "recursiveControl")), true);
  });
});

test("workspace_read_only supports fresh and raw resume only when supplied on each invocation", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-read-only-resume-"));
  const projectDir = path.join(tmp, "project");
  const runsDir = path.join(tmp, "runs");
  const fake = await createFakePiChild();
  await fs.mkdir(projectDir, { recursive: true });
  await withEnv({
    SUBAGENT007_PI_CHILD_PATH: fake.childPath,
    FAKE_PI_LOG_PATH: fake.logPath,
    SUBAGENT007_FAILURE_LOG: "off",
    SUBAGENT007_PI_RAW_SESSIONS_DIR: path.join(tmp, "raw-sessions"),
  }, async () => {
    const fresh = await runSubagent({
      cwd: projectDir,
      prompt: "FAST",
      continuity: { mode: "fresh" },
      effect_profile: "workspace_read_only",
    }, { runsDir, allowTimeout: true });
    assert.equal(fresh.success, true);
    assert.equal(typeof fresh.session_id, "string");
    assert.equal(fresh.activation_receipt?.confirmed_before_prompt, true);

    const resumed = await runSubagent({
      cwd: projectDir,
      prompt: "FAST",
      continuity: { mode: "resume", session_id: fresh.session_id! },
      recursive_delegation: "disabled",
      effect_profile: "workspace_read_only",
    }, { runsDir, allowTimeout: true });
    assert.equal(resumed.success, true);
    assert.equal(resumed.session_id, fresh.session_id);
    assert.equal(resumed.activation_receipt?.confirmed_before_prompt, true);
  });
});

test("expected_skill_sha256 mismatch fails before child launch and a match is receipted", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-skill-pin-"));
  const projectDir = path.join(tmp, "project");
  const runsDir = path.join(tmp, "runs");
  const skillsRoot = path.join(tmp, "skills");
  const skillName = "fixture-pinned-skill";
  const skillPath = await writeSkillFixture(skillsRoot, skillName);
  const actualDigest = await sha256File(skillPath);
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
      await assert.rejects(
        runSubagent({
          cwd: projectDir,
          prompt: "FAST",
          skill_name: skillName,
          expected_skill_sha256: "0".repeat(64),
        }, { runsDir }),
        (error: unknown) => error instanceof ValidationError && error.reasonCode === "skill_content_mismatch",
      );
      assert.deepEqual(await readJsonl(fake.logPath).catch(() => []), []);

      const matched = await runSubagent({
        cwd: projectDir,
        prompt: "FAST",
        skill_name: skillName,
        expected_skill_sha256: actualDigest,
      }, { runsDir });
      assert.equal(matched.success, true);
      assert.deepEqual(matched.activation_receipt?.skill_binding, {
        name: skillName,
        path: skillPath,
        content_sha256: actualDigest,
        expected_content_sha256: actualDigest,
      });
      const logs = await readJsonl<{ request: Record<string, unknown> }>(fake.logPath);
      assert.equal(logs.length, 1);
      assert.notEqual(logs[0].request.skillFilePath, skillPath);
      assert.equal(path.basename(String(logs[0].request.skillFilePath)), "SKILL.md");
      assert.deepEqual(logs[0].request.skillBinding, {
        name: skillName,
        path: skillPath,
        content_sha256: actualDigest,
        expected_content_sha256: actualDigest,
      });
    },
  );
});

test("all constrained start surfaces preflight-reject a mismatched skill digest", async () => {
  const skillsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-mcp-skill-pin-"));
  const skillName = "fixture-mcp-pinned-skill";
  await writeSkillFixture(skillsRoot, skillName);
  await connectFakeClient(async (client, { projectDir, fakeLogPath }) => {
    for (const name of ["run_subagent", "start_run", "schedule_run"] as const) {
      const response = await client.callTool({
        name,
        arguments: {
          cwd: projectDir,
          prompt: "FAST",
          skill_name: skillName,
          expected_skill_sha256: "0".repeat(64),
          ...(name === "run_subagent" ? { run_kind: "quick_noninteractive" } : {}),
        },
      });
      assert.notEqual(response.isError, true, name);
      const rejected = response.structuredContent as RunSubagentMetadata;
      assert.equal(rejected.status, "rejected", name);
      assert.equal(rejected.kind, "preflight_rejected", name);
      assert.equal(rejected.child_started, false, name);
      assert.equal(rejected.reason_code, "skill_content_mismatch", name);
    }
    assert.deepEqual(await readJsonl(fakeLogPath).catch(() => []), []);
  }, { env: { SUBAGENT007_PI_SKILL_PATHS: skillsRoot } });
});

test("all constrained start surfaces launch from one owner snapshot and closed references fail pre-prompt", async () => {
  const skillsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-snapshot-surfaces-"));
  const snapshotsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-snapshot-store-"));
  const durableStateRoot = path.join(snapshotsRoot, "durable-state");
  const skillName = "fixture-snapshot-skill";
  await writeSkillFixture(skillsRoot, skillName);
  await connectFakeClient(async (client, { projectDir, fakeLogPath }) => {
    const resolvedResponse = await client.callTool({
      name: "resolve_skill_runtime_bundles",
      arguments: { contract_version: 1, cwd: projectDir, skill_names: [skillName] },
    });
    const resolved = resolvedResponse.structuredContent as {
      bindings: Array<{ bundle_sha256: string }>;
    };
    const publicationResponse = await client.callTool({
      name: "publish_skill_snapshots",
      arguments: {
        contract_version: 1,
        cwd: projectDir,
        project_reference: { project_id: "project-surfaces", publication_id: "route-command-001", lifecycle: "active" },
        bindings: [{ skill_name: skillName, expected_bundle_sha256: resolved.bindings[0]!.bundle_sha256 }],
      },
    });
    assert.notEqual(publicationResponse.isError, true);
    const publication = publicationResponse.structuredContent as {
      bindings: Array<{
        snapshot_identity: { snapshot_id: string; metadata_sha256: string };
        publication_receipt: { receipt_sha256: string; reference_id: string; project_reference: { project_id: string; publication_id: string } };
      }>;
    };
    const item = publication.bindings[0]!;
    const skill_snapshot_binding = {
      contract_version: 1,
      snapshot_id: item.snapshot_identity.snapshot_id,
      metadata_sha256: item.snapshot_identity.metadata_sha256,
      publication_receipt_sha256: item.publication_receipt.receipt_sha256,
      reference_id: item.publication_receipt.reference_id,
      project_id: item.publication_receipt.project_reference.project_id,
      publication_id: item.publication_receipt.project_reference.publication_id,
    };
    for (const name of ["run_subagent", "start_run", "schedule_run"] as const) {
      const response = await client.callTool({
        name,
        arguments: {
          cwd: projectDir,
          prompt: "FAST",
          skill_name: skillName,
          skill_snapshot_binding,
          ...(name === "run_subagent" ? { run_kind: "quick_noninteractive" } : {}),
          ...(name === "schedule_run" ? { wait_ms: 2_000 } : {}),
        },
      });
      assert.notEqual(response.isError, true, name);
      const view = response.structuredContent as RunSubagentMetadata & { skill_snapshot_activation_receipt?: { snapshot_id?: string } };
      if (view.status === "working") {
        const terminal = await waitForTerminalRun(client, view.run_id) as RunSubagentMetadata & {
          skill_snapshot_activation_receipt?: { snapshot_id?: string };
        };
        assert.equal(terminal.skill_snapshot_activation_receipt?.snapshot_id, item.snapshot_identity.snapshot_id, name);
      } else {
        assert.equal(view.skill_snapshot_activation_receipt?.snapshot_id, item.snapshot_identity.snapshot_id, `${name}: ${JSON.stringify(view)}`);
      }
    }
    assert.equal((await readJsonl(fakeLogPath)).length, 3);
    const recursive = await client.callTool({
      name: "schedule_run",
      arguments: {
        cwd: projectDir,
        prompt: "RECURSIVE_DELEGATE_FAST",
        skill_name: skillName,
        skill_snapshot_binding,
        recursive_delegation: "enabled",
        wait_ms: 2_000,
      },
    });
    const recursiveView = recursive.structuredContent as RunSubagentMetadata & { descendant_run_ids?: string[] };
    assert.equal(recursiveView.status, "completed");
    const recursiveOutput = await fs.readFile(outputPathFor(recursiveView), "utf8");
    assert.equal(recursiveView.descendant_run_ids?.length, 1, JSON.stringify({ recursiveView, recursiveOutput }));
    const recursiveLogs = await readJsonl<{ request: { skillSnapshotBinding?: unknown } }>(fakeLogPath);
    assert.equal(recursiveLogs.length, 5);
    assert.deepEqual(recursiveLogs.slice(3).map((entry) => entry.request.skillSnapshotBinding), [
      skill_snapshot_binding,
      skill_snapshot_binding,
    ]);

    const closed = await client.callTool({
      name: "close_skill_snapshot_references",
      arguments: {
        contract_version: 1,
        project_id: "project-surfaces",
        publication_id: "route-command-001",
        snapshot_ids: [item.snapshot_identity.snapshot_id],
      },
    });
    assert.notEqual(closed.isError, true);
    const rejected = await client.callTool({
      name: "start_run",
      arguments: { cwd: projectDir, prompt: "MUST NOT START", skill_name: skillName, skill_snapshot_binding },
    });
    const rejectedView = rejected.structuredContent as RunSubagentMetadata;
    assert.equal(rejectedView.kind, "preflight_rejected");
    assert.equal(rejectedView.reason_code, "skill_snapshot_reference_closed");
    assert.equal(rejectedView.child_started, false);
    assert.equal((await readJsonl(fakeLogPath)).length, 5);
  }, {
    env: {
      SUBAGENT007_PI_SKILL_PATHS: skillsRoot,
      SUBAGENT007_SKILL_SNAPSHOTS_DIR: snapshotsRoot,
      SUBAGENT007_RUNS_DIR: path.join(durableStateRoot, "runs"),
      SUBAGENT007_RUN_TASKS_DIR: path.join(durableStateRoot, "run-tasks"),
      SUBAGENT007_INPUT_REQUESTS_DIR: path.join(durableStateRoot, "input-requests"),
      SUBAGENT007_ACTIVE_CHILDREN_DIR: path.join(durableStateRoot, "active-children"),
      SUBAGENT007_QUEUED_RUNS_DIR: path.join(durableStateRoot, "queued-runs"),
      SUBAGENT007_SESSIONS_DIR: path.join(durableStateRoot, "sessions"),
      SUBAGENT007_PI_RAW_SESSIONS_DIR: path.join(durableStateRoot, "pi-raw-sessions"),
      SUBAGENT007_MAX_ACTIVE_CHILDREN: "0",
    },
  });
});

test("verify_skill_bindings is canonical, all-or-nothing, and writes no operational state", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-skill-verification-mcp-"));
  const skillsRoot = path.join(tmp, "skills");
  const stateRoot = path.join(tmp, "state");
  const firstName = "alpha-verification-skill";
  const secondName = "beta-verification-skill";
  const firstPath = await writeSkillFixture(skillsRoot, firstName);
  const secondPath = await writeSkillFixture(skillsRoot, secondName);
  const firstDigest = await sha256File(firstPath);
  const secondDigest = await sha256File(secondPath);
  const operationalPaths = {
    runs: path.join(stateRoot, "runs"),
    tasks: path.join(stateRoot, "run-tasks"),
    sessions: path.join(stateRoot, "sessions"),
    inputs: path.join(stateRoot, "input-requests"),
    active: path.join(stateRoot, "active-children"),
    queued: path.join(stateRoot, "queued-runs"),
    temp: path.join(stateRoot, "temp"),
    failures: path.join(stateRoot, "failures.jsonl"),
  };

  await connectFakeClient(async (client, { projectDir, fakeLogPath }) => {
    const bindings = [
      { skill_name: firstName, expected_skill_sha256: firstDigest },
      { skill_name: secondName, expected_skill_sha256: secondDigest },
    ];
    const canonicalRequestSha256 = createHash("sha256")
      .update(
        "subagent007.skill_binding_verification.request.v1\n" +
          JSON.stringify({ contract_version: 1, cwd: projectDir, bindings }),
      )
      .digest("hex");

    const successResponse = await client.callTool({
      name: "verify_skill_bindings",
      arguments: { contract_version: 1, cwd: projectDir, bindings },
    });
    assert.notEqual(successResponse.isError, true);
    const success = successResponse.structuredContent as SkillBindingVerificationResult;
    assert.deepEqual(success, {
      contract_name: "subagent007.skill_binding_verification",
      contract_version: 1,
      kind: "skill_bindings_verified",
      success: true,
      verified: true,
      child_started: false,
      model_invoked: false,
      request_binding: {
        cwd: projectDir,
        count: 2,
        canonical_request_sha256: canonicalRequestSha256,
      },
      bindings: [
        {
          skill_name: firstName,
          expected_skill_sha256: firstDigest,
          resolved_skill_path: firstPath,
          resolved_skill_sha256: firstDigest,
        },
        {
          skill_name: secondName,
          expected_skill_sha256: secondDigest,
          resolved_skill_path: secondPath,
          resolved_skill_sha256: secondDigest,
        },
      ],
    });

    const mismatchBindings = [
      bindings[0],
      { skill_name: secondName, expected_skill_sha256: "0".repeat(64) },
    ];
    const mismatchRequestSha256 = createHash("sha256")
      .update(
        "subagent007.skill_binding_verification.request.v1\n" +
          JSON.stringify({ contract_version: 1, cwd: projectDir, bindings: mismatchBindings }),
      )
      .digest("hex");
    const mismatchResponse = await client.callTool({
      name: "verify_skill_bindings",
      arguments: { contract_version: 1, cwd: projectDir, bindings: mismatchBindings },
    });
    assert.notEqual(mismatchResponse.isError, true);
    const mismatch = mismatchResponse.structuredContent as SkillBindingVerificationResult;
    assert.deepEqual(mismatch, {
      contract_name: "subagent007.skill_binding_verification",
      contract_version: 1,
      kind: "skill_binding_verification_rejected",
      success: false,
      verified: false,
      child_started: false,
      model_invoked: false,
      request_binding: {
        cwd: projectDir,
        count: 2,
        canonical_request_sha256: mismatchRequestSha256,
      },
      reason_code: "skill_content_mismatch",
      failed_binding: {
        index: 1,
        skill_name: secondName,
        expected_skill_sha256: "0".repeat(64),
      },
      message: "Skill content does not match the expected digest.",
    });
    assert.equal(Object.hasOwn(mismatch, "bindings"), false);

    const unknownBindings = [{
      skill_name: "missing-verification-skill",
      expected_skill_sha256: "1".repeat(64),
    }];
    const unknownResponse = await client.callTool({
      name: "verify_skill_bindings",
      arguments: { contract_version: 1, cwd: projectDir, bindings: unknownBindings },
    });
    assert.notEqual(unknownResponse.isError, true);
    const unknown = unknownResponse.structuredContent as SkillBindingVerificationResult;
    assert.equal(unknown.kind, "skill_binding_verification_rejected");
    assert.equal(unknown.reason_code, "skill_not_found");
    assert.deepEqual(unknown.failed_binding, { index: 0, ...unknownBindings[0] });
    assert.equal(Object.hasOwn(unknown, "bindings"), false);

    const cwdResponse = await client.callTool({
      name: "verify_skill_bindings",
      arguments: { contract_version: 1, cwd: "relative", bindings: unknownBindings },
    });
    assert.notEqual(cwdResponse.isError, true);
    const cwdRejected = cwdResponse.structuredContent as SkillBindingVerificationResult;
    assert.equal(cwdRejected.kind, "skill_binding_verification_rejected");
    assert.equal(cwdRejected.reason_code, "cwd_not_absolute");
    assert.equal(Object.hasOwn(cwdRejected, "failed_binding"), false);

    for (const invalidArguments of [
      { contract_version: 1, cwd: projectDir, bindings: [bindings[1], bindings[0]] },
      { contract_version: 1, cwd: projectDir, bindings: [bindings[0], bindings[0]] },
      { contract_version: 1, cwd: projectDir, bindings: [] },
      {
        contract_version: 1,
        cwd: projectDir,
        bindings: Array.from({ length: 65 }, (_, index) => ({
          skill_name: `skill-${String(index).padStart(2, "0")}`,
          expected_skill_sha256: "a".repeat(64),
        })),
      },
      { contract_version: 2, cwd: projectDir, bindings },
      {
        contract_version: 1,
        cwd: projectDir,
        bindings: [{ skill_name: firstName, expected_skill_sha256: "not-a-digest" }],
      },
      { contract_version: 1, cwd: projectDir, bindings, extra: true },
    ]) {
      const response = await client.callTool({
        name: "verify_skill_bindings",
        arguments: invalidArguments,
      });
      assert.equal(response.isError, true);
    }

    assert.deepEqual(await readJsonl(fakeLogPath).catch(() => []), []);
    for (const statePath of Object.values(operationalPaths)) {
      await assert.rejects(fs.stat(statePath), (error: unknown) =>
        (error as NodeJS.ErrnoException).code === "ENOENT");
    }
  }, {
    config: { default_model_class: "invalid" },
    env: {
      SUBAGENT007_PI_SKILL_PATHS: skillsRoot,
      SUBAGENT007_PI_CHILD_PATH: path.join(tmp, "missing-pi-child.js"),
      SUBAGENT007_FAILURE_LOG: "on",
      SUBAGENT007_FAILURE_LOG_PATH: operationalPaths.failures,
      SUBAGENT007_RUNS_DIR: operationalPaths.runs,
      SUBAGENT007_RUN_TASKS_DIR: operationalPaths.tasks,
      SUBAGENT007_SESSIONS_DIR: operationalPaths.sessions,
      SUBAGENT007_INPUT_REQUESTS_DIR: operationalPaths.inputs,
      SUBAGENT007_ACTIVE_CHILDREN_DIR: operationalPaths.active,
      SUBAGENT007_QUEUED_RUNS_DIR: operationalPaths.queued,
      SUBAGENT007_TEMP_DIR: operationalPaths.temp,
    },
  });
});

test("verify_skill_bindings does not replace the launch-time skill digest recheck", async () => {
  const skillsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-skill-verification-drift-"));
  const skillName = "drift-verification-skill";
  const skillPath = await writeSkillFixture(skillsRoot, skillName);
  const originalDigest = await sha256File(skillPath);

  await connectFakeClient(async (client, { projectDir, fakeLogPath }) => {
    const verified = await client.callTool({
      name: "verify_skill_bindings",
      arguments: {
        contract_version: 1,
        cwd: projectDir,
        bindings: [{ skill_name: skillName, expected_skill_sha256: originalDigest }],
      },
    });
    assert.notEqual(verified.isError, true);
    assert.equal((verified.structuredContent as SkillBindingVerificationResult).verified, true);

    await fs.appendFile(skillPath, "\nchanged after verification\n");
    const startResponse = await client.callTool({
      name: "start_run",
      arguments: {
        cwd: projectDir,
        prompt: "must not launch",
        skill_name: skillName,
        expected_skill_sha256: originalDigest,
      },
    });
    assert.notEqual(startResponse.isError, true);
    const rejected = startResponse.structuredContent as RunSubagentMetadata;
    assert.equal(rejected.kind, "preflight_rejected");
    assert.equal(rejected.reason_code, "skill_content_mismatch");
    assert.equal(rejected.child_started, false);
    assert.deepEqual(await readJsonl(fakeLogPath).catch(() => []), []);
  }, {
    env: {
      SUBAGENT007_PI_SKILL_PATHS: skillsRoot,
    },
  });
});

test("resolve_skill_bindings exposes strict canonical schema and typed all-or-nothing rejection", async () => {
  await connectFakeClient(async (client, { projectDir, fakeLogPath }) => {
    const malformed = await client.callTool({
      name: "resolve_skill_bindings",
      arguments: { contract_version: 1, cwd: projectDir, skill_names: ["zeta", "alpha"] },
    });
    assert.equal(malformed.isError, true);
    const unknown = await client.callTool({
      name: "resolve_skill_bindings",
      arguments: { contract_version: 1, cwd: projectDir, skill_names: ["missing-skill"] },
    });
    assert.notEqual(unknown.isError, true);
    const result = unknown.structuredContent as Record<string, unknown>;
    assert.equal(result.kind, "skill_binding_resolution_rejected");
    assert.equal(result.reason_code, "skill_not_found");
    assert.equal(result.child_started, false);
    assert.equal(result.model_invoked, false);
    assert.equal(await fs.stat(fakeLogPath).then(() => true, () => false), false);
  });
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
          recursive_delegation: "disabled",
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
            recursive_delegation: "disabled",
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

test("runSubagent rejects below-reserve disk before child launch", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-disk-preflight-"));
  const projectDir = path.join(tmp, "project");
  const runsDir = path.join(tmp, "runs");
  const fake = await createFakePiChild();
  await fs.mkdir(projectDir, { recursive: true });

  await withEnv(
    {
      SUBAGENT007_PI_CHILD_PATH: fake.childPath,
      FAKE_PI_LOG_PATH: fake.logPath,
      SUBAGENT007_MIN_FREE_DISK_BYTES: String(Number.MAX_SAFE_INTEGER),
    },
    async () => {
      await assert.rejects(
        runSubagent({ cwd: projectDir, prompt: "FAST", model_class: "C" }, { runsDir }),
        (error: NodeJS.ErrnoException & { reasonCode?: string }) =>
          error.reasonCode === "disk_reserve_exhausted",
      );
      const childLogs = await readJsonl(fake.logPath).catch(() => []);
      assert.equal(childLogs.length, 0);
    },
  );
});

test("runSubagent rejects final and streaming terminal output above 1 MiB", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-terminal-output-cap-"));
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
      await assert.rejects(
        runSubagent({ cwd: projectDir, prompt: "TERMINAL_CAP_FINAL", model_class: "C" }, { runsDir }),
        /1 MiB terminal-output limit/,
      );
      const streaming = await runSubagent(
        { cwd: projectDir, prompt: "TERMINAL_CAP_TRANSCRIPT", model_class: "C", output_mode: "transcript" },
        { runsDir },
      );
      assert.equal(streaming.success, false);
      assert.equal(streaming.status, "failed");
      assert.equal(streaming.output_references[0]!.size_bytes <= 1024 * 1024, true);
    },
  );
});

test("runSubagent persists an untruncated file-backed transcript larger than 256 KiB", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-large-transcript-run-"));
  const projectDir = path.join(tmp, "project");
  const runsDir = path.join(tmp, "runs");
  const fake = await createFakePiChild();
  await fs.mkdir(projectDir, { recursive: true });

  await withEnv(
    {
      SUBAGENT007_PI_CHILD_PATH: fake.childPath,
      FAKE_PI_LOG_PATH: fake.logPath,
    },
    async () => {
      const result = await runSubagent(
        { cwd: projectDir, prompt: "LARGE_TRANSCRIPT", model_class: "C", output_mode: "transcript" },
        { runsDir },
      );
      const output = await fs.readFile(outputPathFor(result, runsDir), "utf8");
      assert.equal(result.success, true);
      assert.equal(result.written_output_mode, "transcript");
      assert.equal(Buffer.byteLength(output, "utf8") > 256 * 1024, true);
      assert.match(output, /LARGE PUBLIC/);
      assert.doesNotMatch(output, /transcript truncated/);
    },
  );
});

test("partial output availability requires terminal interruption plus public child content", () => {
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
      resourceExhausted: true,
      hasPublicAssistantText: true,
    }),
    true,
  );
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
    assert.equal(names.length, 21);
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
    assert.equal(names.includes("verify_skill_bindings"), true);
    assert.equal(names.includes("resolve_skill_bindings"), true);
    assert.equal(names.includes("resolve_skill_runtime_bundles"), true);
    assert.equal(names.includes("validate_skill_runtime_bundle"), true);
    assert.equal(names.includes("publish_skill_snapshots"), true);
    assert.equal(names.includes("resolve_retained_skill_snapshot_source"), true);
    assert.equal(names.includes("materialize_retained_skill_snapshot"), false);
    assert.equal(names.includes("close_skill_snapshot_references"), true);
    const exactBundleTool = response.tools.find((tool) => tool.name === "validate_skill_runtime_bundle");
    assert.ok(exactBundleTool);
    assert.equal(exactBundleTool.inputSchema.additionalProperties, false);
    assert.deepEqual(exactBundleTool.inputSchema.required, ["contract_version", "bundle_root", "expected_skill_name"]);
    assert.match(exactBundleTool.description ?? "", /settled staging or canonical source/i);
    const publishSnapshotsTool = response.tools.find((tool) => tool.name === "publish_skill_snapshots");
    assert.ok(publishSnapshotsTool);
    const publicationSchema = publishSnapshotsTool.inputSchema as {
      properties?: {
        bindings?: {
          items?: { additionalProperties?: boolean; required?: string[]; properties?: Record<string, unknown> };
        };
      };
    };
    assert.equal(publicationSchema.properties?.bindings?.items?.additionalProperties, false);
    assert.deepEqual(
      publicationSchema.properties?.bindings?.items?.required,
      ["skill_name", "expected_bundle_sha256"],
    );
    assert.equal(
      Object.hasOwn(publicationSchema.properties?.bindings?.items?.properties ?? {}, "source_root"),
      true,
    );
    const verifySkillBindingsTool = response.tools.find((tool) => tool.name === "verify_skill_bindings");
    assert.ok(verifySkillBindingsTool);
    assert.equal(verifySkillBindingsTool.title, "Verify Skill Bindings");
    assert.match(verifySkillBindingsTool.description ?? "", /without invoking a model or creating operational state/i);
    const verificationSchema = verifySkillBindingsTool.inputSchema as {
      additionalProperties?: boolean;
      required?: string[];
      properties?: {
        contract_version?: { const?: number };
        bindings?: {
          minItems?: number;
          maxItems?: number;
          items?: { additionalProperties?: boolean; required?: string[] };
        };
      };
    };
    assert.equal(verificationSchema.additionalProperties, false);
    assert.deepEqual(verificationSchema.required, ["contract_version", "cwd", "bindings"]);
    assert.equal(verificationSchema.properties?.contract_version?.const, 1);
    assert.equal(verificationSchema.properties?.bindings?.minItems, 1);
    assert.equal(verificationSchema.properties?.bindings?.maxItems, 64);
    assert.equal(verificationSchema.properties?.bindings?.items?.additionalProperties, false);
    assert.deepEqual(
      verificationSchema.properties?.bindings?.items?.required,
      ["skill_name", "expected_skill_sha256"],
    );
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
    for (const toolName of ["run_subagent", "start_run", "schedule_run"]) {
      const tool = response.tools.find((entry) => entry.name === toolName);
      assert.ok(tool, toolName);
      const properties = tool.inputSchema.properties as Record<string, unknown>;
      assert.equal(Object.hasOwn(properties, "effect_profile"), true);
      assert.deepEqual((properties.effect_profile as { enum?: string[] }).enum, [
        "workspace_read_only", "task_root_authoring_v1", "skill_creator_authoring_v1", "researcher_bounded_v1", "assumption_audit_bounded_v1",
      ]);
      assert.equal(Object.hasOwn(properties, "expected_skill_sha256"), true);
      assert.equal(Object.hasOwn(properties, "skill_snapshot_binding"), true);
      assert.equal(Object.hasOwn(properties, "allowed_output_paths"), true);
    }
    const getRunTool = response.tools.find((tool) => tool.name === "get_run");
    assert.ok(getRunTool);
    assert.match(getRunTool.description ?? "", /running_silent.*many minutes/i);
    assert.match(getRunTool.description ?? "", /not.*stale.*cancel/i);
    const cancelRunTool = response.tools.find((tool) => tool.name === "cancel_run");
    assert.ok(cancelRunTool);
    assert.match(cancelRunTool.description ?? "", /explicit user intent.*caller-owned stop condition/i);
    assert.match(cancelRunTool.description ?? "", /silence.*not.*authoriz/i);
    const runSubagentSessionTool = response.tools.find((tool) => tool.name === "run_subagent_session");
    assert.ok(runSubagentSessionTool);
    assert.equal(
      Object.hasOwn(runSubagentSessionTool.inputSchema.properties ?? {}, "continuity"),
      false,
    );
    for (const toolName of ["start_session_run", "run_subagent_session"]) {
      const tool = response.tools.find((entry) => entry.name === toolName);
      assert.ok(tool, toolName);
      const properties = tool.inputSchema.properties as Record<string, unknown>;
      assert.equal(Object.hasOwn(properties, "effect_profile"), false);
      assert.equal(Object.hasOwn(properties, "expected_skill_sha256"), false);
      assert.equal(Object.hasOwn(properties, "skill_snapshot_binding"), false);
      assert.equal(Object.hasOwn(properties, "allowed_output_paths"), false);
    }
    for (const toolName of [
      "start_run",
      "schedule_run",
      "run_subagent",
      "start_session_run",
      "run_subagent_session",
    ]) {
      const tool = response.tools.find((entry) => entry.name === toolName);
      assert.ok(tool, toolName);
      const properties = tool.inputSchema.properties as Record<string, { description?: string }>;
      const skillNameDescription = properties.skill_name?.description ?? "";
      const legacySkillDescription = properties.skill?.description ?? "";
      assert.match(skillNameDescription, /Preferred bare skill name/);
      assert.match(legacySkillDescription, /Legacy alias for skill_name/);
      assert.notEqual(skillNameDescription, legacySkillDescription);
    }
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
      skill_binding_verification?: {
        tool?: string;
        contract_name?: string;
        contract_version?: number;
        max_bindings?: number;
        all_or_nothing?: boolean;
        model_invocation?: string;
        operational_state_writes?: string;
        verification_scope?: string;
        launch_recheck_required?: boolean;
      };
      output_reference?: { transcript_size_policy?: string };
      tools?: {
        start?: string[];
        session_start?: string[];
      };
      input_mailbox?: {
        waiting_status_terminal?: boolean;
        pending_cardinality?: string;
        safe_auto_answer?: string;
        multiple_pending_action?: string;
        duplicate_response?: string;
        stale_request_id?: string;
        foreign_request_id?: string;
        terminal_pending_settlement?: string;
        response_id?: string;
        receipt?: string;
        replay?: string;
        raw_answer_persistence?: string;
        process_loss?: string;
      };
      effect_profiles?: {
        workspace_read_only?: {
          supported_tools?: string[];
          supported_start_tools?: string[];
          supported_continuity_modes?: string[];
          named_sessions?: string;
          recursive_delegate?: string;
          activation_receipt?: { event_type?: string; required_before_prompt?: boolean };
        };
        skill_creator_authoring_v1?: {
          supported_tools?: string[];
          task_root?: string;
          task_root_write_scope?: string;
          snapshot_runtime_read_scope?: string;
          ambient_extensions?: string;
          enforcement_boundary?: string;
          claim_ceiling?: string;
          activation_receipt?: { event_type?: string; required_before_prompt?: boolean };
        };
        researcher_bounded_v1?: {
          supported_tools?: string[];
          supported_continuity_modes?: string[];
          named_sessions?: string;
          recursive_delegate?: string;
          controller_binding?: string;
          state_scope?: string;
          claim_ceiling?: string;
          activation_receipt?: { event_type?: string; required_before_prompt?: boolean };
        };
        assumption_audit_bounded_v1?: {
          supported_tools?: string[];
          supported_continuity_modes?: string[];
          named_sessions?: string;
          recursive_delegate?: string;
          controller_binding?: string;
          state_scope?: string;
          claim_ceiling?: string;
          activation_receipt?: { event_type?: string; required_before_prompt?: boolean };
        };
      };
    };
    assert.equal(contract.contract_name, "subagent007.durable_run");
    assert.equal(contract.contract_version, 3);
    assert.deepEqual(contract.statuses?.terminal, ["completed", "failed", "cancelled", "timed_out"]);
    assert.deepEqual(contract.statuses?.non_terminal, ["working", "input_required"]);
    assert.equal(contract.capabilities?.includes("file_backed_output_references"), true);
    assert.equal(contract.capabilities?.includes("restart_drift_fail_closed"), true);
    assert.equal(contract.capabilities?.includes("recursive_delegate_lineage"), true);
    assert.equal(contract.capabilities?.includes("acknowledged_run_input"), true);
    assert.equal(contract.capabilities?.includes("live_response_replay"), true);
    assert.equal(contract.capabilities?.includes("operational_answer_nonretention"), true);
    assert.equal(contract.capabilities?.includes("terminal_state_compaction"), true);
    assert.equal(contract.capabilities?.includes("complete_file_backed_transcripts"), true);
    assert.equal(contract.capabilities?.includes("disk_reserve_fail_closed"), true);
    assert.equal(contract.capabilities?.includes("bounded_local_admission_queue"), true);
    assert.equal(contract.capabilities?.includes("workspace_read_only_effect_profile"), true);
    assert.equal(contract.capabilities?.includes("skill_creator_authoring_v1_effect_profile"), true);
    assert.equal(contract.capabilities?.includes("researcher_bounded_v1_effect_profile"), true);
    assert.equal(contract.capabilities?.includes("assumption_audit_bounded_v1_effect_profile"), true);
    assert.equal(contract.capabilities?.includes("authoring_effect_scope_binding"), true);
    assert.equal(contract.capabilities?.includes("batch_skill_binding_verification"), true);
    assert.equal(contract.capabilities?.includes("batch_skill_binding_resolution"), true);
    assert.equal(contract.capabilities?.includes("explicit_recursive_delegation"), true);
    assert.equal(contract.capabilities?.includes("terminal_recursive_subtree_closure"), true);
    assert.equal(contract.capabilities?.includes("exact_root_runtime_bundle_validation"), true);
    assert.equal(contract.capabilities?.includes("snapshot_bound_launch"), true);
    assert.deepEqual(contract.skill_binding_verification, {
      tool: "verify_skill_bindings",
      contract_name: "subagent007.skill_binding_verification",
      contract_version: 1,
      max_bindings: 64,
      all_or_nothing: true,
      model_invocation: "none",
      operational_state_writes: "none",
      verification_scope: "point_in_time",
      launch_recheck_required: true,
    });
    assert.deepEqual(contract.effect_profiles?.workspace_read_only?.supported_tools, [
      "read", "grep", "find", "ls", "web_search", "web_read", "request_input",
    ]);
    assert.deepEqual(contract.effect_profiles?.workspace_read_only?.supported_start_tools, [
      "run_subagent", "start_run", "schedule_run",
    ]);
    assert.deepEqual(contract.effect_profiles?.workspace_read_only?.supported_continuity_modes, [
      "ephemeral", "fresh", "resume",
    ]);
    assert.equal(contract.effect_profiles?.workspace_read_only?.named_sessions, "unsupported");
    assert.equal(contract.effect_profiles?.workspace_read_only?.recursive_delegate, "excluded");
    assert.equal(
      contract.effect_profiles?.workspace_read_only?.activation_receipt?.event_type,
      "subagent007.activation_confirmed",
    );
    assert.equal(
      contract.effect_profiles?.workspace_read_only?.activation_receipt?.required_before_prompt,
      true,
    );
    assert.deepEqual(contract.effect_profiles?.skill_creator_authoring_v1?.supported_tools, [
      "read", "grep", "find", "ls", "write", "edit",
    ]);
    assert.equal(contract.effect_profiles?.skill_creator_authoring_v1?.task_root, "exact_run_cwd");
    assert.equal(contract.effect_profiles?.skill_creator_authoring_v1?.task_root_write_scope, "exact_real_run_cwd");
    assert.equal(
      contract.effect_profiles?.skill_creator_authoring_v1?.snapshot_runtime_read_scope,
      "active_validated_snapshot_runtime_root_or_none",
    );
    assert.equal(contract.effect_profiles?.skill_creator_authoring_v1?.ambient_extensions, "disabled");
    assert.equal(
      contract.effect_profiles?.skill_creator_authoring_v1?.enforcement_boundary,
      "pi_create_agent_session_tools_allowlist_and_task_root_path_guards",
    );
    assert.equal(
      contract.effect_profiles?.skill_creator_authoring_v1?.claim_ceiling,
      "pi_tool_dispatch_and_path_guards_not_os_sandbox",
    );
    assert.equal(
      contract.effect_profiles?.skill_creator_authoring_v1?.activation_receipt?.required_before_prompt,
      true,
    );
    assert.deepEqual(contract.effect_profiles?.researcher_bounded_v1?.supported_tools, [
      "read", "grep", "find", "ls", "write", "edit", "web_search", "web_read", "researchctl",
    ]);
    assert.deepEqual(contract.effect_profiles?.assumption_audit_bounded_v1?.supported_tools, [
      "read", "grep", "find", "ls", "write", "edit", "web_search", "web_read", "aj_switchboard",
    ]);
    for (const [profile, stateScope] of [
      [contract.effect_profiles?.researcher_bounded_v1, ".subagent007/researcher_bounded_v1"],
      [contract.effect_profiles?.assumption_audit_bounded_v1, ".subagent007/assumption_audit_bounded_v1"],
    ] as const) {
      assert.deepEqual(profile?.supported_continuity_modes, ["ephemeral", "fresh"]);
      assert.equal(profile?.named_sessions, "unsupported");
      assert.equal(profile?.recursive_delegate, "excluded");
      assert.equal(profile?.controller_binding, "fixed_wrapper_exact_snapshot_script_and_resolved_python_sha256");
      assert.equal(profile?.claim_ceiling, "pi_tool_dispatch_path_controller_and_terminal_reinspection_not_os_sandbox");
      assert.equal(profile?.state_scope, stateScope);
      assert.equal(profile?.activation_receipt?.required_before_prompt, true);
    }
    assert.deepEqual(contract.output_reference, {
      field: "output_references",
      kind: "file",
      name: "primary",
      additive_names: ["packet"],
      cardinality: "exactly_one_primary_with_at_most_one_packet",
      locator_field: "relative_path",
      locator_policy: "canonical_single_component_provider_basename",
      locator_root: "configured_runs_root",
      size_field: "size_bytes",
      digest_field: "content_sha256",
      digest_algorithm: "sha256",
      terminal_max_bytes: 1048576,
      content_type: "text/markdown",
      encoding: "utf-8",
      bounded_inline_fields: ["recent_events", "last_public_output_excerpt"],
      transcript_size_policy: "bounded_1_mib",
    });
    assert.deepEqual(contract.tools?.start, ["start_run", "schedule_run"]);
    assert.deepEqual(contract.tools?.session_start, ["start_session_run", "run_subagent_session"]);
    assert.equal(contract.input_mailbox?.waiting_status_terminal, false);
    assert.equal(contract.input_mailbox?.pending_cardinality, "zero_or_more");
    assert.equal(contract.input_mailbox?.safe_auto_answer, "caller_policy_required");
    assert.equal(contract.input_mailbox?.multiple_pending_action, "fail_closed");
    assert.equal(contract.input_mailbox?.duplicate_response, "exact_live_replay_only");
    assert.equal(contract.input_mailbox?.stale_request_id, "rejected");
    assert.equal(contract.input_mailbox?.foreign_request_id, "rejected");
    assert.equal(contract.input_mailbox?.terminal_pending_settlement, "closed_or_timed_out");
    assert.equal(contract.input_mailbox?.response_id, "required");
    assert.equal(contract.input_mailbox?.receipt, "child_waiter_accepted");
    assert.equal(contract.input_mailbox?.replay, "live_exact_response");
    assert.equal(contract.input_mailbox?.raw_answer_persistence, "forbidden");
    assert.equal(contract.input_mailbox?.process_loss, "fails_closed");
    const startRunTool = response.tools.find((entry) => entry.name === "start_run");
    assert.ok(startRunTool);
    assert.equal("input_protocol" in (startRunTool.inputSchema.properties as Record<string, unknown>), false);
    const answerTool = response.tools.find((entry) => entry.name === "answer_run_input");
    assert.ok(answerTool);
    assert.ok((answerTool.inputSchema.required as string[]).includes("response_id"));
    const readinessResponse = await client.callTool({
      name: "get_runtime_readiness",
      arguments: {
        expected_contract_name: "subagent007.durable_run",
        expected_contract_version: 3,
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
    assert.equal(readiness.contract?.compatible, true);
    assert.match(readiness.runtime?.server_entrypoint ?? "", /(?:src|dist)\/server\.(?:ts|js)$/);
    assert.equal(readiness.capabilities?.public_tools?.includes("get_runtime_readiness"), true);
    if (readiness.ready) {
      assert.equal(readiness.status, "ready");
      assert.deepEqual(readiness.blocks, []);
    } else {
      assert.equal(readiness.status, "blocked");
      assert.ok((readiness.blocks ?? []).length > 0);
    }
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

test("MCP run_subagent and start_run preflight reject when the Pi child entrypoint is missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-missing-child-"));
  const missingChildPath = path.join(tmp, "missing-piChild.js");
  await connectFakeClient(
    async (client, { projectDir, fakeLogPath }) => {
      const runSubagentResponse = await client.callTool({
        name: "run_subagent",
        arguments: {
          cwd: projectDir,
          prompt: "FAST",
          run_kind: "quick_noninteractive",
        },
      });
      assert.notEqual(runSubagentResponse.isError, true);
      assert.equal((runSubagentResponse.structuredContent as { kind?: string }).kind, "preflight_rejected");
      assert.equal(
        (runSubagentResponse.structuredContent as { reason_code?: string }).reason_code,
        "child_entrypoint_missing",
      );
      assert.equal(
        (runSubagentResponse.structuredContent as { child_started?: boolean }).child_started,
        false,
      );

      const startRunResponse = await client.callTool({
        name: "start_run",
        arguments: {
          cwd: projectDir,
          prompt: "FAST",
        },
      });
      assert.notEqual(startRunResponse.isError, true);
      assert.equal((startRunResponse.structuredContent as { kind?: string }).kind, "preflight_rejected");
      assert.equal(
        (startRunResponse.structuredContent as { reason_code?: string }).reason_code,
        "child_entrypoint_missing",
      );
      assert.equal(
        (startRunResponse.structuredContent as { child_started?: boolean }).child_started,
        false,
      );

      await assert.rejects(fs.stat(fakeLogPath), /ENOENT/);
    },
    { env: { SUBAGENT007_PI_CHILD_PATH: missingChildPath } },
  );
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
      default_one_shot_health_status: string;
      default_one_shot_health_basis: string;
      model_health_probe_command: string;
    };
    assertNoPublicCalibrationFields(metadata);
    assert.deepEqual(metadata.model_classes.map((entry) => entry.class), ["A", "B", "C", "D", "E", "Z1", "Z2", "Z3", "Z4", "Z5"]);
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
      };
      assertNoPublicCalibrationFields(metadata);
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
          resolved_model: "openai-codex/gpt-5.6-luna",
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
    assertNoPublicCalibrationFields(metadata);
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
    assertNoPublicCalibrationFields(metadata);
    assert.equal(metadata.success, true);
    assert.equal(metadata.session_id, null);
    assert.equal(Object.hasOwn(metadata, "output_path"), false);
    assert.deepEqual(Object.keys(metadata.output_references?.[0] ?? {}).sort(), [
      "content_sha256", "content_type", "encoding", "kind", "name", "output_mode", "relative_path", "size_bytes",
    ].sort());
    assert.equal(await fs.readFile(outputPathFor(metadata), "utf8"), "FAST FINAL");

    const logs = await readJsonl<{ request: Record<string, unknown> }>(fakeLogPath);
    assert.equal(logs[0].request.model, "openai-codex/gpt-5.6-luna");
    assert.equal(logs[0].request.thinkingLevel, "xhigh");
    assert.equal(logs[0].request.skill, undefined);
    assert.equal(Object.hasOwn(logs[0].request, "toolProfile"), false);
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
            resolved_model: "openai-codex/gpt-5.6-luna",
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
      assertNoPublicCalibrationFields(metadata);
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
      assert.equal(await fs.readFile(outputPathFor(metadata), "utf8"), "FAST FINAL");

      const logs = await readJsonl<{ request: Record<string, unknown> }>(fakeLogPath);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].request.skill, skillName);
      assert.equal(logs[0].request.skillFilePath, skillPath);
      assert.equal(logs[0].request.model, "openai-codex/gpt-5.6-luna");

      const persisted = persistedDurableRunView(JSON.parse(
        await fs.readFile(path.join(runTasksDir, `${metadata.run_id}.json`), "utf8"),
      ) as unknown);
      assert.match(JSON.stringify(persisted.recent_events), /\[auto_promoted\] run_subagent -> durable_run/);

      const runView = await client.callTool({
        name: "get_run",
        arguments: { run_id: metadata.run_id },
      });
      assert.notEqual(runView.isError, true);
      assertNoPublicCalibrationFields(runView.structuredContent);
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
      assert.equal(metadata.status, "timed_out", JSON.stringify(metadata));
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
        prompt: "RAW_THINKING_TRANSCRIPT SECRET_PROMPT_SHOULD_NOT_LEAK",
        run_kind: "quick_noninteractive",
        output_mode: "transcript",
      },
    });
    assert.notEqual(response.isError, true);
    const metadata = response.structuredContent as RunSubagentMetadata;
    assert.equal(metadata.success, true);
    assert.equal(metadata.written_output_mode, "transcript");

    const output = await fs.readFile(outputPathFor(metadata), "utf8");
    assert.equal(output.includes(PUBLIC_PROMPT_REDACTED_MARKER), true);
    assert.match(output, /PUBLIC ASSISTANT TEXT/);
    assert.doesNotMatch(output, /SECRET_PROMPT_SHOULD_NOT_LEAK/);
    assert.doesNotMatch(output, /RAW_THINKING_TRANSCRIPT/);
    assert.doesNotMatch(output, /SECRET_THINKING_SHOULD_NOT_LEAK/);
    assert.doesNotMatch(output, /thinking_delta/);
    assert.doesNotMatch(output, /assistantMessageEvent/);
  });
});

test("run_subagent terminal snapshot omits thinking payloads and removes the raw event file", async () => {
  const runTasksDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-events-"));
  await connectFakeClient(
    async (client, { projectDir }) => {
      const response = await client.callTool({
        name: "run_subagent",
        arguments: {
          cwd: projectDir,
          prompt: "RAW_THINKING_TRANSCRIPT SECRET_PROMPT_SHOULD_NOT_LEAK",
          run_kind: "quick_noninteractive",
          output_mode: "transcript",
        },
      });
      assert.notEqual(response.isError, true);
      const metadata = response.structuredContent as RunSubagentMetadata;
      const persisted = await fs.readFile(path.join(runTasksDir, `${metadata.run_id}.json`), "utf8");
      assert.equal(persisted.includes(PUBLIC_PROMPT_REDACTED_MARKER), true);
      assert.doesNotMatch(persisted, /SECRET_PROMPT_SHOULD_NOT_LEAK/);
      assert.doesNotMatch(persisted, /RAW_THINKING_TRANSCRIPT/);
      assert.doesNotMatch(persisted, /SECRET_THINKING_SHOULD_NOT_LEAK/);
      assert.doesNotMatch(persisted, /thinking_delta|assistantMessageEvent/);
      const recentEventsText = JSON.stringify(metadata.recent_events);
      const lastPublicOutputExcerpt = metadata.last_public_output_excerpt ?? "";
      assert.equal(recentEventsText.includes(PUBLIC_PROMPT_REDACTED_MARKER), true);
      assert.doesNotMatch(recentEventsText, /SECRET_PROMPT_SHOULD_NOT_LEAK|RAW_THINKING_TRANSCRIPT/);
      assert.doesNotMatch(recentEventsText, /SECRET_THINKING_SHOULD_NOT_LEAK/);
      assert.doesNotMatch(lastPublicOutputExcerpt, /SECRET_PROMPT_SHOULD_NOT_LEAK|RAW_THINKING_TRANSCRIPT/);
      await fs.rm(path.join(runTasksDir, `${metadata.run_id}.json`));
      const afterDurableRemoval = await client.callTool({
        name: "get_run",
        arguments: { run_id: metadata.run_id },
      });
      assert.equal((afterDurableRemoval.structuredContent as { reason_code?: string }).reason_code, "run_not_found");
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
          resolved_model: "openai-codex/gpt-5.6-luna",
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
    assert.equal(await fs.readFile(outputPathFor(metadata), "utf8"), "FAST FINAL");
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
    assert.equal(await fs.readFile(outputPathFor(metadata), "utf8"), "FAST FINAL");
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
    assert.equal(Object.hasOwn(logs[0].request, "toolProfile"), false);
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
    assert.equal(await fs.readFile(outputPathFor(metadata), "utf8"), "FAST FINAL");
  });
});

test("MCP schedule_run lets a child delegate a root-visible recursive run", async () => {
  await connectFakeClient(async (client, { projectDir, fakeLogPath }) => {
    const response = await client.callTool({
      name: "schedule_run",
      arguments: {
        cwd: projectDir,
        prompt: "RECURSIVE_DELEGATE_FAST",
        recursive_delegation: "enabled",
        wait_ms: 1000,
      },
    });
    assert.notEqual(response.isError, true);
    const root = response.structuredContent as RunSubagentMetadata;
    assert.equal(root.status, "completed");
    assert.equal(root.success, true);
    assert.equal(root.root_run_id, root.run_id);
    assert.equal(root.recursion_depth, 0);

    const output = JSON.parse(await fs.readFile(outputPathFor(root), "utf8")) as {
      delegated: RunSubagentMetadata;
    };
    const delegated = output.delegated;
    assert.equal(delegated.status, "completed", JSON.stringify(delegated));
    assert.equal(delegated.success, true);
    assert.equal(delegated.parent_run_id, root.run_id);
    assert.equal(delegated.root_run_id, root.run_id);
    assert.equal(delegated.recursion_depth, 1);

    const rootViewResponse = await client.callTool({
      name: "get_run",
      arguments: { run_id: root.run_id },
    });
    assert.notEqual(rootViewResponse.isError, true);
    const rootView = rootViewResponse.structuredContent as RunSubagentMetadata;
    assert.deepEqual(rootView.child_run_ids, [delegated.run_id]);

    const delegatedViewResponse = await client.callTool({
      name: "get_run",
      arguments: { run_id: delegated.run_id },
    });
    assert.notEqual(delegatedViewResponse.isError, true);
    const delegatedView = delegatedViewResponse.structuredContent as RunSubagentMetadata;
    assert.equal(delegatedView.status, "completed");
    assert.equal(delegatedView.parent_run_id, root.run_id);
    assert.equal(delegatedView.root_run_id, root.run_id);
    assert.equal(delegatedView.recursion_depth, 1);
    assert.equal(await fs.readFile(outputPathFor(delegatedView), "utf8"), "FAST FINAL");

    const logs = await readJsonl<{ request: Record<string, unknown> }>(fakeLogPath);
    assert.equal(logs.length, 2);
    assert.equal((logs[0].request.recursiveControl as { parent_run_id?: string }).parent_run_id, root.run_id);
    assert.equal((logs[0].request.recursiveControl as { root_run_id?: string }).root_run_id, root.run_id);
    assert.equal((logs[0].request.recursiveControl as { recursion_depth?: number }).recursion_depth, 0);
    assert.equal((logs[1].request.recursiveControl as { parent_run_id?: string }).parent_run_id, delegated.run_id);
    assert.equal((logs[1].request.recursiveControl as { root_run_id?: string }).root_run_id, root.run_id);
    assert.equal((logs[1].request.recursiveControl as { recursion_depth?: number }).recursion_depth, 1);
  });
});

test("recursive delegation defaults disabled and is confirmed before prompt", async () => {
  await connectFakeClient(async (client, { projectDir, fakeLogPath }) => {
    const response = await client.callTool({
      name: "schedule_run",
      arguments: { cwd: projectDir, prompt: "FAST", wait_ms: 1000 },
    });
    assert.notEqual(response.isError, true);
    const result = response.structuredContent as RunSubagentMetadata & {
      resolved_recursive_delegation?: string;
      recursive_delegation_receipt?: Record<string, unknown>;
    };
    assert.equal(result.resolved_recursive_delegation, "disabled");
    assert.deepEqual(result.recursive_delegation_receipt, {
      schema_version: 1,
      confirmed_before_prompt: true,
      requested_recursive_delegation: null,
      resolved_recursive_delegation: "disabled",
      delegate_tool_active: false,
    });
    const logs = await readJsonl<{ request: Record<string, unknown> }>(fakeLogPath);
    assert.equal(Object.hasOwn(logs[0].request, "recursiveControl"), false);
  });
});

test("parent terminal publication waits for its recursive subtree and exposes exact descendant status", async () => {
  await connectFakeClient(async (client, { projectDir }) => {
    const response = await client.callTool({
      name: "schedule_run",
      arguments: { cwd: projectDir, prompt: "RECURSIVE_DELEGATE_WAIT", recursive_delegation: "enabled", wait_ms: 50 },
    });
    const initial = response.structuredContent as RunSubagentMetadata & { descendant_run_ids?: string[] };
    assert.equal(initial.status, "working");
    let view = initial as typeof initial & { descendant_terminal_statuses?: Record<string, string> };
    for (let index = 0; index < 40 && view.status === "working"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const polled = await client.callTool({ name: "get_run", arguments: { run_id: initial.run_id } });
      view = polled.structuredContent as typeof view;
    }
    assert.equal(view.status, "completed");
    assert.equal(view.descendant_run_ids?.length, 1);
    assert.equal(view.descendant_terminal_statuses?.[view.descendant_run_ids![0]], "completed");
  });
});

test("workspace_read_only rejects recursive enable and raw resume requires explicit reauthorization", async () => {
  await connectFakeClient(async (client, { projectDir, fakeLogPath }) => {
    const conflict = await client.callTool({
      name: "start_run",
      arguments: { cwd: projectDir, prompt: "FAST", effect_profile: "workspace_read_only", recursive_delegation: "enabled" },
    });
    assert.equal((conflict.structuredContent as RunSubagentMetadata).reason_code, "recursive_delegation_effect_conflict");
    assert.equal((conflict.structuredContent as RunSubagentMetadata).child_started, false);
    const rawSession = path.join(projectDir, "raw-session.jsonl");
    await fs.writeFile(rawSession, "{}\n");
    const resume = await client.callTool({
      name: "start_run",
      arguments: { cwd: projectDir, prompt: "FAST", continuity: { mode: "resume", session_id: rawSession } },
    });
    assert.equal((resume.structuredContent as RunSubagentMetadata).reason_code, "recursive_delegation_reauthorization_required");
    assert.equal((resume.structuredContent as RunSubagentMetadata).child_started, false);
    assert.equal(await fs.stat(fakeLogPath).then(() => true, () => false), false);
  });
});

test("MCP recursive delegate rejects at max depth before launching a descendant", async () => {
  await connectFakeClient(
    async (client, { projectDir, fakeLogPath }) => {
      const response = await client.callTool({
        name: "schedule_run",
        arguments: {
          cwd: projectDir,
          prompt: "RECURSIVE_DELEGATE_DEPTH_LIMIT",
          recursive_delegation: "enabled",
          wait_ms: 1000,
        },
      });
      assert.notEqual(response.isError, true);
      const root = response.structuredContent as RunSubagentMetadata;
      assert.equal(root.status, "completed");
      assert.equal(root.success, true);
      assert.deepEqual(root.child_run_ids, []);

      const output = JSON.parse(await fs.readFile(outputPathFor(root), "utf8")) as {
        delegated: RunSubagentMetadata;
      };
      assert.equal(output.delegated.status, "rejected");
      assert.equal(output.delegated.kind, "recursive_delegate_rejected");
      assert.equal(output.delegated.reason_code, "recursive_depth_exceeded");

      const rootViewResponse = await client.callTool({
        name: "get_run",
        arguments: { run_id: root.run_id },
      });
      assert.notEqual(rootViewResponse.isError, true);
      const rootView = rootViewResponse.structuredContent as RunSubagentMetadata;
      assert.deepEqual(rootView.child_run_ids, []);

      const logs = await readJsonl<{ request: Record<string, unknown> }>(fakeLogPath);
      assert.equal(logs.length, 1);
    },
    {
      env: {
        SUBAGENT007_MAX_RECURSION_DEPTH: "0",
      },
    },
  );
});

test("MCP recursive delegate rejects forged caller lineage before launching a descendant", async () => {
  await connectFakeClient(async (client, { projectDir, fakeLogPath }) => {
    const response = await client.callTool({
      name: "schedule_run",
      arguments: {
        cwd: projectDir,
        prompt: "RECURSIVE_DELEGATE_FORGED_PARENT",
        recursive_delegation: "enabled",
        wait_ms: 1000,
      },
    });
    assert.notEqual(response.isError, true);
    const root = response.structuredContent as RunSubagentMetadata;
    assert.equal(root.status, "completed");
    assert.equal(root.success, true);
    assert.deepEqual(root.child_run_ids, []);

    const output = JSON.parse(await fs.readFile(outputPathFor(root), "utf8")) as {
      delegated: RunSubagentMetadata;
    };
    assert.equal(output.delegated.status, "rejected");
    assert.equal(output.delegated.kind, "recursive_delegate_rejected");
    assert.equal(output.delegated.reason_code, "recursive_control_invalid");

    const rootViewResponse = await client.callTool({
      name: "get_run",
      arguments: { run_id: root.run_id },
    });
    assert.notEqual(rootViewResponse.isError, true);
    const rootView = rootViewResponse.structuredContent as RunSubagentMetadata;
    assert.deepEqual(rootView.child_run_ids, []);

    const logs = await readJsonl<{ request: Record<string, unknown> }>(fakeLogPath);
    assert.equal(logs.length, 1);
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
    assert.equal(["starting", "running_silent"].includes(metadata.active_phase ?? ""), true);
    assert.match(metadata.last_progress_message ?? "", /preparing child process|waiting for first public output/);
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
        prompt: "REQUEST_INPUT_WAIT",
        wait_ms: 0,
      },
    });
    assert.notEqual(startedResponse.isError, true);
    const started = startedResponse.structuredContent as RunSubagentMetadata;
    const inputRequired = await waitForInputRequired(client, started.run_id);
    const request = inputRequired.input_requests.find((entry) => entry.status === "pending");
    assert.ok(request);
    assert.equal(inputRequired.input_requests.some((input) => input.request_id === request.request_id), true);

    const answerResponse = await client.callTool({
      name: "answer_run_input",
      arguments: {
        run_id: started.run_id,
        request_id: request.request_id,
        answer: "continue",
        response_id: "schedule-response-001",
      },
    });
    assert.notEqual(answerResponse.isError, true);
    const answered = answerResponse.structuredContent as RunSubagentMetadata;
    assert.equal(answered.status, "working");
    const terminal = await waitForTerminalRun(client, started.run_id);
    assert.equal(terminal.status, "completed");
    assert.equal(await fs.readFile(outputPathFor(terminal), "utf8"), "INPUT CONTINUED");
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
  await connectFakeClient(async (client, { projectDir, activeChildrenDir }) => {
    const startedResponse = await client.callTool({
      name: "start_run",
      arguments: {
        cwd: projectDir,
        prompt: "HEARTBEAT_SLEEP",
      },
    });
    assert.notEqual(startedResponse.isError, true);
    const started = startedResponse.structuredContent as RunSubagentMetadata;
    assert.equal(["working", "completed"].includes(started.status), true);
    assert.equal(["starting", "running_silent", "completed"].includes(started.active_phase ?? ""), true);
    assert.equal(started.queue_wait_ms, undefined);
    assert.equal(typeof started.last_phase_at, "string");
    if (started.status === "working") {
      assert.equal(await hasActiveLeaseForRun(activeChildrenDir, started.run_id), true);
    }

    const terminal = await waitForTerminalRun(client, started.run_id);
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.active_phase, "completed");
    assert.equal(terminal.success, true);
    assert.equal(await fs.readFile(outputPathFor(terminal), "utf8"), "HEARTBEAT DONE");
    assert.equal(terminal.contract_name, "subagent007.durable_run");
    assert.equal(terminal.contract_version, 3);
    assert.equal(terminal.output_references?.length, 1);
    assert.equal(terminal.output_references?.[0].kind, "file");
    assert.equal(terminal.output_references?.[0].relative_path, path.basename(outputPathFor(terminal)));
    assert.equal(terminal.output_references?.[0].output_mode, terminal.written_output_mode);
    assert.equal(terminal.output_references?.[0].size_bytes, Buffer.byteLength("HEARTBEAT DONE", "utf8"));
    assert.equal(terminal.output_references?.[0].content_sha256, createHash("sha256").update("HEARTBEAT DONE").digest("hex"));
    assert.equal(Object.hasOwn(terminal, "output_path"), false);
    assert.equal(Object.hasOwn(terminal.output_references?.[0] ?? {}, "path"), false);
    assert.equal(await hasActiveLeaseForRun(activeChildrenDir!, started.run_id), false);
  });
});

test("MCP start_run final mode completes after generic side-effect progress", async () => {
  await connectFakeClient(async (client, { projectDir }) => {
    const startedResponse = await client.callTool({
      name: "start_run",
      arguments: {
        cwd: projectDir,
        prompt: "SIDE_EFFECT_THEN_FINAL",
        output_mode: "final",
      },
    });
    assert.notEqual(startedResponse.isError, true);
    const started = startedResponse.structuredContent as RunSubagentMetadata;

    const terminal = await waitForTerminalRun(client, started.run_id);
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.success, true);
    assert.equal(terminal.requested_output_mode, "final");
    assert.equal(terminal.written_output_mode, "final");
    assert.equal(await fs.readFile(path.join(projectDir, "side-effect.txt"), "utf8"), "side effect complete\n");
    assert.equal(await fs.readFile(outputPathFor(terminal), "utf8"), "SIDE EFFECT FINAL");
    assert.ok(terminal.recent_events?.some((event) => /PUBLIC SIDE EFFECT PROGRESS/.test(event.text)));
  });
});

test("MCP start_run final mode fails when a clean child exit produces no final output", async () => {
  await connectFakeClient(async (client, { projectDir }) => {
    const startedResponse = await client.callTool({
      name: "start_run",
      arguments: {
        cwd: projectDir,
        prompt: "CLEAN_EXIT_NO_FINAL",
        output_mode: "final",
      },
    });
    assert.notEqual(startedResponse.isError, true);
    const started = startedResponse.structuredContent as RunSubagentMetadata;

    const terminal = await waitForTerminalRun(client, started.run_id);
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.success, false);
    assert.equal(terminal.exit_code, 0);
    assert.equal(terminal.timed_out, false);
    assert.equal(terminal.error_class, "missing_final_output");
    assert.equal(terminal.reason_code, "missing_final_output");
    assert.equal(terminal.requested_output_mode, "final");
    assert.equal(terminal.written_output_mode, "transcript");
    assert.equal(terminal.output_references?.[0].output_mode, "transcript");
    assert.equal(await fs.readFile(path.join(projectDir, "side-effect-no-final.txt"), "utf8"), "side effect complete\n");
  });
});

test("MCP start_run final mode keeps progress-then-timeout classified as timeout", async () => {
  await connectFakeClient(
    async (client, { projectDir }) => {
      const startedResponse = await client.callTool({
        name: "start_run",
        arguments: {
          cwd: projectDir,
          prompt: "TIMEOUT_ASSISTANT_EVENT",
          output_mode: "final",
          timeout_ms: 500,
        },
      });
      assert.notEqual(startedResponse.isError, true);
      const started = startedResponse.structuredContent as RunSubagentMetadata;

      const terminal = await waitForTerminalRun(client, started.run_id);
      assert.equal(terminal.status, "timed_out");
      assert.equal(terminal.success, false);
      assert.equal(terminal.timed_out, true);
      assert.equal(terminal.error_class, "timeout");
      assert.equal(terminal.reason_code, "timeout");
      assert.equal(terminal.written_output_mode, "transcript");
      assert.equal(terminal.partial_output_available, true);
      assert.match(await fs.readFile(outputPathFor(terminal), "utf8"), /PUBLIC PARTIAL ASSISTANT/);
    },
    {
      env: {
        SUBAGENT007_MIN_REQUESTED_TIMEOUT_MS: "0",
        SUBAGENT007_TIMEOUT_RESPONSE_HEADROOM_MS: "100",
        SUBAGENT007_TIMEOUT_KILL_GRACE_MS: "50",
        SUBAGENT007_TIMEOUT_FORCE_GRACE_MS: "50",
      },
    },
  );
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
          prompt: "HEARTBEAT_INPUT_WAIT",
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
      assert.match(silentView.last_progress_message ?? "", /waiting for first public output/);
      assert.equal(typeof silentView.no_public_output_elapsed_ms, "number");
      assert.equal(typeof silentView.last_child_lifecycle_at, "string");
      assert.equal(
        ["child_spawned", "child_bridge_started", "child_session_established", "child_prompt_submitted"].includes(
          silentView.last_child_lifecycle_event ?? "",
        ),
        true,
      );

      const heartbeat = await waitForActiveHeartbeat(client, started.run_id);
      assert.equal(heartbeat.status, "working");
      assert.equal(heartbeat.active_phase, "running_silent");
      assert.equal((heartbeat.heartbeat_count ?? 0) > 0, true);
      assert.equal(typeof heartbeat.elapsed_ms, "number");
      assert.equal(typeof heartbeat.last_progress_at, "string");
      assert.match(heartbeat.last_progress_message ?? "", /waiting for first public output/);
      assert.equal(typeof heartbeat.no_public_output_elapsed_ms, "number");
      assert.equal(heartbeat.first_public_output_at, undefined);

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
      assert.ok(pendingView.input_requests.some((entry) => entry.status === "pending"));

      const cancelResponse = await client.callTool({
        name: "cancel_run",
        arguments: { run_id: started.run_id },
      });
      assert.notEqual(cancelResponse.isError, true);
      const terminal = await waitForTerminalRun(client, started.run_id);
      assert.equal(terminal.status, "cancelled");
    },
    {
      env: {
        SUBAGENT007_HEARTBEAT_INTERVAL_MS: "200",
      },
    },
  );
});

test("delayed consequential-effect fixture fires with its exact nonce while the owner stays alive", async () => {
  const fixture = await createDirectRunTestFixture("subagent007-delayed-effect-positive-");
  const nonce = `positive-${process.pid}-${Date.now()}`;
  const consequentialEffect = path.join(fixture.projectDir, "positive-consequential-effect.txt");
  const delayMs = 350;
  const env = {
    ...fixture.env,
    FAKE_PI_DELAYED_EFFECT_PATH: consequentialEffect,
    FAKE_PI_DELAYED_EFFECT_NONCE: nonce,
    FAKE_PI_DELAYED_EFFECT_DELAY_MS: String(delayMs),
  };
  let runId: string | undefined;

  try {
    await withEnv(env, async () => {
      const started = await startRunTask({
        cwd: fixture.projectDir,
        prompt: "DELAYED_CONSEQUENTIAL_EFFECT",
      });
      runId = started.run_id;
      const armed = await waitForDelayedEffectArmed(fixture.fake.logPath, nonce);
      assert.equal(armed.run_id, runId);
      assert.equal(armed.nonce, nonce);
      assert.equal(armed.delay_ms, delayMs);
      assert.equal(armed.effect_path, consequentialEffect);
      assert.equal(exactPidIsAlive(armed.pid), true);
      assert.equal(await waitForFileText(consequentialEffect, new RegExp(nonce)), `effect nonce=${nonce}\n`);
      const terminal = await waitForTerminalRunTask(runId);
      assert.equal(terminal.status, "completed");
    });
  } finally {
    if (runId) {
      await withEnv(env, async () => {
        await cancelAndWaitForDirectRun(runId!).catch(() => undefined);
      });
    }
    await removeDirectRunTestFixture(fixture);
  }
});

test("real owner SIGKILL before spawn commit leaves no child survivor or consequential effect and restart converges", async () => {
  const fixture = await createDirectRunTestFixture("subagent007-spawn-precommit-sigkill-");
  const callbackMarker = path.join(fixture.root, "spawn-callback-entered.json");
  const consequentialEffect = path.join(fixture.projectDir, "negative-consequential-effect.txt");
  const nonce = `negative-${process.pid}-${Date.now()}`;
  const delayMs = 350;
  const runTaskUrl = pathToFileURL(path.resolve("src/runTask.ts")).href;
  const workerSource = `
    import fs from "node:fs/promises";
    const originalRename = fs.rename.bind(fs);
    let paused = false;
    fs.rename = async (source, destination) => {
      if (!paused && destination.endsWith(".json") && source.includes(".tmp-")) {
        const candidate = JSON.parse(await fs.readFile(source, "utf8"));
        if (candidate.record_name === "subagent007.current_run_claim" && candidate.child_started === true) {
          paused = true;
          await fs.writeFile(
            ${JSON.stringify(callbackMarker)},
            JSON.stringify({ run_id: candidate.run_id }) + "\\n",
            { flag: "wx" },
          );
          await new Promise(() => {});
        }
      }
      return originalRename(source, destination);
    };
    const { startRunTask } = await import(${JSON.stringify(runTaskUrl)});
    await startRunTask({ cwd: ${JSON.stringify(fixture.projectDir)}, prompt: "DELAYED_CONSEQUENTIAL_EFFECT" });
    await new Promise(() => {});
  `;
  const env = {
    ...process.env,
    ...fixture.env,
    FAKE_PI_DELAYED_EFFECT_PATH: consequentialEffect,
    FAKE_PI_DELAYED_EFFECT_NONCE: nonce,
    FAKE_PI_DELAYED_EFFECT_DELAY_MS: String(delayMs),
  };
  const worker = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", workerSource],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  worker.stdout.setEncoding("utf8");
  worker.stderr.setEncoding("utf8");
  worker.stdout.on("data", (chunk: string) => { stdout += chunk; });
  worker.stderr.on("data", (chunk: string) => { stderr += chunk; });

  try {
    await waitForFileText(callbackMarker, /run_id/);
    const marker = JSON.parse(await fs.readFile(callbackMarker, "utf8")) as { run_id: string };
    const armed = await waitForDelayedEffectArmed(fixture.fake.logPath, nonce);
    assert.equal(armed.run_id, marker.run_id);
    assert.equal(armed.nonce, nonce);
    assert.equal(armed.delay_ms, delayMs);
    assert.equal(armed.effect_path, consequentialEffect);
    assert.equal(exactPidIsAlive(armed.pid), true);
    assert.equal(typeof worker.pid, "number");
    assert.equal(exactPidIsAlive(worker.pid!), true);

    assert.equal(worker.kill("SIGKILL"), true);
    const workerExit = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        worker.once("error", reject);
        worker.once("close", (code, signal) => resolve({ code, signal }));
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SIGKILL worker did not close")), 2_000)),
    ]);
    assert.equal(workerExit.code, null, stderr || stdout);
    assert.equal(workerExit.signal, "SIGKILL", stderr || stdout);
    await waitForExactPidGone(armed.pid);

    const recordPath = path.join(fixture.runTasksDir, `${marker.run_id}.json`);
    const preRestartRecord = JSON.parse(await fs.readFile(recordPath, "utf8")) as RunSubagentMetadata;
    assert.equal(preRestartRecord.child_started, false);
    assert.equal(preRestartRecord.recent_events?.some((event) => event.event === "child_spawned"), false);

    const restartSource = `
      const { getRunTask } = await import(${JSON.stringify(runTaskUrl)});
      console.log(JSON.stringify(await getRunTask(${JSON.stringify(marker.run_id)})));
    `;
    const firstRestart = await runTestWorker(restartSource, env);
    assert.equal(firstRestart.code, 0, firstRestart.stderr);
    const firstView = JSON.parse(firstRestart.stdout.trim()) as RunSubagentMetadata;
    assert.equal(firstView.status, "failed");
    assert.equal(firstView.reason_code, "server_restarted_active_run");
    assert.equal(firstView.child_started, false);
    assert.equal(firstView.recent_events?.some((event) => event.event === "child_spawned"), false);
    const firstDurableBytes = await fs.readFile(recordPath, "utf8");
    assert.equal("revision" in JSON.parse(firstDurableBytes), false);

    const secondRestart = await runTestWorker(restartSource, env);
    assert.equal(secondRestart.code, 0, secondRestart.stderr);
    const secondView = JSON.parse(secondRestart.stdout.trim()) as RunSubagentMetadata;
    assert.equal(secondView.status, "failed");
    assert.equal(secondView.reason_code, "server_restarted_active_run");
    const secondDurableBytes = await fs.readFile(recordPath, "utf8");
    assert.equal(secondDurableBytes, firstDurableBytes);

    const effectDeadline = Date.parse(armed.armed_at) + armed.delay_ms + 100;
    if (Date.now() < effectDeadline) {
      await new Promise((resolve) => setTimeout(resolve, effectDeadline - Date.now()));
    }
    await assert.rejects(fs.stat(consequentialEffect), (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ENOENT"
    );
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    await removeDirectRunTestFixture(fixture);
  }
});

test("persisted parent child grandchild restart reconciliation converges without nested-owner deadlock", async () => {
  const fixture = await createDirectRunTestFixture("subagent007-persisted-restart-graph-");
  const runTaskUrl = pathToFileURL(path.resolve("src/runTask.ts")).href;
  const createGraphSource = `
    import fs from "node:fs/promises";
    const { getRunTask, startRunTask } = await import(${JSON.stringify(runTaskUrl)});
    const root = await startRunTask({ cwd: ${JSON.stringify(fixture.projectDir)}, prompt: "CANCEL_WAIT" });
    const child = await startRunTask(
      { cwd: ${JSON.stringify(fixture.projectDir)}, prompt: "CANCEL_WAIT" },
      { lineage: { parentRunId: root.run_id, rootRunId: root.run_id, recursionDepth: 1 } },
    );
    const grandchild = await startRunTask(
      { cwd: ${JSON.stringify(fixture.projectDir)}, prompt: "CANCEL_WAIT" },
      { lineage: { parentRunId: child.run_id, rootRunId: root.run_id, recursionDepth: 2 } },
    );
    for (const runId of [root.run_id, child.run_id, grandchild.run_id]) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const view = await getRunTask(runId);
        if (view.child_started === true) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if ((await getRunTask(runId)).child_started !== true) throw new Error("graph child did not start: " + runId);
    }
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const log = await fs.readFile(process.env.FAKE_PI_LOG_PATH, "utf8").catch(() => "");
      const pids = log.trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line).pid).filter(Number.isInteger);
      if (pids.length === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const log = await fs.readFile(process.env.FAKE_PI_LOG_PATH, "utf8");
    const pids = log.trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line).pid).filter(Number.isInteger);
    if (pids.length !== 3) throw new Error("graph did not observe three exact child PIDs");
    console.log(JSON.stringify({ root: root.run_id, child: child.run_id, grandchild: grandchild.run_id }));
    process.exit(73);
  `;
  const env = { ...process.env, ...fixture.env };

  try {
    const created = await runTestWorker(createGraphSource, env);
    assert.equal(created.code, 73, created.stderr);
    const ids = JSON.parse(created.stdout.trim()) as {
      root: string;
      child: string;
      grandchild: string;
    };
    const childProcesses = (await readJsonl<{ pid?: number }>(fixture.fake.logPath))
      .map((record) => record.pid)
      .filter((pid): pid is number => typeof pid === "number");
    assert.equal(childProcesses.length, 3);
    await Promise.all(childProcesses.map((pid) => waitForExactPidGone(pid)));

    const rootRecordPath = path.join(fixture.runTasksDir, `${ids.root}.json`);
    const rootBeforeRestart = JSON.parse(await fs.readFile(rootRecordPath, "utf8")) as RunSubagentMetadata;
    assert.equal(typeof rootBeforeRestart.partial_output_path, "string");
    const rootPartialPath = rootBeforeRestart.partial_output_path!;
    const reconcileSource = `
      import assert from "node:assert/strict";
      import { createHash } from "node:crypto";
      import fs from "node:fs/promises";
      import path from "node:path";

      const rootRunId = ${JSON.stringify(ids.root)};
      const rootPartialPath = ${JSON.stringify(rootPartialPath)};
      const partialBasename = path.basename(rootPartialPath);
      const partialPrefix = "." + rootRunId + ".";
      assert.equal(partialBasename.startsWith(partialPrefix), true);
      assert.equal(partialBasename.endsWith(".partial"), true);
      const rootFinalPath = path.join(
        path.dirname(rootPartialPath),
        partialBasename.slice(partialPrefix.length, -".partial".length) + ".md",
      );
      const rootClaimLockPath = path.join(
        ${JSON.stringify(path.resolve(fixture.runTasksDir))},
        ".claim-locks",
        createHash("sha256").update(rootRunId).digest("hex") + ".lock",
      );
      const originalLink = fs.link.bind(fs);
      const originalRename = fs.rename.bind(fs);
      let rootLockAttemptObserved = false;
      let partialPresentAtRootLockAttempt = false;
      let finalAbsentAtRootLockAttempt = false;
      let rootTranscriptRenameObserved = false;
      let rootTranscriptRenameOwned = false;

      fs.link = async (...args) => {
        const destination = args[1];
        if (!rootLockAttemptObserved && typeof destination === "string" &&
          path.resolve(destination) === rootClaimLockPath) {
          rootLockAttemptObserved = true;
          partialPresentAtRootLockAttempt = await fs.stat(rootPartialPath)
            .then((stat) => stat.isFile(), () => false);
          finalAbsentAtRootLockAttempt = await fs.lstat(rootFinalPath)
            .then(() => false, (error) => error?.code === "ENOENT");
        }
        return originalLink(...args);
      };
      fs.rename = async (...args) => {
        const [source, destination] = args;
        if (!rootTranscriptRenameObserved && typeof source === "string" && typeof destination === "string" &&
          path.resolve(source) === rootPartialPath && path.resolve(destination) === rootFinalPath) {
          rootTranscriptRenameObserved = true;
          rootTranscriptRenameOwned = await fs.readFile(rootClaimLockPath, "utf8")
            .then((bytes) => JSON.parse(bytes).pid === process.pid, () => false);
        }
        return originalRename(...args);
      };

      const { getRunTask } = await import(${JSON.stringify(runTaskUrl)});
      const settled = await Promise.allSettled([
        getRunTask(rootRunId),
        getRunTask(rootRunId),
        getRunTask(${JSON.stringify(ids.child)}),
        getRunTask(${JSON.stringify(ids.grandchild)}),
      ]);
      const orderingObservation = {
        rootLockAttemptObserved,
        partialPresentAtRootLockAttempt,
        finalAbsentAtRootLockAttempt,
      };
      const ownershipObservation = {
        rootTranscriptRenameObserved,
        rootTranscriptRenameOwned,
      };
      assert.deepEqual(orderingObservation, {
        rootLockAttemptObserved: true,
        partialPresentAtRootLockAttempt: true,
        finalAbsentAtRootLockAttempt: true,
      }, "root transcript recovery occurred before root claim-lock acquisition");
      assert.deepEqual(ownershipObservation, {
        rootTranscriptRenameObserved: true,
        rootTranscriptRenameOwned: true,
      }, "root transcript rename did not occur under this process's exact root claim lock");
      assert.equal(settled.every((result) => result.status === "fulfilled"), true,
        "concurrent restart reconciliation did not fully settle");
      const [rootA, rootB, child, grandchild] = settled.map((result) => result.value);
      assert.equal(rootA.output_references?.length, 1);
      assert.equal(rootB.output_references?.length, 1);
      assert.deepEqual(rootB.output_references, rootA.output_references);
      assert.equal(rootA.status, "failed");
      assert.equal(rootB.status, "failed");
      assert.equal(child.status, "failed");
      assert.equal(grandchild.status, "failed");
      assert.deepEqual(rootA.descendant_run_ids, [${JSON.stringify(ids.child)}, ${JSON.stringify(ids.grandchild)}]);
      assert.equal(rootA.descendant_terminal_statuses?.[${JSON.stringify(ids.child)}], "failed");
      assert.equal(rootA.descendant_terminal_statuses?.[${JSON.stringify(ids.grandchild)}], "failed");
      assert.deepEqual(child.descendant_run_ids, [${JSON.stringify(ids.grandchild)}]);
      assert.equal(child.descendant_terminal_statuses?.[${JSON.stringify(ids.grandchild)}], "failed");
      console.log(JSON.stringify({ rootA, rootB, child, grandchild }));
    `;
    const reconciled = await runTestWorker(reconcileSource, env);
    assert.equal(reconciled.code, 0, reconciled.stderr);
    const views = JSON.parse(reconciled.stdout.trim()) as {
      rootA: RunSubagentMetadata;
      rootB: RunSubagentMetadata;
      child: RunSubagentMetadata;
      grandchild: RunSubagentMetadata;
    };
    assert.equal(views.rootA.status, "failed");
    assert.equal(views.rootB.status, "failed");
    assert.equal(views.child.status, "failed");
    assert.equal(views.grandchild.status, "failed");
    assert.equal(views.rootA.reason_code, "server_restarted_active_run");
    assert.deepEqual(views.rootA.descendant_run_ids, [ids.child, ids.grandchild]);
    assert.equal(views.rootA.descendant_terminal_statuses?.[ids.child], "failed");
    assert.equal(views.rootA.descendant_terminal_statuses?.[ids.grandchild], "failed");
    assert.deepEqual(views.child.descendant_run_ids, [ids.grandchild]);
    assert.equal(views.child.descendant_terminal_statuses?.[ids.grandchild], "failed");

    const recordPaths = [ids.root, ids.child, ids.grandchild]
      .map((runId) => path.join(fixture.runTasksDir, `${runId}.json`));
    const firstBytes = await Promise.all(recordPaths.map((recordPath) => fs.readFile(recordPath, "utf8")));
    const terminalReplaySource = `
      import assert from "node:assert/strict";
      const { getRunTask } = await import(${JSON.stringify(runTaskUrl)});
      const views = await Promise.all([
        getRunTask(${JSON.stringify(ids.root)}),
        getRunTask(${JSON.stringify(ids.child)}),
        getRunTask(${JSON.stringify(ids.grandchild)}),
      ]);
      assert.deepEqual(views.map((view) => view.status), ["failed", "failed", "failed"]);
    `;
    const reopened = await runTestWorker(terminalReplaySource, env);
    assert.equal(reopened.code, 0, reopened.stderr);
    const secondBytes = await Promise.all(recordPaths.map((recordPath) => fs.readFile(recordPath, "utf8")));
    assert.deepEqual(secondBytes, firstBytes);
  } finally {
    await removeDirectRunTestFixture(fixture);
  }
});

test("execution grant is durable before consequential child release", async (t) => {
  const fixture = await createDirectRunTestFixture("subagent007-spawn-owner-order-");
  const ownerCommitStarted = deferredSignal();
  const releaseOwnerCommit = deferredSignal();
  const originalRename = fs.rename.bind(fs);
  let paused = false;
  t.mock.method(fs, "rename", async (source: string, destination: string) => {
    if (!paused && destination.endsWith(".json") && source.includes(".tmp-")) {
      const candidate = JSON.parse(await fs.readFile(source, "utf8")) as {
        record_name?: string;
        launch_observation?: Record<string, unknown>;
        child_started?: boolean;
      };
      if (candidate.record_name === "subagent007.current_run_claim" &&
        candidate.child_started === true && candidate.launch_observation) {
        paused = true;
        ownerCommitStarted.resolve();
        await releaseOwnerCommit.promise;
      }
    }
    await originalRename(source, destination);
  });

  let runId: string | undefined;
  try {
    await withEnv(fixture.env, async () => {
      const started = await startRunTask({ cwd: fixture.projectDir, prompt: "FAST" });
      runId = started.run_id;
      await ownerCommitStarted.promise;

      const visible = await getRunTask(runId) as RunSubagentMetadata;
      assert.equal(visible.child_started, false);
      assert.equal(visible.status, "working");
      assert.equal(visible.first_public_output_at, undefined);
      assert.doesNotMatch(visible.last_public_output_excerpt ?? "", /FAST FINAL|child_bridge_started|child_prompt_submitted/);
      if (visible.partial_output_path) {
        const transcript = await fs.readFile(visible.partial_output_path, "utf8").catch(() => "");
        assert.doesNotMatch(transcript, /FAST FINAL|child_bridge_started|child_prompt_submitted/);
      }
      const persistedBeforeCommit = JSON.parse(
        await fs.readFile(path.join(fixture.runTasksDir, `${runId}.json`), "utf8"),
      ) as {
        record_name?: string;
        launch_observation?: Record<string, unknown>;
        child_started?: boolean;
        status?: string;
        queued_at?: string;
        child_started_at?: string;
        queue_wait_ms?: number;
      };
      assert.equal(persistedBeforeCommit.record_name, "subagent007.current_run_claim");
      assert.equal(persistedBeforeCommit.child_started, false);
      assert.equal(persistedBeforeCommit.status, "working");
      assert.ok(persistedBeforeCommit.launch_observation);
      assert.equal(persistedBeforeCommit.queued_at, undefined);
      assert.equal(persistedBeforeCommit.child_started_at, undefined);
      assert.equal(persistedBeforeCommit.queue_wait_ms, undefined);

      releaseOwnerCommit.resolve();
      const terminal = await waitForTerminalRunTask(runId);
      assert.equal(terminal.status, "completed");
      assert.equal(terminal.child_started, true);
      assert.equal(await fs.readFile(outputPathFor(terminal), "utf8"), "FAST FINAL");
      assert.ok(terminal.recent_events?.some((event) => event.event === "child_spawned"));
      assert.ok(terminal.recent_events?.some((event) => event.event === "completed"));
    });
  } finally {
    releaseOwnerCommit.resolve();
    if (runId) {
      await withEnv(fixture.env, async () => {
        await cancelAndWaitForDirectRun(runId!).catch(() => undefined);
      });
    }
    await removeDirectRunTestFixture(fixture);
  }
});

test("owner spawn commit rejection forwards no child-origin output or success settlement", async (t) => {
  const fixture = await createDirectRunTestFixture("subagent007-spawn-owner-rejection-");
  const originalRename = fs.rename.bind(fs);
  let rejected = false;
  t.mock.method(fs, "rename", async (source: string, destination: string) => {
    if (!rejected && destination.endsWith(".json") && source.includes(".tmp-")) {
      const candidate = JSON.parse(await fs.readFile(source, "utf8")) as {
        record_name?: string;
        child_started?: boolean;
      };
      if (candidate.record_name === "subagent007.current_run_claim" && candidate.child_started === true) {
        rejected = true;
        throw new Error("injected owner spawn commit rejection");
      }
    }
    await originalRename(source, destination);
  });

  let runId: string | undefined;
  try {
    await withEnv(fixture.env, async () => {
      const started = await startRunTask({ cwd: fixture.projectDir, prompt: "FAST" });
      runId = started.run_id;
      const terminal = await waitForTerminalRunTask(runId);
      assert.equal(terminal.status, "failed");
      assert.equal(terminal.child_started, false);
      assert.equal(terminal.first_public_output_at, undefined);
      assert.equal(
        terminal.recent_events?.some((event) =>
          event.kind === "child" || event.kind === "assistant" || event.event === "completed"
        ),
        false,
      );
      if (terminal.output_references?.length === 1) {
        assert.doesNotMatch(await fs.readFile(outputPathFor(terminal), "utf8"), /FAST FINAL|child_bridge_started/);
      }
    });
  } finally {
    if (runId) {
      await withEnv(fixture.env, async () => {
        await cancelAndWaitForDirectRun(runId!).catch(() => undefined);
      });
    }
    await removeDirectRunTestFixture(fixture);
  }
});

test("deterministic fake child terminates when its parent closes stdin before owner release", async () => {
  const fake = await createFakePiChild("subagent007-fake-pi-eof-");
  const requestPath = path.join(path.dirname(fake.childPath), "request.json");
  await fs.writeFile(requestPath, JSON.stringify({ prompt: "CANCEL_WAIT" }));
  const child = spawn(process.execPath, [fake.childPath, requestPath], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.stdin.end();
    const exit = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("fake child ignored stdin EOF")), 1_500)),
    ]);
    assert.equal(exit.code, null);
    assert.equal(exit.signal === "SIGTERM" || exit.signal === "SIGKILL", true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await fs.rm(path.dirname(fake.childPath), { recursive: true, force: true });
  }
});

test("duplicate child lifecycle callbacks are idempotent for phase and progress", async () => {
  const fixture = await createDirectRunTestFixture("subagent007-child-lifecycle-duplicate-");
  let runId: string | undefined;
  try {
    await withEnv(fixture.env, async () => {
      try {
        const started = await startRunTask({
          cwd: fixture.projectDir,
          prompt: "DUPLICATE_CHILD_BRIDGE OMIT_RECURSIVE_DELEGATION_RECEIPT OMIT_PROMPT_SUBMITTED CANCEL_WAIT",
        });
        runId = started.run_id;
        const view = await waitForDirectRunView(
          runId,
          (candidate) => (candidate.recent_events ?? []).filter(
            (event) => event.kind === "child" && event.event === "child_bridge_started",
          ).length === 2,
          "duplicate child bridge events",
        );
        const bridgeEvents = (view.recent_events ?? []).filter(
          (event) => event.kind === "child" && event.event === "child_bridge_started",
        );
        assert.equal(bridgeEvents.length, 2);
        assert.notEqual(bridgeEvents[0].occurred_at, bridgeEvents[1].occurred_at);
        assert.equal(view.last_child_lifecycle_event, "child_bridge_started");
        assert.equal(view.last_child_lifecycle_at, bridgeEvents[0].occurred_at);
        assert.equal(view.active_phase, "running_silent");
        assert.equal(view.last_phase_at, bridgeEvents[0].occurred_at);
        assert.equal(view.last_progress_at, bridgeEvents[0].occurred_at);
        assert.equal(view.last_progress_message, "child bridge started; waiting for first public output");
      } finally {
        if (runId) await cancelAndWaitForDirectRun(runId);
      }
    });
  } finally {
    await removeDirectRunTestFixture(fixture);
  }
});

test("terminalization preserves producer-real byte-identical general lifecycle observations", async (t) => {
  const fixture = await createDirectRunTestFixture("subagent007-child-lifecycle-identical-");
  const occurredAt = "2026-07-22T12:34:56.789Z";
  t.mock.method(Date.prototype, "toISOString", () => occurredAt);
  let runId: string | undefined;
  try {
    await withEnv(fixture.env, async () => {
      try {
        const started = await startRunTask({
          cwd: fixture.projectDir,
          prompt: "DUPLICATE_CHILD_BRIDGE OMIT_RECURSIVE_DELEGATION_RECEIPT OMIT_PROMPT_SUBMITTED CANCEL_WAIT",
        });
        runId = started.run_id;
        const active = await waitForDirectRunView(
          runId,
          (candidate) => (candidate.recent_events ?? []).filter(
            (event) => event.kind === "child" && event.event === "child_bridge_started",
          ).length === 2,
          "byte-identical child bridge observations",
        );
        const activeBridgeEvents = (active.recent_events ?? []).filter(
          (event) => event.kind === "child" && event.event === "child_bridge_started",
        );
        assert.equal(activeBridgeEvents.length, 2);
        assert.deepEqual(activeBridgeEvents[0], activeBridgeEvents[1]);

        await cancelRunTask(runId);
        const terminal = await waitForTerminalRunTask(runId);
        const terminalBridgeEvents = (terminal.recent_events ?? []).filter(
          (event) => event.kind === "child" && event.event === "child_bridge_started",
        );
        assert.equal(terminalBridgeEvents.length, 2);
        assert.deepEqual(terminalBridgeEvents[0], terminalBridgeEvents[1]);
      } finally {
        if (runId) await cancelAndWaitForDirectRun(runId);
      }
    });
  } finally {
    await removeDirectRunTestFixture(fixture);
  }
});

test("producer-order lifecycle projection advances through session before optional activation events", async () => {
  const fixture = await createDirectRunTestFixture("subagent007-child-lifecycle-producer-order-");
  let runId: string | undefined;
  try {
    await withEnv(fixture.env, async () => {
      try {
        const started = await startRunTask({
          cwd: fixture.projectDir,
          prompt: "EMIT_EPHEMERAL_SESSION_EVENT CANCEL_WAIT",
        });
        runId = started.run_id;
        const pausedAfterSession = await waitForDirectRunView(
          runId,
          (view) => view.last_child_lifecycle_event === "child_prompt_submitted",
          "prompt-submitted lifecycle projection",
        );
        const lifecycleEvents = (pausedAfterSession.recent_events ?? [])
          .filter((event) => event.kind === "child")
          .map((event) => event.event);
        assert.deepEqual(lifecycleEvents.slice(-3), [
          "recursive_delegation_confirmed",
          "child_session_established",
          "child_prompt_submitted",
        ]);
        assert.equal(pausedAfterSession.last_child_lifecycle_event, "child_prompt_submitted");
      } finally {
        if (runId) await cancelAndWaitForDirectRun(runId);
      }
    });
  } finally {
    await removeDirectRunTestFixture(fixture);
  }
});

test("producer-order lifecycle projection skips absent session and snapshot before activation", async () => {
  const fixture = await createDirectRunTestFixture("subagent007-child-lifecycle-activation-gap-");
  let runId: string | undefined;
  try {
    await withEnv(fixture.env, async () => {
      try {
        const started = await startRunTask({
          cwd: fixture.projectDir,
          prompt: "CANCEL_WAIT",
          effect_profile: "workspace_read_only",
          recursive_delegation: "disabled",
        });
        runId = started.run_id;
        const pausedAfterActivation = await waitForDirectRunView(
          runId,
          (view) => view.last_child_lifecycle_event === "child_prompt_submitted",
          "activation-gap prompt projection",
        );
        assert.equal(
          pausedAfterActivation.recent_events?.some((event) => event.event === "child_session_established"),
          false,
        );
        assert.equal(
          pausedAfterActivation.recent_events?.some((event) => event.event === "skill_snapshot_activation_confirmed"),
          false,
        );
        assert.equal(pausedAfterActivation.last_child_lifecycle_event, "child_prompt_submitted");
      } finally {
        if (runId) await cancelAndWaitForDirectRun(runId);
      }
    });
  } finally {
    await removeDirectRunTestFixture(fixture);
  }
});

test("producer-order lifecycle projection skips absent session and activation before snapshot", async () => {
  const fixture = await createDirectRunTestFixture("subagent007-child-lifecycle-snapshot-gap-");
  const skillsRoot = path.join(fixture.root, "skills");
  const snapshotsRoot = path.join(fixture.root, "snapshots");
  const skillName = "lifecycle-snapshot-gap";
  const skillPath = await writeSkillFixture(skillsRoot, skillName);
  const bundle = await validateSkillRuntimeBundle(path.dirname(skillPath));
  const publication = await publishSkillSnapshotsRequest({
    contract_version: 1,
    cwd: fixture.projectDir,
    project_reference: {
      project_id: "lifecycle-projection",
      publication_id: "snapshot-gap",
      lifecycle: "active",
    },
    bindings: [{ skill_name: skillName, expected_bundle_sha256: bundle.bundle_sha256 }],
  }, {
    lookupPaths: [skillsRoot],
    agentDir: path.join(fixture.root, "agent"),
    snapshotsRoot,
  });
  assert.equal(publication.kind, "skill_snapshots_published");
  if (publication.kind !== "skill_snapshots_published") throw new Error("snapshot publication failed");
  const published = publication.bindings[0];
  const skillSnapshotBinding = {
    contract_version: 1 as const,
    snapshot_id: published.snapshot_identity.snapshot_id,
    metadata_sha256: published.snapshot_identity.metadata_sha256,
    publication_receipt_sha256: published.publication_receipt.receipt_sha256,
    reference_id: published.publication_receipt.reference_id,
    project_id: published.publication_receipt.project_reference.project_id,
    publication_id: published.publication_receipt.project_reference.publication_id,
  };
  let runId: string | undefined;
  try {
    await withEnv({
      ...fixture.env,
      SUBAGENT007_PI_SKILL_PATHS: skillsRoot,
      SUBAGENT007_SKILL_SNAPSHOTS_DIR: snapshotsRoot,
    }, async () => {
      try {
        const started = await startRunTask({
          cwd: fixture.projectDir,
          prompt: "CANCEL_WAIT",
          skill_name: skillName,
          skill_snapshot_binding: skillSnapshotBinding,
        });
        runId = started.run_id;
        const pausedAfterSnapshot = await waitForDirectRunView(
          runId,
          (view) => view.last_child_lifecycle_event === "child_prompt_submitted",
          "snapshot-gap prompt projection",
        );
        assert.equal(
          pausedAfterSnapshot.recent_events?.some((event) => event.event === "child_session_established"),
          false,
        );
        assert.equal(
          pausedAfterSnapshot.recent_events?.some((event) => event.event === "activation_confirmed"),
          false,
        );
        assert.equal(pausedAfterSnapshot.last_child_lifecycle_event, "child_prompt_submitted");
      } finally {
        if (runId) await cancelAndWaitForDirectRun(runId);
      }
    });
  } finally {
    await makeDirectoriesRemovable(snapshotsRoot);
    await removeDirectRunTestFixture(fixture);
  }
});

test("producer-real lifecycle order projects activation before snapshot when both are present", async () => {
  const fixture = await createDirectRunTestFixture("subagent007-child-lifecycle-all-present-");
  const skillsRoot = path.join(fixture.root, "skills");
  const snapshotsRoot = path.join(fixture.root, "snapshots");
  const skillName = "lifecycle-all-present";
  const skillPath = await writeSkillFixture(skillsRoot, skillName);
  const bundle = await validateSkillRuntimeBundle(path.dirname(skillPath));
  const publication = await publishSkillSnapshotsRequest({
    contract_version: 1,
    cwd: fixture.projectDir,
    project_reference: {
      project_id: "lifecycle-projection",
      publication_id: "all-present",
      lifecycle: "active",
    },
    bindings: [{ skill_name: skillName, expected_bundle_sha256: bundle.bundle_sha256 }],
  }, {
    lookupPaths: [skillsRoot],
    agentDir: path.join(fixture.root, "agent"),
    snapshotsRoot,
  });
  assert.equal(publication.kind, "skill_snapshots_published");
  if (publication.kind !== "skill_snapshots_published") throw new Error("snapshot publication failed");
  const published = publication.bindings[0];
  const skillSnapshotBinding = {
    contract_version: 1 as const,
    snapshot_id: published.snapshot_identity.snapshot_id,
    metadata_sha256: published.snapshot_identity.metadata_sha256,
    publication_receipt_sha256: published.publication_receipt.receipt_sha256,
    reference_id: published.publication_receipt.reference_id,
    project_id: published.publication_receipt.project_reference.project_id,
    publication_id: published.publication_receipt.project_reference.publication_id,
  };
  let runId: string | undefined;
  try {
    await withEnv({
      ...fixture.env,
      SUBAGENT007_PI_SKILL_PATHS: skillsRoot,
      SUBAGENT007_SKILL_SNAPSHOTS_DIR: snapshotsRoot,
    }, async () => {
      try {
        const started = await startRunTask({
          cwd: fixture.projectDir,
          prompt: "CANCEL_WAIT",
          skill_name: skillName,
          skill_snapshot_binding: skillSnapshotBinding,
          effect_profile: "workspace_read_only",
          recursive_delegation: "disabled",
        });
        runId = started.run_id;
        const pausedAfterSnapshot = await waitForDirectRunView(
          runId,
          (view) => view.last_child_lifecycle_event === "child_prompt_submitted",
          "all-present prompt projection",
        );
        const lifecycleEvents = (pausedAfterSnapshot.recent_events ?? [])
          .filter((event) => event.kind === "child")
          .map((event) => event.event);
        assert.deepEqual(lifecycleEvents.slice(-3), [
          "activation_confirmed",
          "skill_snapshot_activation_confirmed",
          "child_prompt_submitted",
        ]);
        assert.equal(pausedAfterSnapshot.last_child_lifecycle_event, "child_prompt_submitted");
      } finally {
        if (runId) await cancelAndWaitForDirectRun(runId);
      }
    });
  } finally {
    await makeDirectoriesRemovable(snapshotsRoot);
    await removeDirectRunTestFixture(fixture);
  }
});

test("MCP input waits for child acceptance before returning an idempotent receipt", async () => {
  await connectFakeClient(async (client, { projectDir, fakeLogPath }) => {
    const startedResponse = await client.callTool({
      name: "start_run",
      arguments: {
        cwd: projectDir,
        prompt: "REQUEST_INPUT_WAIT",
      },
    });
    assert.notEqual(startedResponse.isError, true);
    const started = startedResponse.structuredContent as RunSubagentMetadata;
    const pending = await waitForInputRequired(client, started.run_id);
    const request = pending.input_requests.find((entry) => entry.status === "pending");
    assert.ok(request);

    const answer = "SECRET_ANSWER";
    const responseId = "response-001";
    const answeredResponse = await client.callTool({
      name: "answer_run_input",
      arguments: {
        run_id: started.run_id,
        request_id: request.request_id,
        answer,
        response_id: responseId,
      },
    });
    assert.notEqual(answeredResponse.isError, true);
    const answered = answeredResponse.structuredContent as RunSubagentMetadata;
    assert.equal(answered.status, "working");
    assert.equal(answered.input_response_id, responseId);
    assert.equal(typeof answered.input_response_receipt, "string");
    assert.equal(answered.input_response_outcome, "accepted");
    assert.equal(JSON.stringify(answered).includes(answer), false);

    const conflictingReplay = await client.callTool({
      name: "answer_run_input",
      arguments: {
        run_id: started.run_id,
        request_id: request.request_id,
        answer: "DIFFERENT_SECRET_ANSWER",
        response_id: responseId,
      },
    });
    const conflict = conflictingReplay.structuredContent as RunSubagentMetadata;
    assert.equal(conflict.kind, "operation_rejected");
    assert.equal(conflict.reason_code, "input_response_id_conflict");

    // A child may complete immediately after acknowledging the response.  The
    // exact-live retry guarantee therefore includes the terminal view while
    // this server instance still owns the run.
    const terminal = await waitForTerminalRun(client, started.run_id);
    assert.equal(terminal.status, "completed");

    const replayResponse = await client.callTool({
      name: "answer_run_input",
      arguments: {
        run_id: started.run_id,
        request_id: request.request_id,
        answer,
        response_id: responseId,
      },
    });
    assert.notEqual(replayResponse.isError, true);
    const replay = replayResponse.structuredContent as RunSubagentMetadata;
    assert.equal(replay.input_response_receipt, answered.input_response_receipt);
    assert.equal(replay.input_response_outcome, "replayed");

    assert.equal(await fs.readFile(outputPathFor(terminal), "utf8"), "INPUT CONTINUED");
    assert.equal(JSON.stringify(terminal).includes(answer), false);
    assert.equal((await fs.readFile(fakeLogPath, "utf8")).includes(answer), false);
  });
});

test("accepted input receipts replay only while their owning server remains live", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-live-input-replay-"));
  const stateEnv = {
    SUBAGENT007_RUNS_DIR: path.join(stateRoot, "runs"),
    SUBAGENT007_RUN_TASKS_DIR: path.join(stateRoot, "run-tasks"),
    SUBAGENT007_INPUT_REQUESTS_DIR: path.join(stateRoot, "input-requests"),
    SUBAGENT007_ACTIVE_CHILDREN_DIR: path.join(stateRoot, "active-children"),
    SUBAGENT007_QUEUED_RUNS_DIR: path.join(stateRoot, "queued-runs"),
  };
  let runId = "";
  let requestId = "";

  await connectFakeClient(async (client, { projectDir }) => {
    const started = (await client.callTool({
      name: "start_run",
      arguments: { cwd: projectDir, prompt: "REQUEST_INPUT_WAIT" },
    })).structuredContent as RunSubagentMetadata;
    runId = started.run_id;
    const pending = await waitForInputRequired(client, runId);
    requestId = pending.input_requests.find((request) => request.status === "pending")?.request_id ?? "";
    assert.ok(requestId);
    const accepted = (await client.callTool({
      name: "answer_run_input",
      arguments: {
        run_id: runId,
        request_id: requestId,
        response_id: "live-only-response-001",
        answer: "continue",
      },
    })).structuredContent as RunSubagentMetadata;
    assert.equal(accepted.input_response_outcome, "accepted");
    assert.equal((await waitForTerminalRun(client, runId)).status, "completed");
  }, { env: stateEnv });

  await connectFakeClient(async (client) => {
    const replay = (await client.callTool({
      name: "answer_run_input",
      arguments: {
        run_id: runId,
        request_id: requestId,
        response_id: "live-only-response-001",
        answer: "continue",
      },
    })).structuredContent as RunSubagentMetadata;
    assert.equal(replay.kind, "operation_rejected");
    assert.equal(replay.reason_code, "run_not_found");
  }, { env: stateEnv });
});

test("accepted input remains settled when cancellation happens afterwards", async () => {
  await connectFakeClient(async (client, { projectDir }) => {
    const started = (await client.callTool({
      name: "start_run",
      arguments: { cwd: projectDir, prompt: "REQUEST_INPUT_WAIT" },
    })).structuredContent as RunSubagentMetadata;
    const pending = await waitForInputRequired(client, started.run_id);
    const request = pending.input_requests.find((entry) => entry.status === "pending");
    assert.ok(request);

    const answeredResponse = await client.callTool({
      name: "answer_run_input",
      arguments: {
        run_id: started.run_id,
        request_id: request.request_id,
        response_id: "answer-first-001",
        answer: "continue",
      },
    });
    assert.notEqual(answeredResponse.isError, true);
    const answered = answeredResponse.structuredContent as RunSubagentMetadata;
    assert.equal(answered.input_response_outcome, "accepted");

    const cancelledResponse = await client.callTool({ name: "cancel_run", arguments: { run_id: started.run_id } });
    assert.notEqual(cancelledResponse.isError, true);
    const terminal = await waitForTerminalRun(client, started.run_id);
    assert.equal(terminal.status, "cancelled");
    assert.equal(terminal.input_requests.find((entry) => entry.request_id === request.request_id)?.status, "answered");
  });
});

test("cancellation closes an input delivery that has not reached child acceptance", async () => {
  await connectFakeClient(async (client, { projectDir }) => {
    const started = (await client.callTool({
      name: "start_run",
      arguments: { cwd: projectDir, prompt: "REQUEST_INPUT_DELAYED_ACK" },
    })).structuredContent as RunSubagentMetadata;
    const pending = await waitForInputRequired(client, started.run_id);
    const request = pending.input_requests.find((entry) => entry.status === "pending");
    assert.ok(request);

    const answerPromise = client.callTool({
      name: "answer_run_input",
      arguments: {
        run_id: started.run_id,
        request_id: request.request_id,
        response_id: "cancel-first-001",
        answer: "continue",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const cancelledResponse = await client.callTool({ name: "cancel_run", arguments: { run_id: started.run_id } });
    assert.notEqual(cancelledResponse.isError, true);
    const answerResponse = await answerPromise;
    assert.notEqual(answerResponse.isError, true);
    const rejected = answerResponse.structuredContent as { kind?: string; reason_code?: string };
    assert.equal(rejected.kind, "operation_rejected");
    assert.equal(rejected.reason_code, "input_request_already_closed");
    const terminal = await waitForTerminalRun(client, started.run_id);
    assert.equal(terminal.status, "cancelled");
    assert.equal(terminal.input_requests.find((entry) => entry.request_id === request.request_id)?.status, "closed");
  });
});

test("child acceptance wins finalization that follows in the same output turn", async () => {
  await connectFakeClient(async (client, { projectDir }) => {
    const started = (await client.callTool({
      name: "start_run",
      arguments: { cwd: projectDir, prompt: "REQUEST_INPUT_ACK_THEN_EXIT" },
    })).structuredContent as RunSubagentMetadata;
    const pending = await waitForInputRequired(client, started.run_id);
    const request = pending.input_requests.find((entry) => entry.status === "pending");
    assert.ok(request);

    const answeredResponse = await client.callTool({
      name: "answer_run_input",
      arguments: {
        run_id: started.run_id,
        request_id: request.request_id,
        response_id: "ack-before-finalization-001",
        answer: "continue",
      },
    });
    assert.notEqual(answeredResponse.isError, true);
    const answered = answeredResponse.structuredContent as RunSubagentMetadata;
    assert.equal(answered.input_response_outcome, "accepted");
    const terminal = await waitForTerminalRun(client, started.run_id);
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.input_requests.find((entry) => entry.request_id === request.request_id)?.status, "answered");
  });
});

test("child exit before acceptance rejects the delivery without a receipt", async () => {
  await connectFakeClient(async (client, { projectDir }) => {
    const started = (await client.callTool({
      name: "start_run",
      arguments: { cwd: projectDir, prompt: "REQUEST_INPUT_EXIT_BEFORE_ACK" },
    })).structuredContent as RunSubagentMetadata;
    const pending = await waitForInputRequired(client, started.run_id);
    const request = pending.input_requests.find((entry) => entry.status === "pending");
    assert.ok(request);

    const answerResponse = await client.callTool({
      name: "answer_run_input",
      arguments: {
        run_id: started.run_id,
        request_id: request.request_id,
        response_id: "exit-before-ack-001",
        answer: "continue",
      },
    });
    assert.notEqual(answerResponse.isError, true);
    const rejected = answerResponse.structuredContent as { kind?: string; reason_code?: string };
    assert.equal(rejected.kind, "operation_rejected");
    assert.equal(rejected.reason_code, "run_not_accepting_input");
    const terminal = await waitForTerminalRun(client, started.run_id);
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.input_requests.find((entry) => entry.request_id === request.request_id)?.status, "closed");
  });
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
    assert.equal(Object.hasOwn(eventView, "output_path"), false);
    assert.equal(Object.hasOwn(eventView, "partial_output_path"), false);
    assert.doesNotMatch(JSON.stringify(eventView.recent_events), /thinking_delta|SECRET_THINKING/);
    const cancelled = await client.callTool({ name: "cancel_run", arguments: { run_id: started.run_id } });
    assert.equal(JSON.stringify(cancelled.structuredContent).includes("output_path"), false);
  });
});

test("MCP start_session_run exposes running_silent before first child output", async () => {
  await connectFakeClient(
    async (client, { projectDir }) => {
      const startedResponse = await client.callTool({
        name: "start_session_run",
        arguments: {
          cwd: projectDir,
          prompt: "REQUEST_INPUT_WAIT",
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
      assert.equal(["starting", "running_silent"].includes(started.active_phase ?? ""), true);
      assert.match(started.last_progress_message ?? "", /preparing child process|waiting for first public output/);
      const pending = await waitForInputRequired(client, started.run_id);
      const request = pending.input_requests.find((entry) => entry.status === "pending");
      assert.ok(request);
      const answerResponse = await client.callTool({
        name: "answer_run_input",
        arguments: {
          run_id: started.run_id,
          request_id: request.request_id,
          response_id: "session-response-001",
          answer: "continue",
        },
      });
      assert.notEqual(answerResponse.isError, true);
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
      requested_recursive_delegation?: "disabled" | "enabled";
      resolved_recursive_delegation?: "disabled" | "enabled";
      recursive_delegation_receipt?: {
        requested_recursive_delegation: "disabled" | "enabled" | null;
        resolved_recursive_delegation: "disabled" | "enabled";
      };
    };
    assert.equal(terminal.task_kind, "session");
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.success, true);
    assert.equal(terminal.child_started, true);
    assert.equal(terminal.session_key, "mcp-session:T001");
    assert.equal(terminal.packet_parse_status, "valid");
    assert.equal(terminal.run_record?.success, true);
    assert.equal(terminal.requested_recursive_delegation, undefined);
    assert.equal(terminal.resolved_recursive_delegation, "disabled");
    assert.deepEqual(terminal.recursive_delegation_receipt, {
      schema_version: 1,
      confirmed_before_prompt: true,
      requested_recursive_delegation: "disabled",
      resolved_recursive_delegation: "disabled",
      delegate_tool_active: false,
    });
    assert.ok(terminal.recent_events?.some((event) => event.event === "packet_accepted"));
    assert.ok(terminal.recent_events?.some((event) => event.text === "[server_contract] packet_policy=required contract_packet_v1 instruction applied"));
    assert.doesNotMatch(JSON.stringify(terminal.recent_events), /<subagent007_contract_packet>/);
    assert.doesNotMatch(JSON.stringify(terminal), /input_requests_dir|pi_session_id/);
  });
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

test("getRunTask rejects a terminal direct-v2 snapshot without a current claim and without mutation", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-direct-v2-read-"));
  const runTasksDir = path.join(tmp, "run-tasks");
  const runId = "direct-v2-terminal-run";
  const recordPath = path.join(runTasksDir, `${runId}.json`);
  await fs.mkdir(runTasksDir, { recursive: true });
  const bytes = `${JSON.stringify({
    contract_name: "subagent007.durable_run",
    contract_version: 2,
    run_id: runId,
    task_id: runId,
    task_kind: "run",
    status: "completed",
  }, null, 2)}\n`;
  await fs.writeFile(recordPath, bytes);
  const beforeEntries = await fs.readdir(runTasksDir);

  await withEnv({ SUBAGENT007_RUN_TASKS_DIR: runTasksDir }, async () => {
    await assert.rejects(
      getRunTask(runId),
      (error: unknown) =>
        error instanceof ValidationError &&
        error.reasonCode === "run_liveness_unknown" &&
        error.message === "run snapshot is missing its current run claim",
    );
  });

  assert.equal(await fs.readFile(recordPath, "utf8"), bytes);
  assert.deepEqual(await fs.readdir(runTasksDir), beforeEntries);
});

test("getRunTask rejects terminal and active subagent007.run_owner_record envelopes without mutation", async () => {
  const fixture = await createDirectRunTestFixture("subagent007-historical-owner-rejected-");
  try {
    await withEnv(fixture.env, async () => {
      const started = await startRunTask({ cwd: fixture.projectDir, prompt: "FAST" });
      await waitForTerminalRunTask(started.run_id);
      const recordPath = path.join(fixture.runTasksDir, `${started.run_id}.json`);
      const claim = JSON.parse(await fs.readFile(recordPath, "utf8")) as Record<string, unknown>;
      const {
        record_name: _recordName,
        record_version: _recordVersion,
        declarations: _declarations,
        launch_observation,
        ...terminalPublicView
      } = claim;
      const settlementEvent = (terminalPublicView.recent_events as Array<Record<string, unknown>>).find((event) =>
        event.kind === "terminal"
      );
      if (!settlementEvent) throw new Error("terminal claim omitted its settlement event");

      const cases: Array<{ label: string; publicView: Record<string, unknown> }> = [
        { label: "terminal", publicView: terminalPublicView },
        { label: "active", publicView: { ...terminalPublicView, status: "working", finished_at: undefined } },
      ];
      for (const { label, publicView } of cases) {
        const historical: Record<string, unknown> = {
          record_name: "subagent007.run_owner_record",
          record_version: 1,
          revision: 7,
          immutable_admission: { run_id: started.run_id },
          launch_observation,
          settlement: {
            status: terminalPublicView.status,
            event: settlementEvent,
            occurred_at: terminalPublicView.finished_at,
          },
          public_view: publicView,
        };
        const historicalBytes: string = `${JSON.stringify(historical, null, 2)}\n`;
        await fs.writeFile(recordPath, historicalBytes);
        const beforeEntries = await fs.readdir(fixture.runTasksDir);

        await assert.rejects(
          getRunTask(started.run_id),
          (error: unknown) =>
            error instanceof ValidationError &&
            error.reasonCode === "run_liveness_unknown" &&
            error.message === "run snapshot is missing its current run claim",
          `${label} historical owner envelope was accepted`,
        );

        assert.equal(await fs.readFile(recordPath, "utf8"), historicalBytes);
        assert.deepEqual(await fs.readdir(fixture.runTasksDir), beforeEntries);
      }
    });
  } finally {
    await removeDirectRunTestFixture(fixture);
  }
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
      args: ["--import", "tsx", path.resolve("src/server.ts")],
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
      assert.ok(terminal.recent_events?.some((event) => event.event === "completed"));
      await waitForPathMissing(path.join(stateDir, "input-requests", runId));
    } finally {
      await client.close();
    }
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.resolve("src/server.ts")],
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
    assert.equal(await fs.readFile(outputPathFor(metadata, path.join(stateDir, "runs")), "utf8"), "FAST FINAL");
  } finally {
    await client.close();
  }
});

test("unreadable legacy leases reject active-run inspection without restart terminalization", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-unknown-lease-"));
  const runTasksDir = path.join(tmp, "run-tasks");
  const inputRequestsDir = path.join(tmp, "input-requests");
  const activeChildrenDir = path.join(tmp, "active-children");
  const runId = "unknown-lease-run";
  await fs.mkdir(runTasksDir, { recursive: true });
  await fs.mkdir(path.join(inputRequestsDir, runId), { recursive: true });
  await fs.mkdir(activeChildrenDir, { recursive: true });
  await fs.writeFile(path.join(activeChildrenDir, "legacy-owner.json"), "{");
  await fs.writeFile(
    path.join(runTasksDir, `${runId}.json`),
    `${JSON.stringify({
      contract_name: "subagent007.durable_run",
      contract_version: 3,
      run_id: runId,
      task_id: runId,
      task_kind: "run",
      status: "working",
      started_at: "2026-06-19T00:00:00.000Z",
      input_requests_dir: path.join(inputRequestsDir, runId),
      input_requests: [],
      active_phase: "running_silent",
      last_phase_at: "2026-06-19T00:00:01.000Z",
    }, null, 2)}\n`,
  );
  await withEnv(
    {
      SUBAGENT007_RUN_TASKS_DIR: runTasksDir,
      SUBAGENT007_INPUT_REQUESTS_DIR: inputRequestsDir,
      SUBAGENT007_ACTIVE_CHILDREN_DIR: activeChildrenDir,
    },
    async () => {
      await assert.rejects(
        getRunTask(runId),
        (error: unknown) => error instanceof ValidationError && error.reasonCode === "run_liveness_unknown",
      );
      assert.equal(await reconcilePersistedActiveRunTasks(), 0);
    },
  );
  const persisted = JSON.parse(await fs.readFile(path.join(runTasksDir, `${runId}.json`), "utf8")) as {
    status: string;
  };
  assert.equal(persisted.status, "working");
});

test("get_run rejects a bare v3 snapshot without mutating mailbox or output artifacts", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-stale-run-"));
  const stateDir = path.join(tmp, "state");
  const runTasksDir = path.join(stateDir, "run-tasks");
  const inputRequestsDir = path.join(stateDir, "input-requests");
  const configPath = path.join(stateDir, "config.json");
  const runsDir = path.join(stateDir, "runs");
  const runId = "2026-06-19T000000000Z-stale";
  const partialOutputPath = path.join(runsDir, `.${runId}.2026-06-19T000000000Z-recovered.partial`);
  const publishedOutputPath = path.join(runsDir, "2026-06-19T000000000Z-recovered.md");
  const inputRequestsRunDir = path.join(inputRequestsDir, runId);
  await fs.mkdir(runTasksDir, { recursive: true });
  await fs.mkdir(inputRequestsRunDir, { recursive: true });
  await fs.mkdir(runsDir, { recursive: true });
  await fs.writeFile(publishedOutputPath, "[assistant]\nPUBLIC RECOVERED PARTIAL");
  await fs.writeFile(configPath, JSON.stringify({ default_model_class: "C" }));
  await fs.writeFile(
    path.join(runTasksDir, `${runId}.json`),
    `${JSON.stringify({
      run_id: runId,
      task_id: runId,
      task_kind: "run",
      root_run_id: runId,
      recursion_depth: 0,
      child_run_ids: [],
      descendant_run_ids: [],
      descendant_terminal_statuses: {},
      status: "input_required",
      started_at: "2026-06-19T00:00:00.000Z",
      input_requests_dir: inputRequestsRunDir,
      input_requests: [],
      child_started: true,
      active_phase: "input_required",
      last_phase_at: "2026-06-19T00:00:01.000Z",
      partial_output_path: partialOutputPath,
    }, null, 2)}\n`,
  );
  const request = await createInputRequest({
    mailboxRoot: inputRequestsDir,
    runId,
    question: "This stale request should close",
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.resolve("src/server.ts")],
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
    assert.notEqual(response.isError, true, JSON.stringify(response));
    const metadata = response.structuredContent as RunSubagentMetadata;
    assert.equal(metadata.status, "rejected");
    assert.equal(metadata.reason_code, "run_liveness_unknown");
    assert.equal(await fs.readFile(publishedOutputPath, "utf8"), "[assistant]\nPUBLIC RECOVERED PARTIAL");
    await fs.stat(inputRequestsRunDir);
    assert.equal((await listInputRequests({ mailboxRoot: inputRequestsDir, runId }))[0]?.request_id, request.request_id);
  } finally {
    await client.close();
  }
});

test("restart reconciliation rejects a pre-envelope v3 descendant tree without republishing it", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-stale-tree-"));
  const runTasksDir = path.join(tmp, "run-tasks");
  const inputRequestsDir = path.join(tmp, "input-requests");
  const rootRunId = "stale-tree-root";
  const childRunId = "stale-tree-child";
  await fs.mkdir(runTasksDir, { recursive: true });
  for (const runId of [rootRunId, childRunId]) {
    const inputDir = path.join(inputRequestsDir, runId);
    await fs.mkdir(inputDir, { recursive: true });
    await fs.writeFile(path.join(runTasksDir, `${runId}.json`), `${JSON.stringify({
      contract_name: "subagent007.durable_run",
      contract_version: 3,
      run_id: runId,
      task_id: runId,
      task_kind: "run",
      ...(runId === childRunId ? { parent_run_id: rootRunId } : {}),
      root_run_id: rootRunId,
      recursion_depth: runId === childRunId ? 1 : 0,
      child_run_ids: runId === rootRunId ? [childRunId] : [],
      descendant_run_ids: runId === rootRunId ? [childRunId] : [],
      descendant_terminal_statuses: {},
      status: "working",
      started_at: "2026-06-19T00:00:00.000Z",
      input_requests_dir: inputDir,
      input_requests: [],
      child_started: true,
      active_phase: "running_silent",
      last_phase_at: "2026-06-19T00:00:01.000Z",
    }, null, 2)}\n`);
  }
  await withEnv({
    SUBAGENT007_RUN_TASKS_DIR: runTasksDir,
    SUBAGENT007_INPUT_REQUESTS_DIR: inputRequestsDir,
    SUBAGENT007_FAILURE_LOG: "off",
  }, async () => {
    await assert.rejects(
      getRunTask(rootRunId),
      (error: unknown) => error instanceof ValidationError && error.reasonCode === "run_liveness_unknown",
    );
    await assert.rejects(
      getRunTask(childRunId),
      (error: unknown) => error instanceof ValidationError && error.reasonCode === "run_liveness_unknown",
    );
  });
});

test("cancel_run closes pending input requests and rejects late answers", async () => {
  await connectFakeClient(
    async (client, { projectDir }) => {
      const startedResponse = await client.callTool({
        name: "start_run",
        arguments: {
          cwd: projectDir,
          prompt: "REQUEST_INPUT_WAIT",
          timeout_ms: 6000,
        },
      });
      assert.notEqual(startedResponse.isError, true);
      const started = startedResponse.structuredContent as RunSubagentMetadata;
      const inputRequired = await waitForInputRequired(client, started.run_id);
      const request = inputRequired.input_requests.find((input) => input.status === "pending");
      assert.ok(request);

      const cancelResponse = await client.callTool({
        name: "cancel_run",
        arguments: { run_id: started.run_id },
      });
      assert.notEqual(cancelResponse.isError, true);
      const cancelled = cancelResponse.structuredContent as RunSubagentMetadata;
      assertCancellationInProgressOrSettled(cancelled);
      assert.equal(cancelled.input_requests.some((input) => input.status === "pending"), false);
      assert.equal(
        cancelled.input_requests.some((input) =>
          input.request_id === request.request_id && input.status === "closed"
        ),
        true,
      );

      const lateAnswer = await client.callTool({
        name: "answer_run_input",
        arguments: {
          run_id: started.run_id,
          request_id: request.request_id,
          answer: "late",
          response_id: "late-response-001",
        },
      });
      assert.notEqual(lateAnswer.isError, true);
      const rejected = lateAnswer.structuredContent as { kind?: string; reason_code?: string };
      assert.equal(rejected.kind, "operation_rejected");
      assert.equal(rejected.reason_code, "input_request_already_closed");

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
