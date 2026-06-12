import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runProbe(
  args: string[],
  env: Record<string, string> = {},
): Promise<{
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const result = await execFileAsync(process.execPath, ["scripts/probe-model-health.mjs", ...args], {
      cwd: path.resolve("."),
      env: { ...process.env, ...env },
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

test("model-health probe rejects unsupported model classes", async () => {
  const result = await runProbe(["--model-class", "Z", "--record-status", "healthy"]);

  assert.equal(result.ok, false);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--model-class must be one of: A, B, C, D, E/);
});

test("model-health probe can record a healthy class without running a child", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-model-health-probe-"));
  const healthPath = path.join(dir, "model-health.json");
  const result = await runProbe(
    ["--model-class", "C", "--record-status", "healthy", "--latency-ms", "123"],
    { SUBAGENT007_MODEL_HEALTH_PATH: healthPath },
  );

  assert.equal(result.ok, true);
  const parsed = JSON.parse(result.stdout) as {
    record: {
      model_class: string;
      resolved_model: string;
      usable_for_one_shot: boolean;
      last_success_latency_ms?: number;
    };
  };
  assert.equal(parsed.record.model_class, "C");
  assert.equal(parsed.record.resolved_model, "openrouter/deepseek/deepseek-v4-pro");
  assert.equal(parsed.record.usable_for_one_shot, true);
  assert.equal(parsed.record.last_success_latency_ms, 123);

  const records = JSON.parse(await fs.readFile(healthPath, "utf8")) as Array<{
    model_class: string;
    usable_for_one_shot: boolean;
  }>;
  assert.equal(records.length, 1);
  assert.equal(records[0].model_class, "C");
  assert.equal(records[0].usable_for_one_shot, true);
});
