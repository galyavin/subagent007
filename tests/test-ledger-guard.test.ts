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
    recordSource: string | null;
  };
  assert.equal(captured.recordSource, "test");
  const failureLogPath = captured.failureLogPath;
  if (failureLogPath === null) {
    assert.fail("expected guard to pass a private failure ledger path");
  }
  assert.equal(path.isAbsolute(failureLogPath), true);
  assert.match(failureLogPath, /subagent007-pi-test-ledger-/);
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
  const childTest = await writeChildTest(
    dir,
    [
      "import test from 'node:test';",
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "test('mutate guarded ledger', () => {",
      "  const logPath = process.env.SUBAGENT007_FAILURE_LOG_PATH;",
      "  fs.mkdirSync(path.dirname(logPath), { recursive: true });",
      "  fs.appendFileSync(logPath, 'mutation\\n');",
      "});",
      "",
    ].join("\n"),
  );

  const result = await runGuard(childTest, envWithoutInheritedFailureLog({}));

  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Subagent007 failure ledger changed during tests:/);
});
