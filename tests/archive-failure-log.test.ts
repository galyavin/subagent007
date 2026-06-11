import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function withArchiveFixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-archive-"));
  const logPath = path.join(tmp, "failures.jsonl");
  const env = { ...process.env, SUBAGENT007_FAILURE_LOG_PATH: logPath };
  return { tmp, logPath, archiveDir: path.join(tmp, "archives"), env };
}

async function runArchive(args: string[], env: NodeJS.ProcessEnv) {
  try {
    const result = await execFileAsync(process.execPath, ["scripts/archive-failure-log.mjs", ...args], {
      cwd: path.resolve("."),
      env,
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string; code?: number };
    return {
      ok: false,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
      code: failed.code ?? 1,
    };
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

test("archive help does not mutate the configured failure log", async () => {
  const fixture = await withArchiveFixture();
  await fs.writeFile(fixture.logPath, "kept\n", "utf8");

  const result = await runArchive(["--help"], fixture.env);

  assert.equal(result.ok, true);
  assert.match(result.stdout, /usage: node scripts\/archive-failure-log\.mjs/);
  assert.equal(await fs.readFile(fixture.logPath, "utf8"), "kept\n");
  assert.equal(await exists(fixture.archiveDir), false);
});

test("archive short help does not mutate the configured failure log", async () => {
  const fixture = await withArchiveFixture();
  await fs.writeFile(fixture.logPath, "kept\n", "utf8");

  const result = await runArchive(["-h"], fixture.env);

  assert.equal(result.ok, true);
  assert.match(result.stdout, /Show this help/);
  assert.equal(await fs.readFile(fixture.logPath, "utf8"), "kept\n");
  assert.equal(await exists(fixture.archiveDir), false);
});

test("archive invalid args do not mutate the configured failure log", async () => {
  const fixture = await withArchiveFixture();
  await fs.writeFile(fixture.logPath, "kept\n", "utf8");

  const result = await runArchive(["--unknown"], fixture.env);

  assert.equal(result.ok, false);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown argument: --unknown/);
  assert.equal(await fs.readFile(fixture.logPath, "utf8"), "kept\n");
  assert.equal(await exists(fixture.archiveDir), false);
});

test("archive no-arg invocation moves the configured failure log and writes a summary", async () => {
  const fixture = await withArchiveFixture();
  await fs.writeFile(
    fixture.logPath,
    [
      JSON.stringify({
        schema_version: 2,
        timestamp: "2026-06-10T00:00:00.000Z",
        tool: "run_subagent",
        failure_class: "timeout",
        calibration_era: "model_class_v1",
        cwd: os.tmpdir(),
        campaign_id: "campaign.archive-1",
      }),
      JSON.stringify({
        schema_version: 2,
        timestamp: "2026-06-10T00:01:00.000Z",
        tool: "start_run",
        failure_class: "nonzero_exit",
        cwd: os.tmpdir(),
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  const result = await runArchive([], fixture.env);

  assert.equal(result.ok, true);
  assert.equal(await exists(fixture.logPath), false);
  const parsed = JSON.parse(result.stdout) as {
    archived: boolean;
    archive_path: string;
    summary_path: string;
  };
  assert.equal(parsed.archived, true);
  assert.equal(path.dirname(parsed.archive_path), fixture.archiveDir);
  assert.equal(path.dirname(parsed.summary_path), fixture.archiveDir);

  const archivedText = await fs.readFile(parsed.archive_path, "utf8");
  assert.match(archivedText, /run_subagent/);
  const summary = JSON.parse(await fs.readFile(parsed.summary_path, "utf8")) as {
    total_records: number;
    by_tool: Record<string, number>;
    by_campaign_id: Record<string, number>;
    by_calibration_era: Record<string, number>;
  };
  assert.equal(summary.total_records, 2);
  assert.equal(summary.by_tool.run_subagent, 1);
  assert.equal(summary.by_tool.start_run, 1);
  assert.equal(summary.by_campaign_id["campaign.archive-1"], 1);
  assert.equal(summary.by_campaign_id.uncategorized, 1);
  assert.equal(summary.by_calibration_era.model_class_v1, 1);
  assert.equal(summary.by_calibration_era.legacy_unclassified, 1);
});

test("archive missing failure log remains a no-op success", async () => {
  const fixture = await withArchiveFixture();

  const result = await runArchive([], fixture.env);

  assert.equal(result.ok, true);
  const parsed = JSON.parse(result.stdout) as { archived: boolean; reason: string; log_path: string };
  assert.equal(parsed.archived, false);
  assert.equal(parsed.reason, "failure log does not exist");
  assert.equal(parsed.log_path, fixture.logPath);
});
