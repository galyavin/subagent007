import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  AuthoringEffectScopeBinding,
  EffectProfile,
  ResearchControllerTerminalReceipt,
} from "./types.js";
import { assertAuthoringEffectScopeBinding, assertAuthoringWritableClosure } from "./authoringEffectScope.js";
import { stripAnsiAndControls } from "./output.js";

const execFileAsync = promisify(execFile);

export const BOUNDED_CONTROLLER_TOOL_NAMES = ["researchctl", "aj_switchboard"] as const;
export type BoundedControllerToolName = (typeof BOUNDED_CONTROLLER_TOOL_NAMES)[number];

const RESEARCH_MODEL_COMMANDS = [
  "state-paths",
  "init",
  "plan",
  "advance",
  "start-attempt",
  "finish-attempt",
  "add-evidence",
  "assess-question",
  "set-finding",
  "close",
  "validate",
  "status",
  "render",
] as const;
const RESEARCH_DISPATCH_COMMANDS = [
  "claim-dispatch",
  "record-dispatch-result",
] as const;
export type ResearchDispatchControllerCommand = (typeof RESEARCH_DISPATCH_COMMANDS)[number];
const AJ_COMMANDS = ["gate", "anchors", "reconcile", "triage", "validate", "emit", "run"] as const;
const AJ_RUN_COMMANDS = ["init", "next", "commit", "status", "check"] as const;

export const BOUNDED_CONTROLLER_COMMANDS = {
  researchctl: RESEARCH_MODEL_COMMANDS,
  aj_switchboard: AJ_COMMANDS,
} as const;

const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_CHARS = 4096;
const MAX_STDOUT_BYTES = 128 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_JSON_BYTES = 512 * 1024;
export const BOUNDED_CONTROLLER_TIMEOUT_MS = 2_000;
const PATH_OPTIONS = new Set([
  "--input",
  "--root",
  "--target",
  "--user",
  "--session",
  "--receipt-file",
  "--ledger",
  "--triage",
  "--reconcile",
  "--artifact",
  "--pass2",
  "--pass3",
  "--mediation-receipt",
]);
const JSON_PATH_OPTIONS = new Set(["--input", "--ledger", "--triage", "--reconcile"]);

export type BoundedControllerEffectProfile = Extract<
  EffectProfile,
  "researcher_bounded_v1" | "assumption_audit_bounded_v1"
>;

export interface ResolvedBoundedControllerPython {
  realpath: string;
  file_sha256: string;
}

export interface ResearchControllerStatePaths {
  schema_version: 1;
  job_path: string;
  input_root: string;
}

interface ResearchControllerInitDirectories {
  stateRoot: {
    path: string;
    realpath: string;
    device: string;
    inode: string;
  };
  inputRoot: {
    path: string;
    realpath: string;
    device: string;
    inode: string;
  };
}

export class BoundedControllerExecutionQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

const CONTROLLER_RUNTIME_IMPORTS: Record<BoundedControllerEffectProfile, readonly string[]> = {
  // Both controllers require a usable Python standard library. AJ additionally
  // owns PyYAML as a fixed runtime dependency; prompts never decide this.
  researcher_bounded_v1: ["json"],
  assumption_audit_bounded_v1: ["json", "yaml"],
};
const PYTHON_CAPABILITY_PROBE_TIMEOUT_MS = 1_000;
const PYTHON_CAPABILITY_PROBE_MAX_BUFFER = 4 * 1024;

export function boundedControllerRuntimeImports(effectProfile: BoundedControllerEffectProfile): readonly string[] {
  return CONTROLLER_RUNTIME_IMPORTS[effectProfile];
}

function pythonSearchPath(): string[] {
  return (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")
    .split(path.delimiter)
    .map((entry) => entry || process.cwd());
}

async function pythonFileSha256(filePath: string): Promise<string> {
  return (await import("node:crypto")).createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function capabilityProbeProgram(imports: readonly string[]): string {
  return [
    "import importlib",
    `for name in ${JSON.stringify(imports)}:`,
    "    importlib.import_module(name)",
  ].join("\n");
}

async function hasControllerRuntimeImports(
  realpath: string,
  effectProfile: BoundedControllerEffectProfile,
): Promise<boolean> {
  try {
    await execFileAsync(realpath, ["-c", capabilityProbeProgram(boundedControllerRuntimeImports(effectProfile))], {
      env: envForController(),
      shell: false,
      timeout: PYTHON_CAPABILITY_PROBE_TIMEOUT_MS,
      maxBuffer: PYTHON_CAPABILITY_PROBE_MAX_BUFFER,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function capabilityDescription(effectProfile: BoundedControllerEffectProfile): string {
  return boundedControllerRuntimeImports(effectProfile).join(", ");
}

/**
 * Resolves one capable controller interpreter at parent admission. Discovery is
 * PATH-ordered only here; execution always uses the returned bound realpath.
 */
export async function resolveBoundedControllerPython(
  effectProfile: BoundedControllerEffectProfile,
): Promise<ResolvedBoundedControllerPython> {
  const seenRealpaths = new Set<string>();
  for (const directory of pythonSearchPath()) {
    const candidate = path.resolve(directory, "python3");
    try {
      const realpath = await fs.realpath(candidate);
      if (seenRealpaths.has(realpath)) continue;
      seenRealpaths.add(realpath);
      const stat = await fs.stat(realpath);
      if (!stat.isFile() || (stat.mode & 0o111) === 0) continue;
      const binding = { realpath, file_sha256: await pythonFileSha256(realpath) };
      try {
        await assertResolvedBoundedControllerPython(binding, effectProfile);
        return binding;
      } catch {
        // An unusable or changed candidate is never admitted; later PATH
        // candidates remain deterministic fallback choices.
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") continue;
      throw error;
    }
  }
  throw new Error(
    `no capable python3 interpreter is available for ${effectProfile}; required imports: ${capabilityDescription(effectProfile)}`,
  );
}

/** Rechecks the parent-bound real executable, byte identity, and fixed profile imports without claiming hostile-environment containment. */
export async function assertResolvedBoundedControllerPython(
  value: ResolvedBoundedControllerPython | undefined,
  effectProfile: BoundedControllerEffectProfile,
): Promise<ResolvedBoundedControllerPython> {
  if (!value || !path.isAbsolute(value.realpath) || !/^[0-9a-f]{64}$/u.test(value.file_sha256)) {
    throw new Error("bounded controller resolved Python binding is invalid");
  }
  const assertExactIdentity = async (): Promise<void> => {
    const realpath = await fs.realpath(value.realpath);
    const stat = await fs.stat(realpath);
    if (!stat.isFile() || (stat.mode & 0o111) === 0 || realpath !== value.realpath) {
      throw new Error("bounded controller resolved Python path changed");
    }
    if (await pythonFileSha256(realpath) !== value.file_sha256) {
      throw new Error("bounded controller resolved Python identity changed");
    }
  };
  await assertExactIdentity();
  if (!await hasControllerRuntimeImports(value.realpath, effectProfile)) {
    throw new Error(
      `bounded controller resolved Python cannot import required ${effectProfile} runtime dependencies: ${capabilityDescription(effectProfile)}`,
    );
  }
  // The probe itself executes external bytes, so bind them again after it.
  await assertExactIdentity();
  return value;
}

const CONTROLLER_TOOL_PARAMETERS: Record<BoundedControllerToolName, TSchema> = {
  researchctl: Type.Object({
    subcommand: Type.Union(RESEARCH_MODEL_COMMANDS.map((command) => Type.Literal(command)) as unknown as [TSchema, ...TSchema[]]),
    argv: Type.Optional(Type.Array(Type.String({ maxLength: MAX_ARGUMENT_CHARS }), { maxItems: MAX_ARGUMENTS })),
  }),
  aj_switchboard: Type.Object({
    subcommand: Type.Union(AJ_COMMANDS.map((command) => Type.Literal(command)) as unknown as [TSchema, ...TSchema[]]),
    argv: Type.Optional(Type.Array(Type.String({ maxLength: MAX_ARGUMENT_CHARS }), { maxItems: MAX_ARGUMENTS })),
  }),
};

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(value);
}

function hasLexicalTraversal(value: string): boolean {
  return value.split(/[\\/]/u).some((segment) => segment === "..");
}

async function nearestExistingPath(target: string): Promise<string> {
  let current = target;
  while (true) {
    try {
      return await fs.realpath(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function assertTaskRootPath(taskRoot: string, value: string, label: string): Promise<void> {
  if (value.length === 0 || value === "-") {
    throw new Error(`${label} must name a task-root file or directory`);
  }
  if (value.includes("\0")) {
    throw new Error(`${label} contains NUL`);
  }
  if (hasLexicalTraversal(value)) {
    throw new Error(`${label} contains lexical traversal`);
  }
  if (/^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\")) {
    throw new Error(`${label} contains an absolute local path`);
  }
  const candidate = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(taskRoot, value);
  if (!isWithin(taskRoot, candidate)) {
    throw new Error(`${label} must remain under the exact task root`);
  }
  const resolved = await nearestExistingPath(candidate);
  if (!isWithin(taskRoot, resolved)) {
    throw new Error(`${label} escapes the exact task root through a symlink`);
  }
}

async function assertBoundEffectScopeRoot(
  taskRoot: string,
  binding: AuthoringEffectScopeBinding | undefined,
): Promise<void> {
  if (!binding) return;
  assertAuthoringEffectScopeBinding(binding);
  if (binding.task_root !== taskRoot || binding.writable_scope.kind !== "fixed_state_subtree") {
    throw new Error("bounded controller requires its exact fixed state-subtree effect binding");
  }
  const stat = await fs.lstat(taskRoot);
  if (
    stat.isSymbolicLink() || !stat.isDirectory() ||
    String(stat.dev) !== binding.task_root_device || String(stat.ino) !== binding.task_root_inode
  ) {
    throw new Error("bounded controller task-root identity changed after activation");
  }
}

function assertMutationPathInStateSubtree(
  taskRoot: string,
  value: string,
  label: string,
  binding: AuthoringEffectScopeBinding | undefined,
): void {
  if (!binding) return;
  const candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(taskRoot, value);
  if (!isWithin(binding.writable_scope.paths[0], candidate)) {
    throw new Error(
      `${label} is outside the fixed profile-owned state subtree writable scope; use ${binding.writable_scope.paths[0]}`,
    );
  }
}

function positionalPathIndexes(tool: BoundedControllerToolName, subcommand: string): Set<number> {
  if (tool === "researchctl") {
    if (subcommand === "state-paths") return new Set();
    return new Set([0]);
  }
  if (subcommand === "run") {
    return new Set();
  }
  return new Set([0]);
}

function isPathValue(
  tool: BoundedControllerToolName,
  subcommand: string,
  argv: readonly string[],
  index: number,
): boolean {
  if (index === 0) return positionalPathIndexes(tool, subcommand).has(index);
  let option: string | undefined;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = argv[cursor]!;
    if (candidate.startsWith("--")) {
      option = candidate;
      break;
    }
  }
  if (option && PATH_OPTIONS.has(option)) return true;
  if (tool === "aj_switchboard" && subcommand === "run") {
    const nested = argv[0];
    if (nested === "init") {
      return option === "--root" || option === "--target" || option === "--user" || option === "--session";
    }
    return option === "--root" || option === "--artifact" || option === "--receipt-file";
  }
  return false;
}

function nestedAjCommand(argv: readonly string[]): string | undefined {
  return argv[0];
}

async function validateArguments(
  taskRoot: string,
  tool: BoundedControllerToolName,
  subcommand: string,
  argv: readonly string[],
  effectScopeBinding?: AuthoringEffectScopeBinding,
): Promise<void> {
  if (argv.length > MAX_ARGUMENTS) {
    throw new Error(`${tool} argv exceeds ${MAX_ARGUMENTS} arguments`);
  }
  if (tool === "aj_switchboard" && subcommand === "run") {
    const nested = nestedAjCommand(argv);
    if (!nested || !(AJ_RUN_COMMANDS as readonly string[]).includes(nested)) {
      throw new Error("aj_switchboard run subcommand is not allowed");
    }
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value.length > MAX_ARGUMENT_CHARS) {
      throw new Error(`argv[${index}] exceeds ${MAX_ARGUMENT_CHARS} characters`);
    }
    if (value.includes("\0")) {
      throw new Error(`argv[${index}] contains NUL`);
    }
    if (value === "--") {
      throw new Error("argument separator is not allowed");
    }
    const inlinePathOption = [...PATH_OPTIONS].find((option) => value.startsWith(`${option}=`));
    const pathValue = inlinePathOption ? value.slice(inlinePathOption.length + 1) : value;
    const pathArgument = inlinePathOption !== undefined || isPathValue(tool, subcommand, argv, index);
    if (pathArgument) {
      if (isHttpUrl(pathValue)) {
        throw new Error(`argv[${index}] must remain under the exact task root`);
      }
      await assertTaskRootPath(taskRoot, pathValue, `argv[${index}]`);
      const option = inlinePathOption ?? argv.slice(0, index).reverse().find((candidate) => candidate.startsWith("--"));
      if (
        (tool === "researchctl" && index === 0) ||
        (tool === "aj_switchboard" && subcommand === "run" && option === "--root")
      ) {
        assertMutationPathInStateSubtree(taskRoot, pathValue, `argv[${index}]`, effectScopeBinding);
      }
      if (option && JSON_PATH_OPTIONS.has(option)) {
        const candidate = path.resolve(taskRoot, pathValue);
        const stat = await fs.stat(candidate).catch(() => undefined);
        if (stat && stat.size > MAX_JSON_BYTES) {
          throw new Error(`controller JSON input exceeds ${MAX_JSON_BYTES} bytes`);
        }
      }
      continue;
    }
    if (isHttpUrl(value)) continue;
  }
}

function boundedText(value: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxBytes) return value;
  return `${Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8")}\n[output truncated by bounded controller]`;
}

function envForController(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    PYTHONIOENCODING: "utf-8",
    // Fixed AJ dependencies may be supplied by the selected interpreter's own
    // site configuration; PYTHONPATH remains absent and the exact executable
    // plus its capability probe are bound before the controller is admitted.
    PYTHONDONTWRITEBYTECODE: "1",
  };
}

function researchControllerStatePaths(
  binding: AuthoringEffectScopeBinding | undefined,
): ResearchControllerStatePaths {
  if (
    !binding ||
    binding.effect_profile !== "researcher_bounded_v1" ||
    binding.writable_scope.kind !== "fixed_state_subtree"
  ) {
    throw new Error("researchctl state-paths requires its exact researcher_bounded_v1 effect binding");
  }
  const stateRoot = binding.writable_scope.paths[0];
  return {
    schema_version: 1,
    job_path: path.join(stateRoot, "job.json"),
    input_root: path.join(stateRoot, "inputs"),
  };
}

function exactResearchControllerStateRoot(
  taskRoot: string,
  binding: AuthoringEffectScopeBinding,
  statePaths: ResearchControllerStatePaths,
): string {
  const stateRoot = path.dirname(statePaths.job_path);
  const expected = path.join(taskRoot, ".subagent007", "researcher_bounded_v1");
  if (
    !path.isAbsolute(stateRoot) ||
    path.resolve(stateRoot) !== stateRoot ||
    stateRoot !== expected ||
    stateRoot !== binding.writable_scope.paths[0]
  ) {
    throw new Error("researchctl init state root is not the exact canonical binding-derived path");
  }
  return stateRoot;
}

async function inspectExactDirectory(
  directoryPath: string,
  label: string,
): Promise<ResearchControllerInitDirectories["stateRoot"]> {
  const stat = await fs.lstat(directoryPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be an exact real directory`);
  }
  const resolved = await fs.realpath(directoryPath);
  if (resolved !== directoryPath) {
    throw new Error(`${label} realpath changed or is noncanonical`);
  }
  return {
    path: directoryPath,
    realpath: resolved,
    device: String(stat.dev),
    inode: String(stat.ino),
  };
}

async function establishExactDirectory(directoryPath: string, label: string): Promise<void> {
  try {
    await fs.mkdir(directoryPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await inspectExactDirectory(directoryPath, label);
}

async function assertExactDirectoryIdentity(
  identity: ResearchControllerInitDirectories["stateRoot"],
  label: string,
): Promise<void> {
  const current = await inspectExactDirectory(identity.path, label);
  if (
    current.realpath !== identity.realpath ||
    current.device !== identity.device ||
    current.inode !== identity.inode
  ) {
    throw new Error(`${label} identity changed during researchctl init`);
  }
}

async function establishResearchControllerInitDirectories(input: {
  taskRoot: string;
  binding: AuthoringEffectScopeBinding;
  statePaths: ResearchControllerStatePaths;
}): Promise<ResearchControllerInitDirectories> {
  const stateRoot = exactResearchControllerStateRoot(input.taskRoot, input.binding, input.statePaths);
  const expectedJobPath = input.statePaths.job_path;
  const expectedInputRoot = input.statePaths.input_root;
  if (
    path.basename(expectedJobPath) !== "job.json" ||
    path.dirname(expectedInputRoot) !== stateRoot ||
    path.basename(expectedInputRoot) !== "inputs" ||
    !path.isAbsolute(expectedJobPath) ||
    !path.isAbsolute(expectedInputRoot) ||
    path.resolve(expectedJobPath) !== expectedJobPath ||
    path.resolve(expectedInputRoot) !== expectedInputRoot
  ) {
    throw new Error("researchctl init state paths are not exact canonical binding-derived paths");
  }

  const profileParent = path.dirname(stateRoot);
  if (profileParent !== path.join(input.taskRoot, ".subagent007")) {
    throw new Error("researchctl init state directory chain is not canonical");
  }
  await establishExactDirectory(profileParent, "researchctl profile parent");
  await establishExactDirectory(stateRoot, "researchctl state root");
  await establishExactDirectory(expectedInputRoot, "researchctl input root");

  const directories = {
    stateRoot: await inspectExactDirectory(stateRoot, "researchctl state root"),
    inputRoot: await inspectExactDirectory(expectedInputRoot, "researchctl input root"),
  };
  await assertExactDirectoryIdentity(directories.stateRoot, "researchctl state root");
  await assertExactDirectoryIdentity(directories.inputRoot, "researchctl input root");
  return directories;
}

async function assertResearchControllerInitDirectoryIdentities(
  directories: ResearchControllerInitDirectories,
): Promise<void> {
  await assertExactDirectoryIdentity(directories.stateRoot, "researchctl state root");
  await assertExactDirectoryIdentity(directories.inputRoot, "researchctl input root");
}

async function assertResearchControllerInitSuccess(input: {
  directories: ResearchControllerInitDirectories;
  statePaths: ResearchControllerStatePaths;
  effectScopeBinding: AuthoringEffectScopeBinding;
}): Promise<void> {
  await assertResearchControllerInitDirectoryIdentities(input.directories);
  const jobStat = await fs.lstat(input.statePaths.job_path);
  if (jobStat.isSymbolicLink() || !jobStat.isFile() || jobStat.nlink !== 1) {
    throw new Error("researchctl init must produce the exact regular single-link job.json");
  }
  if (await fs.realpath(input.statePaths.job_path) !== input.statePaths.job_path) {
    throw new Error("researchctl init job.json is noncanonical");
  }
  if (await fs.realpath(input.statePaths.input_root) !== input.directories.inputRoot.realpath) {
    throw new Error("researchctl init input root changed before successful closure");
  }
  await assertAuthoringWritableClosure(input.effectScopeBinding);
}

function toolDescription(
  tool: BoundedControllerToolName,
  binding: AuthoringEffectScopeBinding | undefined,
): string {
  if (tool === "researchctl") {
    const discovery = binding?.effect_profile === "researcher_bounded_v1"
      ? " Call state-paths first and use only its exact job_path and input_root; do not guess state paths."
      : "";
    return `Run one allowlisted researchctl workflow command against task-root state. The immutable researcher snapshot supplies the script; URLs are data and no shell is available.${discovery}`;
  }
  return "Run one allowlisted AJ switchboard command against task-root state. The immutable assumption-judge snapshot supplies the script; URLs are data and no shell is available.";
}

async function verifiedControllerCommand(input: {
  tool: BoundedControllerToolName;
  scriptPath: string;
  controllerPython: ResolvedBoundedControllerPython;
}): Promise<{ scriptPath: string; pythonPath: string }> {
  const resolvedScript = await fs.realpath(input.scriptPath);
  const scriptDirectory = path.dirname(resolvedScript);
  const expectedScript = input.tool === "researchctl" ? "researchctl.py" : "aj.py";
  const expectedRuntimeRoot = await fs.realpath(path.dirname(path.dirname(path.resolve(input.scriptPath))));
  const expectedScriptPath = path.join(expectedRuntimeRoot, "scripts", expectedScript);
  if (
    resolvedScript !== expectedScriptPath ||
    path.basename(scriptDirectory) !== "scripts" ||
    path.basename(resolvedScript) !== expectedScript ||
    !resolvedScript.startsWith(path.sep)
  ) {
    throw new Error(`${input.tool} controller script identity is invalid`);
  }
  const verifiedPython = await assertResolvedBoundedControllerPython(
    input.controllerPython,
    input.tool === "researchctl" ? "researcher_bounded_v1" : "assumption_audit_bounded_v1",
  );
  return { scriptPath: resolvedScript, pythonPath: verifiedPython.realpath };
}

async function executeController(
  taskRoot: string,
  tool: BoundedControllerToolName,
  subcommand: string,
  rawArgv: unknown,
  scriptPath: string,
  controllerPython: ResolvedBoundedControllerPython,
  effectScopeBinding?: AuthoringEffectScopeBinding,
  allowedCommands: readonly string[] = BOUNDED_CONTROLLER_COMMANDS[tool],
): Promise<Awaited<ReturnType<ToolDefinition<any>["execute"]>>> {
  const argv = rawArgv === undefined ? [] : rawArgv;
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    throw new Error(`${tool} argv must be an array of strings`);
  }
  const args = argv as string[];
  const taskRootReal = await fs.realpath(taskRoot);
  await assertBoundEffectScopeRoot(taskRootReal, effectScopeBinding);
  if (!allowedCommands.includes(subcommand)) {
    throw new Error(`${tool} subcommand is not allowed`);
  }
  if (tool === "researchctl" && subcommand === "state-paths") {
    if (args.length !== 0) {
      throw new Error("researchctl state-paths does not accept argv");
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          subcommand,
          state_paths: researchControllerStatePaths(effectScopeBinding),
        }),
      }],
    } as Awaited<ReturnType<ToolDefinition<any>["execute"]>>;
  }
  await validateArguments(taskRootReal, tool, subcommand, args, effectScopeBinding);
  // The caller supplies only the command and its data arguments. The script path
  // is fixed by the immutable snapshot activation and is never an argv value.
  const verified = await verifiedControllerCommand({ tool, scriptPath, controllerPython });
  let researchInit:
    | {
      directories: ResearchControllerInitDirectories;
      statePaths: ResearchControllerStatePaths;
      effectScopeBinding: AuthoringEffectScopeBinding;
    }
    | undefined;
  if (
    tool === "researchctl" &&
    subcommand === "init" &&
    effectScopeBinding?.effect_profile === "researcher_bounded_v1"
  ) {
    if (effectScopeBinding.writable_scope.kind !== "fixed_state_subtree") {
      throw new Error("researchctl init requires its exact researcher_bounded_v1 effect binding");
    }
    const statePaths = researchControllerStatePaths(effectScopeBinding);
    if (args.length === 0 || args[0] !== statePaths.job_path) {
      throw new Error("researchctl init argv[0] must equal the exact binding-derived canonical job_path");
    }
    researchInit = {
      directories: await establishResearchControllerInitDirectories({
        taskRoot: taskRootReal,
        binding: effectScopeBinding,
        statePaths,
      }),
      statePaths,
      effectScopeBinding,
    };
    await assertResearchControllerInitDirectoryIdentities(researchInit.directories);
  }
  const commandArgs = [verified.scriptPath, subcommand, ...args];
  try {
    const result = await execFileAsync(verified.pythonPath, commandArgs, {
      cwd: taskRootReal,
      env: envForController(),
      shell: false,
      timeout: BOUNDED_CONTROLLER_TIMEOUT_MS,
      maxBuffer: MAX_STDOUT_BYTES + MAX_STDERR_BYTES,
      windowsHide: true,
    });
    if (researchInit) {
      await assertResearchControllerInitSuccess(researchInit);
    } else if (effectScopeBinding) {
      await assertAuthoringWritableClosure(effectScopeBinding);
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          subcommand,
          stdout: boundedText(result.stdout, MAX_STDOUT_BYTES),
          stderr: boundedText(result.stderr, MAX_STDERR_BYTES),
        }),
      }],
    } as Awaited<ReturnType<ToolDefinition<any>["execute"]>>;
  } catch (error) {
    if (researchInit) {
      await assertResearchControllerInitDirectoryIdentities(researchInit.directories);
      await assertAuthoringWritableClosure(researchInit.effectScopeBinding);
    } else if (effectScopeBinding) {
      await assertAuthoringWritableClosure(effectScopeBinding);
    }
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    if (failure.stdout !== undefined || failure.stderr !== undefined) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            subcommand,
            timed_out: failure.killed === true,
            stdout: boundedText(failure.stdout ?? "", MAX_STDOUT_BYTES),
            stderr: boundedText(failure.stderr ?? String(error), MAX_STDERR_BYTES),
          }),
        }],
      } as Awaited<ReturnType<ToolDefinition<any>["execute"]>>;
    }
    throw new Error(`${tool} failed: ${failure.message ?? String(error)}`);
  }
}

export async function inspectResearchControllerCompletion(input: {
  taskRoot: string;
  scriptPath: string;
  controllerPython: ResolvedBoundedControllerPython;
  effectScopeBinding: AuthoringEffectScopeBinding;
}): Promise<ResearchControllerTerminalReceipt | undefined> {
  try {
    const taskRootReal = await fs.realpath(input.taskRoot);
    await assertBoundEffectScopeRoot(taskRootReal, input.effectScopeBinding);
    const statePaths = researchControllerStatePaths(input.effectScopeBinding);
    const jobStat = await fs.lstat(statePaths.job_path);
    if (!jobStat.isFile() || jobStat.isSymbolicLink() || jobStat.nlink !== 1 || jobStat.size > MAX_JSON_BYTES) {
      return undefined;
    }
    const jobBytes = await fs.readFile(statePaths.job_path);
    const job = JSON.parse(jobBytes.toString("utf8")) as { state?: unknown };
    if (job.state !== "complete") return undefined;
    const verified = await verifiedControllerCommand({
      tool: "researchctl",
      scriptPath: input.scriptPath,
      controllerPython: input.controllerPython,
    });
    await execFileAsync(
      verified.pythonPath,
      [verified.scriptPath, "validate", statePaths.job_path],
      {
        cwd: taskRootReal,
        env: envForController(),
        shell: false,
        timeout: BOUNDED_CONTROLLER_TIMEOUT_MS,
        maxBuffer: MAX_STDOUT_BYTES + MAX_STDERR_BYTES,
        windowsHide: true,
      },
    );
    const rendered = await execFileAsync(
      verified.pythonPath,
      [verified.scriptPath, "render", statePaths.job_path, "--profile", "full"],
      {
        cwd: taskRootReal,
        env: envForController(),
        shell: false,
        timeout: BOUNDED_CONTROLLER_TIMEOUT_MS,
        maxBuffer: MAX_STDOUT_BYTES + MAX_STDERR_BYTES,
        windowsHide: true,
      },
    );
    const finalJobBytes = await fs.readFile(statePaths.job_path);
    if (!jobBytes.equals(finalJobBytes)) return undefined;
    return {
      schema_version: 1,
      controller: "researchctl",
      state: "complete",
      validation: "passed",
      job_sha256: createHash("sha256").update(jobBytes).digest("hex"),
      render_profile: "full",
      render_sha256: createHash("sha256").update(rendered.stdout, "utf8").digest("hex"),
    };
  } catch {
    return undefined;
  }
}

export interface ResearchControllerTerminalProduct {
  receipt: Extract<ResearchControllerTerminalReceipt, { schema_version: 2 }>;
  primaryMarkdown: string;
  packetMarkdown: string;
}

export async function materializeResearchControllerCompletion(input: {
  taskRoot: string;
  scriptPath: string;
  controllerPython: ResolvedBoundedControllerPython;
  effectScopeBinding: AuthoringEffectScopeBinding;
}): Promise<ResearchControllerTerminalProduct | undefined> {
  try {
    const taskRootReal = await fs.realpath(input.taskRoot);
    await assertBoundEffectScopeRoot(taskRootReal, input.effectScopeBinding);
    const statePaths = researchControllerStatePaths(input.effectScopeBinding);
    const jobStat = await fs.lstat(statePaths.job_path);
    if (!jobStat.isFile() || jobStat.isSymbolicLink() || jobStat.nlink !== 1 || jobStat.size > MAX_JSON_BYTES) {
      return undefined;
    }
    const jobBytes = await fs.readFile(statePaths.job_path);
    const job = JSON.parse(jobBytes.toString("utf8")) as {
      state?: unknown;
      dispatch_protocol?: unknown;
    };
    if (
      job.state !== "complete" ||
      job.dispatch_protocol !== "research_web_dispatch_v1"
    ) {
      return undefined;
    }
    const verified = await verifiedControllerCommand({
      tool: "researchctl",
      scriptPath: input.scriptPath,
      controllerPython: input.controllerPython,
    });
    const run = (argv: string[]) => execFileAsync(verified.pythonPath, argv, {
      cwd: taskRootReal,
      env: envForController(),
      shell: false,
      timeout: BOUNDED_CONTROLLER_TIMEOUT_MS,
      maxBuffer: MAX_STDOUT_BYTES + MAX_STDERR_BYTES,
      windowsHide: true,
    });
    await run([verified.scriptPath, "validate", statePaths.job_path]);
    if (!jobBytes.equals(await fs.readFile(statePaths.job_path))) return undefined;
    const primary = await run([
      verified.scriptPath,
      "render",
      statePaths.job_path,
      "--profile",
      "primary",
    ]);
    if (!jobBytes.equals(await fs.readFile(statePaths.job_path))) return undefined;
    const packet = await run([
      verified.scriptPath,
      "render",
      statePaths.job_path,
      "--profile",
      "bendum",
    ]);
    if (!jobBytes.equals(await fs.readFile(statePaths.job_path))) return undefined;
    const primaryMarkdown = stripAnsiAndControls(primary.stdout);
    const packetMarkdown = stripAnsiAndControls(packet.stdout);
    return {
      primaryMarkdown,
      packetMarkdown,
      receipt: {
        schema_version: 2,
        controller: "researchctl",
        state: "complete",
        validation: "passed",
        dispatch_protocol: "research_web_dispatch_v1",
        job_sha256: createHash("sha256").update(jobBytes).digest("hex"),
        primary_profile: "primary",
        primary_sha256: createHash("sha256").update(primaryMarkdown, "utf8").digest("hex"),
        packet_profile: "bendum",
        packet_sha256: createHash("sha256").update(packetMarkdown, "utf8").digest("hex"),
      },
    };
  } catch {
    return undefined;
  }
}

export interface ResearchDispatchController {
  execute(
    subcommand: ResearchDispatchControllerCommand,
    argv: readonly string[],
  ): Promise<Awaited<ReturnType<ToolDefinition<any>["execute"]>>>;
}

/**
 * Runtime-private provider accounting capability. This is deliberately not a
 * Pi ToolDefinition, so it cannot be registered in the model-visible toolset.
 */
export function createResearchDispatchController(
  taskRoot: string,
  scriptPath: string,
  controllerPython: ResolvedBoundedControllerPython,
  effectScopeBinding: AuthoringEffectScopeBinding,
  executionQueue: BoundedControllerExecutionQueue,
): ResearchDispatchController {
  return {
    execute: (subcommand, argv) =>
      executionQueue.run(() =>
        executeController(
          taskRoot,
          "researchctl",
          subcommand,
          [...argv],
          scriptPath,
          controllerPython,
          effectScopeBinding,
          RESEARCH_DISPATCH_COMMANDS,
        )),
  };
}

export function createBoundedControllerTool(
  taskRoot: string,
  tool: BoundedControllerToolName,
  scriptPath: string,
  controllerPython: ResolvedBoundedControllerPython,
  effectScopeBinding?: AuthoringEffectScopeBinding,
  executionQueue?: BoundedControllerExecutionQueue,
): ToolDefinition<any> {
  const parameters = CONTROLLER_TOOL_PARAMETERS[tool];
  return {
    name: tool,
    label: tool,
    description: toolDescription(tool, effectScopeBinding),
    promptSnippet: tool === "researchctl"
      ? "Use researchctl for bounded workflow state transitions. Call state-paths before init, use the returned paths exactly, and do not use shell commands."
      : "Use aj_switchboard for bounded workflow state transitions; do not use shell commands.",
    promptGuidelines: [
      "Use only the declared subcommands and task-root paths.",
      "Treat HTTP(S) references as data; never provide an executable path.",
      "The controller owns campaign state and its evidence remains under the task root.",
      ...(tool === "researchctl"
        ? ["Use state-paths as the sole authority for the job path and controller input root."]
        : []),
    ],
    parameters,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const record = params as { subcommand?: unknown; argv?: unknown };
      if (typeof record.subcommand !== "string") {
        throw new Error(`${tool} subcommand is required`);
      }
      const subcommand = record.subcommand;
      if (
        tool === "researchctl" &&
        subcommand === "init" &&
        effectScopeBinding?.effect_profile === "researcher_bounded_v1" &&
        !executionQueue
      ) {
        throw new Error("researchctl init requires the shared bounded controller execution queue");
      }
      const operation = () =>
        executeController(
          taskRoot,
          tool,
          subcommand,
          record.argv,
          scriptPath,
          controllerPython,
          effectScopeBinding,
        );
      return executionQueue ? executionQueue.run(operation) : operation();
    },
  };
}

export function controllerScriptName(tool: BoundedControllerToolName): "researchctl.py" | "aj.py" {
  return tool === "researchctl" ? "researchctl.py" : "aj.py";
}

export function controllerToolForEffectProfile(effectProfile: EffectProfile): BoundedControllerToolName | undefined {
  if (effectProfile === "researcher_bounded_v1") return "researchctl";
  if (effectProfile === "assumption_audit_bounded_v1") return "aj_switchboard";
  return undefined;
}
