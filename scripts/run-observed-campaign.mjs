#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CAMPAIGN_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE_SCRIPT_PATH = path.join(SCRIPT_DIR, "archive-failure-log.mjs");

function usage() {
  return [
    "usage: node scripts/run-observed-campaign.mjs [options] -- <command> [args...]",
    "",
    "Runs an observed-use probe with campaign-scoped Subagent007 state paths.",
    "",
    "Options:",
    "  --campaign-id <id>       Stable campaign id. Generated when omitted.",
    "  --state-root <path>      Campaign state root. Temp directory when omitted.",
    "  --failure-log-path <path> Explicit campaign failure ledger path.",
    "  --archive                Archive the campaign failure ledger after the command.",
    "  -h, --help               Show this help.",
  ].join("\n");
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "").replace(/Z$/, "Z");
}

function generatedCampaignId() {
  return `campaign.${timestampSlug()}-${randomBytes(4).toString("hex")}`;
}

function assertCampaignId(value) {
  if (!CAMPAIGN_ID_PATTERN.test(value)) {
    throw new Error("campaign id must be 1-128 chars: letters, digits, underscores, hyphens, dots, or colons");
  }
}

function parseArgs(argv) {
  const separatorIndex = argv.indexOf("--");
  const optionArgs = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
  const command = separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1);
  const options = {
    campaignId: undefined,
    stateRoot: undefined,
    failureLogPath: undefined,
    archive: false,
    help: false,
  };

  function nextValue(index, name) {
    const value = optionArgs[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    return value;
  }

  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--archive") {
      options.archive = true;
    } else if (arg === "--campaign-id") {
      options.campaignId = nextValue(index, arg);
      index += 1;
    } else if (arg === "--state-root") {
      options.stateRoot = nextValue(index, arg);
      index += 1;
    } else if (arg === "--failure-log-path") {
      options.failureLogPath = nextValue(index, arg);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (options.help) {
    return { mode: "help" };
  }
  if (command.length === 0) {
    throw new Error("missing command; put it after --");
  }
  if (options.campaignId === undefined) {
    options.campaignId = generatedCampaignId();
  }
  assertCampaignId(options.campaignId);
  return { mode: "run", options, command };
}

function pathToken(value) {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

async function stateRootFor(campaignId, configuredRoot) {
  if (configuredRoot) {
    const resolved = path.resolve(configuredRoot);
    await fs.mkdir(resolved, { recursive: true });
    return resolved;
  }
  return fs.mkdtemp(path.join(os.tmpdir(), `subagent007-pi-${pathToken(campaignId)}-`));
}

function waitForChildExit(child) {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

function spawnAsync(command, args, options) {
  return waitForChildExit(spawn(command, args, options));
}

async function archiveFailureLog(env) {
  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, [ARCHIVE_SCRIPT_PATH], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const result = await waitForChildExit(child);
  if (result.signal || result.code !== 0) {
    return {
      ok: false,
      code: result.code,
      signal: result.signal,
      stderr,
    };
  }
  return { ok: true, result: JSON.parse(stdout) };
}

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("");
  console.error(usage());
  process.exit(2);
}

if (parsed.mode === "help") {
  console.log(usage());
  process.exit(0);
}

const stateRoot = await stateRootFor(parsed.options.campaignId, parsed.options.stateRoot);
const failureLogPath = parsed.options.failureLogPath
  ? path.resolve(parsed.options.failureLogPath)
  : path.join(stateRoot, "failures.jsonl");
await fs.mkdir(path.dirname(failureLogPath), { recursive: true });
const campaignLedgerPath = process.env.SUBAGENT007_CAMPAIGN_LEDGER_PATH
  ? path.resolve(process.env.SUBAGENT007_CAMPAIGN_LEDGER_PATH)
  : path.join(stateRoot, "campaign-ledger.jsonl");
await fs.mkdir(path.dirname(campaignLedgerPath), { recursive: true });
const statePaths = {
  failureLogPath,
  campaignLedgerPath,
  runsDir: path.join(stateRoot, "runs"),
  runTasksDir: path.join(stateRoot, "run-tasks"),
  inputRequestsDir: path.join(stateRoot, "input-requests"),
  sessionsDir: path.join(stateRoot, "sessions"),
  piRawSessionsDir: path.join(stateRoot, "pi-raw-sessions"),
  modelHealthPath: path.join(stateRoot, "model-health.json"),
};

const campaignEnv = {
  ...process.env,
  SUBAGENT007_CAMPAIGN_ID: parsed.options.campaignId,
  SUBAGENT007_FAILURE_LOG_PATH: statePaths.failureLogPath,
  SUBAGENT007_CAMPAIGN_LEDGER_PATH: statePaths.campaignLedgerPath,
  SUBAGENT007_RUNS_DIR: statePaths.runsDir,
  SUBAGENT007_RUN_TASKS_DIR: statePaths.runTasksDir,
  SUBAGENT007_INPUT_REQUESTS_DIR: statePaths.inputRequestsDir,
  SUBAGENT007_SESSIONS_DIR: statePaths.sessionsDir,
  SUBAGENT007_PI_RAW_SESSIONS_DIR: statePaths.piRawSessionsDir,
  SUBAGENT007_MODEL_HEALTH_PATH: statePaths.modelHealthPath,
};

const [command, ...args] = parsed.command;
const childResult = await spawnAsync(command, args, {
  cwd: process.cwd(),
  env: campaignEnv,
  stdio: "inherit",
});

let archive = null;
if (parsed.options.archive) {
  archive = await archiveFailureLog(campaignEnv);
}

console.log(JSON.stringify(
  {
    campaign_id: parsed.options.campaignId,
    evidence_class: "campaign-scoped",
    state_root: stateRoot,
    failure_log_path: statePaths.failureLogPath,
    campaign_ledger_path: statePaths.campaignLedgerPath,
    runs_dir: statePaths.runsDir,
    run_tasks_dir: statePaths.runTasksDir,
    input_requests_dir: statePaths.inputRequestsDir,
    sessions_dir: statePaths.sessionsDir,
    pi_raw_sessions_dir: statePaths.piRawSessionsDir,
    model_health_path: statePaths.modelHealthPath,
    archive,
    command_exit_code: childResult.code,
    command_signal: childResult.signal,
  },
  null,
  2,
));

if (childResult.signal) {
  process.kill(process.pid, childResult.signal);
} else {
  process.exit(childResult.code ?? 1);
}
