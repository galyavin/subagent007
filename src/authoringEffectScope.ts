import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ValidationError,
  type AuthoringEffectScopeBinding,
  type EffectScopedAuthoringProfile,
  type RecursiveDelegation,
} from "./types.js";

export const MAX_AUTHORING_INITIAL_FILES = 128;
export const MAX_AUTHORING_INITIAL_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_AUTHORING_INITIAL_TOTAL_BYTES = 128 * 1024 * 1024;
export const MAX_AUTHORING_TREE_ENTRIES = 1_024;
export const MAX_ALLOWED_OUTPUT_PATHS = 128;
export const MAX_AUTHORING_WRITABLE_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_AUTHORING_WRITABLE_TOTAL_BYTES = 32 * 1024 * 1024;
export const MIN_MATERIALLY_SPARSE_FILE_BYTES = 1024 * 1024;
export const MIN_MATERIAL_ALLOCATION_RATIO = 0.5;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const EFFECT_SCOPE_DIGEST_DOMAIN = "subagent007.authoring_effect_scope.immutable_tree.v1\n";
const CLAIM_CEILING = "pi_tool_dispatch_path_controller_and_terminal_reinspection_not_os_sandbox" as const;

interface CapturedDirectoryEntry {
  kind: "directory";
  relative_path: string;
  device: string;
  inode: string;
}

interface CapturedFileEntry {
  kind: "file";
  relative_path: string;
  size_bytes: number;
  sha256: string;
  device: string;
  inode: string;
}

type CapturedTreeEntry = CapturedDirectoryEntry | CapturedFileEntry;

export interface CapturedAuthoringEffectScope {
  binding: AuthoringEffectScopeBinding;
  initialEntries: CapturedTreeEntry[];
}

function failInvalid(message: string): never {
  throw new ValidationError(message, "authoring_effect_scope_invalid");
}

function failDrift(message: string): never {
  throw new ValidationError(message, "authoring_effect_scope_drift");
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

export function isEffectScopedAuthoringProfile(
  profile: string | undefined,
): profile is EffectScopedAuthoringProfile {
  return profile === "task_root_authoring_v1" ||
    profile === "researcher_bounded_v1" ||
    profile === "assumption_audit_bounded_v1";
}

export function boundedProfileStateRoot(
  taskRoot: string,
  profile: Extract<EffectScopedAuthoringProfile, "researcher_bounded_v1" | "assumption_audit_bounded_v1">,
): string {
  return path.join(taskRoot, ".subagent007", profile);
}

export function normalizeAllowedOutputPaths(
  value: unknown,
  taskRoot: string,
  effectProfile: string | undefined,
): string[] | undefined {
  if (effectProfile !== "task_root_authoring_v1") {
    if (value !== undefined) {
      failInvalid("allowed_output_paths is only valid with task_root_authoring_v1");
    }
    return undefined;
  }
  if (!Array.isArray(value) || value.length > MAX_ALLOWED_OUTPUT_PATHS) {
    failInvalid(`task_root_authoring_v1 requires allowed_output_paths with at most ${MAX_ALLOWED_OUTPUT_PATHS} entries`);
  }
  const normalized: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate) || path.resolve(candidate) !== candidate) {
      failInvalid("allowed_output_paths entries must be canonical absolute paths");
    }
    if (candidate === taskRoot || !isWithin(taskRoot, candidate)) {
      failInvalid("allowed_output_paths entries must be strict descendants of the exact task root");
    }
    normalized.push(candidate);
  }
  if (
    normalized.some((entry, index) => index > 0 && utf8Compare(normalized[index - 1]!, entry) >= 0) ||
    normalized.some((entry, index) => normalized.slice(index + 1).some((other) => pathsOverlap(entry, other)))
  ) {
    failInvalid("allowed_output_paths must be unique, UTF-8 byte ordered, and non-overlapping");
  }
  return normalized;
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

async function assertCanonicalTaskRoot(taskRoot: string): Promise<void> {
  if (!path.isAbsolute(taskRoot) || path.resolve(taskRoot) !== taskRoot) {
    failInvalid("authoring task root must be canonical and absolute");
  }
  let resolved: string;
  try {
    resolved = await fs.realpath(taskRoot);
  } catch (error) {
    failInvalid(`authoring task root is inaccessible: ${(error as Error).message}`);
  }
  if (resolved !== taskRoot) {
    failInvalid("authoring task root must be its exact real path");
  }
  const stat = await fs.lstat(taskRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    failInvalid("authoring task root must be a real directory");
  }
}

async function assertOutputPathsAbsent(taskRoot: string, outputPaths: readonly string[]): Promise<void> {
  for (const outputPath of outputPaths) {
    const existing = await fs.lstat(outputPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing) {
      failInvalid(`allowed output must be absent before prompt: ${outputPath}`);
    }
    const parent = await nearestExistingPath(path.dirname(outputPath));
    if (!isWithin(taskRoot, parent)) {
      failInvalid(`allowed output parent escapes the exact task root: ${outputPath}`);
    }
  }
}

async function assertBoundedStateRootAbsent(binding: AuthoringEffectScopeBinding): Promise<void> {
  if (binding.writable_scope.kind !== "fixed_state_subtree") return;
  const stateRoot = binding.writable_scope.paths[0];
  const existing = await fs.lstat(stateRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) {
    failInvalid(`fixed profile state root must be absent before prompt: ${stateRoot}`);
  }
}

function relativePath(taskRoot: string, candidate: string): string {
  const relative = path.relative(taskRoot, candidate);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

async function captureFile(taskRoot: string, filePath: string): Promise<CapturedFileEntry> {
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    failInvalid(`authoring task-root file is unreadable or symlinked: ${filePath}: ${(error as Error).message}`);
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_AUTHORING_INITIAL_FILE_BYTES) {
      failInvalid(`authoring task-root input must be a bounded regular file: ${filePath}`);
    }
    if (before.nlink !== 1) {
      failInvalid(`authoring task-root regular files must have link count one; hardlink alias rejected: ${filePath}`);
    }
    if (
      before.size >= MIN_MATERIALLY_SPARSE_FILE_BYTES &&
      before.blocks * 512 < before.size * MIN_MATERIAL_ALLOCATION_RATIO
    ) {
      failInvalid(`authoring task-root sparse input is not allowed: ${filePath}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.length !== before.size) {
      failInvalid(`authoring task-root input changed while it was captured: ${filePath}`);
    }
    const [resolved, current] = await Promise.all([fs.realpath(filePath), fs.lstat(filePath)]);
    if (
      resolved !== filePath || current.isSymbolicLink() || !current.isFile() ||
      current.dev !== before.dev || current.ino !== before.ino
    ) {
      failInvalid(`authoring task-root input identity changed while it was captured: ${filePath}`);
    }
    return {
      kind: "file",
      relative_path: relativePath(taskRoot, filePath),
      size_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      device: String(before.dev),
      inode: String(before.ino),
    };
  } finally {
    await handle.close();
  }
}

function ignoredByWritableSubtree(binding: AuthoringEffectScopeBinding, candidate: string): boolean {
  return binding.writable_scope.kind === "fixed_state_subtree" &&
    isWithin(binding.writable_scope.paths[0], candidate);
}

async function captureTree(
  taskRoot: string,
  binding: AuthoringEffectScopeBinding,
): Promise<CapturedTreeEntry[]> {
  const entries: CapturedTreeEntry[] = [];
  let traversed = 0;
  let fileCount = 0;
  let totalBytes = 0;
  const visit = async (candidate: string): Promise<void> => {
    traversed += 1;
    if (traversed > MAX_AUTHORING_TREE_ENTRIES) {
      failInvalid(`authoring task root exceeds ${MAX_AUTHORING_TREE_ENTRIES} filesystem entries`);
    }
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink()) {
      failInvalid(`authoring task root contains a symlink: ${candidate}`);
    }
    if (stat.isDirectory()) {
      if (!ignoredByWritableSubtree(binding, candidate)) {
        entries.push({
          kind: "directory",
          relative_path: relativePath(taskRoot, candidate),
          device: String(stat.dev),
          inode: String(stat.ino),
        });
      }
      const children = (await fs.readdir(candidate)).sort(utf8Compare);
      for (const child of children) await visit(path.join(candidate, child));
      return;
    }
    if (!stat.isFile()) {
      failInvalid(`authoring task root contains a non-regular entry: ${candidate}`);
    }
    if (stat.nlink !== 1) {
      failInvalid(`authoring task-root regular files must have link count one; hardlink alias rejected: ${candidate}`);
    }
    if (ignoredByWritableSubtree(binding, candidate)) return;
    if (
      binding.writable_scope.kind === "exact_output_files" &&
      binding.writable_scope.paths.includes(candidate)
    ) {
      return;
    }
    fileCount += 1;
    if (fileCount > MAX_AUTHORING_INITIAL_FILES) {
      failInvalid(`authoring task root exceeds ${MAX_AUTHORING_INITIAL_FILES} immutable files`);
    }
    const captured = await captureFile(taskRoot, candidate);
    totalBytes += captured.size_bytes;
    if (totalBytes > MAX_AUTHORING_INITIAL_TOTAL_BYTES) {
      failInvalid(`authoring task-root immutable bytes exceed ${MAX_AUTHORING_INITIAL_TOTAL_BYTES}`);
    }
    entries.push(captured);
  };
  await visit(taskRoot);
  return entries.sort((left, right) => utf8Compare(left.relative_path, right.relative_path));
}

function immutableTreeSha256(entries: readonly CapturedTreeEntry[]): string {
  return createHash("sha256")
    .update(EFFECT_SCOPE_DIGEST_DOMAIN)
    .update(JSON.stringify(entries))
    .digest("hex");
}

function writableScope(
  taskRoot: string,
  profile: EffectScopedAuthoringProfile,
  allowedOutputPaths: readonly string[] | undefined,
): AuthoringEffectScopeBinding["writable_scope"] {
  if (profile === "task_root_authoring_v1") {
    return { kind: "exact_output_files", paths: [...(allowedOutputPaths ?? [])] };
  }
  return { kind: "fixed_state_subtree", paths: [boundedProfileStateRoot(taskRoot, profile)] };
}

export async function captureAuthoringEffectScope(input: {
  taskRoot: string;
  effectProfile: EffectScopedAuthoringProfile;
  recursiveDelegation: RecursiveDelegation;
  allowedOutputPaths?: readonly string[];
}): Promise<CapturedAuthoringEffectScope> {
  await assertCanonicalTaskRoot(input.taskRoot);
  if (input.recursiveDelegation !== "disabled") {
    failInvalid("authoring effect scopes require recursive delegation disabled");
  }
  const normalizedOutputs = normalizeAllowedOutputPaths(
    input.allowedOutputPaths,
    input.taskRoot,
    input.effectProfile,
  );
  if (normalizedOutputs) await assertOutputPathsAbsent(input.taskRoot, normalizedOutputs);
  const provisional: AuthoringEffectScopeBinding = {
    schema_version: 1,
    effect_profile: input.effectProfile,
    task_root: input.taskRoot,
    task_root_device: "0",
    task_root_inode: "0",
    recursive_delegation: "disabled",
    immutable_tree_sha256: "0".repeat(64),
    writable_scope: writableScope(input.taskRoot, input.effectProfile, normalizedOutputs),
    terminal_reinspection_required: true,
    claim_ceiling: CLAIM_CEILING,
  };
  await assertBoundedStateRootAbsent(provisional);
  const initialEntries = await captureTree(input.taskRoot, provisional);
  const taskRootIdentity = initialEntries.find((entry) => entry.relative_path === "." && entry.kind === "directory");
  if (!taskRootIdentity) failInvalid("authoring task-root identity was not captured");
  return {
    binding: {
      ...provisional,
      task_root_device: taskRootIdentity.device,
      task_root_inode: taskRootIdentity.inode,
      immutable_tree_sha256: immutableTreeSha256(initialEntries),
    },
    initialEntries,
  };
}

function exactEntry(left: CapturedTreeEntry, right: CapturedTreeEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function absoluteEntryPath(taskRoot: string, entry: CapturedTreeEntry): string {
  return entry.relative_path === "."
    ? taskRoot
    : path.join(taskRoot, ...entry.relative_path.split("/"));
}

function allowedNewDirectory(binding: AuthoringEffectScopeBinding, candidate: string): boolean {
  return binding.writable_scope.paths.some((writablePath) =>
    candidate !== binding.task_root && isWithin(candidate, writablePath)
  );
}

function assertBoundedWritableFileStat(filePath: string, stat: Awaited<ReturnType<typeof fs.lstat>>): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    failDrift(`authoring writable closure contains a non-regular or symlinked file: ${filePath}`);
  }
  if (stat.nlink !== 1) {
    failDrift(`authoring writable closure regular files must have link count one: ${filePath}`);
  }
  if (stat.size > MAX_AUTHORING_WRITABLE_FILE_BYTES) {
    failDrift(`authoring writable file exceeds bounded logical size ${MAX_AUTHORING_WRITABLE_FILE_BYTES}: ${filePath}`);
  }
  if (
    Number(stat.size) >= MIN_MATERIALLY_SPARSE_FILE_BYTES &&
    Number(stat.blocks) * 512 < Number(stat.size) * MIN_MATERIAL_ALLOCATION_RATIO
  ) {
    failDrift(`authoring writable closure contains a materially sparse file: ${filePath}`);
  }
}

export async function assertAuthoringWritableClosure(
  binding: AuthoringEffectScopeBinding,
  options: { requireExactOutputs?: boolean } = {},
): Promise<void> {
  assertAuthoringEffectScopeBinding(binding);
  let totalBytes = 0;
  let traversed = 0;
  const inspectFile = async (filePath: string, allowMissing = false): Promise<void> => {
    const stat = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (allowMissing && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) return;
    assertBoundedWritableFileStat(filePath, stat);
    if (await fs.realpath(filePath) !== filePath) {
      failDrift(`authoring writable file is not at its exact real path: ${filePath}`);
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_AUTHORING_WRITABLE_TOTAL_BYTES) {
      failDrift(`authoring writable closure aggregate logical size exceeds ${MAX_AUTHORING_WRITABLE_TOTAL_BYTES}`);
    }
  };

  if (binding.writable_scope.kind === "exact_output_files") {
    for (const outputPath of binding.writable_scope.paths) {
      await inspectFile(outputPath, options.requireExactOutputs === false);
    }
    return;
  }

  const stateRoot = binding.writable_scope.paths[0];
  const stateRootStat = await fs.lstat(stateRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stateRootStat) return;
  const visit = async (candidate: string): Promise<void> => {
    traversed += 1;
    if (traversed > MAX_AUTHORING_TREE_ENTRIES) {
      failDrift(`authoring writable state exceeds ${MAX_AUTHORING_TREE_ENTRIES} filesystem entries`);
    }
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink()) {
      failDrift(`authoring writable closure contains a symlink: ${candidate}`);
    }
    if (stat.isDirectory()) {
      if (await fs.realpath(candidate) !== candidate) {
        failDrift(`authoring writable directory is not at its exact real path: ${candidate}`);
      }
      const children = (await fs.readdir(candidate)).sort(utf8Compare);
      for (const child of children) await visit(path.join(candidate, child));
      return;
    }
    await inspectFile(candidate);
  };
  await visit(stateRoot);
}

export async function assertAuthoringEffectScopeTerminal(
  captured: CapturedAuthoringEffectScope,
): Promise<void> {
  try {
    await assertCanonicalTaskRoot(captured.binding.task_root);
    const currentEntries = await captureTree(captured.binding.task_root, captured.binding);
    const initialByPath = new Map(captured.initialEntries.map((entry) => [entry.relative_path, entry]));
    const currentByPath = new Map(currentEntries.map((entry) => [entry.relative_path, entry]));
    for (const [relative, initial] of initialByPath) {
      const current = currentByPath.get(relative);
      if (!current || !exactEntry(initial, current)) {
        failDrift(`immutable authoring input changed identity or bytes: ${absoluteEntryPath(captured.binding.task_root, initial)}`);
      }
    }
    for (const [relative, current] of currentByPath) {
      if (initialByPath.has(relative)) continue;
      const absolute = absoluteEntryPath(captured.binding.task_root, current);
      if (current.kind === "directory" && allowedNewDirectory(captured.binding, absolute)) continue;
      failDrift(`authoring task root contains an undeclared entry: ${absolute}`);
    }
    await assertAuthoringWritableClosure(captured.binding, { requireExactOutputs: true });
  } catch (error) {
    if (error instanceof ValidationError && error.reasonCode === "authoring_effect_scope_drift") throw error;
    throw new ValidationError(
      `authoring effect scope terminal reinspection failed: ${(error as Error).message}`,
      "authoring_effect_scope_drift",
    );
  }
}

export function assertAuthoringEffectScopeBinding(value: AuthoringEffectScopeBinding): void {
  if (
    value.schema_version !== 1 ||
    !isEffectScopedAuthoringProfile(value.effect_profile) ||
    !path.isAbsolute(value.task_root) || path.resolve(value.task_root) !== value.task_root ||
    !/^\d+$/u.test(value.task_root_device) || !/^\d+$/u.test(value.task_root_inode) ||
    value.recursive_delegation !== "disabled" ||
    !SHA256_PATTERN.test(value.immutable_tree_sha256) ||
    value.terminal_reinspection_required !== true ||
    value.claim_ceiling !== CLAIM_CEILING ||
    !Array.isArray(value.writable_scope.paths)
  ) {
    failInvalid("authoring effect scope binding is malformed");
  }
  if (value.effect_profile === "task_root_authoring_v1") {
    if (value.writable_scope.kind !== "exact_output_files") {
      failInvalid("task_root_authoring_v1 effect scope binding requires exact_output_files");
    }
    normalizeAllowedOutputPaths(value.writable_scope.paths, value.task_root, value.effect_profile);
    return;
  }
  if (
    value.writable_scope.kind !== "fixed_state_subtree" ||
    value.writable_scope.paths.length !== 1 ||
    value.writable_scope.paths[0] !== boundedProfileStateRoot(value.task_root, value.effect_profile)
  ) {
    failInvalid(`${value.effect_profile} effect scope binding requires its one exact fixed profile state subtree`);
  }
}
