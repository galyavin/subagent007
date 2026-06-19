#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const RUNTIME_READINESS_CONTRACT_NAME = "subagent007.runtime_readiness";
const RUNTIME_READINESS_CONTRACT_VERSION = 1;
const SOURCE_STATE_POLICIES = new Set(["require_clean", "allow_dirty", "allow_unknown"]);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const execFileAsync = promisify(execFile);

function usage() {
  return [
    "usage: node scripts/check-runtime-readiness.mjs [options]",
    "",
    "Checks the Subagent007 built server entrypoint, launches that entrypoint, then asks it for",
    "the in-process runtime/build/source/capability readiness snapshot.",
    "",
    "Options:",
    "  --server <path>                    Server entrypoint. Default: dist/server.js",
    "  --expected-contract-name <name>     Required durable-run contract name.",
    "  --expected-contract-version <n>     Required durable-run contract version.",
    "  --source-state-policy <policy>      require_clean, allow_dirty, or allow_unknown. Default: require_clean.",
    "  --timeout-ms <n>                    Launch and MCP call timeout. Default: 10000.",
    "  -h, --help                         Show this help.",
  ].join("\n");
}

function nextValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    server: path.join(PROJECT_ROOT, "dist", "server.js"),
    source_state_policy: "require_clean",
    timeout_ms: 10000,
    expected_contract_name: undefined,
    expected_contract_version: undefined,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--server") {
      options.server = path.resolve(nextValue(argv, index, arg));
      index += 1;
    } else if (arg === "--expected-contract-name") {
      options.expected_contract_name = nextValue(argv, index, arg);
      index += 1;
    } else if (arg === "--expected-contract-version") {
      const value = Number(nextValue(argv, index, arg));
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("--expected-contract-version must be a positive integer");
      }
      options.expected_contract_version = value;
      index += 1;
    } else if (arg === "--source-state-policy") {
      const value = nextValue(argv, index, arg);
      if (!SOURCE_STATE_POLICIES.has(value)) {
        throw new Error(`unknown source state policy: ${value}`);
      }
      options.source_state_policy = value;
      index += 1;
    } else if (arg === "--timeout-ms") {
      const value = Number(nextValue(argv, index, arg));
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("--timeout-ms must be a positive integer");
      }
      options.timeout_ms = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

async function fileFact(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return {
      path: filePath,
      exists: true,
      size_bytes: stat.size,
      mtime_ms: stat.mtimeMs,
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { path: filePath, exists: false };
    }
    throw error;
  }
}

async function packageVersion() {
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"));
    return typeof packageJson.version === "string" && packageJson.version.trim() !== ""
      ? packageJson.version
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function git(args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: PROJECT_ROOT,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function gitFacts() {
  try {
    const [worktreeRoot, headSha, branch, porcelain] = await Promise.all([
      git(["rev-parse", "--show-toplevel"]),
      git(["rev-parse", "HEAD"]),
      git(["branch", "--show-current"]),
      git(["status", "--porcelain=v1"]),
    ]);
    const dirtyPaths = porcelain
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean);
    return {
      available: true,
      source_state: dirtyPaths.length > 0 ? "dirty" : "clean",
      worktree_root: worktreeRoot,
      head_sha: headSha,
      ...(branch ? { branch } : {}),
      dirty_paths: dirtyPaths,
    };
  } catch (error) {
    return {
      available: false,
      source_state: "unknown",
      unknown_reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function blockedSnapshot(block, options) {
  const [version, serverEntrypoint, git] = await Promise.all([
    packageVersion(),
    fileFact(options.server),
    gitFacts(),
  ]);
  return {
    schema_version: 1,
    contract_name: RUNTIME_READINESS_CONTRACT_NAME,
    contract_version: RUNTIME_READINESS_CONTRACT_VERSION,
    status: "blocked",
    ready: false,
    generated_at: new Date().toISOString(),
    source_state_policy: options.source_state_policy,
    server: {
      name: "subagent007-pi",
      version,
    },
    runtime: {
      project_root: PROJECT_ROOT,
      server_entrypoint: options.server,
      process_argv: process.argv,
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
    },
    build: {
      dist_dir: path.join(PROJECT_ROOT, "dist"),
      server_entrypoint: serverEntrypoint,
      stale: false,
    },
    git,
    blocks: [block],
  };
}

async function assertServerExists(options) {
  try {
    const stat = await fs.stat(options.server);
    if (!stat.isFile()) {
      return await blockedSnapshot({
        class: "missing_build",
        reason_code: "server_entrypoint_not_file",
        message: "Subagent007 server entrypoint exists but is not a file",
        evidence: { server_entrypoint: options.server },
      }, options);
    }
    return null;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return await blockedSnapshot({
        class: "missing_build",
        reason_code: "server_entrypoint_missing",
        message: "Subagent007 server entrypoint is missing",
        evidence: { server_entrypoint: options.server },
      }, options);
    }
    throw error;
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function incompatibleContractSnapshot(error, options) {
  return blockedSnapshot({
    class: "incompatible_contract",
    reason_code: "runtime_readiness_tool_unavailable",
    message: "launched Subagent007 server does not expose get_runtime_readiness",
    evidence: { error: error instanceof Error ? error.message : String(error) },
  }, options);
}

function launchFailureSnapshot(error, options) {
  return blockedSnapshot({
    class: "runtime_launch_failure",
    reason_code: "mcp_runtime_launch_failed",
    message: "Subagent007 server entrypoint could not be launched for readiness probing",
    evidence: { error: error instanceof Error ? error.message : String(error) },
  }, options);
}

async function callRuntimeReadiness(options) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.server],
    env: process.env,
  });
  const client = new Client({ name: "subagent007-runtime-readiness-check", version: "0.1.0" });
  try {
    await withTimeout(client.connect(transport), options.timeout_ms, "Subagent007 MCP connect");
    const tools = await withTimeout(client.listTools(), options.timeout_ms, "Subagent007 MCP listTools");
    const toolNames = tools.tools.map((tool) => tool.name);
    if (!toolNames.includes("get_runtime_readiness")) {
      return await incompatibleContractSnapshot(new Error(`tools: ${toolNames.join(", ")}`), options);
    }
    const response = await withTimeout(
      client.callTool({
        name: "get_runtime_readiness",
        arguments: {
          expected_contract_name: options.expected_contract_name,
          expected_contract_version: options.expected_contract_version,
          source_state_policy: options.source_state_policy,
        },
      }),
      options.timeout_ms,
      "Subagent007 readiness tool call",
    );
    if (response.isError) {
      return await incompatibleContractSnapshot(new Error(JSON.stringify(response.content)), options);
    }
    return response.structuredContent;
  } catch (error) {
    return await launchFailureSnapshot(error, options);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const prelaunchBlock = await assertServerExists(options);
  const snapshot = prelaunchBlock ?? await callRuntimeReadiness(options);
  console.log(JSON.stringify(snapshot, null, 2));
  return snapshot?.ready === true ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
