import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AuthoringEffectScopeBinding, EffectProfile } from "./types.js";
import { assertAuthoringEffectScopeBinding, assertAuthoringWritableClosure } from "./authoringEffectScope.js";

const execFileAsync = promisify(execFile);

export const BOUNDED_CONTROLLER_TOOL_NAMES = ["researchctl", "aj_switchboard"] as const;
export type BoundedControllerToolName = (typeof BOUNDED_CONTROLLER_TOOL_NAMES)[number];

const RESEARCH_COMMANDS = [
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
const AJ_COMMANDS = ["gate", "anchors", "reconcile", "triage", "validate", "emit", "run"] as const;
const AJ_RUN_COMMANDS = ["init", "next", "commit", "status", "check"] as const;

export const BOUNDED_CONTROLLER_COMMANDS = {
  researchctl: RESEARCH_COMMANDS,
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
    subcommand: Type.Union(RESEARCH_COMMANDS.map((command) => Type.Literal(command)) as unknown as [TSchema, ...TSchema[]]),
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
    throw new Error(`${label} is outside the fixed profile-owned state subtree writable scope`);
  }
}

function positionalPathIndexes(tool: BoundedControllerToolName, subcommand: string): Set<number> {
  if (tool === "researchctl") {
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
  const allowed = BOUNDED_CONTROLLER_COMMANDS[tool] as readonly string[];
  if (!allowed.includes(subcommand)) {
    throw new Error(`${tool} subcommand is not allowed`);
  }
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

function toolDescription(tool: BoundedControllerToolName): string {
  if (tool === "researchctl") {
    return "Run one allowlisted researchctl workflow command against task-root state. The immutable researcher snapshot supplies the script; URLs are data and no shell is available.";
  }
  return "Run one allowlisted AJ switchboard command against task-root state. The immutable assumption-judge snapshot supplies the script; URLs are data and no shell is available.";
}

async function executeController(
  taskRoot: string,
  tool: BoundedControllerToolName,
  subcommand: string,
  rawArgv: unknown,
  scriptPath: string,
  controllerPython: ResolvedBoundedControllerPython,
  effectScopeBinding?: AuthoringEffectScopeBinding,
): Promise<ReturnType<ToolDefinition<any>["execute"]>> {
  const argv = rawArgv === undefined ? [] : rawArgv;
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    throw new Error(`${tool} argv must be an array of strings`);
  }
  const args = argv as string[];
  const taskRootReal = await fs.realpath(taskRoot);
  await assertBoundEffectScopeRoot(taskRootReal, effectScopeBinding);
  await validateArguments(taskRootReal, tool, subcommand, args, effectScopeBinding);
  const resolvedScript = await fs.realpath(scriptPath);
  const scriptDirectory = path.dirname(resolvedScript);
  const expectedScript = tool === "researchctl" ? "researchctl.py" : "aj.py";
  const expectedRuntimeRoot = await fs.realpath(path.dirname(path.dirname(path.resolve(scriptPath))));
  const expectedScriptPath = path.join(expectedRuntimeRoot, "scripts", expectedScript);
  if (
    resolvedScript !== expectedScriptPath ||
    path.basename(scriptDirectory) !== "scripts" ||
    path.basename(resolvedScript) !== expectedScript ||
    !resolvedScript.startsWith(path.sep)
  ) {
    throw new Error(`${tool} controller script identity is invalid`);
  }
  // The caller supplies only the command and its data arguments. The script path
  // is fixed by the immutable snapshot activation and is never an argv value.
  const verifiedPython = await assertResolvedBoundedControllerPython(
    controllerPython,
    tool === "researchctl" ? "researcher_bounded_v1" : "assumption_audit_bounded_v1",
  );
  const commandArgs = [resolvedScript, subcommand, ...args];
  try {
    const result = await execFileAsync(verifiedPython.realpath, commandArgs, {
      cwd: taskRootReal,
      env: envForController(),
      shell: false,
      timeout: BOUNDED_CONTROLLER_TIMEOUT_MS,
      maxBuffer: MAX_STDOUT_BYTES + MAX_STDERR_BYTES,
      windowsHide: true,
    });
    if (effectScopeBinding) await assertAuthoringWritableClosure(effectScopeBinding);
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
    if (effectScopeBinding) await assertAuthoringWritableClosure(effectScopeBinding);
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

export function createBoundedControllerTool(
  taskRoot: string,
  tool: BoundedControllerToolName,
  scriptPath: string,
  controllerPython: ResolvedBoundedControllerPython,
  effectScopeBinding?: AuthoringEffectScopeBinding,
): ToolDefinition<any> {
  const parameters = CONTROLLER_TOOL_PARAMETERS[tool];
  return {
    name: tool,
    label: tool,
    description: toolDescription(tool),
    promptSnippet: `Use ${tool} for bounded workflow state transitions; do not use shell commands.`,
    promptGuidelines: [
      "Use only the declared subcommands and task-root paths.",
      "Treat HTTP(S) references as data; never provide an executable path.",
      "The controller owns campaign state and its evidence remains under the task root.",
    ],
    parameters,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const record = params as { subcommand?: unknown; argv?: unknown };
      if (typeof record.subcommand !== "string") {
        throw new Error(`${tool} subcommand is required`);
      }
      return executeController(
        taskRoot,
        tool,
        record.subcommand,
        record.argv,
        scriptPath,
        controllerPython,
        effectScopeBinding,
      );
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
