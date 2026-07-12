#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

function inheritedFailureLogPath() {
  const configured = process.env.SUBAGENT007_FAILURE_LOG_PATH;
  return configured && configured.trim() !== "" ? path.resolve(configured) : null;
}

function privateFailureLogFixture(suiteRoot) {
  const dir = path.join(suiteRoot, "failure-ledger");
  fs.mkdirSync(dir, { recursive: true });
  return {
    logPath: path.join(dir, "failures.jsonl"),
  };
}

function fingerprint(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    return {
      exists: true,
      size: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { exists: false, size: 0, sha256: null };
    }
    throw error;
  }
}

function terminateSuiteProcesses(suiteRoot) {
  if (process.platform === "win32") {
    return;
  }
  let output;
  try {
    output = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  } catch {
    return;
  }
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes(suiteRoot)) {
      continue;
    }
    const match = /^\s*(\d+)\s+/.exec(line);
    const pid = match ? Number(match[1]) : NaN;
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error && error.code !== "ESRCH") {
        throw error;
      }
    }
  }
}

const testFiles = process.argv.slice(2);
if (testFiles.length === 0) {
  console.error("usage: run-tests-with-ledger-guard.mjs <test files...>");
  process.exit(2);
}

const suiteTempBase = process.platform === "win32" ? os.tmpdir() : "/tmp";
const suiteRoot = fs.mkdtempSync(path.join(suiteTempBase, "s7t-"));
const inheritedLogPath = inheritedFailureLogPath();
const privateFixture = inheritedLogPath ? null : privateFailureLogFixture(suiteRoot);
const logPath = inheritedLogPath ?? privateFixture.logPath;
const suiteStateRoot = path.join(suiteRoot, "state");
const before = fingerprint(logPath);
const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--import", "tsx", ...testFiles], {
  stdio: "inherit",
  env: {
    ...process.env,
    TMPDIR: suiteRoot,
    SUBAGENT007_FAILURE_LOG_PATH: logPath,
    SUBAGENT007_RECORD_SOURCE: "test",
    SUBAGENT007_RUNS_DIR: process.env.SUBAGENT007_RUNS_DIR ?? path.join(suiteStateRoot, "runs"),
    SUBAGENT007_RUN_TASKS_DIR: process.env.SUBAGENT007_RUN_TASKS_DIR ?? path.join(suiteStateRoot, "run-tasks"),
    SUBAGENT007_INPUT_REQUESTS_DIR: process.env.SUBAGENT007_INPUT_REQUESTS_DIR ?? path.join(suiteStateRoot, "input-requests"),
    SUBAGENT007_SESSIONS_DIR: process.env.SUBAGENT007_SESSIONS_DIR ?? path.join(suiteStateRoot, "sessions"),
    SUBAGENT007_PI_RAW_SESSIONS_DIR: process.env.SUBAGENT007_PI_RAW_SESSIONS_DIR ?? path.join(suiteStateRoot, "pi-raw-sessions"),
    SUBAGENT007_MODEL_HEALTH_PATH: process.env.SUBAGENT007_MODEL_HEALTH_PATH ?? path.join(suiteStateRoot, "model-health.json"),
    SUBAGENT007_ACTIVE_CHILDREN_DIR: process.env.SUBAGENT007_ACTIVE_CHILDREN_DIR ?? path.join(suiteStateRoot, "active-children"),
    SUBAGENT007_TEMP_DIR: process.env.SUBAGENT007_TEMP_DIR ?? path.join(suiteStateRoot, "tmp"),
  },
});

child.on("exit", (code, signal) => {
  const after = fingerprint(logPath);
  let resolvedCode = code ?? 1;
  if (
    before.exists !== after.exists ||
    before.size !== after.size ||
    before.sha256 !== after.sha256
  ) {
    console.error(
      `Subagent007 failure ledger changed during tests: ${logPath}. ` +
        "Tests must use a per-test SUBAGENT007_FAILURE_LOG_PATH or disable failure logging.",
    );
    resolvedCode = 1;
  }
  terminateSuiteProcesses(suiteRoot);
  fs.rmSync(suiteRoot, { recursive: true, force: true });
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(resolvedCode);
});
