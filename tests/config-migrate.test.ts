import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function createConfigDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-config-migrate-"));
  return { dir, configPath: path.join(dir, "config.json") };
}

async function runMigrate(configPath: string) {
  try {
    const result = await execFileAsync(process.execPath, ["scripts/migrate-config.mjs"], {
      cwd: path.resolve("."),
      env: { ...process.env, SUBAGENT007_CONFIG_PATH: configPath },
    });
    return {
      ok: true,
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      json: JSON.parse(result.stdout) as Record<string, unknown>,
    };
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string; code?: number };
    return {
      ok: false,
      code: failed.code ?? 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
      json: JSON.parse(failed.stdout ?? "{}") as Record<string, unknown>,
    };
  }
}

test("config:migrate rewrites known stale default_model aliases to canonical refs", async () => {
  const { configPath } = await createConfigDir();
  await fs.writeFile(
    configPath,
    `${JSON.stringify({
      default_model: "anthropic/claude-sonnet-4.5",
      default_thinking_level: "medium",
      extra: "preserved",
    })}\n`,
    "utf8",
  );

  const result = await runMigrate(configPath);

  assert.equal(result.ok, true);
  assert.equal(result.json.status, "migrated");
  assert.equal(result.json.from, "anthropic/claude-sonnet-4.5");
  assert.equal(result.json.to, "openrouter/~anthropic/claude-sonnet-latest");
  const migrated = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  assert.equal(migrated.default_model, "openrouter/~anthropic/claude-sonnet-latest");
  assert.equal(migrated.default_thinking_level, "medium");
  assert.equal(migrated.extra, "preserved");
});

test("config:migrate is idempotent for canonical configs", async () => {
  const { configPath } = await createConfigDir();
  const original = `${JSON.stringify({
    default_model: "openrouter/deepseek/deepseek-v4-pro",
    default_thinking_level: "high",
  }, null, 2)}\n`;
  await fs.writeFile(configPath, original, "utf8");

  const result = await runMigrate(configPath);

  assert.equal(result.ok, true);
  assert.equal(result.json.status, "unchanged");
  assert.equal(await fs.readFile(configPath, "utf8"), original);
});

test("config:migrate trims otherwise canonical default_model values", async () => {
  const { configPath } = await createConfigDir();
  await fs.writeFile(
    configPath,
    `${JSON.stringify({
      default_model: " openrouter/deepseek/deepseek-v4-pro ",
      default_thinking_level: "medium",
    })}\n`,
    "utf8",
  );

  const result = await runMigrate(configPath);

  assert.equal(result.ok, true);
  assert.equal(result.json.status, "migrated");
  assert.equal(result.json.from, " openrouter/deepseek/deepseek-v4-pro ");
  assert.equal(result.json.to, "openrouter/deepseek/deepseek-v4-pro");
  const migrated = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  assert.equal(migrated.default_model, "openrouter/deepseek/deepseek-v4-pro");
});

test("config:migrate does not silently rewrite unsupported models", async () => {
  const { configPath } = await createConfigDir();
  const original = `${JSON.stringify({
    default_model: "openrouter/example/not-curated",
    default_thinking_level: "medium",
  })}\n`;
  await fs.writeFile(configPath, original, "utf8");

  const result = await runMigrate(configPath);

  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.equal(result.json.status, "unrepairable_model");
  assert.equal(await fs.readFile(configPath, "utf8"), original);
});

test("config:migrate reports invalid JSON without overwriting it", async () => {
  const { configPath } = await createConfigDir();
  const original = "{ invalid json\n";
  await fs.writeFile(configPath, original, "utf8");

  const result = await runMigrate(configPath);

  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.equal(result.json.status, "invalid_json");
  assert.equal(await fs.readFile(configPath, "utf8"), original);
});

test("config:migrate reports missing config as an unchanged no-op", async () => {
  const { configPath } = await createConfigDir();

  const result = await runMigrate(configPath);

  assert.equal(result.ok, true);
  assert.equal(result.json.status, "missing_config");
  await assert.rejects(fs.stat(configPath), /ENOENT/);
});
