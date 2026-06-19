import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  DURABLE_RUN_CAPABILITIES,
  durableRunContractView,
} from "./durableRunContract.js";
import { SERVER_VERSION, serverBuildSha } from "./runtimeMetadata.js";

const execFileAsync = promisify(execFile);

const RUNTIME_READINESS_CONTRACT_NAME = "subagent007.runtime_readiness";
const RUNTIME_READINESS_CONTRACT_VERSION = 1;

export const SOURCE_STATE_POLICIES = ["require_clean", "allow_dirty", "allow_unknown"] as const;
type SourceStatePolicy = (typeof SOURCE_STATE_POLICIES)[number];

type RuntimeReadinessBlockClass =
  | "missing_build"
  | "stale_build"
  | "dirty_source"
  | "source_state_unknown"
  | "incompatible_contract"
  | "runtime_launch_failure";

const PUBLIC_TOOL_SURFACE = [
  "get_runtime_readiness",
  "get_run_contract",
  "list_model_classes",
  "list_allowed_models",
  "schedule_run",
  "start_run",
  "get_run",
  "answer_run_input",
  "cancel_run",
  "run_subagent",
  "start_session_run",
  "run_subagent_session",
] as const;

const RUNTIME_READINESS_CAPABILITIES = [
  "concrete_runtime_entrypoint",
  "build_availability_check",
  "stale_build_detection",
  "git_source_state_detection",
  "typed_readiness_blocks",
  "public_tool_surface_snapshot",
] as const;

interface RuntimeReadinessRequest {
  expected_contract_name?: string;
  expected_contract_version?: number;
  source_state_policy?: SourceStatePolicy;
}

export interface RuntimeReadinessOptions extends RuntimeReadinessRequest {
  projectRoot?: string;
  serverEntrypoint?: string;
  processArgv?: string[];
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  now?: Date;
}

interface RuntimeReadinessBlock {
  class: RuntimeReadinessBlockClass;
  reason_code: string;
  message: string;
  evidence?: Record<string, unknown>;
}

interface FileFact {
  path: string;
  exists: boolean;
  size_bytes?: number;
  mtime_ms?: number;
  sha256?: string;
}

interface BuildInputFact {
  path: string;
  mtime_ms: number;
}

interface GitFacts {
  available: boolean;
  source_state: "clean" | "dirty" | "unknown";
  worktree_root?: string;
  head_sha?: string;
  branch?: string;
  dirty_paths?: string[];
  unknown_reason?: string;
}

export interface RuntimeReadinessSnapshot {
  schema_version: 1;
  contract_name: typeof RUNTIME_READINESS_CONTRACT_NAME;
  contract_version: typeof RUNTIME_READINESS_CONTRACT_VERSION;
  status: "ready" | "blocked";
  ready: boolean;
  generated_at: string;
  source_state_policy: SourceStatePolicy;
  server: {
    name: "subagent007-pi";
    version: string;
    build_sha?: string;
  };
  runtime: {
    project_root: string;
    server_entrypoint: string;
    server_entrypoint_realpath?: string;
    process_argv: string[];
    node_version: string;
    platform: NodeJS.Platform;
    arch: string;
    pid: number;
  };
  contract: ReturnType<typeof durableRunContractView> & {
    expected_contract_name?: string;
    expected_contract_version?: number;
    compatible: boolean;
  };
  build: {
    dist_dir: string;
    server_entrypoint: FileFact;
    newest_build_input?: BuildInputFact;
    stale: boolean;
  };
  git: GitFacts;
  capabilities: {
    runtime_readiness: typeof RUNTIME_READINESS_CAPABILITIES;
    durable_run: typeof DURABLE_RUN_CAPABILITIES;
    public_tools: typeof PUBLIC_TOOL_SURFACE;
  };
  blocks: RuntimeReadinessBlock[];
}

function sourceStatePolicyFromInput(value: unknown): SourceStatePolicy {
  return SOURCE_STATE_POLICIES.includes(value as SourceStatePolicy)
    ? value as SourceStatePolicy
    : "require_clean";
}

function defaultProjectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function defaultServerEntrypoint(projectRoot: string, processArgv: string[]): string {
  const invoked = processArgv[1];
  return invoked && invoked.trim() !== ""
    ? path.resolve(invoked)
    : path.join(projectRoot, "dist", "server.js");
}

async function fileFact(filePath: string): Promise<FileFact> {
  try {
    const stat = await fs.stat(filePath);
    const bytes = await fs.readFile(filePath);
    return {
      path: filePath,
      exists: true,
      size_bytes: stat.size,
      mtime_ms: stat.mtimeMs,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: filePath, exists: false };
    }
    throw error;
  }
}

async function realpathIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.realpath(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function collectFiles(dir: string, predicate: (filePath: string) => boolean): Promise<string[]> {
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(fullPath, predicate);
    }
    return predicate(fullPath) ? [fullPath] : [];
  }));
  return files.flat();
}

async function newestBuildInput(projectRoot: string): Promise<BuildInputFact | undefined> {
  const srcFiles = await collectFiles(path.join(projectRoot, "src"), (filePath) => filePath.endsWith(".ts"));
  const topLevelInputs = [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.test.json",
  ].map((name) => path.join(projectRoot, name));
  const candidates = [...srcFiles, ...topLevelInputs];
  const facts = await Promise.all(candidates.map(async (filePath) => {
    try {
      const stat = await fs.stat(filePath);
      return { path: filePath, mtime_ms: stat.mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }));
  return facts
    .filter((fact): fact is BuildInputFact => fact !== undefined)
    .sort((left, right) => right.mtime_ms - left.mtime_ms)[0];
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function gitFacts(projectRoot: string): Promise<GitFacts> {
  try {
    const worktreeRoot = await git(["rev-parse", "--show-toplevel"], projectRoot);
    const [headSha, branch, porcelain] = await Promise.all([
      git(["rev-parse", "HEAD"], projectRoot),
      git(["branch", "--show-current"], projectRoot),
      git(["status", "--porcelain=v1"], projectRoot),
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

function contractCompatible(
  contract: ReturnType<typeof durableRunContractView>,
  request: RuntimeReadinessRequest,
): boolean {
  return (
    (request.expected_contract_name === undefined || request.expected_contract_name === contract.contract_name) &&
    (request.expected_contract_version === undefined || request.expected_contract_version === contract.contract_version)
  );
}

function appendContractBlock(
  blocks: RuntimeReadinessBlock[],
  contract: ReturnType<typeof durableRunContractView>,
  request: RuntimeReadinessRequest,
): void {
  if (request.expected_contract_name !== undefined && request.expected_contract_name !== contract.contract_name) {
    blocks.push({
      class: "incompatible_contract",
      reason_code: "contract_name_mismatch",
      message: "runtime durable-run contract name does not match the caller expectation",
      evidence: {
        expected_contract_name: request.expected_contract_name,
        actual_contract_name: contract.contract_name,
      },
    });
  }
  if (request.expected_contract_version !== undefined && request.expected_contract_version !== contract.contract_version) {
    blocks.push({
      class: "incompatible_contract",
      reason_code: "contract_version_mismatch",
      message: "runtime durable-run contract version does not match the caller expectation",
      evidence: {
        expected_contract_version: request.expected_contract_version,
        actual_contract_version: contract.contract_version,
      },
    });
  }
}

function appendSourceBlocks(
  blocks: RuntimeReadinessBlock[],
  facts: GitFacts,
  policy: SourceStatePolicy,
): void {
  if (facts.source_state === "dirty" && policy === "require_clean") {
    blocks.push({
      class: "dirty_source",
      reason_code: "git_worktree_dirty",
      message: "git worktree has uncommitted or untracked changes",
      evidence: {
        dirty_paths: facts.dirty_paths?.slice(0, 50) ?? [],
        dirty_path_count: facts.dirty_paths?.length ?? 0,
      },
    });
  }
  if (facts.source_state === "unknown" && policy !== "allow_unknown") {
    blocks.push({
      class: "source_state_unknown",
      reason_code: "git_state_unavailable",
      message: "git source state could not be resolved",
      evidence: {
        unknown_reason: facts.unknown_reason,
      },
    });
  }
}

export async function runtimeReadinessSnapshot(
  options: RuntimeReadinessOptions = {},
): Promise<RuntimeReadinessSnapshot> {
  const processArgv = options.processArgv ?? process.argv;
  const projectRoot = path.resolve(options.projectRoot ?? defaultProjectRoot());
  const serverEntrypoint = path.resolve(options.serverEntrypoint ?? defaultServerEntrypoint(projectRoot, processArgv));
  const policy = sourceStatePolicyFromInput(options.source_state_policy);
  const [entrypointFact, entrypointRealpath, newestInput, gitState] = await Promise.all([
    fileFact(serverEntrypoint),
    realpathIfExists(serverEntrypoint),
    newestBuildInput(projectRoot),
    gitFacts(projectRoot),
  ]);
  const contract = durableRunContractView();
  const compatible = contractCompatible(contract, options);
  const blocks: RuntimeReadinessBlock[] = [];

  if (!entrypointFact.exists) {
    blocks.push({
      class: "missing_build",
      reason_code: "server_entrypoint_missing",
      message: "Subagent007 server entrypoint is missing",
      evidence: {
        server_entrypoint: serverEntrypoint,
      },
    });
  }
  const stale =
    entrypointFact.exists &&
    newestInput !== undefined &&
    newestInput.mtime_ms > (entrypointFact.mtime_ms ?? 0) + 1000;
  if (stale) {
    blocks.push({
      class: "stale_build",
      reason_code: "build_input_newer_than_server_entrypoint",
      message: "Subagent007 build output is older than source or build inputs",
      evidence: {
        server_entrypoint_mtime_ms: entrypointFact.mtime_ms,
        newest_build_input: newestInput,
      },
    });
  }
  appendContractBlock(blocks, contract, options);
  appendSourceBlocks(blocks, gitState, policy);

  return {
    schema_version: 1,
    contract_name: RUNTIME_READINESS_CONTRACT_NAME,
    contract_version: RUNTIME_READINESS_CONTRACT_VERSION,
    status: blocks.length === 0 ? "ready" : "blocked",
    ready: blocks.length === 0,
    generated_at: (options.now ?? new Date()).toISOString(),
    source_state_policy: policy,
    server: {
      name: "subagent007-pi",
      version: SERVER_VERSION,
      ...(serverBuildSha() ? { build_sha: serverBuildSha() } : {}),
    },
    runtime: {
      project_root: projectRoot,
      server_entrypoint: serverEntrypoint,
      ...(entrypointRealpath ? { server_entrypoint_realpath: entrypointRealpath } : {}),
      process_argv: processArgv,
      node_version: options.nodeVersion ?? process.version,
      platform: options.platform ?? process.platform,
      arch: options.arch ?? os.arch(),
      pid: process.pid,
    },
    contract: {
      ...contract,
      ...(options.expected_contract_name !== undefined
        ? { expected_contract_name: options.expected_contract_name }
        : {}),
      ...(options.expected_contract_version !== undefined
        ? { expected_contract_version: options.expected_contract_version }
        : {}),
      compatible,
    },
    build: {
      dist_dir: path.join(projectRoot, "dist"),
      server_entrypoint: entrypointFact,
      ...(newestInput ? { newest_build_input: newestInput } : {}),
      stale,
    },
    git: gitState,
    capabilities: {
      runtime_readiness: RUNTIME_READINESS_CAPABILITIES,
      durable_run: DURABLE_RUN_CAPABILITIES,
      public_tools: PUBLIC_TOOL_SURFACE,
    },
    blocks,
  };
}
