#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function defaultFailureLogPath() {
  return process.env.SUBAGENT007_FAILURE_LOG_PATH
    ? path.resolve(process.env.SUBAGENT007_FAILURE_LOG_PATH)
    : path.join(os.homedir(), ".codex", "subagent007-pi", "failures.jsonl");
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

const testFiles = process.argv.slice(2);
if (testFiles.length === 0) {
  console.error("usage: run-tests-with-ledger-guard.mjs <test files...>");
  process.exit(2);
}

const logPath = defaultFailureLogPath();
const before = fingerprint(logPath);
const child = spawn(process.execPath, ["--test", "--import", "tsx", ...testFiles], {
  stdio: "inherit",
  env: {
    ...process.env,
    SUBAGENT007_RECORD_SOURCE: "test",
  },
});

child.on("exit", (code, signal) => {
  const after = fingerprint(logPath);
  if (
    before.exists !== after.exists ||
    before.size !== after.size ||
    before.sha256 !== after.sha256
  ) {
    console.error(
      `Default Subagent007 failure ledger changed during tests: ${logPath}. ` +
        "Tests must use a private SUBAGENT007_FAILURE_LOG_PATH or disable failure logging.",
    );
    process.exit(1);
  }
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
