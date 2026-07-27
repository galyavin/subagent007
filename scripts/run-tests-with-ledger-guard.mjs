#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const STATE_PATHS = {
  SUBAGENT007_CONFIG_PATH: ["config.json"],
  SUBAGENT007_FAILURE_LOG_PATH: null,
  SUBAGENT007_RUNS_DIR: ["state", "runs"],
  SUBAGENT007_RUN_TASKS_DIR: ["state", "run-tasks"],
  SUBAGENT007_INPUT_REQUESTS_DIR: ["state", "input-requests"],
  SUBAGENT007_SESSIONS_DIR: ["state", "sessions"],
  SUBAGENT007_PI_RAW_SESSIONS_DIR: ["state", "pi-raw-sessions"],
  SUBAGENT007_MODEL_HEALTH_PATH: ["state", "model-health.json"],
  SUBAGENT007_ACTIVE_CHILDREN_DIR: ["state", "active-children"],
  SUBAGENT007_QUEUED_RUNS_DIR: ["state", "queued-runs"],
  SUBAGENT007_SKILL_SNAPSHOTS_DIR: ["state", "skill-snapshots"],
  SUBAGENT007_TEMP_DIR: ["state", "tmp"],
  SUBAGENT007_CAMPAIGN_LEDGER_PATH: null,
};
const STATE_KEYS = Object.keys(STATE_PATHS);
const contexts = new Set();
const tempBase = process.platform === "win32" ? os.tmpdir() : "/tmp";
let stopping = false;
let signalReceived = null;
let releaseTimingGate = () => {};
function fail(message) {
  console.error(message);
  process.exit(2);
}
function workers() {
  const raw = process.env.SUBAGENT007_TEST_WORKERS;
  if (raw !== undefined) {
    if (!/^[1-9]\d*$/.test(raw.trim()) || !Number.isSafeInteger(Number(raw))) {
      fail(`SUBAGENT007_TEST_WORKERS must be a positive safe integer; received ${JSON.stringify(raw)}`);
    }
    return Number(raw);
  }
  const available = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.min(6, Math.max(1, available - 2));
}
function fingerprint(file) {
  try {
    const bytes = fs.readFileSync(file);
    return { exists: true, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, size: 0, sha256: null };
    throw error;
  }
}
function changed(before, after) {
  return before.exists !== after.exists || before.size !== after.size || before.sha256 !== after.sha256;
}
function killOwned(root) {
  if (process.platform === "win32") return;
  let output = "";
  try {
    output = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  } catch {
    return;
  }
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes(root)) continue;
    const pid = Number(/^\s*(\d+)\s+/.exec(line)?.[1]);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}
function makeRemovable(target) {
  let entry;
  try {
    entry = fs.lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (entry.isSymbolicLink()) return;
  if (!entry.isDirectory()) {
    fs.chmodSync(target, 0o644);
    return;
  }
  fs.chmodSync(target, 0o755);
  for (const name of fs.readdirSync(target)) makeRemovable(path.join(target, name));
}
function cleanup(context) {
  if (context.cleaned) return;
  killOwned(context.root);
  makeRemovable(context.root);
  fs.rmSync(context.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  context.cleaned = true;
  contexts.delete(context);
}
function privateContext() {
  const root = fs.mkdtempSync(path.join(tempBase, "s7t-"));
  const privateLog = path.join(root, "failure-ledger", "failures.jsonl");
  fs.mkdirSync(path.dirname(privateLog), { recursive: true });
  const log = process.env.SUBAGENT007_FAILURE_LOG_PATH?.trim() ? path.resolve(process.env.SUBAGENT007_FAILURE_LOG_PATH) : privateLog;
  const env = { ...process.env, TMPDIR: root, SUBAGENT007_FAILURE_LOG_PATH: log, SUBAGENT007_RECORD_SOURCE: "test" };
  for (const [key, parts] of Object.entries(STATE_PATHS)) {
    if (parts && !env[key]?.trim()) env[key] = path.join(root, ...parts);
  }
  const context = { root, log, before: null, env, child: null, cleaned: false };
  contexts.add(context);
  try {
    context.before = fingerprint(log);
    return context;
  } catch (error) {
    cleanup(context);
    throw error;
  }
}
function elapsed(started) {
  return Number(process.hrtime.bigint() - started) / 1e6;
}
function targetName(target) {
  return target.name ? `${target.file} :: ${target.name}` : target.file;
}
function show(result) {
  const name = targetName(result.target);
  console.error(`[subagent007-tests] ${result.ok ? "PASS" : "FAIL"} ${name} (${result.ms.toFixed(1)} ms)`);
  if (result.stdout) process.stdout.write(`[subagent007-tests] ${name} stdout\n${result.stdout}${result.stdout.endsWith("\n") ? "" : "\n"}`);
  if (result.stderr) process.stderr.write(`[subagent007-tests] ${name} stderr\n${result.stderr}${result.stderr.endsWith("\n") ? "" : "\n"}`);
  if (result.ledgerChanged) console.error(`Subagent007 failure ledger changed during tests: ${result.log}. Tests must use a per-test SUBAGENT007_FAILURE_LOG_PATH or disable failure logging.`);
  if (result.message) console.error(`[subagent007-tests] ${name}: ${result.message}`);
}
async function runTarget(target) {
  const started = process.hrtime.bigint();
  let context;
  let result;
  try {
    context = privateContext();
    result = await new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let spawnError = null;
      const args = ["--test", "--test-concurrency=1", "--import", "tsx"];
      if (target.pattern) args.push(`--test-name-pattern=${target.pattern}`);
      if (target.skipPattern) args.push(`--test-skip-pattern=${target.skipPattern}`);
      args.push(target.file);
      const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env: context.env });
      context.child = child;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", (error) => { spawnError = error; });
      child.once("close", (code, childSignal) => {
        context.child = null;
        let ledgerChanged = false;
        let ledgerError = null;
        try {
          ledgerChanged = changed(context.before, fingerprint(context.log));
        } catch (error) {
          ledgerError = error;
        }
        const message = ledgerError ? `could not fingerprint failure ledger: ${ledgerError.message}`
          : spawnError ? `could not start child: ${spawnError.message}`
            : childSignal ? `child terminated by ${childSignal}`
              : code === 0 ? null : `child exited with code ${code ?? "unknown"}`;
        resolve({ target, stdout, stderr, log: context.log, ledgerChanged, message, ok: !message && !ledgerChanged });
      });
    });
  } catch (error) {
    result = { target, stdout: "", stderr: "", log: context?.log, ledgerChanged: false, message: error.message, ok: false };
  } finally {
    if (context) {
      try {
        cleanup(context);
      } catch (error) {
        result = { ...(result ?? { target, stdout: "", stderr: "", log: context.log, ledgerChanged: false }), message: `cleanup failed: ${error.message}`, ok: false };
      }
    }
  }
  result.ms = elapsed(started);
  show(result);
  return result;
}
function target(file, name, pattern, skipPattern) {
  return { file, name, pattern, skipPattern };
}
function expand(files, split) {
  const pool = [];
  const timing = [];
  for (const file of files) {
    const base = path.basename(file);
    if (!split) {
      pool.push(target(file));
      continue;
    }
    if (base === "run-subagent.test.ts") {
      pool.push(
        target(file, "core execution and effect profile integration", "^core execution and effect profile integration$"),
        target(file, "MCP public tool integration", "^MCP public tool integration$", "^MCP run_subagent timeout returns async recovery guidance$"),
        target(file, "MCP input and session integration", "^MCP input and session integration$"),
        target(file, "persisted run readback integration", "^persisted run readback integration$"),
      );
      timing.push(
        target(file, "owner-loss and lifecycle integration", "^owner-loss and lifecycle integration$"),
        target(file, "run owner state integration", "^run owner state integration$"),
        target(file, "MCP run_subagent timeout returns async recovery guidance", "^MCP run_subagent timeout returns async recovery guidance$"),
      );
    } else if (base === "observed-campaign.test.ts") {
      const full = "observed MCP probe full-current covers all deterministic current surfaces";
      pool.push(
        target(file, "full-current", `^${full}$`),
        target(file, "remainder", undefined, `^${full}$`),
      );
    } else if (base === "client-start-id.test.ts") {
      const suites = [
        "live client-start admission",
        "client-start restart and replay integration",
        "invalid client-start owner bindings",
        "recoverable client-start publication faults",
      ];
      pool.push(
        ...suites.map((suite) => target(file, suite, `^${suite}$`)),
        target(file, "remainder", undefined, `^(?:${suites.join("|")})$`),
      );
    } else {
      pool.push(target(file));
    }
  }
  return { pool, timing };
}
function takeChains(pool) {
  const specs = [
    [['observed-campaign.test.ts', 'full-current'], ['client-start-id.test.ts', 'live client-start admission']],
    [['run-subagent.test.ts', 'core execution and effect profile integration'], ['run-subagent.test.ts', 'MCP public tool integration']],
  ];
  return specs.map((spec) => spec.map(([file, name]) => {
    const index = pool.findIndex((entry) => path.basename(entry.file) === file && entry.name === name);
    return index < 0 ? null : pool.splice(index, 1)[0];
  }).filter(Boolean)).filter((chain) => chain.length);
}
function stop(signal) {
  if (stopping) return;
  stopping = true;
  releaseTimingGate();
  signalReceived = signal;
  for (const context of contexts) {
    try {
      context.child?.kill(signal);
    } catch {
      // The per-target cleanup scan removes any remaining owned descendant.
    }
  }
}
const files = process.argv.slice(2);
if (files.length === 0) fail("usage: run-tests-with-ledger-guard.mjs <test files...>");
const shared = STATE_KEYS.filter((key) => process.env[key]?.trim());
const requested = workers();
const { pool, timing } = expand(files, shared.length === 0);
const chains = shared.length ? [] : takeChains(pool);
const normalTargetTotal = pool.length + chains.reduce((count, chain) => count + chain.length, 0);
const workerCount = shared.length ? 1 : Math.min(requested, 6, normalTargetTotal);
const timingWorkers = Math.min(2, timing.length, workerCount);
const normalActiveLimit = Math.max(0, Math.min(4, workerCount) - timingWorkers);
let normalStarted = 0;
let normalActive = 0;
const timingGate = new Promise((resolve) => {
  releaseTimingGate = resolve;
});
function maybeOpenTimingGate() {
  if (stopping || (normalStarted === normalTargetTotal && normalActive <= normalActiveLimit)) releaseTimingGate();
}
function stopForFailure() {
  stopping = true;
  releaseTimingGate();
}
const started = process.hrtime.bigint();
const results = [];
if (shared.length) console.error(`[subagent007-tests] Shared state/failure override(s) supplied (${shared.join(", ")}); forcing one worker without semantic splitting.`);
console.error(`[subagent007-tests] ${normalTargetTotal + timing.length} target(s), ${workerCount} worker(s) (requested ${requested})`);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => stop(signal));
process.on("exit", () => {
  for (const context of [...contexts]) {
    try { cleanup(context); } catch { /* no asynchronous recovery during exit */ }
  }
});
async function runNormalTarget(current) {
  normalStarted += 1;
  normalActive += 1;
  try {
    const result = await runTarget(current);
    if (!result.ok) stopForFailure();
    return result;
  } catch (error) {
    stopForFailure();
    throw error;
  } finally {
    normalActive -= 1;
    maybeOpenTimingGate();
  }
}
async function runPhase(targets, limit, runner = runTarget) {
  let cursor = 0;
  async function worker() {
    while (!stopping) {
      const current = targets[cursor++];
      if (!current) return;
      const result = await runner(current);
      results.push(result);
      if (!result.ok) stopForFailure();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, targets.length) }, worker));
}
async function runChain(chain) {
  for (const current of chain) {
    if (stopping) return;
    const result = await runNormalTarget(current);
    results.push(result);
  }
}
async function runNormalPhase() {
  if (!normalTargetTotal) return;
  if (workerCount > chains.length && pool.length > 0) {
    return Promise.all([
      ...chains.map((chain) => runChain(chain)),
      runPhase(pool, Math.max(1, workerCount - chains.length), runNormalTarget),
    ]);
  }
  // With fewer slots than chains, put complete chains on lanes rather than
  // dropping the excess chains (or exceeding the requested worker count).
  const lanes = Array.from({ length: workerCount }, () => []);
  chains.forEach((chain, index) => lanes[index % workerCount].push({ chain }));
  pool.forEach((target, index) => lanes[index % workerCount].push({ target }));
  return Promise.all(lanes.map(async (lane) => {
    for (const job of lane) {
      if (stopping) return;
      if (job.chain) await runChain(job.chain);
      else {
        const result = await runNormalTarget(job.target);
        results.push(result);
      }
    }
  }));
}
async function runTimingPhase() {
  if (!timing.length) return;
  await timingGate;
  if (stopping || !timingWorkers) return;
  console.error(`[subagent007-tests] timing phase: ${timing.length} target(s), ${timingWorkers} worker(s)`);
  await runPhase(timing, timingWorkers);
}
maybeOpenTimingGate();
const normalPromise = shared.length ? runPhase(pool, workerCount, runNormalTarget) : runNormalPhase();
const timingPromise = runTimingPhase();
await Promise.all([normalPromise, timingPromise]);
for (const context of [...contexts]) {
  try { cleanup(context); } catch { /* result cleanup already records ordinary failures */ }
}
const wall = elapsed(started);
const passed = results.filter((result) => result.ok).length;
const failed = results.length - passed;
console.error(`[subagent007-tests] summary: ${passed} passed, ${failed} failed; wall ${wall.toFixed(1)} ms; workers ${workerCount}`);
for (const result of results.slice().sort((left, right) => right.ms - left.ms).slice(0, 5)) {
  console.error(`[subagent007-tests] slowest ${result.ms.toFixed(1)} ms ${targetName(result.target)}`);
}
process.exitCode = signalReceived ? 128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signalReceived] ?? 1) : failed ? 1 : 0;
