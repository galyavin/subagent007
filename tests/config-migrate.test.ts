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

test("config:migrate does not rewrite unsupported legacy model pairs", async () => {
  const { configPath } = await createConfigDir();
  const original = `${JSON.stringify({
    default_model: "anthropic/claude-sonnet-4.5",
    default_thinking_level: "medium",
    extra: "preserved",
  })}\n`;
  await fs.writeFile(configPath, original, "utf8");

  const result = await runMigrate(configPath);

  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.equal(result.json.status, "unrepairable_model_class");
  assert.equal(result.json.default_model, "anthropic/claude-sonnet-4.5");
  assert.equal(result.json.default_thinking_level, "medium");
  assert.equal(result.json.allowed_model_classes, "A, B, C, D, E");
  assert.equal(await fs.readFile(configPath, "utf8"), original);
});

test("config:migrate does not rewrite retired legacy class calibrations", async () => {
  const { configPath } = await createConfigDir();
  const original = `${JSON.stringify({
    default_model: "ollama/qwen3.5:9b-mlx",
    default_thinking_level: "high",
  })}\n`;
  await fs.writeFile(configPath, original, "utf8");

  const result = await runMigrate(configPath);

  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.equal(result.json.status, "unrepairable_model_class");
  assert.equal(await fs.readFile(configPath, "utf8"), original);
});

test("config:migrate migrates legacy model and thinking defaults to model class", async () => {
  const { configPath } = await createConfigDir();
  const original = `${JSON.stringify({
    default_model: "openai-codex/gpt-5.4-mini",
    default_thinking_level: "high",
    extra: "preserved",
  }, null, 2)}\n`;
  await fs.writeFile(configPath, original, "utf8");

  const result = await runMigrate(configPath);

  assert.equal(result.ok, true);
  assert.equal(result.json.status, "migrated");
  assert.deepEqual(result.json.from, {
    default_model: "openai-codex/gpt-5.4-mini",
    default_thinking_level: "high",
  });
  assert.equal(result.json.to, "C");
  const migrated = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  assert.equal(migrated.default_model_class, "C");
  assert.equal(migrated.default_model, undefined);
  assert.equal(migrated.default_thinking_level, undefined);
  assert.equal(migrated.extra, "preserved");
});

test("config:migrate is idempotent for canonical model class configs", async () => {
  const { configPath } = await createConfigDir();
  const original = `${JSON.stringify({
    default_model_class: "C",
    extra: "preserved",
  }, null, 2)}\n`;
  await fs.writeFile(configPath, original, "utf8");

  const result = await runMigrate(configPath);

  assert.equal(result.ok, true);
  assert.equal(result.json.status, "unchanged");
  assert.equal(result.json.default_model_class, "C");
  assert.equal(await fs.readFile(configPath, "utf8"), original);
});

test("config:migrate trims otherwise canonical model class values", async () => {
  const { configPath } = await createConfigDir();
  await fs.writeFile(
    configPath,
    `${JSON.stringify({
      default_model_class: " C ",
    })}\n`,
    "utf8",
  );

  const result = await runMigrate(configPath);

  assert.equal(result.ok, true);
  assert.equal(result.json.status, "migrated");
  assert.equal(result.json.from, " C ");
  assert.equal(result.json.to, "C");
  const migrated = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  assert.equal(migrated.default_model_class, "C");
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
  assert.equal(result.json.status, "unrepairable_model_class");
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
