import fs from "node:fs/promises";
import path from "node:path";
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AuthoringEffectScopeBinding } from "./types.js";
import {
  assertAuthoringEffectScopeBinding,
  assertAuthoringWritableClosure,
  MAX_AUTHORING_WRITABLE_FILE_BYTES,
} from "./authoringEffectScope.js";

export const TASK_ROOT_AUTHORING_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
] as const;

const MAX_READ_LINES = 2_000;
const MAX_SEARCH_RESULTS = 200;
const MAX_LIST_ENTRIES = 200;
const MAX_GREP_CONTEXT_LINES = 50;

type GuardedToolKind = "read" | "grep" | "find" | "ls" | "write" | "edit";
export type TaskRootAuthoringToolName = GuardedToolKind;
type ReadOnlyToolKind = "read" | "grep" | "find" | "ls";

type PathToolParams = {
  path?: string;
  limit?: number;
  context?: number;
  content?: string;
  edits?: Array<{ oldText?: string; newText?: string }>;
};

interface AuthoringRoots {
  taskRoot: string;
  snapshotRuntimeRoot?: string;
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isReadOnlyTool(tool: GuardedToolKind): tool is ReadOnlyToolKind {
  return tool === "read" || tool === "grep" || tool === "find" || tool === "ls";
}

async function assertBoundTaskRootIdentity(
  roots: AuthoringRoots,
  binding: AuthoringEffectScopeBinding | undefined,
): Promise<void> {
  if (!binding) return;
  assertAuthoringEffectScopeBinding(binding);
  if (binding.task_root !== roots.taskRoot) {
    throw new Error("authoring effect scope task root differs from the active task root");
  }
  const stat = await fs.lstat(roots.taskRoot);
  if (
    stat.isSymbolicLink() || !stat.isDirectory() ||
    String(stat.dev) !== binding.task_root_device || String(stat.ino) !== binding.task_root_inode
  ) {
    throw new Error("authoring effect scope task-root identity changed after activation");
  }
}

function assertWritableScope(candidate: string, binding: AuthoringEffectScopeBinding | undefined): void {
  if (!binding) return;
  if (binding.writable_scope.kind === "exact_output_files") {
    if (!binding.writable_scope.paths.includes(candidate)) {
      throw new Error("write path is not an exact declared output in the authoring writable scope");
    }
    return;
  }
  const stateRoot = binding.writable_scope.paths[0];
  if (!isWithin(stateRoot, candidate)) {
    throw new Error("write path is outside the fixed profile-owned state subtree writable scope");
  }
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

async function resolveAuthoringRoots(taskRoot: string, snapshotSkillFilePath?: string): Promise<AuthoringRoots> {
  const resolvedTaskRoot = await fs.realpath(taskRoot);
  if (!snapshotSkillFilePath) return { taskRoot: resolvedTaskRoot };

  // Pi reaches this only after the snapshot binding has revalidated skillFilePath.
  // Its real parent is the exact immutable runtime bundle root, never its snapshot
  // container or any caller-provided source root.
  const resolvedSkillFilePath = await fs.realpath(snapshotSkillFilePath);
  const snapshotRuntimeRoot = await fs.realpath(path.dirname(snapshotSkillFilePath));
  if (!isWithin(snapshotRuntimeRoot, resolvedSkillFilePath) || path.basename(resolvedSkillFilePath) !== "SKILL.md") {
    throw new Error("snapshot skill file must remain beneath its exact runtime root");
  }
  return { taskRoot: resolvedTaskRoot, snapshotRuntimeRoot };
}

/**
 * Enforces exact real roots before a task-root authoring dispatch. Relative paths
 * always resolve from the task root; snapshot access requires an absolute path
 * within the already-validated immutable runtime root.
 */
export async function assertTaskRootAuthoringPath(
  taskRoot: string,
  requestedPath: string | undefined,
  tool: GuardedToolKind,
  snapshotSkillFilePath?: string,
  effectScopeBinding?: AuthoringEffectScopeBinding,
): Promise<string> {
  const roots = await resolveAuthoringRoots(taskRoot, snapshotSkillFilePath);
  await assertBoundTaskRootIdentity(roots, effectScopeBinding);
  const requested = requestedPath ?? ".";
  const allowedRoots = isReadOnlyTool(tool) && roots.snapshotRuntimeRoot
    ? [roots.taskRoot, roots.snapshotRuntimeRoot]
    : [roots.taskRoot];
  let candidate: string;
  if (path.isAbsolute(requested)) {
    candidate = path.resolve(requested);
  } else {
    const taskCandidate = path.resolve(roots.taskRoot, requested);
    if (!isWithin(roots.taskRoot, taskCandidate)) {
      throw new Error(`${tool} path must remain under the exact task root`);
    }
    candidate = taskCandidate;
    // Skill instructions conventionally name sidecars relative to SKILL.md. When
    // the isolated task root has no such path, let read-only tools resolve that
    // relative reference within the active immutable bundle—never by climbing out
    // of cwd. A real task-root path always takes precedence.
    if (isReadOnlyTool(tool) && roots.snapshotRuntimeRoot && requested !== ".") {
      try {
        await fs.realpath(taskCandidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const snapshotCandidate = path.resolve(roots.snapshotRuntimeRoot, requested);
        if (!isWithin(roots.snapshotRuntimeRoot, snapshotCandidate)) {
          throw new Error(`${tool} path must remain under the exact task root`);
        }
        candidate = snapshotCandidate;
      }
    }
  }
  if (!allowedRoots.some((root) => isWithin(root, candidate))) {
    throw new Error(`${tool} path must remain under the exact task root`);
  }
  if (!isReadOnlyTool(tool)) assertWritableScope(candidate, effectScopeBinding);
  const checkedPath = tool === "write" ? await nearestExistingPath(candidate) : await fs.realpath(candidate);
  if (!allowedRoots.some((root) => isWithin(root, checkedPath))) {
    throw new Error(`${tool} path must remain under the exact task root`);
  }
  return tool === "write" ? candidate : checkedPath;
}

function assertBounded(value: number | undefined, maximum: number, field: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > maximum)) {
    throw new Error(`${field} must be an integer from 1 through ${maximum} for task-root authoring`);
  }
}

function assertMutationPayloadBounded(tool: GuardedToolKind, params: PathToolParams): void {
  let payloadBytes = tool === "write" && params.content !== undefined
    ? Buffer.byteLength(params.content, "utf8")
    : 0;
  if (tool === "edit") {
    for (const edit of params.edits ?? []) {
      payloadBytes += Buffer.byteLength(edit.oldText ?? "", "utf8");
      payloadBytes += Buffer.byteLength(edit.newText ?? "", "utf8");
      if (payloadBytes > MAX_AUTHORING_WRITABLE_FILE_BYTES) break;
    }
  }
  if (payloadBytes > MAX_AUTHORING_WRITABLE_FILE_BYTES) {
    throw new Error(`authoring ${tool} payload exceeds ${MAX_AUTHORING_WRITABLE_FILE_BYTES} bytes`);
  }
}

function guardTaskRootTool(
  definition: ToolDefinition<any, any, any>,
  taskRoot: string,
  tool: GuardedToolKind,
  snapshotSkillFilePath?: string,
  effectScopeBinding?: AuthoringEffectScopeBinding,
): ToolDefinition<any, any, any> {
  return {
    ...definition,
    async execute(toolCallId, params: PathToolParams, signal, onUpdate, context) {
      const checkedPath = await assertTaskRootAuthoringPath(
        taskRoot,
        params.path,
        tool,
        snapshotSkillFilePath,
        effectScopeBinding,
      );
      if (tool === "read") assertBounded(params.limit, MAX_READ_LINES, "read limit");
      if (tool === "grep" || tool === "find") assertBounded(params.limit, MAX_SEARCH_RESULTS, `${tool} limit`);
      if (tool === "ls") assertBounded(params.limit, MAX_LIST_ENTRIES, "ls limit");
      if (tool === "grep" && params.context !== undefined) {
        if (!Number.isInteger(params.context) || params.context < 0 || params.context > MAX_GREP_CONTEXT_LINES) {
          throw new Error(`grep context must be an integer from 0 through ${MAX_GREP_CONTEXT_LINES} for task-root authoring`);
        }
      }
      if (effectScopeBinding) assertMutationPayloadBounded(tool, params);
      const result = await definition.execute(toolCallId, { ...params, path: checkedPath }, signal, onUpdate, context);
      if (!isReadOnlyTool(tool) && effectScopeBinding) {
        await assertAuthoringWritableClosure(effectScopeBinding, { requireExactOutputs: false });
      }
      return result;
    },
  };
}

/**
 * Pi custom-tool overrides for the Skill Creator authoring ceiling. The built-in
 * implementations retain their bounded rendering/search behavior. Writes and
 * edits stay beneath the exact real run cwd; read tools additionally receive the
 * exact real immutable runtime root only for a validated snapshot-bound launch.
 */
export function createTaskRootAuthoringTools(
  taskRoot: string,
  snapshotSkillFilePath?: string,
  toolNames: readonly TaskRootAuthoringToolName[] = TASK_ROOT_AUTHORING_TOOL_NAMES,
  effectScopeBinding?: AuthoringEffectScopeBinding,
): ToolDefinition<any, any, any>[] {
  const definitions: Record<TaskRootAuthoringToolName, () => ToolDefinition<any, any, any>> = {
    read: () => createReadToolDefinition(taskRoot),
    grep: () => createGrepToolDefinition(taskRoot),
    find: () => createFindToolDefinition(taskRoot),
    ls: () => createLsToolDefinition(taskRoot),
    write: () => createWriteToolDefinition(taskRoot),
    edit: () => createEditToolDefinition(taskRoot),
  };
  return toolNames.map((toolName) => guardTaskRootTool(
    definitions[toolName](),
    taskRoot,
    toolName,
    snapshotSkillFilePath,
    effectScopeBinding,
  ));
}
