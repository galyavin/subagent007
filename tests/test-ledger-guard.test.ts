import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GUARD_SCRIPT = path.resolve("scripts/run-tests-with-ledger-guard.mjs");

async function writeChildTest(dir: string, body: string): Promise<string> {
  const testPath = path.join(dir, "child.test.mjs");
  await fs.writeFile(testPath, body, "utf8");
  return testPath;
}

async function runGuard(
  testPath: string,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [GUARD_SCRIPT, testPath], {
      cwd: path.resolve("."),
      env,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string; code?: number };
    return {
      ok: false,
      code: failed.code ?? 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

function envWithoutInheritedFailureLog(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = nestedCliEnv(extra);
  delete env.SUBAGENT007_FAILURE_LOG_PATH;
  delete env.SUBAGENT007_RUNS_DIR;
  delete env.SUBAGENT007_RUN_TASKS_DIR;
  delete env.SUBAGENT007_INPUT_REQUESTS_DIR;
  delete env.SUBAGENT007_SESSIONS_DIR;
  delete env.SUBAGENT007_PI_RAW_SESSIONS_DIR;
  delete env.SUBAGENT007_MODEL_HEALTH_PATH;
  delete env.SUBAGENT007_ACTIVE_CHILDREN_DIR;
  return env;
}

function nestedCliEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  removeNodeTestEnv(env);
  return env;
}

function removeNodeTestEnv(env: NodeJS.ProcessEnv): void {
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

test("ledger guard gives child tests a private failure ledger when none is inherited", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-ledger-guard-"));
  const capturePath = path.join(dir, "capture.json");
  const childTest = await writeChildTest(
    dir,
    [
      "import test from 'node:test';",
      "import fs from 'node:fs';",
      "test('capture env', () => {",
      "  fs.writeFileSync(process.env.CAPTURE_ENV_PATH, JSON.stringify({",
      "    failureLogPath: process.env.SUBAGENT007_FAILURE_LOG_PATH ?? null,",
      "    tmpDir: process.env.TMPDIR ?? null,",
      "    runsDir: process.env.SUBAGENT007_RUNS_DIR ?? null,",
      "    runTasksDir: process.env.SUBAGENT007_RUN_TASKS_DIR ?? null,",
      "    recordSource: process.env.SUBAGENT007_RECORD_SOURCE ?? null,",
      "  }));",
      "});",
      "",
    ].join("\n"),
  );

  const result = await runGuard(childTest, envWithoutInheritedFailureLog({ CAPTURE_ENV_PATH: capturePath }));

  assert.equal(result.ok, true);
  const captured = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
    failureLogPath: string | null;
    tmpDir: string | null;
    runsDir: string | null;
    runTasksDir: string | null;
    recordSource: string | null;
  };
  assert.equal(captured.recordSource, "test");
  const failureLogPath = captured.failureLogPath;
  if (failureLogPath === null) {
    assert.fail("expected guard to pass a private failure ledger path");
  }
  assert.equal(path.isAbsolute(failureLogPath), true);
  assert.match(failureLogPath, /s7t-.*failure-ledger/);
  assert.match(captured.tmpDir ?? "", /s7t-/);
  assert.equal(captured.runsDir?.startsWith(captured.tmpDir ?? ""), true);
  assert.equal(captured.runTasksDir?.startsWith(captured.tmpDir ?? ""), true);
  await assert.rejects(fs.stat(captured.tmpDir ?? ""), { code: "ENOENT" });
  assert.notEqual(
    failureLogPath,
    path.join(os.homedir(), ".codex", "subagent007-pi", "failures.jsonl"),
  );
});

test("ledger guard preserves an explicit inherited failure ledger path", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-ledger-guard-explicit-"));
  const capturePath = path.join(dir, "capture.json");
  const logPath = path.join(dir, "explicit", "failures.jsonl");
  const childTest = await writeChildTest(
    dir,
    [
      "import test from 'node:test';",
      "import fs from 'node:fs';",
      "test('capture explicit env', () => {",
      "  fs.writeFileSync(process.env.CAPTURE_ENV_PATH, JSON.stringify({",
      "    failureLogPath: process.env.SUBAGENT007_FAILURE_LOG_PATH ?? null,",
      "  }));",
      "});",
      "",
    ].join("\n"),
  );

  const result = await runGuard(childTest, nestedCliEnv({
    CAPTURE_ENV_PATH: capturePath,
    SUBAGENT007_FAILURE_LOG_PATH: logPath,
  }));

  assert.equal(result.ok, true);
  const captured = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
    failureLogPath: string | null;
  };
  assert.equal(captured.failureLogPath, logPath);
});

test("ledger guard still fails when child tests mutate the guarded ledger", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-ledger-guard-mutating-"));
  const capturePath = path.join(dir, "tmpdir.txt");
  const childTest = await writeChildTest(
    dir,
    [
      "import test from 'node:test';",
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "test('mutate guarded ledger', () => {",
      "  const logPath = process.env.SUBAGENT007_FAILURE_LOG_PATH;",
      "  fs.writeFileSync(process.env.CAPTURE_ENV_PATH, process.env.TMPDIR);",
      "  fs.mkdirSync(path.dirname(logPath), { recursive: true });",
      "  fs.appendFileSync(logPath, 'mutation\\n');",
      "});",
      "",
    ].join("\n"),
  );

  const result = await runGuard(childTest, envWithoutInheritedFailureLog({ CAPTURE_ENV_PATH: capturePath }));

  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Subagent007 failure ledger changed during tests:/);
  await assert.rejects(fs.stat(await fs.readFile(capturePath, "utf8")), /ENOENT/);
});

test("ledger guard kills detached processes owned by its suite root", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-ledger-guard-process-"));
  const pidPath = path.join(dir, "detached.pid");
  const childTest = await writeChildTest(
    dir,
    [
      "import test from 'node:test';",
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { spawn } from 'node:child_process';",
      "test('spawn detached suite process', () => {",
      "  const script = path.join(process.env.TMPDIR, 'detached-suite-child.cjs');",
      "  fs.writeFileSync(script, 'setInterval(() => {}, 1000);\\n');",
      "  const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' });",
      "  child.unref();",
      "  fs.writeFileSync(process.env.CAPTURE_PID_PATH, String(child.pid));",
      "});",
      "",
    ].join("\n"),
  );

  const result = await runGuard(childTest, envWithoutInheritedFailureLog({ CAPTURE_PID_PATH: pidPath }));

  assert.equal(result.ok, true);
  const pid = Number(await fs.readFile(pidPath, "utf8"));
  assert.equal(Number.isInteger(pid), true);
  assert.equal(processExists(pid), false);
});

test("ledger guard removes immutable owner artifacts from its private suite root", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-ledger-guard-immutable-"));
  const capturePath = path.join(dir, "tmpdir.txt");
  const childTest = await writeChildTest(
    dir,
    [
      "import test from 'node:test';",
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "test('create immutable owner artifact', () => {",
      "  const root = path.join(process.env.TMPDIR, 'immutable-snapshot', 'runtime');",
      "  fs.mkdirSync(root, { recursive: true });",
      "  fs.writeFileSync(path.join(root, 'SKILL.md'), 'settled');",
      "  fs.chmodSync(path.join(root, 'SKILL.md'), 0o444);",
      "  fs.chmodSync(root, 0o555);",
      "  fs.writeFileSync(process.env.CAPTURE_ENV_PATH, process.env.TMPDIR);",
      "});",
      "",
    ].join("\n"),
  );

  const result = await runGuard(childTest, envWithoutInheritedFailureLog({ CAPTURE_ENV_PATH: capturePath }));

  assert.equal(result.ok, true, result.stderr);
  await assert.rejects(fs.stat(await fs.readFile(capturePath, "utf8")), { code: "ENOENT" });
});
