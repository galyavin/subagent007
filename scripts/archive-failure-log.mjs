#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function defaultFailureLogPath() {
  return process.env.SUBAGENT007_FAILURE_LOG_PATH
    ? path.resolve(process.env.SUBAGENT007_FAILURE_LOG_PATH)
    : path.join(os.homedir(), ".codex", "subagent007-pi", "failures.jsonl");
}

function usage() {
  return [
    "usage: node scripts/archive-failure-log.mjs",
    "",
    "Archives the configured Subagent007 failure log.",
    "",
    "Options:",
    "  -h, --help  Show this help without mutating archive state.",
  ].join("\n");
}

function parseArgs(argv) {
  if (argv.length === 0) {
    return { mode: "archive" };
  }
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { mode: "help" };
  }
  return { mode: "invalid", error: `unknown argument: ${argv.join(" ")}` };
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "");
}

function withoutPrivatePrefix(value) {
  return value.startsWith("/private/") ? value.slice("/private".length) : value;
}

function classifyCwd(cwd) {
  if (typeof cwd !== "string" || cwd.trim() === "") return "missing";
  if (!path.isAbsolute(cwd)) return "relative";
  const cwdWithoutPrivate = withoutPrivatePrefix(path.normalize(cwd));
  const tmpWithoutPrivate = withoutPrivatePrefix(path.normalize(os.tmpdir()));
  return cwdWithoutPrivate === tmpWithoutPrivate || cwdWithoutPrivate.startsWith(`${tmpWithoutPrivate}${path.sep}`)
    ? "temp"
    : "absolute";
}

function increment(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

function summarize(text) {
  const summary = {
    archived_at: new Date().toISOString(),
    total_records: 0,
    by_schema_version: {},
    by_tool: {},
    by_failure_class: {},
    by_calibration_era: {},
    by_cwd_class: {},
    by_campaign_id: {},
    by_day: {},
    parse_errors: 0,
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    summary.total_records += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      summary.parse_errors += 1;
      continue;
    }
    increment(summary.by_schema_version, String(record.schema_version ?? "missing"));
    increment(summary.by_tool, String(record.tool ?? "missing"));
    increment(summary.by_failure_class, String(record.failure_class ?? "missing"));
    increment(summary.by_calibration_era, String(record.calibration_era ?? "legacy_unclassified"));
    increment(summary.by_cwd_class, String(record.cwd_class ?? classifyCwd(record.cwd)));
    increment(summary.by_campaign_id, String(record.campaign_id ?? "uncategorized"));
    increment(summary.by_day, String(record.timestamp ?? "missing").slice(0, 10));
  }
  return summary;
}

const invocation = parseArgs(process.argv.slice(2));
if (invocation.mode === "help") {
  console.log(usage());
  process.exit(0);
}
if (invocation.mode === "invalid") {
  console.error(invocation.error);
  console.error("");
  console.error(usage());
  process.exit(2);
}

const logPath = defaultFailureLogPath();
const archiveDir = path.join(path.dirname(logPath), "archives");
const slug = timestampSlug();
const archivePath = path.join(archiveDir, `failures-${slug}.jsonl`);
const indexPath = path.join(archiveDir, `failures-${slug}.summary.json`);

try {
  await fs.mkdir(archiveDir, { recursive: true });
  await fs.rename(logPath, archivePath);
} catch (error) {
  if (error && error.code === "ENOENT") {
    console.log(JSON.stringify({ archived: false, reason: "failure log does not exist", log_path: logPath }, null, 2));
    process.exit(0);
  }
  throw error;
}

const text = await fs.readFile(archivePath, "utf8");
await fs.writeFile(indexPath, `${JSON.stringify(summarize(text), null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
});

console.log(
  JSON.stringify(
    {
      archived: true,
      log_path: logPath,
      archive_path: archivePath,
      summary_path: indexPath,
    },
    null,
    2,
  ),
);
